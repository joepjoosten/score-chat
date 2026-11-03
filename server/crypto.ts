/** WebCrypto helpers: random tokens, token hashes and the API key cipher. */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unbase64 = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

/** A random token for a link or a cookie: 32 bytes, base64url. */
export function randomToken(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/** Tokens are stored by hash, so a leaked table does not sign anyone in. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const keys = new Map<string, Promise<CryptoKey>>()
function aesKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle
      .digest('SHA-256', encoder.encode(secret))
      .then((raw) =>
        crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
          'encrypt',
          'decrypt',
        ]),
      )
    keys.set(secret, key)
  }
  return key
}

/**
 * Encrypts an API key as `v1.<iv>.<ciphertext>`. The owner's user ID is
 * authenticated with it, so a key copied to another user's row won't decrypt.
 */
export async function encryptSecret(
  plaintext: string,
  secret: string,
  owner: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(owner) },
    await aesKey(secret),
    encoder.encode(plaintext),
  )
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`
}

/** Decrypts `encryptSecret`'s output; throws when the secret, owner or data don't match. */
export async function decryptSecret(
  blob: string,
  secret: string,
  owner: string,
): Promise<string> {
  const [version, iv, ciphertext] = blob.split('.')
  if (version !== 'v1' || !iv || !ciphertext)
    throw new Error('Unknown key format')
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: unbase64(iv),
      additionalData: encoder.encode(owner),
    },
    await aesKey(secret),
    unbase64(ciphertext),
  )
  return decoder.decode(plaintext)
}
