import { withMidiOutput } from './midi.ts'
import type { Anchor } from '../shared/selection.ts'
import { MAX_SOURCE_LENGTH } from '../shared/protocol.ts'

/** Where an error is in the score: 1-based lines, UTF-16 columns. */
export interface SourcePosition {
  line: number
  column: number
  endLine: number
  endColumn: number
}

export interface RenderResult {
  pages: string[]
  errors: string[]
  /** The position of each error, or null when it has none in the score. */
  positions: (SourcePosition | null)[]
  anchors: Anchor[]
}
export { MAX_SOURCE_LENGTH }

const rendererUrl = () =>
  new URL(`${import.meta.env.BASE_URL}renderer/`, document.baseURI)

// Renderer data (a few megabytes of JSON), optional fonts and stylesheets.
// Workers ask only for what a score reads, just in time. Fetch each file once
// per page and hand it to every worker that asks, instead of letting each new
// worker download it again.
const assets = new Map<string, Promise<string | ArrayBuffer>>()
function asset(path: string, binary: boolean): Promise<string | ArrayBuffer> {
  const key = `${binary ? 'bin' : 'text'}:${path}`
  let content = assets.get(key)
  if (!content) {
    content = fetch(new URL(path, rendererUrl())).then(
      (response): Promise<string | ArrayBuffer> => {
        if (!response.ok)
          throw new Error(
            `Failed to load renderer file ${path}: HTTP ${response.status}`,
          )
        return binary ? response.arrayBuffer() : response.text()
      },
    )
    // Let a later render retry a failed download.
    content.catch(() => assets.delete(key))
    assets.set(key, content)
  }
  return content
}

function startWorker(): Worker {
  const worker = new Worker(new URL('worker.js', rendererUrl()), {
    type: 'module',
  })
  worker.addEventListener('message', ({ data }) => {
    if (data?.type !== 'asset') return
    const { request, path, binary } = data
    asset(path, binary).then(
      // Binary content is copied, so the cached buffer stays usable.
      (content) =>
        worker.postMessage({
          type: 'asset',
          request,
          content: content instanceof ArrayBuffer ? content.slice(0) : content,
        }),
      (error) =>
        worker.postMessage({ type: 'asset', request, error: String(error) }),
    )
  })
  return worker
}

// A worker keeps its parsed data, so finished workers are reused.
const idle: Worker[] = []
const MAX_IDLE = 2
let nextId = 0

const TIMEOUT_SECONDS = 20
// The first render of a page downloads the renderer data and runs cold.
const FIRST_RENDER_TIMEOUT_SECONDS = 30
let hasRendered = false

/**
 * Runs one request on a renderer worker. Only a worker whose request is
 * cancelled or times out is terminated; finished workers return to the pool.
 */
function request<T>(
  payload: object,
  signal: AbortSignal | undefined,
  answer: (data: any) => T,
  failed: (reason: string) => T,
  seconds = TIMEOUT_SECONDS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'))
      return
    }
    const id = ++nextId
    const worker = idle.pop() ?? startWorker()
    const cleanup = () => {
      clearTimeout(timer)
      worker.removeEventListener('message', message)
      worker.removeEventListener('error', error)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      worker.terminate()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      cleanup()
      worker.terminate()
      resolve(
        failed(`Timed out after ${seconds} seconds. Try a smaller score.`),
      )
    }, seconds * 1000)
    const message = ({ data }: MessageEvent) => {
      if (data?.id !== id) return
      cleanup()
      if (idle.length < MAX_IDLE) idle.push(worker)
      else worker.terminate()
      resolve(answer(data))
    }
    const error = () => {
      cleanup()
      worker.terminate()
      resolve(
        failed(
          'The music renderer could not start. Reload the page and try again.',
        ),
      )
    }
    signal?.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', message)
    worker.addEventListener('error', error)
    worker.postMessage({ ...payload, id })
  })
}

export function renderScore(
  source: string,
  signal?: AbortSignal,
): Promise<RenderResult> {
  if (source.length > MAX_SOURCE_LENGTH)
    return Promise.resolve({
      pages: [],
      errors: ['This score exceeds the 150,000-character limit.'],
      positions: [null],
      anchors: [],
    })
  return request(
    { source },
    signal,
    (data) => {
      hasRendered = true
      return {
        pages: data.pages,
        errors: data.errors,
        positions: data.positions ?? data.errors.map(() => null),
        anchors: data.anchors ?? [],
      }
    },
    (reason) => ({
      pages: [],
      errors: [reason.replace(/^Timed out/, 'Rendering timed out')],
      positions: [null],
      anchors: [],
    }),
    hasRendered ? TIMEOUT_SECONDS : FIRST_RENDER_TIMEOUT_SECONDS,
  )
}

/** A sounding MIDI note, in seconds from the start of the performance. */
export interface PlayedNote {
  time: number
  duration: number
  /** MIDI note number. */
  pitch: number
  velocity: number
  channel: number
}

/** When the note event at a source position sounds, to light up its note heads. */
export interface Cue {
  time: number
  end: number
  line: number
  column: number
}

export interface Performance {
  notes: PlayedNote[]
  cues: Cue[]
  /** Seconds until the last event of the last score. */
  duration: number
}

export type PerformResult =
  | { performance: Performance; error?: undefined }
  | {
      performance?: undefined
      error: string
      position?: SourcePosition | null
    }

const NO_MIDI = 'no score requests MIDI output'

/**
 * Performs the score with the renderer's MIDI generator. A score without a
 * `\midi` block is performed as if it had an empty one.
 */
export async function performScore(
  source: string,
  signal?: AbortSignal,
): Promise<PerformResult> {
  const perform = (text: string) =>
    request<PerformResult>(
      { type: 'perform', source: text },
      signal,
      (data) =>
        data.performance
          ? { performance: data.performance }
          : { error: String(data.error), position: data.position ?? null },
      (reason) => ({ error: reason }),
    )
  const result = await perform(source)
  if (!result.error?.includes(NO_MIDI)) return result
  const withMidi = withMidiOutput(source)
  if (withMidi === source)
    return { error: 'Put the music in a \\score block to play it.' }
  return perform(withMidi)
}
