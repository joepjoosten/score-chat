import { build } from 'esbuild'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

const root = resolve(
  process.argv[2] ?? `${homedir()}/development/github/lilypond-typescript`,
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
      const fontManifest = withPinnedEmmentalerMetrics(parseSvgFontManifest(font));
      const SYSTEM_GROUP = /data-system-id="(system-\\d+)" transform="translate\\(([-\\d.e]+) ([-\\d.e]+)\\)"/g;
      // Page-space boxes of note heads and rests, keyed to their source spans, so the
      // app can map a highlighted region of the page back to notes in the source.
      // Layout placements are relative to their system; the system's page offset is
      // the translate on its group in the page SVG.
      const collectAnchors = (result, pages) => {
        const render = result.render;
        const graph = result.result?.graph;
        if (!render || !graph) return [];
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
            const grob = grobs.get(placement.grobId);
            const origin = grob?.origin;
            if (!origin || (grob.name !== 'NoteHead' && grob.name !== 'Rest')) continue;
            const { x, y } = placement.stencil.extent;
            anchors.push({
              kind: grob.name === 'Rest' ? 'rest' : 'note',
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
      self.onmessage = ({ data: { id, source } }) => {
        try {
          const result = renderLySourceToSvg(source, { file: 'score.ly', fontManifest });
          const errors = result.diagnostics.filter(d => d.severity === 'error').map(d => d.message);
          const pages = result.render?.assembly.renderedPages.map(p => p.svg) ?? (result.svg ? [result.svg] : []);
          self.postMessage({ id, pages, errors, anchors: collectAnchors(result, pages) });
        } catch (error) {
          self.postMessage({ id, pages: [], errors: [String(error)], anchors: [] });
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
  minify: true,
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
console.log(`Bundled LilyPond renderer at ${revision}`)
