import { performScore } from './renderer.ts'
import type { Performance, PlayedNote, SourcePosition } from './renderer.ts'
import { anchorKey } from '../shared/selection.ts'

/** Seconds of music scheduled ahead of the audio clock. */
const LOOKAHEAD = 0.3
const SCHEDULE_INTERVAL = 50
/** General MIDI's percussion channel; this synth has no drum kit. */
const PERCUSSION = 9

// Browsers limit the number of audio contexts, so the page shares one.
let audio: AudioContext | undefined
let output: AudioNode | undefined
function audioContext(): AudioContext {
  if (!audio) {
    audio = new AudioContext()
    const compressor = audio.createDynamicsCompressor()
    const gain = audio.createGain()
    gain.gain.value = 0.5
    compressor.connect(gain).connect(audio.destination)
    output = compressor
  }
  return audio
}

/**
 * Plays a performance on a small Web Audio synth. Notes are scheduled a little
 * ahead of the audio clock, so pausing only has to silence a few voices.
 */
export class Player {
  private readonly voices = new Set<{
    oscillator: OscillatorNode
    gain: GainNode
  }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private next = 0
  /** Audio clock time at which the performance started, when playing. */
  private startedAt = 0
  /** Performance time to resume from, when not playing. */
  private offset = 0
  playing = false

  constructor(
    readonly performance: Performance,
    private readonly onEnd: () => void,
  ) {}

  get position(): number {
    return this.playing
      ? Math.max(0, audioContext().currentTime - this.startedAt)
      : this.offset
  }

  play() {
    const context = audioContext()
    void context.resume()
    if (this.offset >= this.performance.duration) this.offset = 0
    this.startedAt = context.currentTime + 0.05 - this.offset
    const index = this.performance.notes.findIndex(
      (note) => note.time >= this.offset,
    )
    this.next = index < 0 ? this.performance.notes.length : index
    this.playing = true
    this.schedule()
    this.timer = setInterval(() => this.schedule(), SCHEDULE_INTERVAL)
  }

  pause() {
    this.offset = this.position
    this.halt()
  }

  stop() {
    this.offset = 0
    this.halt()
  }

  private halt() {
    this.playing = false
    clearInterval(this.timer)
    const now = audioContext().currentTime
    // A short fade instead of a hard cut avoids clicks.
    for (const { oscillator, gain } of this.voices) {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setTargetAtTime(0, now, 0.015)
      oscillator.stop(now + 0.1)
    }
    this.voices.clear()
  }

  private schedule() {
    const { notes, duration } = this.performance
    const horizon = audioContext().currentTime + LOOKAHEAD - this.startedAt
    while (this.next < notes.length && notes[this.next].time < horizon)
      this.sound(notes[this.next++])
    if (this.position >= duration) {
      this.stop()
      this.onEnd()
    }
  }

  private sound(note: PlayedNote) {
    if (note.channel === PERCUSSION) return
    const context = audioContext()
    const start = Math.max(this.startedAt + note.time, context.currentTime)
    const end = Math.max(
      this.startedAt + note.time + note.duration,
      start + 0.05,
    )
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12)
    const peak = (note.velocity / 127) * 0.3
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peak, start + 0.01)
    gain.gain.setTargetAtTime(peak * 0.6, start + 0.01, 0.15)
    gain.gain.setTargetAtTime(0, end, 0.04)
    oscillator.connect(gain).connect(output!)
    oscillator.start(start)
    oscillator.stop(end + 0.3)
    const voice = { oscillator, gain }
    this.voices.add(voice)
    oscillator.onended = () => {
      this.voices.delete(voice)
      gain.disconnect()
    }
  }
}

// The page plays one score at a time; Commands drive it, the Model only
// mirrors its state.
let current: Player | undefined
let loading: AbortController | undefined

export type StartResult =
  { ok: true } | { ok: false; error: string; position: SourcePosition | null }

/**
 * Plays the score, performing it first unless it was already performed and
 * only paused. Audio starts inside the click, as browsers require.
 */
export async function play(source: string): Promise<StartResult> {
  void audioContext().resume()
  if (!current) {
    loading?.abort()
    const controller = new AbortController()
    loading = controller
    const result = await performScore(source, controller.signal).catch(
      () => undefined,
    )
    if (controller.signal.aborted)
      return { ok: false, error: '', position: null }
    loading = undefined
    if (!result?.performance)
      return {
        ok: false,
        error: result?.error ?? 'The score could not be performed.',
        position: result?.position ?? null,
      }
    // At the end it stops by itself and keeps the performance for the next play.
    current = new Player(result.performance, () => {})
  }
  current.play()
  return { ok: true }
}

export const isPlaying = () => current?.playing ?? false

export function pause() {
  current?.pause()
}

/** Stops and rewinds; the performance is kept for the next play. */
export function rewind() {
  loading?.abort()
  loading = undefined
  current?.stop()
}

/** Forgets the performance, e.g. because the score changed. */
export function discard() {
  rewind()
  current = undefined
}

/** Anchor keys of the notes sounding right now. */
export function soundingKeys(): string[] {
  if (!current?.playing) return []
  const position = current.position
  return current.performance.cues
    .filter((cue) => cue.time <= position && position < cue.end)
    .map(anchorKey)
}
