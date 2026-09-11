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
      import { parseSvgFontManifest } from './src/fonts/glyphs.ts';
      import { renderLySourceToSvg } from './src/render/ly-to-svg.ts';
      const fontManifest = parseSvgFontManifest(font);
      self.onmessage = ({ data: { id, source } }) => {
        try {
          const result = renderLySourceToSvg(source, { file: 'score.ly', fontManifest });
          const errors = result.diagnostics.filter(d => d.severity === 'error').map(d => d.message);
          const pages = result.render?.assembly.renderedPages.map(p => p.svg) ?? (result.svg ? [result.svg] : []);
          self.postMessage({ id, pages, errors });
        } catch (error) {
          self.postMessage({ id, pages: [], errors: [String(error)] });
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
