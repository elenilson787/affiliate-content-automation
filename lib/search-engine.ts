import type { AffiliateProvider, Offer, SearchRequest } from "./types";
import { selectOffers } from "./offer-engine";

export type QualifiedSearchResult = {
  selected: Offer[];
  scanned: number;
  pages: number;
};

export async function searchQualifiedOffers(
  provider: AffiliateProvider,
  request: SearchRequest,
  quantity: number,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<QualifiedSearchResult> {
  const target = Math.min(Math.max(Math.trunc(quantity), 1), 100);
  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 3), 1), 5);
  const pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 50), 1), 50);
  const pool: Offer[] = [];
  let selected: Offer[] = [];
  let pages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await provider.search({ ...request, page, limit: pageSize });
    pages = page;
    pool.push(...batch);

    selected = selectOffers(pool, {
      keyword: request.keyword,
      minCommission: request.minCommission,
      minDiscount: request.minDiscount,
      maxPrice: request.maxPrice,
      limit: target,
    });

    if (selected.length >= target) break;
    if (batch.length < pageSize) break;
  }

  return { selected, scanned: pool.length, pages };
}
