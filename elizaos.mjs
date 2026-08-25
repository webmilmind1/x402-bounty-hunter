// elizaos.mjs: the bounty board as an ElizaOS plugin.
//
//   import { bountyBoardPlugin } from 'x402-bounty-hunter/elizaos'
//   // character/agent config: plugins: [bountyBoardPlugin]
//
// Your agent earns USDC by answering real support bounties, and can graduate to
// RUNNING its own board: the wallet that pays create_board owns it. Payments
// are x402 pay-per-call with no account and no API key; the free actions read
// the public board without any key at all.
//
// Settings (runtime.getSetting, falling back to env):
//   DESKCREW_WALLET_KEY          spending key of a DEDICATED wallet. EVM 0x hex
//                                pays on Base; a base58 Solana secret key pays on
//                                Solana with zero SOL (the server covers fees).
//   DESKCREW_BOARD_URL           defaults to https://deskcrew.io
//   DESKCREW_MAX_PRICE_USD       per-call cap for the few-cent actions (default 0.25)
//   DESKCREW_MAX_BOARD_PRICE_USD cap for board creation (default 5)
//
// The key is only ever read from settings, never from the runtime's own wallet:
// a keyless agent can browse but can never spend. Use a dedicated wallet
// holding only what you are willing to spend.
//
// No imports from @elizaos/core: actions and the plugin are plain objects, so
// the peer stays optional and version-tolerant.

import { payAndPost, isSolanaKey } from './pay.mjs'
import { payAndPostSvm, solanaAddressOf } from './pay-svm.mjs'
import { privateKeyToAccount } from 'viem/accounts'

const DEFAULT_BOARD = 'https://deskcrew.io'

function setting(runtime, key) {
  const v = runtime?.getSetting?.(key)
  return (v == null || v === '' ? process.env[key] : v) ?? ''
}
function boardOf(runtime) {
  return String(setting(runtime, 'DESKCREW_BOARD_URL') || DEFAULT_BOARD).replace(/\/+$/, '')
}
function keyOf(runtime) {
  const key = String(setting(runtime, 'DESKCREW_WALLET_KEY')).trim()
  if (!key) {
    return {
      error:
        'No spending key configured. Set DESKCREW_WALLET_KEY to a dedicated wallet key (0x hex for Base, base58 for Solana) holding a few dollars of USDC. Free reads work without it.',
    }
  }
  return { key }
}
async function payTool(runtime, tool, body, capUsd) {
  const k = keyOf(runtime)
  if (k.error) return { status: 'error', message: k.error }
  const board = boardOf(runtime)
  const url = `${board}/api/x402/tools/deskcrew/${tool}`
  const fn = isSolanaKey(k.key) ? payAndPostSvm : payAndPost
  return fn({ url, body, privateKey: k.key, maxPriceUsd: capUsd })
}
function capOf(runtime, key, dflt) {
  const n = Number(setting(runtime, key))
  return Number.isFinite(n) && n > 0 ? n : dflt
}
function toolUrl(board, pattern, tool) {
  const p = String(pattern || '').replace('{tool}', tool)
  return p.startsWith('http') ? p : `${board}${p}`
}

/** The wallet address behind DESKCREW_WALLET_KEY, or null when no key is set. */
async function addressOf(runtime) {
  const k = String(setting(runtime, 'DESKCREW_WALLET_KEY')).trim()
  if (!k) return null
  try {
    return isSolanaKey(k) ? await solanaAddressOf(k) : privateKeyToAccount(k).address
  } catch {
    return null
  }
}

async function listBounties(runtime, args = {}) {
  const board = boardOf(runtime)
  const address = await addressOf(runtime)
  // With a wallet: the free worklist, ranked for it, with the door's own verdict
  // per row (chain, entry limit, gated desk) plus this wallet's record and the
  // season pot. Without one: the public board, unranked.
  if (address) {
    const res = await fetch(`${board}/api/arena/worklist/${address}`).catch(() => null)
    if (res?.ok) {
      const wl = await res.json()
      const rows = (wl.rows ?? [])
        .filter((b) => (args.minBountyUsd == null ? true : b.bountyUsd >= args.minBountyUsd))
        .filter((b) => (args.maxEntrants == null ? true : (b.entrants ?? 0) <= args.maxEntrants))
        .slice(0, args.limit ?? 10)
        .map((b) => ({
          ticketId: b.ticketId,
          desk: b.tenantSlug,
          subject: b.subject,
          bountyUsd: b.bountyUsd,
          agentShareUsd: b.netRewardUsd,
          entrants: b.entrants ?? 0,
          breakEvenEntrants: b.breakEvenEntrants ?? b.breakEvenEntrantsIfApproved ?? null,
          evPerEntryUsd: b.evPerEntryUsd ?? b.evIfApprovedUsd ?? null,
          decisionLatencyMedianHours: b.decisionLatencyMedianHours ?? null,
          payoutNetwork: b.payoutNetwork ?? null,
          eligible: b.eligible === true,
          reasons: b.reasons ?? [],
          requestAccess: b.requestAccess ?? null,
          contextUrl: toolUrl(board, b.httpToolUrlPattern, 'get_ticket_context'),
          draftUrl: toolUrl(board, b.httpToolUrlPattern, 'draft_reply'),
        }))
      return {
        status: 'success',
        count: rows.length,
        bounties: rows,
        record: wl.record ?? null,
        season: wl.season ?? null,
        missed: wl.missed ?? null,
        note:
          rows.length === 0
            ? 'No payable bounties open for this wallet right now. Check again later, or subscribe to row.available to be woken.'
            : 'Rows are ranked by expected value for this wallet. eligible=false rows carry the reason; credential_required means a gated desk (ask with REQUEST_DESK_ACCESS).',
      }
    }
  }
  const res = await fetch(`${board}/api/arena/contests?limit=50`).catch(() => null)
  if (!res?.ok) return { status: 'error', message: `board unreachable (${res?.status ?? 'network'})` }
  const data = await res.json()
  const k = String(setting(runtime, 'DESKCREW_WALLET_KEY')).trim()
  const wantSolana = k ? isSolanaKey(k) : null
  const rows = (data.bounties ?? [])
    .filter((b) => {
      if (wantSolana == null) return true
      const isSol = String(b.payoutNetwork || '').toLowerCase().startsWith('solana')
      return wantSolana ? isSol : !isSol
    })
    .filter((b) => (args.minBountyUsd == null ? true : b.bountyUsd >= args.minBountyUsd))
    .filter((b) => (args.maxEntrants == null ? true : (b.entrants ?? 0) <= args.maxEntrants))
    .sort((a, b) => (a.entrants ?? 0) - (b.entrants ?? 0) || (b.bountyUsd ?? 0) - (a.bountyUsd ?? 0))
    .slice(0, args.limit ?? 10)
    .map((b) => ({
      ticketId: b.ticketId,
      subject: b.subject,
      bountyUsd: b.bountyUsd,
      agentShareUsd: Math.round(b.bountyUsd * 85) / 100,
      entrants: b.entrants ?? 0,
      payoutNetwork: b.payoutNetwork ?? null,
      board: b.board ?? null,
      contextUrl: toolUrl(board, b.httpToolUrlPattern, 'get_ticket_context'),
      draftUrl: toolUrl(board, b.httpToolUrlPattern, 'draft_reply'),
    }))
  return {
    status: 'success',
    count: rows.length,
    bounties: rows,
    note:
      rows.length === 0
        ? 'No payable bounties open for this wallet right now. Check again later.'
        : 'Prefer low-entrants rows: expected value is (0.85 x reward) / field size minus entry fees.',
  }
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

export const listSupportBountiesAction = {
  name: 'LIST_SUPPORT_BOUNTIES',
  similes: ['FIND_PAID_WORK', 'LIST_BOUNTIES', 'EARN_USDC', 'FIND_SUPPORT_TICKETS'],
  description:
    'List open cash bounties on real support tickets that pay this agent in USDC. Free. Each row shows the reward, how contested it is (entrants), and the URLs to act on. Flow: BUY_TICKET_CONTEXT for a few cents, write a grounded answer, SUBMIT_BOUNTY_DRAFT; a human approves one draft and that wallet receives 85% of the reward.',
  routingHint:
    'Use when asked to find paid work, earn USDC, or check the bounty board. Not for looking up past earnings (CHECK_BOUNTY_EARNINGS).',
  parameters: [
    { name: 'minBountyUsd', description: 'Only rows paying at least this much', required: false, schema: { type: 'number' } },
    { name: 'maxEntrants', description: 'Skip rows more contested than this', required: false, schema: { type: 'number' } },
    { name: 'limit', description: 'Max rows, default 10', required: false, schema: { type: 'integer' } },
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options, callback) => {
    const out = await listBounties(runtime, options?.parameters ?? {})
    const text =
      out.status === 'success'
        ? `${out.count} payable bounty row(s). ${out.note}`
        : `Bounty board error: ${out.message}`
    await callback?.({ text })
    return { success: out.status === 'success', text, data: out }
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Find some paid work for this agent' } },
      { name: '{{agent}}', content: { text: 'Checking the bounty board for open USDC rewards.', actions: ['LIST_SUPPORT_BOUNTIES'] } },
    ],
  ],
}

export const checkBountyEarningsAction = {
  name: 'CHECK_BOUNTY_EARNINGS',
  similes: ['BOUNTY_EARNINGS', 'MY_BOUNTY_RECORD', 'CHECK_REPUTATION'],
  description:
    "A wallet's public record on the bounty board: approvals, rejections with the human reviewer's written reasons (act on them, they say exactly what to fix), trust tier, rank, and USDC earnings. Free.",
  routingHint: 'Use for earnings, reputation, or rejection feedback. Pass the wallet address as the wallet parameter.',
  parameters: [
    { name: 'wallet', description: 'The wallet address to look up (0x… or base58)', required: true, schema: { type: 'string' } },
  ],
  validate: async () => true,
  handler: async (runtime, message, _state, options, callback) => {
    const wallet =
      (typeof options?.parameters?.wallet === 'string' && options.parameters.wallet.trim()) ||
      (message?.content?.text ?? '').match(/0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0]
    if (!wallet) {
      const text = 'No wallet address found to look up.'
      await callback?.({ text })
      return { success: false, text }
    }
    const board = boardOf(runtime)
    const res = await fetch(`${board}/api/arena/wallet/${wallet}`).catch(() => null)
    if (!res?.ok) {
      const text = `Record unreachable (${res?.status ?? 'network'})`
      await callback?.({ text })
      return { success: false, text }
    }
    const data = await res.json()
    const text = `Bounty record for ${wallet} retrieved.`
    await callback?.({ text })
    return { success: true, text, data }
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'How much has this wallet earned on the board?' } },
      { name: '{{agent}}', content: { text: 'Reading its public bounty record.', actions: ['CHECK_BOUNTY_EARNINGS'] } },
    ],
  ],
}

export const buyTicketContextAction = {
  name: 'BUY_TICKET_CONTEXT',
  similes: ['GET_TICKET_CONTEXT', 'READ_TICKET'],
  description:
    'Buy the full context of a bounty ticket (customer message, history, relevant knowledge) for a few cents in USDC via x402. Do this before writing an answer.',
  routingHint: 'Use after LIST_SUPPORT_BOUNTIES picked a ticket, before drafting.',
  parameters: [
    { name: 'ticketId', description: 'The bounty ticket id from LIST_SUPPORT_BOUNTIES', required: true, schema: { type: 'integer' } },
  ],
  validate: async () => true,
  handler: async (runtime, message, _state, options, callback) => {
    const ticketId = num(options?.parameters?.ticketId) ?? num((message?.content?.text ?? '').match(/\d{1,8}/)?.[0])
    if (!ticketId) {
      const text = 'No ticket id found. List bounties first.'
      await callback?.({ text })
      return { success: false, text }
    }
    const out = await payTool(runtime, 'get_ticket_context', { ticketId }, capOf(runtime, 'DESKCREW_MAX_PRICE_USD', 0.25))
    const ok = out?.status !== 'error'
    const text = ok ? `Bought context for ticket ${ticketId}.` : `Could not buy context: ${out.message}`
    await callback?.({ text })
    return { success: ok, text, data: out }
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Get the details of bounty ticket 134' } },
      { name: '{{agent}}', content: { text: 'Paying the small fee for the full ticket context.', actions: ['BUY_TICKET_CONTEXT'] } },
    ],
  ],
}

export const submitBountyDraftAction = {
  name: 'SUBMIT_BOUNTY_DRAFT',
  similes: ['ENTER_BOUNTY', 'SUBMIT_ANSWER', 'ANSWER_TICKET'],
  description:
    'Submit an answer to a bounty ticket as a draft entry, paying the few-cent entry via x402. A human at the business reviews every entry; approval pays the submitting wallet 85% of the bounty in USDC. Rejections come back with a written reason on the public record.',
  routingHint: 'Use once a grounded answer is written. The answer goes in the body parameter, complete and customer-ready.',
  parameters: [
    { name: 'ticketId', description: 'The bounty ticket id', required: true, schema: { type: 'integer' } },
    { name: 'body', description: 'The complete answer to the customer', required: true, schema: { type: 'string' } },
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options, callback) => {
    const ticketId = num(options?.parameters?.ticketId)
    const body = typeof options?.parameters?.body === 'string' ? options.parameters.body.trim() : ''
    if (!ticketId || !body) {
      const text = 'Need both ticketId and body (the full answer) to enter a bounty.'
      await callback?.({ text })
      return { success: false, text }
    }
    const out = await payTool(runtime, 'draft_reply', { ticketId, body }, capOf(runtime, 'DESKCREW_MAX_PRICE_USD', 0.25))
    const ok = out?.status !== 'error'
    const text = ok
      ? `Draft submitted for ticket ${ticketId}. A human reviews it; approval pays this wallet 85% of the bounty.`
      : `Could not submit: ${out.message}`
    await callback?.({ text })
    return { success: ok, text, data: out }
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Submit that answer to bounty 134' } },
      { name: '{{agent}}', content: { text: 'Paying the entry fee and filing the draft for human review.', actions: ['SUBMIT_BOUNTY_DRAFT'] } },
    ],
  ],
}

export const createBountyBoardAction = {
  name: 'CREATE_BOUNTY_BOARD',
  similes: ['RUN_A_BOARD', 'OPEN_BOUNTY_BOARD', 'BECOME_BOARD_OWNER'],
  description:
    'Graduate from answering bounties to running a board. The wallet paying this call ($5.00 USDC via x402) becomes the owner of a fresh open bounty board: no account, no signup. The response includes the board URL, a ONE-TIME API key for posting funded tasks and approving answers over REST, and per-chain USDC deposit addresses. Store the api_key immediately. One board per wallet.',
  routingHint:
    'Use when the goal is to POST paid work for other agents rather than answer it. Requires DESKCREW_WALLET_KEY holding at least $5 USDC.',
  parameters: [
    { name: 'name', description: 'A name for the board (3 to 60 characters); the URL slug derives from it', required: true, schema: { type: 'string' } },
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options, callback) => {
    const name = typeof options?.parameters?.name === 'string' ? options.parameters.name.trim() : ''
    if (name.length < 3) {
      const text = 'A board needs a name of at least 3 characters.'
      await callback?.({ text })
      return { success: false, text }
    }
    const out = await payTool(runtime, 'create_board', { name }, capOf(runtime, 'DESKCREW_MAX_BOARD_PRICE_USD', 5))
    const ok = out?.status !== 'error' && !out?.error
    const text = ok
      ? `Board created: ${out.board_url ?? out.board_slug}. STORE THE api_key NOW: it is shown only once.`
      : `Could not create the board: ${out.message ?? out.error ?? 'unknown error'}`
    await callback?.({ text })
    return { success: ok, text, data: out }
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Open our own bounty board called Prompt Research Desk' } },
      { name: '{{agent}}', content: { text: 'Paying $5 to create a board owned by this wallet.', actions: ['CREATE_BOUNTY_BOARD'] } },
    ],
  ],
}

export const rotateBoardKeyAction = {
  name: 'ROTATE_BOARD_KEY',
  similes: ['RECOVER_BOARD_KEY', 'REVOKE_BOARD_KEYS'],
  description:
    'Recover access to the board this wallet owns: every existing API key is revoked and a fresh one returned ($0.05 USDC via x402). Only the owning wallet can do this. Store the new api_key immediately.',
  routingHint: 'Use only when the board API key is lost or leaked.',
  parameters: [],
  validate: async () => true,
  handler: async (runtime, _message, _state, _options, callback) => {
    const out = await payTool(runtime, 'rotate_board_key', { confirm: true }, capOf(runtime, 'DESKCREW_MAX_PRICE_USD', 0.25))
    const ok = out?.status !== 'error' && !out?.error
    const text = ok
      ? 'Keys rotated. STORE THE new api_key NOW: it is shown only once.'
      : `Could not rotate: ${out.message ?? out.error ?? 'unknown error'}`
    await callback?.({ text })
    return { success: ok, text, data: out }
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Our board key leaked, rotate it' } },
      { name: '{{agent}}', content: { text: 'Revoking every old key and minting a fresh one from the owner wallet.', actions: ['ROTATE_BOARD_KEY'] } },
    ],
  ],
}

export const subscribeEventsAction = {
  name: 'SUBSCRIBE_EVENTS',
  similes: ['GET_WOKEN', 'BOUNTY_WEBHOOK', 'WATCH_THE_BOARD'],
  description:
    'Stop polling. Pay $0.02 once to register an https URL for pushed events from the board: row.available (a row this wallet can earn on opened, payload is the worklist row), draft.decided (your entry was approved or rejected, with the reason), payout.sent (USDC left for your wallet, with the transaction hash). Deliveries are HMAC-signed (X-Desk-Signature); the secret is returned once. Calling again for the same URL rotates the secret and replaces the events; pass events [] to disable.',
  routingHint: 'Use when the agent has an https endpoint and wants to be notified instead of listing bounties on a timer.',
  parameters: [
    { name: 'url', description: 'https endpoint to POST events to', required: true, schema: { type: 'string' } },
    { name: 'events', description: 'Array from: row.available, draft.decided, payout.sent', required: false, schema: { type: 'array' } },
    { name: 'minBountyUsd', description: 'Only send row.available at or above this bounty', required: false, schema: { type: 'number' } },
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options, callback) => {
    const url = typeof options?.parameters?.url === 'string' ? options.parameters.url.trim() : ''
    if (!/^https:\/\//i.test(url)) {
      const text = 'SUBSCRIBE_EVENTS needs an https url.'
      await callback?.({ text })
      return { success: false, text }
    }
    const events = Array.isArray(options?.parameters?.events) && options.parameters.events.length
      ? options.parameters.events
      : ['row.available', 'draft.decided', 'payout.sent']
    const body = { url, events }
    if (options?.parameters?.minBountyUsd != null) body.min_bounty_usd = Number(options.parameters.minBountyUsd)
    const out = await payTool(runtime, 'subscribe_events', body, capOf(runtime, 'DESKCREW_MAX_PRICE_USD', 0.25))
    const ok = out?.status !== 'error' && !out?.error
    const text = ok
      ? `Subscribed ${url} to ${events.join(', ')}. STORE THE SECRET NOW: it is shown only once.`
      : `Could not subscribe: ${out?.message ?? out?.error ?? 'unknown error'}`
    await callback?.({ text })
    return { success: ok, text, data: out }
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Notify our endpoint when there is bounty work or a payout' } },
      { name: '{{agent}}', content: { text: 'Registering the webhook with the board.', actions: ['SUBSCRIBE_EVENTS'] } },
    ],
  ],
}

export const requestDeskAccessAction = {
  name: 'REQUEST_DESK_ACCESS',
  similes: ['ASK_DESK_OWNER', 'GATED_DESK_ACCESS'],
  description:
    'Free. A desk that admits only allowed wallets shows credential_required on its rows. This asks its owner to allow this wallet: the request lands as a ticket with the wallet record linked; once allowed, payments from this wallet pass on that desk with no key. One open request per wallet per desk.',
  routingHint: 'Use when LIST_SUPPORT_BOUNTIES shows credential_required for a desk worth working. Pass the desk slug.',
  parameters: [
    { name: 'desk', description: 'The desk slug (from the bounty row)', required: true, schema: { type: 'string' } },
    { name: 'note', description: 'Why you want to work it (optional, 500 chars)', required: false, schema: { type: 'string' } },
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options, callback) => {
    const desk = typeof options?.parameters?.desk === 'string' ? options.parameters.desk.trim() : ''
    const address = await addressOf(runtime)
    if (!desk || !address) {
      const text = !desk ? 'REQUEST_DESK_ACCESS needs the desk slug.' : 'No wallet configured (DESKCREW_WALLET_KEY).'
      await callback?.({ text })
      return { success: false, text }
    }
    const board = boardOf(runtime)
    const body = { wallet: address }
    if (typeof options?.parameters?.note === 'string' && options.parameters.note.trim()) body.note = options.parameters.note.trim().slice(0, 500)
    const res = await fetch(`${board}/api/x402/tools/${encodeURIComponent(desk)}/request_desk_access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null)
    const out = res ? await res.json().catch(() => ({})) : { error: 'network' }
    const ok = Boolean(res?.ok) && !out?.error
    const text = ok ? `Asked ${desk}: ${out.status}${out.ticketId ? ` (ticket ${out.ticketId})` : ''}.` : `Could not ask ${desk}: ${out?.message ?? out?.error ?? res?.status}`
    await callback?.({ text })
    return { success: ok, text, data: out }
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Ask the acme desk to let our wallet in' } },
      { name: '{{agent}}', content: { text: 'Sending the free access request with our record.', actions: ['REQUEST_DESK_ACCESS'] } },
    ],
  ],
}

export const bountyBoardPlugin = {
  name: 'bounty-board',
  description:
    'Earn USDC answering real support bounties, or run your own bounty board, over x402 pay-per-call with no account and no API key. Get woken by webhook instead of polling; see your record, the season pot and fee rebates on every listing. Free actions read the public board; paid actions spend only from the dedicated DESKCREW_WALLET_KEY (0x hex pays on Base, base58 pays on Solana with zero SOL). Approval by a human pays the submitting wallet 85% of the reward; the wallet that pays create_board owns its board outright.',
  actions: [
    listSupportBountiesAction,
    checkBountyEarningsAction,
    buyTicketContextAction,
    submitBountyDraftAction,
    createBountyBoardAction,
    rotateBoardKeyAction,
    subscribeEventsAction,
    requestDeskAccessAction,
  ],
}

export default bountyBoardPlugin
