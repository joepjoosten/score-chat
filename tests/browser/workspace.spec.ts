import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'

async function configure(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('OpenRouter API key').fill('test-key-only')
  await page.getByLabel('Model', { exact: true }).fill('openai/test-model')
  await page.getByRole('button', { name: 'Save settings' }).click()
}

// Builds a streamed chat completion (server-sent events) the way OpenRouter
// sends it: one chunk per text delta or tool call, then the finish reason.
function stream(
  message: { content?: string; tool_calls?: object[] },
  finish = 'stop',
) {
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'test-completion',
      model: 'openai/test-model',
      object: 'chat.completion.chunk',
      created: 1,
      choices: [{ index: 0, delta, finish_reason, logprobs: null }],
    })}\n\n`
  const deltas = (message.content ?? '')
    .split(/(?<= )/)
    .map((content) => chunk({ role: 'assistant', content }))
  if (message.tool_calls)
    deltas.push(chunk({ role: 'assistant', tool_calls: message.tool_calls }))
  return {
    status: 200,
    contentType: 'text/event-stream',
    body: deltas.join('') + chunk({}, finish) + 'data: [DONE]\n\n',
  }
}

test('renders locally, switches views, persists edits and preferences, and downloads', async ({
  page,
}) => {
  const external: string[] = []
  page.on('request', (request) => {
    if (
      !request.url().startsWith('http://127.0.0.1:4173') &&
      !request.url().startsWith('data:')
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
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  await editor.fill(
    (await editor.inputValue()).replace('A little beginning', 'My first score'),
  )
  await page.reload()
  await expect(editor).toContainText('My first score')
  await expect(
    page.getByRole('tab', { name: 'LilyPond', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await configure(page)
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('OpenRouter API key')).toHaveValue(
    'test-key-only',
  )
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(
    'openai/test-model',
  )
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

test('agent executes a validated score edit through Effect AI and preserves tool results', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  const original = await editor.inputValue()
  const changed = original.replace('A little beginning', 'A playful beginning')
  let calls = 0
  await page.route(
    'https://openrouter.ai/api/v1/chat/completions',
    async (route) => {
      const body = route.request().postDataJSON()
      expect(route.request().headers().authorization).toBe(
        'Bearer test-key-only',
      )
      expect(body.model).toBe('openai/test-model')
      expect(
        body.tools.map(
          (tool: { function: { name: string } }) => tool.function.name,
        ),
      ).toContain('update_score')
      calls++
      if (calls === 1) {
        expect(body.messages[0].content[0].text).toContain(original)
        await route.fulfill(
          stream(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'edit-1',
                  type: 'function',
                  function: {
                    name: 'update_score',
                    arguments: JSON.stringify({ source: changed }),
                  },
                },
              ],
            },
            'tool_calls',
          ),
        )
      } else {
        expect(
          body.messages.some(
            (message: { role: string; content: string }) =>
              message.role === 'tool' &&
              message.content.includes('Applied successfully'),
          ),
        ).toBe(true)
        await route.fulfill(
          stream({
            content:
              'I updated the **score title**.\n\n- Old: `A little beginning`\n- New: `A playful beginning`',
          }),
        )
      }
    },
  )
  await page
    .getByLabel('Message the music assistant')
    .fill('Change the title to A playful beginning')
  await page.getByRole('button', { name: 'Send message' }).click()
  const reply = page.locator('.message.assistant')
  await expect(reply).toContainText('I updated the score title.')
  // Markdown is rendered rather than shown as raw text.
  await expect(reply.locator('strong')).toHaveText('score title')
  await expect(reply.locator('li code')).toHaveText([
    'A little beginning',
    'A playful beginning',
  ])
  await expect(reply).not.toContainText('**')
  await expect(editor).toHaveValue(changed)
  expect(calls).toBe(2)
  await page
    .getByRole('button', { name: 'Undo last score replacement' })
    .click()
  await expect(editor).toHaveValue(original)
  const redo = page.getByRole('button', { name: 'Redo score replacement' })
  await redo.click()
  await expect(editor).toHaveValue(changed)
  await page
    .getByRole('button', { name: 'Undo last score replacement' })
    .click()
  await expect(editor).toHaveValue(original)
  // Editing by hand after an undo discards the redo branch.
  await editor.fill(original + '% edited\n')
  await expect(redo).toBeDisabled()
})

test('highlighted notes reach the model as source positions and get edited', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
  const image = page.getByRole('img', { name: 'Sheet music, page 1' })
  await expect(image).toBeVisible()
  await expect(page.locator('.sheet-page:not(.stale)')).toBeVisible()
  await page
    .getByRole('button', { name: 'Highlight notes for the assistant' })
    .click()
  // Swipe across the first bar. The page viewBox is 119.5 x 169 units and the
  // first system's note heads sit around y = 22, starting at x ≈ 23.
  const box = (await image.boundingBox())!
  const at = (x: number, y: number) => ({
    x: box.x + (x / 119.5015) * box.width,
    y: box.y + (y / 169.0093) * box.height,
  })
  const from = at(20, 19)
  const to = at(45, 25)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  const chip = page.locator('.selection-chip')
  await expect(chip).toContainText('4 notes highlighted')
  await expect(chip).toContainText('c4 e g e')
  await expect(page.locator('.page-overlay .marker')).toHaveCount(1)
  // Tapping a highlighted note lifts the marker from it again.
  const tap = at(23.5, 23.2)
  await page.mouse.click(tap.x, tap.y)
  await expect(chip).toContainText('3 notes highlighted')
  await expect(chip).toContainText('e g e')

  let original = ''
  let calls = 0
  await page.route(
    'https://openrouter.ai/api/v1/chat/completions',
    async (route) => {
      const body = route.request().postDataJSON()
      calls++
      if (calls === 1) {
        const user = body.messages.findLast(
          (message: { role: string }) => message.role === 'user',
        )
        const text = JSON.stringify(user.content)
        expect(text).toContain('Add staccato')
        expect(text).toContain('highlighted 3 notes')
        expect(text).toContain('line 14, columns 10-10: `e`')
        expect(text).toContain('line 14, columns 12-12: `g`')
        expect(text).toContain('line 14, columns 14-14: `e`')
        expect(text).not.toContain('`c4`')
        original =
          body.messages[0].content[0].text.split('Current score:\n\n')[1]
        await route.fulfill(
          stream(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'edit-1',
                  type: 'function',
                  function: {
                    name: 'update_score',
                    arguments: JSON.stringify({
                      source: original.replace(
                        'c4\\p e g e |',
                        'c4\\p e-. g-. e-. |',
                      ),
                    }),
                  },
                },
              ],
            },
            'tool_calls',
          ),
        )
      } else {
        await route.fulfill(
          stream({ content: 'Added staccato to the three notes.' }),
        )
      }
    },
  )
  await page.getByLabel('Message the music assistant').fill('Add staccato')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.locator('.message.assistant')).toContainText(
    'Added staccato to the three notes.',
  )
  await expect(page.locator('.message.user .message-selection')).toHaveText(
    'e g e',
  )
  expect(calls).toBe(2)
  // The edit invalidates the highlight; the chip is gone and the score changed.
  await expect(chip).toHaveCount(0)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  await expect(page.getByLabel('LilyPond source')).toHaveValue(
    original.replace('c4\\p e g e |', 'c4\\p e-. g-. e-. |'),
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
  expect(await image.evaluate((node) => node.tagName)).toBe('DIV')
  const systems = image.locator('svg g.system[data-system-id]')
  expect(await systems.count()).toBeGreaterThanOrEqual(2)
  // The inline page scales like the image did (no fixed millimetre size).
  expect(await image.locator('svg').getAttribute('width')).toBeNull()
  // The choice persists, and the highlighter still maps onto the inline page.
  await page.reload()
  expect(await image.evaluate((node) => node.tagName)).toBe('DIV')
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
  await expect(page.locator('.selection-chip')).toContainText('c4 e g e')
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

test('handles provider errors without exposing the API key', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
  await page.route('https://openrouter.ai/api/v1/chat/completions', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { message: 'test-key-only is invalid', code: 401 } },
    }),
  )
  await page.getByLabel('Message the music assistant').fill('Hello')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('alert')).toContainText('Check your API key')
  await expect(page.locator('body')).not.toContainText('test-key-only')
  await expect(page.getByLabel('Message the music assistant')).toBeEnabled()
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
  await configure(page)
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true })
})

test('invalid agent edits return diagnostics and leave the score unchanged', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const original = await page.getByLabel('LilyPond source').inputValue()
  let calls = 0
  await page.route(
    'https://openrouter.ai/api/v1/chat/completions',
    async (route) => {
      calls++
      if (calls === 1) {
        await route.fulfill(
          stream(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'bad-edit',
                  type: 'function',
                  function: {
                    name: 'update_score',
                    arguments: JSON.stringify({ source: 'invalid score' }),
                  },
                },
              ],
            },
            'tool_calls',
          ),
        )
      } else {
        expect(
          JSON.stringify(route.request().postDataJSON().messages),
        ).toContain('Validation failed')
        await route.fulfill(
          stream({
            content: 'That notation is unsupported; your score is unchanged.',
          }),
        )
      }
    },
  )
  await page
    .getByLabel('Message the music assistant')
    .fill('Try an unsupported change')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.getByText('That notation is unsupported; your score is unchanged.'),
  ).toBeVisible()
  await expect(page.getByLabel('LilyPond source')).toHaveValue(original)
  await expect(
    page.getByRole('button', { name: 'Undo last score replacement' }),
  ).toBeDisabled()
})

test('Stop cancels an in-flight model request and unlocks the workspace', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    'https://openrouter.ai/api/v1/chat/completions',
    async (route) => {
      await held
      await route.abort().catch(() => {})
    },
  )
  const request = page.waitForRequest(
    'https://openrouter.ai/api/v1/chat/completions',
  )
  await page.getByLabel('Message the music assistant').fill('Compose a melody')
  await page.getByRole('button', { name: 'Send message' }).click()
  await request
  await page.getByRole('button', { name: 'Stop response' }).click()
  await expect(page.getByRole('alert')).toContainText('Stopped.')
  await expect(page.getByLabel('Message the music assistant')).toBeEnabled()
  release()
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
  await page.goto('./')
  await expect(
    page.getByRole('img', { name: 'Sheet music, page 1' }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Browser storage is unavailable',
  )
  await page.getByLabel('LilyPond source').fill('invalid input')
  await expect(page.getByText('Could not render this source')).toBeVisible()
})
