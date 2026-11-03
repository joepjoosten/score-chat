import { startOpenRouter } from './openrouter.ts'

/** Starts the OpenRouter stand-in for the whole run; Playwright calls the returned teardown. */
export default async function globalSetup() {
  const server = await startOpenRouter()
  return () => new Promise<void>((resolve) => server.close(() => resolve()))
}
