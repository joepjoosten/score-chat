/**
 * The open document's WebSocket to its Durable Object, as a Foldkit Managed
 * Resource. The Model decides when it is open; a closed socket waits and
 * reconnects, and resumes from the last event it received.
 */
import { Duration, Effect, Option, Queue, Schema, Stream } from 'effect'
import { Command, ManagedResource } from 'foldkit'
import {
  ClientCommand,
  ClientCommandJson,
  ServerEventJson,
} from '../shared/protocol.ts'
import { socketUrl } from './api.ts'
import { Message } from './message.ts'
import { SocketState, type Model } from './model.ts'

const PING = JSON.stringify({ _tag: 'Ping' })
/** Keeps intermediaries from closing an idle socket; answered without waking the object. */
const PING_INTERVAL = 25_000

export const DocumentSocket = ManagedResource.tag<WebSocket>()('DocumentSocket')
export type DocumentSocketService = ManagedResource.ServiceOf<
  typeof DocumentSocket
>

const Requirements = Schema.Option(
  Schema.Struct({ documentId: Schema.String, attempt: Schema.Number }),
)

export const managedResources = ManagedResource.make<Model, Message>()(
  (entry) => ({
    socket: entry(Requirements, {
      resource: DocumentSocket,
      modelToMaybeRequirements: (model) => {
        const id = model.documentId
        if (
          model.documentKind !== 'remote' ||
          !id ||
          model.session._tag !== 'SignedIn'
        )
          return Option.none()
        return SocketState.match<
          Option.Option<{ documentId: string; attempt: number }>
        >(model.socket, {
          Connecting: ({ attempt }) => Option.some({ documentId: id, attempt }),
          Connected: ({ attempt }) => Option.some({ documentId: id, attempt }),
          Disconnected: () => Option.none(),
          WaitingToReconnect: () => Option.none(),
        })
      },
      acquire: ({ documentId }) =>
        Effect.callback<WebSocket, Error>((resume) => {
          const socket = new WebSocket(socketUrl(documentId))
          const opened = () => resume(Effect.succeed(socket))
          const failed = () =>
            resume(Effect.fail(new Error('The connection failed.')))
          socket.addEventListener('open', opened, { once: true })
          socket.addEventListener('error', failed, { once: true })
          return Effect.sync(() => {
            socket.removeEventListener('open', opened)
            socket.removeEventListener('error', failed)
          })
        }).pipe(
          // Slow connections get time to open.
          Effect.timeout(Duration.seconds(20)),
          Effect.tap((socket) =>
            Effect.sync(() => {
              const timer = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) socket.send(PING)
              }, PING_INTERVAL)
              socket.addEventListener('close', () => clearInterval(timer), {
                once: true,
              })
            }),
          ),
        ),
      release: (socket) => Effect.sync(() => socket.close(1000)),
      onAcquired: () => Message.ConnectedSocket(),
      onReleased: () => Message.ReleasedSocket(),
      onAcquireError: (error) =>
        Message.FailedConnectSocket({ error: String(error) }),
    }),
  }),
)

/** Events from the open socket, then one ClosedSocket when it closes. */
export const socketEvents = (socket: WebSocket) =>
  Stream.callback<
    typeof Message.ReceivedEvent.Type | typeof Message.ClosedSocket.Type
  >((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const message = ({ data }: MessageEvent) => {
          const decoded = Schema.decodeUnknownOption(ServerEventJson)(
            String(data),
          )
          if (decoded._tag === 'Some')
            Queue.offerUnsafe(
              queue,
              Message.ReceivedEvent({ event: decoded.value }),
            )
        }
        const close = ({ code }: CloseEvent) => {
          Queue.offerUnsafe(queue, Message.ClosedSocket({ code }))
          Queue.endUnsafe(queue)
        }
        socket.addEventListener('message', message)
        socket.addEventListener('close', close)
        // It may have closed before anyone listened.
        if (socket.readyState >= WebSocket.CLOSING)
          close(new CloseEvent('close', { code: 1006 }))
        return { message, close }
      }),
      ({ message, close }) =>
        Effect.sync(() => {
          socket.removeEventListener('message', message)
          socket.removeEventListener('close', close)
        }),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

export const SendToDocument = Command.define('SendToDocument', {
  args: { command: ClientCommand },
  messages: [Message.Completed, Message.FailedSend],
  execute: ({ command }) =>
    DocumentSocket.get.pipe(
      Effect.flatMap((socket) =>
        Effect.try({
          try: () => socket.send(Schema.encodeSync(ClientCommandJson)(command)),
          catch: () => 'The connection closed.',
        }),
      ),
      Effect.as(Message.Completed()),
      Effect.catch(() => Effect.succeed(Message.FailedSend())),
    ),
})

export const WaitToReconnect = Command.define('WaitToReconnect', {
  args: { attempt: Schema.Number },
  messages: [Message.ElapsedReconnectDelay],
  execute: ({ attempt }) =>
    Effect.sleep(Duration.millis(Math.min(15_000, 500 * 2 ** attempt))).pipe(
      Effect.as(Message.ElapsedReconnectDelay()),
    ),
})
