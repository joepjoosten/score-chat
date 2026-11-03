import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { teamOrigin, verifyAccessToken } from '../server/access.ts'

const TEAM = 'https://acme.cloudflareaccess.com'
const encode = (bytes: Uint8Array | string) =>
  Buffer.from(bytes).toString('base64url')

// A team signing key, served the way Access serves its certificates.
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)
const jwk = await crypto.subtle.exportKey('jwk', publicKey)
let certificateRequests = 0
globalThis.fetch = (async (url: string) => {
  assert.equal(url, `${TEAM}/cdn-cgi/access/certs`)
  certificateRequests++
  return Response.json({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256' }] })
}) as typeof fetch

async function token(
  claims: object,
  header: object = { alg: 'RS256', kid: 'key-1' },
) {
  const unsigned = `${encode(JSON.stringify(header))}.${encode(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsigned),
  )
  return `${unsigned}.${encode(new Uint8Array(signature))}`
}

const now = 1_800_000_000_000
const valid = {
  email: 'reader@example.com',
  iss: TEAM,
  aud: ['score-chat-aud'],
  exp: now / 1000 + 600,
  nbf: now / 1000 - 5,
}

describe('Cloudflare Access sign-in', () => {
  it('accepts a token the team signed, and reads the address', async () => {
    const claims = await verifyAccessToken(await token(valid), TEAM, { now })
    assert.equal(claims?.email, 'reader@example.com')
  })
  it('checks the application when its audience tag is known', async () => {
    assert.ok(
      await verifyAccessToken(await token(valid), TEAM, {
        now,
        audience: 'score-chat-aud',
      }),
    )
    assert.equal(
      await verifyAccessToken(await token(valid), TEAM, {
        now,
        audience: 'other-app',
      }),
      undefined,
    )
  })
  it('refuses expired tokens and tokens of another team', async () => {
    assert.equal(
      await verifyAccessToken(
        await token({ ...valid, exp: now / 1000 - 1 }),
        TEAM,
        { now },
      ),
      undefined,
    )
    assert.equal(
      await verifyAccessToken(
        await token({ ...valid, iss: 'https://evil.cloudflareaccess.com' }),
        TEAM,
        { now },
      ),
      undefined,
    )
  })
  it('refuses a tampered or unsigned token', async () => {
    const [header, , signature] = (await token(valid)).split('.')
    const forged = `${header}.${encode(JSON.stringify({ ...valid, email: 'admin@example.com' }))}.${signature}`
    assert.equal(await verifyAccessToken(forged, TEAM, { now }), undefined)
    const none = `${encode(JSON.stringify({ alg: 'none' }))}.${encode(JSON.stringify(valid))}.`
    assert.equal(await verifyAccessToken(none, TEAM, { now }), undefined)
    assert.equal(
      await verifyAccessToken('not a token', TEAM, { now }),
      undefined,
    )
  })
  it('looks for a new signing key once before refusing an unknown one', async () => {
    const before = certificateRequests
    assert.equal(
      await verifyAccessToken(
        await token(valid, { alg: 'RS256', kid: 'rotated' }),
        TEAM,
        { now },
      ),
      undefined,
    )
    assert.equal(certificateRequests, before + 1)
  })
  it('accepts the team domain with or without its scheme', () => {
    assert.equal(teamOrigin('acme.cloudflareaccess.com'), TEAM)
    assert.equal(teamOrigin(`${TEAM}/`), TEAM)
  })
})
