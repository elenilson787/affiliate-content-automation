import type { AffiliateProvider, AffiliateNetwork, Offer, SearchRequest } from "./types";

export class AffiliateRegistry {
  private readonly providers = new Map<AffiliateNetwork, AffiliateProvider>();

  register(provider: AffiliateProvider) {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: AffiliateNetwork) {
    return this.providers.get(id);
  }

  async search(networks: AffiliateNetwork[], request: SearchRequest) {
    const providers = networks
      .map((id) => this.providers.get(id))
      .filter((provider): provider is AffiliateProvider => Boolean(provider));

    const batches = await Promise.all(
      providers.map(async (provider) => {
        try {
          return await provider.search(request);
        } catch {
          return [] as Offer[];
        }
      }),
    );

    return batches.flat();
  }
}

export const affiliateRegistry = new AffiliateRegistry();
