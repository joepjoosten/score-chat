import { useEffect, useRef } from 'react'
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
} from './lilypondLanguage'
import { locateErrors } from './sourceErrors'

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

export default function SourceEditor({
  value,
  readOnly,
  errors,
  maxLength,
  onChange,
}: {
  value: string
  readOnly: boolean
  // Errors from rendering `value`; empty while a render is pending.
  errors: readonly string[]
  maxLength: number
  onChange: (value: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const editable = useRef(new Compartment())
  const latest = useRef({ onChange, readOnly })
  latest.current = { onChange, readOnly }

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
        transaction.newDoc.length <= maxLength ||
        transaction.newDoc.length <= transaction.startState.doc.length,
    ),
    editable.current.of(EditorState.readOnly.of(latest.current.readOnly)),
    EditorView.contentAttributes.of({
      'aria-label': 'LilyPond source',
      spellcheck: 'false',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged)
        latest.current.onChange(update.state.doc.toString())
    }),
    theme,
  ]

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions: extensions() }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
    // The editor is created once; later props are applied by the effects below.
  }, [])

  // Replacements from outside the editor (the assistant, score undo, opening a
  // file) start a fresh editing history, so typing undo cannot step past them.
  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    const scroll = editor.scrollDOM.scrollTop
    editor.setState(
      EditorState.create({ doc: value, extensions: extensions() }),
    )
    editor.scrollDOM.scrollTop = scroll
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const source = editor.state.doc.toString()
    editor.dispatch(
      setDiagnostics(
        editor.state,
        locateErrors(source, errors).map((error) => ({
          ...error,
          severity: 'error' as const,
        })),
      ),
    )
  }, [errors, value])

  return <div ref={host} className="source-editor" />
}
