/** The CodeMirror LilyPond editor, loaded with the first visit to the LilyPond tab. */
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { setDiagnostics } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  completeLilypond,
  lilypond,
  lilypondHighlight,
} from './lilypondLanguage.ts'
import type { SourcePosition } from './model.ts'
import { markErrors, offsetOf } from './sourceErrors.ts'

const theme = EditorView.theme({
  '&': { height: '100%', background: 'transparent', fontSize: '12px' },
  '&.cm-focused': { outline: 'none', boxShadow: 'inset 0 0 0 1px #a6b795' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    lineHeight: '22px',
  },
  // Room to scroll the last lines clear of the floating assistant.
  '.cm-content': { padding: '18px 0 calc(var(--dock-gap) + 150px)' },
  '.cm-line': { padding: '0 14px' },
  '.cm-gutters': {
    background: '#f4f5ee',
    color: '#a0a68f',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px' },
  '.cm-activeLine': { background: '#f1f3e9' },
  '.cm-activeLineGutter': { background: '#e9ecdf', color: '#6d7a5c' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: '#dfe7cf !important',
  },
  '.cm-matchingBracket': { background: '#e2ead3', outline: 'none' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    maxHeight: '16em',
  },
  '.cm-completionDetail': { color: '#89927c', marginLeft: '1em' },
  '.cm-completionInfo': { maxWidth: '320px', lineHeight: '1.5' },
})

export interface EditorOptions {
  doc: string
  readOnly: boolean
  maxLength: number
  onChange: (doc: string) => void
}

/** What the app does to a mounted editor. */
export interface EditorController {
  /** Replaces the document from outside (assistant, undo, a file), starting a fresh history. */
  replace(doc: string): void
  setReadOnly(readOnly: boolean): void
  /** Marks render errors; ignored when they belong to another version of the text. */
  setErrors(
    source: string,
    errors: readonly string[],
    positions: readonly (SourcePosition | null)[],
  ): void
  /** Selects a position and scrolls it into view. */
  reveal(position: SourcePosition): void
  destroy(): void
}

export function createEditor(
  parent: HTMLElement,
  options: EditorOptions,
): EditorController {
  const editable = new Compartment()
  let readOnly = options.readOnly
  const extensions = (): Extension[] => [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    lilypond,
    syntaxHighlighting(lilypondHighlight),
    autocompletion({ override: [completeLilypond], icons: false }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorState.tabSize.of(2),
    EditorState.changeFilter.of(
      (transaction) =>
        transaction.newDoc.length <= options.maxLength ||
        transaction.newDoc.length <= transaction.startState.doc.length,
    ),
    editable.of(EditorState.readOnly.of(readOnly)),
    EditorView.contentAttributes.of({
      'aria-label': 'LilyPond source',
      spellcheck: 'false',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString())
    }),
    theme,
  ]
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.doc, extensions: extensions() }),
  })
  return {
    replace(doc) {
      if (view.state.doc.toString() === doc) return
      const scroll = view.scrollDOM.scrollTop
      // A new state, so typing undo cannot step past the replacement.
      view.setState(EditorState.create({ doc, extensions: extensions() }))
      view.scrollDOM.scrollTop = scroll
    },
    setReadOnly(next) {
      readOnly = next
      view.dispatch({
        effects: editable.reconfigure(EditorState.readOnly.of(next)),
      })
    },
    setErrors(source, errors, positions) {
      const doc = view.state.doc.toString()
      if (doc !== source) return
      view.dispatch(
        setDiagnostics(
          view.state,
          markErrors(doc, errors, positions).map((error) => ({
            ...error,
            severity: 'error' as const,
          })),
        ),
      )
    },
    reveal(position) {
      const doc = view.state.doc.toString()
      const from = offsetOf(doc, position.line, position.column)
      const to = Math.max(
        from,
        offsetOf(doc, position.endLine, position.endColumn),
      )
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      })
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
}
