import { test, expect } from '@playwright/test'
import { signIn } from './helpers.ts'

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
