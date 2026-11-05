import { test, expect } from '@playwright/test'
import { transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { sourceOf } from './helpers.ts'

// Signed-out use: the score lives in this browser, and everything but the
// assistant works without an account.

// Most tests exercise a one-page score; the app's default is the LilyJAZZ lead sheet.
const simpleScore = readFileSync(
  new URL('./simple-score.ly', import.meta.url),
  'utf8',
)
// The single score of earlier versions, which becomes the first local document.
const SCORE_KEY = 'score-chat.score.v1'
const DOCUMENTS_KEY = 'score-chat.documents.v1'
// The default score takes far longer to render on CI runners.
const COMPENDIUM_RENDER = 60_000
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, score]) => {
      try {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, score)
      } catch {}
    },
    [SCORE_KEY, simpleScore],
  )
})

/** Waits until the debounced save has stored the edit in this browser. */
const saved = (page: import('@playwright/test').Page, text: string) =>
  expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key) ?? '', DOCUMENTS_KEY),
    )
    .toContain(text)

test('renders locally, switches views, persists edits and preferences, and downloads', async ({
  page,
}) => {
  const external: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    // The app, and in development Vite's modules and live reload, come from the same host.
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.protocol !== 'data:'
    )
      external.push(request.url())
  })
  await page.goto('./')
  const image = page.getByRole('img', { name: 'Sheet music, page 1' })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
  await expect(page.getByText('1 page · rendered locally')).toBeVisible()
  // A local document gets its own address.
  await expect(page).toHaveURL(/\/d\/local-/)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  await editor.fill(
    (await sourceOf(editor)).replace('A little beginning', 'My first score'),
  )
  await saved(page, 'My first score')
  await page.reload()
  await expect(editor).toContainText('My first score')
  await expect(
    page.getByRole('tab', { name: 'LilyPond', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  // Signed out, Settings has no assistant options; it offers to sign in instead.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('OpenRouter API key')).toHaveCount(0)
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Sign in' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download .ly' }).click()
  expect((await downloadEvent).suggestedFilename()).toBe('score.ly')
  expect(external).toEqual([])
})

test('imports a score, reports invalid input, and recovers with undo and redo', async ({
  page,
}) => {
  await page.goto('./')
  const image = page.getByRole('img', { name: 'Sheet music, page 1' })
  const undo = page.getByRole('button', { name: 'Undo last score replacement' })
  const redo = page.getByRole('button', { name: 'Redo score replacement' })
  await expect(image).toBeVisible()
  await expect(undo).toBeDisabled()
  await expect(redo).toBeDisabled()
  await page.getByLabel('Import LilyPond file').setInputFiles({
    name: 'bad.ly',
    mimeType: 'text/plain',
    buffer: Buffer.from('not lilypond'),
  })
  await expect(page.getByText('Could not render this source')).toBeVisible()
  await expect(redo).toBeDisabled()
  await undo.click()
  await expect(image).toBeVisible()
  await expect(undo).toBeDisabled()
  await redo.click()
  await expect(page.getByText('Could not render this source')).toBeVisible()
  await expect(redo).toBeDisabled()
  await undo.click()
  await expect(image).toBeVisible()
})

test('opens a LilyPond file dropped anywhere on the page', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  await expect(editor).toBeVisible()
  const dropped = simpleScore.replace('A little beginning', 'A dropped score')
  const transfer = await page.evaluateHandle((text) => {
    const data = new DataTransfer()
    data.items.add(new File([text], 'dropped.ly', { type: 'text/plain' }))
    return data
  }, dropped)
  await editor.dispatchEvent('dragenter', { dataTransfer: transfer })
  await expect(page.getByText('Drop a LilyPond file to open it')).toBeVisible()
  await editor.dispatchEvent('dragover', { dataTransfer: transfer })
  await editor.dispatchEvent('drop', { dataTransfer: transfer })
  await expect(page.getByText('Drop a LilyPond file to open it')).toBeHidden()
  // Replaced, not inserted into the editor at the drop point.
  await expect.poll(() => sourceOf(editor)).toBe(dropped)
  await expect(
    page.getByRole('button', { name: 'Undo last score replacement' }),
  ).toBeEnabled()
})

test('highlighting works even when the score turns point-and-click off', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  await editor.fill(
    (await sourceOf(editor)).replace(
      '\\version "2.24.4"\n',
      '\\version "2.24.4"\n\\pointAndClickOff\n',
    ),
  )
  await expect.poll(() => sourceOf(editor)).toMatch(/\\pointAndClickOff\n/)
  await page.getByRole('tab', { name: 'Sheet music' }).click()
  const image = page.getByRole('img', { name: 'Sheet music, page 1' })
  await expect(image).toBeVisible()
  await expect(page.locator('.sheet-page:not(.stale)')).toBeVisible()
  await page
    .getByRole('button', { name: 'Highlight notes for the assistant' })
    .click()
  const box = (await image.boundingBox())!
  const at = (x: number, y: number) => ({
    x: box.x + (x / 119.5015) * box.width,
    y: box.y + (y / 169.0093) * box.height,
  })
  await page.mouse.move(at(20, 19).x, at(20, 19).y)
  await page.mouse.down()
  await page.mouse.move(at(45, 25).x, at(45, 25).y, { steps: 6 })
  await page.mouse.up()
  await expect(page.locator('.selection-chip')).toContainText(
    '4 notes, 1 time signature, 1 dynamic highlighted',
  )
})

test('pages can be shown as inline SVG for inspection, with active content stripped', async ({
  page,
}) => {
  await page.goto('./')
  const image = page.getByRole('img', { name: 'Sheet music, page 1' })
  await expect(image).toBeVisible()
  expect(await image.evaluate((node) => node.tagName)).toBe('IMG')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Sheet music pages').selectOption('inline')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((node) => node.tagName)).toBe('DIV')
  const systems = image.locator('svg g.system[data-system-id]')
  expect(await systems.count()).toBeGreaterThanOrEqual(2)
  // The inline page scales like the image did (no fixed millimetre size).
  expect(await image.locator('svg').getAttribute('width')).toBeNull()
  // The choice persists, and the highlighter still maps onto the inline page.
  await page.reload()
  await expect.poll(() => image.evaluate((node) => node.tagName)).toBe('DIV')
  await expect(page.locator('.sheet-page:not(.stale)')).toBeVisible()
  await page
    .getByRole('button', { name: 'Highlight notes for the assistant' })
    .click()
  const box = (await image.boundingBox())!
  await page.mouse.move(
    box.x + (20 / 119.5015) * box.width,
    box.y + (19 / 169.0093) * box.height,
  )
  await page.mouse.down()
  await page.mouse.move(
    box.x + (45 / 119.5015) * box.width,
    box.y + (25 / 169.0093) * box.height,
    { steps: 4 },
  )
  await page.mouse.up()
  await expect(page.locator('.selection-chip')).toContainText('c4 \\p e g e')
  // Injected active content in a page never reaches the document.
  const hostile =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10mm" height="10mm" onload="window.pwned=1"><script>window.pwned=1</script><a href="javascript:window.pwned=1"><rect width="1" height="1"/></a><foreignObject><div>x</div></foreignObject></svg>'
  await page.addScriptTag({
    content: transformSync(readFileSync('src/svg.ts', 'utf8'), {
      loader: 'ts',
      format: 'iife',
      globalName: 'svgModule',
    }).code,
  })
  const sanitized = await page.evaluate(
    (svg) =>
      (
        window as unknown as {
          svgModule: { sanitizeSvg: (svg: string) => string }
        }
      ).svgModule.sanitizeSvg(svg),
    hostile,
  )
  expect(sanitized).not.toContain('script')
  expect(sanitized).not.toContain('onload')
  expect(sanitized).not.toContain('javascript:')
  expect(sanitized).not.toContain('foreignObject')
  expect(sanitized).toContain('<rect')
  expect(sanitized).not.toContain('width="10mm"')
})

test('the assistant dock can be resized and remembers its size', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('./')
  const dock = page.getByRole('region', { name: 'Music assistant' })
  const before = (await dock.boundingBox())!
  const handle = page.getByRole('separator', { name: /Resize assistant/ })
  const grip = (await handle.boundingBox())!
  await page.mouse.move(grip.x + 9, grip.y + 9)
  await page.mouse.down()
  await page.mouse.move(grip.x - 191, grip.y - 291, { steps: 5 })
  await page.mouse.up()
  // The dock follows in the next frame.
  await expect
    .poll(async () =>
      Math.round((await dock.boundingBox())!.width - before.width),
    )
    .toBe(200)
  const after = (await dock.boundingBox())!
  expect(after.y).toBeLessThan(before.y - 200)
  await page.reload()
  await expect
    .poll(async () => Math.round((await dock.boundingBox())!.width))
    .toBe(Math.round(after.width))
  await page.getByRole('separator', { name: /Resize assistant/ }).dblclick()
  await expect
    .poll(async () => Math.round((await dock.boundingBox())!.width))
    .toBe(Math.round(before.width))
})

test('mobile workspace fits the viewport and settings work', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./')
  await expect(
    page.getByRole('img', { name: 'Sheet music, page 1' }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  )
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('Sheet music pages')).toBeVisible()
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true })
})

test('blocked local storage shows a warning while editing remains usable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
  })
  // Without storage the default compendium renders, which is slow on CI.
  test.slow()
  await page.goto('./')
  await expect(
    page.getByRole('img', { name: 'Sheet music, page 1' }),
  ).toBeVisible({ timeout: COMPENDIUM_RENDER })
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Browser storage is unavailable',
  )
  await page.getByLabel('LilyPond source').fill('invalid input')
  await expect(page.getByText('Could not render this source')).toBeVisible()
})

test('renderer data is downloaded once, even when renders are cancelled', async ({
  page,
}) => {
  const downloads = new Map<string, number>()
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.includes('/renderer/data/'))
      downloads.set(path, (downloads.get(path) ?? 0) + 1)
  })
  await page.goto('./')
  await expect(page.locator('.sheet-page:not(.stale)')).toBeVisible()
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  const original = await sourceOf(editor)
  for (const title of ['Second', 'Third', 'Fourth']) {
    await editor.fill(original.replace('A little beginning', title))
    // Long enough for the render to start, short enough to cancel it.
    await page.waitForTimeout(450)
  }
  await page.getByRole('tab', { name: 'Sheet music', exact: true }).click()
  await expect(page.locator('.sheet-page:not(.stale)')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Fourth' })).toBeVisible()
  // Tables load just in time: a single-staff score never reads the piano brace outlines.
  expect(
    [...downloads.keys()].some((path) =>
      path.endsWith('/optical-masters.json'),
    ),
  ).toBe(true)
  expect(
    [...downloads.keys()].some((path) => path.endsWith('/brace-glyphs.json')),
  ).toBe(false)
  expect(downloads.size).toBeLessThan(7)
  expect([...downloads.values()].every((count) => count === 1)).toBe(true)
})

test('the jazz fonts load only when a score selects them, and only the parts it uses', async ({
  page,
}) => {
  const downloads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.includes('/renderer/fonts/'))
      downloads.push(path.replace(/^.*\/renderer\/fonts\//, ''))
  })
  await page.goto('./')
  await expect(page.locator('.sheet-page:not(.stale)')).toBeVisible()
  expect(downloads).toEqual([])
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  await page.getByLabel('LilyPond source').fill(String.raw`\version "2.24.4"
\include "jazzchords.ily"
\include "lilyjazz.ily"
\header { title = "Jazz Fonts" }
<<
  \new ChordNames \chordmode { c1:m7 f:7 }
  \new Staff \relative c'' { c4 d8 es f4 g | a2 r }
>>`)
  await page.getByRole('tab', { name: 'Sheet music', exact: true }).click()
  await expect(page.locator('.sheet-page:not(.stale)')).toBeVisible()
  await expect(page.getByText('1 page · rendered locally')).toBeVisible()
  expect(downloads).toContain('lilyjazz/stylesheet/lilyjazz.ily')
  expect(downloads).toContain('lilyjazz/lilyjazz-20.otf')
  expect(downloads).toContain('lilyjazz/lilyjazz-chord.otf')
  expect(downloads).toContain('lilyjazz/lilyjazz-text.otf')
  // No piano brace and no unused optical sizes.
  expect(downloads).not.toContain('lilyjazz/lilyjazz-brace.otf')
  expect(downloads).not.toContain('lilyjazz/lilyjazz-26.otf')
  expect(new Set(downloads).size).toBe(downloads.length)
})

test('a fresh visit opens the LilyJAZZ lead sheet', async ({ page }) => {
  const downloads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.includes('/renderer/fonts/'))
      downloads.push(path.split('/renderer/fonts/')[1]!)
  })
  await page.addInitScript((key) => localStorage.removeItem(key), SCORE_KEY)
  await page.goto('./')
  await expect(page.getByText('1 page · rendered locally')).toBeVisible({
    timeout: COMPENDIUM_RENDER,
  })
  expect(downloads).toContain('lilyjazz/lilyjazz-20.otf')
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  await expect
    .poll(() => sourceOf(page.getByLabel('LilyPond source')))
    .toMatch(/title = "Late Light"/)
})

test('playback lights up the sounding note heads, pauses, and rewinds', async ({
  page,
}) => {
  await page.goto('./')
  await expect(page.getByText('1 page · rendered locally')).toBeVisible()
  const sounding = page.locator('.page-overlay .sounding')
  // The simple score has no \midi block; playback adds one.
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(sounding).toHaveCount(1)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(sounding).toHaveCount(1)
  await page.getByRole('button', { name: 'Back to the start' }).click()
  await expect(sounding).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Play', exact: true }),
  ).toBeVisible()
})

test('shows one page at a time, two when they fit, and turns pages', async ({
  page,
}) => {
  // Six pages, one bar each.
  const sixPages = String.raw`\version "2.24.4"
{ c'1 \pageBreak d'1 \pageBreak e'1 \pageBreak f'1 \pageBreak g'1 \pageBreak a'1 }
`
  await page.addInitScript(
    ([key, score]) => {
      // Only the first visit migrates it; reloads keep the stored document.
      if (!localStorage.getItem('score-chat.documents.v1'))
        localStorage.setItem(key, score)
    },
    [SCORE_KEY, sixPages],
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('./')
  const label = page.locator('.page-label')
  await expect(label).toHaveText('1 / 6')
  await expect(page.locator('.sheet-page')).toHaveCount(1)
  await expect(
    page.getByRole('button', { name: 'Previous page' }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(label).toHaveText('2 / 6')
  await page.keyboard.press('ArrowRight')
  await expect(label).toHaveText('3 / 6')
  await page.setViewportSize({ width: 2200, height: 900 })
  await expect(page.locator('.sheet-page')).toHaveCount(2)
  await expect(label).toHaveText('3–4 / 6')
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(label).toHaveText('5–6 / 6')
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled()
})

test('the assistant can move to another corner and hide while it works', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('./')
  const dock = page.getByRole('region', { name: 'Music assistant' })
  const heading = (await page.locator('.chat-heading').boundingBox())!
  await page.mouse.move(heading.x + 60, heading.y + 10)
  await page.mouse.down()
  await page.mouse.move(150, 120, { steps: 6 })
  await page.mouse.up()
  // Dragging is not a click: the dock stays as it was.
  await expect(page.locator('.chat-toggle')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  // The dock settles in the next frame.
  await expect.poll(async () => (await dock.boundingBox())!.x).toBeLessThan(40)
  expect((await dock.boundingBox())!.y).toBeLessThan(120)
  await page.reload()
  expect((await dock.boundingBox())!.x).toBeLessThan(40)

  await page.getByRole('button', { name: 'Hide assistant' }).click()
  await expect(dock).toBeHidden()
  const handle = page.getByRole('button', { name: /^Show assistant/ })
  expect((await handle.boundingBox())!.x).toBeLessThan(40)
  await handle.click()
  await expect(dock).toBeVisible()
})

test('the source editor completes commands and marks unsupported ones', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  await editor.fill(
    (await sourceOf(editor)).replace(
      '\\version "2.24.4"\n',
      '\\version "2.24.4"\n\\bogusThing\n',
    ),
  )
  await expect(page.locator('.cm-lintRange-error')).toHaveText('\\bogusThing')
  await page.locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  // Only what the renderer supports is suggested.
  await page.keyboard.type('\\whiteou')
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0)
  for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type('\\tupl')
  // Let the render of the typed text finish: its error marks clear while it
  // runs and return when it is done, and they settle the completion list.
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0)
  await expect(page.locator('.cm-lintRange-error').first()).toBeVisible()
  await expect(page.locator('.cm-completionLabel').first()).toHaveText(
    '\\tuplet',
  )
  await page.keyboard.press('Enter')
  await expect
    .poll(() => sourceOf(editor))
    .toMatch(/^\\version "2.24.4"\n\\tuplet\n/)
})

test('render errors point at their line and column in the source', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  await editor.fill('\\version "2.24.4"\n{ c4 d\n  \\foo e f }')
  await expect(page.locator('.cm-lintRange-error')).toHaveText('\\foo')
  await page.getByRole('tab', { name: 'Sheet music', exact: true }).click()
  await page.getByRole('button', { name: 'Line 3, column 3' }).click()
  await expect(
    page.getByRole('tab', { name: 'LilyPond', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toBe('\\foo')
})

test('switching views keeps the place in both the sheet music and the source', async ({
  page,
}) => {
  await page.goto('./')
  await expect(page.getByText('1 page · rendered locally')).toBeVisible()
  // Zoom in until the page is taller than the window.
  for (let i = 0; i < 4; i++)
    await page.getByRole('button', { name: 'Zoom in' }).click()
  const canvas = page.locator('#score-panel')
  // Scroll, then let the views see it for a couple of frames, as a reader would.
  const scrollTo = (element: Element, top: number) =>
    new Promise((resolve) => {
      element.scrollTo({ top })
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })
  await canvas.evaluate(scrollTo, 300)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  // Long enough to scroll; trailing comments leave the sheet music unchanged.
  await editor.fill(
    (await sourceOf(editor)) +
      Array.from({ length: 80 }, (_, i) => `% note ${i + 1}`).join('\n'),
  )
  const scroller = page.locator('.cm-scroller')
  await scroller.evaluate(scrollTo, 200)
  await page.getByRole('tab', { name: 'Sheet music', exact: true }).click()
  await expect
    .poll(() => canvas.evaluate((element) => element.scrollTop))
    .toBe(300)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(200)
})

test('with Cloudflare Access, signing in hands over to Access and reports when it did not finish', async ({
  page,
}) => {
  // The deployment says it signs in through Access; locally it uses links.
  await page.route('**/api/auth/config', (route) =>
    route.fulfill({ json: { method: 'access' } }),
  )
  // Access itself is Cloudflare's; here it sends the browser straight back
  // without a session, as a cancelled sign-in would.
  let handedOver = false
  await page.route('**/api/auth/access', (route) => {
    handedOver = true
    return route.fulfill({
      status: 302,
      headers: { Location: '/login?via=access' },
    })
  })
  await page.goto('./')
  await expect(page.getByText('1 page · rendered locally')).toBeVisible()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('emails you a one-time code')
  await expect(dialog.getByLabel('Email')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Continue to sign in' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Signing in with Cloudflare Access did not finish',
  )
  expect(handedOver).toBe(true)
  // Back home with the local score, not stuck on /login.
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.getByText('1 page · rendered locally')).toBeVisible()
})

test('when the sign-in email cannot be sent, the dialog says so instead of claiming it went out', async ({
  page,
}) => {
  await page.route('**/api/auth/request', (route) =>
    route.fulfill({
      status: 500,
      json: { error: 'Something went wrong. Try again.' },
    }),
  )
  await page.goto('./')
  await expect(page.getByText('1 page · rendered locally')).toBeVisible()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Email').fill('reader@example.com')
  await dialog.getByRole('button', { name: 'Email me a link' }).click()
  await expect(dialog).toContainText('Something went wrong')
  await expect(dialog).not.toContainText('We sent a sign-in link')
})

test('the first render of a page gets 30 seconds before it times out', async ({
  page,
}) => {
  // The renderer waits for its data, which never arrives.
  await page.route('**/renderer/data/**', () => {})
  await page.goto('./')
  await page.waitForTimeout(25_000)
  await expect(page.getByText('Rendering timed out')).toHaveCount(0)
  await expect(
    page.getByText('Rendering timed out after 30 seconds'),
  ).toBeVisible({ timeout: 10_000 })
})
