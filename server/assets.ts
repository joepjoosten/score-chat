/**
 * Files the server reads from the client build: renderer data, fonts and
 * stylesheets for checking scores, and the LilyPond documentation. They are
 * served by the Worker's static assets, so the server bundle stays small.
 */
import { createDocsIndex, type Doc, type DocsIndex } from '../shared/docs.ts'
import { checkScore, type CheckResult } from './renderer/check.js'

export type AssetFetcher = (path: string) => Promise<Response>

/**
 * Reads static assets through the ASSETS binding. The host is ignored when
 * deployed; in development the binding reaches Vite, which accepts localhost.
 */
export const assetFetcher =
  (assets: Fetcher): AssetFetcher =>
  async (path) => {
    const response = await assets.fetch(`http://localhost/${path}`)
    if (!response.ok)
      throw new Error(`Could not load ${path}: HTTP ${response.status}`)
    return response
  }

// Each file is fetched once per isolate and shared by every check.
const rendererFiles = new Map<string, Promise<string | ArrayBuffer>>()

/** Checks a score like the browser render, without engraving it. */
export function check(
  fetchAsset: AssetFetcher,
  source: string,
): Promise<CheckResult> {
  return checkScore(source, (path, binary) => {
    const key = `${binary ? 'bin' : 'text'}:${path}`
    let file = rendererFiles.get(key)
    if (!file) {
      file = fetchAsset(`renderer/${path}`).then(
        (response): Promise<string | ArrayBuffer> =>
          binary ? response.arrayBuffer() : response.text(),
      )
      file.catch(() => rendererFiles.delete(key))
      rendererFiles.set(key, file)
    }
    return file
  })
}

let docsIndex: Promise<DocsIndex> | undefined
/** The documentation is about 2 MB, so it is fetched on first use and kept for the isolate. */
export function loadDocs(fetchAsset: AssetFetcher): Promise<DocsIndex> {
  docsIndex ??= fetchAsset('docs/lilypond-docs.json')
    .then((response) => response.json() as Promise<{ documents: Doc[] }>)
    .then(({ documents }) => createDocsIndex(documents))
  docsIndex.catch(() => (docsIndex = undefined))
  return docsIndex
}
