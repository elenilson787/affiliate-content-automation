import type { GeneratedContent, Offer, SocialChannel } from "./types";

function brl(value?: number) {
  if (value == null || !Number.isFinite(value)) return "Preço não informado";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function generateContent(offer: Offer, channel: SocialChannel): GeneratedContent {
  const affiliateUrl = offer.affiliateUrl || offer.productUrl;
  const discount = Math.round(offer.discountPercent ?? 0);
  const commission = offer.commissionPercent ? `💵 Comissão: ${offer.commissionPercent.toFixed(1)}%\n` : "";
  const price = brl(offer.price);

  const title = discount > 0 ? `🔥 ${offer.title} — ${discount}% OFF` : `🔥 ${offer.title}`;
  const body = [
    title,
    "",
    `💰 ${price}`,
    discount > 0 ? `📉 Desconto de ${discount}%` : "",
    commission.trimEnd(),
    "",
    "Confira a oferta:",
  ].filter(Boolean).join("\n");

  return {
    channel,
    title,
    body,
    cta: `👉 Comprar agora: ${affiliateUrl}`,
    affiliateUrl,
    imageUrl: offer.imageUrl,
  };
}
