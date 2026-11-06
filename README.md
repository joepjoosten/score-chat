# Score Chat

A workspace for editing LilyPond, viewing SVG sheet music, and chatting with a music agent. The client is a [Foldkit](https://foldkit.dev) app (Elm architecture on Effect), and sheet music renders in the browser. The agent runs on Cloudflare: one Durable Object per document runs it, keeps its own SQLite database, and streams to the browser over a resumable WebSocket. [Alchemy](https://alchemy.run) defines and deploys all of it. Effect, Foldkit's peer range and the Effect OpenRouter provider are pinned to **4.1**.

## Run locally

Requires Node.js 22.19+.

```sh
npm ci
cp .env.example .env   # then set KEY_ENCRYPTION_SECRET (openssl rand -base64 32)
npm run dev            # alchemy dev: http://localhost:1337
```

`alchemy dev` runs the Worker, the Durable Objects, D1 and Vite with live reload locally in workerd. It needs no Cloudflare account and keeps its state in `.alchemy/`. Sign-in emails aren't sent locally: the link is printed in the dev log and written to `.alchemy/local/email/`.

No account is needed to edit, import, render, play or export music. Those scores stay in the browser. Signing in adds the assistant. It also keeps your scores in your account, available on any device; any scores already in the browser move there. To use the assistant, open **Settings**, enter an OpenRouter API key and a model ID with tool-calling support (`openrouter/auto` is the default), and save.

- **Documents.** The documents button next to the title lists your scores: create, open or delete them. Each has its own address (`/d/<id>`) and its own conversation.
- **Views.** Switch between **Sheet music** and **LilyPond**; edits render automatically. The score fills the window below a single toolbar.
- **Pages.** The sheet music shows one page at a time, or two side by side when both fit at the current zoom. Turn pages with the arrows in the toolbar or the arrow and Page Up/Down keys; playback turns them along with the music.
- **Assistant panel.** The assistant lives in a floating panel that always stays above the score.
  - Click its header (or press Escape in the composer) to collapse it to just the message box; sending a message reopens it.
  - Drag the header to move the panel to another corner (remembered).
  - **Hide** tucks it away behind a small handle. The handle spins while the assistant works and shows a dot when there is something new.
- **LilyPond editor.** The **LilyPond** tab is a CodeMirror editor with LilyPond highlighting (commands, notes and durations, strings, comments, Scheme).
  - Typing `\` suggests the commands Score Chat's renderer supports, each with the documentation section that describes it, along with the variables defined in the score. After `\new`, `\context` or `\clef` it suggests the supported context and clef names.
  - Render and playback errors are underlined where they occur. Each error above the score shows its line and column; clicking it selects that spot in the source.
  - Standard shortcuts apply, including undo, find (Cmd/Ctrl+F) and Tab to indent.
- **Files.** Open a `.ly` file (or drop one anywhere on the page), or download the current source.
- **Editing with the assistant.** Ask the assistant to explain or edit music.
  - Its Effect AI tools search, read (by line range), check and edit the document on the server.
  - Targeted changes are exact text replacements rather than a full rewrite.
  - Each edit is checked with the renderer's checker before it is applied. It parses and interprets the music, and labels each problem as a syntax error, invalid LilyPond or a construct the renderer doesn't support, often with a fix to try. An open browser then engraves it, and an edit it cannot engrave is taken back; the model gets the diagnostics either way.
  - **Stop** ends the turn.
- **It keeps working without you.** The turn belongs to the document, not the page. Close the tab or lose the connection and it carries on; when you come back, the browser replays only the events it missed.
- **Documentation lookups.** The assistant can look things up in the bundled LilyPond 2.24.4 documentation (Notation Reference, snippets and Music Glossary) with full-text search. Every example in it is marked by whether Score Chat's renderer supports it.
- **Thinking.** When the model exposes its reasoning, the latest ten lines stream into the chat while it thinks, then fold away; expand **Thought process** to read it all. Drag the assistant's inner corner to resize it (double-click to reset); the size is remembered.
- **Highlighter.** The **highlighter** in the toolbar swipes a felt-tip marker over the sheet music: notes, rests, articulations, dynamics, slurs, ties, hairpins, tuplets, key and time signatures, lyrics, chord names, text and more.
  - Each highlighted element is attached to your next message as the source line and column range of the music event that produced it, with its kind and the full source line. So "make this louder" or "remove this slur" applies to exactly those elements.
  - Large elements such as slurs and hairpins are picked up when the swipe covers their centre; a tap picks the smallest element under the marker.
  - Swipe again to add more, tap a highlighted element to lift the marker, and clear all from the chip above the composer. Any change to the score clears the highlight.
- **Playback.** **Play** performs the score with the renderer's MIDI generator on a small built-in Web Audio synth (percussion is silent). The note heads that are sounding light up on the page, which scrolls along. Pause keeps the position; **Back to the start** rewinds. A score without a `\midi` block is played as if it had an empty one.
- **Undo and redo** step through up to 20 score replacements made by the agent or file imports during the current session. Editing the source by hand discards the redo history.
- **Settings.**
  - **Thinking:** leave it on the model default, turn thinking off, or turn it on with an effort level from minimal to maximum. It is sent to OpenRouter as the reasoning effort; models without reasoning support ignore it.
  - **Sheet music pages:** pages show as images by default. **Inline SVG** puts the rendered markup in the document so you can inspect systems and glyphs with browser developer tools (scripts, embedded HTML and non-web links are stripped first).
  - The view, the page mode and the assistant's corner and size are kept in this browser. The model, thinking setting and API key belong to your account.

## Architecture

```
src/      the Foldkit client: Model, Messages, update, view, Commands, Subscriptions
shared/   code both sides run: the protocol schemas, score text tools, docs search, selections
server/   the Worker, the DocumentAgent Durable Object, accounts, the agent and its tools
migrations/  D1 schema        alchemy.run.ts  the stack: Worker, Durable Objects, D1, email
```

**Client.** `src/main.ts` assembles the program, and Foldkit runs it:

- `src/model.ts`: one Schema-defined Model.
- `src/message.ts`: fact-named Messages.
- `src/update.ts`: how each Message changes the Model and which Commands follow.
- `src/view.ts`: the view.
- `src/commands.ts`: side effects.
- `src/subscriptions.ts`: window events, playback frames and socket events.
- `src/socket.ts`: the document WebSocket as a Managed Resource that reconnects.
- `src/editor.ts` and `src/mounts.ts`: CodeMirror (loaded with the first visit to the LilyPond tab), the marker overlay and measurements, handed to Foldkit through Mounts.

The renderer (`src/renderer.ts`, `public/renderer/worker.js`) runs in a Web Worker, as before. It has a 20-second timeout and a source-size limit, loads renderer data, fonts and stylesheets just in time, and reports each printed element's page box and source span for the highlighter. `src/player.ts` schedules its MIDI on Web Audio.

**Server.** `server/worker.ts` is a plain Worker module:

- It serves the client build as static assets; client routes such as `/d/<id>` fall back to `index.html`.
- It answers the `/api` routes with Effect's `HttpRouter`: sign-in, settings, the document list.
- It forwards each document's WebSocket to that document's `DocumentAgent` (`server/DocumentAgent.ts`) after checking the session and ownership.

State-changing requests and sockets must come from the site's own origin.

- **Accounts (D1).** Users, single-use sign-in links (15 minutes), sessions (30 days, `HttpOnly` cookie) and the document index live in D1 (`server/accounts.ts`). Only SHA-256 hashes of link and session tokens are stored. OpenRouter keys are encrypted with AES-GCM under `KEY_ENCRYPTION_SECRET`, bound to their owner, and never returned to the browser.
- **Documents (Durable Objects).** Each `DocumentAgent` keeps its document in its own SQLite storage: the score and its revision, the conversation, the runs and a numbered event log.
- **Runs.** A turn runs as an Effect fiber in the object (`server/agent.ts`, `server/tools.ts`). It decrypts the user's key, calls OpenRouter through `@effect/ai-openrouter`, executes the tools and records every change as an event.
  - Streamed text and thinking are batched every 100 ms, so a slow connection gets fewer, larger frames.
  - After every step the run saves a checkpoint, and an alarm every 15 seconds keeps it alive. If the object restarts (for example during a deploy), the run resumes from its last checkpoint.
- **Checking edits.** Edits are checked server-side with `server/renderer/check.js`, the renderer's parser and music interpretation without engraving or layout. It reads its data tables and stylesheets from the static assets.
- **Connections.** Browsers connect over hibernatable WebSockets. `Hello { since }` replays the events after `since`, or sends a snapshot when the browser has nothing or has fallen too far behind (the last 4,000 events are kept). The protocol is in `shared/protocol.ts`.

**Privacy.** Music renders on your computer. Sending a message shares the conversation and the current score with OpenRouter and your selected model provider. The score and conversation are stored in your document's Durable Object.

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

To refresh the LilyJAZZ fonts and stylesheets in `public/renderer/fonts/lilyjazz`, pass a checkout of [OpenLilyPondFonts/lilyjazz](https://github.com/OpenLilyPondFonts/lilyjazz): `npm run renderer:sync -- --fonts=/path/to/lilyjazz`. Without it the synced fonts are kept.

For profiling or debugging locally, `npm run renderer:sync -- --debug` writes an unminified worker with a source map instead; sync again without it before committing.

The sync also writes `server/renderer/check.js`, the server's check, bundled from the same commit. It runs the renderer's checker (the classifier behind its `--check`) over the parser and music interpretation, without engraving or layout. Every problem is labelled syntax, invalid, unsupported or unclassified, often with a hint such as the intended spelling. Commit the updated worker, the check and the version metadata together. The sync command requires a clean source checkout and does not change it. It bundles the same `renderLySourceToSvg` and `parseSvgFontManifest` entry points used by that project's browser playground. The bundle is public when the app is deployed.

## Update the LilyPond documentation

The agent's documentation is generated from the LilyPond 2.24.4 sources in the same lilypond-typescript checkout. The script converts the Texinfo Notation Reference and Music Glossary and the snippet collection to text, and compiles every example with the renderer to record whether Score Chat supports it. Examples that need an explicit `\score` or `\new Staff` for the renderer are stored in the form that rendered. It needs [Bun](https://bun.sh), because it loads the renderer's TypeScript directly, and takes about a minute:

```sh
npm run docs:sync
# Or select a different checkout:
npm run docs:sync -- /path/to/lilypond-typescript
```

It also writes `public/docs/lilypond-commands.json`, the editor's completions: the documented commands, contexts and clefs the renderer supports, judged by whether a rendering example uses them or they render cleanly in a few small probes (`bun scripts/sync-commands.mjs` regenerates just that file). Rerun it after renderer updates so the support markers stay accurate, and commit `public/docs/`. The LilyPond documentation is licensed under the GNU Free Documentation License (included as `public/docs/COPYING.FDL`); the snippets are in the public domain. `public/llms.txt` is a separate hand-made index of the 2.26 manuals on lilypond.org and is not used by the agent.

## Checks

```sh
npm run format:check
npm test              # unit tests
npm run build         # typecheck client and server, build the client
npm run test:server   # the Worker, Durable Object and D1 under alchemy dev
npx playwright install chromium
npm run test:e2e      # the app in Chromium against alchemy dev
```

The server and browser tests run the whole stack locally under `alchemy dev`, with a stand-in for OpenRouter (`tests/browser/openrouter.ts`). They sign in through real magic links, create documents, and run the agent over the document socket, including a dropped connection partway through a reply. They don't need a Cloudflare account and make no paid model requests.

## Deploy

```sh
npx alchemy profile edit --add Cloudflare   # once: log in to Cloudflare
npm run deploy -- --stage prod
```

`alchemy deploy` builds the client and deploys the stack in `alchemy.run.ts`: the Worker with its static assets, the `DocumentAgent` Durable Object class (SQLite storage), the D1 database with `migrations/`, the `send_email` binding, and the R2 bucket, queue and container for PDF conversion. The `prod` stage answers on `score-chat.joepie.dev`, and Cloudflare manages its DNS record and certificate; other stages stay on `workers.dev`. Deploys keep their state in Alchemy's state store on the Cloudflare account. Configuration comes from the environment or `.env`:

- `KEY_ENCRYPTION_SECRET`: encrypts stored OpenRouter keys. Generate it once (`openssl rand -base64 32`) and back it up; without it, stored keys can't be decrypted and users have to enter them again.
- **Sign-in**, one of:
  - **Cloudflare Access (Zero Trust)**, which needs no mail domain: Cloudflare emails the one-time PIN. Set `ACCESS_TEAM_DOMAIN` to your team domain (`yourteam.cloudflareaccess.com`). The deploy then creates an Access application that guards only `/api/auth/access` and lets anyone in who proves an address. Signed-out use, the API and the document sockets stay outside Access. A successful sign-in lands on that path; the Worker checks the Access token (signature, issuer, expiry) and starts Score Chat's own 30-day session. The One-time PIN login method must be enabled in the team (Zero Trust › Settings › Authentication). Set `ACCESS_IDP_ID` to its ID to skip the provider picker. The deploy prints the application's audience tag as `accessAud`; set it as `ACCESS_AUD` to have the Worker check it too. Zero Trust's free plan covers 50 users.
  - **Emailed links**, used when `ACCESS_TEAM_DOMAIN` is empty: `EMAIL_FROM` is the sender, and its domain must be onboarded to [Cloudflare Email Service](https://developers.cloudflare.com/email-service/). With the domain on Cloudflare, set `EMAIL_ZONE_ID` too and Alchemy onboards it. `alchemy dev` always uses links, with simulated mail.

### PDF conversion

A PDF dropped on the page or chosen with the Open button becomes a new document in the background, with a toast when it is done. It takes an account. The Worker stores the PDF in R2 and adds a message to a queue. The queue's consumer runs one job at a time: it wakes the `Converter` container, sends it the PDF, creates the document, and deletes the PDF. Browsers poll `/api/conversions` while a job is active, and an outcome stays until it is dismissed, so it still shows after the tab was closed.

The container is [sheet-to-ly](https://github.com/joepjoosten/sheet-to-ly) behind `converter/server.py`, on a `standard-4` instance (4 vCPU, 12 GB) without internet. A page takes about 45 seconds of the 13 minutes a job gets, so PDFs are limited to 15 pages (`MAX_PAGES` in `converter/server.py`). It goes to sleep two minutes after the last job, and at most one instance runs. The code and weights aren't in this repository, so the image is built from a sheet-to-ly checkout with its `runs/` folder:

```sh
SHEET_TO_LY_DIR=/path/to/sheet-to-ly npm run converter:build   # about 1.9 GB
CONVERTER_IMAGE=score-chat-converter npm run deploy -- --stage prod
```

Alchemy pushes the local image to Cloudflare's registry. CI has neither the weights nor that local image, so set the `CONVERTER_IMAGE` variable there to the `registry.cloudflare.com/...` reference of the pushed image. Without `CONVERTER_IMAGE`, a deploy removes the container and turns conversion off. Locally, and in the tests, `CONVERTER_URL` points the queue's consumer at another converter instead, such as `docker run -p 8080:8080 score-chat-converter` or a stand-in.

`.github/workflows/deploy.yml` runs formatting, unit tests, the build, and the server and browser tests on every push and pull request. Pushes to `main` then deploy the `prod` stage. It needs:

- the secrets `CLOUDFLARE_API_TOKEN` and `KEY_ENCRYPTION_SECRET`;
- the variable `CLOUDFLARE_ACCOUNT_ID`, plus either `ACCESS_TEAM_DOMAIN` (and optionally `ACCESS_IDP_ID` and `ACCESS_AUD`) or `EMAIL_FROM` (and optionally `EMAIL_ZONE_ID`).

Run `npx alchemy state bootstrap` once beforehand: CI doesn't create the state store. The token needs Workers Scripts, D1, Durable Objects, R2, Queues, Containers and Secrets Store permissions on the account. It also needs Access: Apps and Policies when you use Access, or Email Sending and DNS when you use `EMAIL_ZONE_ID`.

References: [Foldkit](https://foldkit.dev), [Effect](https://effect.website), [Alchemy](https://alchemy.run), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [OpenRouter API](https://openrouter.ai/docs/quickstart).
