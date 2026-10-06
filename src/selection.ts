/** A note head or rest on a rendered page, mapped back to its span in the source. */
export interface Anchor {
  kind: 'note' | 'rest'
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

/** A highlighted note as attached to a chat message. */
export interface SelectedNote {
  text: string
  line: number
  column: number
  endLine: number
  endColumn: number
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

/**
 * Chooses the anchors a marker swipe covers. A swipe that is too small to be a
 * drag counts as a tap on the nearest anchor, with some tolerance around it.
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
  if (!tap || hits.length <= 1) return hits
  const distance = (anchor: Anchor) =>
    Math.hypot(
      anchor.x + anchor.width / 2 - box.x,
      anchor.y + anchor.height / 2 - box.y,
    )
  return [hits.reduce((a, b) => (distance(a) <= distance(b) ? a : b))]
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
  const seen = new Set<string>()
  const notes: SelectedNote[] = []
  for (const anchor of anchors) {
    const key = anchorKey(anchor)
    if (!selected.has(key) || seen.has(key)) continue
    seen.add(key)
    const text =
      anchor.line === anchor.endLine
        ? (lines[anchor.line - 1] ?? '').slice(
            anchor.column - 1,
            anchor.endColumn - 1,
          )
        : (lines[anchor.line - 1] ?? '').slice(anchor.column - 1)
    notes.push({
      text,
      line: anchor.line,
      column: anchor.column,
      endLine: anchor.endLine,
      endColumn: anchor.endColumn,
    })
  }
  return notes.sort((a, b) => a.line - b.line || a.column - b.column)
}

/** Describes highlighted notes for the model, appended to the user's message. */
export function describeSelection(notes: readonly SelectedNote[]): string {
  if (!notes.length) return ''
  const items = notes.map(
    (note) =>
      `- line ${note.line}, columns ${note.column}-${note.endColumn - 1}: \`${note.text}\``,
  )
  return `[The user highlighted ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} on the rendered score. Positions are 1-based line and column ranges in the current source; apply the request to exactly these notes unless told otherwise.\n${items.join('\n')}]`
}
