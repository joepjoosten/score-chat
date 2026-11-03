import { Effect, Layer, Redacted, Stream } from 'effect'
import { AiError, LanguageModel, Prompt, type Response } from 'effect/ai'
import { FetchHttpClient } from 'effect/http'
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from '@effect/ai-openrouter'
import type { ReasoningEffort } from '../shared/protocol.ts'
import { ScoreTools, scoreToolHandlers, type ToolContext } from './tools.ts'

export interface AgentRun extends ToolContext {
  /** The user's OpenRouter key, decrypted for this run only. */
  readonly apiKey: string
  readonly model: string
  readonly reasoning: ReasoningEffort | null
  /** The conversation so far: from the start of the turn, or its last checkpoint. */
  readonly prompt: Prompt.Prompt
  /** Whether reply text was streamed before the checkpoint, so the next block starts a paragraph. */
  readonly spoke: boolean
  /** The first step's number; later than 1 when resuming. */
  readonly step: number
  readonly apiUrl?: string | undefined
  readonly onText: (text: string) => void
  readonly onThinking: (text: string) => void
  /** Called after every step that called tools, with the prompt to resume from. */
  readonly onCheckpoint: (
    prompt: Prompt.Prompt,
    step: number,
    spoke: boolean,
  ) => Effect.Effect<void>
}

/** Built per run: the client bakes the user's key into its requests. */
const languageModel = (run: AgentRun) => {
  const thinking = run.reasoning !== null && run.reasoning !== 'none'
  return OpenRouterLanguageModel.layer({
    model: run.model,
    config: {
      // Reasoning tokens count toward max_tokens, so thinking turns get more room for replies and tool calls.
      max_tokens: thinking ? 16384 : 8192,
      parallel_tool_calls: false,
      ...(run.reasoning ? { reasoning: { effort: run.reasoning } } : {}),
    },
  }).pipe(
    Layer.provide(
      OpenRouterClient.layer({
        apiKey: Redacted.make(run.apiKey),
        siteTitle: 'Score Chat',
        ...(run.apiUrl ? { apiUrl: run.apiUrl } : {}),
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
  )
}

/** Runs one turn: streams model output and executes score tools until the model stops calling them. */
export const runAgent = (run: AgentRun) =>
  Effect.gen(function* () {
    let prompt = run.prompt
    let spoke = run.spoke
    let inBlock = false
    // Streams a text chunk, separating text blocks with a blank line.
    const emit = (text: string) => {
      if (!text) return
      if (spoke && !inBlock) run.onText('\n\n')
      spoke = inBlock = true
      run.onText(text)
    }
    for (let step = run.step; ; step++) {
      run.onStatus(`Thinking${step > 1 ? ` · step ${step}` : ''}…`)
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
              run.onThinking(part.delta)
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
      yield* run.onCheckpoint(prompt, step + 1, spoke)
    }
  }).pipe(
    Effect.provide(scoreToolHandlers(run)),
    Effect.provide(languageModel(run)),
  )

/** A message for the user about a failed run. Never includes request details or the key. */
export function describeFailure(error: unknown): string {
  if (AiError.isAiError(error))
    switch (error.reason._tag) {
      case 'AuthenticationError':
        return 'OpenRouter did not accept your API key. Check it in Settings.'
      case 'QuotaExhaustedError':
        return 'Your OpenRouter account is out of credits.'
      case 'RateLimitError':
        return 'OpenRouter is rate limiting requests. Wait a moment and try again.'
      case 'ContentPolicyError':
        return 'The model provider declined this request.'
      case 'InvalidRequestError':
        return 'The model rejected the request. Check that the model in Settings supports tool calling.'
    }
  return 'The assistant could not complete the request. Check your model’s tool support, OpenRouter credits and connection, then try again.'
}
