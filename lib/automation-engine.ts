import { affiliateRegistry } from "./affiliate-registry";
import { generateContent } from "./content-engine";
import { offerKey, selectOffers } from "./offer-engine";
import { publisherRegistry } from "./publisher-registry";
import type { DedupeStore } from "./dedupe-store";
import type { AutomationConfig, GeneratedContent, Offer, SocialChannel } from "./types";

export type AutomationRunOptions = {
  dryRun?: boolean;
  dedupeStore?: DedupeStore;
};

type PublicationResult =
  | { channel: SocialChannel; status: "dry_run"; content: GeneratedContent }
  | { channel: SocialChannel; status: "skipped_duplicate" }
  | { channel: SocialChannel; status: "sent" | "failed" | "not_configured"; externalId?: string; error?: string };

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

  const publications: { offer: Offer; results?: PublicationResult[] }[] = selected.map((offer) => ({ offer }));

  for (const publication of publications) {
    const results: PublicationResult[] = [];
    const key = offerKey(publication.offer);

    for (const channel of config.channels) {
      const content = generateContent(publication.offer, channel);

      if (options.dryRun) {
        results.push({ channel, status: "dry_run", content });
        continue;
      }

      if (options.dedupeStore && config.avoidRepeatDays > 0) {
        const duplicate = await options.dedupeStore.wasPublishedRecently(
          key,
          channel,
          config.avoidRepeatDays,
        );
        if (duplicate) {
          results.push({ channel, status: "skipped_duplicate" });
          continue;
        }
      }

      const result = await publisherRegistry.publishOne(channel, content);
      results.push(result);

      if (result.status === "sent" && options.dedupeStore) {
        await options.dedupeStore.recordPublication({
          offerKey: key,
          network: publication.offer.network,
          offerId: publication.offer.id,
          channel,
          externalId: result.externalId,
          metadata: {
            title: publication.offer.title,
            price: publication.offer.price,
            discountPercent: publication.offer.discountPercent,
            commissionPercent: publication.offer.commissionPercent,
          },
        });
      }
    }

    publication.results = results;
  }

  return {
    selected: selected.length,
    dryRun: options.dryRun === true,
    publications,
  };
}
