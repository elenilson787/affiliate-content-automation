import type { AffiliateProvider, AffiliateNetwork, Offer, SearchRequest } from "./types";

export class AffiliateRegistry {
  private readonly providers = new Map<AffiliateNetwork, AffiliateProvider>();

  register(provider: AffiliateProvider) {
    this.providers.set(provider.network, provider);
    return this;
  }

  get(network: AffiliateNetwork) {
    return this.providers.get(network);
  }

  async search(networks: AffiliateNetwork[], request: SearchRequest) {
    const providers = networks
      .map((network) => this.providers.get(network))
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
