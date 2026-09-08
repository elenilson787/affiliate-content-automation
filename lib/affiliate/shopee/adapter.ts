import type { AffiliateProvider, Offer, SearchRequest } from "../../types";
import { callShopeeApi, generateShopeeAffiliateLink, type ShopeeCredentials } from "./client";

type ShopeeNode = {
  shopId?: string | number;
  itemId?: string | number;
  productName?: string;
  shopName?: string;
  imageUrl?: string;
  priceMin?: string | number;
  priceMax?: string | number;
  commissionRate?: string | number;
  sellerCommissionRate?: string | number;
  commission?: string | number;
  priceDiscountRate?: string | number;
  sales?: number;
  ratingStar?: number;
  productLink?: string;
  offerLink?: string;
};

type ShopeeResponse = { productOfferV2?: { nodes?: ShopeeNode[] } };

function percent(value: string | number | undefined) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return 0;
  return Math.abs(n as number) <= 1 ? (n as number) * 100 : (n as number);
}

function money(value: string | number | undefined) {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? Number(n) : undefined;
}

function mapOffer(node: ShopeeNode, index: number): Offer {
  const price = money(node.priceMin ?? node.priceMax);
  const discount = percent(node.priceDiscountRate);
  const commissionRate = percent(node.commissionRate);
  const id = String(node.itemId || `shopee-${index}`);
  return {
    id: `shopee:${node.shopId ? `${node.shopId}:` : ""}${id}`,
    network: "shopee",
    title: node.productName || "Produto Shopee",
    productUrl: node.productLink || node.offerLink || "https://shopee.com.br",
    affiliateUrl: node.offerLink || node.productLink || "https://shopee.com.br",
    imageUrl: node.imageUrl,
    price,
    originalPrice: price !== undefined && discount > 0 ? price / (1 - discount / 100) : undefined,
    discountPercent: discount || undefined,
    commissionPercent: commissionRate || undefined,
    commissionValue: money(node.commission),
    category: undefined,
    availability: true,
    sourceMetadata: {
      shopId: node.shopId,
      itemId: node.itemId,
      shopName: node.shopName,
      sellerCommissionRate: percent(node.sellerCommissionRate),
      sales: node.sales,
      rating: node.ratingStar,
    },
  };
}

export function createShopeeProvider(credentials: ShopeeCredentials): AffiliateProvider {
  return {
    network: "shopee",
    async search(request: SearchRequest) {
      const keyword = request.keyword.trim().slice(0, 80);
      const page = Math.min(Math.max(Math.trunc(request.page ?? 0), 0), 500);
      const limit = Math.min(Math.max(Math.trunc(request.limit ?? 50), 1), 50);
      const sortType = request.sort === "commission" ? 2 : request.sort === "price" ? 1 : 0;
      const query = `{ productOfferV2(keyword: ${JSON.stringify(keyword)}, listType: 0, sortType: ${sortType}, page: ${page}, limit: ${limit}) { nodes { shopId itemId productName shopName imageUrl priceMin priceMax priceDiscountRate commissionRate sellerCommissionRate commission sales ratingStar productLink offerLink } } }`;
      const data = await callShopeeApi<ShopeeResponse>(query, credentials);
      const nodes = Array.isArray(data.productOfferV2?.nodes) ? data.productOfferV2.nodes : [];
      return nodes.map(mapOffer);
    },
    async createAffiliateUrl(inputUrl: string, trackingId?: string) {
      return generateShopeeAffiliateLink(inputUrl, credentials, trackingId ? [trackingId] : []);
    },
  };
}
