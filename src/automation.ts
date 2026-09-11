import { createShopeeProvider } from "../lib/affiliate/shopee/adapter";
import { generateContent, type ContentTemplate } from "../lib/content-engine";
import { offerKey, productsLookEquivalent } from "../lib/offer-engine";
import { createTelegramPublisher } from "../lib/publishers/telegram";
import { searchQualifiedOffers } from "../lib/search-engine";
import type { GeneratedContent, Offer } from "../lib/types";
import { findDueSlot, stableUuid } from "./cron";
import { SupabaseRest, eq, type AutomationRuleRow, type PublicationQueueRow } from "./db";
import { boundedInt, required, type Env } from "./env";
import type { OfferListItemRow, OfferListRow } from "./catalog";
import { chooseMixNiche, commissionPlan, isSlotDue, mixFallbackOrder, nicheLabel, nicheQuery, sourceMode } from "./rule-policy";

const SCHEDULER_LOOKBACK_MINUTES = 5;

type RuleExecutionResult = {
  ruleId: string;
  runId?: string;
  slot?: string;
  status: "queued" | "dry_run" | "duplicate_run" | "no_offer" | "failed";
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

function nextValidPublicationSlot(start: Date, timezone: string, settings: Record<string, unknown>) {
  let candidate = new Date(start);
  candidate.setUTCSeconds(0, 0);
  const remainder = candidate.getUTCMinutes() % 5;
  if (remainder !== 0) candidate = new Date(candidate.getTime() + (5 - remainder) * 60_000);

  // Procura a próxima janela válida por até 14 dias. Isso também cobre janelas
  // que atravessam a meia-noite sem depender de conversões manuais de timezone.
  for (let i = 0; i < 4_032; i += 1) {
    if (insidePublishWindow(candidate, timezone, settings)) return candidate;
    candidate = new Date(candidate.getTime() + 5 * 60_000);
  }
  throw new Error("NO_VALID_PUBLICATION_WINDOW");
}

async function hasActiveRuleQueue(db: SupabaseRest, ruleId: string) {
  const rows = await db.select<{ id: string }>(
    "publication_queue",
    new URLSearchParams({
      select: "id",
      rule_id: eq(ruleId),
      status: "in.(pending,processing,retry)",
      limit: "1",
    }),
  );
  return rows.length > 0;
}

async function latestRulePublishedAt(db: SupabaseRest, ruleId: string, channel?: string) {
  const params = new URLSearchParams({
    select: "published_at",
    rule_id: eq(ruleId),
    status: "eq.published",
    order: "published_at.desc",
    limit: "1",
  });
  if (channel) params.set("channel", eq(channel));
  const rows = await db.select<{ published_at: string | null }>("publication_queue", params);
  return rows[0]?.published_at || null;
}

async function buildPublicationSlots(
  db: SupabaseRest,
  rule: AutomationRuleRow,
  slot: Date,
  count: number,
) {
  const interval = intervalMinutes(rule.settings);
  if (!interval) return Array.from({ length: count }, () => new Date(slot));

  const timezone = rule.timezone || "America/Sao_Paulo";
  const lastPublishedAt = await latestRulePublishedAt(db, rule.id);
  let firstCandidate = new Date(slot);
  if (lastPublishedAt) {
    const earliest = new Date(lastPublishedAt).getTime() + interval * 60_000;
    if (Number.isFinite(earliest) && earliest > firstCandidate.getTime()) firstCandidate = new Date(earliest);
  }

  const slots: Date[] = [];
  let current = nextValidPublicationSlot(firstCandidate, timezone, rule.settings);
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      current = nextValidPublicationSlot(
        new Date(current.getTime() + interval * 60_000),
        timezone,
        rule.settings,
      );
    }
    slots.push(new Date(current));
  }
  return slots;
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

function localSales(offer: Offer) {
  const value = Number(offer.sourceMetadata?.sales);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function localSortOffers(offers: Offer[], sort: AutomationRuleRow["sort"]) {
  const copy = [...offers];
  const commission = (offer: Offer) => Math.max(0, Number(offer.commissionPercent) || 0);
  const discount = (offer: Offer) => Math.max(0, Number(offer.discountPercent) || 0);
  if (sort === "commission") copy.sort((a, b) => commission(b) - commission(a) || discount(b) - discount(a));
  else if (sort === "discount") copy.sort((a, b) => discount(b) - discount(a) || commission(b) - commission(a));
  else if (sort === "sales") copy.sort((a, b) => localSales(b) - localSales(a) || commission(b) - commission(a));
  else if (sort === "price") copy.sort((a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY));
  else copy.sort((a, b) => commission(b) - commission(a) || discount(b) - discount(a) || localSales(b) - localSales(a));
  return copy;
}

function passesOfferBounds(offer: Offer, minDiscount?: number | null, maxPrice?: number | null) {
  if (minDiscount != null && Math.max(0, Number(offer.discountPercent) || 0) < minDiscount) return false;
  if (maxPrice != null && Number.isFinite(Number(offer.price)) && Number(offer.price) > maxPrice) return false;
  return true;
}

export async function searchOffersForRule(
  db: SupabaseRest,
  env: Env,
  rule: AutomationRuleRow,
  targetQuantity = rule.quantity,
  excludeOffer?: (offer: Offer) => boolean,
  slot = new Date(),
  searchTuning: { pageStart?: number; maxRequests?: number; maxPages?: number } = {},
) {
  const unsupportedNetworks: string[] = [];
  let scanned = 0;
  let pages = 0;
  let excluded = 0;
  const settings = rule.settings || {};
  const mode = sourceMode(settings);
  const timezone = rule.timezone || "America/Sao_Paulo";
  const listId = typeof settings.listId === "string" ? settings.listId : "";
  let sourceList: OfferListRow | undefined;

  if (listId) {
    const rows = await db.select<OfferListRow>("offer_lists", new URLSearchParams({ select: "*", id: eq(listId), enabled: "eq.true", limit: "1" }));
    sourceList = rows[0];
  }

  const minDiscount = sourceList?.min_discount ?? rule.min_discount ?? undefined;
  const maxPrice = sourceList?.max_price ?? rule.max_price ?? undefined;
  const requestedSort = sourceList?.sort ?? rule.sort ?? undefined;
  const commissionTarget = sourceList?.min_commission ?? rule.min_commission ?? undefined;
  const plan = commissionPlan(commissionTarget, settings);
  const selected: Offer[] = [];
  let resolvedCommission: number | null = null;
  let selectedNiche: string | null = null;
  let commissionAttempts: number[] = [];
  const commissionAttemptStats: Array<{ threshold: number; eligible: number }> = [];
  const recordCommissionAttempt = (threshold: number, eligible: number) => {
    const existing = commissionAttemptStats.find((item) => item.threshold === threshold);
    if (existing) existing.eligible = Math.max(existing.eligible, eligible);
    else commissionAttemptStats.push({ threshold, eligible });
  };

  const addUnique = (offers: Offer[]) => {
    for (const offer of offers) {
      if (excludeOffer?.(offer)) { excluded += 1; continue; }
      if (!passesOfferBounds(offer, minDiscount, maxPrice)) continue;
      if (!selected.some((existing) => productsLookEquivalent(existing, offer))) selected.push(offer);
      if (selected.length >= targetQuantity) break;
    }
  };

  if (mode === "list" && sourceList) {
    const items = await db.select<OfferListItemRow>("offer_list_items", new URLSearchParams({
      select: "*",
      list_id: eq(sourceList.id),
      order: "pinned.desc,updated_at.desc",
      limit: "250",
    }));
    scanned += items.length;
    const snapshots = localSortOffers(items.map((item) => item.offer_snapshot).filter(Boolean), requestedSort ?? null)
      .filter((offer) => passesOfferBounds(offer, minDiscount, maxPrice));
    for (const threshold of plan.thresholds) {
      commissionAttempts.push(threshold);
      const candidates = snapshots.filter((offer) => Math.max(0, Number(offer.commissionPercent) || 0) >= threshold);
      recordCommissionAttempt(threshold, candidates.length);
      addUnique(candidates);
      if (selected.length >= targetQuantity) { resolvedCommission = threshold; break; }
    }
  }

  const network = rule.networks.includes("shopee") ? "shopee" : rule.networks[0];
  if (network !== "shopee") unsupportedNetworks.push(network);

  if (selected.length < targetQuantity && network === "shopee") {
    const provider = createShopeeProvider({
      appId: required(env.SHOPEE_APP_ID, "SHOPEE_APP_ID"),
      secret: required(env.SHOPEE_SECRET, "SHOPEE_SECRET"),
    });

    const preferredMix = mode === "mix" ? chooseMixNiche(settings, slot, timezone) : null;
    const nicheOrder = mode === "mix"
      ? mixFallbackOrder(settings, preferredMix)
      : mode === "niche"
        ? [String(settings.niche || "")].filter(Boolean)
        : [""];
    if (mode === "list" && sourceList) nicheOrder.splice(0, nicheOrder.length, "");

    for (const niche of nicheOrder.slice(0, mode === "mix" ? 5 : 1)) {
      const query = niche ? nicheQuery(niche) : "";
      const scope = niche ? "keyword" as const : "all" as const;
      selectedNiche = niche ? nicheLabel(niche) : null;
      const remaining = Math.max(1, targetQuantity - selected.length);

      const primary = await searchQualifiedOffers(
        provider,
        {
          keyword: query,
          category: rule.category || undefined,
          minCommission: plan.desired || undefined,
          minDiscount,
          maxPrice,
          sort: requestedSort,
        },
        remaining,
        {
          maxPages: searchTuning.maxPages ?? 2,
          pageSize: 50,
          maxRequests: searchTuning.maxRequests ?? 8,
          pageStart: searchTuning.pageStart ?? 1,
          searchScope: scope,
          excludeOffer,
        },
      );
      scanned += primary.scanned;
      pages += primary.pages;
      excluded += primary.excluded;
      if (!commissionAttempts.includes(plan.desired)) commissionAttempts.push(plan.desired);
      recordCommissionAttempt(plan.desired, primary.selected.length);
      addUnique(primary.selected);
      if (selected.length >= targetQuantity) {
        resolvedCommission = plan.desired || 0;
        break;
      }

      if (plan.enabled && plan.floor < plan.desired) {
        const fallback = await searchQualifiedOffers(
          provider,
          {
            keyword: query,
            category: rule.category || undefined,
            minCommission: plan.floor || undefined,
            minDiscount,
            maxPrice,
            sort: "commission",
          },
          Math.min(30, Math.max(12, remaining * 8)),
          {
            maxPages: Math.max(searchTuning.maxPages ?? 3, 3),
            pageSize: 50,
            maxRequests: Math.max(searchTuning.maxRequests ?? 12, 12),
            pageStart: searchTuning.pageStart ?? 1,
            searchScope: scope,
            excludeOffer,
          },
        );
        scanned += fallback.scanned;
        pages += fallback.pages;
        excluded += fallback.excluded;
        const ranked = localSortOffers(fallback.selected, requestedSort ?? null);
        for (const threshold of plan.thresholds.slice(1)) {
          if (!commissionAttempts.includes(threshold)) commissionAttempts.push(threshold);
          const thresholdCandidates = ranked.filter((offer) => Math.max(0, Number(offer.commissionPercent) || 0) >= threshold);
          recordCommissionAttempt(threshold, thresholdCandidates.length);
          const before = selected.length;
          addUnique(thresholdCandidates);
          if (selected.length > before) resolvedCommission = threshold;
          if (selected.length >= targetQuantity) break;
        }
        if (selected.length >= targetQuantity) break;
      }
    }
  }

  return {
    selected: selected.slice(0, targetQuantity),
    unsupportedNetworks,
    scanned,
    pages,
    excluded,
    sourceMode: mode,
    sourceNiche: selectedNiche,
    commissionTarget: plan.desired,
    commissionResolved: resolvedCommission,
    commissionAttempts,
    commissionAttemptStats,
  };
}

async function executeRule(db: SupabaseRest, env: Env, rule: AutomationRuleRow, slot: Date, triggerSource: "scheduler" | "manual" = "scheduler"): Promise<RuleExecutionResult> {
  const slotIso = slot.toISOString();
  const runId = triggerSource === "scheduler" ? await stableUuid(`scheduler:${rule.id}:${slotIso}`) : crypto.randomUUID();
  const slotMode = String(rule.settings?.scheduleMode || "") === "slots";
  const requestedQuantity = slotMode ? 1 : rule.quantity;

  const insertedRuns = await db.insert<{ id: string }>(
    "automation_runs",
    {
      id: runId,
      rule_id: rule.id,
      trigger_source: triggerSource,
      status: "running",
      dry_run: rule.dry_run,
      requested_count: requestedQuantity,
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
    const candidateTarget = requestedQuantity;
    const {
      selected: candidates,
      unsupportedNetworks,
      scanned,
      pages,
      excluded,
      sourceMode: selectedSourceMode,
      sourceNiche,
      commissionTarget,
      commissionResolved,
      commissionAttempts,
    } = await searchOffersForRule(db, env, rule, candidateTarget, excludeOffer, slot);

    if (rule.dry_run) {
      const selected = candidates.slice(0, requestedQuantity);
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
    const configuredInterval = intervalMinutes(rule.settings);
    const publicationSlots = slotMode ? [new Date(slot)] : await buildPublicationSlots(db, rule, slot, requestedQuantity);
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

      const publicationIndex = selected.length;
      const scheduledFor = publicationSlots[publicationIndex]?.toISOString() || slotIso;
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
          scheduled_for: scheduledFor,
          available_at: scheduledFor,
          max_attempts: maxAttempts,
          idempotency_key: `${runId}:${key}:${channel}`,
          content,
          offer_snapshot: offer,
        });
      }

      if (selected.length >= requestedQuantity) break;
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
        sourceMode: selectedSourceMode,
        sourceNiche,
        commissionTarget,
        commissionResolved,
        commissionAttempts,
        publicationIntervalMinutes: configuredInterval,
        firstScheduledFor: selected.length ? publicationSlots[0]?.toISOString() || null : null,
        lastScheduledFor: selected.length ? publicationSlots[selected.length - 1]?.toISOString() || null : null,
      },
    });

    return {
      ruleId: rule.id,
      runId,
      slot: slotIso,
      status: queued > 0 ? "queued" : "no_offer",
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
  if (!rules[0].dry_run && await hasActiveRuleQueue(db, ruleId)) {
    throw new Error("Esta automação já possui publicações pendentes. Aguarde a sequência atual terminar ou cancele a fila antes de executar novamente.");
  }
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

    // Uma regra nunca cria uma segunda publicação enquanto a anterior ainda está
    // pendente/processing/retry. No modo de slots isso forma uma fila deslizante:
    // o produto é escolhido perto do horário real, evitando ofertas envelhecidas.
    if (!rule.dry_run && await hasActiveRuleQueue(db, rule.id)) continue;

    if (String(rule.settings?.scheduleMode || "") === "slots") {
      if (!isSlotDue(rule, now)) continue;
      slot = new Date(now);
      slot.setUTCSeconds(0, 0);
    } else if (intervalMinutes(rule.settings)) {
      const candidate = new Date(now);
      candidate.setUTCSeconds(0, 0);
      if (insidePublishWindow(candidate, timezone, rule.settings)) slot = candidate;
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

async function deferClaimIfTooSoon(db: SupabaseRest, workerId: string, row: PublicationQueueRow) {
  if (!row.rule_id) return null;
  const rules = await db.select<AutomationRuleRow>(
    "automation_rules",
    new URLSearchParams({ select: "*", id: eq(row.rule_id), limit: "1" }),
  );
  const rule = rules[0];
  if (!rule) return null;
  const interval = intervalMinutes(rule.settings);
  if (!interval) return null;

  const lastPublishedAt = await latestRulePublishedAt(db, rule.id, row.channel);
  if (!lastPublishedAt) return null;
  const earliestMs = new Date(lastPublishedAt).getTime() + interval * 60_000;
  if (!Number.isFinite(earliestMs) || Date.now() >= earliestMs) return null;

  const scheduled = nextValidPublicationSlot(
    new Date(earliestMs),
    rule.timezone || "America/Sao_Paulo",
    rule.settings,
  );
  const scheduledIso = scheduled.toISOString();
  const filters = new URLSearchParams({ id: eq(row.id), locked_by: eq(workerId) });
  await db.update("publication_queue", filters, {
    status: "pending",
    scheduled_for: scheduledIso,
    available_at: scheduledIso,
    attempts: Math.max(0, Number(row.attempts || 0) - 1),
    locked_at: null,
    locked_by: null,
  });
  await db.insert("publication_logs", {
    queue_id: row.id,
    run_id: row.run_id,
    rule_id: row.rule_id,
    event: "interval_deferred",
    status: "pending",
    message: `Publicação adiada para respeitar intervalo de ${interval} minuto(s).`,
    metadata: { intervalMinutes: interval, scheduledFor: scheduledIso },
  }, "return=minimal");
  return scheduledIso;
}

async function publishQueueItem(db: SupabaseRest, env: Env, workerId: string, row: PublicationQueueRow) {
  try {
    const deferredUntil = await deferClaimIfTooSoon(db, workerId, row);
    if (deferredUntil) {
      return { id: row.id, runId: row.run_id, status: "deferred" as const, scheduledFor: deferredUntil };
    }
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
