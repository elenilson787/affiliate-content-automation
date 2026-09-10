from pathlib import Path
import re

path = Path('src/admin.ts')
s = path.read_text(encoding='utf-8')

# 1) Reutiliza a mesma política de comissão inteligente do executor real.
anchor = 'import { handleCatalogAdminApi } from "./catalog";'
replacement = anchor + '\nimport { commissionPlan } from "./rule-policy";'
if 'import { commissionPlan } from "./rule-policy";' not in s:
    if anchor not in s:
        raise SystemExit('import anchor not found')
    s = s.replace(anchor, replacement, 1)

# 2) Faz a prévia simular a escada de comissão em uma única varredura ampla no piso autorizado.
new_preview = r'''async function preview(request: Request, env: Env) {
  const body=await request.json().catch(()=>({})) as JsonObject; const db=new SupabaseRest(env); let rule:AutomationRuleRow|undefined;
  if(typeof body.ruleId==="string") { const rows=await db.select<AutomationRuleRow>("automation_rules",new URLSearchParams({select:"*",id:eq(body.ruleId),limit:"1"})); rule=rows[0]; }
  const settings=(rule?.settings||body.settings||{}) as JsonObject;
  const searchScope="all" as const;
  const keyword="";
  const quantity=Math.min(Math.max(Number(rule?.quantity||body.quantity||3),1),5);
  const minCommission=rule?.min_commission??nullableNumber(body.minCommission,0,100)??undefined;
  const minDiscount=rule?.min_discount??nullableNumber(body.minDiscount,0,100)??undefined;
  const maxPrice=rule?.max_price??nullableNumber(body.maxPrice,0,1_000_000)??undefined;
  const provider=createShopeeProvider({appId:required(env.SHOPEE_APP_ID,"SHOPEE_APP_ID"),secret:required(env.SHOPEE_SECRET,"SHOPEE_SECRET")});
  const requestedSort = rule?.sort || (["commission","price","sales","discount"].includes(String(body.sort)) ? String(body.sort) as "commission"|"price"|"sales"|"discount" : undefined);
  const plan=commissionPlan(minCommission,settings);
  const effectiveMinCommission=plan.enabled?plan.floor:minCommission;
  const candidateQuantity=plan.enabled?60:quantity;
  const result=await searchQualifiedOffers(
    provider,
    {keyword,minCommission:effectiveMinCommission,minDiscount,maxPrice,sort:plan.enabled?"commission":requestedSort},
    candidateQuantity,
    {maxPages:plan.enabled?3:2,pageSize:50,maxRequests:plan.enabled?12:10,searchScope},
  );

  const commission=(offer:(typeof result.selected)[number])=>Math.max(0,Number(offer.commissionPercent)||0);
  const discount=(offer:(typeof result.selected)[number])=>Math.max(0,Number(offer.discountPercent)||0);
  const sales=(offer:(typeof result.selected)[number])=>Math.max(0,Number(offer.sourceMetadata?.sales)||0);
  const sortSelected=(offers:typeof result.selected)=>{
    const copy=[...offers];
    if(requestedSort==="discount") copy.sort((a,b)=>discount(b)-discount(a)||commission(b)-commission(a));
    else if(requestedSort==="price") copy.sort((a,b)=>(a.price??Number.POSITIVE_INFINITY)-(b.price??Number.POSITIVE_INFINITY));
    else if(requestedSort==="sales") copy.sort((a,b)=>sales(b)-sales(a)||commission(b)-commission(a));
    else copy.sort((a,b)=>commission(b)-commission(a)||discount(b)-discount(a)||sales(b)-sales(a));
    return copy;
  };

  let selected=result.selected.slice(0,quantity);
  let resolvedCommission:number|null=plan.desired||null;
  const commissionAttempts=plan.enabled
    ? plan.thresholds.map((threshold)=>({threshold,eligible:result.selected.filter((offer)=>commission(offer)>=threshold).length}))
    : [];

  if(plan.enabled){
    const resolved=commissionAttempts.find((attempt)=>attempt.eligible>0);
    resolvedCommission=resolved?.threshold??null;
    selected=resolvedCommission==null
      ? []
      : sortSelected(result.selected.filter((offer)=>commission(offer)>=resolvedCommission!)).slice(0,quantity);
  }

  const template=validTemplate(settings.contentTemplate); const thread=Number(settings.telegramThreadId); const messageThreadId=Number.isInteger(thread)&&thread>0?thread:undefined;
  const filters={minCommission:minCommission??null,minDiscount:minDiscount??null,maxPrice:maxPrice??null,effectiveMinCommission:effectiveMinCommission??null};
  let suggestions=buildPreviewSuggestions(result.diagnostics,{minCommission:effectiveMinCommission??null,minDiscount:minDiscount??null,maxPrice:maxPrice??null});
  if(plan.enabled&&selected.length===0){
    suggestions=[
      `A flexibilização já testou a comissão de ${plan.desired}% até o piso autorizado de ${plan.floor}% e não encontrou oferta elegível.`,
      `Se desejar ampliar mais, reduza o piso de comissão abaixo de ${plan.floor}% ou ajuste os outros filtros.`,
      ...suggestions.filter((item)=>!item.startsWith("Reduza a comissão mínima")),
    ].slice(0,3);
  }
  return json({
    dryRun:true,
    selected:selected.length,
    scanned:result.scanned,
    pages:result.pages,
    diagnostics:result.diagnostics,
    strategy:result.strategy,
    searchScope,
    filters,
    commissionFlex:{
      enabled:plan.enabled,
      target:plan.desired,
      floor:plan.floor,
      step:plan.step,
      resolved:resolvedCommission,
      attempts:commissionAttempts,
    },
    suggestions,
    publications:selected.map(offer=>({offer,content:generateContent(offer,"telegram",{template,messageThreadId})})),
  });
}'''
pattern = re.compile(r'async function preview\(request: Request, env: Env\) \{.*?\n\}\n\nexport async function handleAdminApi', re.S)
s, n = pattern.subn(new_preview + '\n\nexport async function handleAdminApi', s, count=1)
if n != 1:
    raise SystemExit(f'preview function replacement count={n}')

# 3) Permite mover um elemento que esteja aninhado no mesmo bloco; isso coloca o resumo DEPOIS de intervalo/janela.
old_move = "function moveSmartNode(target,node){if(target&&node&&!target.contains(node))target.appendChild(node)}"
new_move = "function moveSmartNode(target,node){if(target&&node&&node.parentElement!==target)target.appendChild(node)}"
if old_move in s:
    s = s.replace(old_move, new_move, 1)
elif new_move not in s:
    raise SystemExit('moveSmartNode anchor not found')

# 4) A prévia não salva a automação, então envia explicitamente as opções de flexibilização presentes no formulário.
old_settings = "var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',searchScope:'all',description:(byId('description')&&byId('description').value.trim())||'',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()};"
new_settings = "var targetCommission=Number(byId('minCommission')&&byId('minCommission').value),flexEnabled=Number.isFinite(targetCommission)&&targetCommission>0&&!!(byId('flexCommissionEnabled')&&byId('flexCommissionEnabled').checked),floorValue=Number(byId('flexCommissionFloor')&&byId('flexCommissionFloor').value),stepValue=Number(byId('flexCommissionStep')&&byId('flexCommissionStep').value);var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',searchScope:'all',description:(byId('description')&&byId('description').value.trim())||'',telegramThreadId:currentThread(),telegramTopicName:currentTopicName(),flexCommissionEnabled:flexEnabled,flexCommissionStep:[5,10].includes(stepValue)?stepValue:5,flexCommissionFloor:flexEnabled?(Number.isFinite(floorValue)&&floorValue>0?floorValue:Math.max(1,Math.round(targetCommission*0.6*10)/10)):null};"
if old_settings not in s:
    raise SystemExit('inline preview settings anchor not found')
s = s.replace(old_settings, new_settings, 1)

# 5) Mostra a escada 50 → 45 → ... tanto quando encontra quanto quando chega ao piso sem encontrar.
new_render = r'''  function renderPreviewDiagnostics(res){
    var d=res&&res.diagnostics||{},suggestions=res&&res.suggestions||[],scanned=Number(res&&res.scanned||d.scanned||0),flex=res&&res.commissionFlex;
    var commissionLabel=flex&&flex.enabled?'Abaixo do piso de comissão ('+flex.floor+'%)':'Abaixo da comissão mínima';
    var rows=[
      ['Não relacionados / acessórios',d.rejectedRelevance||0,''],
      [commissionLabel,d.belowCommission||0,'warn'],
      ['Abaixo do desconto mínimo',d.belowDiscount||0,'warn'],
      ['Acima do preço máximo',d.aboveMaxPrice||0,'warn'],
      ['Anúncios equivalentes',d.equivalentDuplicates||0,''],
      ['Métricas inválidas',d.invalidMetrics||0,''],
      ['Elegíveis',d.eligible||0,'good']
    ];
    var flexHtml='';
    if(flex&&flex.enabled){
      var attempts=flex.attempts||[];
      flexHtml='<div class="commission-flex-preview"><div class="commission-flex-title"><b>Flexibilização automática da comissão</b><span>Meta '+esc(flex.target)+'% · piso '+esc(flex.floor)+'%</span></div><div class="commission-flex-steps">'+attempts.map(function(a){return'<span class="commission-flex-step '+(a.eligible>0?'hit':'')+'">≥ '+esc(a.threshold)+'% <b>'+esc(a.eligible)+'</b></span>'}).join('')+'</div><div class="diag-note">'+(flex.resolved!=null?'A primeira faixa com oferta elegível foi ≥ '+esc(flex.resolved)+'%.':'A busca chegou ao piso autorizado sem encontrar uma oferta que também cumpra os demais filtros.')+'</div></div>';
    }
    var html='<div class="preview-diagnostics"><div class="preview-diagnostics-head"><b>Nenhuma oferta elegível com a combinação atual</b><span>'+esc(scanned)+' analisadas · '+esc(res&&res.pages||0)+' página(s)</span></div>'+flexHtml+'<div class="diag-grid">';
    rows.forEach(function(r){html+='<div class="diag-row '+r[2]+'"><span>'+esc(r[0])+'</span><strong>'+esc(r[1])+'</strong></div>'});
    html+='</div><div class="diag-note">Os motivos são independentes: o mesmo anúncio pode deixar de atender a mais de um filtro.</div>';
    if(suggestions.length){html+='<div class="diag-suggestions"><b>Sugestões para ampliar a busca</b><ul>';suggestions.forEach(function(x){html+='<li>'+esc(x)+'</li>'});html+='</ul></div>'}
    html+='</div>';return html;
  }
  function previewDiagnosticSummary(res){var d=res&&res.diagnostics||{},zero=Number(d.zeroSalesAccepted||0),f=res&&res.commissionFlex,flexText='';if(f&&f.enabled){var path=(f.attempts||[]).map(function(a){return a.threshold+'%'}).join(' → ');flexText=f.resolved!=null?(f.resolved<f.target?' · comissão flexibilizada '+esc(f.target)+'% → '+esc(f.resolved)+'%':' · meta de comissão '+esc(f.target)+'% atendida'):' · flexibilização '+esc(path)+' sem resultado'}return '<div class="preview-summary">'+esc(res&&res.scanned||0)+' anúncios únicos · '+esc(d.eligible||0)+' elegíveis · '+esc(res&&res.strategy&&res.strategy.requests||res&&res.pages||0)+' consultas'+flexText+(zero? ' · <span class="new-product">'+esc(zero)+' com 0 vendas aceitas</span>':'')+'</div>'}'''
render_pattern = re.compile(r'  function renderPreviewDiagnostics\(res\)\{.*?\n  function previewDiagnosticSummary\(res\)\{.*?\}\n  async function refreshInlinePreview\(\)', re.S)
s, n = render_pattern.subn(new_render + '\n  async function refreshInlinePreview()', s, count=1)
if n != 1:
    raise SystemExit(f'preview renderer replacement count={n}')

# 6) Estilo da escada de comissão.
style_anchor = ".preview-summary .new-product{color:#25dba0}"
style_extra = style_anchor + ".commission-flex-preview{border:1px solid rgba(116,82,255,.48);background:linear-gradient(135deg,rgba(89,52,210,.14),rgba(14,45,91,.18));border-radius:10px;padding:10px}.commission-flex-title{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px}.commission-flex-title span{font-size:10px;color:#9aa8c8}.commission-flex-steps{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:7px}.commission-flex-step{border:1px solid #30456f;background:#09152e;color:#9faed0;padding:5px 7px;border-radius:999px;font-size:10px}.commission-flex-step b{color:#dbe5ff;margin-left:3px}.commission-flex-step.hit{border-color:#21c990;color:#53edba;background:rgba(24,155,112,.12)}"
if style_extra not in s:
    if style_anchor not in s:
        raise SystemExit('preview style anchor not found')
    s = s.replace(style_anchor, style_extra, 1)

path.write_text(s, encoding='utf-8')
print('patched src/admin.ts')
