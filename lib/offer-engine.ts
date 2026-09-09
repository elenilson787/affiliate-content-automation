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
  "cerdas",
  "cerda",
  "bico",
  "cabo",
  "resistencia",
];

const STRONG_ACCESSORY_MARKERS = [
  "peca de reposicao",
  "peca reposicao",
  "refil",
  "cerdas para",
  "cerda para",
  "kit de cerdas",
  "kit cerdas",
  "bico para",
  "cabo para",
  "resistencia para",
  "compativel com",
];

function sourceMetric(offer: Offer, key: string) {
  const raw = offer.sourceMetadata?.[key];
  if (raw == null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function offerSales(offer: Offer) {
  return sourceMetric(offer, "sales");
}

export function offerRating(offer: Offer) {
  return sourceMetric(offer, "rating");
}

function keywordRequestsAccessory(keyword: string) {
  const value = normalized(keyword);
  return ACCESSORY_LEADS.some((lead) => value === lead || value.startsWith(`${lead} `) || value.includes(` ${lead} `));
}

export function offerLooksLikeAccessory(offer: Offer, keyword: string) {
  // Em busca ampla não tratamos palavras como bolsa/capa/organizador como acessório,
  // porque elas podem ser o próprio produto desejado.
  if (!normalized(keyword)) return false;
  if (keywordRequestsAccessory(keyword)) return false;
  const title = normalized(offer.title);

  if (ACCESSORY_LEADS.some((lead) => title === lead || title.startsWith(`${lead} `))) return true;
  return STRONG_ACCESSORY_MARKERS.some((marker) => title === marker || title.includes(` ${marker} `) || title.endsWith(` ${marker}`));
}

export function offerKey(offer: Offer) {
  const prefix = `${offer.network}:`;
  return offer.id.startsWith(prefix) ? offer.id : `${prefix}${offer.id}`;
}

const PRODUCT_NOISE = new Set([
  "de", "da", "do", "das", "dos", "e", "em", "para", "com", "sem", "por", "um", "uma",
  "novo", "nova", "original", "oficial", "produto", "promocao", "oferta", "kit", "conjunto", "profissional",
  "alta", "velocidade", "bivolt", "voltagem", "110v", "127v", "220v", "110", "127", "220",
]);

function identityTokens(title: string) {
  return normalized(title)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !PRODUCT_NOISE.has(token));
}

function modelTokens(tokens: string[]) {
  return tokens.filter((token) => /[a-z]/.test(token) && /\d/.test(token) && token.length >= 3);
}

function likelyBrand(tokens: string[]) {
  const generic = new Set([
    "escova", "secadora", "secador", "cabelo", "modeladora", "alisadora", "multifuncional", "rotativa",
    "eletrica", "eletrico", "air", "styler", "dryer", "hair", "shark",
  ]);
  return tokens.find((token) => !generic.has(token) && !/^\d+$/.test(token)) || "";
}

function diceSimilarity(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

export function productFingerprint(offer: Offer) {
  return Array.from(new Set(identityTokens(offer.title))).sort().join(" ");
}

export function productsLookEquivalent(a: Offer, b: Offer) {
  const left = identityTokens(a.title);
  const right = identityTokens(b.title);
  if (!left.length || !right.length) return false;

  const leftModels = modelTokens(left);
  const rightModels = modelTokens(right);
  if (leftModels.some((model) => rightModels.includes(model))) return true;

  const similarity = diceSimilarity(left, right);
  const leftBrand = likelyBrand(left);
  const rightBrand = likelyBrand(right);
  const sameBrand = Boolean(leftBrand && rightBrand && leftBrand === rightBrand);

  return similarity >= 0.8 || (sameBrand && similarity >= 0.64);
}

export function discountPercent(offer: Offer) {
  if (!offer.originalPrice || offer.price == null || offer.originalPrice <= offer.price) return 0;
  return ((offer.originalPrice - offer.price) / offer.originalPrice) * 100;
}

const SEARCH_STOP_WORDS = new Set([
  "a", "as", "o", "os", "de", "da", "das", "do", "dos", "e", "em", "com", "para", "por", "um", "uma",
  "no", "na", "nos", "nas", "ao", "aos", "se", "que", "pra",
]);

export function offerIsRelevant(offer: Offer, keyword: string) {
  const normalizedKeyword = normalized(keyword);
  if (!normalizedKeyword) return true;
  if (offerLooksLikeAccessory(offer, keyword)) return false;

  const haystack = normalized(`${offer.title} ${offer.category || ""}`);
  if (haystack.includes(normalizedKeyword)) return true;

  const terms = normalizedKeyword
    .split(/\s+/)
    .filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term));
  if (!terms.length) return true;

  const matches = terms.filter((term) => haystack.includes(term)).length;
  const required = terms.length <= 2 ? terms.length : Math.max(2, Math.ceil(terms.length * 0.6));
  return matches >= required;
}

export function offerHasTrustSignals(offer: Offer) {
  const sales = offerSales(offer);
  const rating = offerRating(offer);

  // Zero vendas e zero avaliação são válidos para anúncios novos.
  // Só descartamos métricas claramente inválidas. Produtos novos continuam
  // naturalmente abaixo no ranking porque não recebem bônus de vendas/avaliação.
  if (sales !== undefined && sales < 0) return false;
  if (rating !== undefined && (rating < 0 || rating > 5)) return false;
  return true;
}

export function rankOffer(offer: Offer) {
  const discount = offer.discountPercent ?? discountPercent(offer);
  const commission = Math.max(0, offer.commissionPercent ?? 0);
  const sales = Math.max(0, offerSales(offer) ?? 0);
  const rating = Math.max(0, Math.min(5, offerRating(offer) ?? 0));
  const trustBonus = rating * 2 + Math.log10(sales + 1) * 3;
  return discount * 0.55 + commission * 0.35 + trustBonus;
}

export type OfferSelectionInput = {
  keyword: string;
  minCommission?: number;
  maxPrice?: number;
  minDiscount?: number;
  sort?: "commission" | "price" | "sales" | "discount";
  limit?: number;
};

export type OfferFilterDiagnostics = {
  scanned: number;
  rejectedRelevance: number;
  invalidMetrics: number;
  belowCommission: number;
  belowDiscount: number;
  aboveMaxPrice: number;
  equivalentDuplicates: number;
  eligible: number;
  zeroSalesAccepted: number;
  zeroRatingAccepted: number;
};

function compareOffers(a: Offer, b: Offer, sort: OfferSelectionInput["sort"]) {
  const commissionA = Math.max(0, a.commissionPercent ?? 0);
  const commissionB = Math.max(0, b.commissionPercent ?? 0);
  const discountA = Math.max(0, a.discountPercent ?? discountPercent(a));
  const discountB = Math.max(0, b.discountPercent ?? discountPercent(b));
  const salesA = Math.max(0, offerSales(a) ?? 0);
  const salesB = Math.max(0, offerSales(b) ?? 0);
  const priceA = a.price ?? Number.POSITIVE_INFINITY;
  const priceB = b.price ?? Number.POSITIVE_INFINITY;

  if (sort === "commission") return commissionB - commissionA || discountB - discountA || salesB - salesA || rankOffer(b) - rankOffer(a);
  if (sort === "discount") return discountB - discountA || commissionB - commissionA || salesB - salesA || rankOffer(b) - rankOffer(a);
  if (sort === "sales") return salesB - salesA || commissionB - commissionA || discountB - discountA || rankOffer(b) - rankOffer(a);
  if (sort === "price") return priceA - priceB || salesB - salesA || commissionB - commissionA || discountB - discountA;
  return rankOffer(b) - rankOffer(a);
}

export function analyzeOffers(pool: Offer[], input: OfferSelectionInput) {
  const diagnostics: OfferFilterDiagnostics = {
    scanned: pool.length,
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

  const candidates: Offer[] = [];

  for (const offer of pool) {
    const relevant = offerIsRelevant(offer, input.keyword);
    const trusted = offerHasTrustSignals(offer);
    const commissionOk = input.minCommission == null || (offer.commissionPercent ?? 0) >= input.minCommission;
    const discountOk = input.minDiscount == null || (offer.discountPercent ?? discountPercent(offer)) >= input.minDiscount;
    const priceOk = input.maxPrice == null || offer.price == null || offer.price <= input.maxPrice;

    if (!relevant) diagnostics.rejectedRelevance += 1;
    if (!trusted) diagnostics.invalidMetrics += 1;
    if (!commissionOk) diagnostics.belowCommission += 1;
    if (!discountOk) diagnostics.belowDiscount += 1;
    if (!priceOk) diagnostics.aboveMaxPrice += 1;

    if (relevant && trusted && commissionOk && discountOk && priceOk) candidates.push(offer);
  }

  candidates.sort((a, b) => compareOffers(a, b, input.sort));

  const seenOffers = new Set<string>();
  const seenProducts: Offer[] = [];
  const unique: Offer[] = [];

  for (const offer of candidates) {
    const key = offerKey(offer);
    if (seenOffers.has(key) || seenProducts.some((existing) => productsLookEquivalent(existing, offer))) {
      diagnostics.equivalentDuplicates += 1;
      continue;
    }

    seenOffers.add(key);
    seenProducts.push(offer);
    unique.push(offer);

    if (offerSales(offer) === 0) diagnostics.zeroSalesAccepted += 1;
    if (offerRating(offer) === 0) diagnostics.zeroRatingAccepted += 1;
  }

  diagnostics.eligible = unique.length;

  return {
    selected: unique.slice(0, input.limit || 10),
    diagnostics,
  };
}

export function selectOffers(pool: Offer[], input: OfferSelectionInput) {
  return analyzeOffers(pool, input).selected;
}
