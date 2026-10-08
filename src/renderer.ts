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

// A worker keeps its parsed data, so finished workers are reused. Only a worker
// whose render is cancelled or times out is terminated, which stops compilation.
const idle: Worker[] = []
const MAX_IDLE = 2
let nextId = 0

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
      resolve({
        pages: [],
        errors: ['Rendering timed out after 20 seconds. Try a smaller score.'],
        anchors: [],
      })
    }, 20_000)
    const message = ({ data }: MessageEvent) => {
      if (data?.id !== id) return
      cleanup()
      if (idle.length < MAX_IDLE) idle.push(worker)
      else worker.terminate()
      resolve({
        pages: data.pages,
        errors: data.errors,
        anchors: data.anchors ?? [],
      })
    }
    const error = () => {
      cleanup()
      worker.terminate()
      resolve({
        pages: [],
        errors: [
          'The music renderer could not start. Reload the page and try again.',
        ],
        anchors: [],
      })
    }
    signal?.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', message)
    worker.addEventListener('error', error)
    worker.postMessage({ id, source })
  })
}
