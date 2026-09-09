import { createShopeeProvider } from "../lib/affiliate/shopee/adapter";
import { generateContent, type ContentTemplate } from "../lib/content-engine";
import { createTelegramPublisher } from "../lib/publishers/telegram";
import { searchQualifiedOffers } from "../lib/search-engine";
import { runRuleNow, workerTick } from "./automation";
import { cronMatches } from "./cron";
import { SupabaseRest, eq, type AutomationRuleRow } from "./db";
import { required, type Env } from "./env";

type JsonObject = Record<string, unknown>;
type AdminRuleInput = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function text(value: unknown, max = 160) { return typeof value === "string" ? value.trim().slice(0, max) : undefined; }
function nullableNumber(value: unknown, min: number, max: number) {
  if (value === null || value === "") return null;
  const normalized = typeof value === "string"
    ? (value.includes(",") ? value.trim().replace(/\./g, "").replace(",", ".") : value.trim())
    : value;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}
function validTemplate(value: unknown): ContentTemplate {
  return ["offer", "natural", "storytelling", "no_price"].includes(String(value)) ? String(value) as ContentTemplate : "offer";
}
function nextSlot(expression: string | null, timezone: string, from = new Date()) {
  if (!expression) return null;
  const start = new Date(from.getTime() + 60_000); start.setUTCSeconds(0, 0);
  for (let i = 0; i < 10_080; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (cronMatches(expression, candidate, timezone)) return candidate.toISOString();
  }
  return null;
}
function intervalValue(settings: JsonObject) {
  const value = Number(settings?.intervalMinutes);
  return Number.isInteger(value) && value >= 5 && value <= 1440 && value % 5 === 0 ? value : null;
}
function validClock(value: unknown, fallback: string) {
  const v = typeof value === "string" ? value : fallback;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback;
}
function clockToMinutes(value: string) { const [h,m]=value.split(":").map(Number); return h*60+m; }
function localClockMinutes(date: Date, timezone: string) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date).map(p=>[p.type,p.value]));
  return Number(parts.hour)*60+Number(parts.minute);
}
function inRuleWindow(date: Date, timezone: string, settings: JsonObject) {
  const start=clockToMinutes(validClock(settings?.windowStart,"09:00"));
  const end=clockToMinutes(validClock(settings?.windowEnd,"22:00"));
  const current=localClockMinutes(date,timezone);
  return start<=end ? current>=start&&current<=end : current>=start||current<=end;
}
function nextRuleSlot(rule: AutomationRuleRow, lastRunAt: string | null, from = new Date()) {
  const interval=intervalValue(rule.settings||{});
  const timezone=rule.timezone||"America/Sao_Paulo";
  if (!interval) return nextSlot(rule.schedule_cron,timezone,from);
  const earliest=lastRunAt ? Math.max(from.getTime()+60_000,new Date(lastRunAt).getTime()+interval*60_000) : from.getTime()+60_000;
  let candidate=new Date(earliest);
  candidate.setUTCSeconds(0,0);
  const remainder=candidate.getUTCMinutes()%5;
  if(remainder!==0) candidate=new Date(candidate.getTime()+(5-remainder)*60_000);
  for(let i=0;i<2_016;i+=1){
    if(inRuleWindow(candidate,timezone,rule.settings||{})) return candidate.toISOString();
    candidate=new Date(candidate.getTime()+5*60_000);
  }
  return null;
}
function safeConfig(env: Env) {
  return { shopee: Boolean(env.SHOPEE_APP_ID && env.SHOPEE_SECRET), telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), supabase: Boolean(env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)), protectedEndpoints: Boolean(env.AUTOMATION_SECRET) };
}

function rulePatch(input: AdminRuleInput, creating = false, currentSettings: JsonObject = {}) {
  const patch: JsonObject = {};
  const incomingSettings = input.settings && typeof input.settings === "object" && !Array.isArray(input.settings)
    ? input.settings as JsonObject
    : {};
  const searchScope = (incomingSettings.searchScope ?? currentSettings.searchScope) === "all" ? "all" : "keyword";
  if (input.name !== undefined) { const v = text(input.name, 120); if (!v) throw new Error("Nome obrigatório."); patch.name = v; } else if (creating) throw new Error("Nome obrigatório.");
  if (input.keyword !== undefined) {
    const v = text(input.keyword, 120) || "";
    if (!v && searchScope !== "all") throw new Error("Informe a palavra-chave ou selecione Todos os produtos.");
    patch.keyword = v;
  } else if (creating) {
    if (searchScope === "all") patch.keyword = "";
    else throw new Error("Palavra-chave obrigatória.");
  }
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  if (input.dry_run !== undefined) patch.dry_run = Boolean(input.dry_run);
  for (const [key, min, max] of [["min_commission",0,100],["min_discount",0,100],["max_price",0,1_000_000]] as const) {
    if (input[key] !== undefined) { const v = nullableNumber(input[key], min, max); if (v === undefined) throw new Error(`${key} inválido.`); patch[key] = v; }
  }
  if (input.quantity !== undefined) { const v=Number(input.quantity); if(!Number.isInteger(v)||v<1||v>100) throw new Error("Quantidade inválida."); patch.quantity=v; }
  if (input.avoid_repeat_days !== undefined) { const v=Number(input.avoid_repeat_days); if(!Number.isInteger(v)||v<0||v>365) throw new Error("Dias sem repetir inválido."); patch.avoid_repeat_days=v; }
  if (input.sort !== undefined) { const v=input.sort===null||input.sort===""?null:String(input.sort); if(v!==null&&!['commission','price','sales','discount'].includes(v)) throw new Error("Ordenação inválida."); patch.sort=v; }
  if (input.schedule_cron !== undefined) { const v=input.schedule_cron===null?null:text(input.schedule_cron,100); if(v&&v.split(/\s+/).length!==5) throw new Error("Cron deve ter 5 campos."); patch.schedule_cron=v||null; } else if (creating) patch.schedule_cron="0 9-22 * * *";
  if (input.timezone !== undefined) { const v=text(input.timezone,80); if(!v) throw new Error("Timezone inválido."); try{new Intl.DateTimeFormat("pt-BR",{timeZone:v}).format(new Date());}catch{throw new Error("Timezone inválido.");} patch.timezone=v; } else if(creating) patch.timezone="America/Sao_Paulo";
  if (input.settings !== undefined) {
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) throw new Error("Settings inválido.");
    patch.settings = { ...currentSettings, ...(input.settings as JsonObject) };
  }
  if (creating) {
    patch.id=crypto.randomUUID(); patch.networks=["shopee"]; patch.channels=["telegram"];
    if(patch.enabled===undefined) patch.enabled=false; if(patch.dry_run===undefined) patch.dry_run=true; if(patch.quantity===undefined) patch.quantity=1; if(patch.avoid_repeat_days===undefined) patch.avoid_repeat_days=7;
    patch.settings={ purpose:"admin_ui", priority:100, maxAttempts:3, contentTemplate:"offer", intervalMinutes:60, windowStart:"09:00", windowEnd:"22:00", ...(patch.settings as JsonObject || {}) };
  }
  return patch;
}

async function dashboard(env: Env) {
  const db=new SupabaseRest(env); const since=new Date(Date.now()-86_400_000).toISOString(); const now=new Date();
  const [rules,runs,queue,published,logs,p24,open,failed]=await Promise.all([
    db.select<AutomationRuleRow>("automation_rules",new URLSearchParams({select:"*",order:"created_at.desc"})),
    db.select<JsonObject>("automation_runs",new URLSearchParams({select:"*",order:"started_at.desc",limit:"60"})),
    db.select<JsonObject>("publication_queue",new URLSearchParams({select:"*",order:"created_at.desc",limit:"80"})),
    db.select<JsonObject>("published_offers",new URLSearchParams({select:"*",order:"published_at.desc",limit:"50"})),
    db.select<JsonObject>("publication_logs",new URLSearchParams({select:"*",order:"created_at.desc",limit:"80"})),
    db.select<{id:number}>("published_offers",new URLSearchParams({select:"id",published_at:`gte.${since}`})),
    db.select<{id:string}>("publication_queue",new URLSearchParams({select:"id",status:"in.(pending,processing,retry)"})),
    db.select<{id:string}>("publication_queue",new URLSearchParams({select:"id",status:"eq.failed",updated_at:`gte.${since}`})),
  ]);
  const nextRuns=Object.fromEntries(rules.map(r=>{ const last=runs.find((run:any)=>run.rule_id===r.id) as any; return [r.id,r.enabled?nextRuleSlot(r,last?.started_at?String(last.started_at):null,now):null]; }));
  return {ok:true,generatedAt:now.toISOString(),config:safeConfig(env),metrics:{activeRules:rules.filter(r=>r.enabled).length,totalRules:rules.length,published24h:p24.length,queueOpen:open.length,failed24h:failed.length,successRate:p24.length+failed.length?Math.round(p24.length/(p24.length+failed.length)*1000)/10:100},nextRuns,rules,runs,queue,published,logs};
}

async function telegramInfo(env: Env) {
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID) return {configured:false,topics:[]};
  const token=env.TELEGRAM_BOT_TOKEN; const chatId=env.TELEGRAM_CHAT_ID;
  async function call(method:string,body:JsonObject={}) { const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)}); const p=await r.json() as any; if(!r.ok||!p?.ok) throw new Error(p?.description||`Telegram HTTP ${r.status}`); return p.result; }
  const db=new SupabaseRest(env);
  const [me,chat,rules]=await Promise.all([
    call("getMe"),
    call("getChat",{chat_id:chatId}),
    db.select<AutomationRuleRow>("automation_rules",new URLSearchParams({select:"id,name,settings",order:"created_at.desc"})),
  ]);
  const topicMap=new Map<number,string>();
  for(const rule of rules){
    const id=Number(rule.settings?.telegramThreadId);
    if(Number.isInteger(id)&&id>0){
      const name=typeof rule.settings?.telegramTopicName==="string"&&String(rule.settings.telegramTopicName).trim()?String(rule.settings.telegramTopicName).trim():`Tópico ${id}`;
      if(!topicMap.has(id)) topicMap.set(id,name);
    }
  }
  const topics=Array.from(topicMap.entries()).map(([id,name])=>({id,name}));
  return {configured:true,botUsername:me?.username||null,botName:me?.first_name||null,chatTitle:chat?.title||chat?.username||"Grupo Telegram",isForum:Boolean(chat?.is_forum),chatType:chat?.type||null,topics};
}

function buildPreviewSuggestions(
  diagnostics: { [key: string]: number },
  filters: { minCommission?: number | null; minDiscount?: number | null; maxPrice?: number | null },
) {
  if (!diagnostics.scanned) return ["A Shopee não retornou itens para essa palavra-chave. Tente um termo mais comum ou mais curto."];

  const candidates = [
    { count: diagnostics.rejectedRelevance || 0, text: "Muitos itens não correspondem exatamente à palavra-chave. Tente um termo um pouco mais amplo." },
    { count: diagnostics.belowCommission || 0, text: filters.minCommission != null ? `Reduza a comissão mínima de ${filters.minCommission}% ou deixe esse filtro vazio.` : "Revise a comissão mínima." },
    { count: diagnostics.belowDiscount || 0, text: filters.minDiscount != null ? `Reduza o desconto mínimo de ${filters.minDiscount}% ou deixe esse filtro vazio.` : "Revise o desconto mínimo." },
    { count: diagnostics.aboveMaxPrice || 0, text: filters.maxPrice != null ? `Aumente o preço máximo de R$ ${filters.maxPrice.toFixed(2).replace(".", ",")} ou deixe esse filtro vazio.` : "Revise o preço máximo." },
    { count: diagnostics.equivalentDuplicates || 0, text: "Há anúncios equivalentes entre os resultados; amplie a busca para encontrar produtos realmente diferentes." },
    { count: diagnostics.invalidMetrics || 0, text: "Alguns anúncios vieram com métricas inválidas da rede e foram descartados por segurança." },
  ].filter((item) => item.count > 0).sort((a, b) => b.count - a.count);

  return candidates.slice(0, 3).map((item) => item.text);
}

async function preview(request: Request, env: Env) {
  const body=await request.json().catch(()=>({})) as JsonObject; const db=new SupabaseRest(env); let rule:AutomationRuleRow|undefined;
  if(typeof body.ruleId==="string") { const rows=await db.select<AutomationRuleRow>("automation_rules",new URLSearchParams({select:"*",id:eq(body.ruleId),limit:"1"})); rule=rows[0]; }
  const settings=(rule?.settings||body.settings||{}) as JsonObject;
  const searchScope=settings.searchScope==="all"?"all":"keyword";
  const keyword=rule?.keyword??text(body.keyword,120)??"";
  if(searchScope!=="all"&&!keyword) return json({error:"Informe a palavra-chave ou selecione Todos os produtos."},400);
  const quantity=Math.min(Math.max(Number(rule?.quantity||body.quantity||3),1),5);
  const minCommission=rule?.min_commission??nullableNumber(body.minCommission,0,100)??undefined;
  const minDiscount=rule?.min_discount??nullableNumber(body.minDiscount,0,100)??undefined;
  const maxPrice=rule?.max_price??nullableNumber(body.maxPrice,0,1_000_000)??undefined;
  const provider=createShopeeProvider({appId:required(env.SHOPEE_APP_ID,"SHOPEE_APP_ID"),secret:required(env.SHOPEE_SECRET,"SHOPEE_SECRET")});
  const requestedSort = rule?.sort || (["commission","price","sales","discount"].includes(String(body.sort)) ? String(body.sort) as "commission"|"price"|"sales"|"discount" : undefined);
  const result=await searchQualifiedOffers(provider,{keyword,minCommission,minDiscount,maxPrice,sort:requestedSort},quantity,{maxPages:2,pageSize:50,maxRequests:searchScope==="all"?10:8,searchScope});
  const template=validTemplate(settings.contentTemplate); const thread=Number(settings.telegramThreadId); const messageThreadId=Number.isInteger(thread)&&thread>0?thread:undefined;
  const filters={minCommission:minCommission??null,minDiscount:minDiscount??null,maxPrice:maxPrice??null};
  return json({
    dryRun:true,
    selected:result.selected.length,
    scanned:result.scanned,
    pages:result.pages,
    diagnostics:result.diagnostics,
    strategy:result.strategy,
    searchScope,
    filters,
    suggestions:buildPreviewSuggestions(result.diagnostics,filters),
    publications:result.selected.map(offer=>({offer,content:generateContent(offer,"telegram",{template,messageThreadId})})),
  });
}

export async function handleAdminApi(request: Request, env: Env) {
  const url=new URL(request.url); const path=url.pathname; const db=new SupabaseRest(env);
  if(request.method==="GET"&&path==="/api/admin/dashboard") return json(await dashboard(env));
  if(request.method==="GET"&&path==="/api/admin/telegram") { try{return json(await telegramInfo(env));}catch(e){return json({configured:true,error:e instanceof Error?e.message:"Falha Telegram"},502);} }
  if(request.method==="POST"&&path==="/api/admin/preview") return preview(request,env);
  if(request.method==="POST"&&path==="/api/admin/telegram/test") {
    const body=await request.json().catch(()=>({})) as JsonObject; if(body.confirm!=="SEND_TEST") return json({error:"CONFIRMATION_REQUIRED"},409);
    const thread=Number(body.messageThreadId); const publisher=createTelegramPublisher({token:required(env.TELEGRAM_BOT_TOKEN,"TELEGRAM_BOT_TOKEN"),chatId:required(env.TELEGRAM_CHAT_ID,"TELEGRAM_CHAT_ID")});
    const result=await publisher.publish({channel:"telegram",title:"Teste",body:"✅ Teste técnico da automação",cta:"Cloudflare Worker → Telegram funcionando.",affiliateUrl:"https://shopee.com.br",messageThreadId:Number.isInteger(thread)&&thread>0?thread:undefined});
    return json({ok:true,externalId:result.externalId});
  }
  if(request.method==="POST"&&path==="/api/admin/rules") { const body=await request.json().catch(()=>({})) as AdminRuleInput; const rows=await db.insert<AutomationRuleRow>("automation_rules",rulePatch(body,true)); return json({ok:true,rule:rows[0]},201); }
  const ruleMatch=path.match(/^\/api\/admin\/rules\/([0-9a-f-]{36})$/i);
  if(ruleMatch&&request.method==="PATCH") { const existing=await db.select<AutomationRuleRow>("automation_rules",new URLSearchParams({select:"*",id:eq(ruleMatch[1]),limit:"1"})); if(!existing.length)return json({error:"Automação não encontrada."},404); const body=await request.json().catch(()=>({})) as AdminRuleInput; const patch=rulePatch(body,false,existing[0].settings||{}); const rows=await db.update<AutomationRuleRow>("automation_rules",new URLSearchParams({id:eq(ruleMatch[1])}),patch); return json({ok:true,rule:rows[0]}); }
  const runMatch=path.match(/^\/api\/admin\/rules\/([0-9a-f-]{36})\/run$/i);
  if(runMatch&&request.method==="POST") { const rows=await db.select<AutomationRuleRow>("automation_rules",new URLSearchParams({select:"*",id:eq(runMatch[1]),limit:"1"})); if(!rows.length)return json({error:"Automação não encontrada."},404); const body=await request.json().catch(()=>({})) as JsonObject; if(!rows[0].dry_run&&body.confirm!=="RUN_NOW") return json({error:"CONFIRMATION_REQUIRED",message:"Confirme a publicação real."},409); return json({ok:true,...await runRuleNow(env,runMatch[1])}); }
  const queueMatch=path.match(/^\/api\/admin\/queue\/([0-9a-f-]{36})\/(retry|cancel)$/i);
  if(queueMatch&&request.method==="POST") {
    const rows=await db.select<JsonObject>("publication_queue",new URLSearchParams({select:"*",id:eq(queueMatch[1]),limit:"1"})); if(!rows.length)return json({error:"Item não encontrado."},404); const q=rows[0] as any; const action=queueMatch[2];
    if(action==="retry") { if(!["failed","retry"].includes(String(q.status))) return json({error:"Este item não pode ser reenviado."},409); await db.update("publication_queue",new URLSearchParams({id:eq(queueMatch[1])}),{status:"pending",attempts:0,available_at:new Date().toISOString(),scheduled_for:new Date().toISOString(),locked_at:null,locked_by:null,last_error:null}); await db.insert("publication_logs",{queue_id:q.id,run_id:q.run_id,rule_id:q.rule_id,event:"manual_retry",status:"pending",message:"Retry solicitado pelo painel"},"return=minimal"); const worker=await workerTick(env); return json({ok:true,worker}); }
    if(!["pending","retry","failed"].includes(String(q.status))) return json({error:"Este item não pode ser cancelado."},409); await db.update("publication_queue",new URLSearchParams({id:eq(queueMatch[1])}),{status:"cancelled",locked_at:null,locked_by:null}); await db.insert("publication_logs",{queue_id:q.id,run_id:q.run_id,rule_id:q.rule_id,event:"manual_cancel",status:"cancelled",message:"Cancelado pelo painel"},"return=minimal"); return json({ok:true});
  }
  return json({error:"NOT_FOUND"},404);
}

const ADMIN_HTML=String.raw`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Affiliate Automation</title><style>
:root{--bg:#f5f6fb;--panel:#fff;--ink:#17182f;--muted:#777b90;--line:#e7e9f1;--brand:#6657f4;--green:#12a56a;--red:#e5484d;--amber:#c98b13;--shadow:0 12px 30px rgba(35,38,82,.07)}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}button,input,select{font:inherit}.shell{min-height:100vh;display:grid;grid-template-columns:238px 1fr}.sidebar{background:#fff;border-right:1px solid var(--line);padding:22px 16px;position:sticky;top:0;height:100vh}.brand{display:flex;gap:11px;align-items:center;padding:4px 8px 22px}.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#6657f4,#8b5cf6);display:grid;place-items:center;color:#fff;font-weight:900}.brand h1{font-size:15px;margin:0}.brand small{display:block;color:var(--muted);font-size:11px}.nav{display:grid;gap:6px}.nav button{border:0;background:transparent;text-align:left;padding:11px 12px;border-radius:10px;color:#565a71;cursor:pointer}.nav button.active,.nav button:hover{background:#efefff;color:var(--brand);font-weight:700}.sidefoot{position:absolute;bottom:18px;left:16px;right:16px}.mini{border:1px solid var(--line);border-radius:12px;padding:11px;background:#fafaff;font-size:12px;color:var(--muted)}.main{padding:26px 30px 42px;min-width:0}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:22px}.top h2{margin:0;font-size:24px}.top p{margin:4px 0 0;color:var(--muted);font-size:13px}.actions,.row-actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid var(--line);background:#fff;padding:9px 13px;border-radius:10px;cursor:pointer;font-weight:700;color:#505469}.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}.btn.danger{color:var(--red)}.btn.small{padding:7px 10px;font-size:11px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.metric,.card,.rule-card,.integration{background:#fff;border:1px solid var(--line);border-radius:15px;box-shadow:var(--shadow)}.metric{padding:17px}.metric .label{font-size:12px;color:var(--muted)}.metric .value{font-size:29px;font-weight:800;margin-top:7px}.metric .sub{font-size:11px;color:var(--muted)}.section{margin-top:22px}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:11px}.section-head h3{margin:0;font-size:15px}.rule-list{display:grid;gap:11px}.rule-card{padding:16px 17px}.rule-top{display:flex;justify-content:space-between;gap:16px}.rule-name{font-weight:800;font-size:15px}.rule-meta,.runmeta,.muted{color:var(--muted);font-size:12px}.runmeta{margin-top:9px}.pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:11px}.pill{border-radius:999px;padding:5px 8px;background:#f4f4fa;color:#666a7e;font-size:11px;font-weight:700}.pill.green{background:#eaf8f2;color:var(--green)}.pill.purple{background:#f0efff;color:var(--brand)}.pill.amber{background:#fff7e6;color:var(--amber)}.panel{background:#fff;border:1px solid var(--line);border-radius:15px;box-shadow:var(--shadow);overflow:hidden}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;min-width:800px}.table th,.table td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;font-size:12px}.table th{font-size:10px;text-transform:uppercase;color:#9397aa;background:#fbfbfe}.product{display:flex;align-items:center;gap:10px;min-width:260px}.thumb{width:38px;height:38px;border-radius:9px;background:#f1f2f6;object-fit:cover;border:1px solid var(--line)}.product-title{max-width:390px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700}.status{display:inline-flex;padding:5px 8px;border-radius:999px;font-weight:800;font-size:10px;background:#f1f2f6;color:#626679}.status.published,.status.completed{background:#eaf8f2;color:var(--green)}.status.failed{background:#fdeeee;color:var(--red)}.status.pending,.status.processing,.status.retry,.status.running{background:#fff6e4;color:var(--amber)}.status.skipped_duplicate,.status.cancelled{background:#f0efff;color:var(--brand)}.view{display:none}.view.active{display:block}.empty{padding:34px;text-align:center;color:var(--muted);font-size:13px}.log{display:grid;grid-template-columns:96px 120px 1fr;gap:12px;padding:12px 15px;border-bottom:1px solid var(--line);font-size:12px}.integration-grid,.template-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.integration,.template{padding:15px}.template.active{outline:2px solid var(--brand)}.template h4{margin:0 0 8px}.template p{font-size:12px;color:var(--muted);margin:0}.view-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.check{display:flex;align-items:center;gap:7px;font-size:12px;color:#5e6277}.modal-backdrop,.lock{position:fixed;inset:0;background:rgba(26,27,46,.46);display:none;align-items:center;justify-content:center;padding:18px;z-index:30;backdrop-filter:blur(5px)}.modal-backdrop.show,.lock.show{display:flex}.modal{width:min(700px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:18px}.modal-head,.modal-foot{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}.modal-foot{border-top:1px solid var(--line);border-bottom:0;justify-content:flex-end}.modal-body{padding:20px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:11px;font-weight:800;color:#666a80}.field input,.field select{border:1px solid #dfe1eb;border-radius:10px;padding:10px 11px}.preview{white-space:pre-wrap;background:#f8f8fc;border:1px solid var(--line);border-radius:12px;padding:14px;font-size:12px;line-height:1.55}.preview-img{width:120px;height:120px;object-fit:cover;border-radius:12px;border:1px solid var(--line);margin-bottom:12px}.toast{position:fixed;right:22px;bottom:22px;background:#202235;color:#fff;padding:12px 15px;border-radius:11px;display:none;z-index:50;max-width:420px;font-size:12px}.toast.show{display:block}.lock-card{background:#fff;width:min(410px,100%);border-radius:18px;padding:24px}.lock-card input{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px;margin:10px 0}.red{color:var(--red)}
@media(max-width:1050px){.grid,.integration-grid,.template-grid{grid-template-columns:repeat(2,1fr)}.shell{grid-template-columns:82px 1fr}.brand h1,.brand small,.nav span,.sidefoot{display:none}.nav button{text-align:center}.main{padding:22px 20px}}@media(max-width:700px){.shell{display:block}.sidebar{position:sticky;height:auto;z-index:10;padding:9px 12px;display:flex;gap:8px;overflow:auto}.brand{padding:0}.nav{display:flex}.nav button{white-space:nowrap}.main{padding:17px 13px}.grid,.integration-grid,.template-grid,.form-grid{grid-template-columns:1fr}.field.full{grid-column:auto}.rule-top{display:block}.row-actions{margin-top:12px}.log{grid-template-columns:72px 1fr}.log div:last-child{grid-column:2}}

/* Cyberpunk Black Theme — aprovado em 09/09/2026 */
:root{
  --bg:#050816;--panel:rgba(10,17,38,.82);--ink:#f5f7ff;--muted:#8f9ab8;--line:#223258;
  --brand:#7c3cff;--brand2:#a855f7;--green:#14f195;--red:#ff4d78;--amber:#ffb84d;
  --cyan:#19c8ff;--blue:#3b82f6;--shadow:0 18px 55px rgba(0,0,0,.38),0 0 28px rgba(91,61,255,.08)
}
html{background:#040713;color-scheme:dark}
body{background:
  radial-gradient(circle at 78% 8%,rgba(64,77,255,.15),transparent 27%),
  radial-gradient(circle at 28% 32%,rgba(124,58,237,.12),transparent 30%),
  linear-gradient(180deg,#050816 0%,#070b18 48%,#040712 100%);color:var(--ink);min-height:100vh}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.22;background-image:
  linear-gradient(rgba(72,106,190,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(72,106,190,.09) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,black,transparent 88%)}
.sidebar{background:linear-gradient(180deg,rgba(5,9,23,.98),rgba(6,10,24,.96));border-right:1px solid rgba(91,118,190,.28);box-shadow:12px 0 45px rgba(0,0,0,.22)}
.logo{background:linear-gradient(135deg,#5b35ff,#9b45ff);box-shadow:0 0 26px rgba(124,60,255,.62),inset 0 0 18px rgba(255,255,255,.14)}
.brand h1,.top h2,.section-head h3,.rule-name,.integration b,.modal-head h3,.lock-card h2{color:#f7f8ff}
.nav button{color:#a8b3cf;border:1px solid transparent;transition:.18s ease}
.nav button.active,.nav button:hover{background:linear-gradient(90deg,rgba(106,57,255,.25),rgba(38,80,190,.12));color:#c4b5fd;border-color:rgba(126,74,255,.48);box-shadow:0 0 22px rgba(108,54,255,.16),inset 3px 0 0 #8257ff}
.main{position:relative;background:transparent}
.top{padding-bottom:16px;border-bottom:1px solid rgba(63,84,137,.22)}
.top:before{content:"AUTOMAÇÃO • DADOS • PERFORMANCE";position:absolute;right:30px;top:8px;color:rgba(110,139,222,.11);font-size:10px;letter-spacing:.32em;pointer-events:none}
.btn{background:linear-gradient(180deg,rgba(13,22,45,.92),rgba(8,15,32,.95));border-color:#283b68;color:#cbd5f3;box-shadow:inset 0 0 0 1px rgba(255,255,255,.015);transition:.18s ease}
.btn:hover{border-color:#6d55ff;color:#fff;box-shadow:0 0 18px rgba(104,72,255,.18);transform:translateY(-1px)}
.btn.primary{background:linear-gradient(135deg,#6d39ff,#7c45ff 55%,#9b48ff);border-color:#9d6bff;color:white;box-shadow:0 0 24px rgba(110,57,255,.34)}
.btn.danger{color:#ff7a96;border-color:rgba(255,77,120,.35)}
.metric,.panel,.rule-card,.integration,.card,.template,.modal,.lock-card{background:linear-gradient(145deg,rgba(12,22,48,.88),rgba(7,13,29,.92));border-color:rgba(52,79,137,.58);box-shadow:var(--shadow);backdrop-filter:blur(15px)}
.template{border:1px solid rgba(52,79,137,.58);border-radius:15px;color:#eef2ff}.template h4{color:#f7f8ff}.template p{color:#8f9ab8}.card{color:#eef2ff}.card>b{color:#f7f8ff}
.metric{position:relative;overflow:hidden}.metric:after{content:"";position:absolute;inset:auto -20% -70% 20%;height:90px;background:radial-gradient(circle,rgba(64,108,255,.17),transparent 68%);pointer-events:none}
.metric:nth-child(1){border-bottom-color:#7c3cff}.metric:nth-child(2){border-bottom-color:#22b8ff}.metric:nth-child(3){border-bottom-color:#ffb84d}.metric:nth-child(4){border-bottom-color:#14f195}
.metric .value{color:#fff;text-shadow:0 0 18px rgba(127,92,255,.18)}
.rule-card{border-color:rgba(78,74,196,.65);box-shadow:0 0 0 1px rgba(113,74,255,.08),0 18px 50px rgba(0,0,0,.25),0 0 28px rgba(84,47,255,.08)}
.rule-card:hover{border-color:rgba(116,79,255,.92);box-shadow:0 0 30px rgba(97,60,255,.12),0 18px 50px rgba(0,0,0,.28)}
.pill{background:#111a31;color:#9ca9c8;border:1px solid rgba(61,81,129,.48)}
.pill.purple{background:rgba(109,57,255,.18);color:#b9a7ff;border-color:rgba(127,84,255,.42)}
.pill.green{background:rgba(20,241,149,.1);color:#28f2a2;border-color:rgba(20,241,149,.28)}
.pill.amber{background:rgba(255,184,77,.1);color:#ffc569;border-color:rgba(255,184,77,.28)}
.table th{background:rgba(15,28,56,.9);color:#8293bd;border-bottom-color:#29426f}.table td{border-bottom-color:rgba(41,59,98,.52);color:#dfe6fa}.table tr:hover td{background:rgba(23,42,78,.28)}
.thumb{background:#0d1730;border-color:#2c426e}.product-title{color:#f5f7ff}.muted{color:#8593b4!important}
.status{border:1px solid transparent}.status.published,.status.completed{background:rgba(20,241,149,.1);color:#25e99e;border-color:rgba(20,241,149,.22)}
.status.failed{background:rgba(255,77,120,.1);color:#ff7696;border-color:rgba(255,77,120,.22)}
.status.pending,.status.processing,.status.retry,.status.running{background:rgba(255,184,77,.1);color:#ffc267;border-color:rgba(255,184,77,.22)}
.status.skipped_duplicate{background:rgba(124,60,255,.12);color:#b49cff;border-color:rgba(124,60,255,.24)}
.log{border-bottom-color:rgba(42,60,98,.55)}
.integration{position:relative;overflow:hidden}.integration:after{content:"";position:absolute;right:-20px;top:-35px;width:90px;height:90px;border-radius:50%;background:radial-gradient(circle,rgba(25,200,255,.11),transparent 70%)}
.dot{box-shadow:0 0 12px rgba(20,241,149,.72)}.dot.off{box-shadow:0 0 12px rgba(255,77,120,.62)}
.field input,.field select,.lock-card input{background:#081127;border-color:#293d69;color:#edf2ff}.field input:focus,.field select:focus,.lock-card input:focus{border-color:#7c4dff;box-shadow:0 0 0 3px rgba(124,77,255,.12),0 0 18px rgba(124,77,255,.08)}
.modal-backdrop,.lock{background:rgba(1,4,12,.74);backdrop-filter:blur(10px)}
.toast{background:#0b1429;border:1px solid #354d7e;color:#f5f7ff;box-shadow:0 0 30px rgba(56,83,255,.18)}
.mini{background:linear-gradient(145deg,rgba(11,22,44,.95),rgba(7,13,28,.96));border-color:#2a416d;color:#93a3c7;box-shadow:0 0 18px rgba(0,0,0,.18)}
.sidebar-foot .mini b{color:#18e99a;text-shadow:0 0 11px rgba(20,241,149,.35)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:#050916}::-webkit-scrollbar-thumb{background:#263a68;border-radius:10px;border:2px solid #050916}::-webkit-scrollbar-thumb:hover{background:#4d46a8}


#ruleModal .modal{width:min(980px,96vw)}
.time-row{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center}.time-row span{color:#7585aa;font-size:11px}
.topic-custom{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.topic-custom.hidden{display:none}
.live-preview-field{margin-top:4px}.live-preview-card{border:1px solid rgba(80,103,168,.55);background:linear-gradient(145deg,rgba(7,15,34,.95),rgba(10,20,43,.88));border-radius:14px;padding:14px;min-height:145px;box-shadow:inset 0 0 26px rgba(40,73,150,.08)}
.live-preview-grid{display:grid;grid-template-columns:120px 1fr;gap:14px;align-items:start}.live-preview-grid img{width:120px;height:120px;object-fit:cover;border-radius:12px;border:1px solid #2a416d;background:#0c1630}.live-preview-message{white-space:pre-wrap;line-height:1.55;font-size:12px;color:#dce5fb}.live-preview-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px}.live-preview-placeholder{color:#7887aa;font-size:12px;padding:18px 4px}
.field input[type=time]{color-scheme:dark}
#telegramTopic,#intervalMinutes{background:#071127;color:#eef3ff;border-color:#29416e}
@media(max-width:700px){.live-preview-grid{grid-template-columns:1fr}.live-preview-grid img{width:100%;height:190px}.topic-custom{grid-template-columns:1fr}}

.preview-diagnostics{display:grid;gap:10px;color:#dce5fb}.preview-diagnostics-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.preview-diagnostics-head b{font-size:13px;color:#f5f7ff}.preview-diagnostics-head span{font-size:11px;color:#8290b2}.diag-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.diag-row{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid rgba(59,82,139,.55);border-radius:9px;background:rgba(5,13,31,.55);font-size:11px}.diag-row span{color:#8f9bbc}.diag-row strong{color:#eef3ff}.diag-row.good strong{color:#28e8a0}.diag-row.warn strong{color:#ffca6a}.diag-note{font-size:10px;color:#7180a4}.diag-suggestions{border-top:1px solid rgba(59,82,139,.45);padding-top:9px}.diag-suggestions b{font-size:11px;color:#bcb7ff}.diag-suggestions ul{margin:6px 0 0 17px;padding:0;color:#9ba8c8;font-size:11px;line-height:1.55}.preview-summary{margin-top:10px;padding-top:9px;border-top:1px solid rgba(59,82,139,.4);font-size:10px;color:#8190b1}.preview-summary .new-product{color:#25dba0}@media(max-width:700px){.diag-grid{grid-template-columns:1fr}}
</style></head><body><div class="shell"><aside class="sidebar"><div class="brand"><div class="logo">A</div><div><h1>Affiliate Automation</h1><small>motor independente</small></div></div><nav class="nav"><button class="active" data-view="dashboard">▦ <span>Dashboard</span></button><button data-view="automations">⚙ <span>Automações</span></button><button data-view="queue">≡ <span>Fila</span></button><button data-view="published">↗ <span>Publicações</span></button><button data-view="logs">⌁ <span>Logs</span></button><button data-view="content">✦ <span>Conteúdo</span></button><button data-view="settings">◉ <span>Configurações</span></button></nav><div class="sidefoot"><div class="mini">Cloudflare Worker<br><b id="workerState">Conectando…</b></div></div></aside><main class="main"><header class="top"><div><h2 id="pageTitle">Dashboard</h2><p id="pageSub">Visão operacional da automação</p></div><div class="actions"><button class="btn" id="refreshBtn">Atualizar</button><button class="btn primary" id="newBtn">+ Nova automação</button></div></header>
<section class="view active" id="view-dashboard"><div class="grid" id="metrics"></div><div class="section"><div class="section-head"><h3>Automações ativas</h3></div><div id="dashboardRules" class="rule-list"></div></div><div class="section"><div class="section-head"><h3>Publicações recentes</h3></div><div class="panel table-wrap"><table class="table"><thead><tr><th>Produto</th><th>Canal</th><th>Status</th><th>Horário</th></tr></thead><tbody id="dashboardPublished"></tbody></table></div></div></section>
<section class="view" id="view-automations"><div class="view-head"><label class="check"><input id="showPaused" type="checkbox"> Mostrar pausadas</label></div><div id="rules" class="rule-list"></div></section>
<section class="view" id="view-queue"><div class="panel table-wrap"><table class="table"><thead><tr><th>Produto</th><th>Status</th><th>Tentativas</th><th>Agendado</th><th>Erro</th><th>Ações</th></tr></thead><tbody id="queueBody"></tbody></table></div></section>
<section class="view" id="view-published"><div class="panel table-wrap"><table class="table"><thead><tr><th>Oferta</th><th>Canal</th><th>ID externo</th><th>Publicado em</th></tr></thead><tbody id="publishedBody"></tbody></table></div></section>
<section class="view" id="view-logs"><div class="panel" id="logsBody"></div></section>
<section class="view" id="view-content"><div class="template-grid" id="templates"></div><div class="section"><div class="card" style="padding:18px"><b>Templates por automação</b><div id="contentRules" class="rule-list" style="margin-top:12px"></div></div></div></section>
<section class="view" id="view-settings"><div class="integration-grid" id="integrations"></div><div class="section"><div class="card" style="padding:18px"><b>Telegram</b><div id="telegramInfo" class="muted" style="margin:10px 0">Carregando…</div><div class="actions"><input id="telegramThreadTest" type="number" min="1" placeholder="ID do tópico (opcional)" style="border:1px solid var(--line);border-radius:10px;padding:9px"><button class="btn" id="telegramTestBtn">Enviar teste</button></div></div></div><div class="section"><div class="card" style="padding:18px"><b>Sessão administrativa</b><p class="muted">A chave fica somente nesta aba.</p><button class="btn danger" id="logoutBtn">Encerrar sessão</button></div></div></section>
</main></div>
<div class="modal-backdrop" id="ruleModal"><div class="modal"><form id="ruleForm"><div class="modal-head"><h3 id="modalTitle">Automação</h3><button type="button" class="btn" id="closeModal">Fechar</button></div><div class="modal-body"><input id="ruleId" type="hidden"><div class="form-grid"><div class="field full"><label>Nome</label><input id="name" required></div><div class="field full"><label>Escopo da busca</label><select id="searchScope" onchange="var f=document.getElementById('keywordField');if(f)f.style.display=this.value==='all'?'none':''"><option value="all">Todos os produtos / nichos</option><option value="keyword">Palavra-chave / nicho específico</option></select><div class="muted" style="font-size:10px;margin-top:5px">“Todos os produtos” procura ofertas em vários nichos e ordenações, semelhante ao AFILIAPULSE.</div></div><div class="field full" id="keywordField"><label>Palavra-chave / nicho</label><input id="keyword" placeholder="Ex.: escova secadora, smartwatch, roupa pet"></div><div class="field"><label>Quantidade / ciclo</label><input id="quantity" type="number" min="1" max="100" value="1"></div><div class="field"><label>Dias sem repetir</label><input id="repeatDays" type="number" min="0" max="365" value="7"></div><div class="field"><label>Comissão mínima %</label><input id="minCommission" type="number" min="0" max="100" step="0.1"></div><div class="field"><label>Desconto mínimo %</label><input id="minDiscount" type="number" min="0" max="100" step="0.1"></div><div class="field"><label>Preço máximo</label><input id="maxPrice" type="number" min="0" step="0.01"></div><div class="field"><label>Ordenar</label><select id="sort"><option value="">Relevância</option><option value="commission">Comissão</option><option value="sales">Vendas</option><option value="discount">Desconto</option><option value="price">Preço</option></select></div><div class="field full"><label>Agenda Cron</label><input id="cron" value="0 9-22 * * *"></div><div class="field"><label>Template</label><select id="contentTemplate"><option value="offer">Oferta direta</option><option value="natural">Recomendação natural</option><option value="storytelling">Storytelling contextual</option><option value="no_price">Sem preço</option></select></div><div class="field"><label>Tópico Telegram (message_thread_id)</label><input id="threadId" type="number" min="1" placeholder="Geral se vazio"></div><div class="field full"><label>Timezone</label><input id="timezone" value="America/Sao_Paulo"></div><div class="field full"><label class="check"><input id="enabled" type="checkbox"> Ativa</label><label class="check"><input id="dryRun" type="checkbox" checked> Modo teste (não publica)</label></div></div></div><div class="modal-foot"><button type="button" class="btn" id="previewBtn">Pré-visualizar</button><button class="btn primary" type="submit">Salvar</button></div></form></div></div>
<div class="modal-backdrop" id="previewModal"><div class="modal"><div class="modal-head"><h3>Prévia da publicação</h3><button class="btn" id="closePreview">Fechar</button></div><div class="modal-body" id="previewBody"></div></div></div>
<div class="lock show" id="lock"><div class="lock-card"><div class="logo">A</div><h2>Painel administrativo</h2><p class="muted">Informe a AUTOMATION_SECRET.</p><input id="secretInput" type="password" placeholder="AUTOMATION_SECRET"><div id="lockError" class="red"></div><button class="btn primary" style="width:100%;margin-top:10px" id="loginBtn">Entrar</button></div></div><div class="toast" id="toast"></div>
<script>(function(){var state={data:null,view:'dashboard',telegram:null};var titles={dashboard:['Dashboard','Visão operacional da automação'],automations:['Automações','Gerencie regras e execuções'],queue:['Fila','Acompanhe e intervenha em publicações'],published:['Publicações','Histórico confirmado'],logs:['Logs','Diagnóstico operacional'],content:['Conteúdo','Templates de mensagens'],settings:['Configurações','Integrações e sessão']};var labels={published:'Publicado',completed:'Concluído',failed:'Falhou',pending:'Pendente',processing:'Processando',retry:'Nova tentativa',running:'Em execução',skipped_duplicate:'Ignorado · já publicado',cancelled:'Cancelado'};function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]})}function token(){return sessionStorage.getItem('automationSecret')||''}function fmt(v){if(!v)return'—';try{return new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v))}catch(e){return String(v)}}function status(v){return'<span class="status '+esc(v)+'">'+esc(labels[v]||v||'—')+'</span>'}function toast(m){var e=document.getElementById('toast');e.textContent=m;e.classList.add('show');setTimeout(function(){e.classList.remove('show')},3500)}async function api(path,opt){opt=opt||{};opt.headers=Object.assign({'authorization':'Bearer '+token(),'content-type':'application/json'},opt.headers||{});var r=await fetch(path,opt);if(r.status===401){showLock('Chave inválida.');throw new Error('UNAUTHORIZED')}var p=await r.json().catch(function(){return{}});if(!r.ok)throw new Error(p.message||p.error||'Falha na requisição');return p}function showLock(m){document.getElementById('lock').classList.add('show');document.getElementById('lockError').textContent=m||''}function hideLock(){document.getElementById('lock').classList.remove('show')}function titleFrom(o){return o&&o.offer_snapshot&&o.offer_snapshot.title?o.offer_snapshot.title:o&&o.offer_key?o.offer_key:'Oferta'}function imageFrom(o){return o&&o.offer_snapshot&&o.offer_snapshot.imageUrl?o.offer_snapshot.imageUrl:''}function product(o){var i=imageFrom(o);return'<div class="product">'+(i?'<img class="thumb" src="'+esc(i)+'" loading="lazy">':'<div class="thumb"></div>')+'<div class="product-title">'+esc(titleFrom(o))+'</div></div>'}function scheduleLabel(c){if(c==='0 9-22 * * *')return'1x/h · 09h–22h';if(c==='*/5 * * * *')return'a cada 5 min';if(c==='*/15 * * * *')return'a cada 15 min';return c||'sem agenda'}function scheduleLabelRule(r){var m=Number(r&&r.settings&&r.settings.intervalMinutes);if(Number.isInteger(m)&&m>0){var label=m<60?m+' min':m===60?'1 hora':m%60===0?(m/60)+' horas':(Math.floor(m/60)+'h'+String(m%60).padStart(2,'0'));var a=r.settings.windowStart||'09:00',b=r.settings.windowEnd||'22:00';return'a cada '+label+' · '+a+'–'+b}return scheduleLabel(r.schedule_cron)}function latestRun(id){return(state.data.runs||[]).find(function(r){return r.rule_id===id})}function ruleById(id){return(state.data.rules||[]).find(function(r){return r.id===id})}function templateName(r){var t=r&&r.settings&&r.settings.contentTemplate||'offer';return{offer:'Oferta direta',natural:'Recomendação natural',storytelling:'Storytelling',no_price:'Sem preço'}[t]||t}function ruleCard(r){var lr=latestRun(r.id),next=state.data.nextRuns&&state.data.nextRuns[r.id];return'<div class="rule-card"><div class="rule-top"><div><div class="rule-name">'+esc(r.name)+'</div><div class="rule-meta">'+esc(r.settings&&r.settings.searchScope==='all'?'Todos os produtos':r.keyword)+' · '+(r.enabled?'Ativa':'Pausada')+'</div><div class="pills"><span class="pill purple">Shopee → Telegram</span><span class="pill">'+esc(scheduleLabelRule(r))+'</span><span class="pill">'+esc(r.quantity)+' por ciclo</span><span class="pill">≥ '+esc(r.min_commission==null?0:r.min_commission)+'% comissão</span><span class="pill">≥ '+esc(r.min_discount==null?0:r.min_discount)+'% desconto</span><span class="pill">'+esc(r.avoid_repeat_days)+'d sem repetir</span><span class="pill">'+esc(templateName(r))+'</span>'+(r.dry_run?'<span class="pill amber">modo teste</span>':'<span class="pill green">produção</span>')+'</div><div class="runmeta">Última: '+esc(lr?fmt(lr.started_at):'ainda nenhuma')+(lr?' · '+esc(labels[lr.status]||lr.status):'')+' &nbsp; | &nbsp; Próxima: '+esc(next?fmt(next):'—')+'</div></div><div class="row-actions"><button class="btn small" data-toggle="'+r.id+'">'+(r.enabled?'Pausar':'Ativar')+'</button><button class="btn small" data-preview="'+r.id+'">Prévia</button><button class="btn small" data-run="'+r.id+'">Executar agora</button><button class="btn small primary" data-edit="'+r.id+'">Editar</button></div></div></div>'}function render(){var d=state.data;if(!d)return;var m=d.metrics;document.getElementById('metrics').innerHTML=[['Automações ativas',m.activeRules+'/'+m.totalRules,'regras habilitadas'],['Publicadas em 24h',m.published24h,'Telegram confirmado'],['Fila aberta',m.queueOpen,'pendentes / retry'],['Taxa de sucesso',m.successRate+'%','últimas 24h']].map(function(x){return'<div class="metric"><div class="label">'+x[0]+'</div><div class="value">'+x[1]+'</div><div class="sub">'+x[2]+'</div></div>'}).join('');renderRules();renderQueue();renderPublished();renderLogs();renderTemplates();renderIntegrations()}function renderRules(){var rs=state.data.rules||[],active=rs.filter(function(r){return r.enabled});document.getElementById('dashboardRules').innerHTML=active.length?active.slice(0,3).map(ruleCard).join(''):'<div class="empty">Nenhuma automação ativa.</div>';var show=document.getElementById('showPaused').checked;var list=show?rs:rs.filter(function(r){return r.enabled});document.getElementById('rules').innerHTML=list.length?list.map(ruleCard).join(''):'<div class="empty">Nenhuma automação nesta visualização.</div>';document.getElementById('contentRules').innerHTML=rs.filter(function(r){return r.enabled}).map(function(r){return'<div class="rule-card"><b>'+esc(r.name)+'</b><div class="pills"><span class="pill purple">'+esc(templateName(r))+'</span>'+(r.settings&&r.settings.telegramThreadId?'<span class="pill">Tópico '+esc(r.settings.telegramThreadId)+'</span>':'<span class="pill">Tópico Geral</span>')+'</div><button class="btn small primary" data-edit="'+r.id+'" style="margin-top:10px">Configurar conteúdo</button></div>'}).join('')||'<div class="empty">Nenhuma automação ativa.</div>'}function renderQueue(){var rows=state.data.queue||[];document.getElementById('queueBody').innerHTML=rows.length?rows.map(function(q){var a='';if(q.status==='failed'||q.status==='retry')a+='<button class="btn small" data-retry="'+q.id+'">Tentar novamente</button>';if(['pending','retry','failed'].includes(q.status))a+='<button class="btn small danger" data-cancel="'+q.id+'">Cancelar</button>';return'<tr><td>'+product(q)+'</td><td>'+status(q.status)+'</td><td>'+q.attempts+' / '+q.max_attempts+'</td><td>'+esc(fmt(q.scheduled_for))+'</td><td class="muted">'+esc(q.last_error||'—')+'</td><td><div class="row-actions">'+a+'</div></td></tr>'}).join(''):'<tr><td colspan="6" class="empty">Fila vazia.</td></tr>'}function publishedProduct(p){var q=(state.data.queue||[]).find(function(x){return x.id===p.source_queue_id});return q?product(q):'<b>'+esc(p.offer_key)+'</b>'}function renderPublished(){var rows=state.data.published||[],html=rows.length?rows.map(function(p){return'<tr><td>'+publishedProduct(p)+'</td><td>'+esc(p.channel)+'</td><td>'+esc(p.external_id||'—')+'</td><td>'+esc(fmt(p.published_at))+'</td></tr>'}).join(''):'<tr><td colspan="4" class="empty">Nenhuma publicação.</td></tr>';document.getElementById('publishedBody').innerHTML=html;document.getElementById('dashboardPublished').innerHTML=rows.length?rows.slice(0,5).map(function(p){return'<tr><td>'+publishedProduct(p)+'</td><td>'+esc(p.channel)+'</td><td>'+status('published')+'</td><td>'+esc(fmt(p.published_at))+'</td></tr>'}).join(''):'<tr><td colspan="4" class="empty">Nenhuma publicação recente.</td></tr>'}function renderLogs(){var runs=(state.data.runs||[]).map(function(r){var m=r.metadata||{},bits=[];if(m.searchScanned!=null)bits.push(m.searchScanned+' analisadas');if(m.searchCandidates!=null)bits.push(m.searchCandidates+' candidatas');if(m.dedupeCandidatesSkipped)bits.push(m.dedupeCandidatesSkipped+' repetida(s) ignorada(s)');if(r.published_count)bits.push(r.published_count+' publicada(s)');if(r.failed_count)bits.push(r.failed_count+' falha(s)');if(r.skipped_count)bits.push(r.skipped_count+' ignorada(s)');return{created_at:r.finished_at||r.started_at,status:r.status,event:'Ciclo '+(r.trigger_source==='manual'?'manual':'agendado'),message:bits.join(' · ')||('selecionadas '+r.selected_count)}});var logs=(state.data.logs||[]).map(function(l){return l});var all=runs.concat(logs).sort(function(a,b){return new Date(b.created_at)-new Date(a.created_at)}).slice(0,80);document.getElementById('logsBody').innerHTML=all.length?all.map(function(l){return'<div class="log"><time>'+esc(fmt(l.created_at))+'</time><div>'+status(l.status||l.event)+'</div><div><b>'+esc(l.event)+'</b><div class="muted">'+esc(l.message||'—')+'</div></div></div>'}).join(''):'<div class="empty">Nenhum log.</div>'}function renderTemplates(){var t=[['offer','Oferta direta','Preço, desconto e CTA objetivo.'],['natural','Recomendação natural','Texto mais conversacional, sem cara de banner.'],['storytelling','Storytelling contextual','Situação cotidiana sem inventar depoimento pessoal.'],['no_price','Sem preço','Leva ao link para conferir o valor atual.']];document.getElementById('templates').innerHTML=t.map(function(x){return'<div class="template card"><h4>'+esc(x[1])+'</h4><p>'+esc(x[2])+'</p></div>'}).join('')}function renderIntegrations(){var c=state.data.config||{},items=[['Cloudflare Worker',true],['Supabase',c.supabase],['Shopee Affiliate',c.shopee],['Telegram Bot',c.telegram]];document.getElementById('integrations').innerHTML=items.map(function(i){return'<div class="integration"><b>'+i[0]+'</b><div style="margin-top:9px;font-size:12px;color:'+(i[1]?'var(--green)':'var(--red)')+'">● '+(i[1]?'Conectado':'Não configurado')+'</div></div>'}).join('')}async function loadTelegram(){try{state.telegram=await api('/api/admin/telegram');var t=state.telegram;document.getElementById('telegramInfo').innerHTML=t.error?'<span class="red">'+esc(t.error)+'</span>':t.configured?'<b>'+esc(t.chatTitle||'Telegram')+'</b> · bot @'+esc(t.botUsername||'—')+' · '+(t.isForum?'grupo com tópicos':'grupo comum'):'Não configurado';var r=(state.data.rules||[]).find(function(x){return x.enabled&&x.settings&&x.settings.telegramThreadId});if(r)document.getElementById('telegramThreadTest').value=r.settings.telegramThreadId}catch(e){document.getElementById('telegramInfo').textContent=e.message}}async function refresh(){document.getElementById('workerState').textContent='Atualizando…';try{state.data=await api('/api/admin/dashboard');render();document.getElementById('workerState').textContent='Online';document.getElementById('pageSub').textContent=titles[state.view][1]+' · atualizado '+fmt(state.data.generatedAt);if(state.view==='settings')loadTelegram()}catch(e){document.getElementById('workerState').textContent='Erro';if(e.message!=='UNAUTHORIZED')toast(e.message);throw e}}function setView(v){state.view=v;document.querySelectorAll('.view').forEach(function(e){e.classList.remove('active')});document.getElementById('view-'+v).classList.add('active');document.querySelectorAll('.nav button').forEach(function(b){b.classList.toggle('active',b.dataset.view===v)});document.getElementById('pageTitle').textContent=titles[v][0];document.getElementById('pageSub').textContent=titles[v][1];if(v==='settings')loadTelegram()}function openModal(r){document.getElementById('ruleId').value=r?r.id:'';document.getElementById('modalTitle').textContent=r?'Editar automação':'Nova automação';['name','keyword'].forEach(function(k){document.getElementById(k).value=r?r[k]:''});var scope=r?(r.settings&&r.settings.searchScope==='all'?'all':'keyword'):'all';document.getElementById('searchScope').value=scope;document.getElementById('keywordField').style.display=scope==='all'?'none':'';document.getElementById('quantity').value=r?r.quantity:1;document.getElementById('repeatDays').value=r?r.avoid_repeat_days:7;document.getElementById('minCommission').value=r&&r.min_commission!=null?r.min_commission:'';document.getElementById('minDiscount').value=r&&r.min_discount!=null?r.min_discount:'';document.getElementById('maxPrice').value=r&&r.max_price!=null?r.max_price:'';document.getElementById('sort').value=r&&r.sort?r.sort:'';document.getElementById('cron').value=r&&r.schedule_cron?r.schedule_cron:'0 9-22 * * *';document.getElementById('timezone').value=r&&r.timezone?r.timezone:'America/Sao_Paulo';document.getElementById('enabled').checked=r?!!r.enabled:false;document.getElementById('dryRun').checked=r?!!r.dry_run:true;document.getElementById('contentTemplate').value=r&&r.settings&&r.settings.contentTemplate?r.settings.contentTemplate:'offer';document.getElementById('threadId').value=r&&r.settings&&r.settings.telegramThreadId?r.settings.telegramThreadId:'';document.getElementById('ruleModal').classList.add('show')}function closeModal(){document.getElementById('ruleModal').classList.remove('show')}function formPayload(){var id=document.getElementById('ruleId').value,r=id?ruleById(id):null,settings=Object.assign({},r&&r.settings||{});settings.contentTemplate=document.getElementById('contentTemplate').value;settings.searchScope=document.getElementById('searchScope').value||'all';var th=document.getElementById('threadId').value;settings.telegramThreadId=th?Number(th):null;function n(id){var v=document.getElementById(id).value;return v===''?null:Number(v)}return{name:document.getElementById('name').value,keyword:document.getElementById('keyword').value,quantity:Number(document.getElementById('quantity').value),avoid_repeat_days:Number(document.getElementById('repeatDays').value),min_commission:n('minCommission'),min_discount:n('minDiscount'),max_price:n('maxPrice'),sort:document.getElementById('sort').value||null,schedule_cron:document.getElementById('cron').value,timezone:document.getElementById('timezone').value,enabled:document.getElementById('enabled').checked,dry_run:document.getElementById('dryRun').checked,settings:settings}}async function saveRule(e){e.preventDefault();var id=document.getElementById('ruleId').value;try{await api(id?'/api/admin/rules/'+id:'/api/admin/rules',{method:id?'PATCH':'POST',body:JSON.stringify(formPayload())});closeModal();toast(id?'Automação atualizada.':'Automação criada em modo seguro.');await refresh()}catch(e){toast(e.message)}}async function toggleRule(id){var r=ruleById(id);try{await api('/api/admin/rules/'+id,{method:'PATCH',body:JSON.stringify({enabled:!r.enabled})});toast(r.enabled?'Automação pausada.':'Automação ativada.');await refresh()}catch(e){toast(e.message)}}async function runNow(id){var r=ruleById(id);if(!r)return;if(!r.dry_run&&!confirm('Isso publicará uma oferta REAL agora no Telegram. Continuar?'))return;try{toast('Executando…');var out=await api('/api/admin/rules/'+id+'/run',{method:'POST',body:JSON.stringify({confirm:'RUN_NOW'})});var processed=out.worker&&out.worker.processed||0;toast(r.dry_run?'Teste executado.':'Execução concluída · '+processed+' publicação(ões) processada(s).');await refresh()}catch(e){toast(e.message)}}async function showPreview(id){try{toast('Gerando prévia…');var body=id?{ruleId:id}:Object.assign({},formPayload(),{settings:formPayload().settings});var out=await api('/api/admin/preview',{method:'POST',body:JSON.stringify(body)});var p=out.publications&&out.publications[0];if(!p){toast('Nenhuma oferta elegível.');return}document.getElementById('previewBody').innerHTML=(p.offer.imageUrl?'<img class="preview-img" src="'+esc(p.offer.imageUrl)+'">':'')+'<b>'+esc(p.offer.title)+'</b><div class="preview" style="margin-top:12px">'+esc(p.content.body+'\n\n'+p.content.cta)+'</div><p class="muted">'+out.scanned+' ofertas analisadas · '+out.selected+' selecionada(s)</p>';document.getElementById('previewModal').classList.add('show')}catch(e){toast(e.message)}}async function queueAction(id,action){if(action==='cancel'&&!confirm('Cancelar este item da fila?'))return;try{await api('/api/admin/queue/'+id+'/'+action,{method:'POST',body:'{}'});toast(action==='retry'?'Retry executado.':'Item cancelado.');await refresh()}catch(e){toast(e.message)}}async function telegramTest(){if(!confirm('Enviar uma mensagem técnica real ao Telegram?'))return;var th=document.getElementById('telegramThreadTest').value;try{var out=await api('/api/admin/telegram/test',{method:'POST',body:JSON.stringify({confirm:'SEND_TEST',messageThreadId:th?Number(th):null})});toast('Teste enviado · ID '+(out.externalId||'—'))}catch(e){toast(e.message)}}document.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;if(b.dataset.view)setView(b.dataset.view);if(b.dataset.edit)openModal(ruleById(b.dataset.edit));if(b.dataset.toggle)toggleRule(b.dataset.toggle);if(b.dataset.preview)showPreview(b.dataset.preview);if(b.dataset.run)runNow(b.dataset.run);if(b.dataset.retry)queueAction(b.dataset.retry,'retry');if(b.dataset.cancel)queueAction(b.dataset.cancel,'cancel')});document.getElementById('showPaused').onchange=renderRules;document.getElementById('refreshBtn').onclick=refresh;document.getElementById('newBtn').onclick=function(){openModal(null)};document.getElementById('closeModal').onclick=closeModal;document.getElementById('ruleForm').onsubmit=saveRule;document.getElementById('previewBtn').onclick=function(){showPreview(document.getElementById('ruleId').value||null)};document.getElementById('closePreview').onclick=function(){document.getElementById('previewModal').classList.remove('show')};document.getElementById('telegramTestBtn').onclick=telegramTest;document.getElementById('logoutBtn').onclick=function(){sessionStorage.removeItem('automationSecret');showLock('Sessão encerrada.')};document.getElementById('loginBtn').onclick=async function(){var s=document.getElementById('secretInput').value.trim();if(!s)return;sessionStorage.setItem('automationSecret',s);try{await refresh();hideLock()}catch(e){showLock('Não foi possível autenticar.')}};document.getElementById('secretInput').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('loginBtn').click()});if(token())refresh().then(hideLock).catch(function(){showLock('Informe a chave novamente.')});else showLock('')})();</script>
<script>(function(){
  var nativeFetch=window.fetch.bind(window), intervalOptions=[[10,'10 minutos'],[15,'15 minutos'],[20,'20 minutos'],[30,'30 minutos'],[45,'45 minutos'],[60,'1 hora'],[90,'1 hora e 30 min'],[120,'2 horas'],[180,'3 horas'],[240,'4 horas'],[360,'6 horas'],[720,'12 horas']];
  function secret(){return sessionStorage.getItem('automationSecret')||''}
  function api(path,opt){opt=opt||{};opt.headers=Object.assign({'authorization':'Bearer '+secret(),'content-type':'application/json'},opt.headers||{});return nativeFetch(path,opt).then(async function(r){var p=await r.json().catch(function(){return{}});if(!r.ok)throw new Error(p.message||p.error||'Falha');return p})}
  function byId(id){return document.getElementById(id)}
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]})}
  function currentTopicName(){var sel=byId('telegramTopic');if(!sel||!sel.value)return'Tópico Geral';if(sel.value==='__custom__')return(byId('topicName')&&byId('topicName').value.trim())||('Tópico '+((byId('threadId')&&byId('threadId').value)||''));return sel.options[sel.selectedIndex]?sel.options[sel.selectedIndex].text:'Tópico Geral'}
  function currentThread(){var sel=byId('telegramTopic');if(!sel||!sel.value)return null;if(sel.value==='__custom__'){var n=Number(byId('threadId')&&byId('threadId').value);return Number.isInteger(n)&&n>0?n:null}var n=Number(sel.value);return Number.isInteger(n)&&n>0?n:null}
  function enhanceSchedule(){var cron=byId('cron');if(!cron)return;var field=cron.closest('.field');if(!field||byId('intervalMinutes'))return;field.classList.add('full');field.innerHTML='<label>Intervalo entre cada publicação</label><select id="intervalMinutes">'+intervalOptions.map(function(x){return'<option value="'+x[0]+'">'+x[1]+'</option>'}).join('')+'</select><label style="margin-top:8px">Janela de publicação</label><div class="time-row"><input id="windowStart" type="time" step="300" value="09:00"><span>até</span><input id="windowEnd" type="time" step="300" value="22:00"></div><input id="cron" type="hidden" value="0 9-22 * * *"><small class="muted">O Worker verifica a agenda a cada 5 minutos, mas só publica quando o intervalo escolhido for cumprido.</small>'}
  function enhanceTopic(){var old=byId('threadId');if(!old)return;var field=old.closest('.field');if(!field||byId('telegramTopic'))return;field.innerHTML='<label>Tópico do Telegram</label><select id="telegramTopic"><option value="">Tópico Geral</option><option value="__custom__">+ Cadastrar / usar outro tópico</option></select><div id="topicCustom" class="topic-custom hidden"><input id="topicName" placeholder="Nome do tópico"><input id="threadId" type="number" min="1" placeholder="message_thread_id"></div><small class="muted">Os tópicos já usados ficam disponíveis para seleção nas próximas automações.</small>';byId('telegramTopic').addEventListener('change',function(){toggleCustomTopic();refreshInlinePreview()})
  }
  function enhancePreview(){if(byId('livePreviewCard'))return;var grid=byId('ruleId')&&byId('ruleId').parentElement&&byId('ruleId').parentElement.querySelector('.form-grid');if(!grid)return;var wrap=document.createElement('div');wrap.className='field full live-preview-field';wrap.innerHTML='<label>Prévia da publicação</label><div id="livePreviewCard" class="live-preview-card"><div class="live-preview-placeholder">Informe uma palavra-chave e clique em “Atualizar prévia”. A foto e a mensagem aparecerão aqui antes de salvar a automação.</div></div>';grid.appendChild(wrap);var b=byId('previewBtn');if(b)b.textContent='Atualizar prévia'}
  function toggleCustomTopic(){var sel=byId('telegramTopic'),box=byId('topicCustom');if(!sel||!box)return;box.classList.toggle('hidden',sel.value!=='__custom__')}
  async function refreshTopics(selectedId,selectedName){var sel=byId('telegramTopic');if(!sel)return;try{var info=await api('/api/admin/telegram');var topics=info.topics||[];var html='<option value="">Tópico Geral</option>';topics.forEach(function(t){html+='<option value="'+esc(t.id)+'">'+esc(t.name)+' · #'+esc(t.id)+'</option>'});html+='<option value="__custom__">+ Cadastrar / usar outro tópico</option>';sel.innerHTML=html;var sid=selectedId?String(selectedId):'';if(sid&&Array.from(sel.options).some(function(o){return o.value===sid})){sel.value=sid}else if(sid){sel.value='__custom__';if(byId('threadId'))byId('threadId').value=sid;if(byId('topicName'))byId('topicName').value=selectedName||''}else sel.value='';toggleCustomTopic()}catch(e){console.warn('topics',e)}}
  function inferLegacyInterval(cron){if(cron==='*/10 * * * *')return 10;if(cron==='*/15 * * * *')return 15;if(cron==='*/20 * * * *')return 20;if(cron==='*/30 * * * *')return 30;if(cron==='0 9-22 * * *')return 60;return 60}
  async function hydrate(ruleId){try{var data=await api('/api/admin/dashboard'),rule=ruleId?(data.rules||[]).find(function(r){return r.id===ruleId}):null,settings=rule&&rule.settings||{};if(byId('intervalMinutes'))byId('intervalMinutes').value=String(Number(settings.intervalMinutes)||inferLegacyInterval(rule&&rule.schedule_cron));if(byId('windowStart'))byId('windowStart').value=settings.windowStart||'09:00';if(byId('windowEnd'))byId('windowEnd').value=settings.windowEnd||'22:00';await refreshTopics(settings.telegramThreadId,settings.telegramTopicName);if(!rule){if(byId('threadId'))byId('threadId').value='';if(byId('topicName'))byId('topicName').value=''}setTimeout(function(){if(byId('keyword')&&byId('keyword').value.trim())refreshInlinePreview()},120)}catch(e){console.warn('hydrate',e)}}
  function renderPreviewDiagnostics(res){
    var d=res&&res.diagnostics||{},suggestions=res&&res.suggestions||[],scanned=Number(res&&res.scanned||d.scanned||0);
    var rows=[
      ['Não relacionados / acessórios',d.rejectedRelevance||0,''],
      ['Abaixo da comissão mínima',d.belowCommission||0,'warn'],
      ['Abaixo do desconto mínimo',d.belowDiscount||0,'warn'],
      ['Acima do preço máximo',d.aboveMaxPrice||0,'warn'],
      ['Anúncios equivalentes',d.equivalentDuplicates||0,''],
      ['Métricas inválidas',d.invalidMetrics||0,''],
      ['Elegíveis',d.eligible||0,'good']
    ];
    var html='<div class="preview-diagnostics"><div class="preview-diagnostics-head"><b>Nenhuma oferta elegível com a combinação atual</b><span>'+esc(scanned)+' analisadas · '+esc(res&&res.pages||0)+' página(s)</span></div><div class="diag-grid">';
    rows.forEach(function(r){html+='<div class="diag-row '+r[2]+'"><span>'+esc(r[0])+'</span><strong>'+esc(r[1])+'</strong></div>'});
    html+='</div><div class="diag-note">Os motivos são independentes: o mesmo anúncio pode deixar de atender a mais de um filtro.</div>';
    if(suggestions.length){html+='<div class="diag-suggestions"><b>Sugestões para ampliar a busca</b><ul>';suggestions.forEach(function(x){html+='<li>'+esc(x)+'</li>'});html+='</ul></div>'}
    html+='</div>';return html;
  }
  function previewDiagnosticSummary(res){var d=res&&res.diagnostics||{};var zero=Number(d.zeroSalesAccepted||0);return '<div class="preview-summary">'+esc(res&&res.scanned||0)+' anúncios únicos · '+esc(d.eligible||0)+' elegíveis · '+esc(res&&res.strategy&&res.strategy.requests||res&&res.pages||0)+' consultas'+(zero? ' · <span class="new-product">'+esc(zero)+' com 0 vendas aceitas</span>':'')+'</div>'}
  async function refreshInlinePreview(){
    var card=byId('livePreviewCard'),keyword=byId('keyword');if(!card||!keyword||!keyword.value.trim())return;if(card.dataset.loading==='1')return;
    card.dataset.loading='1';card.innerHTML='<div class="live-preview-placeholder">Buscando ofertas e analisando cada filtro…</div>';
    try{
      var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',searchScope:(byId('searchScope')&&byId('searchScope').value)||'all',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()};
      var payload={keyword:keyword.value.trim(),quantity:1,minCommission:byId('minCommission')&&byId('minCommission').value,minDiscount:byId('minDiscount')&&byId('minDiscount').value,maxPrice:byId('maxPrice')&&byId('maxPrice').value,settings:settings};
      var res=await api('/api/admin/preview',{method:'POST',body:JSON.stringify(payload)}),pub=res.publications&&res.publications[0];
      if(!pub){card.innerHTML=renderPreviewDiagnostics(res);return}
      var img=pub.offer&&pub.offer.imageUrl?'<img src="'+esc(pub.offer.imageUrl)+'" alt="Produto">':'<div style="width:120px;height:120px;border:1px solid #29416e;border-radius:12px"></div>';
      var msg=[pub.content.title,pub.content.body,pub.content.cta].filter(Boolean).join('\n\n');
      card.innerHTML='<div class="live-preview-grid">'+img+'<div><div class="live-preview-meta"><span class="pill purple">'+esc((byId('contentTemplate')&&byId('contentTemplate').options[byId('contentTemplate').selectedIndex].text)||'Template')+'</span><span class="pill">'+esc(currentTopicName())+'</span></div><div class="live-preview-message">'+esc(msg)+'</div>'+previewDiagnosticSummary(res)+'</div></div>';
    }catch(e){card.innerHTML='<div class="live-preview-placeholder">Não foi possível gerar a prévia: '+esc(e.message)+'</div>'}finally{card.dataset.loading='0'}
  }
  function enrichRequest(input,init){var url=typeof input==='string'?input:(input&&input.url)||'';if(!init||!init.body||!/^\/api\/admin\/rules(?:\/[0-9a-f-]{36})?$/i.test(url))return init;try{var body=JSON.parse(String(init.body));body.schedule_cron='0 9-22 * * *';body.settings=Object.assign({},body.settings||{},{intervalMinutes:Number(byId('intervalMinutes')&&byId('intervalMinutes').value)||60,windowStart:(byId('windowStart')&&byId('windowStart').value)||'09:00',windowEnd:(byId('windowEnd')&&byId('windowEnd').value)||'22:00',telegramThreadId:currentThread(),telegramTopicName:currentThread()?currentTopicName():null});return Object.assign({},init,{body:JSON.stringify(body)})}catch(e){return init}}
  window.fetch=function(input,init){return nativeFetch(input,enrichRequest(input,init))};
  enhanceSchedule();enhanceTopic();enhancePreview();refreshTopics();
  document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('#newBtn,[data-edit],#previewBtn');if(!t)return;if(t.id==='previewBtn'){e.preventDefault();e.stopImmediatePropagation();refreshInlinePreview();return}if(t.id==='newBtn')setTimeout(function(){hydrate(null)},80);else if(t.dataset&&t.dataset.edit)setTimeout(function(){hydrate(t.dataset.edit)},80)},true);
  document.addEventListener('change',function(e){if(['contentTemplate','telegramTopic'].includes(e.target.id))refreshInlinePreview();if(['intervalMinutes','windowStart','windowEnd'].includes(e.target.id)&&byId('cron'))byId('cron').value='0 9-22 * * *'});
  if(byId('keyword'))byId('keyword').addEventListener('blur',function(){refreshInlinePreview()});
})();</script>
</body></html>`;

export function adminPage(){return new Response(ADMIN_HTML,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-frame-options":"DENY","referrer-policy":"no-referrer","content-security-policy":"default-src 'self'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"}});}
