export interface Env {
  SHOPEE_APP_ID?: string;
  SHOPEE_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AUTOMATION_SECRET?: string;
  WORKER_BATCH_SIZE?: string;
  WORKER_MAX_BATCHES?: string;
  PUBLISH_DELAY_MS?: string;
  DEFAULT_TIMEZONE?: string;
}

export function required(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`MISSING_ENV: ${name}`);
  return value.trim();
}

export function supabaseKey(env: Env) {
  return required(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SECRET_KEY");
}

export function boundedInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
