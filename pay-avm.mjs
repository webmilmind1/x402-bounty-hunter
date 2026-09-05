/**
 * Algorand (AVM) payment for the bounty hunter.
 *
 * WHY THIS EXISTS. A bounty pays out on the chain it was funded in, and the three address
 * spaces do not overlap: a wallet holding USDC on Algorand cannot be paid on Base or Solana,
 * or the reverse. Until this file the hunter could not pay on Algorand at all, so an Algorand
 * wallet could see a bounty, want it, and have no way to enter.
 *
 * WHY IT BUILDS THE TRANSACTION BY HAND, when pay-svm.mjs delegates to a reference client.
 * There is no published client for this scheme yet, and the shape is small enough to pin
 * completely: two transactions in one atomic group. Ours is a USDC asset transfer with its fee
 * set to ZERO. The other is a do-nothing self-payment by the server's declared fee payer, left
 * unsigned, which the facilitator signs at settlement and which carries the fee for both. That
 * is why paying costs the agent no ALGO whatsoever: the seller pays the network, the buyer pays
 * only the price.
 *
 * THE PROTECTIONS ARE OURS AND THEY RUN BEFORE ANYTHING IS SIGNED:
 *   - the server does not choose the token. `asset` is checked against the canonical Algorand
 *     USDC asset id below, so a lookalike asset is refused rather than signed.
 *   - the server does not choose the price. Anything above the caller's ceiling stops the run
 *     while no signature exists.
 *   - the server does not choose the chain. Only Algorand mainnet is accepted here.
 *   - the server cannot sweep the account. A close-out field would empty the wallet into the
 *     receiver on top of the amount, so this builds the transfer itself and never accepts one.
 *   - the server cannot make us pay its fees. Our transaction's fee is pinned to zero, and a
 *     challenge with no fee payer is refused instead of quietly funded by us.
 *
 * Algorand addresses and transaction ids are base32 and CASE-SENSITIVE. Nothing here may be
 * lowercased. Folding one produces a string that identifies no account, which is a way to lose
 * money that looks like a formatting choice.
 */
import { PaymentRefused, readChallenge, isAlgorandKey } from './pay.mjs'

export { isAlgorandKey }

/** Circle USDC on Algorand mainnet, as an asset id. Ours to insist on, never the server's. */
export const ALGORAND_USDC_ASSET = '31566704'

/** The chain id an Algorand mainnet accept carries. The friendly spelling is also accepted
 *  because both dialects are in use in the wild. */
export const ALGORAND_MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='

const USDC_DECIMALS = 6
const DEFAULT_ALGOD = 'https://mainnet-api.algonode.cloud'

/** 58 characters of base32. Deliberately not a checksum test: this is only used to route on
 *  the shape of a value, and the library validates properly when it derives the account. */
const ADDRESS_RE = /^[A-Z2-7]{58}$/

async function sdk() {
  try {
    return await import('algosdk')
  } catch {
    throw new PaymentRefused(
      'missing-dependency',
      'paying on Algorand needs the algosdk package: npm install algosdk',
    )
  }
}

/** The address for a mnemonic, so a caller can report where it will be paid without ever
 *  handling key material itself. */
export async function algorandAddressOf(mnemonic) {
  const { mnemonicToSecretKey } = await sdk()
  return mnemonicToSecretKey(String(mnemonic).trim()).addr.toString()
}

/**
 * POST to an x402 endpoint, paying on Algorand if it asks.
 *
 * Returns the same shape as the other payers so the hunt loop does not branch:
 * { paid, status, body, tx, priceUsd }.
 */
export async function payAndPostAvm({
  url,
  body,
  privateKey,
  maxPriceUsd,
  algodUrl = DEFAULT_ALGOD,
}) {
  const {
    Algodv2,
    assignGroupID,
    encodeUnsignedTransaction,
    makeAssetTransferTxnWithSuggestedParamsFromObject,
    makePaymentTxnWithSuggestedParamsFromObject,
    mnemonicToSecretKey,
  } = await sdk()

  const first = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const firstText = await first.text()

  // Free, or already satisfied: nothing to pay.
  if (first.status !== 402) {
    return { paid: false, status: first.status, body: firstText, tx: null, priceUsd: '0' }
  }

  // This scheme is version 2, so the terms we want are the ones in the header. A server that
  // also emits the older body form is read as a fallback rather than preferred, because only
  // the header form carries the chain id and the fee payer we need.
  const { challenge: v1Challenge } = readChallenge(first, firstText)
  let challenge = v1Challenge
  const headerTerms = first.headers.get('payment-required')
  if (headerTerms) {
    try {
      challenge = JSON.parse(Buffer.from(headerTerms, 'base64').toString('utf8'))
    } catch {
      /* keep whatever the body gave us */
    }
  }
  if (!challenge) throw new PaymentRefused('unreadable-402', 'the 402 carried no readable terms')

  const accepts = challenge.accepts || []
  const pick = accepts.find((a) => a.network === ALGORAND_MAINNET_CAIP2 || a.network === 'algorand')
  if (!pick) {
    throw new PaymentRefused(
      'no-payable-network',
      `this wallet pays on algorand; server accepts ${accepts.map((a) => a.network).join(', ') || 'nothing'}`,
    )
  }

  // ⚠️ The token is ours to decide. An asset id is a number, so compare as text without folding.
  if (String(pick.asset) !== ALGORAND_USDC_ASSET) {
    throw new PaymentRefused(
      'non-usdc-asset',
      `server asked to be paid in asset ${pick.asset}, which is not USDC on algorand`,
    )
  }
  if (!ADDRESS_RE.test(String(pick.payTo ?? ''))) {
    throw new PaymentRefused('bad-recipient', 'the server gave no valid Algorand address to pay')
  }

  const atomic = BigInt(pick.amount ?? pick.maxAmountRequired ?? 0)
  const priceUsd = (Number(atomic) / 10 ** USDC_DECIMALS).toFixed(6)
  if (atomic <= 0n) {
    throw new PaymentRefused('bad-price', 'the server quoted no price')
  }

  // ⚠️ A ceiling the server cannot move. Balances are public, so "quote exactly their balance"
  // would otherwise be a one-signature drain.
  if (atomic > BigInt(Math.round(maxPriceUsd * 10 ** USDC_DECIMALS))) {
    throw new PaymentRefused(
      'over-max-price',
      `server asked ${priceUsd} USDC, above the ${maxPriceUsd} ceiling. Nothing was signed.`,
    )
  }

  // ⚠️ No fee payer means the group cannot cover the network fee unless WE do, silently. Refuse
  // rather than discover it as an unexplained ALGO balance falling.
  const feePayer = pick.extra?.feePayer
  if (!ADDRESS_RE.test(String(feePayer ?? ''))) {
    throw new PaymentRefused(
      'no-fee-payer',
      'the server named no fee payer, so this payment would cost us network fees it promised to cover',
    )
  }

  const payer = mnemonicToSecretKey(String(privateKey).trim())
  const algod = new Algodv2('', algodUrl, '')

  // ⚠️ On Algorand a transfer FAILS unless the receiver has opted in to the asset, and that
  // failure would arrive only after the server had already done the work. Checking first turns
  // a confusing loss into one clear refusal that costs nothing.
  try {
    await algod.accountAssetInformation(pick.payTo, Number(pick.asset)).do()
  } catch {
    throw new PaymentRefused(
      'recipient-not-opted-in',
      `the address ${pick.payTo} cannot receive asset ${pick.asset}. Nothing was signed.`,
    )
  }

  let paymentGroup
  let txId
  try {
    const sp = await algod.getTransactionParams().do()
    const minFee = Number(sp.minFee ?? 1000)
    // Ours: the price, at a fee of zero. No closeRemainderTo and no rekeyTo, ever.
    const transfer = makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: payer.addr,
      receiver: pick.payTo,
      amount: atomic,
      assetIndex: Number(pick.asset),
      suggestedParams: { ...sp, flatFee: true, fee: 0 },
    })
    // Theirs: a self-payment moving nothing, carrying the fee for the whole group. Left
    // unsigned on purpose, because only the fee payer can sign it.
    const fee = makePaymentTxnWithSuggestedParamsFromObject({
      sender: feePayer,
      receiver: feePayer,
      amount: 0,
      suggestedParams: { ...sp, flatFee: true, fee: minFee * 2 },
      note: new TextEncoder().encode('x402-fee-payer'),
    })
    const [groupedTransfer, groupedFee] = assignGroupID([transfer, fee])
    // Grouped atomically: either both land or neither does, so the fee transaction cannot be
    // dropped to leave ours paying full freight.
    paymentGroup = [
      Buffer.from(groupedTransfer.signTxn(payer.sk)).toString('base64'),
      Buffer.from(encodeUnsignedTransaction(groupedFee)).toString('base64'),
    ]
    txId = groupedTransfer.txID()
  } catch (err) {
    throw new PaymentRefused(
      'cannot-sign',
      `could not build the Algorand payment: ${err?.message ?? err}`,
    )
  }

  const paymentSignature = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: 'exact',
      network: pick.network,
      accepted: pick,
      payload: { paymentGroup, paymentIndex: 0 },
    }),
  ).toString('base64')

  const paid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': paymentSignature },
    body: JSON.stringify(body),
  })
  const paidText = await paid.text()

  // No receipt means no settlement, so nothing was charged. Reported honestly rather than
  // assumed, because the loop's accounting depends on it. The signed transaction id is a
  // useful fallback for looking the payment up either way.
  const receipt = paid.headers.get('payment-response') || paid.headers.get('x-payment-response')
  let tx = null
  if (receipt) {
    try {
      tx = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')).transaction ?? null
    } catch {
      /* unreadable receipt: treat as unsettled */
    }
  }

  return { paid: Boolean(tx), status: paid.status, body: paidText, tx: tx ?? null, priceUsd, txId }
}
