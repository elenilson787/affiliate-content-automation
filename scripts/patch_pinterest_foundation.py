from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, found {count}")
    return text.replace(old, new, 1)

# worker routes/config
path = Path('src/worker.ts')
text = path.read_text()
text = replace_once(
    text,
    'import { required, type Env } from "./env";\n',
    'import { required, type Env } from "./env";\nimport { handlePinterestAdminApi, handlePinterestCallback, pinterestAppConfigured } from "./pinterest";\n',
    'worker pinterest import',
)
text = replace_once(
    text,
    '    telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),\n    supabase:',
    '    telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),\n    pinterest: pinterestAppConfigured(env),\n    supabase:',
    'worker safe config',
)
text = replace_once(
    text,
    '  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {\n    return adminPage();\n  }\n\n  if (url.pathname.startsWith("/api/admin/")) {',
    '  if (request.method === "GET" && url.pathname === "/oauth/pinterest/callback") {\n    return handlePinterestCallback(request, env);\n  }\n\n  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {\n    return adminPage();\n  }\n\n  if (url.pathname.startsWith("/api/admin/")) {',
    'worker callback route',
)
text = replace_once(
    text,
    '    try {\n      return await handleAdminApi(request, env);',
    '    try {\n      if (url.pathname.startsWith("/api/admin/pinterest/")) return await handlePinterestAdminApi(request, env);\n      return await handleAdminApi(request, env);',
    'worker admin pinterest route',
)
path.write_text(text)

# automation publisher support
path = Path('src/automation.ts')
text = path.read_text()
text = replace_once(
    text,
    'import { createTelegramPublisher } from "../lib/publishers/telegram";\n',
    'import { createTelegramPublisher } from "../lib/publishers/telegram";\nimport { createPinterestPublisher } from "../lib/publishers/pinterest";\n',
    'automation pinterest publisher import',
)
text = replace_once(
    text,
    'import { chooseMixNiche, commissionPlan, isSlotDue, mixFallbackOrder, nicheLabel, nicheQuery, sourceMode } from "./rule-policy";\n',
    'import { chooseMixNiche, commissionPlan, isSlotDue, mixFallbackOrder, nicheLabel, nicheQuery, sourceMode } from "./rule-policy";\nimport { getPinterestAccess, pinterestApiBase } from "./pinterest";\n',
    'automation pinterest connection import',
)
text = replace_once(
    text,
    '  const messageThreadId = Number.isInteger(threadRaw) && threadRaw > 0 ? threadRaw : undefined;\n  return { template, messageThreadId };',
    '  const messageThreadId = Number.isInteger(threadRaw) && threadRaw > 0 ? threadRaw : undefined;\n  const pinterestBoardId = typeof settings.pinterestBoardId === "string" && settings.pinterestBoardId.trim()\n    ? settings.pinterestBoardId.trim()\n    : undefined;\n  return { template, messageThreadId, pinterestBoardId };',
    'automation content options',
)
text = replace_once(
    text,
    '    messageThreadId: Number.isInteger(Number(content.messageThreadId)) && Number(content.messageThreadId) > 0\n      ? Number(content.messageThreadId)\n      : undefined,\n  };',
    '    messageThreadId: Number.isInteger(Number(content.messageThreadId)) && Number(content.messageThreadId) > 0\n      ? Number(content.messageThreadId)\n      : undefined,\n    pinterestBoardId: typeof content.pinterestBoardId === "string" && content.pinterestBoardId.trim()\n      ? content.pinterestBoardId.trim()\n      : undefined,\n  };',
    'automation queue content pinterest board',
)
old_publish = '''    const content = contentFromQueue(row);\n    if (row.channel !== "telegram") throw new Error(`PUBLISHER_NOT_CONFIGURED: ${row.channel}`);\n\n    const publisher = createTelegramPublisher({\n      token: required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),\n      chatId: required(env.TELEGRAM_CHAT_ID, "TELEGRAM_CHAT_ID"),\n    });\n    const result = await publisher.publish(content);'''
new_publish = '''    const content = contentFromQueue(row);\n    let result: { externalId?: string };\n    if (row.channel === "telegram") {\n      const publisher = createTelegramPublisher({\n        token: required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),\n        chatId: required(env.TELEGRAM_CHAT_ID, "TELEGRAM_CHAT_ID"),\n      });\n      result = await publisher.publish(content);\n    } else if (row.channel === "pinterest") {\n      const { connection, accessToken } = await getPinterestAccess(env, db);\n      const boardId = content.pinterestBoardId || connection.default_board_id || "";\n      if (!boardId) throw new Error("PINTEREST_DEFAULT_BOARD_REQUIRED");\n      const publisher = createPinterestPublisher({\n        accessToken,\n        boardId,\n        apiBase: pinterestApiBase(env),\n      });\n      result = await publisher.publish(content);\n    } else {\n      throw new Error(`PUBLISHER_NOT_CONFIGURED: ${row.channel}`);\n    }'''
text = replace_once(text, old_publish, new_publish, 'automation publish switch')
path.write_text(text)

# admin commercial Pinterest UI/config
path = Path('src/admin.ts')
text = path.read_text()
text = replace_once(
    text,
    'return { shopee: Boolean(env.SHOPEE_APP_ID && env.SHOPEE_SECRET), telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), supabase:',
    'return { shopee: Boolean(env.SHOPEE_APP_ID && env.SHOPEE_SECRET), telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), pinterest: Boolean(env.PINTEREST_APP_ID && env.PINTEREST_APP_SECRET && env.PINTEREST_REDIRECT_URI && env.PINTEREST_TOKEN_KEY), supabase:',
    'admin safe config',
)
text = replace_once(
    text,
    '.integration-commercial-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:11px}',
    '.integration-commercial-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:11px}',
    'integration grid responsive',
)
text = replace_once(
    text,
    "var SMART={data:null,telegram:null,automationFilter:'all',activityFilter:'all',activityMode:'list',dayPlanSignature:null,dayPlanResult:null};",
    "var SMART={data:null,telegram:null,pinterest:null,automationFilter:'all',activityFilter:'all',activityMode:'list',dayPlanSignature:null,dayPlanResult:null};",
    'SMART pinterest state',
)
anchor = 'function smartDateToday(){var p=localKey(new Date());return p.key}'
if text.count(anchor) != 1:
    raise SystemExit('smartDateToday anchor missing')
pinterest_ui = r'''function renderPinterestCommercial(){var p=SMART.pinterest||{},configured=!!p.configured,connected=!!p.connected,boards=Array.isArray(p.boards)?p.boards:[],account=p.account||{},state=connected?'Conectado':configured?'Não conectado':'Configuração pendente',cls=connected?'state-active':configured?'state-problem':'state-scheduled';var select=connected?'<select id="pinterestBoardSelect"><option value="">Selecione a pasta padrão</option>'+boards.map(function(b){return'<option value="'+sEsc(b.id)+'" '+(String(p.defaultBoardId||'')===String(b.id)?'selected':'')+'>'+sEsc(b.name)+'</option>'}).join('')+'</select>':'';var actions=!configured?'<div class="muted">A integração já está preparada no sistema. Para conectar, ainda será necessário cadastrar o App ID, App Secret, Redirect URI e a chave de criptografia no Cloudflare.</div>':!connected?'<button class="btn primary" data-pinterest-connect>Conectar Pinterest</button>':'<div class="smart-actions" style="justify-content:flex-start"><button class="btn" data-pinterest-test>Testar conexão</button><button class="btn danger" data-pinterest-disconnect>Desconectar</button></div>';return'<div class="smart-section" style="margin-top:12px"><div class="smart-section-head"><div><h3>📌 Pinterest</h3><div class="muted">Conexão oficial via OAuth 2.0 · boards e Pins pela API v5.</div></div><span class="state-badge '+cls+'">'+state+'</span></div>'+(connected?'<div class="smart-inline"><div class="field"><label>Conta conectada</label><div class="capacity-box"><b>@'+sEsc(account.username||account.id||'Pinterest')+'</b><div>'+sEsc(p.environment||'production')+' · '+boards.length+' pasta(s) disponível(is)</div></div></div><div class="field"><label>Pasta padrão das automações</label>'+select+'<button class="btn small primary" style="margin-top:7px" data-pinterest-save-board>Salvar pasta padrão</button></div></div>':'')+'<div style="margin-top:12px">'+actions+'</div></div>'}
function renderIntegrationsCommercial(){var root=document.getElementById('commercialIntegrations');if(!root||!SMART.data)return;var c=SMART.data.config||{},t=SMART.telegram||{},p=SMART.pinterest||{},pStatus=p.connected?'Conectado':p.configured?'Não conectado':'Preparado',pMode=p.connected?'live':p.configured?'live':'ready';var cards=[['🛍️','Shopee Affiliate',c.shopee?'Conectado':'Não configurado',c.shopee?'API de afiliados pronta para buscar ofertas.':'Credenciais da Shopee ainda não estão disponíveis.','live'],['✈️','Telegram',c.telegram?'Conectado':'Não configurado',c.telegram?((t.chatTitle||'Grupo Telegram')+' · '+((t.topics||[]).length)+' tópico(s) cadastrado(s)'):'Configure o bot e o grupo de destino.','live'],['📌','Pinterest',pStatus,p.connected?('@'+String((p.account||{}).username||'conta')+' · '+((p.boards||[]).length)+' pasta(s)'):p.configured?'Clique em Conectar para autorizar sua conta Pinterest.':'Conector oficial pronto; faltam as credenciais do app. ',pMode],['🟢','WhatsApp','Em breve','Envio automatizado para grupos e canais, com conexão própria.','soon'],['🔵','Facebook','Em breve','Publicação de ofertas em destinos autorizados.','soon'],['🧵','Threads','Em breve','Transforme ofertas em posts curtos automaticamente.','soon']];root.innerHTML='<div class="smart-section"><div class="smart-section-head"><div><h3>Integrações</h3><div class="muted">Conecte as plataformas usadas para encontrar e publicar ofertas.</div></div></div><div class="integration-commercial-grid">'+cards.map(function(x){var cls=x[4]==='soon'?'state-ended':x[2]==='Conectado'?'state-active':x[4]==='ready'?'state-scheduled':'state-problem';return'<div class="integration-commercial"><div class="icon">'+x[0]+'</div><h4>'+x[1]+'</h4><div class="state-badge '+cls+'">'+x[2]+'</div><p>'+sEsc(x[3])+'</p></div>'}).join('')+'</div></div>'+renderPinterestCommercial()}
async function loadPinterest(){try{SMART.pinterest=await sApi('/api/admin/pinterest/status')}catch(e){SMART.pinterest={configured:false,connected:false,message:e.message,boards:[]}}renderIntegrationsCommercial()}
'''
text = text.replace(anchor, pinterest_ui + anchor, 1)
old_refresh = "async function smartRefresh(){if(!sToken())return;try{SMART.data=await sApi('/api/admin/dashboard');try{SMART.telegram=await sApi('/api/admin/telegram')}catch(e){}renderSmartDashboard();renderSmartAutomations();renderActivity();renderIntegrationsCommercial()}catch(e){console.warn('smart refresh',e)}}"
new_refresh = "async function smartRefresh(){if(!sToken())return;try{SMART.data=await sApi('/api/admin/dashboard');try{SMART.telegram=await sApi('/api/admin/telegram')}catch(e){}try{SMART.pinterest=await sApi('/api/admin/pinterest/status')}catch(e){SMART.pinterest={configured:false,connected:false,message:e.message,boards:[]}}renderSmartDashboard();renderSmartAutomations();renderActivity();renderIntegrationsCommercial()}catch(e){console.warn('smart refresh',e)}}"
text = replace_once(text, old_refresh, new_refresh, 'smart refresh Pinterest')
change_anchor = "document.addEventListener('change',function(e){if(['intervalMinutes'"
if text.count(change_anchor) != 1:
    raise SystemExit('change listener anchor missing')
pinterest_handlers = r'''document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button');if(!b)return;if(b.hasAttribute('data-pinterest-connect')){e.preventDefault();sApi('/api/admin/pinterest/auth-url',{method:'POST',body:'{}'}).then(function(r){var w=window.open(r.url,'pinterest-oauth','width=720,height=820,resizable=yes,scrollbars=yes');if(!w)window.location.href=r.url}).catch(function(err){alert(err.message)});return}if(b.hasAttribute('data-pinterest-test')){e.preventDefault();sApi('/api/admin/pinterest/test',{method:'POST',body:'{}'}).then(function(){alert('Pinterest conectado e respondendo corretamente.');return loadPinterest()}).catch(function(err){alert(err.message)});return}if(b.hasAttribute('data-pinterest-save-board')){e.preventDefault();var select=document.getElementById('pinterestBoardSelect'),boardId=select&&select.value;if(!boardId){alert('Selecione uma pasta do Pinterest.');return}sApi('/api/admin/pinterest/default-board',{method:'POST',body:JSON.stringify({boardId:boardId})}).then(function(){return loadPinterest()}).catch(function(err){alert(err.message)});return}if(b.hasAttribute('data-pinterest-disconnect')){e.preventDefault();if(!confirm('Desconectar o Pinterest? As automações com esse destino ficarão indisponíveis até reconectar.'))return;sApi('/api/admin/pinterest/disconnect',{method:'POST',body:'{}'}).then(function(){return loadPinterest()}).catch(function(err){alert(err.message)});return}if(b.dataset.view==='settings')setTimeout(function(){document.getElementById('pageSub').textContent='Shopee, Telegram, Pinterest e próximos canais';loadPinterest()},45)},true);
window.addEventListener('message',function(e){if(e.origin===location.origin&&e.data&&e.data.type==='pinterest-connected')setTimeout(loadPinterest,350)});
'''
text = text.replace(change_anchor, pinterest_handlers + change_anchor, 1)
path.write_text(text)
print('Pinterest foundation patch applied')
