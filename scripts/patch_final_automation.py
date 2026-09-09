from pathlib import Path
import re

path = Path('src/automation.ts')
text = path.read_text(encoding='utf-8')

text = text.replace('import type { OfferListRow } from "./catalog";\n', 'import type { OfferListItemRow, OfferListRow } from "./catalog";\nimport { chooseMixNiche, commissionPlan, isSlotDue, mixFallbackOrder, nicheLabel, nicheQuery, sourceMode } from "./rule-policy";\n')

pattern = re.compile(r'async function searchOffers\([\s\S]*?\n\}\n\nasync function executeRule', re.M)
match = pattern.search(text)
assert match, 'searchOffers function not found'
new_block = r'''function localSales(offer: Offer) {
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

async function searchOffers(
  db: SupabaseRest,
  env: Env,
  rule: AutomationRuleRow,
  targetQuantity = rule.quantity,
  excludeOffer?: (offer: Offer) => boolean,
  slot = new Date(),
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
        { maxPages: 2, pageSize: 50, maxRequests: 8, searchScope: scope, excludeOffer },
      );
      scanned += primary.scanned;
      pages += primary.pages;
      excluded += primary.excluded;
      if (!commissionAttempts.includes(plan.desired)) commissionAttempts.push(plan.desired);
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
          { maxPages: 3, pageSize: 50, maxRequests: 12, searchScope: scope, excludeOffer },
        );
        scanned += fallback.scanned;
        pages += fallback.pages;
        excluded += fallback.excluded;
        const ranked = localSortOffers(fallback.selected, requestedSort ?? null);
        for (const threshold of plan.thresholds.slice(1)) {
          if (!commissionAttempts.includes(threshold)) commissionAttempts.push(threshold);
          const before = selected.length;
          addUnique(ranked.filter((offer) => Math.max(0, Number(offer.commissionPercent) || 0) >= threshold));
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
  };
}

async function executeRule'''
text = text[:match.start()] + new_block + text[match.end():]

text = text.replace('''  const slotIso = slot.toISOString();
  const runId = triggerSource === "scheduler" ? await stableUuid(`scheduler:${rule.id}:${slotIso}`) : crypto.randomUUID();

  const insertedRuns = await db.insert<{ id: string }>(
''', '''  const slotIso = slot.toISOString();
  const runId = triggerSource === "scheduler" ? await stableUuid(`scheduler:${rule.id}:${slotIso}`) : crypto.randomUUID();
  const slotMode = String(rule.settings?.scheduleMode || "") === "slots";
  const requestedQuantity = slotMode ? 1 : rule.quantity;

  const insertedRuns = await db.insert<{ id: string }>(
''')
text = text.replace('''      requested_count: rule.quantity,
''', '''      requested_count: requestedQuantity,
''', 1)
text = text.replace('''    const candidateTarget = rule.quantity;
    const { selected: candidates, unsupportedNetworks, scanned, pages, excluded } = await searchOffers(
      db, env, rule, candidateTarget, excludeOffer,
    );
''', '''    const candidateTarget = requestedQuantity;
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
    } = await searchOffers(db, env, rule, candidateTarget, excludeOffer, slot);
''')
text = text.replace('''      const selected = candidates.slice(0, rule.quantity);
''', '''      const selected = candidates.slice(0, requestedQuantity);
''')
text = text.replace('''    const configuredInterval = intervalMinutes(rule.settings);
    const publicationSlots = await buildPublicationSlots(db, rule, slot, rule.quantity);
''', '''    const configuredInterval = intervalMinutes(rule.settings);
    const publicationSlots = slotMode ? [new Date(slot)] : await buildPublicationSlots(db, rule, slot, requestedQuantity);
''')
text = text.replace('''      if (selected.length >= rule.quantity) break;
''', '''      if (selected.length >= requestedQuantity) break;
''')
text = text.replace('''        dedupeCandidatesSkipped,
        publicationIntervalMinutes: configuredInterval,
''', '''        dedupeCandidatesSkipped,
        sourceMode: selectedSourceMode,
        sourceNiche,
        commissionTarget,
        commissionResolved,
        commissionAttempts,
        publicationIntervalMinutes: configuredInterval,
''')
text = text.replace('''      status: queued > 0 ? "queued" : "dry_run",
''', '''      status: queued > 0 ? "queued" : "no_offer",
''')
text = text.replace('''  status: "queued" | "dry_run" | "duplicate_run" | "failed";
''', '''  status: "queued" | "dry_run" | "duplicate_run" | "no_offer" | "failed";
''')

old_scheduler = '''    // Uma regra nunca cria uma segunda sequência enquanto a anterior ainda tiver
    // itens pendentes/processing/retry. Isso impede lotes concorrentes.
    if (!rule.dry_run && await hasActiveRuleQueue(db, rule.id)) continue;

    if (intervalMinutes(rule.settings)) {
      const candidate = new Date(now);
      candidate.setUTCSeconds(0, 0);
      if (insidePublishWindow(candidate, timezone, rule.settings)) slot = candidate;
    } else if (rule.schedule_cron?.trim()) {
      slot = findDueSlot(rule.schedule_cron, now, timezone, SCHEDULER_LOOKBACK_MINUTES);
    }
'''
new_scheduler = '''    // Uma regra nunca cria uma segunda publicação enquanto a anterior ainda está
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
'''
assert old_scheduler in text, 'scheduler block not found'
text = text.replace(old_scheduler, new_scheduler)

path.write_text(text, encoding='utf-8')
