# Score Chat

A static React + TypeScript workspace for editing LilyPond, viewing SVG sheet music, and chatting with a music agent. Effect, Effect Atom React, and the Effect OpenRouter provider are pinned to **4.0.0-rc.112**. Effect v4 provides the core atom and AI modules inside `effect/unstable`.

## Run locally

Requires Node.js 22.12+.

```sh
npm ci
npm run dev
```

Open **Settings**, enter an OpenRouter API key and a model ID with tool-calling support, then save. `openrouter/auto` is the default. No API key is needed to edit, import, render, or export music.

- Switch between **Sheet music** and **LilyPond**; edits render automatically. The score fills the window below a single toolbar.
- The assistant lives in a floating panel over the score. Click its header (or press Escape in the composer) to collapse it to just the message box; sending a message reopens it.
- Open a `.ly` file or download the current source. Each rendered page has an SVG download.
- Ask the assistant to explain or edit music. Its Effect AI tools search, read (by line range), validate, and edit the score in the browser; targeted changes are sent as exact text replacements instead of a full rewrite, and the score is no longer embedded in the prompt. Invalid edits are rejected and returned to the model as diagnostics. The assistant keeps working until it is done; **Stop** ends the turn immediately.
- The assistant can look things up in the bundled LilyPond 2.24.4 documentation (Notation Reference, snippets and Music Glossary) with full-text search. Every example in it is marked by whether Score Chat's renderer supports it.
- When the model exposes its reasoning, the latest ten lines stream into the chat while it thinks, then fold away; expand **Thought process** to read it all. Drag the assistant's top-left corner to resize it (double-click to reset); the size is remembered.
- Use the **highlighter** in the toolbar to swipe a felt-tip marker over the sheet music: notes, rests, articulations, dynamics, slurs, ties, hairpins, tuplets, key and time signatures, lyrics, chord names, text and more. Each highlighted element is attached to your next message as the source line and column range of the music event that produced it, together with its kind and the full source line, so "make this louder" or "remove this slur" applies to exactly those elements. Large elements such as slurs and hairpins are picked up when the swipe covers their centre; a tap picks the smallest element under the marker. Swipe again to add more, tap a highlighted element to lift the marker, and clear all from the chip above the composer. Any change to the score clears the highlight.
- Undo and redo step through up to 20 score replacements made by the agent or file imports during the current session. Editing the source by hand discards the redo history.
- Settings has a **Thinking** option: leave it on the model default, turn thinking off, or turn it on with an effort level from minimal to maximum. It's sent to OpenRouter as the reasoning effort; models without reasoning support ignore it.
- Settings has a **Sheet music pages** option: pages are shown as images by default; choose **Inline SVG** to put the rendered markup in the document so systems and glyphs can be inspected with browser developer tools (scripts, embedded HTML, and non-web links are stripped first).
- Settings (including your API key), selected view, and current score persist in local storage. Chat and undo history are session-only. Storage failures are shown in the UI.

## Client-side architecture

Vite emits only static files into `dist/`. There is no backend, server function, or runtime package installation. Asset paths are relative, so the same build works at a domain root or a GitHub Pages repository path. This app does not use history routing or require rewrite rules.

The LilyPond compiler runs in a dedicated Web Worker, with a 20-second timeout and a source-size limit. Alongside each page's SVG, the worker reports the page-space box of every printed element that the renderer's LilyPond point-and-click links to a music event, together with that event's source span and the grob kind (from the system placements); the app draws highlights on a transparent overlay from that data. SVGs are displayed as images by default; the optional inline mode sanitizes the markup (`src/svg.ts`) before injecting it. The music font is bundled; rendering makes no external requests. The renderer supports a subset of LilyPond **2.24.4**, not all GNU LilyPond features, and reports unsupported syntax as diagnostics.

The agent loop runs locally, but **model inference happens through OpenRouter**, not on your computer. Sending a message shares the current score and conversation with OpenRouter and the selected provider. Your API key is sent in the authorization header to OpenRouter; it is never included in the build, prompt, or displayed errors. Browser local storage is not an encrypted secret store; use a limited-spend key and avoid shared devices. Clearing the key in Settings and saving removes it from the stored settings.

- `src/state.ts`: Effect Atom state and validated local-storage settings.
- `src/renderer.ts`: cancellable browser worker requests.
- `src/harness/`: the agent harness, loaded when chat starts — `agent.ts` runs the model loop through OpenRouter, `tools.ts` defines the score tools, `prompt.ts` builds the system prompt and history, `scoreText.ts` holds the pure read, search and edit helpers, and `docs.ts` searches the bundled documentation (BM25 over titles, index entries and text) once `public/docs/lilypond-docs.json` is fetched on first use.
- `src/selection.ts`: maps marker swipes over the rendered page to notes in the source and describes them to the model.
- `src/App.tsx`: editor, SVG preview, settings, and conversation.

## Update the LilyPond renderer

The renderer is built from `~/development/github/lilypond-typescript`. Because that repository is private, this repository commits its browser-only bundle and font in `public/renderer/worker.js`. GitHub Actions needs no credentials to the private source repository. The exact source commit is recorded in `public/renderer/version.json`.

After committing renderer changes in the source repository:

```sh
npm run renderer:sync
# Or select a different checkout:
npm run renderer:sync -- /path/to/lilypond-typescript
npm run build
npm run test:e2e
```

Commit the updated worker and version metadata together. The sync command requires a clean source checkout and does not change it. It bundles the same `renderLySourceToSvg` and `parseSvgFontManifest` entry points used by that project's browser playground. The bundle is public when the app is deployed.

## Update the LilyPond documentation

The agent's documentation is generated from the LilyPond 2.24.4 sources in the same lilypond-typescript checkout. The script converts the Texinfo Notation Reference and Music Glossary and the snippet collection to text, and compiles every example with the renderer to record whether Score Chat supports it. Examples that need an explicit `\score` or `\new Staff` for the renderer are stored in the form that rendered. It needs [Bun](https://bun.sh), because it loads the renderer's TypeScript directly, and takes about a minute:

```sh
npm run docs:sync
# Or select a different checkout:
npm run docs:sync -- /path/to/lilypond-typescript
```

Rerun it after renderer updates so the support markers stay accurate, and commit `public/docs/`. The LilyPond documentation is licensed under the GNU Free Documentation License (included as `public/docs/COPYING.FDL`); the snippets are in the public domain. `public/llms.txt` is a separate hand-made index of the 2.26 manuals on lilypond.org and is not used by the agent.

## Checks

```sh
npm run format:check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests use the production build under `/score-chat/` and test local rendering, persistence, import recovery, mobile layout, and mocked OpenRouter authentication and tool execution. They do not make paid model requests. To check a real connection, configure your own key in Settings and send a message.

## Deploy

`.github/workflows/pages.yml` runs formatting, unit tests, a production build, and Chromium browser tests. Pushes to `main` deploy `dist/` using GitHub's Pages artifact workflow; pull requests run checks without deployment. You can also run the workflow manually.

The repository's Pages source must be **GitHub Actions** (`build_type: workflow`). No deployment or OpenRouter secrets are required. For another static host, upload the contents of `dist/`.

References: [Effect OpenRouter provider](https://github.com/Effect-TS/effect/tree/main/packages/ai/openrouter), [OpenRouter API](https://openrouter.ai/docs/quickstart), [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
