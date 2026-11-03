/** DOM that the view hands to code that owns it: measuring, swiping, dialogs. */
import { Effect, Queue, Schema, Stream } from 'effect'
import { Mount } from 'foldkit'
import { dragBox } from '../shared/selection.ts'
import { Message } from './message.ts'

/** Turns DOM listeners set up by `listen` into a Mount's message stream. */
function listening<A>(listen: (emit: (message: A) => void) => () => void) {
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => listen((message) => Queue.offerUnsafe(queue, message))),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )
}

/** Reports the room for pages in the score canvas, inside its padding. */
export const MeasureCanvas = Mount.defineStream('MeasureCanvas', {
  messages: [Message.MeasuredCanvas],
  execute: ({ element }) =>
    listening<typeof Message.MeasuredCanvas.Type>((emit) => {
      const measure = () => {
        // Hidden behind the LilyPond tab: keep the last width (and the reader's place).
        if (!element.clientWidth) return
        const style = getComputedStyle(element)
        emit(
          Message.MeasuredCanvas({
            width:
              element.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight),
          }),
        )
      }
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      measure()
      return () => observer.disconnect()
    }),
})

export const MeasureStage = Mount.defineStream('MeasureStage', {
  messages: [Message.MeasuredStage],
  execute: ({ element }) =>
    listening<typeof Message.MeasuredStage.Type>((emit) => {
      const observer = new ResizeObserver(() => {
        const { x, y, width, height } = element.getBoundingClientRect()
        emit(Message.MeasuredStage({ box: { x, y, width, height } }))
      })
      observer.observe(element)
      return () => observer.disconnect()
    }),
})

/** Reports the dock's width and its conversation's height, which resizing starts from. */
export const MeasureDock = Mount.defineStream('MeasureDock', {
  messages: [Message.MeasuredDock],
  execute: ({ element }) =>
    listening<typeof Message.MeasuredDock.Type>((emit) => {
      const measure = () => {
        const log = element.querySelector('.chat-messages')
        emit(
          Message.MeasuredDock({
            width: element.getBoundingClientRect().width,
            height: log?.getBoundingClientRect().height ?? 0,
          }),
        )
      }
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      // The conversation comes and goes as the dock opens and closes.
      const children = new MutationObserver(() => {
        const log = element.querySelector('.chat-messages')
        if (log) observer.observe(log)
        measure()
      })
      children.observe(element, { childList: true })
      const log = element.querySelector('.chat-messages')
      if (log) observer.observe(log)
      return () => {
        observer.disconnect()
        children.disconnect()
      }
    }),
})

/**
 * The felt-tip marker over one page. The overlay shares the page's viewBox and
 * aspect ratio, so page units scale linearly with pixels.
 */
export const MarkerOverlay = Mount.defineStream('MarkerOverlay', {
  args: { page: Schema.Number, width: Schema.Number, height: Schema.Number },
  messages: [Message.ChangedMarquee, Message.Swiped],
  execute: ({ element: overlay, page, width, height }) =>
    listening<typeof Message.ChangedMarquee.Type | typeof Message.Swiped.Type>(
      (emit) => {
        const element = overlay as SVGSVGElement
        let start: { x: number; y: number } | null = null
        const toPage = (event: PointerEvent) => {
          const rect = element.getBoundingClientRect()
          return {
            x: ((event.clientX - rect.left) / rect.width) * width,
            y: ((event.clientY - rect.top) / rect.height) * height,
          }
        }
        const down = (event: PointerEvent) => {
          if (event.button !== 0 || !element.classList.contains('active'))
            return
          element.setPointerCapture(event.pointerId)
          start = toPage(event)
          emit(Message.ChangedMarquee({ page, box: dragBox(start, start) }))
        }
        const move = (event: PointerEvent) => {
          if (start)
            emit(
              Message.ChangedMarquee({
                page,
                box: dragBox(start, toPage(event)),
              }),
            )
        }
        const up = (event: PointerEvent) => {
          if (!start) return
          const box = dragBox(start, toPage(event))
          start = null
          emit(Message.Swiped({ page, box }))
        }
        const cancel = () => {
          start = null
          emit(Message.ChangedMarquee({ page, box: null }))
        }
        element.addEventListener('pointerdown', down)
        element.addEventListener('pointermove', move)
        element.addEventListener('pointerup', up)
        element.addEventListener('pointercancel', cancel)
        return () => {
          element.removeEventListener('pointerdown', down)
          element.removeEventListener('pointermove', move)
          element.removeEventListener('pointerup', up)
          element.removeEventListener('pointercancel', cancel)
        }
      },
    ),
})

/** Follows streaming output, but only while the reader is at the bottom of the conversation. */
export const FollowConversation = Mount.defineStream('FollowConversation', {
  messages: [Message.Completed],
  execute: ({ element }) =>
    listening<typeof Message.Completed.Type>(() => {
      let follow = true
      const scrolled = () => {
        follow =
          element.scrollHeight - element.scrollTop - element.clientHeight < 40
      }
      const changed = () => {
        if (follow) element.scrollTop = element.scrollHeight
      }
      const observer = new MutationObserver(changed)
      observer.observe(element, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      const resized = new ResizeObserver(changed)
      resized.observe(element)
      element.addEventListener('scroll', scrolled, { passive: true })
      changed()
      return () => {
        observer.disconnect()
        resized.disconnect()
        element.removeEventListener('scroll', scrolled)
      }
    }),
})

/** Opens a <dialog> as a modal when it is shown. */
export const ShowModal = Mount.defineStream('ShowModal', {
  messages: [Message.Completed],
  execute: ({ element }) =>
    listening<typeof Message.Completed.Type>(() => {
      if (element instanceof HTMLDialogElement && !element.open)
        element.showModal()
      return () => {}
    }),
})
