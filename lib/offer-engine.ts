import type { Offer } from "./types";

function normalized(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ACCESSORY_LEADS = [
  "kit suporte",
  "kit de suporte",
  "suporte",
  "porta",
  "descanso",
  "organizador",
  "capa",
  "case",
  "estojo",
  "bolsa",
  "adaptador",
  "acessorio",
  "peca de reposicao",
  "peca reposicao",
  "reposicao",
  "refil",
];

function sourceMetric(offer: Offer, key: string) {
  const raw = offer.sourceMetadata?.[key];
  if (raw == null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function keywordRequestsAccessory(keyword: string) {
  const value = normalized(keyword);
  return ACCESSORY_LEADS.some((lead) => value === lead || value.startsWith(`${lead} `) || value.includes(` ${lead} `));
}

export function offerLooksLikeAccessory(offer: Offer, keyword: string) {
  if (keywordRequestsAccessory(keyword)) return false;
  const title = normalized(offer.title);
  return ACCESSORY_LEADS.some((lead) => title === lead || title.startsWith(`${lead} `));
}

export function offerKey(offer: Offer) {
  return `${offer.network}:${offer.id}`;
}

export function discountPercent(offer: Offer) {
  if (!offer.originalPrice || offer.price == null || offer.originalPrice <= offer.price) return 0;
  return ((offer.originalPrice - offer.price) / offer.originalPrice) * 100;
}

export function offerIsRelevant(offer: Offer, keyword: string) {
  const haystack = normalized(`${offer.title} ${offer.category || ""}`);
  const terms = normalized(keyword).split(/\s+/).filter((term) => term.length >= 3);
  if (terms.length > 0 && !terms.some((term) => haystack.includes(term))) return false;
  if (offerLooksLikeAccessory(offer, keyword)) return false;
  return true;
}

export function offerHasTrustSignals(offer: Offer) {
  const sales = sourceMetric(offer, "sales");
  const rating = sourceMetric(offer, "rating");

  // Quando a rede fornece métricas explicitamente zeradas, tratamos a oferta
  // como inadequada para publicação automática. Métrica ausente não bloqueia.
  if (sales !== undefined && sales <= 0) return false;
  if (rating !== undefined && rating <= 0) return false;
  return true;
}

export function rankOffer(offer: Offer) {
  const discount = offer.discountPercent ?? discountPercent(offer);
  const commission = Math.max(0, offer.commissionPercent ?? 0);
  const sales = Math.max(0, sourceMetric(offer, "sales") ?? 0);
  const rating = Math.max(0, Math.min(5, sourceMetric(offer, "rating") ?? 0));
  const trustBonus = rating * 2 + Math.log10(sales + 1) * 3;
  return discount * 0.55 + commission * 0.35 + trustBonus;
}

export function selectOffers(
  pool: Offer[],
  input: {
    keyword: string;
    minCommission?: number;
    maxPrice?: number;
    minDiscount?: number;
    limit?: number;
  },
) {
  const seen = new Set<string>();

  return pool
    .filter((offer) => offerIsRelevant(offer, input.keyword))
    .filter(offerHasTrustSignals)
    .filter((offer) => input.minCommission == null || (offer.commissionPercent ?? 0) >= input.minCommission)
    .filter((offer) => input.maxPrice == null || offer.price == null || offer.price <= input.maxPrice)
    .filter((offer) => input.minDiscount == null || (offer.discountPercent ?? discountPercent(offer)) >= input.minDiscount)
    .filter((offer) => {
      const key = offerKey(offer);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => rankOffer(b) - rankOffer(a))
    .slice(0, input.limit || 10);
}
