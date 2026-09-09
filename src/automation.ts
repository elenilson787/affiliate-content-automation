import { createShopeeProvider } from "../lib/affiliate/shopee/adapter";
import { generateContent, type ContentTemplate } from "../lib/content-engine";
import { offerKey } from "../lib/offer-engine";
import { createTelegramPublisher } from "../lib/publishers/telegram";
import { searchQualifiedOffers } from "../lib/search-engine";
import type { GeneratedContent, Offer } from "../lib/types";
import { findDueSlot, stableUuid } from "./cron";
import { SupabaseRest, eq, type AutomationRuleRow, type PublicationQueueRow } from "./db";
import { boundedInt, required, type Env } from "./env";

const SCHEDULER_LOOKBACK_MINUTES = 5;

type RuleExecutionResult = {
  ruleId: string;
  runId?: string;
  slot?: string;
  status: "queued" | "dry_run" | "duplicate_run" | "failed";
  selected?: number;
  queued?: number;
  skipped?: number;
  error?: string;
};

type QueueInsert = {
  run_id: string;
  rule_id: string;
  offer_key: string;
  network: string;
  offer_id: string;
  channel: string;
  status: "pending" | "skipped_duplicate";
  priority: number;
  scheduled_for: string;
  available_at: string;
  max_attempts: number;
  idempotency_key: string;
  content: GeneratedContent;
  offer_snapshot: Offer;
};

function numberSetting(settings: Record<string, unknown>, key: string, fallback: number, min: number, max: number) {
  const raw = settings[key];
  const value = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function contentOptions(settings: Record<string, unknown>) {
  const rawTemplate = typeof settings.contentTemplate === "string" ? settings.contentTemplate : "offer";
  const template: ContentTemplate = ["offer", "natural", "storytelling", "no_price"].includes(rawTemplate)
    ? rawTemplate as ContentTemplate
    : "offer";
  const threadRaw = Number(settings.telegramThreadId);
  const messageThreadId = Number.isInteger(threadRaw) && threadRaw > 0 ? threadRaw : undefined;
  return { template, messageThreadId };
}

async function loadEnabledRules(db: SupabaseRest) {
  const params = new URLSearchParams({ select: "*", enabled: "eq.true", order: "created_at.asc" });
  return db.select<AutomationRuleRow>("automation_rules", params);
}

async function wasPublishedRecently(db: SupabaseRest, key: string, channel: string, days: number) {
  if (days <= 0) return false;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const params = new URLSearchParams({
    select: "id",
    offer_key: eq(key),
    channel: eq(channel),
    published_at: `gte.${cutoff}`,
    limit: "1",
  });
  const rows = await db.select<{ id: number }>("published_offers", params);
  return rows.length > 0;
}

async function updateRun(db: SupabaseRest, runId: string, patch: Record<string, unknown>) {
  await db.update("automation_runs", new URLSearchParams({ id: eq(runId) }), patch);
}

async function searchOffers(env: Env, rule: AutomationRuleRow, targetQuantity = rule.quantity) {
  const selected: Offer[] = [];
  const unsupportedNetworks: string[] = [];
  let scanned = 0;
  let pages = 0;

  for (const network of rule.networks) {
    if (network !== "shopee") {
      unsupportedNetworks.push(network);
      continue;
    }

    const provider = createShopeeProvider({
      appId: required(env.SHOPEE_APP_ID, "SHOPEE_APP_ID"),
      secret: required(env.SHOPEE_SECRET, "SHOPEE_SECRET"),
    });

    const result = await searchQualifiedOffers(
      provider,
      {
        keyword: rule.keyword,
        category: rule.category || undefined,
        minCommission: rule.min_commission ?? undefined,
        minDiscount: rule.min_discount ?? undefined,
        maxPrice: rule.max_price ?? undefined,
        sort: rule.sort || undefined,
      },
      targetQuantity,
      { maxPages: 3, pageSize: 50 },
    );

    selected.push(...result.selected);
    scanned += result.scanned;
    pages += result.pages;
  }

  const uniqueSelected = Array.from(new Map(selected.map((offer) => [offerKey(offer), offer])).values()).slice(0, targetQuantity);
  return { selected: uniqueSelected, unsupportedNetworks, scanned, pages };
}

async function executeRule(db: SupabaseRest, env: Env, rule: AutomationRuleRow, slot: Date, triggerSource: "scheduler" | "manual" = "scheduler"): Promise<RuleExecutionResult> {
  const slotIso = slot.toISOString();
  const runId = triggerSource === "scheduler" ? await stableUuid(`scheduler:${rule.id}:${slotIso}`) : crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const insertedRuns = await db.insert<{ id: string }>(
    "automation_runs",
    {
      id: runId,
      rule_id: rule.id,
      trigger_source: triggerSource,
      status: "running",
      dry_run: rule.dry_run,
      requested_count: rule.quantity,
      metadata: {
        ruleName: rule.name,
        scheduleCron: rule.schedule_cron,
        scheduleSlot: slotIso,
        timezone: rule.timezone,
        triggerSource,
      },
    },
    "resolution=ignore-duplicates,return=representation",
  );

  if (insertedRuns.length === 0) {
    return { ruleId: rule.id, runId, slot: slotIso, status: "duplicate_run" };
  }

  try {
    const candidateTarget = rule.dry_run ? rule.quantity : Math.min(Math.max(rule.quantity * 10, 20), 50);
    const { selected: candidates, unsupportedNetworks, scanned, pages } = await searchOffers(env, rule, candidateTarget);

    if (rule.dry_run) {
      const selected = candidates.slice(0, rule.quantity);
      const preview = selected.slice(0, 20).flatMap((offer) =>
        rule.channels.slice(0, 5).map((channel) => ({
          offerKey: offerKey(offer),
          channel,
          content: generateContent(offer, channel, contentOptions(rule.settings)),
        })),
      );

      await updateRun(db, runId, {
        status: "completed",
        selected_count: selected.length,
        queued_count: 0,
        skipped_count: 0,
        finished_at: new Date().toISOString(),
        metadata: {
          ruleName: rule.name,
          scheduleCron: rule.schedule_cron,
          scheduleSlot: slotIso,
          timezone: rule.timezone,
          triggerSource,
          unsupportedNetworks,
          searchScanned: scanned,
          searchPages: pages,
          dryRunPreview: preview,
        },
      });

      return { ruleId: rule.id, runId, slot: slotIso, status: "dry_run", selected: selected.length, queued: 0, skipped: 0 };
    }

    const priority = numberSetting(rule.settings, "priority", 100, 0, 32_767);
    const maxAttempts = numberSetting(rule.settings, "maxAttempts", 3, 1, 20);
    const queueRows: QueueInsert[] = [];
    const selected: Offer[] = [];
    let dedupeCandidatesSkipped = 0;

    for (const offer of candidates) {
      const key = offerKey(offer);
      const channelStates = await Promise.all(
        rule.channels.map(async (channel) => ({
          channel,
          duplicate: await wasPublishedRecently(db, key, channel, rule.avoid_repeat_days),
        })),
      );

      if (channelStates.length > 0 && channelStates.every((state) => state.duplicate)) {
        dedupeCandidatesSkipped += 1;
        continue;
      }

      selected.push(offer);
      for (const { channel, duplicate } of channelStates) {
        const content = generateContent(offer, channel, contentOptions(rule.settings));
        queueRows.push({
          run_id: runId,
          rule_id: rule.id,
          offer_key: key,
          network: offer.network,
          offer_id: offer.id,
          channel,
          status: duplicate ? "skipped_duplicate" : "pending",
          priority,
          scheduled_for: nowIso,
          available_at: nowIso,
          max_attempts: maxAttempts,
          idempotency_key: `${runId}:${key}:${channel}`,
          content,
          offer_snapshot: offer,
        });
      }

      if (selected.length >= rule.quantity) break;
    }

    const insertedQueue = queueRows.length
      ? await db.insert<PublicationQueueRow>("publication_queue", queueRows, "resolution=ignore-duplicates,return=representation")
      : [];
    const queued = insertedQueue.filter((row) => row.status === "pending").length;
    const insertedSkipped = insertedQueue.filter((row) => row.status === "skipped_duplicate").length;

    await updateRun(db, runId, {
      status: queued > 0 ? "running" : "completed",
      selected_count: selected.length,
      queued_count: queued,
      skipped_count: insertedSkipped,
      finished_at: queued > 0 ? null : new Date().toISOString(),
      metadata: {
        ruleName: rule.name,
        scheduleCron: rule.schedule_cron,
        scheduleSlot: slotIso,
        timezone: rule.timezone,
        triggerSource,
        unsupportedNetworks,
        searchScanned: scanned,
        searchPages: pages,
        candidateTarget,
        searchCandidates: candidates.length,
        dedupeCandidatesSkipped,
      },
    });

    return {
      ruleId: rule.id,
      runId,
      slot: slotIso,
      status: queued > 0 ? "queued" : "dry_run",
      selected: selected.length,
      queued,
      skipped: insertedSkipped + dedupeCandidatesSkipped,
    };
  } catch (error) {
    const errorMessage = message(error);
    await updateRun(db, runId, {
      status: "failed",
      error_message: errorMessage.slice(0, 4000),
      finished_at: new Date().toISOString(),
    }).catch(() => undefined);
    return { ruleId: rule.id, runId, slot: slotIso, status: "failed", error: errorMessage };
  }
}

export async function runRuleNow(env: Env, ruleId: string) {
  const db = new SupabaseRest(env);
  const rules = await db.select<AutomationRuleRow>(
    "automation_rules",
    new URLSearchParams({ select: "*", id: eq(ruleId), limit: "1" }),
  );
  if (!rules.length) throw new Error("AUTOMATION_RULE_NOT_FOUND");
  const execution = await executeRule(db, env, rules[0], new Date(), "manual");
  const worker = execution.status === "queued" ? await workerTick(env) : null;
  return { execution, worker };
}

export async function schedulerTick(env: Env, now = new Date()) {
  const db = new SupabaseRest(env);
  const rules = await loadEnabledRules(db);
  const results: RuleExecutionResult[] = [];

  for (const rule of rules) {
    if (!rule.schedule_cron?.trim()) continue;
    const timezone = rule.timezone || env.DEFAULT_TIMEZONE || "America/Sao_Paulo";
    const slot = findDueSlot(rule.schedule_cron, now, timezone, SCHEDULER_LOOKBACK_MINUTES);
    if (!slot) continue;
    results.push(await executeRule(db, env, rule, slot));
  }

  return {
    checkedRules: rules.length,
    dueRules: results.length,
    results,
  };
}

async function finalizeRun(db: SupabaseRest, runId: string) {
  const rows = await db.select<{ status: string }>(
    "publication_queue",
    new URLSearchParams({ select: "status", run_id: eq(runId) }),
  );

  const count = (status: string) => rows.filter((row) => row.status === status).length;
  const published = count("published");
  const failed = count("failed");
  const skipped = count("skipped_duplicate") + count("cancelled");
  const active = count("pending") + count("processing") + count("retry");

  let status: "running" | "completed" | "partial" | "failed" = "running";
  if (active === 0) {
    if (failed > 0 && published > 0) status = "partial";
    else if (failed > 0) status = "failed";
    else status = "completed";
  }

  await updateRun(db, runId, {
    status,
    published_count: published,
    failed_count: failed,
    skipped_count: skipped,
    finished_at: active === 0 ? new Date().toISOString() : null,
  });
}

function contentFromQueue(row: PublicationQueueRow): GeneratedContent {
  const content = row.content as Partial<GeneratedContent>;
  if (!content.body || !content.cta || !content.affiliateUrl) {
    throw new Error("INVALID_QUEUE_CONTENT");
  }
  return {
    channel: row.channel,
    title: String(content.title || "Oferta"),
    body: String(content.body),
    cta: String(content.cta),
    affiliateUrl: String(content.affiliateUrl),
    imageUrl: content.imageUrl ? String(content.imageUrl) : undefined,
    messageThreadId: Number.isInteger(Number(content.messageThreadId)) && Number(content.messageThreadId) > 0
      ? Number(content.messageThreadId)
      : undefined,
  };
}

async function publishQueueItem(db: SupabaseRest, env: Env, workerId: string, row: PublicationQueueRow) {
  try {
    const content = contentFromQueue(row);
    if (row.channel !== "telegram") throw new Error(`PUBLISHER_NOT_CONFIGURED: ${row.channel}`);

    const publisher = createTelegramPublisher({
      token: required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),
      chatId: required(env.TELEGRAM_CHAT_ID, "TELEGRAM_CHAT_ID"),
    });
    const result = await publisher.publish(content);

    await db.rpc<PublicationQueueRow[]>("complete_publication", {
      p_queue_id: row.id,
      p_worker_id: workerId,
      p_external_id: result.externalId || null,
      p_metadata: {
        worker: "cloudflare",
        attempt: row.attempts,
      },
    });

    return { id: row.id, runId: row.run_id, status: "published" as const, externalId: result.externalId };
  } catch (error) {
    const errorMessage = message(error);
    const failed = await db.rpc<PublicationQueueRow[]>("fail_publication", {
      p_queue_id: row.id,
      p_worker_id: workerId,
      p_error: errorMessage.slice(0, 4000),
      p_retry_after_seconds: null,
    });
    const nextStatus = Array.isArray(failed) ? failed[0]?.status : undefined;
    return { id: row.id, runId: row.run_id, status: nextStatus || "retry", error: errorMessage };
  }
}

export async function workerTick(env: Env) {
  const db = new SupabaseRest(env);
  const batchSize = boundedInt(env.WORKER_BATCH_SIZE, 10, 1, 50);
  const maxBatches = boundedInt(env.WORKER_MAX_BATCHES, 2, 1, 10);
  const delayMs = boundedInt(env.PUBLISH_DELAY_MS, 1000, 0, 10_000);
  const workerId = `cf-${crypto.randomUUID()}`;
  const results: Array<Record<string, unknown>> = [];
  const touchedRuns = new Set<string>();

  const recovered = await db.rpc<number>("recover_stale_publications", { p_lock_timeout_minutes: 10 });

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const claimed = await db.rpc<PublicationQueueRow[]>("claim_due_publications", {
      p_worker_id: workerId,
      p_limit: batchSize,
    });
    if (!Array.isArray(claimed) || claimed.length === 0) break;

    for (let index = 0; index < claimed.length; index += 1) {
      const row = claimed[index];
      const result = await publishQueueItem(db, env, workerId, row);
      results.push(result);
      if (row.run_id) touchedRuns.add(row.run_id);
      if (delayMs > 0 && index < claimed.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  for (const runId of touchedRuns) {
    await finalizeRun(db, runId);
  }

  return {
    workerId,
    recovered,
    processed: results.length,
    results,
  };
}

export async function runFullTick(env: Env, now = new Date()) {
  const scheduler = await schedulerTick(env, now);
  const worker = await workerTick(env);
  return { scheduler, worker };
}
