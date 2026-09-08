import { affiliateRegistry } from "./affiliate-registry";
import { generateContent } from "./content-engine";
import { offerKey, selectOffers } from "./offer-engine";
import { publisherRegistry } from "./publisher-registry";
import type { AutomationConfig, Offer } from "./types";

export async function runAutomation(config: AutomationConfig) {
  const selected: Offer[] = [];
  const seen = new Set<string>();

  for (const rule of config.rules) {
    const pool = await affiliateRegistry.search(config.networks, {
      keyword: rule.keyword,
      minCommission: rule.minCommission,
      maxPrice: rule.maxPrice,
      minDiscount: rule.minDiscount,
      limit: Math.max((rule.quantity || 1) * 3, 10),
    });

    for (const offer of selectOffers(pool, rule)) {
      const key = offerKey(offer);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(offer);
      if (selected.length >= (rule.quantity || 1)) break;
    }
  }

  const publications = [];
  for (const offer of selected) {
    publications.push({
      offer,
      results: await publisherRegistry.publish(
        config.channels,
        (channel) => generateContent(offer, channel),
      ),
    });
  }

  return { selected: selected.length, publications };
}
