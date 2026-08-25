/**
 * Solana (SVM) payment for the bounty hunter.
 *
 * WHY THIS EXISTS. A bounty pays out on the chain it was funded in, and the address
 * spaces do not overlap: a wallet holding USDC on Solana cannot be paid on Base, or the
 * reverse. Until this file, the hunter could only pay with an EVM key, so it could not
 * collect a Solana bounty at all. It would spend the tool price on work it could never
 * be paid for.
 *
 * WHY IT DELEGATES TO x402 RATHER THAN BUILDING THE TRANSACTION BY HAND, when pay.mjs
 * deliberately hand-builds its EIP-3009 signature. The EVM scheme is one typed-data
 * signature whose every field we can pin ourselves, so hand-building it is how the
 * server is prevented from choosing any of them. The SVM scheme is a whole SPL
 * TransferChecked transaction that must name the server's fee-payer, derive the right
 * associated token accounts, and carry a recent blockhash. Hand-rolling that would be
 * re-implementing the protocol, and getting it subtly wrong loses money rather than
 * failing loudly. x402's own client is the reference implementation, so it builds the
 * transaction and we keep control of the DECISION to pay.
 *
 * THE PROTECTIONS ARE STILL OURS, and they run BEFORE anything is signed:
 *   - the server does not choose the token. `asset` is checked against the canonical
 *     Solana USDC mint below, so a lookalike SPL token is refused, not signed.
 *   - the server does not choose the price. Anything above the caller's ceiling stops
 *     the run before a signature exists.
 *   - the server does not choose the chain. Only `solana` is accepted here; a devnet or
 *     unknown network is refused.
 * Base58 is CASE-SENSITIVE, so none of these comparisons may be lowercased.
 */
import { svm } from 'x402/shared'
import { createPaymentHeader } from 'x402/client'
import { PaymentRefused, readChallenge, isSolanaKey } from './pay.mjs'

export { isSolanaKey }

/** Native Circle USDC on Solana mainnet. Ours, never the server's. */
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** USDC is 6 decimals here as everywhere else. */
const USDC_DECIMALS = 6

/** The wallet address for a Solana secret key, so the hunter can report where it will
 *  be paid without the caller handling key material. */
export async function solanaAddressOf(privateKey) {
  const signer = await svm.createSignerFromBase58(privateKey)
  return String(signer.address)
}

/**
 * POST to an x402 endpoint, paying on Solana if it asks.
 *
 * Returns the same shape as the EVM payAndPost so the hunt loop does not branch:
 * { paid, status, body, tx, priceUsd }.
 */
export async function payAndPostSvm({ url, body, privateKey, maxPriceUsd }) {
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

  const { challenge, dialect } = readChallenge(first, firstText)
  if (!challenge) throw new PaymentRefused('unreadable-402', 'the 402 carried no readable terms')

  const accepts = challenge.accepts || []
  const pick = accepts.find((a) => a.network === 'solana')
  if (!pick) {
    throw new PaymentRefused(
      'no-payable-network',
      `this wallet pays on solana; server accepts ${accepts.map((a) => a.network).join(', ') || 'nothing'}`,
    )
  }

  // ⚠️ The token is ours to decide. Case-sensitive: base58 must not be folded.
  if (pick.asset && pick.asset !== SOLANA_USDC_MINT) {
    throw new PaymentRefused(
      'non-usdc-asset',
      `server asked to be paid in ${pick.asset}, which is not canonical USDC on solana`,
    )
  }

  const atomic = BigInt(pick.maxAmountRequired ?? pick.amount ?? 0)
  const priceUsd = (Number(atomic) / 10 ** USDC_DECIMALS).toFixed(6)

  // ⚠️ A ceiling the server cannot move. Balances are public, so "quote exactly their
  // balance" would otherwise be a one-signature drain.
  if (atomic > BigInt(Math.round(maxPriceUsd * 10 ** USDC_DECIMALS))) {
    throw new PaymentRefused(
      'over-max-price',
      `server asked ${priceUsd} USDC, above the ${maxPriceUsd} ceiling. Nothing was signed.`,
    )
  }

  // Only now, with the terms accepted, is anything signed. x402 builds the SPL
  // TransferChecked transaction against these requirements and the server's fee-payer.
  const signer = await svm.createSignerFromBase58(privateKey)
  let header
  try {
    header = await createPaymentHeader(signer, challenge.x402Version ?? 1, pick)
  } catch (err) {
    // Most often an unfunded wallet (no USDC, or no token account yet). Reported as a
    // refusal rather than a crash so the loop stops cleanly instead of retrying.
    throw new PaymentRefused('cannot-sign', `could not build the Solana payment: ${err.message}`)
  }

  const paid = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [dialect === 'v2' ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT']: header,
    },
    body: JSON.stringify(body),
  })
  const paidText = await paid.text()

  // No receipt means no settlement, so nothing was charged. Reported honestly rather
  // than assumed, because the loop's accounting depends on it.
  const receipt = paid.headers.get('payment-response') || paid.headers.get('x-payment-response')
  let tx = null
  if (receipt) {
    try {
      tx = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')).transaction ?? null
    } catch {
      /* unreadable receipt: treat as unsettled */
    }
  }

  return { paid: Boolean(tx), status: paid.status, body: paidText, tx, priceUsd }
}
