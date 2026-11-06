/**
 * End-to-end check of the Worker, its DocumentAgent and D1, against
 * `alchemy dev` and a stand-in for OpenRouter. Run with `npm run test:server`,
 * which starts both. No paid model requests are made.
 *
 * It signs in through a magic link, stores an API key, creates a document,
 * and has the agent edit it over the document socket, dropping the
 * connection partway and resuming from the last event.
 */
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type ServerResponse,
} from 'node:http'
import { join } from 'node:path'

const APP = process.env.APP_URL ?? 'http://localhost:1337'
const MOCK_PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 8788)
const EMAIL_DIR = '.alchemy/local/email'
const origin = new URL(APP).origin
const email = `agent-${Date.now()}@example.com`
const simple = await readFile(
  new URL('../browser/simple-score.ly', import.meta.url),
  'utf8',
)

// --- A stand-in for OpenRouter's streaming chat completions -----------------

const requests: {
  messages: { role: string; content: unknown }[]
  authorization?: string
}[] = []
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'test',
    model: 'test/model',
    object: 'chat.completion.chunk',
    created: 1,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  })}\n\n`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// --- A stand-in for the PDF converter ----------------------------------------

const CONVERTED = `\\version "2.24.4"\n\\header { title = "Converted" }\n{ c'4 }\n`
/** While set, conversions wait, so a test can see them queued. */
let holdConversions: Promise<void> | undefined
let releaseConversions = () => {}

const convert = async (pdf: string, response: ServerResponse) => {
  await holdConversions
  response.setHeader('Content-Type', 'application/json')
  if (pdf.includes('unreadable')) {
    response.statusCode = 422
    response.end(JSON.stringify({ error: 'No music staves were found.' }))
  } else response.end(JSON.stringify({ source: CONVERTED }))
}

const mock = createServer(async (request, response) => {
  let body = ''
  for await (const part of request) body += part
  if (request.url === '/convert') return convert(body, response)
  const json = JSON.parse(body)
  requests.push({
    messages: json.messages,
    authorization: request.headers.authorization,
  })
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const last = json.messages.at(-1)
  if (last.role === 'user') {
    // First step: think, then edit the title.
    response.write(
      chunk({ role: 'assistant', reasoning: 'The title should change.\n' }),
    )
    response.write(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            type: 'function',
            function: {
              name: 'edit_score',
              arguments: JSON.stringify({
                edits: [
                  {
                    old_text: 'title = "A little beginning"',
                    new_text: 'title = "Agent tested"',
                  },
                ],
              }),
            },
          },
        ],
      }),
    )
    response.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
    return
  }
  // Second step: a slow reply, so the test can drop the connection meanwhile.
  for (const word of 'I renamed the score to Agent tested. '
    .repeat(3)
    .split(/(?<= )/)) {
    response.write(chunk({ role: 'assistant', content: word }))
    await sleep(60)
  }
  response.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
})
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, resolve))

// --- HTTP API ------------------------------------------------------------------

let cookie = ''
async function api(
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${APP}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]!
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

/** The sign-in link in the first message the local mail simulator wrote after `since`. */
async function readLink(since: number): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const files: { path: string; time: number }[] = []
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      )) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        // The simulator writes a temporary file first, then renames it.
        else if (!entry.name.startsWith('.'))
          files.push({
            path,
            time: await stat(path).then(
              (file) => file.mtimeMs,
              () => 0,
            ),
          })
      }
    }
    await walk(EMAIL_DIR)
    for (const file of files
      .filter((file) => file.time >= since)
      .sort((a, b) => a.time - b.time)) {
      const content = await readFile(file.path, 'utf8').catch(() => '')
      const link = content.match(
        /https?:\/\/[^\s"<>]+\/login\?token=[\w-]+/,
      )?.[0]
      if (link && content.includes(email)) return link
    }
    await sleep(100)
  }
  throw new Error(`No sign-in email for ${email} in ${EMAIL_DIR}`)
}

// --- Document socket ---------------------------------------------------------------

type Event = { _tag: string; seq?: number; [key: string]: any }

function connect(id: string) {
  const url = `${APP.replace(/^http/, 'ws')}/api/documents/${id}/socket`
  // Node's WebSocket (undici) takes headers, which browsers set themselves.
  const socket = new WebSocket(url, {
    headers: { Cookie: cookie, Origin: origin },
  } as any)
  const events: Event[] = []
  const waiters: {
    test: (event: Event) => boolean
    resolve: (event: Event) => void
  }[] = []
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(String(data)) as Event
    events.push(event)
    for (const waiter of [...waiters])
      if (waiter.test(event)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(event)
      }
  })
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener(
      'error',
      () => reject(new Error(`Could not connect to ${url}`)),
      { once: true },
    )
  })
  return {
    events,
    opened,
    send: (command: object) => socket.send(JSON.stringify(command)),
    next: (test: (event: Event) => boolean, timeout = 20_000) => {
      const seen = events.find(test)
      if (seen) return Promise.resolve(seen)
      return new Promise<Event>((resolve, reject) => {
        waiters.push({ test, resolve })
        setTimeout(
          () =>
            reject(
              new Error(
                `Timed out; got ${events.map((e) => e._tag).join(', ')}`,
              ),
            ),
          timeout,
        )
      })
    },
    close: () => socket.close(),
  }
}

try {
  // Signed out: the API asks to sign in, and forged origins are refused.
  assert.equal((await api('/api/me')).status, 401)
  const forged = await fetch(`${APP}/api/auth/request`, {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  })
  assert.equal(forged.status, 403)

  // Magic link sign-in, once.
  const requested = Date.now() - 1000
  assert.equal(
    (await api('/api/auth/request', { method: 'POST', body: { email } }))
      .status,
    200,
  )
  const token = new URL(await readLink(requested)).searchParams.get('token')!
  const verified = await api('/api/auth/verify', {
    method: 'POST',
    body: { token },
  })
  assert.equal(verified.status, 200, JSON.stringify(verified.json))
  assert.equal(verified.json.user.email, email)
  assert.equal(verified.json.settings.hasApiKey, false)
  assert.equal(
    (await api('/api/auth/verify', { method: 'POST', body: { token } })).status,
    400,
  )
  console.log('✓ signs in with a magic link that works once')

  // The key is stored encrypted and never comes back.
  const saved = await api('/api/settings', {
    method: 'PUT',
    body: {
      apiKey: 'sk-or-test-secret',
      model: 'test/model',
      reasoning: 'low',
    },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.json.settings, {
    model: 'test/model',
    reasoning: 'low',
    hasApiKey: true,
  })
  assert.ok(!JSON.stringify(saved.json).includes('sk-or-test-secret'))
  console.log('✓ stores the OpenRouter key without returning it')

  // Documents.
  const created = await api('/api/documents', {
    method: 'POST',
    body: { source: simple },
  })
  assert.equal(created.status, 201)
  const id = created.json.id as string
  const list = await api('/api/documents')
  assert.deepEqual(
    list.json.documents.map((doc: any) => [doc.id, doc.title]),
    [[id, 'A little beginning']],
  )
  console.log('✓ creates and lists documents')

  // An agent run over the socket.
  const first = connect(id)
  await first.opened
  first.send({ _tag: 'Hello', since: null })
  const snapshot = await first.next((event) => event._tag === 'Snapshot')
  assert.equal(snapshot.document.source, simple)
  assert.equal(snapshot.document.revision, 1)
  first.send({ _tag: 'Send', text: 'Rename the score', selection: [] })
  const edited = await first.next(
    (event) => event._tag === 'SourceChanged' && event.origin === 'agent',
  )
  assert.match(edited.source, /title = "Agent tested"/)
  // The browser engraves the edit and reports back; the agent waits for it.
  first.send({ _tag: 'Rendered', revision: edited.revision, errors: [] })
  await first.next((event) => event._tag === 'Delta' && event.kind === 'text')
  const lastSeen = Math.max(...first.events.map((event) => event.seq ?? 0))
  first.close()
  console.log('✓ streams the agent’s edit and reply')

  // Reconnect partway: only the missed events are replayed.
  await sleep(300)
  const second = connect(id)
  await second.opened
  second.send({ _tag: 'Hello', since: lastSeen })
  const done = await second.next(
    (event) => event._tag === 'RunChanged' && event.run.state === 'done',
  )
  assert.ok(
    !second.events.some((event) => event._tag === 'Snapshot'),
    'expected a replay, not a snapshot',
  )
  assert.ok(
    second.events.every(
      (event) => event.seq === undefined || event.seq > lastSeen,
    ),
  )
  const replayed = second.events
    .filter((event) => event._tag === 'Delta')
    .map((event) => event.text)
    .join('')
  assert.ok(replayed.length > 0)
  console.log('✓ resumes after a dropped connection from the last event')
  second.close()

  // The whole reply is stored with the conversation, and the edit persisted.
  const third = connect(id)
  await third.opened
  third.send({ _tag: 'Hello', since: null })
  const after = await third.next((event) => event._tag === 'Snapshot')
  assert.match(after.document.source, /Agent tested/)
  const reply = after.messages.find(
    (message: any) => message.id === done.run.messageId,
  )
  assert.equal(
    reply.text.trim(),
    'I renamed the score to Agent tested. '.repeat(3).trim(),
  )
  assert.deepEqual(
    reply.parts.map((part: any) => part.type),
    ['thinking', 'text'],
  )
  third.close()
  console.log('✓ keeps the conversation and the edited score')

  // The model got the user's key, the tools and the tool result.
  assert.equal(requests[0]!.authorization, 'Bearer sk-or-test-secret')
  const toolResult = requests[1]!.messages.find(
    (message) => message.role === 'tool',
  )
  assert.match(String(toolResult?.content), /Applied successfully/)
  console.log('✓ sends the user’s key and the checked tool result to the model')

  // Index title follows the score.
  await sleep(2500)
  const renamed = await api('/api/documents')
  assert.equal(renamed.json.documents[0].title, 'Agent tested')
  console.log('✓ updates the document list')

  // Someone else's session cannot open the document.
  const ownerCookie = cookie
  cookie = ''
  const stranger = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${APP}/api/documents/${id}/socket`, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: origin,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    request.on('response', (response) => resolve(response.statusCode ?? 0))
    request.on('upgrade', () => resolve(101))
    request.on('error', reject)
    request.end()
  })
  assert.equal(stranger, 401)
  cookie = ownerCookie
  assert.equal(
    (await api(`/api/documents/${id}`, { method: 'DELETE' })).status,
    204,
  )
  assert.deepEqual((await api('/api/documents')).json.documents, [])
  console.log('✓ guards and deletes documents')

  // --- PDF conversion --------------------------------------------------------

  const upload = async (text: string, name: string, as = cookie) => {
    const response = await fetch(
      `${APP}/api/conversions?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/pdf',
          ...(as ? { Cookie: as } : {}),
        },
        body: text,
      },
    )
    return { status: response.status, json: await response.json() }
  }
  const conversion = async (id: string) =>
    (await api('/api/conversions')).json.conversions.find(
      (known: { id: string }) => known.id === id,
    )
  const settled = async (id: string) => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const current = await conversion(id)
      if (current.status === 'done' || current.status === 'failed')
        return current
      assert.ok(Date.now() < deadline, `${id} is still ${current.status}`)
      await sleep(200)
    }
  }

  assert.equal((await upload('%PDF-1.7 music', 'a.pdf', '')).status, 401)
  assert.equal((await upload('not a pdf', 'a.pdf')).status, 400)

  const queued = await upload('%PDF-1.7 music', 'Fur Elise.pdf')
  assert.equal(queued.status, 202)
  assert.equal(queued.json.fileName, 'Fur Elise.pdf')
  assert.equal((await settled(queued.json.id)).status, 'done')
  const converted = (await api('/api/documents')).json.documents
  assert.deepEqual(
    converted.map((document: { id: string; title: string }) => [
      document.id,
      document.title,
    ]),
    [[queued.json.id, 'Converted']],
  )
  // Its outcome is gone once dismissed, and the document stays.
  assert.equal(
    (await api(`/api/conversions/${queued.json.id}`, { method: 'DELETE' }))
      .status,
    204,
  )
  assert.equal(await conversion(queued.json.id), undefined)
  assert.equal((await api('/api/documents')).json.documents.length, 1)

  const rejected = await upload('%PDF-1.7 unreadable', 'blank.pdf')
  const outcome = await settled(rejected.json.id)
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.error, 'No music staves were found.')
  assert.equal((await api('/api/documents')).json.documents.length, 1)

  // Nobody can dismiss what is still running, or someone else's.
  holdConversions = new Promise((resolve) => (releaseConversions = resolve))
  const running = [
    await upload('%PDF-1.7 one', 'one.pdf'),
    await upload('%PDF-1.7 two', 'two.pdf'),
    await upload('%PDF-1.7 three', 'three.pdf'),
  ]
  assert.deepEqual(
    running.map(({ status }) => status),
    [202, 202, 202],
  )
  assert.equal((await upload('%PDF-1.7 four', 'four.pdf')).status, 429)
  await api(`/api/conversions/${running[0]!.json.id}`, { method: 'DELETE' })
  assert.ok(await conversion(running[0]!.json.id))
  releaseConversions()
  holdConversions = undefined
  for (const { json } of running)
    assert.equal((await settled(json.id)).status, 'done')
  console.log('✓ converts PDFs through the queue')
} catch (error) {
  // What the model was told, which usually explains a failed run.
  for (const request of requests)
    for (const message of request.messages.filter(
      (message) => message.role === 'tool',
    ))
      console.error('Tool result:', message.content)
  throw error
} finally {
  mock.close()
}
