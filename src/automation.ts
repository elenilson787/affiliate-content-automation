import { createShopeeProvider } from "../lib/affiliate/shopee/adapter";
import { generateContent, type ContentTemplate } from "../lib/content-engine";
import { offerKey, productsLookEquivalent } from "../lib/offer-engine";
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

function intervalMinutes(settings: Record<string, unknown>) {
  const value = Number(settings.intervalMinutes);
  return Number.isInteger(value) && value >= 5 && value <= 1440 && value % 5 === 0 ? value : null;
}

function clockSetting(settings: Record<string, unknown>, key: string, fallback: string) {
  const value = typeof settings[key] === "string" ? String(settings[key]) : fallback;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function clockMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function localClockMinutes(date: Date, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function insidePublishWindow(date: Date, timezone: string, settings: Record<string, unknown>) {
  const start = clockMinutes(clockSetting(settings, "windowStart", "09:00"));
  const end = clockMinutes(clockSetting(settings, "windowEnd", "22:00"));
  const current = localClockMinutes(date, timezone);
  return start <= end ? current >= start && current <= end : current >= start || current <= end;
}

function intervalDueSlot(now: Date, timezone: string, settings: Record<string, unknown>, lastRunAt?: string | null) {
  const interval = intervalMinutes(settings);
  if (!interval) return null;
  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);
  if (!insidePublishWindow(slot, timezone, settings)) return null;
  if (lastRunAt) {
    const last = new Date(lastRunAt).getTime();
    if (Number.isFinite(last) && slot.getTime() - last < interval * 60_000) return null;
  }
  return slot;
}

type RecentPublishedQueue = {
  offer_key: string;
  channel: string;
  offer_snapshot: Offer;
  published_at: string | null;
};

async function loadRecentPublishedQueue(db: SupabaseRest, channels: string[], days: number) {
  if (days <= 0 || channels.length === 0) return [] as RecentPublishedQueue[];
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const params = new URLSearchParams({
    select: "offer_key,channel,offer_snapshot,published_at",
    status: "eq.published",
    published_at: `gte.${cutoff}`,
    order: "published_at.desc",
    limit: "500",
  });
  return db.select<RecentPublishedQueue>("publication_queue", params);
}

function wasProductPublishedRecently(recent: RecentPublishedQueue[], offer: Offer, channel: string) {
  const key = offerKey(offer);
  return recent.some((row) =>
    row.channel === channel &&
    (row.offer_key === key || (row.offer_snapshot && productsLookEquivalent(offer, row.offer_snapshot)))
  );
}

async function updateRun(db: SupabaseRest, runId: string, patch: Record<string, unknown>) {
  await db.update("automation_runs", new URLSearchParams({ id: eq(runId) }), patch);
}

async function searchOffers(
  env: Env,
  rule: AutomationRuleRow,
  targetQuantity = rule.quantity,
  excludeOffer?: (offer: Offer) => boolean,
) {
  const selected: Offer[] = [];
  const unsupportedNetworks: string[] = [];
  let scanned = 0;
  let pages = 0;
  let excluded = 0;

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
      {
        maxPages: 2,
        pageSize: 50,
        maxRequests: rule.settings.searchScope === "all" ? 10 : 8,
        searchScope: rule.settings.searchScope === "all" ? "all" : "keyword",
        excludeOffer,
      },
    );

    selected.push(...result.selected);
    scanned += result.scanned;
    pages += result.pages;
    excluded += result.excluded;
  }

  const uniqueSelected: Offer[] = [];
  for (const offer of selected) {
    if (!uniqueSelected.some((existing) => productsLookEquivalent(existing, offer))) uniqueSelected.push(offer);
    if (uniqueSelected.length >= targetQuantity) break;
  }
  return { selected: uniqueSelected, unsupportedNetworks, scanned, pages, excluded };
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
    const recentPublished = rule.dry_run ? [] : await loadRecentPublishedQueue(db, rule.channels, rule.avoid_repeat_days);
    const excludeOffer = rule.dry_run
      ? undefined
      : (offer: Offer) => rule.channels.length > 0 && rule.channels.every((channel) =>
          wasProductPublishedRecently(recentPublished, offer, channel)
        );
    const candidateTarget = rule.quantity;
    const { selected: candidates, unsupportedNetworks, scanned, pages, excluded } = await searchOffers(
      env, rule, candidateTarget, excludeOffer,
    );

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
    let dedupeCandidatesSkipped = excluded;

    for (const offer of candidates) {
      const key = offerKey(offer);
      const channelStates = rule.channels.map((channel) => ({
        channel,
        duplicate: wasProductPublishedRecently(recentPublished, offer, channel),
      }));

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
    const timezone = rule.timezone || env.DEFAULT_TIMEZONE || "America/Sao_Paulo";
    let slot: Date | null = null;

    if (intervalMinutes(rule.settings)) {
      const lastRuns = await db.select<{ started_at: string }>(
        "automation_runs",
        new URLSearchParams({ select: "started_at", rule_id: eq(rule.id), order: "started_at.desc", limit: "1" }),
      );
      slot = intervalDueSlot(now, timezone, rule.settings, lastRuns[0]?.started_at);
    } else if (rule.schedule_cron?.trim()) {
      slot = findDueSlot(rule.schedule_cron, now, timezone, SCHEDULER_LOOKBACK_MINUTES);
    }

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
