from pathlib import Path
import re

root = Path('.')
auto_path = root / 'src/automation.ts'
admin_path = root / 'src/admin.ts'

auto = auto_path.read_text()
admin = admin_path.read_text()

# 1) Expor o mesmo motor de seleção usado pela automação real.
auto = auto.replace('async function searchOffers(\n', 'export async function searchOffersForRule(\n', 1)
auto = auto.replace('} = await searchOffers(db, env, rule, candidateTarget, excludeOffer, slot);', '} = await searchOffersForRule(db, env, rule, candidateTarget, excludeOffer, slot);', 1)

needle = '  let commissionAttempts: number[] = [];\n'
replacement = '''  let commissionAttempts: number[] = [];\n  const commissionAttemptStats: Array<{ threshold: number; eligible: number }> = [];\n  const recordCommissionAttempt = (threshold: number, eligible: number) => {\n    const existing = commissionAttemptStats.find((item) => item.threshold === threshold);\n    if (existing) existing.eligible = Math.max(existing.eligible, eligible);\n    else commissionAttemptStats.push({ threshold, eligible });\n  };\n'''
if needle not in auto:
    raise SystemExit('automation marker commissionAttempts not found')
auto = auto.replace(needle, replacement, 1)

auto = auto.replace('''      commissionAttempts.push(threshold);\n      const candidates = snapshots.filter((offer) => Math.max(0, Number(offer.commissionPercent) || 0) >= threshold);\n      addUnique(candidates);''', '''      commissionAttempts.push(threshold);\n      const candidates = snapshots.filter((offer) => Math.max(0, Number(offer.commissionPercent) || 0) >= threshold);\n      recordCommissionAttempt(threshold, candidates.length);\n      addUnique(candidates);''', 1)

auto = auto.replace('''      if (!commissionAttempts.includes(plan.desired)) commissionAttempts.push(plan.desired);\n      addUnique(primary.selected);''', '''      if (!commissionAttempts.includes(plan.desired)) commissionAttempts.push(plan.desired);\n      recordCommissionAttempt(plan.desired, primary.selected.length);\n      addUnique(primary.selected);''', 1)

auto = auto.replace('''        for (const threshold of plan.thresholds.slice(1)) {\n          if (!commissionAttempts.includes(threshold)) commissionAttempts.push(threshold);\n          const before = selected.length;\n          addUnique(ranked.filter((offer) => Math.max(0, Number(offer.commissionPercent) || 0) >= threshold));''', '''        for (const threshold of plan.thresholds.slice(1)) {\n          if (!commissionAttempts.includes(threshold)) commissionAttempts.push(threshold);\n          const thresholdCandidates = ranked.filter((offer) => Math.max(0, Number(offer.commissionPercent) || 0) >= threshold);\n          recordCommissionAttempt(threshold, thresholdCandidates.length);\n          const before = selected.length;\n          addUnique(thresholdCandidates);''', 1)

auto = auto.replace('''    commissionResolved: resolvedCommission,\n    commissionAttempts,\n  };''', '''    commissionResolved: resolvedCommission,\n    commissionAttempts,\n    commissionAttemptStats,\n  };''', 1)

# 2) Admin: usar o mesmo motor real na prévia, em vez de uma lógica paralela.
admin = admin.replace('import { createShopeeProvider } from "../lib/affiliate/shopee/adapter";\n', '', 1)
admin = admin.replace('import { searchQualifiedOffers } from "../lib/search-engine";\n', '', 1)
admin = admin.replace('import { runRuleNow, workerTick } from "./automation";', 'import { runRuleNow, searchOffersForRule, workerTick } from "./automation";', 1)
admin = admin.replace('import { commissionPlan } from "./rule-policy";\n', '', 1)

preview_pattern = re.compile(r'async function preview\(request: Request, env: Env\) \{.*?\n\}\n\nasync function telegramInfo', re.S)
new_preview = r'''async function preview(request: Request, env: Env) {
  const body=await request.json() as JsonObject;
  const settings=(body.settings&&typeof body.settings==="object"&&!Array.isArray(body.settings)?body.settings:{}) as JsonObject;
  const minCommission=nullableNumber(body.minCommission??body.min_commission,0,100)??undefined;
  const minDiscount=nullableNumber(body.minDiscount??body.min_discount,0,100)??undefined;
  const maxPrice=nullableNumber(body.maxPrice??body.max_price,0,1_000_000)??undefined;
  const quantityRaw=Number(body.quantity||1);
  const quantity=Number.isInteger(quantityRaw)?Math.min(Math.max(quantityRaw,1),20):1;
  const requestedSort=["commission","price","sales","discount"].includes(String(body.sort))?String(body.sort) as AutomationRuleRow["sort"]:null;
  const timezone=text(body.timezone,80)||"America/Sao_Paulo";
  const previewRule:AutomationRuleRow={
    id:"preview",
    name:"Prévia",
    enabled:false,
    networks:["shopee"],
    channels:["telegram"],
    keyword:"",
    category:null,
    min_commission:minCommission??null,
    min_discount:minDiscount??null,
    max_price:maxPrice??null,
    quantity,
    sort:requestedSort,
    avoid_repeat_days:0,
    schedule_cron:null,
    timezone,
    dry_run:true,
    settings:{...settings,searchScope:"all"},
  };
  const db=new SupabaseRest(env);
  const result=await searchOffersForRule(db,env,previewRule,quantity,undefined,new Date());
  const template=validTemplate(settings.contentTemplate);
  const thread=Number(settings.telegramThreadId);
  const messageThreadId=Number.isInteger(thread)&&thread>0?thread:undefined;
  const flexEnabled=Boolean(settings.flexCommissionEnabled)&&Number(result.commissionTarget)>0;
  const attempts=(result.commissionAttemptStats||[]).map((item)=>({threshold:item.threshold,eligible:item.eligible}));
  const resolved=result.commissionResolved;
  const diagnostics={
    scanned:result.scanned,
    rejectedRelevance:0,
    invalidMetrics:0,
    belowCommission:0,
    belowDiscount:0,
    aboveMaxPrice:0,
    equivalentDuplicates:0,
    excludedRecent:result.excluded,
    eligible:result.selected.length,
    zeroSalesAccepted:result.selected.filter((offer)=>Number(offer.sourceMetadata?.sales)===0).length,
    zeroRatingAccepted:result.selected.filter((offer)=>Number(offer.sourceMetadata?.rating)===0).length,
  };
  const suggestions:string[]=[];
  if(result.selected.length===0){
    if(flexEnabled){
      suggestions.push(`A busca real testou a meta de ${result.commissionTarget}% até o piso autorizado e não encontrou uma oferta que também respeitasse os demais filtros.`);
      if(minDiscount!=null) suggestions.push(`O desconto mínimo de ${minDiscount}% também pode estar restringindo a combinação.`);
      if(maxPrice!=null) suggestions.push(`O preço máximo também está ativo; aumente-o apenas se fizer sentido para a campanha.`);
    }else{
      if(minCommission!=null) suggestions.push(`A comissão está rígida em ${minCommission}%. Ative a flexibilização ou reduza a meta para ampliar a busca.`);
      if(minDiscount!=null) suggestions.push(`Revise o desconto mínimo de ${minDiscount}% se quiser ampliar a busca.`);
    }
  }
  return json({
    dryRun:true,
    selected:result.selected.length,
    scanned:result.scanned,
    pages:result.pages,
    diagnostics,
    strategy:{scope:result.sourceMode,requests:result.pages,queries:result.sourceNiche?[result.sourceNiche]:["Todos os produtos"],sourceSorts:[requestedSort||"relevance"]},
    filters:{minCommission:minCommission??null,minDiscount:minDiscount??null,maxPrice:maxPrice??null},
    suggestions,
    commissionFlex:{
      enabled:flexEnabled,
      target:result.commissionTarget,
      floor:Number(settings.flexCommissionFloor)||result.commissionTarget,
      step:Number(settings.flexCommissionStep)||5,
      resolved,
      attempts,
    },
    selectionEngine:"automation",
    sourceMode:result.sourceMode,
    sourceNiche:result.sourceNiche,
    publications:result.selected.map((offer)=>({offer,content:generateContent(offer,"telegram",{template,messageThreadId})})),
  });
}

async function telegramInfo'''
admin, count = preview_pattern.subn(new_preview, admin, count=1)
if count != 1:
    raise SystemExit(f'preview function replacement count={count}')

# 3) A prévia lê um único snapshot canônico do formulário.
old_block = '''      var targetCommission=Number(byId('minCommission')&&byId('minCommission').value),flexEnabled=Number.isFinite(targetCommission)&&targetCommission>0&&!!(byId('flexCommissionEnabled')&&byId('flexCommissionEnabled').checked),floorValue=Number(byId('flexCommissionFloor')&&byId('flexCommissionFloor').value),stepValue=Number(byId('flexCommissionStep')&&byId('flexCommissionStep').value);var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',searchScope:'all',description:(byId('description')&&byId('description').value.trim())||'',telegramThreadId:currentThread(),telegramTopicName:currentTopicName(),flexCommissionEnabled:flexEnabled,flexCommissionStep:[5,10].includes(stepValue)?stepValue:5,flexCommissionFloor:flexEnabled?(Number.isFinite(floorValue)&&floorValue>0?floorValue:Math.max(1,Math.round(targetCommission*0.6*10)/10)):null};\n      var payload={keyword:'',quantity:1,minCommission:byId('minCommission')&&byId('minCommission').value,minDiscount:byId('minDiscount')&&byId('minDiscount').value,maxPrice:byId('maxPrice')&&byId('maxPrice').value,sort:byId('sort')&&byId('sort').value,settings:settings};'''
new_block = '''      var payload=typeof window.readAutomationDraftFromForm==='function'?window.readAutomationDraftFromForm():{keyword:'',quantity:1,minCommission:byId('minCommission')&&byId('minCommission').value,minDiscount:byId('minDiscount')&&byId('minDiscount').value,maxPrice:byId('maxPrice')&&byId('maxPrice').value,sort:byId('sort')&&byId('sort').value,settings:{contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()}};'''
if old_block not in admin:
    raise SystemExit('frontend old preview payload block not found')
admin = admin.replace(old_block, new_block, 1)

# 4) Mostrar claramente no diagnóstico que o backend recebeu e executou a escada.
marker = "  function renderPreviewDiagnostics(res){"
idx = admin.find(marker)
if idx < 0:
    raise SystemExit('renderPreviewDiagnostics marker not found')
# inject flex banner after function opening's initial vars line by replacing known snippet
old_diag = "    var d=res&&res.diagnostics||{},filters=res&&res.filters||{},suggestions=res&&res.suggestions||[];"
new_diag = "    var d=res&&res.diagnostics||{},filters=res&&res.filters||{},suggestions=res&&res.suggestions||[],f=res&&res.commissionFlex;"
if old_diag not in admin:
    raise SystemExit('diagnostic vars marker not found')
admin = admin.replace(old_diag, new_diag, 1)
old_head = "    var html='<div class=\"preview-diagnostics\"><div class=\"preview-diagnostics-head\"><b>Nenhuma oferta elegível com a combinação atual</b><span>'+esc(res&&res.scanned||0)+' analisadas · '+esc(res&&res.pages||0)+' página(s)</span></div>';"
new_head = "    var html='<div class=\"preview-diagnostics\"><div class=\"preview-diagnostics-head\"><b>Nenhuma oferta elegível com a combinação atual</b><span>'+esc(res&&res.scanned||0)+' analisadas · '+esc(res&&res.pages||0)+' consulta(s)</span></div>';if(f&&f.enabled){html+='<div class=\"commission-flex-preview\"><div class=\"commission-flex-title\"><b>🧠 Comissão inteligente ATIVA</b><span>Meta '+esc(f.target)+'% · passo '+esc(f.step)+' p.p. · piso '+esc(f.floor)+'%</span></div><div class=\"commission-flex-steps\">';(f.attempts||[]).forEach(function(a){html+='<span class=\"commission-flex-step '+(f.resolved===a.threshold?'hit':'')+'\">≥ '+esc(a.threshold)+'% <b>'+esc(a.eligible)+' candidato(s)</b></span>'});html+='</div><div class=\"diag-note\">Esta prévia usa o mesmo motor de seleção da automação real.</div></div>';}"
if old_head not in admin:
    raise SystemExit('diagnostic head marker not found')
admin = admin.replace(old_head, new_head, 1)

# 5) Função única de leitura do formulário para salvar e pré-visualizar.
collect_marker = "function collectSmartSettings(body){"
insert_pos = admin.find(collect_marker)
if insert_pos < 0:
    raise SystemExit('collectSmartSettings marker not found')
read_fn = '''function readAutomationDraftFromForm(){var val=function(id){var e=document.getElementById(id);return e?e.value:''},num=function(id){var v=val(id);return v===''?null:Number(v)};var settings={contentTemplate:val('contentTemplate')||'offer',intervalMinutes:Number(val('intervalMinutes'))||60,windowStart:val('windowStart')||'09:00',windowEnd:val('windowEnd')||'22:00',telegramThreadId:currentThread(),telegramTopicName:currentThread()?currentTopicName():null,listId:(document.getElementById('sourceList')&&document.getElementById('sourceList').value)||null,listName:(document.getElementById('sourceList')&&document.getElementById('sourceList').selectedIndex>0?document.getElementById('sourceList').options[document.getElementById('sourceList').selectedIndex].text.split(' · ')[0]:null)};var body={min_commission:num('minCommission'),min_discount:num('minDiscount'),max_price:num('maxPrice'),sort:val('sort')||null,quantity:1,timezone:val('timezone')||'America/Sao_Paulo',settings:settings};collectSmartSettings(body);return{keyword:'',quantity:1,minCommission:body.min_commission,minDiscount:body.min_discount,maxPrice:body.max_price,sort:body.sort,timezone:body.timezone,settings:body.settings};}\nwindow.readAutomationDraftFromForm=readAutomationDraftFromForm;\n'''
admin = admin[:insert_pos] + read_fn + admin[insert_pos:]

# Ensure preview success also shows commission path.
old_success = "      card.innerHTML='<div class=\"live-preview-grid\">'+img+'<div class=\"live-preview-message\">'+esc(msg)+'</div></div>'+previewDiagnosticSummary(res);"
new_success = "      var flex=res&&res.commissionFlex,flexBanner='';if(flex&&flex.enabled){flexBanner='<div class=\"commission-flex-preview\" style=\"margin-top:10px\"><div class=\"commission-flex-title\"><b>🧠 Comissão inteligente ATIVA</b><span>Meta '+esc(flex.target)+'% · usada '+esc(flex.resolved==null?'—':flex.resolved+'%')+'</span></div><div class=\"commission-flex-steps\">';(flex.attempts||[]).forEach(function(a){flexBanner+='<span class=\"commission-flex-step '+(flex.resolved===a.threshold?'hit':'')+'\">≥ '+esc(a.threshold)+'% <b>'+esc(a.eligible)+'</b></span>'});flexBanner+='</div><div class=\"diag-note\">Prévia e automação real usam o mesmo motor de seleção.</div></div>';}card.innerHTML='<div class=\"live-preview-grid\">'+img+'<div class=\"live-preview-message\">'+esc(msg)+'</div></div>'+flexBanner+previewDiagnosticSummary(res);"
if old_success not in admin:
    raise SystemExit('preview success marker not found')
admin = admin.replace(old_success, new_success, 1)

auto_path.write_text(auto)
admin_path.write_text(admin)
print('patched automation.ts and admin.ts')
