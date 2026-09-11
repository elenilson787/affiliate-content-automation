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

function privacyPage() {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Política de Privacidade — Affiliate Automation</title>
  <meta name="description" content="Política de Privacidade do Affiliate Automation.">
  <style>
    :root{color-scheme:dark;--bg:#050816;--panel:#0b1328;--line:#263a67;--ink:#f5f7ff;--muted:#a2acc5;--brand:#8b5cf6;--cyan:#22d3ee}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,rgba(91,61,255,.17),transparent 30%),var(--bg);color:var(--ink);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.65}
    main{width:min(920px,calc(100% - 32px));margin:48px auto;padding:34px;background:rgba(11,19,40,.92);border:1px solid var(--line);border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.35)}
    h1{font-size:clamp(28px,5vw,44px);line-height:1.1;margin:0 0 8px}h2{font-size:20px;margin:32px 0 8px;color:#fff}p,li{color:var(--muted)}strong{color:#fff}a{color:var(--cyan)}.brand{color:#c9b7ff;font-weight:800}.updated{font-size:13px;color:#7f8db0;margin-bottom:28px}.notice{padding:16px 18px;border:1px solid rgba(139,92,246,.45);border-radius:14px;background:rgba(139,92,246,.08)}ul{padding-left:22px}footer{margin-top:34px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:#7f8db0}
  </style>
</head>
<body>
<main>
  <div class="brand">Affiliate Automation</div>
  <h1>Política de Privacidade</h1>
  <div class="updated">Última atualização: 11 de setembro de 2026</div>

  <div class="notice">Esta Política explica como o <strong>Affiliate Automation</strong> trata dados quando uma pessoa usa o serviço ou conecta uma conta de terceiros, incluindo o Pinterest, para automatizar conteúdo de ofertas e afiliados.</div>

  <h2>1. Quem somos</h2>
  <p>O Affiliate Automation é uma plataforma de automação de conteúdo para afiliados. O serviço pesquisa e organiza ofertas, prepara conteúdo e, quando autorizado pelo usuário, pode publicar esse conteúdo em canais conectados.</p>

  <h2>2. Dados que podemos tratar</h2>
  <p>Dependendo das integrações utilizadas, podemos tratar os seguintes dados:</p>
  <ul>
    <li>informações técnicas necessárias à operação e segurança do serviço, como registros de execução, data, horário e status de ações;</li>
    <li>configurações criadas pelo usuário, como filtros de ofertas, agendas, destinos, templates e preferências;</li>
    <li>dados públicos ou autorizados das plataformas conectadas, como identificador da conta, nome de usuário, perfil, pastas/boards, Pins e identificadores de publicações;</li>
    <li>tokens OAuth e credenciais técnicas concedidas pelas plataformas para executar ações autorizadas.</li>
  </ul>
  <p><strong>Não solicitamos nem armazenamos a senha da conta Pinterest.</strong> A autorização é realizada pelo fluxo oficial OAuth disponibilizado pela própria plataforma.</p>

  <h2>3. Integração com Pinterest</h2>
  <p>Quando o usuário conecta o Pinterest, o Affiliate Automation pode, conforme as permissões concedidas:</p>
  <ul>
    <li>identificar a conta autorizada;</li>
    <li>listar pastas/boards disponíveis para que o usuário escolha o destino;</li>
    <li>ler informações necessárias para gerenciar conteúdo autorizado;</li>
    <li>criar Pins contendo imagem, título, descrição e link definido pelo usuário ou pela automação;</li>
    <li>verificar o resultado das publicações e manter histórico operacional.</li>
  </ul>
  <p>O acesso é limitado às permissões efetivamente autorizadas. O usuário pode desconectar a integração, interrompendo novas ações automatizadas.</p>

  <h2>4. Como usamos os dados</h2>
  <p>Usamos os dados somente para:</p>
  <ul>
    <li>autenticar integrações e manter a sessão autorizada;</li>
    <li>executar buscas, filtros, planejamento e publicações configuradas pelo usuário;</li>
    <li>mostrar pastas, destinos, status, métricas e histórico no painel;</li>
    <li>detectar erros, prevenir abuso, evitar duplicidade e manter a segurança do serviço;</li>
    <li>cumprir obrigações legais quando aplicável.</li>
  </ul>
  <p>O Affiliate Automation <strong>não vende dados pessoais</strong> a anunciantes ou terceiros.</p>

  <h2>5. Compartilhamento e operadores</h2>
  <p>Podemos utilizar prestadores de infraestrutura necessários para operar o serviço, como hospedagem, banco de dados e processamento em nuvem. Esses fornecedores recebem somente os dados necessários à prestação técnica do serviço. Dados também são enviados às plataformas conectadas, como o Pinterest, quando isso é necessário para executar uma ação solicitada ou programada pelo usuário.</p>

  <h2>6. Segurança</h2>
  <p>Adotamos controles técnicos destinados a proteger credenciais e dados de integração, incluindo armazenamento protegido de segredos, criptografia de tokens quando aplicável, controle de acesso administrativo e uso de HTTPS.</p>

  <h2>7. Retenção e exclusão</h2>
  <p>Dados de conexão são mantidos enquanto necessários para fornecer a integração. Ao desconectar uma conta, o serviço deixa de realizar novas ações com essa autorização. Registros operacionais podem ser mantidos por período razoável para segurança, auditoria, prevenção de duplicidade e diagnóstico de falhas. Solicitações de exclusão de dados podem ser realizadas pelo canal de suporte disponibilizado no aplicativo.</p>

  <h2>8. Direitos do titular</h2>
  <p>Quando aplicável, inclusive nos termos da Lei Geral de Proteção de Dados Pessoais (LGPD), o titular pode solicitar confirmação de tratamento, acesso, correção, informação, portabilidade quando cabível, eliminação de dados tratados com consentimento, revogação do consentimento e demais direitos previstos em lei.</p>

  <h2>9. Links de afiliado e serviços de terceiros</h2>
  <p>O conteúdo automatizado pode conter links de afiliado e levar a sites ou aplicativos de terceiros. O tratamento de dados realizado nesses ambientes é regido pelas respectivas políticas de privacidade. A utilização do Pinterest também está sujeita aos termos e políticas do Pinterest.</p>

  <h2>10. Crianças e adolescentes</h2>
  <p>O Affiliate Automation é destinado ao uso profissional e comercial e não é direcionado intencionalmente a crianças.</p>

  <h2>11. Alterações desta Política</h2>
  <p>Esta Política poderá ser atualizada para refletir novas integrações, recursos, requisitos legais ou mudanças operacionais. A data da versão mais recente será sempre indicada no início desta página.</p>

  <h2>12. Contato</h2>
  <p>Para dúvidas ou solicitações relacionadas à privacidade, utilize o canal de suporte disponibilizado no painel do Affiliate Automation ou o canal oficial indicado pela conta comercial associada ao serviço.</p>

  <footer>Affiliate Automation · Política pública de privacidade</footer>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
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
      privacy: "/privacy",
      config: safeConfig(env),
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method === "GET" && ["/privacy", "/privacy/", "/politica-de-privacidade", "/politica-de-privacidade/"].includes(url.pathname)) {
    return privacyPage();
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
