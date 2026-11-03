import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { foldkit } from '@foldkit/vite-plugin'

const client = fileURLToPath(new URL('./src/', import.meta.url))

/**
 * Foldkit brands the returns of view functions in every module Vite builds.
 * Alchemy builds the Worker with the same config, so keep the transform to
 * the client: server code needs no view identity, and it breaks the
 * minified renderer check.
 */
function clientOnly(plugins: Plugin[]): Plugin[] {
  return plugins.map((plugin) => {
    const transform = plugin.transform
    if (
      plugin.name !== 'foldkit:view-identity' ||
      typeof transform !== 'function'
    )
      return plugin
    return {
      ...plugin,
      transform(code, id, options) {
        return id.startsWith(client)
          ? transform.call(this, code, id, options)
          : null
      },
    }
  })
}

export default defineConfig({
  plugins: clientOnly(foldkit()),
  optimizeDeps: { entries: ['src/entry.ts'] },
  // Alchemy's local state and simulated email live in .alchemy/.
  server: { watch: { ignored: ['**/.alchemy/**'] } },
})
