import { withMidiOutput } from './midi'
import type { Anchor } from './selection'

export interface RenderResult {
  pages: string[]
  errors: string[]
  anchors: Anchor[]
}
export const MAX_SOURCE_LENGTH = 150_000

const rendererUrl = () =>
  new URL(`${import.meta.env.BASE_URL}renderer/`, document.baseURI)

// Renderer data is a few megabytes of JSON. Fetch each file once per page and
// hand the text to every worker that asks, instead of letting each new worker
// download it again.
const dataFiles = new Map<string, Promise<string>>()
function dataFile(name: string): Promise<string> {
  let text = dataFiles.get(name)
  if (!text) {
    text = fetch(new URL(`data/${name}`, rendererUrl())).then((response) => {
      if (!response.ok)
        throw new Error(
          `Failed to load renderer data ${name}: HTTP ${response.status}`,
        )
      return response.text()
    })
    // Let a later render retry a failed download.
    text.catch(() => dataFiles.delete(name))
    dataFiles.set(name, text)
  }
  return text
}

function startWorker(): Worker {
  const worker = new Worker(new URL('worker.js', rendererUrl()), {
    type: 'module',
  })
  worker.addEventListener('message', ({ data }) => {
    if (data?.type !== 'data') return
    dataFile(data.name).then(
      (text) => worker.postMessage({ type: 'data', name: data.name, text }),
      (error) =>
        worker.postMessage({
          type: 'data',
          name: data.name,
          error: String(error),
        }),
    )
  })
  return worker
}

// A worker keeps its parsed data, so finished workers are reused.
const idle: Worker[] = []
const MAX_IDLE = 2
let nextId = 0

/**
 * Runs one request on a renderer worker. Only a worker whose request is
 * cancelled or times out is terminated; finished workers return to the pool.
 */
function request<T>(
  payload: object,
  signal: AbortSignal | undefined,
  answer: (data: any) => T,
  failed: (reason: string) => T,
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
      resolve(failed('Timed out after 20 seconds. Try a smaller score.'))
    }, 20_000)
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
      anchors: [],
    })
  return request(
    { source },
    signal,
    (data) => ({
      pages: data.pages,
      errors: data.errors,
      anchors: data.anchors ?? [],
    }),
    (reason) => ({
      pages: [],
      errors: [reason.replace(/^Timed out/, 'Rendering timed out')],
      anchors: [],
    }),
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
  | { performance?: undefined; error: string }

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
          : { error: String(data.error) },
      (reason) => ({ error: reason }),
    )
  const result = await perform(source)
  if (!result.error?.includes(NO_MIDI)) return result
  const withMidi = withMidiOutput(source)
  if (withMidi === source)
    return { error: 'Put the music in a \\score block to play it.' }
  return perform(withMidi)
}
