/**
 * Links the systems of a scan to the live score. A converted score has a
 * `% system N` comment where each line of the scan starts, and those comments
 * travel with the text through hand and assistant edits.
 */
import type { Review } from './protocol.ts'

/** A stretch of source: 1-based lines, both ends included. */
export interface LineRange {
  readonly start: number
  readonly end: number
}

/** Where a system is on the rendered page, in the page's own units. */
export interface SystemCrop {
  readonly page: number
  readonly y: number
  readonly height: number
}

interface PlacedAnchor {
  readonly page: number
  readonly system: number
  readonly y: number
  readonly height: number
  readonly line: number
}

const MARKER = /^\s*%\s*system\s+(\d+)\s*$/
const STAFF_END = /^\s*}/
/** Room above and below the marks on a system, for the staff lines around them. */
const CROP_PADDING = 2

/** Every system's lines. A score with several staves has a range per staff. */
export function systemRanges(source: string): Map<number, LineRange[]> {
  const ranges = new Map<number, LineRange[]>()
  let current: { system: number; start: number } | null = null
  const close = (end: number) => {
    if (!current) return
    const list = ranges.get(current.system) ?? []
    ranges.set(current.system, [...list, { start: current.start, end }])
    current = null
  }
  const lines = source.split('\n')
  lines.forEach((text, index) => {
    const line = index + 1
    const marker = text.match(MARKER)
    if (marker) {
      close(line - 1)
      current = { system: Number(marker[1]), start: line + 1 }
    } else if (STAFF_END.test(text)) close(line - 1)
  })
  close(lines.length)
  return ranges
}

/** A system's music as written, for comparing versions of it. */
export function systemText(source: string, system: number): string {
  const lines = source.split('\n')
  return (systemRanges(source).get(system) ?? [])
    .flatMap(({ start, end }) => lines.slice(start - 1, end))
    .join(' ')
    .replace(/\\break\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether a system differs from what the conversion produced. */
export const isEdited = (review: Review, system: number, source: string) =>
  systemText(review.source, system) !== systemText(source, system)

/** What the model is told about the scan that comes with a message. */
export function describeSystem(
  review: Review,
  system: number,
  source: string,
): string {
  const ranges = systemRanges(source).get(system) ?? []
  const lines = ranges.map(({ start, end }) => `${start}-${end}`).join(', ')
  const flags = review.systems.find((entry) => entry.system === system)?.flags
  return [
    `Attached: the scan of system ${system}${lines ? `, which is on lines ${lines} of the score` : ''}.`,
    flags?.length
      ? `The recognizer's doubts when it read this system, numbering bars from the start of the system: ${flags.join('; ')}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** The score without its markers, once nothing links to them anymore. */
export const stripSystemMarkers = (source: string) =>
  source
    .split('\n')
    .filter((line) => !MARKER.test(line))
    .join('\n')

/**
 * Where a system ended up on the rendered pages. It usually fills one rendered
 * system, but an edit can push it over several. A crop stops halfway to the
 * next system, so it shows none of that system's marks.
 */
export function systemCrops(
  ranges: readonly LineRange[],
  anchors: readonly PlacedAnchor[],
): SystemCrop[] {
  const bands = new Map<
    string,
    { page: number; top: number; bottom: number; linked: boolean }
  >()
  for (const anchor of anchors) {
    const key = `${anchor.page}:${anchor.system}`
    const band = bands.get(key) ?? {
      page: anchor.page,
      top: anchor.y,
      bottom: anchor.y + anchor.height,
      linked: false,
    }
    band.top = Math.min(band.top, anchor.y)
    band.bottom = Math.max(band.bottom, anchor.y + anchor.height)
    band.linked ||= ranges.some(
      ({ start, end }) => anchor.line >= start && anchor.line <= end,
    )
    bands.set(key, band)
  }
  const ordered = [...bands.values()].sort(
    (a, b) => a.page - b.page || a.top - b.top,
  )
  return ordered.flatMap((band, index) => {
    if (!band.linked) return []
    const above = ordered[index - 1]
    const below = ordered[index + 1]
    const top = Math.max(
      0,
      above?.page === band.page
        ? Math.max(band.top - CROP_PADDING, (above.bottom + band.top) / 2)
        : band.top - CROP_PADDING,
    )
    const bottom =
      below?.page === band.page
        ? Math.min(band.bottom + CROP_PADDING, (band.bottom + below.top) / 2)
        : band.bottom + CROP_PADDING
    return [{ page: band.page, y: top, height: bottom - top }]
  })
}
