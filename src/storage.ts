/** This browser's local storage: preferences and documents of signed-out users. */
import { Schema } from 'effect'
import { scoreTitle } from '../shared/protocol.ts'
import { initialScore } from './initialScore.ts'
import { LocalDocument, Prefs, defaultPrefs, dockCorners } from './model.ts'

export const PREFS_KEY = 'score-chat.settings.v1'
export const DOCUMENTS_KEY = 'score-chat.documents.v1'
/** The single score of Score Chat before it kept several documents. */
export const LEGACY_SCORE_KEY = 'score-chat.score.v1'
export const LOCAL_PREFIX = 'local-'

export const isLocalId = (id: string) => id.startsWith(LOCAL_PREFIX)

/** Reads stored preferences, keeping what is valid; older versions stored more fields. */
export function readPrefs(storage: Pick<Storage, 'getItem'>): Prefs {
  try {
    const raw = JSON.parse(storage.getItem(PREFS_KEY) ?? '{}') as Record<
      string,
      unknown
    >
    const dock = Schema.decodeUnknownOption(Prefs.fields.dock)(raw.dock ?? null)
    return {
      view: raw.view === 'source' || raw.view === 'review' ? raw.view : 'score',
      pages: raw.pages === 'inline' ? 'inline' : 'image',
      dock: dock._tag === 'Some' ? dock.value : null,
      corner:
        dockCorners.find((corner) => corner === raw.corner) ??
        defaultPrefs.corner,
    }
  } catch {
    return defaultPrefs
  }
}

const LocalDocuments = Schema.Array(LocalDocument)

// Documents written while storage refuses them, so they last for the session.
const unsaved = new Map<string, LocalDocument>()
const withUnsaved = (documents: LocalDocument[]) => {
  const byId = new Map(documents.map((doc) => [doc.id, doc]))
  for (const [id, doc] of unsaved) byId.set(id, doc)
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The documents kept in this browser, newest first. A legacy single score becomes the first. */
export function readLocalDocuments(
  storage: Pick<Storage, 'getItem'>,
  now = Date.now(),
): LocalDocument[] {
  try {
    const raw = storage.getItem(DOCUMENTS_KEY)
    if (raw)
      return withUnsaved([
        ...Schema.decodeUnknownSync(LocalDocuments)(JSON.parse(raw)),
      ])
    const legacy = storage.getItem(LEGACY_SCORE_KEY)
    return withUnsaved(legacy ? [newLocalDocument(legacy, now)] : [])
  } catch {
    return withUnsaved([])
  }
}

export function newLocalDocument(
  source = initialScore,
  now = Date.now(),
): LocalDocument {
  return {
    id: `${LOCAL_PREFIX}${crypto.randomUUID()}`,
    title: scoreTitle(source),
    source,
    updatedAt: now,
  }
}

/** Stores a document, replacing its earlier version. Throws when storage is unavailable. */
export function writeLocalDocument(storage: Storage, document: LocalDocument) {
  const others = readLocalDocuments(storage).filter(
    (doc) => doc.id !== document.id,
  )
  unsaved.set(document.id, document)
  storage.setItem(DOCUMENTS_KEY, JSON.stringify([document, ...others]))
  unsaved.delete(document.id)
}

export function removeLocalDocument(storage: Storage, id: string) {
  const others = readLocalDocuments(storage).filter((doc) => doc.id !== id)
  unsaved.delete(id)
  storage.setItem(DOCUMENTS_KEY, JSON.stringify(others))
}
