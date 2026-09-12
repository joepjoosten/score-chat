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
- Ask the assistant to explain or edit music. Its Effect AI tools read, validate, and update the score in the browser. Invalid updates are rejected and returned to the model as diagnostics. Each message allows up to eight model steps; Stop cancels work.
- Undo restores up to 20 score replacements made by the agent or file imports during the current session.
- Settings (including your API key), selected view, and current score persist in local storage. Chat and undo history are session-only. Storage failures are shown in the UI.

## Client-side architecture

Vite emits only static files into `dist/`. There is no backend, server function, or runtime package installation. Asset paths are relative, so the same build works at a domain root or a GitHub Pages repository path. This app does not use history routing or require rewrite rules.

The LilyPond compiler runs in a dedicated Web Worker, with a 20-second timeout and a source-size limit. SVGs are displayed as images rather than injected HTML. The music font is bundled; rendering makes no external requests. The renderer supports a subset of LilyPond **2.24.4**, not all GNU LilyPond features, and reports unsupported syntax as diagnostics.

The agent loop runs locally, but **model inference happens through OpenRouter**, not on your computer. Sending a message shares the current score and conversation with OpenRouter and the selected provider. Your API key is sent in the authorization header to OpenRouter; it is never included in the build, prompt, or displayed errors. Browser local storage is not an encrypted secret store; use a limited-spend key and avoid shared devices. Clearing the key in Settings and saving removes it from the stored settings.

- `src/state.ts`: Effect Atom state and validated local-storage settings.
- `src/renderer.ts`: cancellable browser worker requests.
- `src/agent.ts`: Effect AI toolkit and OpenRouter integration, loaded when chat starts.
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
