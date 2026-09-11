import type { GeneratedContent, Publisher } from "../types";

export type PinterestPublisherInput = {
  accessToken: string;
  boardId: string;
  apiBase?: string;
};

type PinterestPinResponse = {
  id?: string;
};

function pinterestDescription(content: GeneratedContent) {
  // Pins podem circular por muito tempo. Evitamos repetir o link no texto porque
  // ele já é enviado no campo `link`, e limitamos a descrição a um tamanho seguro.
  const raw = [content.body, content.cta]
    .filter(Boolean)
    .join("\n\n")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return raw.slice(0, 500);
}

export function createPinterestPublisher(input: PinterestPublisherInput): Publisher {
  if (!input.accessToken) throw new Error("PINTEREST_ACCESS_TOKEN_MISSING");
  if (!input.boardId) throw new Error("PINTEREST_BOARD_ID_MISSING");

  const apiBase = (input.apiBase || "https://api.pinterest.com/v5").replace(/\/$/, "");

  return {
    channel: "pinterest",
    async publish(content: GeneratedContent) {
      if (!content.imageUrl) throw new Error("PINTEREST_IMAGE_REQUIRED");

      const response = await fetch(`${apiBase}/pins`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          board_id: input.boardId,
          link: content.affiliateUrl,
          title: content.title.slice(0, 100),
          description: pinterestDescription(content),
          media_source: {
            source_type: "image_url",
            url: content.imageUrl,
            is_standard: true,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const payload = await response.json().catch(() => null) as (PinterestPinResponse & { message?: string; code?: number }) | null;
      if (!response.ok || !payload?.id) {
        throw new Error(`PINTEREST_API_ERROR: ${payload?.message || `HTTP ${response.status}`}`);
      }

      return { externalId: String(payload.id) };
    },
  };
}
