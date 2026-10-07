import { Effect, Layer, Redacted, Stream } from 'effect'
import { LanguageModel, Prompt, type Response } from 'effect/ai'
import { FetchHttpClient } from 'effect/http'
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from '@effect/ai-openrouter'
import type { Message, Settings } from '../state'
import { history, systemPrompt } from './prompt'
import { ScoreTools, scoreToolHandlers } from './tools'
import type { ToolContext } from './tools'

export interface AgentOptions extends ToolContext {
  settings: Settings
  messages: readonly Message[]
  /** Appends a chunk of assistant text; called repeatedly while streaming. */
  onText: (text: string) => void
  /** Appends a chunk of the model's reasoning, when the model exposes it. */
  onThinking: (text: string) => void
}

/** Runs one turn: streams model output and executes score tools until the model stops calling them. */
export function runAgent(agentOptions: AgentOptions): Promise<void> {
  const { settings, signal } = agentOptions
  // Once stopped, late stream chunks and tool results must not reach the UI or the score.
  const live =
    <A extends unknown[]>(callback: (...args: A) => void) =>
    (...args: A) => {
      if (!signal.aborted) callback(...args)
    }
  const options = {
    ...agentOptions,
    updateSource: live(agentOptions.updateSource),
    onStatus: live(agentOptions.onStatus),
    onText: live(agentOptions.onText),
    onThinking: live(agentOptions.onThinking),
  }
  const handlers = scoreToolHandlers(options)
  const thinking = settings.reasoning && settings.reasoning !== 'none'
  const client = OpenRouterClient.layer({
    apiKey: Redacted.make(settings.apiKey),
    siteTitle: 'Score Chat',
  }).pipe(Layer.provide(FetchHttpClient.layer))
  const model = OpenRouterLanguageModel.layer({
    model: settings.model,
    config: {
      // Reasoning tokens count toward max_tokens, so thinking turns get more room for replies and tool calls.
      max_tokens: thinking ? 16384 : 8192,
      parallel_tool_calls: false,
      ...(settings.reasoning
        ? { reasoning: { effort: settings.reasoning } }
        : {}),
    },
  }).pipe(Layer.provide(client))
  const program = Effect.gen(function* () {
    let prompt = Prompt.make([
      { role: 'system', content: systemPrompt(options.getSource()) },
      ...history(options.messages),
    ])
    let spoke = false
    let inBlock = false
    // Streams a text chunk to the UI, separating text blocks with a blank line.
    const emit = (text: string) => {
      if (!text) return
      if (spoke && !inBlock) options.onText('\n\n')
      spoke = inBlock = true
      options.onText(text)
    }
    for (let step = 1; ; step++) {
      options.onStatus(`Thinking${step > 1 ? ` · step ${step}` : ''}…`)
      const parts: Response.StreamPart<typeof ScoreTools.tools, 'opaque'>[] = []
      inBlock = false
      yield* LanguageModel.streamText({ prompt, toolkit: ScoreTools }).pipe(
        Stream.runForEach((part) =>
          Effect.sync(() => {
            parts.push(part)
            if (part.type === 'text-delta') emit(part.delta)
            else if (part.type === 'text-end') inBlock = false
            // Encrypted reasoning arrives as a "[REDACTED]" placeholder with nothing to show.
            else if (
              part.type === 'reasoning-delta' &&
              part.delta !== '[REDACTED]'
            )
              options.onThinking(part.delta)
          }),
        ),
      )
      if (!parts.some((part) => part.type === 'tool-call')) {
        if (!parts.some((part) => part.type === 'text-delta'))
          emit(
            'The model returned no text. Try sending another message or choosing a different model in Settings.',
          )
        return
      }
      prompt = Prompt.concat(prompt, Prompt.fromResponseParts(parts))
    }
  }).pipe(Effect.provide(handlers), Effect.provide(model))
  // Settle as soon as the user stops, without waiting for in-flight requests or renders to wind down.
  const stopped = new Promise<never>((_, reject) => {
    const stop = () => reject(new Error('Stopped by the user.'))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  return Promise.race([Effect.runPromise(program, { signal }), stopped])
}
