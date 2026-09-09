import { createShopeeProvider } from "../lib/affiliate/shopee/adapter";
import { generateContent } from "../lib/content-engine";
import { searchQualifiedOffers } from "../lib/search-engine";
import { adminPage, handleAdminApi } from "./admin";
import { runFullTick, schedulerTick, workerTick } from "./automation";
import { required, type Env } from "./env";

type CloudflareScheduledController = {
  cron: string;
  scheduledTime: number;
};

type CloudflareExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function authorized(request: Request, env: Env) {
  if (!env.AUTOMATION_SECRET) return false;
  return request.headers.get("authorization") === `Bearer ${env.AUTOMATION_SECRET}`;
}

function safeConfig(env: Env) {
  return {
    shopee: Boolean(env.SHOPEE_APP_ID && env.SHOPEE_SECRET),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    supabase: Boolean(env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)),
    protectedEndpoints: Boolean(env.AUTOMATION_SECRET),
  };
}

async function manualTest(request: Request, env: Env) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword) return json({ error: "Informe keyword." }, 400);

  const quantityRaw = Number(body.quantity ?? 3);
  const quantity = Math.min(Math.max(Number.isFinite(quantityRaw) ? Math.trunc(quantityRaw) : 3, 1), 20);
  const numberOrUndefined = (value: unknown) => {
    if (value == null || value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const provider = createShopeeProvider({
    appId: required(env.SHOPEE_APP_ID, "SHOPEE_APP_ID"),
    secret: required(env.SHOPEE_SECRET, "SHOPEE_SECRET"),
  });

  const search = await searchQualifiedOffers(
    provider,
    {
      keyword,
      minCommission: numberOrUndefined(body.minCommission),
      minDiscount: numberOrUndefined(body.minDiscount),
      maxPrice: numberOrUndefined(body.maxPrice),
    },
    quantity,
    { maxPages: 3, pageSize: 50 },
  );

  return json({
    dryRun: true,
    selected: search.selected.length,
    scanned: search.scanned,
    pages: search.pages,
    publications: search.selected.map((offer) => ({
      offer,
      content: generateContent(offer, "telegram"),
    })),
  });
}

async function handleFetch(request: Request, env: Env) {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json({
      ok: true,
      service: "affiliate-content-automation",
      runtime: "cloudflare-workers",
      scheduler: "*/5 * * * *",
      admin: "/admin",
      config: safeConfig(env),
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    return adminPage();
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!authorized(request, env)) return json({ error: "UNAUTHORIZED" }, 401);
    try {
      return await handleAdminApi(request, env);
    } catch (error) {
      console.error("admin request failed", error);
      return json({
        error: "ADMIN_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : "Falha desconhecida",
      }, 500);
    }
  }

  if (!["/tick", "/scheduler", "/worker", "/test"].includes(url.pathname)) {
    return json({ error: "NOT_FOUND" }, 404);
  }
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!authorized(request, env)) return json({ error: "UNAUTHORIZED" }, 401);

  try {
    if (url.pathname === "/scheduler") return json(await schedulerTick(env));
    if (url.pathname === "/worker") return json(await workerTick(env));
    if (url.pathname === "/test") return await manualTest(request, env);
    return json(await runFullTick(env));
  } catch (error) {
    console.error("worker request failed", error);
    return json({
      error: "WORKER_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : "Falha desconhecida",
    }, 500);
  }
}

export default {
  fetch(request: Request, env: Env, _ctx: CloudflareExecutionContext) {
    return handleFetch(request, env);
  },

  async scheduled(controller: CloudflareScheduledController, env: Env, _ctx: CloudflareExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime);
    console.log("cron start", { cron: controller.cron, scheduledAt: scheduledAt.toISOString() });
    const result = await runFullTick(env, scheduledAt);
    console.log("cron complete", {
      dueRules: result.scheduler.dueRules,
      processed: result.worker.processed,
      recovered: result.worker.recovered,
    });
  },
};
