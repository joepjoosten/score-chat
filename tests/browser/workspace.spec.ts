import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'

// Most tests exercise a one-page score; the app's default is the multi-page saxophone compendium.
const simpleScore = readFileSync(
  new URL('./simple-score.ly', import.meta.url),
  'utf8',
)
const SCORE_KEY = 'score-chat.score.v1'
// The CodeMirror document behind the LilyPond source editor.
const sourceOf = (editor: Locator) =>
  editor.evaluate((content) =>
    [...content.querySelectorAll('.cm-line')]
      .map((line) => line.textContent)
      .join('\n'),
  )
// The six-page default score takes far longer to render on CI runners.
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

async function configure(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('OpenRouter API key').fill('test-key-only')
  await page.getByLabel('Model', { exact: true }).fill('openai/test-model')
  await page.getByRole('button', { name: 'Save settings' }).click()
}

// Builds a streamed chat completion (server-sent events) the way OpenRouter
// sends it: one chunk per text delta or tool call, then the finish reason.
function stream(
  message: { reasoning?: string; content?: string; tool_calls?: object[] },
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
  const deltas = [
    ...(message.reasoning ?? '')
      .split(/(?<=\n)/)
      .filter(Boolean)
      .map((reasoning) => chunk({ role: 'assistant', reasoning })),
    ...(message.content ?? '')
      .split(/(?<= )/)
      .map((content) => chunk({ role: 'assistant', content })),
  ]
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
    (await sourceOf(editor)).replace('A little beginning', 'My first score'),
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
  const original = await sourceOf(editor)
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
        // The score is fetched through tools rather than embedded in the prompt.
        expect(body.messages[0].content[0].text).not.toContain(original)
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
  await expect.poll(() => sourceOf(editor)).toEqual(changed)
  expect(calls).toBe(2)
  await page
    .getByRole('button', { name: 'Undo last score replacement' })
    .click()
  await expect.poll(() => sourceOf(editor)).toEqual(original)
  const redo = page.getByRole('button', { name: 'Redo score replacement' })
  await redo.click()
  await expect.poll(() => sourceOf(editor)).toEqual(changed)
  await page
    .getByRole('button', { name: 'Undo last score replacement' })
    .click()
  await expect.poll(() => sourceOf(editor)).toEqual(original)
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
  // The swipe also covers the time signature and the dynamic under the notes.
  await expect(chip).toContainText(
    '4 notes, 1 time signature, 1 dynamic highlighted',
  )
  await expect(chip).toContainText('\\time 4/4 c4 \\p e g e')
  await expect(page.locator('.page-overlay .marker')).toHaveCount(1)
  // Tapping a highlighted note lifts the marker from it again.
  const tap = at(23.5, 23.2)
  await page.mouse.click(tap.x, tap.y)
  await expect(chip).toContainText(
    '3 notes, 1 time signature, 1 dynamic highlighted',
  )
  await expect(chip).toContainText('\\time 4/4 \\p e g e')

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
        expect(text).toContain(
          'highlighted 3 notes, 1 time signature, 1 dynamic',
        )
        expect(text).toContain('Line 14: `    c4\\\\p e g e | f4 a g2 |`')
        expect(text).toContain('line 14, columns 7-8 (dynamic): `\\\\p`')
        expect(text).toContain('line 14, columns 10-10 (note): `e`')
        expect(text).toContain('line 14, columns 12-12 (note): `g`')
        expect(text).toContain('line 14, columns 14-14 (note): `e`')
        expect(text).not.toContain('`c4`')
        await route.fulfill(
          stream(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'edit-1',
                  type: 'function',
                  function: {
                    name: 'edit_score',
                    arguments: JSON.stringify({
                      edits: [
                        {
                          old_text: 'c4\\p e g e |',
                          new_text: 'c4\\p e-. g-. e-. |',
                        },
                      ],
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
    '\\time 4/4 \\p e g e',
  )
  expect(calls).toBe(2)
  // The edit invalidates the highlight; the chip is gone and the score changed.
  await expect(chip).toHaveCount(0)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const edited = await sourceOf(page.getByLabel('LilyPond source'))
  expect(edited).toContain('    c4\\p e-. g-. e-. | f4 a g2 |\n')
  expect(edited).not.toContain('c4\\p e g e |')
})

test('highlighting works even when the score turns point-and-click off', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
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

test('agent searches, edits with exact replacements, and shows its thinking', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  const original = await sourceOf(editor)
  const thoughts = Array.from(
    { length: 14 },
    (_, index) => `thought ${index + 1}`,
  ).join('\n')
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const bodies: { messages: { role: string; content: unknown }[] }[] = []
  const call = (id: string, name: string, args: object) => ({
    tool_calls: [
      {
        index: 0,
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  })
  await page.route(
    'https://openrouter.ai/api/v1/chat/completions',
    async (route) => {
      bodies.push(route.request().postDataJSON())
      if (bodies.length === 1)
        await route.fulfill(
          stream(
            {
              reasoning: thoughts,
              ...call('find', 'search_score', { query: 'andante' }),
            },
            'tool_calls',
          ),
        )
      else if (bodies.length === 2) {
        await held
        await route.fulfill(
          stream(
            call('edit', 'edit_score', {
              edits: [{ old_text: '"Andante"', new_text: '"Allegro"' }],
            }),
            'tool_calls',
          ),
        )
      } else await route.fulfill(stream({ content: 'Now it is Allegro.' }))
    },
  )
  await page.getByLabel('Message the music assistant').fill('Make it faster')
  await page.getByRole('button', { name: 'Send message' }).click()
  // While the model is still working, its thinking tails the last ten lines.
  const thinking = page.locator('.thinking-text')
  await expect(thinking).toBeVisible()
  await expect(thinking).toContainText('thought 14')
  const lineHeight = await thinking.evaluate(
    (element) => parseFloat(getComputedStyle(element).lineHeight) || 16.5,
  )
  expect((await thinking.boundingBox())!.height).toBeLessThan(
    lineHeight * 11 + 12,
  )
  release()
  await expect(page.getByText('Now it is Allegro.')).toBeVisible()
  await expect
    .poll(() => sourceOf(editor))
    .toEqual(original.replace('"Andante"', '"Allegro"'))
  const searched = bodies[1].messages.find(
    (message) => message.role === 'tool',
  )!.content as string
  // Tool results reach the model as plain text, not JSON-encoded strings.
  expect(searched).toMatch(/^1 matching line\(s\):\n\d+\t\s+\\tempo "Andante"/)
  expect(JSON.stringify(bodies[2].messages)).toContain('Applied successfully')
  // Once done, the thinking folds away fully and can be expanded in full.
  await expect(thinking).toHaveCount(0)
  await page.getByRole('button', { name: 'Thought process' }).click()
  await expect(thinking).toContainText('thought 1\n')
  await expect(thinking).toContainText('thought 14')
  expect((await thinking.boundingBox())!.height).toBeGreaterThan(
    lineHeight * 13,
  )
})

test('agent searches and reads the bundled LilyPond documentation', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
  const results: string[] = []
  const call = (id: string, name: string, args: object) =>
    stream(
      {
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      'tool_calls',
    )
  await page.route(
    'https://openrouter.ai/api/v1/chat/completions',
    async (route) => {
      const messages = route.request().postDataJSON().messages
      const tool = messages.at(-1)
      if (tool.role === 'tool') results.push(tool.content)
      if (results.length === 0)
        await route.fulfill(
          call('find', 'search_docs', {
            query: 'crescendo hairpin',
            kind: 'notation',
          }),
        )
      else if (results.length === 1)
        await route.fulfill(call('read', 'read_doc', { id: 'dynamics' }))
      else await route.fulfill(stream({ content: 'Use \\< and \\!.' }))
    },
  )
  await page
    .getByLabel('Message the music assistant')
    .fill('How do hairpins work?')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.locator('.message.assistant')).toContainText('Use')
  expect(results[0]).toMatch(/^Top \d+ results for "crescendo hairpin"/)
  expect(results[0]).toContain('Dynamics [notation] id: dynamics')
  expect(results[1]).toMatch(
    /^# Dynamics\nLilyPond 2\.24\.4 Notation Reference/,
  )
  expect(results[1]).toContain('Example (renders in Score Chat):')
  expect(results[1]).toContain('\\version "2.24.4"')
})

test('the thinking setting sets the reasoning effort sent to OpenRouter', async ({
  page,
}) => {
  await page.goto('./')
  await configure(page)
  const bodies: Record<string, unknown>[] = []
  await page.route('https://openrouter.ai/api/v1/chat/completions', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill(stream({ content: 'Hi.' }))
  })
  const ask = async () => {
    await page.getByLabel('Message the music assistant').fill('Hello')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByLabel('Message the music assistant')).toBeEnabled()
  }
  await ask()
  expect(bodies[0]).not.toHaveProperty('reasoning')
  expect(bodies[0].max_tokens).toBe(8192)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Thinking').selectOption('high')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.reload()
  await ask()
  expect(bodies[1].reasoning).toEqual({ effort: 'high' })
  expect(bodies[1].max_tokens).toBe(16384)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Thinking').selectOption('Off')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await ask()
  expect(bodies[2].reasoning).toEqual({ effort: 'none' })
  expect(bodies[2].max_tokens).toBe(8192)
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
  const after = (await dock.boundingBox())!
  expect(Math.round(after.width - before.width)).toBe(200)
  expect(after.y).toBeLessThan(before.y - 200)
  await page.reload()
  expect(Math.round((await dock.boundingBox())!.width)).toBe(
    Math.round(after.width),
  )
  await page.getByRole('separator', { name: /Resize assistant/ }).dblclick()
  expect(Math.round((await dock.boundingBox())!.width)).toBe(
    Math.round(before.width),
  )
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
  const original = await sourceOf(page.getByLabel('LilyPond source'))
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
  await expect
    .poll(() => sourceOf(page.getByLabel('LilyPond source')))
    .toEqual(original)
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
  expect(downloads.size).toBe(7)
  expect([...downloads.values()].every((count) => count === 1)).toBe(true)
})

test('a fresh visit opens the alto saxophone compendium', async ({ page }) => {
  test.slow()
  await page.addInitScript((key) => localStorage.removeItem(key), SCORE_KEY)
  await page.goto('./')
  await expect(page.getByText('6 pages · rendered locally')).toBeVisible({
    timeout: COMPENDIUM_RENDER,
  })
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  await expect
    .poll(() => sourceOf(page.getByLabel('LilyPond source')))
    .toMatch(/title = "The Complete Alto Saxophone"/)
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
  await page.addInitScript((key) => localStorage.removeItem(key), SCORE_KEY)
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
  const moved = (await dock.boundingBox())!
  expect(moved.x).toBeLessThan(40)
  expect(moved.y).toBeLessThan(120)
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
