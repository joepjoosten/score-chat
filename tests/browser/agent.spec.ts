import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  configure,
  openDocument,
  requestLink,
  signIn,
  sourceOf,
  unique,
} from './helpers.ts'
import { release, requestsFor, script, stream, toolCall } from './openrouter.ts'

// Signed in: documents live in their Durable Object and the assistant runs
// there, against the OpenRouter stand-in scripted per test.

const simpleScore = readFileSync(
  new URL('./simple-score.ly', import.meta.url),
  'utf8',
)

/** Signs in, opens a server document with the simple score, and stores a key of its own. */
async function setUp(page: Page) {
  const key = unique('sk-or-test')
  await signIn(page)
  await openDocument(page, simpleScore)
  await configure(page, key)
  return key
}

async function ask(page: Page, text: string) {
  await page.getByLabel('Message the music assistant').fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
}

const toolResults = (messages: { role: string; content: unknown }[]) =>
  messages
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))

test('agent executes a validated score edit through Effect AI and preserves tool results', async ({
  page,
}) => {
  const key = await setUp(page)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  const original = await sourceOf(editor)
  const changed = original.replace('A little beginning', 'A playful beginning')
  await script(key, [
    { events: toolCall('edit-1', 'update_score', { source: changed }) },
    {
      events: stream({
        content:
          'I updated the **score title**.\n\n- Old: `A little beginning`\n- New: `A playful beginning`',
      }),
    },
  ])
  await ask(page, 'Change the title to A playful beginning')
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
  const requests = await requestsFor(key)
  expect(requests).toHaveLength(2)
  for (const { authorization, body } of requests) {
    expect(authorization).toBe(`Bearer ${key}`)
    expect(body.model).toBe('openai/test-model')
    expect(body.tools!.map((tool) => tool.function.name)).toContain(
      'update_score',
    )
  }
  // The score is fetched through tools rather than embedded in the prompt.
  expect(JSON.stringify(requests[0]!.body.messages[0])).not.toContain(original)
  expect(toolResults(requests[1]!.body.messages).join()).toContain(
    'Applied successfully',
  )

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
  // The undo and the hand edit are saved to the document.
  await page.waitForTimeout(1000)
  await page.reload()
  await expect.poll(() => sourceOf(editor)).toEqual(original + '% edited\n')
})

test('highlighted notes reach the model as source positions and get edited', async ({
  page,
}) => {
  const key = await setUp(page)
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

  await script(key, [
    {
      events: toolCall('edit-1', 'edit_score', {
        edits: [{ old_text: 'c4\\p e g e |', new_text: 'c4\\p e-. g-. e-. |' }],
      }),
    },
    { events: stream({ content: 'Added staccato to the three notes.' }) },
  ])
  await ask(page, 'Add staccato')
  await expect(page.locator('.message.assistant')).toContainText(
    'Added staccato to the three notes.',
  )
  await expect(page.locator('.message.user .message-selection')).toHaveText(
    '\\time 4/4 \\p e g e',
  )
  const requests = await requestsFor(key)
  expect(requests).toHaveLength(2)
  const user = requests[0]!.body.messages.findLast(
    (message) => message.role === 'user',
  )!
  const text = JSON.stringify(user.content)
  expect(text).toContain('Add staccato')
  expect(text).toContain('highlighted 3 notes, 1 time signature, 1 dynamic')
  expect(text).toContain('Line 14: `    c4\\\\p e g e | f4 a g2 |`')
  expect(text).toContain('line 14, columns 7-8 (dynamic): `\\\\p`')
  expect(text).toContain('line 14, columns 10-10 (note): `e`')
  expect(text).toContain('line 14, columns 12-12 (note): `g`')
  expect(text).toContain('line 14, columns 14-14 (note): `e`')
  expect(text).not.toContain('`c4`')
  // The edit invalidates the highlight; the chip is gone and the score changed.
  await expect(chip).toHaveCount(0)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const edited = await sourceOf(page.getByLabel('LilyPond source'))
  expect(edited).toContain('    c4\\p e-. g-. e-. | f4 a g2 |\n')
  expect(edited).not.toContain('c4\\p e g e |')
})

test('agent searches, edits with exact replacements, and shows its thinking', async ({
  page,
}) => {
  const key = await setUp(page)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  const original = await sourceOf(editor)
  const thoughts = Array.from(
    { length: 14 },
    (_, index) => `thought ${index + 1}`,
  ).join('\n')
  await script(key, [
    // Thinking and the search arrive together; the next step waits until released.
    {
      events: [
        ...stream({ reasoning: thoughts }).slice(0, 14),
        ...toolCall('find', 'search_score', { query: 'andante' }),
      ],
    },
    {
      held: true,
      events: toolCall('edit', 'edit_score', {
        edits: [{ old_text: '"Andante"', new_text: '"Allegro"' }],
      }),
    },
    { events: stream({ content: 'Now it is Allegro.' }) },
  ])
  await ask(page, 'Make it faster')
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
  await release(key)
  await expect(page.getByText('Now it is Allegro.')).toBeVisible()
  await expect
    .poll(() => sourceOf(editor))
    .toEqual(original.replace('"Andante"', '"Allegro"'))
  const requests = await requestsFor(key)
  const searched = toolResults(requests[1]!.body.messages)[0]!
  // Tool results reach the model as plain text, not JSON-encoded strings.
  expect(searched).toMatch(/^1 matching line\(s\):\n\d+\t\s+\\tempo "Andante"/)
  expect(JSON.stringify(requests[2]!.body.messages)).toContain(
    'Applied successfully',
  )
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
  const key = await setUp(page)
  await script(key, [
    {
      events: toolCall('find', 'search_docs', {
        query: 'crescendo hairpin',
        kind: 'notation',
      }),
    },
    { events: toolCall('read', 'read_doc', { id: 'dynamics' }) },
    { events: stream({ content: 'Use \\< and \\!.' }) },
  ])
  await ask(page, 'How do hairpins work?')
  await expect(page.locator('.message.assistant')).toContainText('Use')
  const results = toolResults((await requestsFor(key)).at(-1)!.body.messages)
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
  const key = await setUp(page)
  const replies = page.locator('.message.assistant')
  await script(
    key,
    [1, 2, 3].map(() => ({ events: stream({ content: 'Hi.' }) })),
  )
  const turn = async (count: number) => {
    await ask(page, 'Hello')
    await expect(replies).toHaveCount(count)
    await expect(replies.nth(count - 1)).toContainText('Hi.')
    await expect(page.getByLabel('Message the music assistant')).toBeEnabled()
  }
  await turn(1)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Thinking').selectOption('high')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await turn(2)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('Thinking')).toHaveValue('high')
  await page.getByLabel('Thinking').selectOption('Off')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await turn(3)
  const bodies = (await requestsFor(key)).map((request) => request.body)
  expect(bodies[0]).not.toHaveProperty('reasoning')
  expect(bodies[0]!.max_tokens).toBe(8192)
  expect(bodies[1]!.reasoning).toEqual({ effort: 'high' })
  expect(bodies[1]!.max_tokens).toBe(16384)
  expect(bodies[2]!.reasoning).toEqual({ effort: 'none' })
  expect(bodies[2]!.max_tokens).toBe(8192)
})

test('handles provider errors without exposing the API key', async ({
  page,
}) => {
  const key = await setUp(page)
  await script(key, [
    {
      status: 401,
      json: { error: { message: `${key} is invalid`, code: 401 } },
    },
  ])
  await ask(page, 'Hello')
  await expect(page.getByRole('alert')).toContainText(
    'did not accept your API key',
  )
  await expect(page.locator('body')).not.toContainText(key)
  await expect(page.getByLabel('Message the music assistant')).toBeEnabled()
  // The key is never sent back to the browser, not even in Settings.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByLabel('OpenRouter API key')).toHaveValue('')
  await expect(page.getByLabel('OpenRouter API key')).toHaveAttribute(
    'placeholder',
    /saved/,
  )
})

test('invalid agent edits return diagnostics and leave the score unchanged', async ({
  page,
}) => {
  const key = await setUp(page)
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const original = await sourceOf(page.getByLabel('LilyPond source'))
  await script(key, [
    {
      events: toolCall('bad-edit', 'update_score', { source: 'invalid score' }),
    },
    {
      events: stream({
        content: 'That notation is unsupported; your score is unchanged.',
      }),
    },
  ])
  await ask(page, 'Try an unsupported change')
  await expect(
    page.getByText('That notation is unsupported; your score is unchanged.'),
  ).toBeVisible()
  expect(
    toolResults((await requestsFor(key))[1]!.body.messages).join(),
  ).toContain('Validation failed')
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
  const key = await setUp(page)
  await script(key, [{ hang: true }])
  await ask(page, 'Compose a melody')
  await expect.poll(async () => (await requestsFor(key)).length).toBe(1)
  await page.getByRole('button', { name: 'Stop response' }).click()
  await expect(page.getByRole('alert')).toContainText('Stopped.')
  await expect(page.getByLabel('Message the music assistant')).toBeEnabled()
})

test('keeps several scores: create, switch between and delete them', async ({
  page,
}) => {
  await signIn(page)
  await openDocument(page, simpleScore)
  const first = page.url()
  await page.getByRole('button', { name: 'Documents' }).click()
  await page.getByRole('button', { name: 'New score' }).click()
  // A new score starts from the LilyJAZZ lead sheet, at its own address.
  await expect(page.getByRole('heading', { name: 'Late Light' })).toBeVisible()
  await expect(page).not.toHaveURL(first)
  const second = page.url()
  await page.getByRole('button', { name: 'Documents' }).click()
  const menu = page.getByRole('menu', { name: 'Documents' })
  await expect(menu.getByRole('link')).toHaveCount(2)
  await menu.getByRole('link', { name: /A little beginning/ }).click()
  await expect(page).toHaveURL(first)
  await expect(
    page.getByRole('heading', { name: 'A little beginning' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Documents' }).click()
  await menu.getByRole('button', { name: 'Delete Late Light' }).click()
  await expect(menu.getByRole('link')).toHaveCount(1)
  // A deleted score is gone for good.
  await page.goto(second)
  await expect(page).not.toHaveURL(second)
})

test('signing in moves this browser’s scores into the account, and the chat stays', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByText('rendered locally')).toBeVisible({
    timeout: 60_000,
  })
  await page.getByRole('tab', { name: 'LilyPond', exact: true }).click()
  const editor = page.getByLabel('LilyPond source')
  await editor.fill(
    (await sourceOf(editor)).replace('Late Light', 'Moved Light'),
  )
  await expect
    .poll(() =>
      page.evaluate(
        () => localStorage.getItem('score-chat.documents.v1') ?? '',
      ),
    )
    .toContain('Moved Light')
  // Sending while signed out asks to sign in first.
  await page.getByLabel('Message the music assistant').fill('Hello')
  await page.getByLabel('Message the music assistant').press('Enter')
  await expect(
    page
      .getByRole('dialog', { name: /Sign in/ })
      .or(page.locator('.login-dialog')),
  ).toBeVisible()
  const { link } = await requestLink(page)
  await page.goto(link)
  await expect(page).toHaveURL(/\/d\/(?!local-)[\w-]+$/)
  await expect(page.getByRole('heading', { name: 'Moved Light' })).toBeVisible()
  expect(
    await page.evaluate(() => localStorage.getItem('score-chat.documents.v1')),
  ).toBe('[]')
  const key = unique('sk-or-test')
  await configure(page, key)
  await script(key, [{ events: stream({ content: 'Hello from the server.' }) }])
  await ask(page, 'Hello')
  await expect(page.locator('.message.assistant')).toContainText(
    'Hello from the server.',
  )
  await page.reload()
  await expect(page.locator('.message.user')).toContainText('Hello')
  await expect(page.locator('.message.assistant')).toContainText(
    'Hello from the server.',
  )
})

test('the agent keeps working while the connection drops, and the reply arrives once', async ({
  page,
}) => {
  // Keeps the page's sockets reachable, to cut the connection mid-reply.
  await page.addInitScript(() => {
    const sockets: WebSocket[] = []
    ;(window as unknown as { sockets: WebSocket[] }).sockets = sockets
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (String(url).includes('/api/documents/')) sockets.push(this)
      }
    }
  })
  const key = await setUp(page)
  const words = Array.from({ length: 30 }, (_, index) => `word${index + 1}`)
  await script(key, [
    { events: stream({ content: words.join(' ') }), delay: 80 },
  ])
  await ask(page, 'Say thirty words')
  const reply = page.locator('.message.assistant .message-body')
  await expect(reply).toContainText('word3')
  await page.evaluate(() =>
    (window as unknown as { sockets: WebSocket[] }).sockets.at(-1)!.close(),
  )
  await expect(reply).toContainText('word30', { timeout: 30_000 })
  await expect(page.getByLabel('Message the music assistant')).toBeEnabled()
  expect((await reply.innerText()).trim()).toBe(words.join(' '))
  // It reconnected rather than giving up.
  expect(
    await page.evaluate(
      () => (window as unknown as { sockets: WebSocket[] }).sockets.length,
    ),
  ).toBeGreaterThan(1)
})
