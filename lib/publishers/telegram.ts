import type { GeneratedContent, Publisher } from "../types";

const TELEGRAM_API = "https://api.telegram.org";

async function telegramRequest<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: T } | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(`TELEGRAM_API_ERROR: ${payload?.description || `HTTP ${response.status}`}`);
  }
  return payload.result as T;
}

export function createTelegramPublisher(input: { token: string; chatId: string }): Publisher {
  if (!input.token || !input.chatId) throw new Error("TELEGRAM_NOT_CONFIGURED");

  return {
    channel: "telegram",
    async publish(content: GeneratedContent) {
      const caption = `${content.body}\n\n${content.cta}`;

      const thread = content.messageThreadId ? { message_thread_id: content.messageThreadId } : {};

      if (content.imageUrl) {
        const result = await telegramRequest<{ message_id: number }>(input.token, "sendPhoto", {
          chat_id: input.chatId,
          photo: content.imageUrl,
          caption: caption.slice(0, 1024),
          ...thread,
        });
        return { externalId: String(result.message_id) };
      }

      const result = await telegramRequest<{ message_id: number }>(input.token, "sendMessage", {
        chat_id: input.chatId,
        text: caption,
        disable_web_page_preview: false,
        ...thread,
      });
      return { externalId: String(result.message_id) };
    },
  };
}
