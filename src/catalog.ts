import { createShopeeProvider } from "../lib/affiliate/shopee/adapter";
import { discountPercent, offerKey, offerRating, offerSales } from "../lib/offer-engine";
import { searchQualifiedOffers } from "../lib/search-engine";
import type { Offer, SearchRequest } from "../lib/types";
import { SupabaseRest, eq } from "./db";
import { required, type Env } from "./env";

type JsonObject = Record<string, unknown>;
export type OfferListPreset = "recommended" | "viral" | "sales" | "commission" | "discount" | "new";
export type OfferListType = "manual" | "intelligent" | "hybrid";

export type OfferListRow = {
  id: string;
  name: string;
  description: string;
  list_type: OfferListType;
  preset: OfferListPreset;
  enabled: boolean;
  min_commission: number | null;
  min_discount: number | null;
  min_price: number | null;
  max_price: number | null;
  min_sales: number | null;
  min_rating: number | null;
  sort: SearchRequest["sort"] | null;
  target_size: number;
  rules: JsonObject;
  created_at: string;
  updated_at: string;
};

export type OfferListItemRow = {
  id: string;
  list_id: string;
  offer_key: string;
  network: string;
  offer_id: string;
  offer_snapshot: Offer;
  source: "smart" | "manual";
  pinned: boolean;
  created_at: string;
  updated_at: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(value: unknown, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function numberOrNull(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" && value.includes(",")
    ? value.trim().replace(/\./g, "").replace(",", ".")
    : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function integerOrNull(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function preset(value: unknown): OfferListPreset {
  return ["recommended", "viral", "sales", "commission", "discount", "new"].includes(String(value))
    ? String(value) as OfferListPreset
    : "recommended";
}

function listType(value: unknown): OfferListType {
  return ["manual", "intelligent", "hybrid"].includes(String(value))
    ? String(value) as OfferListType
    : "intelligent";
}

function validSort(value: unknown): SearchRequest["sort"] | null {
  return ["commission", "price", "sales", "discount"].includes(String(value))
    ? String(value) as SearchRequest["sort"]
    : null;
}

function presetSort(value: OfferListPreset, requested: SearchRequest["sort"] | null) {
  if (requested) return requested;
  if (value === "sales" || value === "viral") return "sales" as const;
  if (value === "commission") return "commission" as const;
  if (value === "discount") return "discount" as const;
  return undefined;
}

function metric(offer: Offer, key: "sales" | "rating") {
  return key === "sales" ? Math.max(0, offerSales(offer) ?? 0) : Math.max(0, offerRating(offer) ?? 0);
}

function opportunityScore(offer: Offer, strategy: OfferListPreset) {
  const discount = Math.max(0, offer.discountPercent ?? discountPercent(offer));
  const commission = Math.max(0, offer.commissionPercent ?? 0);
  const sales = metric(offer, "sales");
  const rating = Math.min(5, metric(offer, "rating"));
  let score = Math.min(45, discount * 0.7) + Math.min(30, commission * 1.1) + Math.min(15, Math.log10(sales + 1) * 4) + Math.min(10, rating * 2);
  if (strategy === "viral") score += Math.min(8, Math.log10(sales + 1) * 2) + Math.min(4, rating * 0.8);
  if (strategy === "commission") score += Math.min(8, commission * 0.3);
  if (strategy === "discount") score += Math.min(8, discount * 0.15);
  if (strategy === "new" && sales === 0) score += 12;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function sortOffers(offers: Offer[], strategy: OfferListPreset, sort: SearchRequest["sort"] | null) {
  const sales = (o: Offer) => metric(o, "sales");
  const rating = (o: Offer) => metric(o, "rating");
  const discount = (o: Offer) => Math.max(0, o.discountPercent ?? discountPercent(o));
  const commission = (o: Offer) => Math.max(0, o.commissionPercent ?? 0);
  const copy = [...offers];
  if (strategy === "new") {
    copy.sort((a, b) => sales(a) - sales(b) || discount(b) - discount(a) || commission(b) - commission(a));
    return copy;
  }
  if (strategy === "viral") {
    copy.sort((a, b) => sales(b) - sales(a) || rating(b) - rating(a) || discount(b) - discount(a) || commission(b) - commission(a));
    return copy;
  }
  if (sort === "commission" || strategy === "commission") copy.sort((a, b) => commission(b) - commission(a) || discount(b) - discount(a) || sales(b) - sales(a));
  else if (sort === "discount" || strategy === "discount") copy.sort((a, b) => discount(b) - discount(a) || commission(b) - commission(a) || sales(b) - sales(a));
  else if (sort === "sales" || strategy === "sales") copy.sort((a, b) => sales(b) - sales(a) || commission(b) - commission(a) || discount(b) - discount(a));
  else if (sort === "price") copy.sort((a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY));
  else copy.sort((a, b) => opportunityScore(b, strategy) - opportunityScore(a, strategy));
  return copy;
}

type ExploreFilters = {
  preset: OfferListPreset;
  minCommission: number | null;
  minDiscount: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  minSales: number | null;
  minRating: number | null;
  sort: SearchRequest["sort"] | null;
  limit: number;
};

function parseExploreFilters(body: JsonObject, defaults?: Partial<ExploreFilters>): ExploreFilters {
  return {
    preset: preset(body.preset ?? defaults?.preset),
    minCommission: numberOrNull(body.minCommission ?? defaults?.minCommission, 0, 100),
    minDiscount: numberOrNull(body.minDiscount ?? defaults?.minDiscount, 0, 100),
    minPrice: numberOrNull(body.minPrice ?? defaults?.minPrice, 0, 1_000_000),
    maxPrice: numberOrNull(body.maxPrice ?? defaults?.maxPrice, 0, 1_000_000),
    minSales: integerOrNull(body.minSales ?? defaults?.minSales, 0, 1_000_000_000),
    minRating: numberOrNull(body.minRating ?? defaults?.minRating, 0, 5),
    sort: validSort(body.sort ?? defaults?.sort),
    limit: Math.min(Math.max(Number(body.limit ?? defaults?.limit ?? 24) || 24, 1), 60),
  };
}

export async function exploreOffers(env: Env, filters: ExploreFilters) {
  const provider = createShopeeProvider({
    appId: required(env.SHOPEE_APP_ID, "SHOPEE_APP_ID"),
    secret: required(env.SHOPEE_SECRET, "SHOPEE_SECRET"),
  });
  const discoveryTarget = Math.min(Math.max(filters.limit * 3, 30), 100);
  const search = await searchQualifiedOffers(
    provider,
    {
      keyword: "",
      minCommission: filters.minCommission ?? undefined,
      minDiscount: filters.minDiscount ?? undefined,
      maxPrice: filters.maxPrice ?? undefined,
      sort: presetSort(filters.preset, filters.sort),
    },
    discoveryTarget,
    { maxPages: 2, pageSize: 50, maxRequests: 12, searchScope: "all" },
  );
  let offers = search.selected.filter((offer) => {
    const price = offer.price ?? 0;
    const sales = metric(offer, "sales");
    const rating = metric(offer, "rating");
    if (filters.minPrice != null && price < filters.minPrice) return false;
    if (filters.minSales != null && sales < filters.minSales) return false;
    if (filters.minRating != null && rating < filters.minRating) return false;
    return true;
  });
  offers = sortOffers(offers, filters.preset, filters.sort).slice(0, filters.limit);
  return {
    offers: offers.map((offer) => ({
      offer,
      score: opportunityScore(offer, filters.preset),
      sales: metric(offer, "sales"),
      rating: metric(offer, "rating"),
      discount: Math.round((offer.discountPercent ?? discountPercent(offer)) * 10) / 10,
      commission: Math.round((offer.commissionPercent ?? 0) * 10) / 10,
    })),
    scanned: search.scanned,
    requests: search.strategy.requests,
    diagnostics: search.diagnostics,
    strategy: search.strategy,
    filters,
  };
}

function listFilters(row: OfferListRow): ExploreFilters {
  return {
    preset: row.preset,
    minCommission: row.min_commission,
    minDiscount: row.min_discount,
    minPrice: row.min_price,
    maxPrice: row.max_price,
    minSales: row.min_sales,
    minRating: row.min_rating,
    sort: row.sort,
    limit: row.target_size,
  };
}

async function loadLists(db: SupabaseRest) {
  const [lists, items] = await Promise.all([
    db.select<OfferListRow>("offer_lists", new URLSearchParams({ select: "*", order: "updated_at.desc" })),
    db.select<OfferListItemRow>("offer_list_items", new URLSearchParams({ select: "*", order: "created_at.desc", limit: "500" })),
  ]);
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.list_id] = (counts[item.list_id] || 0) + 1;
  return {
    lists: lists.map((list) => ({ ...list, itemCount: counts[list.id] || 0 })),
    items,
  };
}

function createListPayload(body: JsonObject) {
  const name = text(body.name, 120);
  if (!name) throw new Error("Nome da lista obrigatório.");
  const type = listType(body.listType);
  const chosenPreset = preset(body.preset);
  const targetSize = Math.min(Math.max(Number(body.targetSize ?? 30) || 30, 1), 100);
  return {
    name,
    description: text(body.description, 220),
    list_type: type,
    preset: chosenPreset,
    enabled: body.enabled !== false,
    min_commission: numberOrNull(body.minCommission, 0, 100),
    min_discount: numberOrNull(body.minDiscount, 0, 100),
    min_price: numberOrNull(body.minPrice, 0, 1_000_000),
    max_price: numberOrNull(body.maxPrice, 0, 1_000_000),
    min_sales: integerOrNull(body.minSales, 0, 1_000_000_000),
    min_rating: numberOrNull(body.minRating, 0, 5),
    sort: validSort(body.sort),
    target_size: targetSize,
    rules: { source: "smart_catalog", version: 1 },
  };
}

async function refreshList(db: SupabaseRest, env: Env, id: string) {
  const rows = await db.select<OfferListRow>("offer_lists", new URLSearchParams({ select: "*", id: eq(id), limit: "1" }));
  const list = rows[0];
  if (!list) return json({ error: "Lista não encontrada." }, 404);
  if (list.list_type === "manual") return json({ error: "Lista manual não usa atualização inteligente." }, 409);
  const result = await exploreOffers(env, listFilters(list));
  const payload = result.offers.map(({ offer }) => ({
    id: crypto.randomUUID(),
    list_id: list.id,
    offer_key: offerKey(offer),
    network: offer.network,
    offer_id: offer.id,
    offer_snapshot: offer,
    source: "smart",
    pinned: false,
  }));
  if (payload.length) {
    await db.insert<OfferListItemRow>(
      "offer_list_items?on_conflict=list_id,offer_key",
      payload,
      "resolution=merge-duplicates,return=representation",
    );
  }
  await db.update("offer_lists", new URLSearchParams({ id: eq(id) }), { updated_at: new Date().toISOString() });
  return json({ ok: true, list, refreshed: payload.length, result });
}

async function addItem(db: SupabaseRest, id: string, body: JsonObject) {
  const offer = body.offer as Offer | undefined;
  if (!offer || !offer.id || !offer.network || !offer.title) return json({ error: "Oferta inválida." }, 400);
  const lists = await db.select<OfferListRow>("offer_lists", new URLSearchParams({ select: "id", id: eq(id), limit: "1" }));
  if (!lists.length) return json({ error: "Lista não encontrada." }, 404);
  const rows = await db.insert<OfferListItemRow>(
    "offer_list_items?on_conflict=list_id,offer_key",
    {
      id: crypto.randomUUID(),
      list_id: id,
      offer_key: offerKey(offer),
      network: offer.network,
      offer_id: offer.id,
      offer_snapshot: offer,
      source: "manual",
      pinned: true,
    },
    "resolution=merge-duplicates,return=representation",
  );
  return json({ ok: true, item: rows[0] || null });
}

export async function handleCatalogAdminApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = new SupabaseRest(env);

  if (request.method === "POST" && path === "/api/admin/explore") {
    const body = await request.json().catch(() => ({})) as JsonObject;
    const filters = parseExploreFilters(body);
    return json(await exploreOffers(env, filters));
  }

  if (request.method === "GET" && path === "/api/admin/lists") {
    return json({ ok: true, ...(await loadLists(db)) });
  }

  if (request.method === "POST" && path === "/api/admin/lists") {
    const body = await request.json().catch(() => ({})) as JsonObject;
    const payload = createListPayload(body);
    const rows = await db.insert<OfferListRow>("offer_lists", { id: crypto.randomUUID(), ...payload }, "return=representation");
    const list = rows[0];
    if (!list) return json({ error: "Não foi possível criar a lista." }, 500);
    if (list.list_type !== "manual" && body.refresh !== false) {
      return refreshList(db, env, list.id);
    }
    return json({ ok: true, list });
  }

  const refreshMatch = path.match(/^\/api\/admin\/lists\/([0-9a-f-]{36})\/refresh$/i);
  if (refreshMatch && request.method === "POST") return refreshList(db, env, refreshMatch[1]);

  const itemMatch = path.match(/^\/api\/admin\/lists\/([0-9a-f-]{36})\/items$/i);
  if (itemMatch && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as JsonObject;
    return addItem(db, itemMatch[1], body);
  }

  const listMatch = path.match(/^\/api\/admin\/lists\/([0-9a-f-]{36})$/i);
  if (listMatch && request.method === "PATCH") {
    const body = await request.json().catch(() => ({})) as JsonObject;
    const current = await db.select<OfferListRow>("offer_lists", new URLSearchParams({ select: "*", id: eq(listMatch[1]), limit: "1" }));
    if (!current.length) return json({ error: "Lista não encontrada." }, 404);
    const patch: JsonObject = {};
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.name !== undefined) patch.name = text(body.name, 120) || current[0].name;
    if (body.description !== undefined) patch.description = text(body.description, 220);
    const rows = await db.update<OfferListRow>("offer_lists", new URLSearchParams({ id: eq(listMatch[1]) }), patch);
    return json({ ok: true, list: rows[0] || current[0] });
  }

  return null;
}
