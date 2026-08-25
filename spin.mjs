// spin.mjs: the DeskCrew desk-bot, a terminal mascot in the OpenClaw-crab
// tradition. A little robot waves its claws while the hunter works.
//
// The hunter spends real money over the network, and a silent pause while USDC
// moves reads as a hang. The bot gives every wait a live status line, with zero
// dependencies.
//
// Honest-terminal rules:
//   - TTY only. Piped output, CI logs and --json consumers get plain lines,
//     never animation frames or ANSI codes.
//   - A spinner always ENDS as a plain printed line (ok/fail), so scrollback
//     reads like a log even though it animated live.
//   - The cursor is always restored, even on Ctrl-C mid-frame.

const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const ESC = '\x1b['
const dim = (s) => (TTY ? `${ESC}2m${s}${ESC}0m` : s)
const cyan = (s) => (TTY ? `${ESC}36m${s}${ESC}0m` : s)
const green = (s) => (TTY ? `${ESC}32m${s}${ESC}0m` : s)
const red = (s) => (TTY ? `${ESC}31m${s}${ESC}0m` : s)
const bold = (s) => (TTY ? `${ESC}1m${s}${ESC}0m` : s)

/** The brand mark, colored when the terminal allows it. */
export const MARK = cyan(bold('>_$'))

// The desk-bot. Claw-arms wave while it works; every few beats it blinks.
// Every frame is the same width so the line never jitters.
const FRAMES = [
  '╰[ o_o ]╯',
  '╯[ o_o ]╰',
  '╰[ o_o ]╯',
  '╯[ -_- ]╰',
  '╰[ o_o ]╯',
  '╯[ o_o ]╰',
  '╰[ >_o ]╯',
  '╯[ o_o ]╰',
]
const INTERVAL_MS = 160

let active = null

function restoreCursor() {
  if (TTY) process.stdout.write(`${ESC}?25h`)
}
// Ctrl-C mid-frame must not leave the user's cursor invisible.
process.on('SIGINT', () => {
  restoreCursor()
  process.exit(130)
})
process.on('exit', restoreCursor)

/**
 * Start a live status line: `⠋ >_$ reading the board`.
 * Returns { update, ok, fail }. Exactly one of ok/fail ends it, printing a
 * plain final line so the transcript stays readable after the fact.
 */
export function spin(text) {
  if (!TTY) {
    console.log(`  ${text}`)
    return {
      update() {},
      ok(final) {
        if (final) console.log(`  ${final}`)
      },
      fail(final) {
        if (final) console.log(`  ${final}`)
      },
    }
  }

  // One spinner at a time keeps the line math simple; a second start finishes
  // the first quietly rather than interleaving frames.
  if (active) active.ok()

  let i = 0
  let current = text
  process.stdout.write(`${ESC}?25l`)
  const draw = () => {
    process.stdout.write(`\r${ESC}2K  ${cyan(FRAMES[i % FRAMES.length])} ${dim(current)}`)
    i++
  }
  draw()
  const timer = setInterval(draw, INTERVAL_MS)

  const end = (symbol, final) => {
    clearInterval(timer)
    process.stdout.write(`\r${ESC}2K`)
    restoreCursor()
    if (final) console.log(`  ${symbol} ${final}`)
    active = null
  }

  const handle = {
    update(next) {
      current = next
    },
    ok(final) {
      end(green('✓'), final)
    },
    fail(final) {
      end(red('✗'), final)
    },
  }
  active = handle
  return handle
}
