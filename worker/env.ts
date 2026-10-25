/// <reference types="@cloudflare/workers-types" />

export interface Env {
  /** Durable Object namespace that owns the authoritative canvas */
  CANVAS: DurableObjectNamespace;
  /** Static front-end build (Vite output), present on the Worker deployment */
  ASSETS?: Fetcher;
  /** Optional R2 bucket used for scheduled backups */
  BACKUP_BUCKET?: R2Bucket;
  /** HMAC secret used to sign anonymous session cookies */
  SESSION_SECRET: string;
  /** Admin token. When unset, the admin panel is disabled entirely. */
  ADMIN_TOKEN?: string;
  /** Comma separated list of extra origins allowed to call the API */
  ALLOWED_ORIGINS?: string;
  /** Set to "1" to include error messages in 500 responses (debugging only) */
  DEBUG_ERRORS?: string;
  /** Canvas configuration (all optional, sensible defaults apply) */
  CANVAS_WIDTH?: string;
  CANVAS_HEIGHT?: string;
  CANVAS_NAME?: string;
  CANVAS_PALETTE?: string;
  COOLDOWN_SECONDS?: string;
}
