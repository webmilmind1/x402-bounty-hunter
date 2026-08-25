#!/usr/bin/env node
/**
 * bounty-hunter: earn USDC answering real support tickets.
 *
 * The loop: read the open board (free), pick a bounty, buy the ticket's context,
 * draft an answer with YOUR model, submit it, and get paid if a human at that
 * business approves it. Payment is x402 over HTTP, so there is no account and no
 * card; you fund a wallet with a couple of dollars of USDC and the server pays
 * the gas.
 *
 * ⚠️ THIS SPENDS REAL MONEY AND MOST ATTEMPTS DO NOT PAY. The board publishes its
 * own history: about 22% of submitted drafts get approved. Every attempt costs
 * the fee whether or not you win. Read the economics in the README before running
 * without --dry-run. Defaults here are deliberately timid: dry run unless told
 * otherwise, one bounty at a time, and a hard ceiling on total spend.
 */
import { readFileSync } from 'node:fs'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { payAndPost, PaymentRefused, NETWORKS, isSolanaKey } from './pay.mjs'
import { solanaAddressOf } from './pay-svm.mjs'
import { draftReply, DraftFailed } from './draft.mjs'
import { spin, MARK } from './spin.mjs'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f, d) => {
  const i = args.indexOf(f)
  return i > -1 && args[i + 1] ? args[i + 1] : d
}

const HOST = (val('--host', process.env.DESKCREW_HOST) || 'https://deskcrew.io').replace(/\/+$/, '')
const DRY = !has('--live')
const MAX_SPEND = Number(val('--max-spend', process.env.MAX_SPEND_USD || '1.00'))
const MAX_PRICE = Number(val('--max-price', '0.25'))
const LIMIT = Number(val('--limit', '1'))
const ONCE = !has('--watch')
const INTERVAL_MS = Math.max(60, Number(val('--interval', '300'))) * 1000

if (has('--help') || has('-h')) {
  console.log(`
  bounty-hunter: earn USDC answering real support tickets

    npx x402-bounty-hunter                 read the board and show what it WOULD do
    npx x402-bounty-hunter --live          actually pay and submit
    npx x402-bounty-hunter --live --watch  keep going, checking every 5 minutes

  Options
    --live              spend real money (default is a dry run)
    --max-spend <usd>   stop once this much has been spent   [1.00]
    --max-price <usd>   refuse any single charge above this  [0.25]
    --limit <n>         bounties per pass                    [1]
    --watch             keep running
    --interval <secs>   seconds between passes               [300]
    --host <url>        board to hunt on                     [https://deskcrew.io]
                        any board exposing the same endpoints works, and anyone
                        can RUN one: https://deskcrew.io/bounties

  Environment
    WALLET_KEY     EVM: 0x + 64 hex.  Solana: base58 secret key.
                   Which one you hold decides which bounties you can COLLECT:
                   a bounty pays out on the chain that funded it, and the board
                   publishes that chain, so unpayable ones are skipped for free.
                   Generated in memory if unset (dry run only, EVM).
    LLM_BASE_URL   any OpenAI-compatible endpoint
    LLM_API_KEY    your key
    LLM_MODEL      your model name

  ⚠️ Most attempts do not pay. The board publishes ~22% approval. Read the README.
`)
  process.exit(0)
}

const llm = {
  baseUrl: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL,
}

let key = process.env.WALLET_KEY
if (!key) {
  if (!DRY) {
    console.error('\n  WALLET_KEY is required with --live. Nothing was spent.\n')
    process.exit(1)
  }
  key = generatePrivateKey()
}
// Two kinds of wallet are payable, and which one you hold decides which bounties you
// can COLLECT, not just how you pay. A bounty settles on the chain that funded it, and
// the address spaces do not overlap.
const SOLANA = isSolanaKey(key)
if (!SOLANA && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('\n  WALLET_KEY must be either 0x + 64 hex (EVM) or a base58 Solana secret key.\n')
  process.exit(1)
}
const address = SOLANA ? await solanaAddressOf(key) : privateKeyToAccount(key).address

/** Can this wallet be PAID for a bounty that settles on `network`? An EVM wallet cannot
 *  receive USDC on Solana, or the reverse, so entering such a bounty means paying the
 *  tool price for work that can never be collected. The board publishes the chain for
 *  exactly this reason; skipping is the whole point of reading it. */
function payableToMe(network) {
  const solanaBounty = String(network ?? '').startsWith('solana')
  return solanaBounty === SOLANA
}

let spent = 0
let attempts = 0
let submitted = 0

const usd = (n) => `$${Number(n).toFixed(2)}`

const REQUEST_ACCESS = process.argv.includes('--request-access') || process.env.REQUEST_ACCESS === 'true'

/** The board, ranked for THIS wallet. Free: no payment, no account. The worklist
 *  runs the door's own checks (chain, entry limit, gated desk) and prices every
 *  row with the published EV math, so nothing here is entered blind. It also
 *  carries this wallet's record and the season pot, printed once per pass. */
async function worklist() {
  const res = await fetch(`${HOST}/api/arena/worklist/${address}`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`board returned ${res.status}`)
  return res.json()
}

/** Free: ask a gated desk to allow this wallet. Lands as a ticket for the owner. */
async function requestDeskAccess(slug) {
  const res = await fetch(`${HOST}/api/x402/tools/${slug}/request_desk_access`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: address, note: 'x402-bounty-hunter asking to work this desk' }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  return res?.ok ? res.json() : null
}

/** Buy the ticket's context. Skippable: some tickets are answerable without it. */
async function buyContext(ticketId) {
  try {
    const r = await payAndPost({
      url: `${HOST}/api/x402/tools/deskcrew/get_ticket_context`,
      body: { ticketId },
      privateKey: key,
      maxPriceUsd: MAX_PRICE,
      rpcUrl: process.env.X402_RPC_URL,
    })
    if (r.paid) spent += Number(r.priceUsd)
    const parsed = JSON.parse(r.body)
    return { text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed), cost: r.priceUsd }
  } catch (err) {
    if (err instanceof PaymentRefused) throw err
    return { text: '', cost: '0' }
  }
}

/** Submit the draft. This is the charge that matters and the one that can pay. */
async function submitDraft(ticketId, body) {
  const r = await payAndPost({
    url: `${HOST}/api/x402/tools/deskcrew/draft_reply`,
    body: { ticketId, body },
    privateKey: key,
    maxPriceUsd: MAX_PRICE,
    rpcUrl: process.env.X402_RPC_URL,
  })
  if (r.paid) spent += Number(r.priceUsd)
  return r
}

async function pass() {
  const boardSpin = spin(`reading the board at ${HOST}`)
  let wl
  try {
    wl = await worklist()
  } catch (err) {
    boardSpin.fail(`board unreachable: ${err?.message ?? err}`)
    throw err
  }
  boardSpin.ok()
  const bounties = Array.isArray(wl?.rows) ? wl.rows : []
  // This wallet, in one line: what it has won, what it was paid, where it stands
  // this season, and what it missed by not entering. All from the ledger.
  if (wl?.record) {
    const r = wl.record
    console.log(
      `  record: ${r.wonCount} won, ${usd(r.paidUsd)} paid` +
        (r.pendingUsd > 0 ? ` (${usd(r.pendingUsd)} pending)` : '') +
        `, last ${r.recentApproved + r.recentRejected} decided: ${r.recentApproved} approved`,
    )
  }
  if (wl?.season) {
    const sn = wl.season
    console.log(
      `  season ${sn.season?.number}: pot ${usd(sn.potUsd)}` +
        (sn.you?.rank ? `, you are rank ${sn.you.rank} (projected ${usd(sn.you.projectedUsd)})` : `, to qualify: ${(sn.you?.toEligible ?? []).join(' and ') || 'eligible'}`),
    )
  }
  if (wl?.missed?.paidToOthersUsd > 0) {
    console.log(`  missed: ${usd(wl.missed.paidToOthersUsd)} paid to others this week on rows you never entered`)
  }
  if (!bounties.length) {
    console.log('  no open bounties right now')
    return
  }
  // ⚠️ SKIP WHAT THIS WALLET CANNOT BE PAID FOR, before spending a cent. The board
  // publishes each bounty's payout chain precisely so an agent can do this; entering a
  // Solana bounty with an EVM wallet (or the reverse) means paying the tool price for
  // work that can never be collected.
  // Prefer the least contested work. The board publishes each row's entrant count
  // because your expected value is roughly (0.85 x reward) / field size minus the fee:
  // joining a row that already has five entries is worth a fraction of joining an
  // empty one at the same reward. Sorting here is what lets a field of hunters spread
  // across the board instead of stampeding the richest row.
  // The worklist arrives money-ranked with the door's own verdict per row. A
  // gated desk shows credential_required: with --request-access the free ask is
  // sent once per desk; the owner sees this wallet's record and decides.
  const gated = bounties.filter((b) => (b.reasons ?? []).includes('credential_required'))
  if (gated.length) {
    const desks = [...new Set(gated.map((b) => b.tenantSlug))]
    console.log(`  ${gated.length} row(s) on ${desks.length} gated desk(s): ${desks.join(', ')}`)
    if (REQUEST_ACCESS) {
      for (const slug of desks) {
        const r = await requestDeskAccess(slug)
        console.log(`    asked ${slug}: ${r?.status ?? 'no reply'}${r?.ticketId ? ` (ticket ${r.ticketId})` : ''}`)
      }
    } else {
      console.log('    run with --request-access to ask their owners (free)')
    }
  }
  const mine = bounties.filter((b) => b.eligible === true && payableToMe(b.payoutNetwork))
  const skipped = bounties.length - mine.length
  console.log(
    `  ${bounties.length} open, ${mine.length} enterable now` +
      (skipped ? ` (${skipped} skipped: ${[...new Set(bounties.flatMap((b) => b.reasons ?? []))].join(', ') || 'not eligible'})` : ''),
  )
  if (!mine.length) {
    console.log(`  nothing here pays out on ${SOLANA ? 'solana' : 'an EVM chain'} right now`)
    return
  }

  for (const b of mine.slice(0, LIMIT)) {
    const reward = Number(b.bountyUsd ?? b.amountUsd ?? 0)
    const ticketId = b.ticketId ?? b.ticket ?? b.id
    const ev = b.evPerEntryUsd ?? b.evIfApprovedUsd
    console.log(
      `\n  #${ticketId}  ${usd(reward)}  ${String(b.subject ?? '').slice(0, 60)}` +
        `  [${b.entrants ?? 0} in, EV ${ev == null ? '?' : usd(ev)}` +
        (b.decisionLatencyMedianHours != null ? `, verdict ~${Math.round(b.decisionLatencyMedianHours)}h` : '') +
        ']',
    )

    if (spent >= MAX_SPEND) {
      console.log(`  stopping: spend cap ${usd(MAX_SPEND)} reached`)
      return
    }

    if (DRY) {
      console.log('  DRY RUN: would buy context, draft an answer, and submit.')
      console.log(`  would risk ~$0.08 to win ${usd(reward * 0.85)} if approved.`)
      attempts++
      continue
    }

    let context = ''
    {
      const sp = spin('buying ticket context over x402')
      try {
        const c = await buyContext(ticketId)
        context = c.text
        sp.ok(Number(c.cost) > 0 ? `context bought for ${usd(c.cost)}` : undefined)
      } catch (err) {
        sp.fail(`context refused (${err.reason ?? 'error'}): ${err.message}`)
        if (err.reason === 'insufficient-funds' || err.reason === 'over-max-price') return
      }
    }

    let text
    {
      const sp = spin('drafting an answer with your model')
      try {
        text = await draftReply({
          subject: b.subject ?? '',
          body: b.body ?? '',
          context,
          config: llm,
        })
        sp.ok()
      } catch (err) {
        // Not worth paying to submit something the model would not stand behind.
        sp.fail(`skipped: ${err.message}`)
        continue
      }
    }

    attempts++
    {
      const sp = spin('submitting the draft, USDC moving over x402')
      try {
        const r = await submitDraft(ticketId, text)
        if (r.paid) {
          submitted++
          sp.ok(`submitted. paid ${usd(r.priceUsd)}${r.tx ? `  tx ${r.tx.slice(0, 14)}…` : ''}`)
          console.log(
            '  a human at that business now decides. Approval pays you 85% of the reward.',
          )
        } else {
          sp.fail(`not settled (status ${r.status}), so nothing was charged`)
        }
      } catch (err) {
        sp.fail(`submit refused (${err.reason ?? 'error'}): ${err.message}`)
        if (err.reason === 'insufficient-funds' || err.reason === 'over-max-price') return
      }
    }
  }
}

async function main() {
  console.log(`\n  ${MARK} bounty-hunter  ${DRY ? '(dry run)' : '(LIVE)'}`)
  console.log(`  wallet ${address}`)
  console.log(`  board  ${HOST}`)
  if (!DRY) console.log(`  caps   ${usd(MAX_SPEND)} total, ${usd(MAX_PRICE)} per charge`)
  if (DRY) console.log('  nothing will be spent. Add --live when you mean it.')
  console.log('')

  do {
    try {
      await pass()
    } catch (err) {
      console.log(`  pass failed: ${err?.message ?? err}`)
    }
    if (!ONCE) {
      if (spent >= MAX_SPEND) {
        console.log(`\n  spend cap ${usd(MAX_SPEND)} reached. Stopping.`)
        break
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS))
    }
  } while (!ONCE)

  console.log(`\n  attempts ${attempts}, submitted ${submitted}, spent ${usd(spent)}`)
  if (submitted > 0) {
    console.log(`  earnings appear at ${HOST}/api/arena/wallet/${address}`)
    console.log('  approvals are made by humans, so payment is not immediate.')
  }
  console.log('')
}

main().catch((err) => {
  console.error(`\n  ${err?.message ?? err}\n`)
  process.exit(1)
})
