import type { GeneratedContent, Publisher } from "../types";

const TELEGRAM_API = "https://api.telegram.org";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`TELEGRAM_NOT_CONFIGURED: ${name}`);
  return value;
}

async function telegramRequest<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: T } | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(`TELEGRAM_API_ERROR: ${payload?.description || `HTTP ${response.status}`}`);
  }
  return payload.result as T;
}

export function createTelegramPublisher(input?: { token?: string; chatId?: string }): Publisher {
  const token = input?.token || requiredEnv("TELEGRAM_BOT_TOKEN");
  const chatId = input?.chatId || requiredEnv("TELEGRAM_CHAT_ID");

  return {
    channel: "telegram",
    async publish(content: GeneratedContent) {
      const caption = `${content.body}\n\n${content.cta}`;

      if (content.imageUrl) {
        const result = await telegramRequest<{ message_id: number }>(token, "sendPhoto", {
          chat_id: chatId,
          photo: content.imageUrl,
          caption: caption.slice(0, 1024),
        });
        return { externalId: String(result.message_id) };
      }

      const result = await telegramRequest<{ message_id: number }>(token, "sendMessage", {
        chat_id: chatId,
        text: caption,
        disable_web_page_preview: false,
      });
      return { externalId: String(result.message_id) };
    },
  };
}
