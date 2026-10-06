/**
 * A printed element on a rendered page, mapped back to the source span of the
 * music event that caused it (the renderer's point-and-click link).
 */
export interface Anchor {
  /** LilyPond grob name, e.g. NoteHead, Rest, Slur or DynamicText. */
  kind: string
  page: number
  system: number
  /** Page-space box in the page SVG's viewBox units (millimetres). */
  x: number
  y: number
  width: number
  height: number
  /** 1-based source position; the end column is exclusive. */
  line: number
  column: number
  endLine: number
  endColumn: number
}

/** A highlighted source event as attached to a chat message. */
export interface SelectedNote {
  text: string
  line: number
  column: number
  endLine: number
  endColumn: number
  /** Readable kinds of the highlighted elements, e.g. `note` or `slur`. */
  kinds?: string[]
  /** The full source line the event starts on. */
  context?: string
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export const anchorKey = (anchor: Pick<Anchor, 'line' | 'column'>) =>
  `${anchor.line}:${anchor.column}`

export function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

/** Normalizes a drag from `start` to `end` into a box with positive size. */
export function dragBox(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Box {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

/** Elements larger than this (mm²), such as slurs, hairpins and text, are
 * only swiped up when the swipe covers their centre. */
const SMALL_AREA = 4

/**
 * Chooses the anchors a marker swipe covers. A swipe that is too small to be a
 * drag counts as a tap on the closest, smallest anchor, with some tolerance
 * around it.
 */
export function anchorsInBox(
  anchors: readonly Anchor[],
  box: Box,
  page: number,
): Anchor[] {
  const tap = box.width < 0.5 && box.height < 0.5
  const probe: Box = tap
    ? { x: box.x - 1, y: box.y - 1, width: 2, height: 2 }
    : box
  const hits = anchors.filter(
    (anchor) => anchor.page === page && intersects(anchor, probe),
  )
  if (!tap)
    return hits.filter(
      (anchor) =>
        anchor.width * anchor.height <= SMALL_AREA ||
        contains(
          box,
          anchor.x + anchor.width / 2,
          anchor.y + anchor.height / 2,
        ),
    )
  if (hits.length <= 1) return hits
  // Distance from the tap to the box; nested elements prefer the smaller one.
  const rank = (anchor: Anchor) => [
    Math.hypot(
      Math.max(anchor.x - box.x, 0, box.x - anchor.x - anchor.width),
      Math.max(anchor.y - box.y, 0, box.y - anchor.y - anchor.height),
    ),
    anchor.width * anchor.height,
  ]
  return [
    hits.reduce((a, b) => {
      const [da, sa] = rank(a)
      const [db, sb] = rank(b)
      return da < db || (da === db && sa <= sb) ? a : b
    }),
  ]
}

function contains(box: Box, x: number, y: number): boolean {
  return (
    x >= box.x &&
    x <= box.x + box.width &&
    y >= box.y &&
    y <= box.y + box.height
  )
}

const KIND_NAMES: Record<string, string> = {
  NoteHead: 'note',
  TabNoteHead: 'note',
  Rest: 'rest',
  MultiMeasureRest: 'multi-measure rest',
  MultiMeasureRestText: 'multi-measure rest text',
  Script: 'articulation',
  DynamicText: 'dynamic',
  TextScript: 'text',
  KeySignature: 'key signature',
  KeyCancellation: 'key signature',
  TimeSignature: 'time signature',
  TupletBracket: 'tuplet',
  TupletNumber: 'tuplet',
  LyricText: 'lyric',
  ChordName: 'chord name',
  MetronomeMark: 'tempo mark',
  StemTremolo: 'tremolo',
  TrillSpanner: 'trill',
  SustainPedal: 'pedal',
  SostenutoPedal: 'pedal',
  UnaCordaPedal: 'pedal',
  PianoPedalBracket: 'pedal',
}

/** A readable name for a LilyPond grob, e.g. `DynamicText` → `dynamic`. */
export function kindName(kind: string): string {
  return (
    KIND_NAMES[kind] ?? kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  )
}

/**
 * Merges the selected anchors of one page into felt-tip strokes: one box per
 * system, spanning from the first to the last highlighted note.
 */
export function markerStrokes(
  anchors: readonly Anchor[],
  selected: ReadonlySet<string>,
  page: number,
): Box[] {
  const bySystem = new Map<number, Box>()
  for (const anchor of anchors) {
    if (anchor.page !== page || !selected.has(anchorKey(anchor))) continue
    const box: Box = {
      x: anchor.x - 0.8,
      y: anchor.y - 1.2,
      width: anchor.width + 1.6,
      height: anchor.height + 2.4,
    }
    const current = bySystem.get(anchor.system)
    if (!current) {
      bySystem.set(anchor.system, box)
      continue
    }
    const x = Math.min(current.x, box.x)
    const y = Math.min(current.y, box.y)
    bySystem.set(anchor.system, {
      x,
      y,
      width: Math.max(current.x + current.width, box.x + box.width) - x,
      height: Math.max(current.y + current.height, box.y + box.height) - y,
    })
  }
  return [...bySystem.values()]
}

/** Resolves the selected anchors to their source text, in document order. */
export function selectedNotes(
  anchors: readonly Anchor[],
  selected: ReadonlySet<string>,
  source: string,
): SelectedNote[] {
  const lines = source.split('\n')
  const seen = new Map<string, SelectedNote>()
  const notes: SelectedNote[] = []
  for (const anchor of anchors) {
    const key = anchorKey(anchor)
    if (!selected.has(key)) continue
    const kind = kindName(anchor.kind)
    const known = seen.get(key)
    if (known) {
      if (!known.kinds!.includes(kind)) known.kinds!.push(kind)
      continue
    }
    const text =
      anchor.line === anchor.endLine
        ? (lines[anchor.line - 1] ?? '').slice(
            anchor.column - 1,
            anchor.endColumn - 1,
          )
        : (lines[anchor.line - 1] ?? '').slice(anchor.column - 1)
    const note: SelectedNote = {
      text,
      line: anchor.line,
      column: anchor.column,
      endLine: anchor.endLine,
      endColumn: anchor.endColumn,
      kinds: [kind],
      context: lines[anchor.line - 1] ?? '',
    }
    seen.set(key, note)
    notes.push(note)
  }
  return notes.sort((a, b) => a.line - b.line || a.column - b.column)
}

const plural = (count: number, kind: string) =>
  `${count} ${count === 1 ? kind : kind === 'text' ? 'texts' : `${kind}s`}`

/** The main kind of a selected event; selections saved before kinds were
 * recorded only held notes. */
const mainKind = (note: SelectedNote) =>
  note.kinds?.includes('note') ? 'note' : (note.kinds?.[0] ?? 'note')

/** Summarizes a selection by kind, largest group first, e.g. `3 notes, 1 slur`. */
export function summarizeSelection(notes: readonly SelectedNote[]): string {
  const counts = new Map<string, number>()
  for (const note of notes)
    counts.set(mainKind(note), (counts.get(mainKind(note)) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => plural(count, kind))
    .join(', ')
}

/**
 * Describes highlighted score elements for the model, appended to the user's
 * message: each source event with its kinds, grouped under its source line.
 */
export function describeSelection(notes: readonly SelectedNote[]): string {
  if (!notes.length) return ''
  const items: string[] = []
  let line: number | undefined
  for (const note of notes) {
    if (note.context !== undefined && note.line !== line) {
      line = note.line
      items.push(`Line ${note.line}: \`${note.context}\``)
    }
    const position =
      note.endLine === note.line
        ? `line ${note.line}, columns ${note.column}-${note.endColumn - 1}`
        : `lines ${note.line}-${note.endLine}, from column ${note.column}`
    items.push(
      `- ${position} (${(note.kinds ?? ['note']).join(', ')}): \`${note.text}\``,
    )
  }
  return `[The user highlighted ${summarizeSelection(notes)} on the rendered score. Positions are 1-based line and column ranges in the current source, each followed by the kinds of printed elements that come from it; apply the request to exactly these elements unless told otherwise.\n${items.join('\n')}]`
}
