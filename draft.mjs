/**
 * Turning a ticket into a draft answer, using YOUR model.
 *
 * ⚠️ DELIBERATELY PROVIDER-AGNOSTIC. This talks to any OpenAI-compatible chat
 * completions endpoint, which is what nearly every provider and every local
 * runner exposes. You bring the base URL, the key and the model name, so nothing
 * here ties you to one vendor and no vendor is named in the code. Point it at a
 * hosted API or at something on your own machine.
 *
 * Set:
 *   LLM_BASE_URL   e.g. https://api.your-provider.example/v1
 *   LLM_API_KEY    your key
 *   LLM_MODEL      the model name
 */

/**
 * The instruction the model works to.
 *
 * Written to match what actually gets APPROVED. The published acceptance rate on
 * the board is about 22%, and reading the rejections the pattern is consistent:
 * answers get rejected for inventing features, for hedging into uselessness, and
 * for ignoring the context they were given. So the prompt pushes hard on
 * grounding and on admitting ignorance, because a confident wrong answer is worth
 * less than nothing here: it costs you the attempt fee AND your acceptance rate.
 */
function systemPrompt() {
  return [
    'You are answering a real customer support ticket for a business you do not work for.',
    'A human at that business will read your answer and either approve it (you get paid) or reject it (you do not).',
    '',
    'Rules that decide whether you get paid:',
    '1. Use ONLY the context provided. Never invent a feature, a setting, a menu item, or a URL.',
    '2. If the context does not contain the answer, say plainly what is missing rather than guessing.',
    '3. Write to the customer, not about them. No preamble, no "as an AI", no restating the question.',
    '4. Be specific and short. Concrete steps beat a paragraph of reassurance.',
    '5. Match a support reply in tone: plain, calm, and useful. No marketing.',
    '',
    'Return only the reply body. No subject line, no signature, no markdown headings.',
  ].join('\n')
}

export class DraftFailed extends Error {}

/** Ask the configured model for a reply. Returns the text, or throws. */
export async function draftReply({ subject, body, context, config }) {
  const { baseUrl, apiKey, model } = config
  if (!baseUrl || !apiKey || !model) {
    throw new DraftFailed('LLM_BASE_URL, LLM_API_KEY and LLM_MODEL must all be set')
  }

  const user = [
    `TICKET SUBJECT: ${subject}`,
    '',
    `TICKET BODY:\n${body}`,
    '',
    context
      ? `CONTEXT FROM THE BUSINESS (knowledge base and ticket history):\n${context}`
      : 'CONTEXT: none was available. Answer only if the ticket alone is genuinely answerable, otherwise say what you would need.',
  ].join('\n')

  let res
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: 700,
      }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    throw new DraftFailed(`could not reach the model: ${err?.message ?? err}`)
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new DraftFailed(`model returned ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = await res.json().catch(() => null)
  const text = data?.choices?.[0]?.message?.content?.trim()
  if (!text) throw new DraftFailed('model returned no text')

  // A reply that is mostly an apology for not knowing is not worth 6 cents to
  // submit. Better to skip the bounty and keep both the fee and the accept rate.
  if (text.length < 40) throw new DraftFailed('model returned too little to be worth submitting')

  return text
}
