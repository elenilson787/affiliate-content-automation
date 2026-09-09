import type { AffiliateProvider, Offer, SearchRequest } from "./types";
import { analyzeOffers, type OfferFilterDiagnostics } from "./offer-engine";

export type QualifiedSearchResult = {
  selected: Offer[];
  scanned: number;
  pages: number;
  excluded: number;
  diagnostics: OfferFilterDiagnostics & { excludedRecent: number };
};

type SearchOptions = {
  maxPages?: number;
  pageSize?: number;
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

export async function searchQualifiedOffers(
  provider: AffiliateProvider,
  request: SearchRequest,
  quantity: number,
  options: SearchOptions = {},
): Promise<QualifiedSearchResult> {
  const target = Math.min(Math.max(Math.trunc(quantity), 1), 100);
  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 3), 1), 5);
  const pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 50), 1), 50);
  const pool: Offer[] = [];
  let selected: Offer[] = [];
  let pages = 0;
  let excluded = 0;
  let diagnostics: OfferFilterDiagnostics = { ...EMPTY_DIAGNOSTICS };

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await provider.search({ ...request, page, limit: pageSize });
    pages = page;
    pool.push(...batch);

    // Reserva suficiente para substituir produtos já publicados sem obrigar
    // a carregar todas as páginas quando a primeira já possui boas candidatas.
    const reserve = options.excludeOffer ? Math.min(Math.max(target * 8, 12), 50) : target;
    const analyzed = analyzeOffers(pool, {
      keyword: request.keyword,
      minCommission: request.minCommission,
      minDiscount: request.minDiscount,
      maxPrice: request.maxPrice,
      limit: reserve,
    });

    diagnostics = analyzed.diagnostics;
    const qualified = analyzed.selected;
    const fresh = options.excludeOffer ? qualified.filter((offer) => !options.excludeOffer!(offer)) : qualified;
    excluded = Math.max(0, qualified.length - fresh.length);
    selected = fresh.slice(0, target);

    if (selected.length >= target) break;
    if (batch.length < pageSize) break;
  }

  return {
    selected,
    scanned: pool.length,
    pages,
    excluded,
    diagnostics: { ...diagnostics, excludedRecent: excluded },
  };
}
