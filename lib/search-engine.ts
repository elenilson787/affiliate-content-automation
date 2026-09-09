import type { AffiliateProvider, Offer, SearchRequest } from "./types";
import { analyzeOffers, offerKey, type OfferFilterDiagnostics } from "./offer-engine";

export type SearchScope = "keyword" | "all";

export type QualifiedSearchResult = {
  selected: Offer[];
  scanned: number;
  pages: number;
  excluded: number;
  diagnostics: OfferFilterDiagnostics & { excludedRecent: number };
  strategy: {
    scope: SearchScope;
    requests: number;
    queries: string[];
    sourceSorts: string[];
  };
};

type SearchOptions = {
  maxPages?: number;
  pageSize?: number;
  maxRequests?: number;
  searchScope?: SearchScope;
  excludeOffer?: (offer: Offer) => boolean;
};

const EMPTY_DIAGNOSTICS: OfferFilterDiagnostics = {
  scanned: 0,
  rejectedRelevance: 0,
  invalidMetrics: 0,
  belowCommission: 0,
  belowDiscount: 0,
  aboveMaxPrice: 0,
  equivalentDuplicates: 0,
  eligible: 0,
  zeroSalesAccepted: 0,
  zeroRatingAccepted: 0,
};

const SEARCH_STOP_WORDS = new Set([
  "a", "as", "o", "os", "de", "da", "das", "do", "dos", "e", "em", "com", "para", "por", "um", "uma",
  "no", "na", "nos", "nas", "ao", "aos", "se", "que", "pra",
]);

const ALL_SCOPE_QUERIES = [
  "",
  "celular smartphone",
  "casa cozinha",
  "moda feminina",
  "moda masculina",
  "beleza cuidados pessoais",
  "produto pet",
  "roupa infantil bebe",
];

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function keywordVariants(keyword: string) {
  const exact = keyword.trim().slice(0, 80);
  if (!exact) return [""];
  const terms = normalize(exact)
    .split(/\s+/)
    .filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term));
  const variants = [exact];
  if (terms.length >= 2) variants.push(terms.slice(0, 4).join(" "));
  if (terms.length >= 3) variants.push(terms.slice(0, 2).join(" "));
  return Array.from(new Set(variants.filter(Boolean))).slice(0, 3);
}

function sourceSorts(sort: SearchRequest["sort"]) {
  const primary: SearchRequest["sort"] = sort === "discount" ? "sales" : sort;
  const values: Array<SearchRequest["sort"]> = [primary, "commission", "sales", undefined];
  return values.filter((value, index) => values.indexOf(value) === index);
}

function mergeUnique(pool: Offer[], seen: Set<string>, batch: Offer[]) {
  for (const offer of batch) {
    const key = offerKey(offer);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(offer);
  }
}

function evaluate(
  pool: Offer[],
  request: SearchRequest,
  target: number,
  scope: SearchScope,
  excludeOffer?: (offer: Offer) => boolean,
) {
  const reserve = excludeOffer ? Math.min(Math.max(target * 8, 20), 100) : Math.min(Math.max(target * 3, target), 100);
  const analyzed = analyzeOffers(pool, {
    keyword: scope === "all" ? "" : request.keyword,
    minCommission: request.minCommission,
    minDiscount: request.minDiscount,
    maxPrice: request.maxPrice,
    sort: request.sort,
    limit: reserve,
  });
  const qualified = analyzed.selected;
  const fresh = excludeOffer ? qualified.filter((offer) => !excludeOffer(offer)) : qualified;
  const excluded = Math.max(0, qualified.length - fresh.length);
  return {
    selected: fresh.slice(0, target),
    excluded,
    diagnostics: analyzed.diagnostics,
  };
}

export async function searchQualifiedOffers(
  provider: AffiliateProvider,
  request: SearchRequest,
  quantity: number,
  options: SearchOptions = {},
): Promise<QualifiedSearchResult> {
  const target = Math.min(Math.max(Math.trunc(quantity), 1), 100);
  const pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 50), 1), 50);
  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 2), 1), 5);
  const scope: SearchScope = options.searchScope === "all" ? "all" : "keyword";
  const maxRequests = Math.min(Math.max(Math.trunc(options.maxRequests ?? (scope === "all" ? 10 : 8)), 1), 20);
  const queries = scope === "all" ? ALL_SCOPE_QUERIES : keywordVariants(request.keyword);
  const sorts = sourceSorts(request.sort);
  const pool: Offer[] = [];
  const seen = new Set<string>();
  const usedQueries = new Set<string>();
  const usedSorts = new Set<string>();
  let requests = 0;
  let selected: Offer[] = [];
  let excluded = 0;
  let diagnostics: OfferFilterDiagnostics = { ...EMPTY_DIAGNOSTICS };

  const runRequest = async (keyword: string, sort: SearchRequest["sort"], page: number) => {
    if (requests >= maxRequests) return false;
    const batch = await provider.search({ ...request, keyword, sort, page, limit: pageSize });
    requests += 1;
    usedQueries.add(keyword || "Todos os produtos");
    usedSorts.add(sort || "relevance");
    mergeUnique(pool, seen, batch);
    const evaluated = evaluate(pool, request, target, scope, options.excludeOffer);
    selected = evaluated.selected;
    excluded = evaluated.excluded;
    diagnostics = evaluated.diagnostics;
    return batch.length >= pageSize;
  };

  outer:
  for (const query of queries) {
    for (const sort of sorts) {
      await runRequest(query, sort, 1);
      const minimumDiscovery = target <= 5 ? 2 : 3;
      if (selected.length >= target && requests >= minimumDiscovery) break outer;
      if (requests >= maxRequests) break outer;
    }
  }

  if (selected.length < target && requests < maxRequests) {
    const primaryQuery = queries[0] || "";
    for (let page = 2; page <= maxPages && requests < maxRequests; page += 1) {
      for (const sort of sorts.slice(0, 3)) {
        const full = await runRequest(primaryQuery, sort, page);
        if (selected.length >= target || requests >= maxRequests) break;
        if (!full) break;
      }
      if (selected.length >= target) break;
    }
  }

  return {
    selected,
    scanned: pool.length,
    pages: requests,
    excluded,
    diagnostics: { ...diagnostics, excludedRecent: excluded },
    strategy: {
      scope,
      requests,
      queries: [...usedQueries],
      sourceSorts: [...usedSorts],
    },
  };
}
