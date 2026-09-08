export type AffiliateNetwork = "shopee" | "amazon" | "mercadolivre" | "magalu" | "aliexpress" | string;
export type SocialChannel = "telegram" | "whatsapp" | "facebook" | "instagram" | "threads" | string;

export type Offer = {
  id: string;
  network: AffiliateNetwork;
  title: string;
  url: string;
  affiliateUrl?: string;
  imageUrl?: string;
  price: number;
  originalPrice?: number;
  commission?: number;
  shopName?: string;
  category?: string;
  metadata?: Record<string, unknown>;
};

export type SearchRequest = {
  keyword: string;
  category?: string;
  minCommission?: number;
  maxPrice?: number;
  minDiscount?: number;
  limit?: number;
};

export type AffiliateProvider = {
  id: AffiliateNetwork;
  search(request: SearchRequest): Promise<Offer[]>;
  createAffiliateUrl?(offer: Offer): Promise<string>;
};

export type GeneratedContent = {
  channel: SocialChannel;
  title: string;
  body: string;
  cta: string;
  affiliateUrl: string;
  imageUrl?: string;
};

export type Publisher = {
  id: SocialChannel;
  publish(content: GeneratedContent): Promise<{ externalId?: string }>;
};

export type AutomationRule = {
  keyword: string;
  minCommission?: number;
  maxPrice?: number;
  minDiscount?: number;
  quantity?: number;
};

export type AutomationConfig = {
  networks: AffiliateNetwork[];
  channels: SocialChannel[];
  rules: AutomationRule[];
  avoidRepeatDays: number;
};
