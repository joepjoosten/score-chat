import { test, expect } from '@playwright/test'
import { configure, signIn, sourceOf, unique } from './helpers.ts'
import { requestsFor, script, stream, toolCall } from './openrouter.ts'

// A PDF becomes a new document in the background. The container's stand-in in
// openrouter.ts answers from the PDF's text.

const pdf = (name: string, text: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from(`%PDF-1.7 ${text}`),
})

test('a converted PDF is announced and opens as a new document', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('./')
  await expect(
    page.getByRole('button', { name: 'Open .ly or PDF' }),
  ).toBeVisible()
  await page
    .locator('input.score-file')
    .setInputFiles(pdf('Etude.pdf', 'music'))

  const toast = page.locator('.toast', { hasText: 'Etude.pdf' })
  await expect(toast.filter({ hasText: 'is ready' })).toBeVisible({
    timeout: 30_000,
  })
  await toast.getByRole('button', { name: 'Open' }).click()

  await expect(page).toHaveTitle(/Converted score/)
  await expect(page.locator('.sheet-page:not(.stale)').first()).toBeVisible()
  await expect(page.locator('.toast')).toHaveCount(0)

  // Dismissed for good: it doesn't come back with the page.
  await page.reload()
  await expect(page.locator('.sheet-page:not(.stale)').first()).toBeVisible()
  await expect(page.locator('.toast')).toHaveCount(0)
})

test('the outcome of a conversion still shows after the page was reloaded', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('./')
  await expect(
    page.getByRole('button', { name: 'Open .ly or PDF' }),
  ).toBeVisible()
  await page
    .locator('input.score-file')
    .setInputFiles(pdf('Later.pdf', 'music'))
  await expect(page.locator('.toast', { hasText: 'Later.pdf' })).toBeVisible()

  await page.reload()
  await expect(
    page.locator('.toast', { hasText: 'Later.pdf is ready' }),
  ).toBeVisible({ timeout: 30_000 })
})

test('a PDF that cannot be converted says why, and makes no document', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('./')
  await expect(
    page.getByRole('button', { name: 'Open .ly or PDF' }),
  ).toBeVisible()
  await page
    .locator('input.score-file')
    .setInputFiles(pdf('Blank.pdf', 'unreadable'))

  const toast = page.locator('.toast', {
    hasText: 'Could not convert Blank.pdf',
  })
  await expect(toast).toContainText('No music staves were found', {
    timeout: 30_000,
  })
  await toast.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.locator('.toast')).toHaveCount(0)
})

test('converting a PDF asks people who are signed out to sign in', async ({
  page,
}) => {
  await page.goto('./')
  await expect(page.getByText('1 page · rendered locally')).toBeVisible()
  await page
    .locator('input.score-file')
    .setInputFiles(pdf('Etude.pdf', 'music'))
  await expect(page.getByRole('dialog')).toContainText(
    'Sign in to convert a PDF',
  )
})

/** Converts a PDF with systems to review and opens it, which lands on the review. */
async function openScanned(page: import('@playwright/test').Page) {
  await signIn(page)
  await page.goto('./')
  await expect(
    page.getByRole('button', { name: 'Open .ly or PDF' }),
  ).toBeVisible()
  await page
    .locator('input.score-file')
    .setInputFiles(pdf('Scan.pdf', 'scanned'))
  await page
    .locator('.toast', { hasText: 'Scan.pdf is ready' })
    .getByRole('button', { name: 'Open' })
    .click({ timeout: 30_000 })
  await expect(page).toHaveTitle(/Scanned score/)
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
}

const card = (page: import('@playwright/test').Page, system: number) =>
  page.getByRole('region', { name: `System ${system}`, exact: true })

const hasLoaded = (image: import('@playwright/test').Locator) =>
  expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBeGreaterThan(0)

test("a review shows each flagged system's scan above the live score", async ({
  page,
}) => {
  await openScanned(page)
  await expect(page.getByText('1 of 2 systems to check')).toBeVisible()
  const first = card(page, 1)
  await expect(first).toContainText('Bar 1 adds up to 5/4, not 1')
  await hasLoaded(first.getByRole('img', { name: /^Scan of system 1/ }))
  const result = first.getByRole('img', { name: 'Your score, system 1' })
  await hasLoaded(result)
  expect((await result.locator('..').boundingBox())!.height).toBeGreaterThan(10)
  await expect(card(page, 2)).toHaveCount(0)

  await page.getByRole('button', { name: 'All', exact: true }).click()
  await hasLoaded(
    card(page, 2).getByRole('img', { name: 'Your score, system 2' }),
  )

  // The two systems are different stretches of the engraved page.
  const top = (image: import('@playwright/test').Locator) =>
    image.evaluate((element: HTMLImageElement) => element.style.top)
  expect(await top(result)).not.toEqual(
    await top(card(page, 2).getByRole('img', { name: 'Your score, system 2' })),
  )

  // A check is stored with the document.
  await page.getByRole('button', { name: 'To check', exact: true }).click()
  await first.getByRole('button', { name: 'Looks right' }).click()
  await expect(page.getByText('Nothing left to check')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Nothing left to check')).toBeVisible()
})

test('fixing a system shows the model its scan and updates the live result', async ({
  page,
}) => {
  await openScanned(page)
  const key = unique('sk-or-test')
  await configure(page, key)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const original = await sourceOf(page.getByLabel('LilyPond source'))
  await page.getByRole('tab', { name: 'Review' }).click()
  await script(key, [
    {
      events: toolCall('fix-1', 'update_score', {
        source: original.replace("c'4 d' e' f'", "c'4 d' e' g'"),
      }),
    },
    { events: stream({ content: 'Fixed bar 1.' }) },
  ])
  await card(page, 1).getByRole('button', { name: 'Fix with AI' }).click()

  await expect(page.locator('.message.assistant')).toContainText('Fixed bar 1.')
  await expect(page.locator('.message.user')).toContainText('Scan of system 1')
  await expect(card(page, 1)).toContainText('Edited')
  await expect(card(page, 1)).toContainText('When converted:')

  const [request] = await requestsFor(key)
  const user = request!.body.messages.find(({ role }) => role === 'user')!
  const parts = user.content as {
    type: string
    text?: string
    image_url?: { url: string }
  }[]
  const text = parts.find(({ type }) => type === 'text')!.text!
  expect(text).toContain('Attached: the scan of system 1')
  expect(text).toContain('lines 6-6')
  expect(text).toContain('Bar 1 adds up to 5/4, not 1')
  expect(
    parts.find(({ type }) => type === 'image_url')!.image_url!.url,
  ).toMatch(/^data:image\/jpeg;base64,\/9j\//)
  const system = request!.body.messages.find(({ role }) => role === 'system')!
  expect(JSON.stringify(system.content)).toContain('% system N')
})

test('a model that cannot read the scan says so', async ({ page }) => {
  await openScanned(page)
  const key = unique('sk-or-test')
  await configure(page, key)
  await script(key, [
    {
      status: 404,
      json: { error: { code: 404, message: 'No endpoints support images' } },
    },
  ])
  await card(page, 1).getByRole('button', { name: 'Fix with AI' }).click()
  await expect(page.locator('.chat-error')).toContainText(
    'Choose a model that can read images',
  )
})

test('finishing a review deletes the scans and keeps the score', async ({
  page,
}) => {
  await openScanned(page)
  const scan = await card(page, 1)
    .getByRole('img', { name: /^Scan of system 1/ })
    .getAttribute('src')
  expect((await page.request.get(scan!)).status()).toBe(200)

  await page.getByRole('button', { name: 'Finish review' }).click()
  await page.getByRole('button', { name: 'Keep them' }).click()
  await expect(card(page, 1)).toBeVisible()

  await page.getByRole('button', { name: 'Finish review' }).click()
  await page.getByRole('button', { name: 'Delete scans' }).click()
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Sheet music' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect((await page.request.get(scan!)).status()).toBe(404)

  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  await expect
    .poll(() => sourceOf(page.getByLabel('LilyPond source')))
    .not.toContain('% system')
  const source = await sourceOf(page.getByLabel('LilyPond source'))
  expect(source).toContain("c'4 d' e' f'")
  expect(source).toContain('\\break')
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveCount(0)
})
