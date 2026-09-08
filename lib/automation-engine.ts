import { affiliateRegistry } from "./affiliate-registry";
import { generateContent } from "./content-engine";
import { offerKey, selectOffers } from "./offer-engine";
import { publisherRegistry } from "./publisher-registry";
import type { AutomationConfig, Offer } from "./types";

export type AutomationRunOptions = {
  dryRun?: boolean;
};

export async function runAutomation(config: AutomationConfig, options: AutomationRunOptions = {}) {
  const selected: Offer[] = [];
  const seen = new Set<string>();

  for (const rule of config.rules) {
    const quantity = Math.max(1, rule.quantity || 1);
    const pool = await affiliateRegistry.search(config.networks, {
      keyword: rule.keyword,
      minCommission: rule.minCommission,
      maxPrice: rule.maxPrice,
      minDiscount: rule.minDiscount,
      limit: Math.min(quantity * 5, 50),
    });

    for (const offer of selectOffers(pool, { ...rule, limit: quantity })) {
      const key = offerKey(offer);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(offer);
    }
  }

  const publications = selected.map((offer) => ({
    offer,
    results: options.dryRun
      ? config.channels.map((channel) => ({ channel, status: "dry_run" as const, content: generateContent(offer, channel) }))
      : undefined,
  }));

  if (!options.dryRun) {
    for (const publication of publications) {
      publication.results = await publisherRegistry.publish(
        config.channels,
        (channel) => generateContent(publication.offer, channel),
      );
    }
  }

  return {
    selected: selected.length,
    dryRun: options.dryRun === true,
    publications,
  };
}
