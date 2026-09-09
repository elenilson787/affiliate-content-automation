import type { AffiliateProvider, Offer, SearchRequest } from "./types";
import { selectOffers } from "./offer-engine";

export type QualifiedSearchResult = {
  selected: Offer[];
  scanned: number;
  pages: number;
  excluded: number;
};

type SearchOptions = {
  maxPages?: number;
  pageSize?: number;
  excludeOffer?: (offer: Offer) => boolean;
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

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await provider.search({ ...request, page, limit: pageSize });
    pages = page;
    pool.push(...batch);

    // Mantemos uma reserva de candidatas para poder descartar equivalentes já publicados
    // sem obrigar a buscar 3 páginas em todo ciclo.
    const reserve = options.excludeOffer ? Math.min(Math.max(target * 8, 12), 50) : target;
    const qualified = selectOffers(pool, {
      keyword: request.keyword,
      minCommission: request.minCommission,
      minDiscount: request.minDiscount,
      maxPrice: request.maxPrice,
      limit: reserve,
    });

    const fresh = options.excludeOffer ? qualified.filter((offer) => !options.excludeOffer!(offer)) : qualified;
    excluded = Math.max(0, qualified.length - fresh.length);
    selected = fresh.slice(0, target);

    if (selected.length >= target) break;
    if (batch.length < pageSize) break;
  }

  return { selected, scanned: pool.length, pages, excluded };
}
