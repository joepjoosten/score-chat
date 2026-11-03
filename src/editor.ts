/**
 * The source editor behind a Foldkit Mount. CodeMirror owns its DOM; the
 * live instance stays here, out of the Model, and Commands reach it.
 */
import { Effect, Queue, Schema, Stream } from 'effect'
import { Command, Mount } from 'foldkit'
import { MAX_SOURCE_LENGTH } from '../shared/protocol.ts'
import type { EditorController } from './editorView.ts'
import { Message } from './message.ts'
import { SourcePosition } from './model.ts'

let controller: EditorController | undefined
// What arrived before CodeMirror finished loading, applied once it has.
let latestDoc: string | undefined
let latestReadOnly: boolean | undefined
let latestErrors: Parameters<EditorController['setErrors']> | undefined
let latestReveal: SourcePosition | undefined

export const MountEditor = Mount.defineStream('MountEditor', {
  args: { doc: Schema.String, readOnly: Schema.Boolean },
  messages: [Message.EditedSource],
  execute: ({ element, doc, readOnly }) =>
    Stream.callback<typeof Message.EditedSource.Type>((queue) =>
      Effect.acquireRelease(
        Effect.promise(() => import('./editorView.ts')).pipe(
          Effect.map(({ createEditor }) => {
            const editor = createEditor(element as HTMLElement, {
              doc: latestDoc ?? doc,
              readOnly: latestReadOnly ?? readOnly,
              maxLength: MAX_SOURCE_LENGTH,
              onChange: (text) => {
                latestDoc = text
                Queue.offerUnsafe(queue, Message.EditedSource({ text }))
              },
            })
            controller = editor
            if (latestErrors) editor.setErrors(...latestErrors)
            if (latestReveal) editor.reveal(latestReveal)
            latestReveal = undefined
            return editor
          }),
        ),
        (editor) =>
          Effect.sync(() => {
            editor.destroy()
            if (controller === editor) controller = undefined
          }),
      ).pipe(Effect.flatMap(() => Effect.never)),
    ),
})

const withEditor = (apply: () => void) =>
  Effect.sync(apply).pipe(Effect.as(Message.Completed()))

/** Puts a replacement from outside the editor into it (assistant, undo, a file, another tab). */
export const SyncEditor = Command.define('SyncEditor', {
  args: { doc: Schema.String },
  messages: [Message.Completed],
  execute: ({ doc }) =>
    withEditor(() => {
      latestDoc = doc
      controller?.replace(doc)
    }),
})

export const SetEditorReadOnly = Command.define('SetEditorReadOnly', {
  args: { readOnly: Schema.Boolean },
  messages: [Message.Completed],
  execute: ({ readOnly }) =>
    withEditor(() => {
      latestReadOnly = readOnly
      controller?.setReadOnly(readOnly)
    }),
})

/** Marks errors in the editor; empty clears them. */
export const SetEditorErrors = Command.define('SetEditorErrors', {
  args: {
    source: Schema.String,
    errors: Schema.Array(Schema.String),
    positions: Schema.Array(Schema.NullOr(SourcePosition)),
  },
  messages: [Message.Completed],
  execute: ({ source, errors, positions }) =>
    withEditor(() => {
      latestErrors = [source, errors, positions]
      controller?.setErrors(source, errors, positions)
    }),
})

export const RevealInEditor = Command.define('RevealInEditor', {
  args: { position: SourcePosition },
  messages: [Message.Completed],
  execute: ({ position }) =>
    Effect.sleep('16 millis').pipe(
      Effect.andThen(
        withEditor(() => {
          if (controller) controller.reveal(position)
          else latestReveal = position
        }),
      ),
    ),
})
