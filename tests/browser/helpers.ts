import { expect, type Locator, type Page } from '@playwright/test'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const APP = 'http://localhost:1337'
const EMAIL_DIR = '.alchemy/local/email/text'

// The CodeMirror document behind the LilyPond source editor.
export const sourceOf = (editor: Locator) =>
  editor.evaluate((content) =>
    [...content.querySelectorAll('.cm-line')]
      .map((line) => line.textContent)
      .join('\n'),
  )

let counter = 0
/** A name no other test (or earlier run) uses, for emails and API keys. */
export const unique = (prefix: string) =>
  `${prefix}-${process.pid}-${Date.now()}-${++counter}`

/** The sign-in link the local mail simulator wrote for this address. */
async function signInLink(email: string, since: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const name of await readdir(EMAIL_DIR).catch(() => [] as string[])) {
      // The simulator writes a temporary file first, then renames it.
      if (name.startsWith('.')) continue
      const path = join(EMAIL_DIR, name)
      const written = await stat(path).then(
        (file) => file.mtimeMs,
        () => 0,
      )
      if (written < since) continue
      const text = await readFile(path, 'utf8').catch(() => '')
      if (!text.includes(` as ${email}:`)) continue
      const link = text.match(/https?:\/\/\S+\/login\?token=[\w-]+/)?.[0]
      if (link) return link
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`No sign-in email for ${email}`)
}

/** Requests a magic link for a new address and returns it, as the email would. */
export async function requestLink(
  page: Page,
  email = `${unique('user')}@example.com`,
) {
  const since = Date.now() - 1000
  const response = await page.request.post(`${APP}/api/auth/request`, {
    data: { email },
    headers: { Origin: APP },
  })
  expect(response.ok()).toBe(true)
  return { email, link: await signInLink(email, since) }
}

/** Signs a new user in through the API; the session cookie lands in the browser context. */
export async function signIn(page: Page) {
  const { email, link } = await requestLink(page)
  const token = new URL(link).searchParams.get('token')
  const response = await page.request.post(`${APP}/api/auth/verify`, {
    data: { token },
    headers: { Origin: APP },
  })
  expect(response.ok()).toBe(true)
  return email
}

/** Stores an API key and model through Settings. Each test's key picks its scripted model replies. */
export async function configure(
  page: Page,
  key: string,
  model = 'openai/test-model',
) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('OpenRouter API key').fill(key)
  await page.getByLabel('Model', { exact: true }).fill(model)
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Creates a document in the account and opens it. */
export async function openDocument(page: Page, source: string) {
  const response = await page.request.post(`${APP}/api/documents`, {
    data: { source },
    headers: { Origin: APP },
  })
  expect(response.status()).toBe(201)
  const { id } = await response.json()
  await page.goto(`/d/${id}`)
  await expect(page.locator('.sheet-page:not(.stale)').first()).toBeVisible()
  return id as string
}
