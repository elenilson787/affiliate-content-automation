import type { GeneratedContent, Offer, SocialChannel } from "./types";

export function generateContent(offer: Offer, channel: SocialChannel): GeneratedContent {
  const affiliateUrl = offer.affiliateUrl || offer.url;
  const discount = offer.originalPrice && offer.originalPrice > offer.price
    ? Math.round(((offer.originalPrice - offer.price) / offer.originalPrice) * 100)
    : 0;

  const title = discount > 0 ? `🔥 ${offer.title} — ${discount}% OFF` : `🔥 ${offer.title}`;
  const body = `💰 Por apenas R$ ${offer.price.toFixed(2).replace(".", ",")}\n${offer.shopName ? `🏪 ${offer.shopName}\n` : ""}${discount > 0 ? `📉 Desconto de ${discount}%\n` : ""}\nConfira a oferta:`;

  return {
    channel,
    title,
    body,
    cta: `👉 Comprar agora: ${affiliateUrl}`,
    affiliateUrl,
    imageUrl: offer.imageUrl,
  };
}
