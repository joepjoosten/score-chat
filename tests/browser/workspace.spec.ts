import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

async function configure(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('OpenRouter API key').fill('test-key-only')
  await page.getByLabel('Model', { exact: true }).fill('openai/test-model')
  await page.getByRole('button', { name: 'Save settings' }).click()
}

function response(message: object, finish = 'stop') {
  return {
    id: 'test-completion',
    model: 'openai/test-model',
    object: 'chat.completion',
    created: 1,
    system_fingerprint: null,
    choices: [{ index: 0, finish_reason: finish, logprobs: null, message }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
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

test('imports a score, reports invalid input, and recovers with undo', async ({
  page,
}) => {
  await page.goto('./')
  await expect(
    page.getByRole('img', { name: 'Sheet music, page 1' }),
  ).toBeVisible()
  await page.getByLabel('Import LilyPond file').setInputFiles({
    name: 'bad.ly',
    mimeType: 'text/plain',
    buffer: Buffer.from('not lilypond'),
  })
  await expect(page.getByText('Could not render this source')).toBeVisible()
  await page
    .getByRole('button', { name: 'Undo last score replacement' })
    .click()
  await expect(
    page.getByRole('img', { name: 'Sheet music, page 1' }),
  ).toBeVisible()
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
        await route.fulfill({
          json: response(
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
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
        })
      } else {
        expect(
          body.messages.some(
            (message: { role: string; content: string }) =>
              message.role === 'tool' &&
              message.content.includes('Applied successfully'),
          ),
        ).toBe(true)
        await route.fulfill({
          json: response({
            role: 'assistant',
            content: 'I updated the score title.',
          }),
        })
      }
    },
  )
  await page
    .getByLabel('Message the music assistant')
    .fill('Change the title to A playful beginning')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('I updated the score title.')).toBeVisible()
  await expect(editor).toHaveValue(changed)
  expect(calls).toBe(2)
  await page
    .getByRole('button', { name: 'Undo last score replacement' })
    .click()
  await expect(editor).toHaveValue(original)
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
        await route.fulfill({
          json: response(
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
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
        })
      } else {
        expect(
          JSON.stringify(route.request().postDataJSON().messages),
        ).toContain('Validation failed')
        await route.fulfill({
          json: response({
            role: 'assistant',
            content: 'That notation is unsupported; your score is unchanged.',
          }),
        })
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
