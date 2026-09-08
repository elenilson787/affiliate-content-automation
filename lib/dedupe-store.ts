import type { AffiliateNetwork, SocialChannel } from "./types";

export type PublicationRecord = {
  offerKey: string;
  network: AffiliateNetwork;
  offerId: string;
  channel: SocialChannel;
  externalId?: string;
  metadata?: Record<string, unknown>;
};

export interface DedupeStore {
  wasPublishedRecently(offerKey: string, channel: SocialChannel, days: number): Promise<boolean>;
  recordPublication(record: PublicationRecord): Promise<void>;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`SUPABASE_NOT_CONFIGURED: ${name}`);
  return value;
}

export class SupabaseDedupeStore implements DedupeStore {
  private readonly url: string;
  private readonly key: string;

  constructor(input?: { url?: string; serviceRoleKey?: string }) {
    this.url = (input?.url || process.env.SUPABASE_URL || "").replace(/\/$/, "") || requiredEnv("SUPABASE_URL");
    this.key = input?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(`SUPABASE_DEDUPE_ERROR: HTTP ${response.status}${message ? ` - ${message.slice(0, 300)}` : ""}`);
    }

    return response;
  }

  async wasPublishedRecently(offerKey: string, channel: SocialChannel, days: number) {
    if (days <= 0) return false;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      select: "id",
      offer_key: `eq.${offerKey}`,
      channel: `eq.${channel}`,
      published_at: `gte.${cutoff}`,
      limit: "1",
    });

    const response = await this.request(`published_offers?${params.toString()}`, { method: "GET" });
    const rows = await response.json() as unknown[];
    return rows.length > 0;
  }

  async recordPublication(record: PublicationRecord) {
    await this.request("published_offers", {
      method: "POST",
      headers: {
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({
        offer_key: record.offerKey,
        network: record.network,
        offer_id: record.offerId,
        channel: record.channel,
        external_id: record.externalId || null,
        metadata: record.metadata || {},
      }),
    });
  }
}

export function createSupabaseDedupeStore() {
  return new SupabaseDedupeStore();
}
