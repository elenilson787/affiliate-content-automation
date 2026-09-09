import { SupabaseRest, eq, type AutomationRuleRow } from "./db";
import type { Env } from "./env";

type JsonObject = Record<string, unknown>;

type AdminRuleInput = {
  name?: unknown;
  enabled?: unknown;
  dry_run?: unknown;
  keyword?: unknown;
  category?: unknown;
  min_commission?: unknown;
  min_discount?: unknown;
  max_price?: unknown;
  quantity?: unknown;
  sort?: unknown;
  avoid_repeat_days?: unknown;
  schedule_cron?: unknown;
  timezone?: unknown;
  settings?: unknown;
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

function asString(value: unknown, max = 160) {
  if (typeof value !== "string") return undefined;
  return value.trim().slice(0, max);
}

function asNullableNumber(value: unknown, min: number, max: number) {
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

function rulePatch(input: AdminRuleInput, creating = false) {
  const patch: JsonObject = {};

  if (input.name !== undefined) {
    const value = asString(input.name, 120);
    if (!value) throw new Error("Nome da automação é obrigatório.");
    patch.name = value;
  } else if (creating) throw new Error("Nome da automação é obrigatório.");

  if (input.keyword !== undefined) {
    const value = asString(input.keyword, 120);
    if (!value) throw new Error("Palavra-chave é obrigatória.");
    patch.keyword = value;
  } else if (creating) throw new Error("Palavra-chave é obrigatória.");

  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  if (input.dry_run !== undefined) patch.dry_run = Boolean(input.dry_run);

  if (input.category !== undefined) patch.category = input.category === null ? null : asString(input.category, 120) || null;

  if (input.min_commission !== undefined) {
    const value = asNullableNumber(input.min_commission, 0, 100);
    if (value === undefined) throw new Error("Comissão mínima inválida.");
    patch.min_commission = value;
  }
  if (input.min_discount !== undefined) {
    const value = asNullableNumber(input.min_discount, 0, 100);
    if (value === undefined) throw new Error("Desconto mínimo inválido.");
    patch.min_discount = value;
  }
  if (input.max_price !== undefined) {
    const value = asNullableNumber(input.max_price, 0, 1_000_000);
    if (value === undefined) throw new Error("Preço máximo inválido.");
    patch.max_price = value;
  }
  if (input.quantity !== undefined) {
    const value = Number(input.quantity);
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("Quantidade deve ficar entre 1 e 100.");
    patch.quantity = value;
  }
  if (input.avoid_repeat_days !== undefined) {
    const value = Number(input.avoid_repeat_days);
    if (!Number.isInteger(value) || value < 0 || value > 365) throw new Error("Dias sem repetir deve ficar entre 0 e 365.");
    patch.avoid_repeat_days = value;
  }
  if (input.sort !== undefined) {
    const value = input.sort === null || input.sort === "" ? null : String(input.sort);
    if (value !== null && !["commission", "price", "sales", "discount"].includes(value)) throw new Error("Ordenação inválida.");
    patch.sort = value;
  }
  if (input.schedule_cron !== undefined) {
    const value = input.schedule_cron === null ? null : asString(input.schedule_cron, 100);
    if (value && value.split(/\s+/).length !== 5) throw new Error("Cron deve possuir 5 campos.");
    patch.schedule_cron = value || null;
  } else if (creating) patch.schedule_cron = "0 9-22 * * *";

  if (input.timezone !== undefined) {
    const value = asString(input.timezone, 80);
    if (!value) throw new Error("Timezone inválido.");
    try { new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format(new Date()); } catch { throw new Error("Timezone inválido."); }
    patch.timezone = value;
  } else if (creating) patch.timezone = "America/Sao_Paulo";

  if (input.settings !== undefined) {
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) throw new Error("Settings inválido.");
    patch.settings = input.settings;
  }

  if (creating) {
    patch.id = crypto.randomUUID();
    patch.networks = ["shopee"];
    patch.channels = ["telegram"];
    if (patch.enabled === undefined) patch.enabled = false;
    if (patch.dry_run === undefined) patch.dry_run = true;
    if (patch.quantity === undefined) patch.quantity = 1;
    if (patch.avoid_repeat_days === undefined) patch.avoid_repeat_days = 7;
    if (patch.settings === undefined) patch.settings = { purpose: "admin_ui", priority: 100, maxAttempts: 3 };
  }

  return patch;
}

function safeConfig(env: Env) {
  return {
    shopee: Boolean(env.SHOPEE_APP_ID && env.SHOPEE_SECRET),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    supabase: Boolean(env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)),
    protectedEndpoints: Boolean(env.AUTOMATION_SECRET),
  };
}

async function dashboard(env: Env) {
  const db = new SupabaseRest(env);
  const since24h = new Date(Date.now() - 86_400_000).toISOString();

  const [rules, runs, queue, published, logs, published24, queueOpen, failed24] = await Promise.all([
    db.select<AutomationRuleRow>("automation_rules", new URLSearchParams({ select: "*", order: "created_at.desc" })),
    db.select<JsonObject>("automation_runs", new URLSearchParams({ select: "*", order: "started_at.desc", limit: "20" })),
    db.select<JsonObject>("publication_queue", new URLSearchParams({ select: "*", order: "created_at.desc", limit: "40" })),
    db.select<JsonObject>("published_offers", new URLSearchParams({ select: "*", order: "published_at.desc", limit: "30" })),
    db.select<JsonObject>("publication_logs", new URLSearchParams({ select: "*", order: "created_at.desc", limit: "40" })),
    db.select<{ id: number }>("published_offers", new URLSearchParams({ select: "id", published_at: `gte.${since24h}` })),
    db.select<{ id: string; status: string }>("publication_queue", new URLSearchParams({ select: "id,status", status: "in.(pending,processing,retry)" })),
    db.select<{ id: string }>("publication_queue", new URLSearchParams({ select: "id", status: "eq.failed", updated_at: `gte.${since24h}` })),
  ]);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: safeConfig(env),
    metrics: {
      activeRules: rules.filter((rule) => rule.enabled).length,
      totalRules: rules.length,
      published24h: published24.length,
      queueOpen: queueOpen.length,
      failed24h: failed24.length,
      successRate: published24.length + failed24.length > 0
        ? Math.round((published24.length / (published24.length + failed24.length)) * 1000) / 10
        : 100,
    },
    rules,
    runs,
    queue,
    published,
    logs,
  };
}

export async function handleAdminApi(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = new SupabaseRest(env);

  if (request.method === "GET" && path === "/api/admin/dashboard") return json(await dashboard(env));

  if (request.method === "GET" && path === "/api/admin/rules") {
    const rows = await db.select<AutomationRuleRow>("automation_rules", new URLSearchParams({ select: "*", order: "created_at.desc" }));
    return json({ rules: rows });
  }

  if (request.method === "POST" && path === "/api/admin/rules") {
    const body = await request.json().catch(() => ({})) as AdminRuleInput;
    const patch = rulePatch(body, true);
    const rows = await db.insert<AutomationRuleRow>("automation_rules", patch);
    return json({ ok: true, rule: rows[0] }, 201);
  }

  const match = path.match(/^\/api\/admin\/rules\/([0-9a-f-]{36})$/i);
  if (match && request.method === "PATCH") {
    const body = await request.json().catch(() => ({})) as AdminRuleInput;
    const patch = rulePatch(body, false);
    if (Object.keys(patch).length === 0) return json({ error: "Nenhuma alteração válida." }, 400);
    const rows = await db.update<AutomationRuleRow>("automation_rules", new URLSearchParams({ id: eq(match[1]) }), patch);
    if (!rows.length) return json({ error: "Automação não encontrada." }, 404);
    return json({ ok: true, rule: rows[0] });
  }

  return json({ error: "NOT_FOUND" }, 404);
}

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Affiliate Automation</title>
<style>
:root{--bg:#f5f6fb;--panel:#fff;--ink:#17182f;--muted:#74788e;--line:#e8e9f2;--brand:#6657f4;--brand2:#8b5cf6;--green:#12a56a;--red:#e5484d;--amber:#c98b13;--shadow:0 12px 34px rgba(35,38,82,.08)}
*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}button,input,select{font:inherit}.shell{min-height:100vh;display:grid;grid-template-columns:238px 1fr}.sidebar{background:var(--panel);border-right:1px solid var(--line);padding:22px 16px;position:sticky;top:0;height:100vh}.brand{display:flex;gap:11px;align-items:center;padding:4px 8px 22px}.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,var(--brand),var(--brand2));display:grid;place-items:center;color:#fff;font-weight:900;box-shadow:0 8px 20px rgba(102,87,244,.28)}.brand h1{font-size:15px;margin:0}.brand small{display:block;color:var(--muted);font-size:11px;margin-top:2px}.nav{display:grid;gap:6px}.nav button{border:0;background:transparent;text-align:left;padding:11px 12px;border-radius:10px;color:#565a71;cursor:pointer}.nav button.active,.nav button:hover{background:#f0efff;color:var(--brand);font-weight:700}.sidebar-foot{position:absolute;bottom:18px;left:16px;right:16px}.mini{border:1px solid var(--line);border-radius:12px;padding:11px;background:#fafaff;font-size:12px;color:var(--muted)}.main{padding:26px 30px 42px;min-width:0}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.top h2{margin:0;font-size:24px;letter-spacing:-.02em}.top p{margin:4px 0 0;color:var(--muted);font-size:13px}.actions{display:flex;gap:9px;align-items:center}.btn{border:1px solid var(--line);background:#fff;padding:9px 13px;border-radius:10px;cursor:pointer;font-weight:700;color:#4e5268}.btn:hover{transform:translateY(-1px)}.btn.primary{border-color:var(--brand);background:var(--brand);color:#fff}.btn.danger{color:var(--red)}.btn.small{padding:7px 10px;font-size:12px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:17px;box-shadow:var(--shadow)}.metric .label{font-size:12px;color:var(--muted)}.metric .value{font-size:29px;font-weight:800;margin-top:7px;letter-spacing:-.03em}.metric .sub{font-size:11px;color:var(--muted);margin-top:4px}.section{margin-top:22px}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:11px}.section-head h3{margin:0;font-size:15px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;box-shadow:var(--shadow);overflow:hidden}.rule-list{display:grid;gap:11px}.rule-card{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:16px 17px;box-shadow:var(--shadow)}.rule-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.rule-name{font-weight:800;font-size:15px}.rule-meta{color:var(--muted);font-size:12px;margin-top:5px}.pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.pill{border-radius:999px;padding:5px 8px;background:#f4f4fa;color:#666a7e;font-size:11px;font-weight:700}.pill.green{background:#eaf8f2;color:var(--green)}.pill.purple{background:#f0efff;color:var(--brand)}.pill.amber{background:#fff7e6;color:var(--amber)}.rule-actions{display:flex;gap:7px;flex-wrap:wrap}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;min-width:760px}.table th,.table td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;font-size:12px;vertical-align:middle}.table th{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#9295a8;background:#fbfbfe}.table tr:last-child td{border-bottom:0}.product{display:flex;align-items:center;gap:10px;min-width:250px}.thumb{width:38px;height:38px;border-radius:9px;background:#f1f2f6;object-fit:cover;border:1px solid var(--line)}.product-title{max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700}.status{display:inline-flex;padding:5px 8px;border-radius:999px;font-weight:800;font-size:10px;background:#f1f2f6;color:#626679}.status.published,.status.completed{background:#eaf8f2;color:var(--green)}.status.failed{background:#fdeeee;color:var(--red)}.status.pending,.status.processing,.status.retry,.status.running{background:#fff6e4;color:var(--amber)}.status.skipped_duplicate{background:#f0efff;color:var(--brand)}.view{display:none}.view.active{display:block}.empty{padding:34px;text-align:center;color:var(--muted);font-size:13px}.timeline{padding:6px 0}.log{display:grid;grid-template-columns:86px 120px 1fr;gap:12px;padding:12px 15px;border-bottom:1px solid var(--line);font-size:12px}.log:last-child{border-bottom:0}.log time{color:var(--muted)}.integration-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.integration{border:1px solid var(--line);border-radius:13px;padding:15px;background:#fff}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block;margin-right:6px}.dot.off{background:var(--red)}.modal-backdrop,.lock{position:fixed;inset:0;background:rgba(26,27,46,.46);display:none;align-items:center;justify-content:center;padding:18px;z-index:30;backdrop-filter:blur(5px)}.modal-backdrop.show,.lock.show{display:flex}.modal{width:min(660px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:18px;box-shadow:0 30px 80px rgba(18,20,55,.24)}.modal-head{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}.modal-head h3{margin:0}.modal-body{padding:20px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:11px;font-weight:800;color:#666a80}.field input,.field select{border:1px solid #dfe1eb;border-radius:10px;padding:10px 11px;outline:none;background:#fff}.field input:focus,.field select:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(102,87,244,.11)}.hint{font-size:10px;color:var(--muted)}.modal-foot{padding:14px 20px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px}.switch-row{display:flex;gap:18px;align-items:center}.check{display:flex;align-items:center;gap:7px;font-size:12px;color:#5e6277}.toast{position:fixed;right:22px;bottom:22px;background:#202235;color:#fff;padding:12px 15px;border-radius:11px;box-shadow:var(--shadow);display:none;z-index:50;max-width:360px;font-size:12px}.toast.show{display:block}.lock-card{background:#fff;width:min(410px,100%);border-radius:18px;padding:24px;box-shadow:0 30px 80px rgba(18,20,55,.25)}.lock-card h2{margin:0 0 7px}.lock-card p{color:var(--muted);font-size:13px;margin:0 0 16px}.lock-card input{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px;margin-bottom:9px}.lock-error{color:var(--red);font-size:11px;min-height:16px;margin-bottom:7px}.muted{color:var(--muted)}
@media(max-width:1050px){.grid,.integration-grid{grid-template-columns:repeat(2,1fr)}.shell{grid-template-columns:82px 1fr}.sidebar{padding:20px 10px}.brand h1,.brand small,.nav button span,.sidebar-foot{display:none}.brand{justify-content:center}.nav button{text-align:center}.main{padding:22px 20px}}
@media(max-width:700px){.shell{display:block}.sidebar{position:sticky;height:auto;z-index:10;padding:9px 12px;display:flex;align-items:center;gap:8px;overflow:auto}.brand{padding:0}.logo{width:34px;height:34px}.nav{display:flex}.nav button{white-space:nowrap}.main{padding:17px 13px}.top{align-items:flex-start}.grid,.integration-grid,.form-grid{grid-template-columns:1fr}.field.full{grid-column:auto}.rule-top{display:block}.rule-actions{margin-top:12px}.log{grid-template-columns:72px 1fr}.log div:last-child{grid-column:2}.actions .btn:not(.primary){display:none}}
</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><div class="logo">A</div><div><h1>Affiliate Automation</h1><small>motor independente</small></div></div>
    <nav class="nav">
      <button data-view="dashboard" class="active">▦ <span>Dashboard</span></button>
      <button data-view="automations">⚙ <span>Automações</span></button>
      <button data-view="queue">≡ <span>Fila</span></button>
      <button data-view="published">↗ <span>Publicações</span></button>
      <button data-view="logs">⌁ <span>Logs</span></button>
      <button data-view="settings">◉ <span>Configurações</span></button>
    </nav>
    <div class="sidebar-foot"><div class="mini">Cloudflare Worker<br><b id="workerState">Conectando…</b></div></div>
  </aside>
  <main class="main">
    <header class="top"><div><h2 id="pageTitle">Dashboard</h2><p id="pageSub">Visão operacional da automação</p></div><div class="actions"><button class="btn" id="refreshBtn">Atualizar</button><button class="btn primary" id="newBtn">+ Nova automação</button></div></header>

    <section class="view active" id="view-dashboard">
      <div class="grid" id="metrics"></div>
      <div class="section"><div class="section-head"><h3>Automações ativas</h3><button class="btn small" data-jump="automations">Ver todas</button></div><div id="dashboardRules" class="rule-list"></div></div>
      <div class="section"><div class="section-head"><h3>Publicações recentes</h3></div><div class="panel table-wrap"><table class="table"><thead><tr><th>Produto</th><th>Canal</th><th>Status</th><th>Horário</th></tr></thead><tbody id="dashboardPublished"></tbody></table></div></div>
    </section>

    <section class="view" id="view-automations"><div id="rules" class="rule-list"></div></section>
    <section class="view" id="view-queue"><div class="panel table-wrap"><table class="table"><thead><tr><th>Produto</th><th>Status</th><th>Tentativas</th><th>Agendado</th><th>Erro</th></tr></thead><tbody id="queueBody"></tbody></table></div></section>
    <section class="view" id="view-published"><div class="panel table-wrap"><table class="table"><thead><tr><th>Oferta</th><th>Canal</th><th>ID externo</th><th>Publicado em</th></tr></thead><tbody id="publishedBody"></tbody></table></div></section>
    <section class="view" id="view-logs"><div class="panel timeline" id="logsBody"></div></section>
    <section class="view" id="view-settings"><div class="integration-grid" id="integrations"></div><div class="section"><div class="panel" style="padding:18px"><b>Sessão administrativa</b><p class="muted" style="font-size:12px">A chave fica somente nesta aba do navegador e não é gravada no painel.</p><button class="btn danger" id="logoutBtn">Encerrar sessão</button></div></div></section>
  </main>
</div>

<div class="modal-backdrop" id="ruleModal"><div class="modal"><div class="modal-head"><h3 id="modalTitle">Nova automação</h3><button class="btn small" id="closeModal">Fechar</button></div><form id="ruleForm"><div class="modal-body"><div class="form-grid">
  <input type="hidden" id="ruleId" />
  <div class="field full"><label>Nome</label><input id="name" required placeholder="Ex.: Escova secadora → Telegram" /></div>
  <div class="field full"><label>Palavra-chave Shopee</label><input id="keyword" required placeholder="escova secadora" /></div>
  <div class="field"><label>Quantidade por ciclo</label><input id="quantity" type="number" min="1" max="100" value="1" /></div>
  <div class="field"><label>Não repetir por</label><input id="repeatDays" type="number" min="0" max="365" value="7" /></div>
  <div class="field"><label>Comissão mínima (%)</label><input id="minCommission" type="number" min="0" max="100" step="0.1" /></div>
  <div class="field"><label>Desconto mínimo (%)</label><input id="minDiscount" type="number" min="0" max="100" step="0.1" /></div>
  <div class="field"><label>Preço máximo (R$)</label><input id="maxPrice" type="number" min="0" step="0.01" /></div>
  <div class="field"><label>Ordenar por</label><select id="sort"><option value="">Relevância</option><option value="commission">Comissão</option><option value="discount">Desconto</option><option value="sales">Vendas</option><option value="price">Preço</option></select></div>
  <div class="field full"><label>Agendamento (cron)</label><input id="cron" value="0 9-22 * * *" /><div class="hint">Ex.: 0 9-22 * * * = a cada hora, das 09h às 22h.</div></div>
  <div class="field full"><label>Timezone</label><input id="timezone" value="America/Sao_Paulo" /></div>
  <div class="field full"><div class="switch-row"><label class="check"><input id="enabled" type="checkbox" /> Ativa</label><label class="check"><input id="dryRun" type="checkbox" checked /> Modo teste (não publica)</label></div></div>
</div></div><div class="modal-foot"><button type="button" class="btn" id="testBtn">Testar busca</button><button type="submit" class="btn primary">Salvar</button></div></form></div></div>

<div class="lock show" id="lock"><div class="lock-card"><div class="logo" style="margin-bottom:14px">A</div><h2>Painel administrativo</h2><p>Informe a chave da automação para acessar dados e configurações.</p><input id="secretInput" type="password" autocomplete="current-password" placeholder="AUTOMATION_SECRET" /><div class="lock-error" id="lockError"></div><button class="btn primary" style="width:100%" id="loginBtn">Entrar</button></div></div>
<div class="toast" id="toast"></div>
<script>
(function(){
  var state={data:null,view:'dashboard'};
  var titles={dashboard:['Dashboard','Visão operacional da automação'],automations:['Automações','Crie, edite, pause e teste suas regras'],queue:['Fila','Acompanhe o ciclo pending → processing → published'],published:['Publicações','Histórico confirmado de envios'],logs:['Logs','Eventos gravados pelo executor'],settings:['Configurações','Saúde das integrações e sessão']};
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c];});}
  function token(){return sessionStorage.getItem('automationSecret')||'';}
  function fmt(v){if(!v)return '—';try{return new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v));}catch(e){return String(v);}}
  function status(v){return '<span class="status '+esc(v)+'">'+esc(v||'—')+'</span>';}
  function titleFrom(obj){return obj&&obj.offer_snapshot&&obj.offer_snapshot.title?obj.offer_snapshot.title:(obj&&obj.offer_key?obj.offer_key:'Oferta');}
  function imageFrom(obj){return obj&&obj.offer_snapshot&&obj.offer_snapshot.imageUrl?obj.offer_snapshot.imageUrl:'';}
  function product(obj){var img=imageFrom(obj);return '<div class="product">'+(img?'<img class="thumb" src="'+esc(img)+'" loading="lazy" referrerpolicy="no-referrer" />':'<div class="thumb"></div>')+'<div class="product-title" title="'+esc(titleFrom(obj))+'">'+esc(titleFrom(obj))+'</div></div>';}
  async function api(path,opt){opt=opt||{};opt.headers=Object.assign({'authorization':'Bearer '+token(),'content-type':'application/json'},opt.headers||{});var r=await fetch(path,opt);if(r.status===401){showLock('Chave inválida ou expirada.');throw new Error('UNAUTHORIZED');}var p=await r.json().catch(function(){return {};});if(!r.ok)throw new Error(p.message||p.error||'Falha na requisição');return p;}
  function toast(msg){var el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');setTimeout(function(){el.classList.remove('show');},3000);}
  function showLock(msg){document.getElementById('lock').classList.add('show');document.getElementById('lockError').textContent=msg||'';}
  function hideLock(){document.getElementById('lock').classList.remove('show');document.getElementById('lockError').textContent='';}
  function scheduleLabel(c){if(c==='0 9-22 * * *')return '1x/h • 09h–22h';if(c==='*/5 * * * *')return 'a cada 5 min';if(c==='*/15 * * * *')return 'a cada 15 min';return c||'sem agenda';}
  function render(){var d=state.data;if(!d)return;document.getElementById('workerState').textContent='Online';
    var m=d.metrics;document.getElementById('metrics').innerHTML=[['Automações ativas',m.activeRules+'/'+m.totalRules,'regras habilitadas'],['Publicadas em 24h',m.published24h,'Telegram confirmado'],['Fila aberta',m.queueOpen,'pending / retry'],['Taxa de sucesso',m.successRate+'%','últimas 24h']].map(function(x){return '<div class="metric"><div class="label">'+esc(x[0])+'</div><div class="value">'+esc(x[1])+'</div><div class="sub">'+esc(x[2])+'</div></div>';}).join('');
    renderRules();renderQueue();renderPublished();renderLogs();renderIntegrations();
  }
  function ruleCard(r){var pills='<div class="pills"><span class="pill purple">Shopee → Telegram</span><span class="pill">'+esc(scheduleLabel(r.schedule_cron))+'</span><span class="pill">'+esc(r.quantity)+' por ciclo</span><span class="pill">≥ '+esc(r.min_commission==null?'0':r.min_commission)+'% comissão</span><span class="pill">≥ '+esc(r.min_discount==null?'0':r.min_discount)+'% desconto</span><span class="pill">'+esc(r.avoid_repeat_days)+'d sem repetir</span>'+(r.dry_run?'<span class="pill amber">modo teste</span>':'<span class="pill green">produção</span>')+'</div>';
    return '<div class="rule-card"><div class="rule-top"><div><div class="rule-name">'+esc(r.name)+'</div><div class="rule-meta">'+esc(r.keyword)+' · '+(r.enabled?'Ativa':'Pausada')+'</div>'+pills+'</div><div class="rule-actions"><button class="btn small" data-toggle="'+esc(r.id)+'">'+(r.enabled?'Pausar':'Ativar')+'</button><button class="btn small" data-test="'+esc(r.id)+'">Testar busca</button><button class="btn small primary" data-edit="'+esc(r.id)+'">Editar</button></div></div></div>';
  }
  function renderRules(){var rules=state.data.rules||[];var active=rules.filter(function(r){return r.enabled;});document.getElementById('dashboardRules').innerHTML=active.length?active.slice(0,3).map(ruleCard).join(''):'<div class="empty">Nenhuma automação ativa.</div>';document.getElementById('rules').innerHTML=rules.length?rules.map(ruleCard).join(''):'<div class="empty">Nenhuma automação criada.</div>';}
  function renderQueue(){var rows=state.data.queue||[];document.getElementById('queueBody').innerHTML=rows.length?rows.map(function(q){return '<tr><td>'+product(q)+'</td><td>'+status(q.status)+'</td><td>'+esc(q.attempts)+' / '+esc(q.max_attempts)+'</td><td>'+esc(fmt(q.scheduled_for))+'</td><td class="muted">'+esc(q.last_error||'—')+'</td></tr>';}).join(''):'<tr><td colspan="5" class="empty">Fila vazia.</td></tr>';}
  function renderPublished(){var rows=state.data.published||[];var html=rows.length?rows.map(function(p){return '<tr><td><b>'+esc(p.offer_key)+'</b></td><td>'+esc(p.channel)+'</td><td>'+esc(p.external_id||'—')+'</td><td>'+esc(fmt(p.published_at))+'</td></tr>';}).join(''):'<tr><td colspan="4" class="empty">Nenhuma publicação.</td></tr>';document.getElementById('publishedBody').innerHTML=html;document.getElementById('dashboardPublished').innerHTML=rows.length?rows.slice(0,5).map(function(p){return '<tr><td><b>'+esc(p.offer_key)+'</b></td><td>'+esc(p.channel)+'</td><td>'+status('published')+'</td><td>'+esc(fmt(p.published_at))+'</td></tr>';}).join(''):'<tr><td colspan="4" class="empty">Nenhuma publicação recente.</td></tr>';}
  function renderLogs(){var rows=state.data.logs||[];document.getElementById('logsBody').innerHTML=rows.length?rows.map(function(l){return '<div class="log"><time>'+esc(fmt(l.created_at))+'</time><div>'+status(l.status||l.event)+'</div><div><b>'+esc(l.event)+'</b><div class="muted" style="margin-top:3px">'+esc(l.message||('run '+(l.run_id||'—')))+'</div></div></div>';}).join(''):'<div class="empty">Nenhum log registrado.</div>';}
  function renderIntegrations(){var c=state.data.config||{};var items=[['Cloudflare Worker',true],['Supabase',c.supabase],['Shopee Affiliate',c.shopee],['Telegram Bot',c.telegram]];document.getElementById('integrations').innerHTML=items.map(function(i){return '<div class="integration"><b>'+esc(i[0])+'</b><div style="margin-top:9px;font-size:12px"><span class="dot '+(i[1]?'':'off')+'"></span>'+(i[1]?'Conectado':'Não configurado')+'</div></div>';}).join('');}
  async function refresh(){document.getElementById('workerState').textContent='Atualizando…';try{state.data=await api('/api/admin/dashboard');render();document.getElementById('workerState').textContent='Online';document.getElementById('pageSub').textContent=titles[state.view][1]+' · atualizado '+fmt(state.data.generatedAt);}catch(e){document.getElementById('workerState').textContent='Erro';if(e.message!=='UNAUTHORIZED')toast(e.message);}}
  function setView(v){state.view=v;document.querySelectorAll('.view').forEach(function(el){el.classList.remove('active');});document.getElementById('view-'+v).classList.add('active');document.querySelectorAll('.nav button').forEach(function(b){b.classList.toggle('active',b.dataset.view===v);});document.getElementById('pageTitle').textContent=titles[v][0];document.getElementById('pageSub').textContent=titles[v][1];}
  function ruleById(id){return (state.data.rules||[]).find(function(r){return r.id===id;});}
  function openModal(r){document.getElementById('ruleId').value=r?r.id:'';document.getElementById('modalTitle').textContent=r?'Editar automação':'Nova automação';document.getElementById('name').value=r?r.name:'';document.getElementById('keyword').value=r?r.keyword:'';document.getElementById('quantity').value=r?r.quantity:1;document.getElementById('repeatDays').value=r?r.avoid_repeat_days:7;document.getElementById('minCommission').value=r&&r.min_commission!=null?r.min_commission:'';document.getElementById('minDiscount').value=r&&r.min_discount!=null?r.min_discount:'';document.getElementById('maxPrice').value=r&&r.max_price!=null?r.max_price:'';document.getElementById('sort').value=r&&r.sort?r.sort:'';document.getElementById('cron').value=r&&r.schedule_cron?r.schedule_cron:'0 9-22 * * *';document.getElementById('timezone').value=r&&r.timezone?r.timezone:'America/Sao_Paulo';document.getElementById('enabled').checked=r?!!r.enabled:false;document.getElementById('dryRun').checked=r?!!r.dry_run:true;document.getElementById('ruleModal').classList.add('show');}
  function closeModal(){document.getElementById('ruleModal').classList.remove('show');}
  function formPayload(){function nullable(id){var v=document.getElementById(id).value;return v===''?null:Number(v);}return {name:document.getElementById('name').value,keyword:document.getElementById('keyword').value,quantity:Number(document.getElementById('quantity').value),avoid_repeat_days:Number(document.getElementById('repeatDays').value),min_commission:nullable('minCommission'),min_discount:nullable('minDiscount'),max_price:nullable('maxPrice'),sort:document.getElementById('sort').value||null,schedule_cron:document.getElementById('cron').value,timezone:document.getElementById('timezone').value,enabled:document.getElementById('enabled').checked,dry_run:document.getElementById('dryRun').checked};}
  async function saveRule(ev){ev.preventDefault();var id=document.getElementById('ruleId').value;try{await api(id?'/api/admin/rules/'+id:'/api/admin/rules',{method:id?'PATCH':'POST',body:JSON.stringify(formPayload())});closeModal();toast(id?'Automação atualizada.':'Automação criada em modo seguro.');await refresh();}catch(e){toast(e.message);}}
  async function toggleRule(id){var r=ruleById(id);if(!r)return;try{await api('/api/admin/rules/'+id,{method:'PATCH',body:JSON.stringify({enabled:!r.enabled})});toast(r.enabled?'Automação pausada.':'Automação ativada.');await refresh();}catch(e){toast(e.message);}}
  async function testRule(id){var r=id?ruleById(id):null;var p=r?{keyword:r.keyword,quantity:Math.min(r.quantity,5),minCommission:r.min_commission,minDiscount:r.min_discount,maxPrice:r.max_price}:formPayload();if(!p.keyword){toast('Informe uma palavra-chave.');return;}try{toast('Buscando ofertas…');var out=await api('/test',{method:'POST',body:JSON.stringify(p)});var first=out.publications&&out.publications[0]&&out.publications[0].offer?out.publications[0].offer.title:'';toast('Teste: '+out.selected+' selecionada(s), '+out.scanned+' analisadas. '+(first?first:''));}catch(e){toast(e.message);}}
  document.addEventListener('click',function(ev){var b=ev.target.closest('button');if(!b)return;if(b.dataset.view)setView(b.dataset.view);if(b.dataset.jump)setView(b.dataset.jump);if(b.dataset.edit)openModal(ruleById(b.dataset.edit));if(b.dataset.toggle)toggleRule(b.dataset.toggle);if(b.dataset.test)testRule(b.dataset.test);});
  document.getElementById('refreshBtn').onclick=refresh;document.getElementById('newBtn').onclick=function(){openModal(null);};document.getElementById('closeModal').onclick=closeModal;document.getElementById('ruleForm').onsubmit=saveRule;document.getElementById('testBtn').onclick=function(){testRule(document.getElementById('ruleId').value||null);};document.getElementById('logoutBtn').onclick=function(){sessionStorage.removeItem('automationSecret');showLock('Sessão encerrada.');};
  document.getElementById('loginBtn').onclick=async function(){var s=document.getElementById('secretInput').value.trim();if(!s){document.getElementById('lockError').textContent='Informe a chave.';return;}sessionStorage.setItem('automationSecret',s);try{await refresh();hideLock();}catch(e){showLock('Não foi possível autenticar.');}};
  document.getElementById('secretInput').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('loginBtn').click();});
  if(token()){refresh().then(hideLock).catch(function(){showLock('Informe a chave novamente.');});}else{showLock('');}
})();
</script>
</body>
</html>`;

export function adminPage() {
  return new Response(ADMIN_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    },
  });
}
