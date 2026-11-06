/** External event streams, each declared as a function of the Model. */
import { Effect, Queue, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'
import { Message } from './message.ts'
import { activeView, hasActiveConversion, isBusy, type Model } from './model.ts'
import * as Player from './player.ts'
import {
  DocumentSocket,
  socketEvents,
  type DocumentSocketService,
} from './socket.ts'

type AnyMessage = Message

/** A stream of messages from window listeners that `listen` sets up and tears down. */
const fromWindow = <A extends AnyMessage>(
  listen: (emit: (message: A) => void) => () => void,
) =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => listen((message) => Queue.offerUnsafe(queue, message))),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

const PAGE_KEYS: Record<string, number> = {
  ArrowLeft: -1,
  PageUp: -1,
  ArrowRight: 1,
  PageDown: 1,
}

/** Arrow and page keys turn the pages, unless the reader is typing. */
const pageKeys = fromWindow<typeof Message.TurnedPage.Type>((emit) => {
  const keydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      target?.closest?.(
        'input, textarea, select, dialog, [role="separator"], .cm-editor',
      )
    )
      return
    const step = PAGE_KEYS[event.key]
    if (!step) return
    event.preventDefault()
    emit(Message.TurnedPage({ step }))
  }
  window.addEventListener('keydown', keydown)
  return () => window.removeEventListener('keydown', keydown)
})

/**
 * A file dropped anywhere on the page opens it. Listening in the capture phase
 * keeps the source editor and chat box from inserting it as text.
 */
const fileDrops = (busy: boolean) =>
  fromWindow<
    typeof Message.ChangedFileDrag.Type | typeof Message.SelectedFiles.Type
  >((emit) => {
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer?.types.includes('Files') ?? false
    // dragenter and dragleave fire for every child crossed, so count the nesting.
    let depth = 0
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth++
      if (!busy) emit(Message.ChangedFileDrag({ active: true }))
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer!.dropEffect = busy ? 'none' : 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth) emit(Message.ChangedFileDrag({ active: false }))
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      depth = 0
      emit(Message.ChangedFileDrag({ active: false }))
      const file = event.dataTransfer?.files[0]
      if (file && !busy) emit(Message.SelectedFiles({ files: [file] }))
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
    }
  })

/** While playing, the notes sounding right now, and the end of the music. */
const playbackFrames = fromWindow<
  typeof Message.ChangedSounding.Type | typeof Message.EndedPlayback.Type
>((emit) => {
  let frame = 0
  let last = ''
  const follow = () => {
    if (!Player.isPlaying()) {
      emit(Message.EndedPlayback())
      return
    }
    const keys = Player.soundingKeys()
    const id = keys.join()
    if (id !== last) {
      last = id
      emit(Message.ChangedSounding({ keys }))
    }
    frame = requestAnimationFrame(follow)
  }
  frame = requestAnimationFrame(follow)
  return () => cancelAnimationFrame(frame)
})

/** Pointer moves on the window while the dock is dragged or resized. */
const pointerDrag = <Move extends AnyMessage, End extends AnyMessage>(
  move: (x: number, y: number) => Move,
  end: (x: number, y: number) => End,
) =>
  fromWindow<Move | End>((emit) => {
    const moved = (event: PointerEvent) =>
      emit(move(event.clientX, event.clientY))
    const ended = (event: PointerEvent) =>
      emit(end(event.clientX, event.clientY))
    window.addEventListener('pointermove', moved)
    window.addEventListener('pointerup', ended)
    window.addEventListener('pointercancel', ended)
    return () => {
      window.removeEventListener('pointermove', moved)
      window.removeEventListener('pointerup', ended)
      window.removeEventListener('pointercancel', ended)
    }
  })

const CONVERSION_POLL_MS = 5000

/** Every few seconds while a PDF is being converted. */
const conversionPolls = fromWindow<typeof Message.ElapsedConversionPoll.Type>(
  (emit) => {
    const timer = setInterval(
      () => emit(Message.ElapsedConversionPoll()),
      CONVERSION_POLL_MS,
    )
    return () => clearInterval(timer)
  },
)

export const subscriptions = Subscription.make<
  Model,
  Message,
  DocumentSocketService
>()((entry) => ({
  socket: entry(
    { connected: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        connected: model.socket._tag === 'Connected',
      }),
      dependenciesToStream: ({ connected }) =>
        connected
          ? Stream.unwrap(
              DocumentSocket.get.pipe(
                Effect.map(socketEvents),
                Effect.catchTag('ResourceNotAvailable', () =>
                  Effect.succeed(Stream.empty),
                ),
              ),
            )
          : Stream.empty,
    },
  ),
  conversions: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ active: hasActiveConversion(model) }),
      dependenciesToStream: ({ active }) =>
        active ? conversionPolls : Stream.empty,
    },
  ),
  pageKeys: entry(
    { score: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        score: activeView(model) === 'score',
      }),
      dependenciesToStream: ({ score }) => (score ? pageKeys : Stream.empty),
    },
  ),
  fileDrops: entry(
    { busy: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ busy: isBusy(model) }),
      dependenciesToStream: ({ busy }) => fileDrops(busy),
    },
  ),
  playback: entry(
    { playing: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        playing: model.playback === 'playing',
      }),
      dependenciesToStream: ({ playing }) =>
        playing ? playbackFrames : Stream.empty,
    },
  ),
  dockDrag: entry(
    { dragging: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ dragging: model.dockDrag !== null }),
      dependenciesToStream: ({ dragging }) =>
        dragging
          ? pointerDrag(
              (x, y) => Message.MovedDock({ x, y }),
              (x, y) => Message.ReleasedDock({ x, y }),
            )
          : Stream.empty,
    },
  ),
  dockResize: entry(
    { resizing: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ resizing: model.dockResize !== null }),
      dependenciesToStream: ({ resizing }) =>
        resizing
          ? pointerDrag(
              (x, y) => Message.MovedDockGrip({ x, y }),
              () => Message.ReleasedDockGrip(),
            )
          : Stream.empty,
    },
  ),
}))
