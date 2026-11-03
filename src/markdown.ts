/**
 * Assistant replies as Markdown (with GitHub tables, task lists and
 * strikethrough), built as virtual DOM rather than HTML, so model output
 * can never inject markup.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Html, HtmlBuilder } from 'foldkit/html'
import type { Nodes, RootContent } from 'mdast'

type Child = Html | string

const safeHref = (url: string) =>
  /^(https?:|mailto:|#)/i.test(url) ? url : undefined

function children<M>(
  h: HtmlBuilder<M>,
  nodes: readonly RootContent[],
): Child[] {
  return nodes.map((node) => render(h, node))
}

function render<M>(h: HtmlBuilder<M>, node: Nodes): Child {
  switch (node.type) {
    case 'root':
      return h.div([], children(h, node.children))
    case 'text':
      return node.value
    case 'paragraph':
      return h.p([], children(h, node.children))
    case 'heading': {
      const tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[
        node.depth - 1
      ]!
      return h[tag]([], children(h, node.children))
    }
    case 'emphasis':
      return h.em([], children(h, node.children))
    case 'strong':
      return h.strong([], children(h, node.children))
    case 'delete':
      return h.del([], children(h, node.children))
    case 'inlineCode':
      return h.code([], [node.value])
    case 'code':
      return h.pre(
        [],
        [
          h.code(node.lang ? [h.Class(`language-${node.lang}`)] : [], [
            node.value,
          ]),
        ],
      )
    case 'blockquote':
      return h.blockquote([], children(h, node.children))
    case 'list': {
      const items = children(h, node.children)
      return node.ordered
        ? h.ol(
            node.start && node.start !== 1 ? [h.Start(node.start)] : [],
            items,
          )
        : h.ul([], items)
    }
    case 'listItem': {
      // Tight list items hold their text without paragraphs.
      const content = node.spread
        ? children(h, node.children)
        : node.children.flatMap((child) =>
            child.type === 'paragraph'
              ? children(h, child.children)
              : [render(h, child)],
          )
      return h.li(
        [],
        node.checked === null || node.checked === undefined
          ? content
          : [
              h.input([
                h.Type('checkbox'),
                h.Checked(node.checked),
                h.Disabled(true),
              ]),
              ' ',
              ...content,
            ],
      )
    }
    case 'link': {
      const href = safeHref(node.url)
      return href
        ? h.a(
            [h.Href(href), h.Target('_blank'), h.Rel('noreferrer')],
            children(h, node.children),
          )
        : h.span([], children(h, node.children))
    }
    case 'image':
      return node.alt ?? ''
    case 'break':
      return h.br([])
    case 'thematicBreak':
      return h.hr([])
    case 'table':
      return h.table(
        [],
        [
          h.thead(
            [],
            node.children.slice(0, 1).map((row) => render(h, row)),
          ),
          h.tbody(
            [],
            node.children.slice(1).map((row) => render(h, row)),
          ),
        ],
      )
    case 'tableRow':
      return h.tr([], children(h, node.children))
    case 'tableCell':
      return h.td([], children(h, node.children))
    case 'html':
      return node.value
    default:
      return 'children' in node
        ? h.span([], children(h, node.children as RootContent[]))
        : ''
  }
}

export function markdown<M>(h: HtmlBuilder<M>, text: string): Html {
  const tree = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
  return h.div([h.Class('markdown')], children(h, tree.children))
}
