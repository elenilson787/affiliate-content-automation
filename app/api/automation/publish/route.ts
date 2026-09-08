import { NextResponse } from "next/server";
import { affiliateRegistry } from "@/lib/affiliate-registry";
import { runAutomation } from "@/lib/automation-engine";
import { createSupabaseDedupeStore } from "@/lib/dedupe-store";
import { createShopeeProvider } from "@/lib/affiliate/shopee";
import { createTelegramPublisher } from "@/lib/publishers/telegram";
import { publisherRegistry } from "@/lib/publisher-registry";
import type { AutomationRule } from "@/lib/types";

export const runtime = "nodejs";

function numberOrUndefined(value: unknown) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    if (!keyword) return NextResponse.json({ error: "Informe keyword." }, { status: 400 });

    const quantity = Math.min(Math.max(Math.trunc(Number(body.quantity ?? 1)), 1), 20);
    const dryRun = body.dryRun !== false;
    const avoidRepeatDays = Math.min(Math.max(Math.trunc(Number(body.avoidRepeatDays ?? 7)), 0), 365);
    const rule: AutomationRule = {
      keyword,
      quantity,
      minCommission: numberOrUndefined(body.minCommission),
      maxPrice: numberOrUndefined(body.maxPrice),
      minDiscount: numberOrUndefined(body.minDiscount),
    };

    const shopeeAppId = process.env.SHOPEE_APP_ID;
    const shopeeSecret = process.env.SHOPEE_SECRET;
    if (!shopeeAppId || !shopeeSecret) {
      return NextResponse.json({ error: "SHOPEE_NOT_CONFIGURED" }, { status: 503 });
    }

    affiliateRegistry.register(createShopeeProvider({ appId: shopeeAppId, secret: shopeeSecret }));

    const channels = ["telegram"] as const;
    if (!dryRun) {
      publisherRegistry.register(createTelegramPublisher());
    }

    const dedupeStore = !dryRun && avoidRepeatDays > 0 ? createSupabaseDedupeStore() : undefined;

    const result = await runAutomation(
      {
        networks: ["shopee"],
        channels: [...channels],
        rules: [rule],
        avoidRepeatDays,
      },
      { dryRun, dedupeStore },
    );

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: "AUTOMATION_PUBLISH_FAILED", message: error instanceof Error ? error.message : "Falha desconhecida" },
      { status: 500 },
    );
  }
}
