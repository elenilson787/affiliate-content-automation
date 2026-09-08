import type { Offer } from "./types";

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function offerKey(offer: Offer) {
  return `${offer.network}:${offer.id}`;
}

export function discountPercent(offer: Offer) {
  if (!offer.originalPrice || offer.originalPrice <= offer.price) return 0;
  return ((offer.originalPrice - offer.price) / offer.originalPrice) * 100;
}

export function offerIsRelevant(offer: Offer, keyword: string) {
  const haystack = normalized(`${offer.title} ${offer.shopName || ""} ${offer.category || ""}`);
  const terms = normalized(keyword).split(/\s+/).filter((term) => term.length >= 3);
  return terms.length === 0 || terms.some((term) => haystack.includes(term));
}

export function rankOffer(offer: Offer) {
  const discount = discountPercent(offer);
  const commission = Math.max(0, offer.commission || 0);
  return discount * 0.6 + commission * 0.4;
}

export function selectOffers(pool: Offer[], input: { keyword: string; minCommission?: number; maxPrice?: number; minDiscount?: number; limit?: number }) {
  const seen = new Set<string>();
  return pool
    .filter((offer) => offerIsRelevant(offer, input.keyword))
    .filter((offer) => (input.minCommission == null || (offer.commission || 0) >= input.minCommission))
    .filter((offer) => (input.maxPrice == null || offer.price <= input.maxPrice))
    .filter((offer) => (input.minDiscount == null || discountPercent(offer) >= input.minDiscount))
    .filter((offer) => {
      const key = offerKey(offer);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => rankOffer(b) - rankOffer(a))
    .slice(0, input.limit || 10);
}
