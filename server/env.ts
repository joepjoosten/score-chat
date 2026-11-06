import type { Converter, ConversionMessage } from './conversions.ts'
import type { DocumentAgent } from './DocumentAgent.ts'

/** Bindings of the Score Chat Worker, declared in alchemy.run.ts. */
export interface Env {
  /** The built client: index.html, the renderer worker, its data and fonts, and the docs. */
  ASSETS: Fetcher
  /** Users, sign-in links, sessions, agent settings and the document index. */
  DB: D1Database
  DOCUMENT_AGENT: DurableObjectNamespace<DocumentAgent>
  /** Sends sign-in links. */
  MAILER: SendEmail
  /** Sender address of sign-in links, on a domain set up for Cloudflare Email Service. */
  EMAIL_FROM: string
  /**
   * The Zero Trust team domain, e.g. `acme.cloudflareaccess.com`. When set,
   * people sign in through Cloudflare Access instead of emailed links.
   */
  ACCESS_TEAM_DOMAIN: string
  /** The Access application's audience tag, checked when set. */
  ACCESS_AUD: string
  /** Encrypts the users' OpenRouter keys at rest. Keep it stable and backed up. */
  KEY_ENCRYPTION_SECRET: string
  /** OpenRouter's API URL, replaced in tests; empty for the real one. */
  OPENROUTER_URL: string
  /** PDFs waiting to be converted. */
  CONVERSION_UPLOADS: R2Bucket
  CONVERSION_QUEUE: Queue<ConversionMessage>
  /** The converter container; absent when no CONVERTER_IMAGE is deployed. */
  CONVERTER?: DurableObjectNamespace<Converter>
  /** A converter to call instead of the container: a test stand-in, or one run locally. */
  CONVERTER_URL: string
  /** Set by Alchemy: the stage, e.g. `prod` or `dev_joep`. */
  ALCHEMY_STAGE?: string
}
