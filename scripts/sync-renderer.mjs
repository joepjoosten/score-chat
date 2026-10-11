import { build } from 'esbuild'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

// `--debug` builds a readable worker with a source map for local inspection.
// Run the sync again without it before committing.
const args = process.argv.slice(2)
const debug = args.includes('--debug')
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
await copyFile(
  resolve(root, 'lilypond-2.24.4/COPYING'),
  'public/renderer/COPYING',
)
await build({
  stdin: {
    contents: `
      import font from './assets/fonts/emmentaler-20.svg';
      import { parseSvgFontManifest, withPinnedEmmentalerMetrics } from './src/fonts/glyphs.ts';
      import { renderLySourceToSvg } from './src/render/ly-to-svg.ts';
      import { loadRendererData } from './src/data/renderer-data.ts';
      import { pointAndClickLinker } from './src/render/point-and-click.ts';
      import { iterateSourcePerformances, performSourceMusic } from './src/performance/index.ts';
      import { momentDuration, performanceTicks } from './src/performance/time.ts';
      import { errorSpan } from './src/core/error-span.ts';
      // Where in the score an error is; null outside it (an \\include) or when unknown.
      const position = (span) =>
        span && span.file === 'score.ly'
          ? { line: span.startLine, column: span.startColumn, endLine: span.endLine, endColumn: span.endColumn }
          : null;
      // Data files come from the page, which fetches each one once and hands it
      // to every worker, so replacing a cancelled worker downloads nothing again.
      const files = new Map();
      const readFile = (name) => new Promise((resolve, reject) => {
        files.set(name, { resolve, reject });
        self.postMessage({ type: 'data', name });
      });
      const ready = loadRendererData(readFile)
        .then(() => withPinnedEmmentalerMetrics(parseSvgFontManifest(font)));
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
        for (const input of iterateSourcePerformances(source, { file: 'score.ly' })) {
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
        if (data.type === 'data') {
          const file = files.get(data.name);
          files.delete(data.name);
          if (data.error) file?.reject(new Error(data.error));
          else file?.resolve(JSON.parse(data.text));
          return;
        }
        const { id, source } = data;
        if (data.type === 'perform') {
          try {
            await ready;
            self.postMessage({ id, performance: performScore(source) });
          } catch (error) {
            self.postMessage({ id, error: error instanceof Error ? error.message : String(error), position: position(errorSpan(error)) });
          }
          return;
        }
        try {
          const fontManifest = await ready;
          const result = renderLySourceToSvg(source, { file: 'score.ly', fontManifest });
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
})
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
