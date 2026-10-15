import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { applyBeforeSign, clearanceTerms, payAndPost, PaymentRefused } from '../pay.mjs'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const RESOURCE = 'https://deskcrew.example/submit'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYTO = '0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8'

function challengeBody() {
  return JSON.stringify({
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        asset: USDC,
        maxAmountRequired: '1000',
        payTo: PAYTO,
        maxTimeoutSeconds: 60,
        resource: RESOURCE,
      },
    ],
  })
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('applyBeforeSign is a no-op when omitted and rethrows PaymentRefused', async () => {
  await applyBeforeSign(undefined, { payTo: PAYTO })
  await assert.rejects(
    applyBeforeSign(() => {
      throw new PaymentRefused('counterparty', 'no allow for this challenge')
    }, {}),
    (err) => err instanceof PaymentRefused && err.reason === 'counterparty',
  )
  await assert.rejects(
    applyBeforeSign(() => {
      throw new Error('intel down')
    }, {}),
    (err) => err instanceof PaymentRefused && err.reason === 'before-sign' && /intel down/.test(err.message),
  )
})

test('clearanceTerms keeps the envelope resource ahead of the request url', () => {
  const terms = clearanceTerms({
    url: 'https://request.example/post',
    pick: { payTo: PAYTO, network: 'base', asset: USDC, scheme: 'exact' },
    challenge: { resource: { url: 'https://envelope.example/paid' } },
    priceUsd: '0.001000',
    amount: 1000n,
  })
  assert.equal(terms.resource, 'https://envelope.example/paid')
  assert.equal(terms.amount, '1000')
  assert.equal(terms.payTo, PAYTO)
})

test('a refusing beforeSign stops before the paid retry', async () => {
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const body = init?.body == null ? '' : String(init.body)
    seen.push(target)
    if (body.includes('"method"')) {
      const msg = JSON.parse(body)
      if (msg.method === 'eth_call') {
        return json({
          jsonrpc: '2.0',
          id: msg.id,
          result: '0x' + (10n ** 12n).toString(16).padStart(64, '0'),
        })
      }
      if (msg.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: msg.id, result: '0x2105' })
      return json({ jsonrpc: '2.0', id: msg.id, result: '0x0' })
    }
    const hits = seen.filter((u) => u === RESOURCE).length
    if (hits === 1) {
      return new Response(challengeBody(), { status: 402, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200 })
  }
  try {
    let hooked = 0
    await assert.rejects(
      payAndPost({
        url: RESOURCE,
        body: { ticketId: 't' },
        privateKey: KEY,
        maxPriceUsd: 1,
        beforeSign: (terms) => {
          hooked += 1
          assert.equal(terms.payTo, PAYTO)
          assert.equal(terms.amount, '1000')
          assert.equal(terms.network, 'base')
          throw new PaymentRefused('counterparty', 'no unexpired allow or warn for this challenge')
        },
      }),
      (err) => err instanceof PaymentRefused && err.reason === 'counterparty',
    )
    assert.equal(hooked, 1)
    assert.equal(seen.filter((u) => u === RESOURCE).length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('over the price ceiling never calls beforeSign', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(challengeBody(), { status: 402, headers: { 'content-type': 'application/json' } })
  try {
    let hooked = 0
    await assert.rejects(
      payAndPost({
        url: RESOURCE,
        body: {},
        privateKey: KEY,
        maxPriceUsd: 0,
        beforeSign: () => {
          hooked += 1
        },
      }),
      (err) => err instanceof PaymentRefused && err.reason === 'over-max-price',
    )
    assert.equal(hooked, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('the hook is wired before each signature', () => {
  const svm = readFileSync(new URL('../pay-svm.mjs', import.meta.url), 'utf8')
  const evm = readFileSync(new URL('../pay.mjs', import.meta.url), 'utf8')
  const avm = readFileSync(new URL('../pay-avm.mjs', import.meta.url), 'utf8')
  assert.ok(svm.indexOf('await applyBeforeSign') < svm.indexOf('await createPaymentHeader'))
  assert.ok(evm.indexOf('await applyBeforeSign') < evm.indexOf('account.signTypedData'))
  assert.ok(avm.indexOf('await applyBeforeSign') < avm.indexOf('.signTxn('))
})
