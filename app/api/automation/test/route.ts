import { NextResponse } from "next/server";
import { affiliateRegistry } from "@/lib/affiliate-registry";
import { runAutomation } from "@/lib/automation-engine";
import { createShopeeProvider } from "@/lib/affiliate/shopee";
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
    if (!keyword) {
      return NextResponse.json({ error: "Informe keyword." }, { status: 400 });
    }

    const quantity = Math.min(Math.max(Math.trunc(Number(body.quantity ?? 5)), 1), 20);
    const rule: AutomationRule = {
      keyword,
      quantity,
      minCommission: numberOrUndefined(body.minCommission),
      maxPrice: numberOrUndefined(body.maxPrice),
      minDiscount: numberOrUndefined(body.minDiscount),
    };

    const appId = process.env.SHOPEE_APP_ID;
    const secret = process.env.SHOPEE_SECRET;
    if (!appId || !secret) {
      return NextResponse.json(
        { error: "SHOPEE_NOT_CONFIGURED", message: "Configure SHOPEE_APP_ID e SHOPEE_SECRET." },
        { status: 503 },
      );
    }

    affiliateRegistry.register(createShopeeProvider({ appId, secret }));

    const result = await runAutomation(
      {
        networks: ["shopee"],
        channels: [],
        rules: [rule],
        avoidRepeatDays: 0,
      },
      { dryRun: true },
    );

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: "AUTOMATION_TEST_FAILED", message: error instanceof Error ? error.message : "Falha desconhecida" },
      { status: 500 },
    );
  }
}
