/**
 * Sign-in through Cloudflare Access (Zero Trust). Access guards a single
 * path, `/api/auth/access`, with its one-time PIN: Cloudflare emails the
 * code from its own domain, so Score Chat needs no mail domain. A request
 * that reaches that path carries Access's signed JWT, which is checked here
 * before Score Chat starts its own session.
 */

export const ACCESS_PATH = '/api/auth/access'

interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
}

export interface AccessClaims {
  email: string
  iss: string
  aud: string | string[]
  exp: number
  nbf?: number
}

const decoder = new TextDecoder()
const base64url = (text: string) =>
  Uint8Array.from(
    atob(text.replaceAll('-', '+').replaceAll('_', '/')),
    (char) => char.charCodeAt(0),
  )
const json = <A>(part: string) =>
  JSON.parse(decoder.decode(base64url(part))) as A

/** The team's signing keys rotate; each is fetched once per isolate per hour. */
const certificates = new Map<string, { keys: Promise<Jwk[]>; at: number }>()
const CERTIFICATE_LIFETIME = 60 * 60 * 1000

function signingKeys(
  team: string,
  now: number,
  refresh = false,
): Promise<Jwk[]> {
  const cached = certificates.get(team)
  if (cached && !refresh && now - cached.at < CERTIFICATE_LIFETIME)
    return cached.keys
  const keys = fetch(`${team}/cdn-cgi/access/certs`)
    .then((response) => {
      if (!response.ok)
        throw new Error(`Access certificates: HTTP ${response.status}`)
      return response.json() as Promise<{ keys: Jwk[] }>
    })
    .then(({ keys }) => keys)
  keys.catch(() => certificates.delete(team))
  certificates.set(team, { keys, at: now })
  return keys
}

/** The team domain as Access issues it, e.g. `https://acme.cloudflareaccess.com`. */
export const teamOrigin = (domain: string) =>
  domain.startsWith('http')
    ? domain.replace(/\/+$/, '')
    : `https://${domain.replace(/\/+$/, '')}`

/**
 * Verifies an Access JWT: an RS256 signature by one of the team's keys, the
 * team as issuer, and a current lifetime. With `audience`, the token must
 * also be for that Access application. Returns the claims, or undefined.
 */
export async function verifyAccessToken(
  token: string,
  team: string,
  options: { audience?: string; now?: number } = {},
): Promise<AccessClaims | undefined> {
  const now = options.now ?? Date.now()
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ]
  let header: { alg?: string; kid?: string }
  let claims: AccessClaims
  try {
    header = json(encodedHeader)
    claims = json(encodedPayload)
  } catch {
    return undefined
  }
  if (header.alg !== 'RS256' || !header.kid) return undefined
  // A key unknown to the cached set may be new: look once more before refusing.
  let key = (await signingKeys(team, now)).find(
    (candidate) => candidate.kid === header.kid,
  )
  key ??= (await signingKeys(team, now, true)).find(
    (candidate) => candidate.kid === header.kid,
  )
  if (!key) return undefined
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: key.kty, n: key.n, e: key.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  )
  if (!valid) return undefined
  const seconds = now / 1000
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (
    claims.iss !== team ||
    typeof claims.email !== 'string' ||
    !(claims.exp > seconds) ||
    (claims.nbf !== undefined && claims.nbf > seconds + 60) ||
    (options.audience !== undefined && !audiences.includes(options.audience))
  )
    return undefined
  return claims
}
