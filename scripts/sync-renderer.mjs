import { build } from 'esbuild'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

// `--debug` builds a readable worker with a source map for local inspection.
// Run the sync again without it before committing.
// `--fonts=<lilyjazz checkout>` refreshes the optional jazz fonts; without it
// the fonts already in public/renderer/fonts are kept.
const args = process.argv.slice(2)
const debug = args.includes('--debug')
const fontSource = args.find((arg) => arg.startsWith('--fonts='))?.slice(8)
const root = resolve(
  args.find((arg) => !arg.startsWith('--')) ??
    `${homedir()}/development/github/lilypond-typescript`,
)
const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const dirty = execFileSync(
  'git',
  ['-C', root, '-c', 'core.fsmonitor=false', 'status', '--porcelain'],
  { encoding: 'utf8' },
).trim()
if (dirty)
  throw new Error(
    'Commit renderer changes before syncing a reproducible browser bundle.',
  )
await mkdir('public/renderer', { recursive: true })
// Font and engraving tables load separately from the worker code, so the
// browser can cache them independently of renderer updates.
await rm('public/renderer/data', { recursive: true, force: true })
await mkdir('public/renderer/data')
for (const file of await readdir(resolve(root, 'assets/data')))
  if (file.endsWith('.json'))
    await copyFile(
      resolve(root, 'assets/data', file),
      `public/renderer/data/${file}`,
    )
await copyFile(
  resolve(root, 'assets/fonts/LICENSE.OFL'),
  'public/renderer/LICENSE.OFL',
)
// Optional fonts are fetched by the worker only when a score selects them
// (renderJustInTime), one optical size or text font at a time.
const fontsDir = 'public/renderer/fonts'
if (fontSource) {
  const source = resolve(fontSource)
  await rm(fontsDir, { recursive: true, force: true })
  await mkdir(`${fontsDir}/lilyjazz`, { recursive: true })
  for (const kind of ['svg', 'otf'])
    for (const file of await readdir(join(source, kind)))
      if (/^lilyjazz-(\d+|brace)\.(svg|otf)$/.test(file))
        await copyFile(join(source, kind, file), `${fontsDir}/lilyjazz/${file}`)
  for (const text of ['lilyjazz-text', 'lilyjazz-chord']) {
    await copyFile(
      join(source, 'supplementary-files', text, `${text}.otf`),
      `${fontsDir}/lilyjazz/${text}.otf`,
    )
    for (const notice of ['OFL.txt', 'FONTLOG.txt'])
      await copyFile(
        join(source, 'supplementary-files', text, notice),
        `${fontsDir}/lilyjazz/${text}-${notice}`,
      )
  }
  for (const file of ['LICENSE', 'FONTLOG.txt'])
    await copyFile(join(source, file), `${fontsDir}/lilyjazz/${file}`)
  await mkdir(`${fontsDir}/lilyjazz/stylesheet`)
  for (const file of await readdir(join(source, 'stylesheet')))
    if (file.endsWith('.ily'))
      await copyFile(
        join(source, 'stylesheet', file),
        `${fontsDir}/lilyjazz/stylesheet/${file}`,
      )
  const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  await writeFile(
    `${fontsDir}/lilyjazz/version.json`,
    JSON.stringify(
      { repository: 'OpenLilyPondFonts/lilyjazz', revision },
      null,
      2,
    ) + '\n',
  )
}
// What the worker may load on demand, read from the synced files.
const catalog = { music: {}, text: [], includes: {} }
if (existsSync(`${fontsDir}/lilyjazz`)) {
  const files = await readdir(`${fontsDir}/lilyjazz`)
  const parts = files
    .map((file) => /^lilyjazz-(\d+|brace)\.otf$/.exec(file)?.[1])
    .filter((part) => part && files.includes(`lilyjazz-${part}.svg`))
  if (parts.includes('20')) catalog.music.lilyjazz = parts
  for (const text of ['lilyjazz-text', 'lilyjazz-chord'])
    if (files.includes(`${text}.otf`)) catalog.text.push(text)
  for (const file of await readdir(`${fontsDir}/lilyjazz/stylesheet`).catch(
    () => [],
  ))
    catalog.includes[file] = `fonts/lilyjazz/stylesheet/${file}`
}
await copyFile(
  resolve(root, 'lilypond-2.24.4/COPYING'),
  'public/renderer/COPYING',
)
await build({
  stdin: {
    contents: `
      import font from './assets/fonts/emmentaler-20.svg';
      import { lazyPinnedEmmentalerManifest } from './src/fonts/glyphs.ts';
      import { renderLySourceToSvg } from './src/render/ly-to-svg.ts';
      import { renderJustInTime, loadRendererDataTables, EMMENTALER_GLYPH_TABLES } from './src/render/just-in-time.ts';
      import { declareMusicFont } from './src/fonts/music-font.ts';
      import { declareTextFont } from './src/fonts/text-font.ts';
      import { pointAndClickLinker } from './src/render/point-and-click.ts';
      import { iterateSourcePerformances, performSourceMusic } from './src/performance/index.ts';
      import { momentDuration, performanceTicks } from './src/performance/time.ts';
      import { errorSpan } from './src/core/error-span.ts';
      // Where in the score an error is; null outside it (an \\include) or when unknown.
      const position = (span) =>
        span && span.file === 'score.ly'
          ? { line: span.startLine, column: span.startColumn, endLine: span.endLine, endColumn: span.endColumn }
          : null;
      // Renderer data, fonts and stylesheets come from the page, which fetches
      // each file once and hands it to every worker, so replacing a cancelled
      // worker downloads nothing again. Nothing is fetched up front: a render
      // asks for exactly the tables, font sizes and includes it reads
      // (renderJustInTime) and runs again until it has them all.
      const catalog = CATALOG;
      for (const [name, parts] of Object.entries(catalog.music)) declareMusicFont(name, parts);
      for (const name of catalog.text) declareTextFont(name);
      const pending = new Map();
      let nextAsset = 0;
      const asset = (path, binary) => new Promise((resolve, reject) => {
        const request = ++nextAsset;
        pending.set(request, { resolve, reject });
        self.postMessage({ type: 'asset', request, path, binary });
      });
      const fontPart = (name, part) => Promise.all([
        asset('fonts/' + name + '/' + name + '-' + part + '.svg', false),
        asset('fonts/' + name + '/' + name + '-' + part + '.otf', true),
      ]).then(([svg, otf]) => ({ svg, otf: new Uint8Array(otf) }));
      const loader = {
        rendererData: (file) => asset('data/' + file, false).then(JSON.parse),
        musicFontPart: fontPart,
        textFont: (name) => {
          const owner = Object.keys(catalog.music).find((family) => name.startsWith(family)) ?? name;
          return asset('fonts/' + owner + '/' + name + '.otf', true).then((bytes) => new Uint8Array(bytes));
        },
      };
      // Stylesheets a score may \\include (e.g. lilyjazz.ily), loaded the same way.
      const includes = new Map();
      const missingIncludes = new Set();
      const includeResolver = (name) => {
        const base = name.replace(/^.*\\//, '');
        if (includes.has(base)) return { file: base, source: includes.get(base) };
        if (catalog.includes[base]) missingIncludes.add(base);
        return undefined;
      };
      const fontManifest = lazyPinnedEmmentalerManifest(font);
      // Every parse reads the grob defaults, and a score that selects no other
      // music font draws Emmentaler: fetch those with the request rather than
      // discovering each in a render of its own. Everything else is on demand.
      const OTHER_MUSIC_FONT = /#:music\\s+"(?!emmentaler")/;
      const justInTime = async (run, source, engraves) => {
        for (;;) {
          missingIncludes.clear();
          const text = [source, ...includes.values()].join('\\n');
          await loadRendererDataTables(['nativeGrobDefaults',
            ...(engraves && !OTHER_MUSIC_FONT.test(text) ? EMMENTALER_GLYPH_TABLES : [])], loader);
          const { value } = await renderJustInTime(run, loader);
          if (!missingIncludes.size) return value;
          await Promise.all([...missingIncludes].map(async (base) =>
            includes.set(base, await asset(catalog.includes[base], false))));
        }
      };
      const SYSTEM_GROUP = /data-system-id="(system-\\d+)" transform="translate\\(([-\\d.e]+) ([-\\d.e]+)\\)"/g;
      // Page-space boxes of every printed element that LilyPond's point-and-click
      // links to a music event (notes, rests, articulations, dynamics, slurs, ...),
      // keyed to that event's source span, so the app can map a highlighted region
      // of the page back to the source. Layout placements are relative to their
      // system; the system's page offset is the translate on its group in the page SVG.
      const collectAnchors = (result, pages, source) => {
        const render = result.render;
        const graph = result.result?.graph;
        if (!render || !graph) return [];
        // Always on: the selection tool needs every element's source event, whatever
        // \\pointAndClickOff or \\pointAndClickTypes the score itself sets.
        const linked = pointAndClickLinker({ setting: true, source, file: 'score.ly' });
        const grobs = new Map(graph.grobs.map((grob) => [grob.id, grob]));
        const systems = new Map();
        pages.forEach((svg, page) => {
          for (const match of svg.matchAll(SYSTEM_GROUP))
            systems.set(match[1], { page, x: Number(match[2]), y: Number(match[3]) });
        });
        const anchors = [];
        render.layouts.forEach((layout, index) => {
          const system = systems.get('system-' + (index + 1));
          if (!system) return;
          for (const placement of layout.placements) {
            // A spanner broken across systems keeps its original grob's cause.
            const grob = grobs.get(placement.grobId)
              ?? grobs.get(placement.grobId.replace(/:broken:[^:]*$/, ''));
            if (!grob || !linked(grob)) continue;
            const origin = grob.causeEvent.origin;
            const { x, y } = placement.stencil.extent;
            // Empty stencils (e.g. a C major key signature) have nothing to swipe.
            if (!(x.max > x.min && y.max > y.min)) continue;
            anchors.push({
              kind: grob.name,
              page: system.page,
              system: index,
              x: system.x + placement.x + x.min,
              y: system.y + placement.y + y.min,
              width: x.max - x.min,
              height: y.max - y.min,
              line: origin.startLine,
              column: origin.startColumn,
              endLine: origin.endLine,
              endColumn: origin.endColumn,
            });
          }
        });
        return anchors;
      };
      // Seconds at a MIDI tick, following the tempo changes of every track.
      const midiClock = (performance) => {
        const tempos = performance.tracks.flat()
          .filter((event) => event.status === 255 && event.type === 81)
          .map((event) => ({
            tick: event.tick,
            perTick: ((event.data[0] << 16) | (event.data[1] << 8) | event.data[2]) / 1e6 / performance.division,
          }))
          .sort((a, b) => a.tick - b.tick);
        return (tick) => {
          let seconds = 0, at = 0, perTick = 0.5 / performance.division;
          for (const tempo of tempos) {
            if (tempo.tick > tick) break;
            seconds += (tempo.tick - at) * perTick;
            at = tempo.tick;
            perTick = tempo.perTick;
          }
          return seconds + (tick - at) * perTick;
        };
      };
      // Performs every score that requests MIDI, one after another. Notes are the
      // sounding MIDI notes; cues are the source events of the notes, so the app
      // can light up the printed note heads while they sound.
      const performScore = (source) => {
        const notes = [], cues = [];
        let start = 0;
        for (const input of iterateSourcePerformances(source, { file: 'score.ly', includeResolver })) {
          const performance = performSourceMusic(input);
          const seconds = midiClock(performance);
          let end = 0;
          for (const track of performance.tracks) {
            const sounding = new Map();
            for (const event of track) {
              end = Math.max(end, seconds(event.tick));
              const kind = event.status & 0xf0, channel = event.status & 15;
              if (kind !== 0x90 && kind !== 0x80) continue;
              const key = channel * 128 + event.data[0];
              if (kind === 0x90 && event.data[1] > 0) {
                sounding.set(key, event);
                continue;
              }
              const on = sounding.get(key);
              if (!on) continue;
              sounding.delete(key);
              const time = seconds(on.tick);
              notes.push({ time: start + time, duration: seconds(event.tick) - time, pitch: event.data[0], velocity: on.data[1], channel });
            }
          }
          // The MIDI tracks start at the first event; shift source moments the same way.
          const events = performance.source.events;
          const offset = Math.min(0, events[0] ? performanceTicks(events[0].moment) : 0);
          for (const event of events) {
            const { music } = event, origin = music.origin, duration = music.properties.duration;
            if (music.type !== 'NoteEvent' || !duration || origin?.file !== 'score.ly') continue;
            if (event.settings['midi-remove.Note_performer'] === true) continue;
            const tick = performanceTicks(event.moment) - offset;
            const length = performanceTicks(momentDuration(duration, music.properties.grace === true));
            cues.push({ time: start + seconds(tick), end: start + seconds(tick + length), line: origin.startLine, column: origin.startColumn });
          }
          start += end + 1;
        }
        notes.sort((a, b) => a.time - b.time);
        cues.sort((a, b) => a.time - b.time);
        return { notes, cues, duration: Math.max(0, start - 1) };
      };
      self.onmessage = async ({ data }) => {
        if (data.type === 'asset') {
          const file = pending.get(data.request);
          pending.delete(data.request);
          if (data.error) file?.reject(new Error(data.error));
          else file?.resolve(data.content);
          return;
        }
        const { id, source } = data;
        if (data.type === 'perform') {
          try {
            self.postMessage({ id, performance: await justInTime(() => performScore(source), source, false) });
          } catch (error) {
            self.postMessage({ id, error: error instanceof Error ? error.message : String(error), position: position(errorSpan(error)) });
          }
          return;
        }
        try {
          const result = await justInTime(() => renderLySourceToSvg(source, { file: 'score.ly', fontManifest, includeResolver }), source, true);
          const failures = result.diagnostics.filter(d => d.severity === 'error');
          const errors = failures.map(d => d.message);
          const positions = failures.map(d => position(d.span));
          const pages = result.render?.assembly.renderedPages.map(p => p.svg) ?? (result.svg ? [result.svg] : []);
          self.postMessage({ id, pages, errors, positions, anchors: collectAnchors(result, pages, source) });
        } catch (error) {
          self.postMessage({ id, pages: [], errors: [String(error)], positions: [position(errorSpan(error))], anchors: [] });
        }
      };
    `,
    resolveDir: root,
    sourcefile: 'score-chat-renderer.ts',
    loader: 'ts',
  },
  outfile: 'public/renderer/worker.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: !debug,
  sourcemap: debug ? 'linked' : false,
  legalComments: 'eof',
  loader: { '.svg': 'text' },
  define: { CATALOG: JSON.stringify(catalog) },
})
// The server's check: the renderer's checker (src/check/classify.ts, as used
// by its --check) over the same parser and music interpretation as the
// browser render, without engraving or layout. The Durable Object can then
// reject an edit with a category and often a did-you-mean hint, without the
// fonts and layout tables. Renderer data, fonts and stylesheets come through
// the host's `asset` function, just in time, like the browser worker.
await mkdir('server/renderer', { recursive: true })
await build({
  stdin: {
    contents: `
      import { runV2BookOwnershipPipeline, V2PipelineError } from './src/v2/index.ts';
      import { parseLilyPond } from './src/frontend/parser/index.ts';
      import { renderJustInTime, loadRendererDataTables } from './src/render/just-in-time.ts';
      import { declareMusicFont } from './src/fonts/music-font.ts';
      import { declareTextFont } from './src/fonts/text-font.ts';
      import { errorSpan } from './src/core/error-span.ts';
      import { classifyDiagnostic, documentIdentifiers, SUPPORTED_VERSION, versionSpan } from './src/check/classify.ts';
      const FILE = 'score.ly';
      const position = (span) =>
        span && span.file === FILE
          ? { line: span.startLine, column: span.startColumn, endLine: span.endLine, endColumn: span.endColumn }
          : null;
      const catalog = CATALOG;
      for (const [name, parts] of Object.entries(catalog.music)) declareMusicFont(name, parts);
      for (const name of catalog.text) declareTextFont(name);
      // Stylesheets a score may \\include (e.g. lilyjazz.ily), kept once loaded.
      const includes = new Map();
      const loaderFor = (asset) => ({
        rendererData: (file) => asset('data/' + file, false).then(JSON.parse),
        musicFontPart: (name, part) => Promise.all([
          asset('fonts/' + name + '/' + name + '-' + part + '.svg', false),
          asset('fonts/' + name + '/' + name + '-' + part + '.otf', true),
        ]).then(([svg, otf]) => ({ svg, otf: new Uint8Array(otf) })),
        textFont: (name) => {
          const owner = Object.keys(catalog.music).find((family) => name.startsWith(family)) ?? name;
          return asset('fonts/' + owner + '/' + name + '.otf', true).then((bytes) => new Uint8Array(bytes));
        },
      });
      const contextFor = (source) => ({
        sourceText: (file) => (file === FILE ? source : includes.get(file)),
        userIdentifiers: documentIdentifiers(source),
        hasIncludes: /\\\\include\\s*"/u.test(source),
        file: FILE,
      });
      const shape = (diagnostic) => ({
        severity: diagnostic.severity,
        category: diagnostic.category,
        message: diagnostic.message,
        ...(diagnostic.hint ? { hint: diagnostic.hint } : {}),
        position: position(diagnostic.span),
      });
      const result = (diagnostics) => ({
        ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
        diagnostics: diagnostics.map(shape),
      });
      const errorDiagnostic = (error) => {
        const span = errorSpan(error);
        return {
          severity: 'error',
          message: error instanceof V2PipelineError
            ? 'V2 renderer ' + error.message
            : 'V2 renderer failed: ' + (error instanceof Error ? error.message : String(error)),
          ...(span ? { span } : {}),
        };
      };
      /**
       * Checks a score like the renderer's --check, but stops before engraving:
       * parse errors (the first one, as later ones are often noise), a wrong
       * \\version (the rest is still checked as if it were right), and what
       * the music interpretation rejects, each classified as syntax, invalid,
       * unsupported or unclassified, often with a hint. \`asset(path, binary)\`
       * returns a file below public/renderer/ as text or an ArrayBuffer.
       */
      export async function checkScore(source, asset) {
        const loader = loaderFor(asset);
        await loadRendererDataTables(['nativeGrobDefaults'], loader);
        for (;;) {
          const missing = new Set();
          const includeResolver = (name) => {
            const base = name.replace(/^.*\\//, '');
            if (includes.has(base)) return { file: base, source: includes.get(base) };
            if (catalog.includes[base]) missing.add(base);
            return undefined;
          };
          const { value: diagnostics } = await renderJustInTime(() => {
            const context = contextFor(source);
            const found = [];
            const seen = new Set();
            const add = (diagnostic) => {
              const key = diagnostic.severity + '|' + diagnostic.message + '|' + JSON.stringify(diagnostic.span ?? null);
              if (!seen.has(key)) { seen.add(key); found.push(classifyDiagnostic(diagnostic, context)); }
            };
            let parsed;
            try {
              parsed = parseLilyPond(source, { file: FILE, includeResolver });
            } catch (error) {
              add(errorDiagnostic(error));
              return found;
            }
            const first = parsed.diagnostics.findIndex((diagnostic) => diagnostic.severity === 'error');
            for (const diagnostic of first < 0 ? parsed.diagnostics : parsed.diagnostics.slice(0, first + 1)) add(diagnostic);
            let checked = source;
            if (parsed.version !== SUPPORTED_VERSION) {
              const span = versionSpan(source, FILE);
              found.push({
                severity: 'error',
                category: 'unsupported',
                message: parsed.version === undefined
                  ? 'No \\\\version statement; this renderer requires \\\\version "' + SUPPORTED_VERSION + '".'
                  : '\\\\version "' + parsed.version + '" is not supported; this renderer requires \\\\version "' + SUPPORTED_VERSION + '".',
                hint: parsed.version === undefined
                  ? 'Add \\\\version "' + SUPPORTED_VERSION + '" as the first line.'
                  : 'Change it to \\\\version "' + SUPPORTED_VERSION + '".',
                ...(span ? { span } : {}),
              });
              checked = span
                ? source.replace(/(\\\\version\\s*")[^"]*"/u, '$1' + SUPPORTED_VERSION + '"')
                : source + '\\n\\\\version "' + SUPPORTED_VERSION + '"\\n';
            }
            if (first >= 0) return found;
            try {
              runV2BookOwnershipPipeline(checked, { file: FILE, includeResolver });
            } catch (error) {
              // A missing table makes the run throw; renderJustInTime loads it and runs again.
              if (error?.name === 'RendererDataNotLoadedError') throw error;
              add(errorDiagnostic(error));
            }
            return found;
          }, loader);
          if (!missing.size) return result(diagnostics);
          await Promise.all([...missing].map(async (base) =>
            includes.set(base, await asset(catalog.includes[base], false))));
        }
      }
      /** Classifies errors the browser's full render reported, e.g. while engraving. */
      export function classifyErrors(source, errors, positions = []) {
        const context = contextFor(source);
        return result(errors.map((message, index) => {
          const at = positions[index];
          const span = at ? { file: FILE, startLine: at.line, startColumn: at.column, endLine: at.endLine, endColumn: at.endColumn } : undefined;
          return classifyDiagnostic({ severity: 'error', message, ...(span ? { span } : {}) }, context);
        }));
      }
    `,
    resolveDir: root,
    sourcefile: 'score-chat-check.ts',
    loader: 'ts',
  },
  outfile: 'server/renderer/check.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: !debug,
  legalComments: 'eof',
  define: { CATALOG: JSON.stringify(catalog) },
})
await writeFile(
  'server/renderer/check.d.ts',
  `/** Generated by scripts/sync-renderer.mjs. */
export interface CheckPosition {
  line: number
  column: number
  endLine: number
  endColumn: number
}
/**
 * What to do about a problem: fix the source (\`syntax\`, \`invalid\`),
 * simplify valid LilyPond the renderer cannot handle yet (\`unsupported\`),
 * or judge for yourself (\`unclassified\`). Warnings don't block rendering.
 */
export type CheckCategory = 'syntax' | 'invalid' | 'unsupported' | 'unclassified' | 'warning'
export interface CheckDiagnostic {
  severity: 'error' | 'warning'
  category: CheckCategory
  message: string
  /** A concrete fix to try, such as a likely intended spelling. */
  hint?: string
  /** Where in the score, or null when it is elsewhere or unknown. */
  position: CheckPosition | null
}
export interface CheckResult {
  /** No errors: the score parses and every construct is supported. */
  ok: boolean
  diagnostics: CheckDiagnostic[]
}
/** Parses and interprets a score like the browser render, without engraving it. */
export function checkScore(
  source: string,
  asset: (path: string, binary: boolean) => Promise<string | ArrayBuffer>,
): Promise<CheckResult>
/** Classifies errors the browser's full render reported, e.g. while engraving. */
export function classifyErrors(
  source: string,
  errors: readonly string[],
  positions?: readonly (CheckPosition | null)[],
): CheckResult
`,
)
await writeFile(
  'public/renderer/version.json',
  JSON.stringify(
    { repository: 'joepjoosten/lilypond-typescript', revision },
    null,
    2,
  ) + '\n',
)
if (!debug) await rm('public/renderer/worker.js.map', { force: true })
console.log(`Bundled ${debug ? 'debug ' : ''}LilyPond renderer at ${revision}`)
