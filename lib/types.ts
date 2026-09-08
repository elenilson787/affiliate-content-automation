export type AffiliateNetwork = "shopee" | "amazon" | "mercadolivre" | "magalu" | "aliexpress" | string;
export type SocialChannel = "telegram" | "whatsapp" | "facebook" | "instagram" | "threads" | string;

export type Offer = {
  id: string;
  network: AffiliateNetwork;
  title: string;
  productUrl: string;
  affiliateUrl?: string;
  imageUrl?: string;
  price?: number;
  originalPrice?: number;
  discountPercent?: number;
  commissionPercent?: number;
  commissionValue?: number;
  category?: string;
  availability?: boolean;
  sourceMetadata?: Record<string, unknown>;
};

export type SearchRequest = {
  keyword: string;
  category?: string;
  minCommission?: number;
  maxPrice?: number;
  minDiscount?: number;
  limit?: number;
  page?: number;
  sort?: "commission" | "price" | "sales" | "discount";
};

export type AffiliateProvider = {
  network: AffiliateNetwork;
  search(request: SearchRequest): Promise<Offer[]>;
  createAffiliateUrl?(inputUrl: string, trackingId?: string): Promise<string>;
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
  channel: SocialChannel;
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
