/**
 * A stand-in for OpenRouter's chat completions, which the DocumentAgent calls
 * from `alchemy dev`. Tests run in parallel, so each one stores its own API
 * key and scripts the replies for it; the bearer token picks the script.
 * Tests talk to it from Node through a small control API.
 */
import { createServer, type Server } from 'node:http'

export const MOCK_PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 8788)
const CONTROL = `http://127.0.0.1:${MOCK_PORT}`

export type Reply =
  /** Server-sent events, sent one by one `delay` ms apart; `held` waits for release(). */
  | { events: string[]; delay?: number; held?: boolean }
  /** A plain HTTP error. */
  | { status: number; json: unknown }
  /** Keeps the request open until the caller gives up. */
  | { hang: true }

export interface RecordedRequest {
  authorization: string | undefined
  body: {
    model: string
    messages: { role: string; content: unknown }[]
    tools?: { function: { name: string } }[]
    max_tokens?: number
    reasoning?: unknown
  }
}

// --- The server, started by global setup -------------------------------------

export function startOpenRouter(): Promise<Server> {
  const scripts = new Map<string, Reply[]>()
  const requests = new Map<string, RecordedRequest[]>()
  const releases = new Map<string, () => void>()
  const released = new Set<string>()
  const read = async (request: AsyncIterable<Buffer>) => {
    let body = ''
    for await (const part of request) body += part
    return body
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', CONTROL)
    if (url.pathname === '/__script') {
      const { key, replies } = JSON.parse(await read(request))
      scripts.set(key, replies)
      requests.set(key, [])
      released.delete(key)
      return response.end('{}')
    }
    if (url.pathname === '/__requests') {
      response.setHeader('Content-Type', 'application/json')
      return response.end(
        JSON.stringify(requests.get(url.searchParams.get('key') ?? '') ?? []),
      )
    }
    if (url.pathname === '/__release') {
      const key = url.searchParams.get('key') ?? ''
      released.add(key)
      releases.get(key)?.()
      return response.end('{}')
    }
    // The PDF converter's stand-in: the PDF's text says how to answer.
    if (url.pathname === '/convert') {
      const pdf = await read(request)
      response.setHeader('Content-Type', 'application/json')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (pdf.includes('unreadable')) {
        response.statusCode = 422
        return response.end(
          JSON.stringify({ error: 'No music staves were found in this PDF.' }),
        )
      }
      return response.end(
        JSON.stringify({
          source: `\\version "2.24.4"\n\\header { title = "Converted score" }\n{ c'4 d' e' f' }\n`,
        }),
      )
    }
    if (url.pathname !== '/api/v1/chat/completions') {
      response.statusCode = 404
      return response.end()
    }
    const authorization = request.headers.authorization
    const key = authorization?.replace(/^Bearer /, '') ?? ''
    const body = JSON.parse(await read(request))
    const made = requests.get(key) ?? []
    made.push({ authorization, body })
    requests.set(key, made)
    const script = scripts.get(key) ?? []
    // Past the end of its script, a test gets a short reply.
    const reply: Reply = script[made.length - 1] ?? {
      events: stream({ content: 'Done.' }),
    }
    if ('hang' in reply) return
    if ('status' in reply) {
      response.writeHead(reply.status, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify(reply.json))
    }
    if (reply.held && !released.has(key))
      await new Promise<void>((resolve) => releases.set(key, resolve))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of reply.events) {
      if (response.destroyed) return
      response.write(event)
      if (reply.delay)
        await new Promise((resolve) => setTimeout(resolve, reply.delay))
    }
    response.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server))
  })
}

// --- What tests use ----------------------------------------------------------------

/** Scripts the replies the model gives to requests with this API key, in order. */
export async function script(key: string, replies: Reply[]) {
  await fetch(`${CONTROL}/__script`, {
    method: 'POST',
    body: JSON.stringify({ key, replies }),
  })
}

export async function requestsFor(key: string): Promise<RecordedRequest[]> {
  return (
    await fetch(`${CONTROL}/__requests?key=${encodeURIComponent(key)}`)
  ).json()
}

/** Lets a held reply go. */
export async function release(key: string) {
  await fetch(`${CONTROL}/__release?key=${encodeURIComponent(key)}`)
}

/**
 * A streamed chat completion the way OpenRouter sends it: one chunk per text
 * delta or tool call, then the finish reason.
 */
export function stream(
  message: { reasoning?: string; content?: string; tool_calls?: object[] },
  finish = 'stop',
): string[] {
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'test-completion',
      model: 'openai/test-model',
      object: 'chat.completion.chunk',
      created: 1,
      choices: [{ index: 0, delta, finish_reason, logprobs: null }],
    })}\n\n`
  const events = [
    ...(message.reasoning ?? '')
      .split(/(?<=\n)/)
      .filter(Boolean)
      .map((reasoning) => chunk({ role: 'assistant', reasoning })),
    ...(message.content ?? '')
      .split(/(?<= )/)
      .filter(Boolean)
      .map((content) => chunk({ role: 'assistant', content })),
  ]
  if (message.tool_calls)
    events.push(chunk({ role: 'assistant', tool_calls: message.tool_calls }))
  return [...events, chunk({}, finish), 'data: [DONE]\n\n']
}

/** One tool call, as a streamed reply. */
export const toolCall = (id: string, name: string, args: object): string[] =>
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
