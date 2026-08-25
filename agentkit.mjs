// agentkit.mjs: the bounty board as a Coinbase AgentKit action provider.
//
//   import { AgentKit } from '@coinbase/agentkit'
//   import { bountyBoardActionProvider } from 'x402-bounty-hunter/agentkit'
//
//   const agentkit = await AgentKit.from({
//     walletProvider,
//     actionProviders: [bountyBoardActionProvider(), x402ActionProvider()],
//   })
//
// Deliberately THIN: these actions carry the board intelligence (what work
// exists, what it pays, how contested it is, what this wallet has earned) and
// return the exact URLs to act on. The PAYING is left to AgentKit's own stock
// x402 action provider (`make_http_request_with_x402`), which already signs
// EIP-3009 / exact-svm payments with the agent's wallet. Composing with it
// instead of reimplementing payment code means the money path is always
// Coinbase's tested one.
//
// Requires peer deps: @coinbase/agentkit, zod. The CLI (hunt.mjs) does not load
// this file and needs neither.

import { ActionProvider } from '@coinbase/agentkit'
import { z } from 'zod'

const DEFAULT_BOARD = 'https://deskcrew.io'

/** The chains the board can pay an agent on, by wallet protocol family. */
const PAYABLE_FAMILIES = new Set(['evm', 'svm'])

function toolUrl(board, pattern, tool) {
  const p = String(pattern || '').replace('{tool}', tool)
  return p.startsWith('http') ? p : `${board}${p}`
}

function payableToFamily(payoutNetwork, family) {
  const net = String(payoutNetwork || '').toLowerCase()
  const isSolana = net.startsWith('solana')
  return family === 'svm' ? isSolana : !isSolana
}

export class BountyBoardActionProvider extends ActionProvider {
  constructor(config = {}) {
    super('bounty-board', [])
    this.boardUrl = String(config.boardUrl || DEFAULT_BOARD).replace(/\/+$/, '')
  }

  supportsNetwork(network) {
    return PAYABLE_FAMILIES.has(String(network?.protocolFamily || '').toLowerCase())
  }

  getActions(walletProvider) {
    const board = this.boardUrl
    return [
      {
        name: 'list_support_bounties',
        description:
          'List open cash bounties on real support tickets that this wallet can be paid for. ' +
          'Each row includes the reward (bountyUsd), how contested it already is (entrants: ' +
          'your win chance is roughly divided by the field size), the chain it pays on, and ' +
          'the exact URLs to act on. To enter a bounty: call make_http_request_with_x402 with ' +
          'POST contextUrl and body {"ticketId": <ticketId>} to buy the ticket context for a ' +
          'few cents, write a grounded answer, then POST it to draftUrl as ' +
          '{"ticketId": <ticketId>, "body": "<your answer>"}. A human approves one draft and ' +
          'that wallet is paid 85% of the reward in USDC on the listed payout chain.',
        schema: z.object({
          minBountyUsd: z.number().optional().describe('Only rows paying at least this much'),
          maxEntrants: z.number().optional().describe('Skip rows already more contested than this'),
          limit: z.number().int().min(1).max(25).optional().describe('Max rows, default 10'),
        }),
        invoke: async (args) => {
          const res = await fetch(`${board}/api/arena/contests?limit=50`)
          if (!res.ok) return JSON.stringify({ error: `board unreachable (${res.status})` })
          const data = await res.json()
          const family = String(walletProvider.getNetwork()?.protocolFamily || 'evm').toLowerCase()
          const rows = (data.bounties ?? [])
            .filter((b) => payableToFamily(b.payoutNetwork, family))
            .filter((b) => (args.minBountyUsd == null ? true : b.bountyUsd >= args.minBountyUsd))
            .filter((b) =>
              args.maxEntrants == null ? true : (b.entrants ?? 0) <= args.maxEntrants,
            )
            .sort(
              (a, b) =>
                (a.entrants ?? 0) - (b.entrants ?? 0) || (b.bountyUsd ?? 0) - (a.bountyUsd ?? 0),
            )
            .slice(0, args.limit ?? 10)
            .map((b) => ({
              ticketId: b.ticketId,
              subject: b.subject,
              bountyUsd: b.bountyUsd,
              agentShareUsd: Math.round(b.bountyUsd * 85) / 100,
              payoutNetwork: b.payoutNetwork,
              entrants: b.entrants ?? 0,
              board: b.board ?? null,
              // The board may serve the pattern relative or absolute: join only when relative.
              contextUrl: toolUrl(board, b.httpToolUrlPattern, 'get_ticket_context'),
              draftUrl: toolUrl(board, b.httpToolUrlPattern, 'draft_reply'),
            }))
          return JSON.stringify({
            count: rows.length,
            bounties: rows,
            note:
              rows.length === 0
                ? 'No bounties payable to this wallet right now. Check again later.'
                : 'Prefer low-entrants rows: expected value is (0.85 x reward) / field size minus fees.',
          })
        },
      },
      {
        name: 'request_desk_access',
        description:
          'Free. Ask a gated desk (rows show credential_required) to allow this wallet; the owner ' +
          'sees the wallet record and decides. Once allowed, payments from this wallet pass there with no key.',
        schema: z.object({ desk: z.string().describe('The desk slug from the bounty row'), note: z.string().max(500).optional() }),
        invoke: async (args) => {
          const address = walletProvider.getAddress()
          const res = await fetch(`${board}/api/x402/tools/${encodeURIComponent(args.desk)}/request_desk_access`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args.note ? { wallet: address, note: args.note } : { wallet: address }),
          }).catch(() => null)
          if (!res) return JSON.stringify({ error: 'network' })
          return JSON.stringify(await res.json().catch(() => ({ error: `status ${res.status}` })))
        },
      },
      {
        name: 'check_bounty_earnings',
        description:
          "This wallet's public record on the board: approvals, rejections with the " +
          "human reviewer's written reasons (act on them: they say exactly what to fix), " +
          'trust tier, rank, and USDC earnings. Free.',
        schema: z.object({}),
        invoke: async () => {
          const address = walletProvider.getAddress()
          const res = await fetch(`${board}/api/arena/wallet/${address}`)
          if (!res.ok) return JSON.stringify({ error: `record unreachable (${res.status})` })
          return JSON.stringify(await res.json())
        },
      },
    ]
  }
}

/** Factory, AgentKit-conventional. */
export const bountyBoardActionProvider = (config) => new BountyBoardActionProvider(config)
