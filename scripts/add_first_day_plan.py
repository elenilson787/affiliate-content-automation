from pathlib import Path

path = Path('src/admin.ts')
text = path.read_text()

# Imports used by the non-publishing first-day coverage planner.
old = 'import { generateContent, type ContentTemplate } from "../lib/content-engine";\nimport { createTelegramPublisher } from "../lib/publishers/telegram";\nimport { runRuleNow, searchOffersForRule, workerTick } from "./automation";'
new = 'import { generateContent, type ContentTemplate } from "../lib/content-engine";\nimport { productsLookEquivalent } from "../lib/offer-engine";\nimport { createTelegramPublisher } from "../lib/publishers/telegram";\nimport type { Offer } from "../lib/types";\nimport { runRuleNow, searchOffersForRule, workerTick } from "./automation";'
assert old in text, 'imports anchor not found'
text = text.replace(old, new, 1)
old = 'import { handleCatalogAdminApi } from "./catalog";'
new = 'import { handleCatalogAdminApi } from "./catalog";\nimport { chooseMixNiche, nicheLabel, sourceMode } from "./rule-policy";'
assert old in text, 'rule-policy import anchor not found'
text = text.replace(old, new, 1)

backend = r'''
function planDateKey(date: Date, timezone: string) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date).map((part)=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validDateKey(value: unknown) { const v=typeof value==="string"?value:""; return /^\d{4}-\d{2}-\d{2}$/.test(v)?v:""; }
function shiftDateKey(key: string, days: number) { const d=new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function dateKeyWeekday(key: string) { return new Date(`${key}T12:00:00Z`).getUTCDay(); }
function planWeekdays(settings: JsonObject) {
  const raw=Array.isArray(settings.activeWeekdays)?settings.activeWeekdays.map(Number).filter((v)=>Number.isInteger(v)&&v>=0&&v<=6):[];
  return raw.length?Array.from(new Set(raw)):[0,1,2,3,4,5,6];
}
function firstPlanDate(settings: JsonObject, timezone: string) {
  const today=planDateKey(new Date(),timezone); const configured=validDateKey(settings.activeStartDate); let key=configured&&configured>today?configured:today;
  const end=validDateKey(settings.activeEndDate); const allowed=planWeekdays(settings);
  for(let guard=0;guard<3700;guard+=1){ if(end&&key>end)return null; if(allowed.includes(dateKeyWeekday(key)))return key; key=shiftDateKey(key,1); }
  return null;
}
function zonedPlanDate(dateKey: string, totalMinutes: number, timezone: string) {
  const dayOffset=Math.floor(totalMinutes/1440); const minute=((totalMinutes%1440)+1440)%1440; const shifted=shiftDateKey(dateKey,dayOffset);
  const [year,month,day]=shifted.split("-").map(Number); const hour=Math.floor(minute/60); const min=minute%60; const desired=Date.UTC(year,month-1,day,hour,min,0,0);
  let guess=new Date(desired);
  for(let pass=0;pass<3;pass+=1){
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(guess).map((part)=>[part.type,part.value]));
    const observed=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),0,0);
    const delta=desired-observed; if(!delta)break; guess=new Date(guess.getTime()+delta);
  }
  return guess;
}
function planSlots(dateKey: string, settings: JsonObject, timezone: string) {
  const start=clockToMinutes(validClock(settings.windowStart,"09:00")); const end=clockToMinutes(validClock(settings.windowEnd,"22:00")); const interval=intervalValue(settings)||60;
  const span=start<=end?end-start:(1440-start)+end; const count=Math.floor(span/interval)+1; const slots=[] as Array<{index:number;time:string;date:Date;nicheId:string|null}>;
  for(let index=0;index<count;index+=1){ const total=start+index*interval; const minute=((total%1440)+1440)%1440; const hh=String(Math.floor(minute/60)).padStart(2,"0"),mm=String(minute%60).padStart(2,"0"); const date=zonedPlanDate(dateKey,total,timezone); slots.push({index,time:`${hh}:${mm}`,date,nicheId:null}); }
  return slots;
}
function countPlanDays(settings: JsonObject, firstDate: string) {
  const end=validDateKey(settings.activeEndDate); if(!end)return null; const allowed=planWeekdays(settings); let key=firstDate,count=0;
  for(let guard=0;guard<3700&&key<=end;guard+=1){ if(allowed.includes(dateKeyWeekday(key)))count+=1; key=shiftDateKey(key,1); }
  return count;
}
async function recentPlanOffers(db: SupabaseRest, days: number) {
  if(days<=0)return [] as Offer[]; const cutoff=new Date(Date.now()-days*86_400_000).toISOString();
  const rows=await db.select<{offer_snapshot:Offer|null}>("publication_queue",new URLSearchParams({select:"offer_snapshot",status:"eq.published",published_at:`gte.${cutoff}`,order:"published_at.desc",limit:"500"}));
  return rows.map((row)=>row.offer_snapshot).filter((offer):offer is Offer=>Boolean(offer));
}
async function firstDayPlanPreview(request: Request, env: Env) {
  const body=await request.json().catch(()=>({})) as JsonObject; const settings=(body.settings&&typeof body.settings==="object"&&!Array.isArray(body.settings)?body.settings:{}) as JsonObject;
  const minCommission=nullableNumber(body.minCommission??body.min_commission,0,100)??undefined; const minDiscount=nullableNumber(body.minDiscount??body.min_discount,0,100)??undefined; const maxPrice=nullableNumber(body.maxPrice??body.max_price,0,1_000_000)??undefined;
  const requestedSort=["commission","price","sales","discount"].includes(String(body.sort))?String(body.sort) as AutomationRuleRow["sort"]:null; const timezone=text(body.timezone,80)||"America/Sao_Paulo";
  const repeatRaw=nullableNumber(body.avoidRepeatDays??body.avoid_repeat_days,0,365); const avoidRepeatDays=repeatRaw==null?0:Math.round(repeatRaw);
  const dateKey=firstPlanDate(settings,timezone); if(!dateKey)return json({error:"Nenhum dia ativo disponível dentro do período selecionado."},422);
  const allSlots=planSlots(dateKey,settings,timezone); const MAX_PREVIEW_SLOTS=180; const slots=allSlots.slice(0,MAX_PREVIEW_SLOTS); const truncated=allSlots.length>slots.length;
  const rule:AutomationRuleRow={id:"first-day-plan",name:"Agenda prevista",enabled:false,networks:["shopee"],channels:["telegram"],keyword:"",category:null,min_commission:minCommission??null,min_discount:minDiscount??null,max_price:maxPrice??null,quantity:1,sort:requestedSort,avoid_repeat_days:avoidRepeatDays,schedule_cron:null,timezone,dry_run:true,settings:{...settings,searchScope:"all"}};
  const db=new SupabaseRest(env); const recent=await recentPlanOffers(db,avoidRepeatDays); const planned:Offer[]=[];
  const excluded=(offer:Offer)=>recent.some((old)=>productsLookEquivalent(old,offer))||planned.some((old)=>productsLookEquivalent(old,offer));
  type Assignment={offer:Offer;commissionResolved:number|null;sourceNiche:string|null;scanned:number;pages:number}; const assignments=new Map<number,Assignment>(); let scanned=0,pages=0;
  const fill=async(group:typeof slots,slotDate:Date)=>{ if(!group.length)return; const result=await searchOffersForRule(db,env,rule,group.length,excluded,slotDate); scanned+=result.scanned; pages+=result.pages; result.selected.forEach((offer,index)=>{ const target=group[index]; if(!target)return; planned.push(offer); assignments.set(target.index,{offer,commissionResolved:result.commissionResolved,sourceNiche:result.sourceNiche,scanned:result.scanned,pages:result.pages}); }); };
  const mode=sourceMode(settings);
  if(mode==="mix"){
    const groups=new Map<string,typeof slots>();
    for(const slot of slots){ const niche=chooseMixNiche(settings,slot.date,timezone)||""; slot.nicheId=niche||null; const group=groups.get(niche)||[]; group.push(slot); groups.set(niche,group); }
    for(const group of groups.values())await fill(group,group[0].date);
  }else await fill(slots,slots[0]?.date||new Date());
  const defaultNiche=mode==="niche"?nicheLabel(settings.niche):mode==="list"?String(settings.listName||"Lista inteligente"):mode==="all"?"Todos os nichos":null;
  const output=slots.map((slot)=>{ const found=assignments.get(slot.index); const requestedNiche=slot.nicheId?nicheLabel(slot.nicheId):defaultNiche; return {index:slot.index,time:slot.time,scheduledFor:slot.date.toISOString(),requestedNiche,status:found?"filled":"missing",commissionResolved:found?.commissionResolved??null,sourceNiche:found?.sourceNiche??null,offer:found?.offer??null}; });
  const filled=output.filter((slot)=>slot.status==="filled").length; const activeDays=countPlanDays(settings,dateKey); const futureDays=activeDays==null?null:Math.max(0,activeDays-1);
  return json({dryRun:true,firstDay:dateKey,totalSlots:allSlots.length,previewedSlots:slots.length,filled,missing:Math.max(0,allSlots.length-filled),coverage:allSlots.length?Math.round((filled/allSlots.length)*1000)/10:0,truncated,scanned,pages,continuous:activeDays==null,activeDays,futureDays,revalidateBeforePublish:true,slots:output,message:activeDays==null||futureDays>0?"Somente o primeiro dia é planejado agora. Nos próximos dias, novos produtos serão buscados automaticamente quando cada novo ciclo diário começar e serão revalidados perto de cada horário.":"A agenda abaixo cobre o único dia ativo selecionado."});
}
'''
marker = '\nexport async function handleAdminApi(request: Request, env: Env) {'
assert marker in text, 'backend insertion marker not found'
text = text.replace(marker, '\n'+backend+marker, 1)

old = '  if(request.method==="POST"&&path==="/api/admin/preview") return preview(request,env);'
new = old + '\n  if(request.method==="POST"&&path==="/api/admin/plan-preview") return firstDayPlanPreview(request,env);'
assert old in text, 'preview route anchor not found'
text = text.replace(old, new, 1)

# Commercial styling for the planning card.
old = '.capacity-box b{font-size:13px;color:#fff}.capacity-box div{font-size:10px;color:#9dabcb;margin-top:4px}.smart-inline{display:grid;grid-template-columns:1fr 1fr;gap:9px}'
new = '.capacity-box b{font-size:13px;color:#fff}.capacity-box div{font-size:10px;color:#9dabcb;margin-top:4px}.day-plan-box{border:1px solid rgba(68,102,180,.72);background:rgba(7,15,34,.72);border-radius:12px;padding:12px}.day-plan-head{display:flex;justify-content:space-between;gap:10px;align-items:center}.day-plan-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:10px}.day-plan-stat{border:1px solid rgba(44,65,111,.62);border-radius:9px;padding:8px;background:rgba(10,24,51,.62)}.day-plan-stat small{display:block;color:#8090b5;font-size:9px}.day-plan-stat b{font-size:14px}.day-plan-progress{height:7px;border-radius:999px;background:#101d39;overflow:hidden;margin:10px 0}.day-plan-progress span{display:block;height:100%;background:linear-gradient(90deg,#7c45ff,#19c8ff);border-radius:999px}.day-plan-list{display:grid;gap:6px;max-height:430px;overflow:auto;padding-right:3px}.day-plan-row{display:grid;grid-template-columns:64px 42px minmax(0,1fr) auto;gap:9px;align-items:center;border:1px solid rgba(44,65,111,.55);border-radius:9px;padding:8px;background:rgba(8,18,39,.62)}.day-plan-row img{width:42px;height:42px;border-radius:8px;object-fit:cover;background:#fff}.day-plan-time{font-weight:900;color:#beaaff}.day-plan-title{font-size:10px;font-weight:800;color:#edf2ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.day-plan-meta{font-size:9px;color:#8190b3;margin-top:3px}.day-plan-note{font-size:9px!important;line-height:1.55;color:#91a0c2!important;margin-top:9px!important}.smart-inline{display:grid;grid-template-columns:1fr 1fr;gap:9px}'
assert old in text, 'css anchor not found'
text = text.replace(old, new, 1)

old = "var SMART={data:null,telegram:null,automationFilter:'all',activityFilter:'all',activityMode:'list'};"
new = "var SMART={data:null,telegram:null,automationFilter:'all',activityFilter:'all',activityMode:'list',dayPlanSignature:null,dayPlanResult:null};"
assert old in text, 'SMART anchor not found'
text = text.replace(old, new, 1)

# Create and render the new step between Content and Execution.
insert_marker = 'function moveSmartNode(target,node){if(target&&node&&node.parentElement!==target)target.appendChild(node)}\n'
ui_functions = r'''function ensureDayPlanUI(){var grid=document.querySelector('#ruleForm .form-grid'),block=document.getElementById('dayPlanBlock');if(block)return block;if(!grid)return null;block=document.createElement('div');block.id='dayPlanBlock';block.className='field full';block.innerHTML='<div class="day-plan-box"><div class="day-plan-head"><div><b>Agenda prevista do 1º dia</b><div class="muted" style="font-size:9px;margin-top:3px">Confira se existem ofertas suficientes para os horários antes de ativar a campanha.</div></div><button type="button" class="btn small primary" id="generateDayPlanBtn">Gerar agenda do 1º dia</button></div><div id="dayPlanBody" class="day-plan-note">Ainda não calculada. A agenda é uma simulação de cobertura e não publica nada.</div></div>';grid.appendChild(block);return block}
function dayPlanSignature(){var d=window.readAutomationDraftFromForm?window.readAutomationDraftFromForm():null;if(!d)return'';var s=d.settings||{};return JSON.stringify({minCommission:d.minCommission,minDiscount:d.minDiscount,maxPrice:d.maxPrice,sort:d.sort,avoidRepeatDays:d.avoidRepeatDays,timezone:d.timezone,settings:{intervalMinutes:s.intervalMinutes,windowStart:s.windowStart,windowEnd:s.windowEnd,activeStartDate:s.activeStartDate,activeEndDate:s.activeEndDate,activeWeekdays:s.activeWeekdays,sourceMode:s.sourceMode,niche:s.niche,nicheMix:s.nicheMix,listId:s.listId,flexCommissionEnabled:s.flexCommissionEnabled,flexCommissionStep:s.flexCommissionStep,flexCommissionFloor:s.flexCommissionFloor}})}
function invalidateDayPlan(){if(!SMART.dayPlanSignature)return;SMART.dayPlanSignature=null;var body=document.getElementById('dayPlanBody');if(body)body.innerHTML='<span style="color:#ffc66d">⚠ Configuração alterada. Gere novamente a agenda do primeiro dia antes de ativar.</span>'}
function renderDayPlan(res){var body=document.getElementById('dayPlanBody');if(!body)return;var slots=res.slots||[],pct=Number(res.coverage||0),full=Number(res.filled||0)>=Number(res.totalSlots||0)&&!res.truncated;var status=full?'✅ Cobertura completa':Number(res.filled||0)>0?'⚠ Cobertura parcial':'❌ Sem cobertura',rows=slots.map(function(x){var o=x.offer||{},img=o.imageUrl?'<img src="'+sEsc(o.imageUrl)+'" loading="lazy">':'<div style="width:42px;height:42px;border-radius:8px;background:#101b34"></div>',commission=o.commissionPercent!=null?Number(o.commissionPercent).toFixed(0)+'%':'—',discount=o.discountPercent!=null?Number(o.discountPercent).toFixed(0)+'%':'—';return'<div class="day-plan-row"><div class="day-plan-time">'+sEsc(x.time)+'</div>'+img+'<div><div class="day-plan-title">'+sEsc(o.title||'Nenhuma oferta encontrada para este horário')+'</div><div class="day-plan-meta">'+sEsc(x.requestedNiche||'Todos os nichos')+(x.status==='filled'?' · comissão '+commission+' · desconto '+discount:' · continuará procurando automaticamente')+'</div></div><span class="state-badge '+(x.status==='filled'?'state-active':'state-paused')+'">'+(x.status==='filled'?'Encontrada':'Pendente')+'</span></div>'}).join('');var future=(res.continuous||Number(res.futureDays||0)>0)?'<div class="day-plan-note">🔄 '+sEsc(res.message||'Os produtos dos próximos dias serão buscados automaticamente no novo ciclo diário.')+'</div>':'';var trunc=res.truncated?'<div class="day-plan-note">⚠ A agenda possui '+sEsc(res.totalSlots)+' horários; esta prévia exibiu os primeiros '+sEsc(res.previewedSlots)+'.</div>':'';body.innerHTML='<div class="day-plan-summary"><div class="day-plan-stat"><small>COBERTURA</small><b>'+sEsc(pct)+'%</b></div><div class="day-plan-stat"><small>HORÁRIOS PREENCHIDOS</small><b>'+sEsc(res.filled)+' / '+sEsc(res.totalSlots)+'</b></div><div class="day-plan-stat"><small>PRIMEIRO DIA</small><b>'+sEsc(res.firstDay)+'</b></div></div><div class="day-plan-progress"><span style="width:'+Math.min(100,pct)+'%"></span></div><div style="font-size:10px;font-weight:900;margin-bottom:8px">'+status+'</div><div class="day-plan-list">'+rows+'</div>'+future+trunc+'<div class="day-plan-note">ℹ Esta agenda comprova a cobertura encontrada agora. Na execução real, cada horário revalida os filtros e pode substituir a oferta se preço, desconto, comissão ou disponibilidade mudarem.</div>'}
async function generateDayPlan(){var btn=document.getElementById('generateDayPlanBtn'),body=document.getElementById('dayPlanBody');if(!body||!window.readAutomationDraftFromForm)return null;if(btn){btn.disabled=true;btn.textContent='Buscando ofertas…'}body.innerHTML='<span class="muted">Buscando produtos diferentes para preencher os horários do primeiro dia…</span>';try{var draft=window.readAutomationDraftFromForm(),res=await sApi('/api/admin/plan-preview',{method:'POST',body:JSON.stringify(draft)});SMART.dayPlanResult=res;SMART.dayPlanSignature=dayPlanSignature();renderDayPlan(res);return res}catch(err){SMART.dayPlanResult=null;SMART.dayPlanSignature=null;body.innerHTML='<span style="color:#ff7895">Não foi possível gerar a agenda: '+sEsc(err.message)+'</span>';return null}finally{if(btn){btn.disabled=false;btn.textContent='Gerar agenda do 1º dia'}}}
'''
assert insert_marker in text, 'moveSmartNode marker not found'
text = text.replace(insert_marker, ui_functions + insert_marker, 1)

old = "content=smartSection('formContent','6 · Conteúdo','Escolha o formato da mensagem e confira a prévia.'),execution=smartSection('formExecution','7 · Execução','Defina se ficará ativa e se está em modo de teste.');"
new = "content=smartSection('formContent','6 · Conteúdo','Escolha o formato da mensagem e confira a prévia.'),planning=smartSection('formPlanning','7 · Planejamento','Valide a cobertura do primeiro dia antes de ativar.'),execution=smartSection('formExecution','8 · Execução','Defina se ficará ativa e se está em modo de teste.');"
assert old in text, 'organize section anchor not found'
text = text.replace(old, new, 1)
old = "moveSmartNode(content,document.getElementById('livePreviewCard')?.closest('.field'));moveSmartNode(execution,field('enabled'));"
new = "moveSmartNode(content,document.getElementById('livePreviewCard')?.closest('.field'));moveSmartNode(planning,ensureDayPlanUI());moveSmartNode(execution,field('enabled'));"
assert old in text, 'planning placement anchor not found'
text = text.replace(old, new, 1)

old = "return{keyword:'',quantity:1,minCommission:body.min_commission,minDiscount:body.min_discount,maxPrice:body.max_price,sort:body.sort,timezone:body.timezone,settings:body.settings};}"
new = "return{keyword:'',quantity:1,minCommission:body.min_commission,minDiscount:body.min_discount,maxPrice:body.max_price,sort:body.sort,timezone:body.timezone,avoidRepeatDays:num('repeatDays')==null?7:num('repeatDays'),settings:body.settings};}"
assert old in text, 'draft return anchor not found'
text = text.replace(old, new, 1)

# Manual generation button and stale-plan tracking.
old = "document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button');if(!b)return;if(b.dataset.view==='queue')"
new = "document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button');if(!b)return;if(b.id==='generateDayPlanBtn'){e.preventDefault();e.stopPropagation();generateDayPlan();return}if(b.dataset.view==='queue')"
assert old in text, 'click listener anchor not found'
text = text.replace(old, new, 1)

old = "document.addEventListener('change',function(e){if(['intervalMinutes','windowStart','windowEnd','activeStartDate','activeEndDate','sourceMode'].indexOf(e.target.id)>=0||e.target.hasAttribute('data-weekday'))updateCapacity();if(e.target.id==='minCommission'||e.target.id==='flexCommissionEnabled')updateFlexUI()});document.addEventListener('input',function(e){if(['intervalMinutes','windowStart','windowEnd'].indexOf(e.target.id)>=0)updateCapacity()});\nsetupLayout();"
new = "document.addEventListener('change',function(e){if(['intervalMinutes','windowStart','windowEnd','activeStartDate','activeEndDate','sourceMode'].indexOf(e.target.id)>=0||e.target.hasAttribute('data-weekday'))updateCapacity();if(e.target.id==='minCommission'||e.target.id==='flexCommissionEnabled')updateFlexUI();if(e.target.closest&&e.target.closest('#ruleForm'))invalidateDayPlan()});document.addEventListener('input',function(e){if(['intervalMinutes','windowStart','windowEnd'].indexOf(e.target.id)>=0)updateCapacity();if(e.target.closest&&e.target.closest('#ruleForm'))invalidateDayPlan()});\ndocument.addEventListener('submit',function(e){if(!e.target||e.target.id!=='ruleForm')return;var enabled=document.getElementById('enabled')?.checked,dry=document.getElementById('dryRun')?.checked;if(!enabled||dry)return;var signature=dayPlanSignature();if(!signature||SMART.dayPlanSignature!==signature){e.preventDefault();e.stopImmediatePropagation();generateDayPlan().then(function(){document.getElementById('formPlanning')?.scrollIntoView({behavior:'smooth',block:'center'})});return}var r=SMART.dayPlanResult;if(r&&Number(r.filled||0)<Number(r.totalSlots||0)&&!window.confirm('A cobertura do primeiro dia está parcial ('+r.filled+' de '+r.totalSlots+' horários). O sistema continuará procurando ofertas automaticamente. Deseja ativar mesmo assim?')){e.preventDefault();e.stopImmediatePropagation()}},true);\nsetupLayout();"
assert old in text, 'change/submit anchor not found'
text = text.replace(old, new, 1)

# Reset coverage whenever another automation is opened/new.
old = "function hydrateSmartForm(ruleId){ensureSmartForm();var r=ruleId&&SMART.data?"
new = "function hydrateSmartForm(ruleId){SMART.dayPlanSignature=null;SMART.dayPlanResult=null;var planBody=document.getElementById('dayPlanBody');if(planBody)planBody.innerHTML='Ainda não calculada. Gere a agenda do primeiro dia antes de ativar.';ensureSmartForm();var r=ruleId&&SMART.data?"
assert old in text, 'hydrate anchor not found'
text = text.replace(old, new, 1)

path.write_text(text)
print('first-day planning patch applied')
