export interface RenderResult {
  pages: string[]
  errors: string[]
}
export const MAX_SOURCE_LENGTH = 150_000

/** Each request owns its worker, so cancellation and timeouts stop compilation too. */
export function renderScore(
  source: string,
  signal?: AbortSignal,
): Promise<RenderResult> {
  if (source.length > MAX_SOURCE_LENGTH)
    return Promise.resolve({
      pages: [],
      errors: ['This score exceeds the 150,000-character limit.'],
    })
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'))
      return
    }
    const worker = new Worker(
      new URL(
        `${import.meta.env.BASE_URL}renderer/worker.js`,
        document.baseURI,
      ),
      { type: 'module' },
    )
    const cleanup = () => {
      clearTimeout(timer)
      worker.terminate()
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve({
        pages: [],
        errors: ['Rendering timed out after 20 seconds. Try a smaller score.'],
      })
    }, 20_000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }) => {
      cleanup()
      resolve({ pages: data.pages, errors: data.errors })
    }
    worker.onerror = () => {
      cleanup()
      resolve({
        pages: [],
        errors: [
          'The music renderer could not start. Reload the page and try again.',
        ],
      })
    }
    worker.postMessage({ id: 1, source })
  })
}
