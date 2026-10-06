const BLOCKED_ELEMENTS = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
]

/**
 * Prepares a rendered page for inline display. The renderer escapes its own
 * output, but imported scores are untrusted, so active content is stripped
 * before the markup is injected. Fixed millimetre dimensions are removed so
 * the page scales with its container like the image version.
 */
export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  if (root.nodeName !== 'svg') return ''
  for (const element of root.querySelectorAll(BLOCKED_ELEMENTS.join(',')))
    element.remove()
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim().toLowerCase()
      if (
        name.startsWith('on') ||
        ((name === 'href' || name === 'xlink:href') &&
          !value.startsWith('#') &&
          !value.startsWith('http'))
      )
        element.removeAttribute(attribute.name)
    }
  }
  root.removeAttribute('width')
  root.removeAttribute('height')
  return root.outerHTML
}
