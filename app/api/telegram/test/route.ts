import { NextResponse } from "next/server";
import { createTelegramPublisher } from "@/lib/publishers/telegram";
import type { GeneratedContent } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const content: GeneratedContent = {
      channel: "telegram",
      title: typeof body.title === "string" ? body.title : "🔥 Teste Telegram",
      body: typeof body.message === "string" ? body.message : "Mensagem de teste do affiliate-content-automation.",
      cta: typeof body.cta === "string" ? body.cta : "👉 Teste concluído",
      affiliateUrl: typeof body.affiliateUrl === "string" ? body.affiliateUrl : "https://example.com",
      imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : undefined,
    };

    const publisher = createTelegramPublisher();
    const result = await publisher.publish(content);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida";
    const status = message.startsWith("TELEGRAM_NOT_CONFIGURED") ? 503 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
