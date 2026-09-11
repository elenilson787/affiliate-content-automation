import type { GeneratedContent, Offer, SocialChannel } from "./types";

export type ContentTemplate = "offer" | "natural" | "storytelling" | "no_price";

export type ContentOptions = {
  template?: ContentTemplate;
  messageThreadId?: number;
  pinterestBoardId?: string;
};

function brl(value?: number) {
  if (value == null || !Number.isFinite(value)) return "Preço não informado";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function cleanTitle(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function generateContent(offer: Offer, channel: SocialChannel, options: ContentOptions = {}): GeneratedContent {
  const affiliateUrl = offer.affiliateUrl || offer.productUrl;
  const discount = Math.round(offer.discountPercent ?? 0);
  const price = brl(offer.price);
  const product = cleanTitle(offer.title);
  const template = options.template || "offer";

  let title = discount > 0 ? `🔥 ${product} — ${discount}% OFF` : `🔥 ${product}`;
  let body: string;
  let cta: string;

  if (template === "natural") {
    title = `✨ Uma opção interessante: ${product}`;
    body = [
      "Pra quem está procurando algo nessa linha, encontrei esta opção e achei que valia compartilhar.",
      "",
      product,
      offer.price != null ? `💰 Hoje aparece por ${price}` : "",
      discount > 0 ? `📉 O anúncio indica ${discount}% de desconto` : "",
      "",
      "Dá uma olhada nos detalhes e avaliações antes de decidir:",
    ].filter(Boolean).join("\n");
    cta = `👉 Ver na Shopee: ${affiliateUrl}`;
  } else if (template === "storytelling") {
    title = `💡 Achado para facilitar a rotina`;
    body = [
      "Sabe quando uma tarefa simples começa a tomar mais tempo do que deveria? Esse tipo de produto pode ser uma alternativa prática para deixar a rotina mais rápida.",
      "",
      product,
      offer.price != null ? `💰 ${price}` : "",
      discount > 0 ? `📉 ${discount}% de desconto no anúncio` : "",
      "",
      "Deixei o link para quem quiser conferir as especificações:",
    ].filter(Boolean).join("\n");
    cta = `👉 Conferir: ${affiliateUrl}`;
  } else if (template === "no_price") {
    title = `👀 Olha este achado: ${product}`;
    body = [
      "Encontrei esta opção enquanto pesquisava produtos dessa categoria.",
      "",
      product,
      discount > 0 ? `📉 O anúncio está marcando ${discount}% de desconto` : "",
      "",
      "Como preço e estoque podem mudar, vale abrir o link para conferir o valor atual:",
    ].filter(Boolean).join("\n");
    cta = `👉 Ver oferta atual: ${affiliateUrl}`;
  } else {
    body = [
      title,
      "",
      offer.price != null ? `💰 ${price}` : "",
      discount > 0 ? `📉 Desconto de ${discount}%` : "",
      "",
      "Confira os detalhes da oferta:",
    ].filter(Boolean).join("\n");
    cta = `👉 Ver na Shopee: ${affiliateUrl}`;
  }

  return {
    channel,
    title,
    body,
    cta,
    affiliateUrl,
    imageUrl: offer.imageUrl,
    messageThreadId: options.messageThreadId,
    pinterestBoardId: options.pinterestBoardId,
  };
}
