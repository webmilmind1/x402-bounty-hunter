/**
 * x402 payment for the bounty hunter: given a URL and a body, pay whatever the
 * server asks and return its answer.
 *
 * This is the payment core from try-x402, narrowed to what an autonomous loop
 * needs. Every protection in the original is kept, because a loop that pays
 * repeatedly without a human watching needs them MORE than a one-shot CLI does:
 *
 *   - The server does NOT get to choose the token. `asset` is checked against the
 *     canonical USDC we pinned per chain. A hostile endpoint quoting a different
 *     EIP-3009 token would otherwise get a signature against a contract we never
 *     meant to spend from.
 *   - The server does NOT get to choose the price. Anything above the caller's
 *     ceiling is refused before signing. Balances are public, so "quote exactly
 *     their balance" is a one-signature drain otherwise.
 *   - The server does NOT get to choose the EIP-712 domain. Name, version, chain
 *     and verifying contract all come from our table.
 *   - The authorization window is CLAMPED, so nobody holds a live authorization
 *     over the wallet for years and settles it when it suits them.
 *
 * Gas is never needed: EIP-3009 is an off-chain signature the server broadcasts
 * and pays for.
 */
import { createPublicClient, http, formatUnits, toHex } from 'viem'
import { base, polygon, avalanche, sei } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * A Solana secret key as wallets export it: base58 that decodes to 64 bytes, so it
 * never starts with 0x and is far longer than an EVM key.
 *
 * Lives HERE rather than beside the Solana code so the two modules only point one way:
 * pay-svm imports from pay, and pay reaches pay-svm through a dynamic import inside the
 * function. A static import both ways would work by ESM's live bindings, but only
 * because nothing touches the bindings at module-evaluation time, which is a property
 * a future edit could quietly break.
 */
export function isSolanaKey(key) {
  return typeof key === 'string' && !key.startsWith('0x') && key.length >= 80 && key.length <= 92
}

const ERC20 = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
]

/** Canonical USDC per chain. Ours, never the server's. */
export const NETWORKS = {
  base: { chain: base, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', domain: 'USDC' },
  polygon: { chain: polygon, usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', domain: 'USDC' },
  avalanche: {
    chain: avalanche,
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    domain: 'USDC',
  },
  sei: { chain: sei, usdc: '0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392', domain: 'USDC' },
}

export class PaymentRefused extends Error {
  constructor(reason, detail) {
    super(detail)
    this.reason = reason
  }
}

/** Read the 402 challenge from either dialect: v1 in the body, v2 on the header.
 *  Exported so the Solana path in pay-svm.mjs reads a challenge exactly the same way
 *  rather than keeping a second copy that could drift. */
export function readChallenge(res, bodyText) {
  try {
    return { challenge: JSON.parse(bodyText), dialect: 'v1' }
  } catch {
    /* not v1 */
  }
  const header = res.headers.get('payment-required')
  if (header) {
    try {
      return {
        challenge: JSON.parse(Buffer.from(header, 'base64').toString('utf8')),
        dialect: 'v2',
      }
    } catch {
      /* not v2 either */
    }
  }
  return { challenge: null, dialect: null }
}

/**
 * POST to an x402 endpoint, paying if it asks.
 *
 * Returns { paid, status, body, tx, priceUsd }. Throws PaymentRefused when a term
 * is unacceptable, so the caller can stop the loop rather than retry into a trap.
 */
export async function payAndPost({ url, body, privateKey, maxPriceUsd, rpcUrl = undefined }) {
  // A Solana key means the Solana scheme: a different signature, a different address
  // space, and a transaction rather than a typed-data signature. Routed on the key's
  // own shape so the caller never has to declare which chain it holds.
  if (isSolanaKey(privateKey)) {
    const { payAndPostSvm } = await import('./pay-svm.mjs')
    return payAndPostSvm({ url, body, privateKey, maxPriceUsd })
  }

  const account = privateKeyToAccount(privateKey)

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
  const pick = accepts.find((a) => NETWORKS[a.network])
  if (!pick) {
    throw new PaymentRefused(
      'no-payable-network',
      `server accepts ${accepts.map((a) => a.network).join(', ') || 'nothing'}; we can pay ${Object.keys(NETWORKS).join(', ')}`,
    )
  }
  const net = NETWORKS[pick.network]

  // ⚠️ The token is ours to decide, not the server's.
  if (pick.asset && pick.asset.toLowerCase() !== net.usdc.toLowerCase()) {
    throw new PaymentRefused(
      'non-usdc-asset',
      `server asked to be paid in ${pick.asset}, which is not canonical USDC on ${pick.network}`,
    )
  }

  const atomic = BigInt(pick.maxAmountRequired ?? pick.amount ?? 0)
  const priceUsd = formatUnits(atomic, 6)

  // ⚠️ A ceiling the server cannot move. This is the loop's spend safety.
  if (atomic > BigInt(Math.round(maxPriceUsd * 1e6))) {
    throw new PaymentRefused(
      'over-max-price',
      `server asked ${priceUsd} USDC, above the ${maxPriceUsd} ceiling. Nothing was signed.`,
    )
  }

  const pub = createPublicClient({ chain: net.chain, transport: http(rpcUrl || undefined) })
  const balance = await pub.readContract({
    address: net.usdc,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [account.address],
  })
  if (balance < atomic) {
    throw new PaymentRefused(
      'insufficient-funds',
      `need ${priceUsd} USDC on ${pick.network}, wallet holds ${formatUnits(balance, 6)}. Fund ${account.address} (no gas token needed).`,
    )
  }

  // EIP-3009: an off-chain signature the server broadcasts and pays gas for.
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const now = Math.floor(Date.now() / 1000)
  const validBefore = String(now + Math.min(Number(pick.maxTimeoutSeconds) || 300, 600))

  let domainName = net.domain
  try {
    domainName = await pub.readContract({ address: net.usdc, abi: ERC20, functionName: 'name' })
  } catch {
    /* keep the pinned value */
  }

  const signature = await account.signTypedData({
    // Every field from OUR table. The server shifts none of it.
    domain: {
      name: domainName,
      version: '2',
      chainId: net.chain.id,
      verifyingContract: net.usdc,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: pick.payTo,
      value: atomic,
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce,
    },
  })

  const payload = {
    signature,
    authorization: {
      from: account.address,
      to: pick.payTo,
      value: atomic.toString(),
      validAfter: '0',
      validBefore,
      nonce,
    },
  }
  const envelope =
    dialect === 'v2'
      ? {
          x402Version: 2,
          accepted: { scheme: pick.scheme ?? 'exact', network: pick.network },
          payload,
        }
      : { x402Version: 1, scheme: pick.scheme ?? 'exact', network: pick.network, payload }

  const paid = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [dialect === 'v2' ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT']: Buffer.from(
        JSON.stringify(envelope),
      ).toString('base64'),
    },
    body: JSON.stringify(body),
  })
  const paidText = await paid.text()

  // No receipt means no settlement, so nothing was charged. Reported honestly
  // rather than assumed, because the loop's accounting depends on it.
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
