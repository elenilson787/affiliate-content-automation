import type { GeneratedContent, Publisher, SocialChannel } from "./types";

export class PublisherRegistry {
  private readonly publishers = new Map<SocialChannel, Publisher>();

  register(publisher: Publisher) {
    this.publishers.set(publisher.id, publisher);
    return this;
  }

  async publish(channels: SocialChannel[], contentFactory: (channel: SocialChannel) => GeneratedContent) {
    return Promise.all(channels.map(async (channel) => {
      const publisher = this.publishers.get(channel);
      if (!publisher) return { channel, status: "not_configured" as const };
      try {
        const result = await publisher.publish(contentFactory(channel));
        return { channel, status: "sent" as const, ...result };
      } catch (error) {
        return { channel, status: "failed" as const, error: error instanceof Error ? error.message : "Falha desconhecida" };
      }
    }));
  }
}

export const publisherRegistry = new PublisherRegistry();
