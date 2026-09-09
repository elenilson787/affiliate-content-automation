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

// Marcadores fortes de peça/acessório. Diferente de ACCESSORY_LEADS,
// estes bloqueiam mesmo quando aparecem no meio do título, porque normalmente
// indicam que o anúncio é de reposição e não do produto principal.
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

function keywordRequestsAccessory(keyword: string) {
  const value = normalized(keyword);
  return ACCESSORY_LEADS.some((lead) => value === lead || value.startsWith(`${lead} `) || value.includes(` ${lead} `));
}

export function offerLooksLikeAccessory(offer: Offer, keyword: string) {
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

  // Títulos do mesmo item em lojas diferentes normalmente ficam acima de 0,80.
  // Para a mesma marca/família, usamos limiar menor para evitar variantes quase idênticas
  // (ex.: 5 em 1 vs 7 em 1) ocupando ciclos consecutivos.
  return similarity >= 0.8 || (sameBrand && similarity >= 0.64);
}

export function discountPercent(offer: Offer) {
  if (!offer.originalPrice || offer.price == null || offer.originalPrice <= offer.price) return 0;
  return ((offer.originalPrice - offer.price) / offer.originalPrice) * 100;
}

export function offerIsRelevant(offer: Offer, keyword: string) {
  const haystack = normalized(`${offer.title} ${offer.category || ""}`);
  const terms = normalized(keyword).split(/\s+/).filter((term) => term.length >= 3);

  // Em buscas compostas (ex.: "escova secadora"), todos os termos relevantes
  // precisam aparecer. Isso reduz resultados semanticamente próximos, mas errados.
  if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) return false;
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
  const seenOffers = new Set<string>();
  const seenProducts: Offer[] = [];

  return pool
    .filter((offer) => offerIsRelevant(offer, input.keyword))
    .filter(offerHasTrustSignals)
    .filter((offer) => input.minCommission == null || (offer.commissionPercent ?? 0) >= input.minCommission)
    .filter((offer) => input.maxPrice == null || offer.price == null || offer.price <= input.maxPrice)
    .filter((offer) => input.minDiscount == null || (offer.discountPercent ?? discountPercent(offer)) >= input.minDiscount)
    .sort((a, b) => rankOffer(b) - rankOffer(a))
    .filter((offer) => {
      const key = offerKey(offer);
      if (seenOffers.has(key) || seenProducts.some((existing) => productsLookEquivalent(existing, offer))) return false;
      seenOffers.add(key);
      seenProducts.push(offer);
      return true;
    })
    .slice(0, input.limit || 10);
}
