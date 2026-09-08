import type { Env } from "./env";
import { required, supabaseKey } from "./env";

export type AutomationRuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  networks: string[];
  channels: string[];
  keyword: string;
  category: string | null;
  min_commission: number | null;
  min_discount: number | null;
  max_price: number | null;
  quantity: number;
  sort: "commission" | "price" | "sales" | "discount" | null;
  avoid_repeat_days: number;
  schedule_cron: string | null;
  timezone: string;
  dry_run: boolean;
  settings: Record<string, unknown>;
};

export type PublicationQueueRow = {
  id: string;
  run_id: string | null;
  rule_id: string | null;
  offer_key: string;
  network: string;
  offer_id: string;
  channel: string;
  status: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  content: Record<string, unknown>;
  offer_snapshot: Record<string, unknown>;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  prefer?: string;
};

export class SupabaseRest {
  private readonly baseUrl: string;
  private readonly key: string;

  constructor(env: Env) {
    this.baseUrl = required(env.SUPABASE_URL, "SUPABASE_URL").replace(/\/$/, "");
    this.key = supabaseKey(env);
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      apikey: this.key,
      "content-type": "application/json",
    };

    // Legacy service_role keys are JWTs. New sb_secret_* keys must use apikey, not Bearer.
    if (!this.key.startsWith("sb_secret_")) {
      headers.Authorization = `Bearer ${this.key}`;
    }
    if (options.prefer) headers.Prefer = options.prefer;

    const response = await fetch(`${this.baseUrl}/rest/v1/${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(`SUPABASE_HTTP_${response.status}: ${message.slice(0, 600)}`);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  select<T>(table: string, query: URLSearchParams) {
    return this.request<T[]>(`${table}?${query.toString()}`);
  }

  insert<T>(table: string, body: unknown, prefer = "return=representation") {
    return this.request<T[]>(table, { method: "POST", body, prefer });
  }

  update<T>(table: string, filters: URLSearchParams, body: unknown) {
    return this.request<T[]>(`${table}?${filters.toString()}`, {
      method: "PATCH",
      body,
      prefer: "return=representation",
    });
  }

  rpc<T>(name: string, args: Record<string, unknown>) {
    return this.request<T>(`rpc/${name}`, { method: "POST", body: args });
  }
}

export function eq(value: string) {
  return `eq.${value}`;
}
