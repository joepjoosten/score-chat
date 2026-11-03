/** Side effects, as Foldkit Commands that report back with a Message. */
import { Effect, Schema } from 'effect'
import { Command, File, Navigation } from 'foldkit'
import {
  MAX_SOURCE_LENGTH,
  UpdateSettings,
  scoreTitle,
} from '../shared/protocol.ts'
import * as Api from './api.ts'
import { Message } from './message.ts'
import { LocalDocument, Prefs } from './model.ts'
import * as Player from './player.ts'
import { renderScore } from './renderer.ts'
import {
  DOCUMENTS_KEY,
  PREFS_KEY,
  readLocalDocuments,
  removeLocalDocument,
  writeLocalDocument,
} from './storage.ts'

const failed = (error: Api.ApiFailure) =>
  Effect.succeed(Message.FailedApi({ error: error.message }))

// ---------------------------------------------------------------------------
// Navigation

export const PushUrl = Command.define('PushUrl', {
  args: { url: Schema.String },
  messages: [Message.Completed],
  execute: ({ url }) =>
    Navigation.pushUrl(url).pipe(Effect.as(Message.Completed())),
})

export const ReplaceUrl = Command.define('ReplaceUrl', {
  args: { url: Schema.String },
  messages: [Message.Completed],
  execute: ({ url }) =>
    Navigation.replaceUrl(url).pipe(Effect.as(Message.Completed())),
})

export const LoadUrl = Command.define('LoadUrl', {
  args: { href: Schema.String },
  messages: [Message.Completed],
  execute: ({ href }) =>
    Navigation.load(href).pipe(Effect.as(Message.Completed())),
})

// ---------------------------------------------------------------------------
// Accounts

export const FetchSession = Command.define('FetchSession', {
  messages: [Message.GotSession, Message.GotNoSession],
  execute: Api.fetchMe.pipe(
    Effect.map((me) => Message.GotSession({ me })),
    // Offline or signed out alike: the local documents still work.
    Effect.catch(() => Effect.succeed(Message.GotNoSession())),
  ),
})

export const FetchSignInConfig = Command.define('FetchSignInConfig', {
  messages: [Message.GotSignInConfig],
  execute: Api.fetchSignInConfig.pipe(
    Effect.map(({ method }) => Message.GotSignInConfig({ method })),
    // Without an answer, the emailed link is the one that works locally.
    Effect.catch(() =>
      Effect.succeed(Message.GotSignInConfig({ method: 'email' })),
    ),
  ),
})

export const RequestLoginLink = Command.define('RequestLoginLink', {
  args: { email: Schema.String },
  messages: [Message.SentLoginLink, Message.FailedLogin],
  execute: ({ email }) =>
    Api.requestLoginLink(email).pipe(
      Effect.as(Message.SentLoginLink()),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLogin({ error: error.message })),
      ),
    ),
})

export const VerifyLogin = Command.define('VerifyLogin', {
  args: { token: Schema.String },
  messages: [Message.VerifiedLogin, Message.FailedLogin],
  execute: ({ token }) =>
    Api.verifyLogin(token).pipe(
      Effect.map((me) => Message.VerifiedLogin({ me })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedLogin({ error: error.message })),
      ),
    ),
})

/** Moves this browser's documents into the account, newest last so it ends up first. */
export const ImportLocalDocuments = Command.define('ImportLocalDocuments', {
  messages: [Message.ImportedLocalDocuments, Message.FailedApi],
  execute: Effect.gen(function* () {
    const documents = readLocalDocuments(localStorage).reverse()
    let newest: string | null = null
    for (const document of documents) {
      const { id } = yield* Api.createDocument(document.source)
      removeLocalDocument(localStorage, document.id)
      newest = id
    }
    return Message.ImportedLocalDocuments({ documentId: newest })
  }).pipe(Effect.catch(failed)),
})

export const SignOut = Command.define('SignOut', {
  messages: [Message.SignedOut],
  execute: Api.logout.pipe(Effect.ignore, Effect.as(Message.SignedOut())),
})

export const SaveSettings = Command.define('SaveSettings', {
  args: { update: UpdateSettings },
  messages: [Message.SavedSettings, Message.FailedSaveSettings],
  execute: ({ update }) =>
    Api.saveSettings(update).pipe(
      Effect.map((me) => Message.SavedSettings({ me })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSaveSettings({ error: error.message })),
      ),
    ),
})

// ---------------------------------------------------------------------------
// Documents

export const FetchDocuments = Command.define('FetchDocuments', {
  messages: [Message.GotDocuments, Message.FailedApi],
  execute: Api.fetchDocuments.pipe(
    Effect.map(({ documents }) => Message.GotDocuments({ documents })),
    Effect.catch(failed),
  ),
})

export const CreateDocument = Command.define('CreateDocument', {
  args: { source: Schema.String },
  messages: [Message.CreatedDocument, Message.FailedApi],
  execute: ({ source }) =>
    Api.createDocument(source).pipe(
      Effect.map(({ id }) => Message.CreatedDocument({ id })),
      Effect.catch(failed),
    ),
})

export const DeleteDocument = Command.define('DeleteDocument', {
  args: { id: Schema.String },
  messages: [Message.DeletedDocument, Message.FailedApi],
  execute: ({ id }) =>
    Api.deleteDocument(id).pipe(
      Effect.as(Message.DeletedDocument({ id })),
      Effect.catch(failed),
    ),
})

export const LoadLocalDocuments = Command.define('LoadLocalDocuments', {
  messages: [Message.GotLocalDocuments],
  execute: Effect.sync(() => {
    const documents = readLocalDocuments(localStorage)
    // The single score of an earlier version becomes a stored document, so its ID stays put.
    try {
      if (localStorage.getItem(DOCUMENTS_KEY) === null && documents[0])
        writeLocalDocument(localStorage, documents[0])
    } catch {
      // Storage is unavailable; the document lasts for this session.
    }
    return Message.GotLocalDocuments({ documents })
  }),
})

const storing = (write: () => void) =>
  Effect.try({ try: write, catch: () => 'unavailable' }).pipe(
    Effect.as(Message.Completed()),
    Effect.catch(() => Effect.succeed(Message.StorageFailed())),
  )

export const SaveLocalDocument = Command.define('SaveLocalDocument', {
  args: { id: Schema.String, source: Schema.String },
  messages: [Message.Completed, Message.StorageFailed],
  execute: ({ id, source }) =>
    storing(() =>
      writeLocalDocument(localStorage, {
        id,
        source,
        title: scoreTitle(source),
        updatedAt: Date.now(),
      }),
    ),
})

export const DeleteLocalDocument = Command.define('DeleteLocalDocument', {
  args: { id: Schema.String },
  messages: [Message.DeletedDocument, Message.StorageFailed],
  execute: ({ id }) =>
    Effect.try({
      try: () => removeLocalDocument(localStorage, id),
      catch: () => 'unavailable',
    }).pipe(
      Effect.as(Message.DeletedDocument({ id })),
      Effect.catch(() => Effect.succeed(Message.StorageFailed())),
    ),
})

export const SavePrefs = Command.define('SavePrefs', {
  args: { prefs: Prefs },
  messages: [Message.Completed, Message.StorageFailed],
  execute: ({ prefs }) =>
    storing(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))),
})

/** Waits before saving a hand edit, so typing sends one save rather than many. */
export const DebounceSave = Command.define('DebounceSave', {
  args: { generation: Schema.Number },
  messages: [Message.ElapsedSaveDebounce],
  execute: ({ generation }) =>
    Effect.sleep('600 millis').pipe(
      Effect.as(Message.ElapsedSaveDebounce({ generation })),
    ),
})

// ---------------------------------------------------------------------------
// Files

export const ClickFileInput = Command.define('ClickFileInput', {
  messages: [Message.Completed],
  execute: Effect.sync(() => {
    document.querySelector<HTMLInputElement>('input.score-file')?.click()
    return Message.Completed()
  }),
})

export const ReadScoreFile = Command.define('ReadScoreFile', {
  args: { file: File.File },
  messages: [Message.ReadFile, Message.FailedReadFile],
  execute: ({ file }) =>
    file.size > MAX_SOURCE_LENGTH
      ? Effect.succeed(
          Message.FailedReadFile({
            error: 'Choose a LilyPond file smaller than 150 KB.',
          }),
        )
      : File.readAsText(file).pipe(
          Effect.map((text) => Message.ReadFile({ text })),
          Effect.catch(() =>
            Effect.succeed(
              Message.FailedReadFile({ error: 'Could not read this file.' }),
            ),
          ),
        ),
})

export const DownloadSource = Command.define('DownloadSource', {
  args: { source: Schema.String },
  messages: [Message.Completed],
  execute: ({ source }) =>
    Effect.sync(() => {
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/plain' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = 'score.ly'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return Message.Completed()
    }),
})

// ---------------------------------------------------------------------------
// Rendering and playback

export const DebounceRender = Command.define('DebounceRender', {
  args: { generation: Schema.Number },
  messages: [Message.ElapsedRenderDebounce],
  execute: ({ generation }) =>
    Effect.sleep('350 millis').pipe(
      Effect.as(Message.ElapsedRenderDebounce({ generation })),
    ),
})

export const RenderScore = Command.define('RenderScore', {
  args: { generation: Schema.Number, source: Schema.String },
  messages: [Message.RenderedScore],
  // A newer render cancels the worker still busy with an older one.
  interrupt: {
    keyFields: ['generation'],
    toKey: ({ generation }) => String(generation),
  },
  execute: ({ generation, source }) =>
    Effect.tryPromise((signal) => renderScore(source, signal)).pipe(
      Effect.map((result) => Message.RenderedScore({ generation, result })),
      Effect.catch(() =>
        Effect.succeed(
          Message.RenderedScore({
            generation,
            result: {
              pages: [],
              errors: ['Rendering failed. Please try again.'],
              positions: [null],
              anchors: [],
            },
          }),
        ),
      ),
    ),
})

/** Plays the score; the playback subscription follows it and reports its end. */
export const Play = Command.define('Play', {
  args: { source: Schema.String },
  messages: [Message.StartedPlayback, Message.FailedPlayback],
  execute: ({ source }) =>
    Effect.promise(() => Player.play(source)).pipe(
      Effect.map((result) =>
        result.ok
          ? Message.StartedPlayback()
          : Message.FailedPlayback({
              error: result.error,
              position: result.position,
            }),
      ),
    ),
})

export const Pause = Command.define('Pause', {
  messages: [Message.Completed],
  execute: Effect.sync(() => {
    Player.pause()
    return Message.Completed()
  }),
})

export const Rewind = Command.define('Rewind', {
  messages: [Message.Completed],
  execute: Effect.sync(() => {
    Player.rewind()
    return Message.Completed()
  }),
})

export const DiscardPerformance = Command.define('DiscardPerformance', {
  messages: [Message.Completed],
  execute: Effect.sync(() => {
    Player.discard()
    return Message.Completed()
  }),
})

// ---------------------------------------------------------------------------
// DOM

const afterRender = (apply: () => void) =>
  Effect.callback<typeof Message.Completed.Type>((resume) => {
    requestAnimationFrame(() => {
      apply()
      resume(Effect.succeed(Message.Completed()))
    })
  })

export const ScrollScoreToTop = Command.define('ScrollScoreToTop', {
  messages: [Message.Completed],
  execute: afterRender(() =>
    document.querySelector('.score-canvas')?.scrollTo({ top: 0 }),
  ),
})

/** Keeps the sounding notes in view as playback moves down the page. */
export const FollowSoundingNotes = Command.define('FollowSoundingNotes', {
  messages: [Message.Completed],
  execute: afterRender(() => {
    const note = document.querySelector('.page-overlay .sounding')
    const canvas = note?.closest('.score-canvas')
    if (!note || !canvas) return
    const box = note.getBoundingClientRect()
    const view = canvas.getBoundingClientRect()
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40)
      note.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }),
})

export const FocusComposer = Command.define('FocusComposer', {
  messages: [Message.Completed],
  execute: afterRender(() =>
    document
      .querySelector<HTMLTextAreaElement>('.chat-composer textarea')
      ?.focus(),
  ),
})

/** A new local document's title, for the document list. */
export const localSummary = (document: LocalDocument) => ({
  id: document.id,
  title: scoreTitle(document.source),
  updatedAt: document.updatedAt,
})
