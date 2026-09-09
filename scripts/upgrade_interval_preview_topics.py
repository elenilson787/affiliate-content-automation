from pathlib import Path

# ---------------- automation.ts: interval scheduler ----------------
p = Path('src/automation.ts')
s = p.read_text()

anchor = '''async function loadEnabledRules(db: SupabaseRest) {\n  const params = new URLSearchParams({ select: "*", enabled: "eq.true", order: "created_at.asc" });\n  return db.select<AutomationRuleRow>("automation_rules", params);\n}\n'''
insert = anchor + r'''
function intervalMinutes(settings: Record<string, unknown>) {
  const value = Number(settings.intervalMinutes);
  return Number.isInteger(value) && value >= 5 && value <= 1440 && value % 5 === 0 ? value : null;
}

function clockSetting(settings: Record<string, unknown>, key: string, fallback: string) {
  const value = typeof settings[key] === "string" ? String(settings[key]) : fallback;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function clockMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function localClockMinutes(date: Date, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function insidePublishWindow(date: Date, timezone: string, settings: Record<string, unknown>) {
  const start = clockMinutes(clockSetting(settings, "windowStart", "09:00"));
  const end = clockMinutes(clockSetting(settings, "windowEnd", "22:00"));
  const current = localClockMinutes(date, timezone);
  return start <= end ? current >= start && current <= end : current >= start || current <= end;
}

function intervalDueSlot(now: Date, timezone: string, settings: Record<string, unknown>, lastRunAt?: string | null) {
  const interval = intervalMinutes(settings);
  if (!interval) return null;
  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);
  if (!insidePublishWindow(slot, timezone, settings)) return null;
  if (lastRunAt) {
    const last = new Date(lastRunAt).getTime();
    if (Number.isFinite(last) && slot.getTime() - last < interval * 60_000) return null;
  }
  return slot;
}
'''
if anchor not in s:
    raise SystemExit('automation loadEnabledRules anchor not found')
s = s.replace(anchor, insert, 1)

old = '''  for (const rule of rules) {\n    if (!rule.schedule_cron?.trim()) continue;\n    const timezone = rule.timezone || env.DEFAULT_TIMEZONE || "America/Sao_Paulo";\n    const slot = findDueSlot(rule.schedule_cron, now, timezone, SCHEDULER_LOOKBACK_MINUTES);\n    if (!slot) continue;\n    results.push(await executeRule(db, env, rule, slot));\n  }\n'''
new = '''  for (const rule of rules) {\n    const timezone = rule.timezone || env.DEFAULT_TIMEZONE || "America/Sao_Paulo";\n    let slot: Date | null = null;\n\n    if (intervalMinutes(rule.settings)) {\n      const lastRuns = await db.select<{ started_at: string }>(\n        "automation_runs",\n        new URLSearchParams({ select: "started_at", rule_id: eq(rule.id), order: "started_at.desc", limit: "1" }),\n      );\n      slot = intervalDueSlot(now, timezone, rule.settings, lastRuns[0]?.started_at);\n    } else if (rule.schedule_cron?.trim()) {\n      slot = findDueSlot(rule.schedule_cron, now, timezone, SCHEDULER_LOOKBACK_MINUTES);\n    }\n\n    if (!slot) continue;\n    results.push(await executeRule(db, env, rule, slot));\n  }\n'''
if old not in s:
    raise SystemExit('automation scheduler loop not found')
s = s.replace(old, new, 1)
p.write_text(s)

# ---------------- admin.ts: interval next run, topic catalog, UI enhancer ----------------
p = Path('src/admin.ts')
s = p.read_text()

old = '''function nextSlot(expression: string | null, timezone: string, from = new Date()) {\n  if (!expression) return null;\n  const start = new Date(from.getTime() + 60_000); start.setUTCSeconds(0, 0);\n  for (let i = 0; i < 10_080; i += 1) {\n    const candidate = new Date(start.getTime() + i * 60_000);\n    if (cronMatches(expression, candidate, timezone)) return candidate.toISOString();\n  }\n  return null;\n}\n'''
new = r'''function nextSlot(expression: string | null, timezone: string, from = new Date()) {
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
'''
if old not in s:
    raise SystemExit('admin nextSlot not found')
s = s.replace(old, new, 1)

s = s.replace('''  if (input.schedule_cron !== undefined) { const v=input.schedule_cron===null?null:text(input.schedule_cron,100); if(v&&v.split(/\\s+/).length!==5) throw new Error("Cron deve ter 5 campos."); patch.schedule_cron=v||null; } else if (creating) patch.schedule_cron="0 9-22 * * *";''', '''  if (input.schedule_cron !== undefined) { const v=input.schedule_cron===null?null:text(input.schedule_cron,100); if(v&&v.split(/\\s+/).length!==5) throw new Error("Cron deve ter 5 campos."); patch.schedule_cron=v||null; } else if (creating) patch.schedule_cron="*/5 * * * *";''', 1)

old = '''    patch.settings={ purpose:"admin_ui", priority:100, maxAttempts:3, contentTemplate:"offer", ...(patch.settings as JsonObject || {}) };'''
new = '''    patch.settings={ purpose:"admin_ui", priority:100, maxAttempts:3, contentTemplate:"offer", intervalMinutes:60, windowStart:"09:00", windowEnd:"22:00", ...(patch.settings as JsonObject || {}) };'''
if old not in s:
    raise SystemExit('admin settings defaults not found')
s = s.replace(old, new, 1)

old = '''  const nextRuns=Object.fromEntries(rules.map(r=>[r.id,r.enabled?nextSlot(r.schedule_cron,r.timezone||"America/Sao_Paulo",now):null]));'''
new = '''  const nextRuns=Object.fromEntries(rules.map(r=>{ const last=runs.find((run:any)=>run.rule_id===r.id) as any; return [r.id,r.enabled?nextRuleSlot(r,last?.started_at?String(last.started_at):null,now):null]; }));'''
if old not in s:
    raise SystemExit('admin nextRuns not found')
s = s.replace(old, new, 1)

start = s.index('async function telegramInfo(env: Env) {')
end = s.index('\nasync function preview(request: Request, env: Env) {', start)
old = s[start:end]
new = r'''async function telegramInfo(env: Env) {
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
'''
s = s[:start] + new + s[end:]

# Friendly schedule label in cards.
old = '''function scheduleLabel(c){if(c==='0 9-22 * * *')return'1x/h · 09h–22h';if(c==='*/5 * * * *')return'a cada 5 min';if(c==='*/15 * * * *')return'a cada 15 min';return c||'sem agenda'}'''
new = '''function scheduleLabel(c){if(c==='0 9-22 * * *')return'1x/h · 09h–22h';if(c==='*/5 * * * *')return'a cada 5 min';if(c==='*/15 * * * *')return'a cada 15 min';return c||'sem agenda'}function scheduleLabelRule(r){var m=Number(r&&r.settings&&r.settings.intervalMinutes);if(Number.isInteger(m)&&m>0){var label=m<60?m+' min':m===60?'1 hora':m%60===0?(m/60)+' horas':(Math.floor(m/60)+'h'+String(m%60).padStart(2,'0'));var a=r.settings.windowStart||'09:00',b=r.settings.windowEnd||'22:00';return'a cada '+label+' · '+a+'–'+b}return scheduleLabel(r.schedule_cron)}'''
if old not in s:
    raise SystemExit('admin scheduleLabel JS not found')
s = s.replace(old, new, 1)
s = s.replace("esc(scheduleLabel(r.schedule_cron))", "esc(scheduleLabelRule(r))")

# Fix remaining light blocks in cyberpunk theme.
css_anchor = '''.metric,.panel,.rule-card,.integration,.modal,.lock-card{background:linear-gradient(145deg,rgba(12,22,48,.88),rgba(7,13,29,.92));border-color:rgba(52,79,137,.58);box-shadow:var(--shadow);backdrop-filter:blur(15px)}'''
css_new = '''.metric,.panel,.rule-card,.integration,.card,.template,.modal,.lock-card{background:linear-gradient(145deg,rgba(12,22,48,.88),rgba(7,13,29,.92));border-color:rgba(52,79,137,.58);box-shadow:var(--shadow);backdrop-filter:blur(15px)}\n.template{border:1px solid rgba(52,79,137,.58);border-radius:15px;color:#eef2ff}.template h4{color:#f7f8ff}.template p{color:#8f9ab8}.card{color:#eef2ff}.card>b{color:#f7f8ff}'''
if css_anchor not in s:
    raise SystemExit('cyber css panel anchor not found')
s = s.replace(css_anchor, css_new, 1)

extra_css = r'''
#ruleModal .modal{width:min(980px,96vw)}
.time-row{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center}.time-row span{color:#7585aa;font-size:11px}
.topic-custom{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.topic-custom.hidden{display:none}
.live-preview-field{margin-top:4px}.live-preview-card{border:1px solid rgba(80,103,168,.55);background:linear-gradient(145deg,rgba(7,15,34,.95),rgba(10,20,43,.88));border-radius:14px;padding:14px;min-height:145px;box-shadow:inset 0 0 26px rgba(40,73,150,.08)}
.live-preview-grid{display:grid;grid-template-columns:120px 1fr;gap:14px;align-items:start}.live-preview-grid img{width:120px;height:120px;object-fit:cover;border-radius:12px;border:1px solid #2a416d;background:#0c1630}.live-preview-message{white-space:pre-wrap;line-height:1.55;font-size:12px;color:#dce5fb}.live-preview-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px}.live-preview-placeholder{color:#7887aa;font-size:12px;padding:18px 4px}
.field input[type=time]{color-scheme:dark}
#telegramTopic,#intervalMinutes{background:#071127;color:#eef3ff;border-color:#29416e}
@media(max-width:700px){.live-preview-grid{grid-template-columns:1fr}.live-preview-grid img{width:100%;height:190px}.topic-custom{grid-template-columns:1fr}}
'''
marker = '</style></head><body>'
if marker not in s:
    raise SystemExit('style closing marker not found')
s = s.replace(marker, extra_css + marker, 1)

# Inject an independent enhancement script before </body>; it enriches the existing form without rewriting the core UI.
enhancer = r'''
<script>(function(){
  var nativeFetch=window.fetch.bind(window), intervalOptions=[[10,'10 minutos'],[15,'15 minutos'],[20,'20 minutos'],[30,'30 minutos'],[45,'45 minutos'],[60,'1 hora'],[90,'1 hora e 30 min'],[120,'2 horas'],[180,'3 horas'],[240,'4 horas'],[360,'6 horas'],[720,'12 horas']];
  function secret(){return sessionStorage.getItem('automationSecret')||''}
  function api(path,opt){opt=opt||{};opt.headers=Object.assign({'authorization':'Bearer '+secret(),'content-type':'application/json'},opt.headers||{});return nativeFetch(path,opt).then(async function(r){var p=await r.json().catch(function(){return{}});if(!r.ok)throw new Error(p.message||p.error||'Falha');return p})}
  function byId(id){return document.getElementById(id)}
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]})}
  function currentTopicName(){var sel=byId('telegramTopic');if(!sel||!sel.value)return'Tópico Geral';if(sel.value==='__custom__')return(byId('topicName')&&byId('topicName').value.trim())||('Tópico '+((byId('threadId')&&byId('threadId').value)||''));return sel.options[sel.selectedIndex]?sel.options[sel.selectedIndex].text:'Tópico Geral'}
  function currentThread(){var sel=byId('telegramTopic');if(!sel||!sel.value)return null;if(sel.value==='__custom__'){var n=Number(byId('threadId')&&byId('threadId').value);return Number.isInteger(n)&&n>0?n:null}var n=Number(sel.value);return Number.isInteger(n)&&n>0?n:null}
  function enhanceSchedule(){var cron=byId('cron');if(!cron)return;var field=cron.closest('.field');if(!field||byId('intervalMinutes'))return;field.classList.add('full');field.innerHTML='<label>Intervalo entre cada publicação</label><select id="intervalMinutes">'+intervalOptions.map(function(x){return'<option value="'+x[0]+'">'+x[1]+'</option>'}).join('')+'</select><label style="margin-top:8px">Janela de publicação</label><div class="time-row"><input id="windowStart" type="time" step="300" value="09:00"><span>até</span><input id="windowEnd" type="time" step="300" value="22:00"></div><input id="cron" type="hidden" value="*/5 * * * *"><small class="muted">O Worker verifica a agenda a cada 5 minutos, mas só publica quando o intervalo escolhido for cumprido.</small>'}
  function enhanceTopic(){var old=byId('threadId');if(!old)return;var field=old.closest('.field');if(!field||byId('telegramTopic'))return;field.innerHTML='<label>Tópico do Telegram</label><select id="telegramTopic"><option value="">Tópico Geral</option><option value="__custom__">+ Cadastrar / usar outro tópico</option></select><div id="topicCustom" class="topic-custom hidden"><input id="topicName" placeholder="Nome do tópico"><input id="threadId" type="number" min="1" placeholder="message_thread_id"></div><small class="muted">Os tópicos já usados ficam disponíveis para seleção nas próximas automações.</small>';byId('telegramTopic').addEventListener('change',function(){toggleCustomTopic();refreshInlinePreview()})
  }
  function enhancePreview(){if(byId('livePreviewCard'))return;var grid=byId('ruleId')&&byId('ruleId').parentElement&&byId('ruleId').parentElement.querySelector('.form-grid');if(!grid)return;var wrap=document.createElement('div');wrap.className='field full live-preview-field';wrap.innerHTML='<label>Prévia da publicação</label><div id="livePreviewCard" class="live-preview-card"><div class="live-preview-placeholder">Informe uma palavra-chave e clique em “Atualizar prévia”. A foto e a mensagem aparecerão aqui antes de salvar a automação.</div></div>';grid.appendChild(wrap);var b=byId('previewBtn');if(b)b.textContent='Atualizar prévia'}
  function toggleCustomTopic(){var sel=byId('telegramTopic'),box=byId('topicCustom');if(!sel||!box)return;box.classList.toggle('hidden',sel.value!=='__custom__')}
  async function refreshTopics(selectedId,selectedName){var sel=byId('telegramTopic');if(!sel)return;try{var info=await api('/api/admin/telegram');var topics=info.topics||[];var html='<option value="">Tópico Geral</option>';topics.forEach(function(t){html+='<option value="'+esc(t.id)+'">'+esc(t.name)+' · #'+esc(t.id)+'</option>'});html+='<option value="__custom__">+ Cadastrar / usar outro tópico</option>';sel.innerHTML=html;var sid=selectedId?String(selectedId):'';if(sid&&Array.from(sel.options).some(function(o){return o.value===sid})){sel.value=sid}else if(sid){sel.value='__custom__';if(byId('threadId'))byId('threadId').value=sid;if(byId('topicName'))byId('topicName').value=selectedName||''}else sel.value='';toggleCustomTopic()}catch(e){console.warn('topics',e)}}
  function inferLegacyInterval(cron){if(cron==='*/10 * * * *')return 10;if(cron==='*/15 * * * *')return 15;if(cron==='*/20 * * * *')return 20;if(cron==='*/30 * * * *')return 30;if(cron==='0 9-22 * * *')return 60;return 60}
  async function hydrate(ruleId){try{var data=await api('/api/admin/dashboard'),rule=ruleId?(data.rules||[]).find(function(r){return r.id===ruleId}):null,settings=rule&&rule.settings||{};if(byId('intervalMinutes'))byId('intervalMinutes').value=String(Number(settings.intervalMinutes)||inferLegacyInterval(rule&&rule.schedule_cron));if(byId('windowStart'))byId('windowStart').value=settings.windowStart||'09:00';if(byId('windowEnd'))byId('windowEnd').value=settings.windowEnd||'22:00';await refreshTopics(settings.telegramThreadId,settings.telegramTopicName);if(!rule){if(byId('threadId'))byId('threadId').value='';if(byId('topicName'))byId('topicName').value=''}setTimeout(function(){if(byId('keyword')&&byId('keyword').value.trim())refreshInlinePreview()},120)}catch(e){console.warn('hydrate',e)}}
  async function refreshInlinePreview(){var card=byId('livePreviewCard'),keyword=byId('keyword');if(!card||!keyword||!keyword.value.trim())return;if(card.dataset.loading==='1')return;card.dataset.loading='1';card.innerHTML='<div class="live-preview-placeholder">Buscando uma oferta real e montando a prévia…</div>';try{var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()};var payload={keyword:keyword.value.trim(),quantity:1,minCommission:byId('minCommission')&&byId('minCommission').value,minDiscount:byId('minDiscount')&&byId('minDiscount').value,maxPrice:byId('maxPrice')&&byId('maxPrice').value,settings:settings};var res=await api('/api/admin/preview',{method:'POST',body:JSON.stringify(payload)}),pub=res.publications&&res.publications[0];if(!pub){card.innerHTML='<div class="live-preview-placeholder">Nenhuma oferta passou pelos filtros atuais. Ajuste os filtros e tente novamente.</div>';return}var img=pub.offer&&pub.offer.imageUrl?'<img src="'+esc(pub.offer.imageUrl)+'" alt="Produto">':'<div style="width:120px;height:120px;border:1px solid #29416e;border-radius:12px"></div>',msg=[pub.content.title,pub.content.body,pub.content.cta].filter(Boolean).join('\n\n');card.innerHTML='<div class="live-preview-grid">'+img+'<div><div class="live-preview-meta"><span class="pill purple">'+esc((byId('contentTemplate')&&byId('contentTemplate').options[byId('contentTemplate').selectedIndex].text)||'Template')+'</span><span class="pill">'+esc(currentTopicName())+'</span></div><div class="live-preview-message">'+esc(msg)+'</div></div></div>'}catch(e){card.innerHTML='<div class="live-preview-placeholder">Não foi possível gerar a prévia: '+esc(e.message)+'</div>'}finally{card.dataset.loading='0'}}
  function enrichRequest(input,init){var url=typeof input==='string'?input:(input&&input.url)||'';if(!init||!init.body||!/^\/api\/admin\/rules(?:\/[0-9a-f-]{36})?$/i.test(url))return init;try{var body=JSON.parse(String(init.body));body.schedule_cron='*/5 * * * *';body.settings=Object.assign({},body.settings||{},{intervalMinutes:Number(byId('intervalMinutes')&&byId('intervalMinutes').value)||60,windowStart:(byId('windowStart')&&byId('windowStart').value)||'09:00',windowEnd:(byId('windowEnd')&&byId('windowEnd').value)||'22:00',telegramThreadId:currentThread(),telegramTopicName:currentThread()?currentTopicName():null});return Object.assign({},init,{body:JSON.stringify(body)})}catch(e){return init}}
  window.fetch=function(input,init){return nativeFetch(input,enrichRequest(input,init))};
  enhanceSchedule();enhanceTopic();enhancePreview();refreshTopics();
  document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('#newBtn,[data-edit],#previewBtn');if(!t)return;if(t.id==='previewBtn'){e.preventDefault();e.stopImmediatePropagation();refreshInlinePreview();return}if(t.id==='newBtn')setTimeout(function(){hydrate(null)},80);else if(t.dataset&&t.dataset.edit)setTimeout(function(){hydrate(t.dataset.edit)},80)},true);
  document.addEventListener('change',function(e){if(['contentTemplate','telegramTopic'].includes(e.target.id))refreshInlinePreview();if(['intervalMinutes','windowStart','windowEnd'].includes(e.target.id)&&byId('cron'))byId('cron').value='*/5 * * * *'});
  if(byId('keyword'))byId('keyword').addEventListener('blur',function(){refreshInlinePreview()});
})();</script>
'''
if '</body></html>' not in s:
    raise SystemExit('body closing not found')
s = s.replace('</body></html>', enhancer + '</body></html>', 1)
p.write_text(s)
