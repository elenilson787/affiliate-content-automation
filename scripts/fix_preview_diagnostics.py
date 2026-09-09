from pathlib import Path

p = Path('src/admin.ts')
s = p.read_text()

old = '''function nullableNumber(value: unknown, min: number, max: number) {\n  if (value === null || value === "") return null;\n  const n = Number(value);\n  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;\n}\n'''
new = '''function nullableNumber(value: unknown, min: number, max: number) {\n  if (value === null || value === "") return null;\n  const normalized = typeof value === "string"\n    ? (value.includes(",") ? value.trim().replace(/\\./g, "").replace(",", ".") : value.trim())\n    : value;\n  const n = Number(normalized);\n  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;\n}\n'''
if old not in s:
    raise SystemExit('nullableNumber anchor not found')
s = s.replace(old, new, 1)

start = s.index('async function preview(request: Request, env: Env) {')
end = s.index('\nexport async function handleAdminApi', start)
new_preview = r'''function buildPreviewSuggestions(
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
  const keyword=rule?.keyword||text(body.keyword,120)||""; if(!keyword) return json({error:"Informe a palavra-chave."},400);
  const quantity=Math.min(Math.max(Number(rule?.quantity||body.quantity||3),1),5); const settings=(rule?.settings||body.settings||{}) as JsonObject;
  const minCommission=rule?.min_commission??nullableNumber(body.minCommission,0,100)??undefined;
  const minDiscount=rule?.min_discount??nullableNumber(body.minDiscount,0,100)??undefined;
  const maxPrice=rule?.max_price??nullableNumber(body.maxPrice,0,1_000_000)??undefined;
  const provider=createShopeeProvider({appId:required(env.SHOPEE_APP_ID,"SHOPEE_APP_ID"),secret:required(env.SHOPEE_SECRET,"SHOPEE_SECRET")});
  const result=await searchQualifiedOffers(provider,{keyword,minCommission,minDiscount,maxPrice,sort:rule?.sort||undefined},quantity,{maxPages:3,pageSize:50});
  const template=validTemplate(settings.contentTemplate); const thread=Number(settings.telegramThreadId); const messageThreadId=Number.isInteger(thread)&&thread>0?thread:undefined;
  const filters={minCommission:minCommission??null,minDiscount:minDiscount??null,maxPrice:maxPrice??null};
  return json({
    dryRun:true,
    selected:result.selected.length,
    scanned:result.scanned,
    pages:result.pages,
    diagnostics:result.diagnostics,
    filters,
    suggestions:buildPreviewSuggestions(result.diagnostics,filters),
    publications:result.selected.map(offer=>({offer,content:generateContent(offer,"telegram",{template,messageThreadId})})),
  });
}
'''
s = s[:start] + new_preview + s[end:]

css = r'''
.preview-diagnostics{display:grid;gap:10px;color:#dce5fb}.preview-diagnostics-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.preview-diagnostics-head b{font-size:13px;color:#f5f7ff}.preview-diagnostics-head span{font-size:11px;color:#8290b2}.diag-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.diag-row{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid rgba(59,82,139,.55);border-radius:9px;background:rgba(5,13,31,.55);font-size:11px}.diag-row span{color:#8f9bbc}.diag-row strong{color:#eef3ff}.diag-row.good strong{color:#28e8a0}.diag-row.warn strong{color:#ffca6a}.diag-note{font-size:10px;color:#7180a4}.diag-suggestions{border-top:1px solid rgba(59,82,139,.45);padding-top:9px}.diag-suggestions b{font-size:11px;color:#bcb7ff}.diag-suggestions ul{margin:6px 0 0 17px;padding:0;color:#9ba8c8;font-size:11px;line-height:1.55}.preview-summary{margin-top:10px;padding-top:9px;border-top:1px solid rgba(59,82,139,.4);font-size:10px;color:#8190b1}.preview-summary .new-product{color:#25dba0}@media(max-width:700px){.diag-grid{grid-template-columns:1fr}}
'''
marker = '</style></head><body>'
if marker not in s:
    raise SystemExit('style marker not found')
s = s.replace(marker, css + marker, 1)

js_start = s.index('  async function refreshInlinePreview(){')
js_end = s.index('\n  function enrichRequest', js_start)
new_js = r'''  function renderPreviewDiagnostics(res){
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
  function previewDiagnosticSummary(res){var d=res&&res.diagnostics||{};var zero=Number(d.zeroSalesAccepted||0);return '<div class="preview-summary">'+esc(res&&res.scanned||0)+' analisadas · '+esc(d.eligible||0)+' elegíveis'+(zero? ' · <span class="new-product">'+esc(zero)+' com 0 vendas aceitas</span>':'')+'</div>'}
  async function refreshInlinePreview(){
    var card=byId('livePreviewCard'),keyword=byId('keyword');if(!card||!keyword||!keyword.value.trim())return;if(card.dataset.loading==='1')return;
    card.dataset.loading='1';card.innerHTML='<div class="live-preview-placeholder">Buscando ofertas e analisando cada filtro…</div>';
    try{
      var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()};
      var payload={keyword:keyword.value.trim(),quantity:1,minCommission:byId('minCommission')&&byId('minCommission').value,minDiscount:byId('minDiscount')&&byId('minDiscount').value,maxPrice:byId('maxPrice')&&byId('maxPrice').value,settings:settings};
      var res=await api('/api/admin/preview',{method:'POST',body:JSON.stringify(payload)}),pub=res.publications&&res.publications[0];
      if(!pub){card.innerHTML=renderPreviewDiagnostics(res);return}
      var img=pub.offer&&pub.offer.imageUrl?'<img src="'+esc(pub.offer.imageUrl)+'" alt="Produto">':'<div style="width:120px;height:120px;border:1px solid #29416e;border-radius:12px"></div>';
      var msg=[pub.content.title,pub.content.body,pub.content.cta].filter(Boolean).join('\n\n');
      card.innerHTML='<div class="live-preview-grid">'+img+'<div><div class="live-preview-meta"><span class="pill purple">'+esc((byId('contentTemplate')&&byId('contentTemplate').options[byId('contentTemplate').selectedIndex].text)||'Template')+'</span><span class="pill">'+esc(currentTopicName())+'</span></div><div class="live-preview-message">'+esc(msg)+'</div>'+previewDiagnosticSummary(res)+'</div></div>';
    }catch(e){card.innerHTML='<div class="live-preview-placeholder">Não foi possível gerar a prévia: '+esc(e.message)+'</div>'}finally{card.dataset.loading='0'}
  }'''
s = s[:js_start] + new_js + s[js_end:]

p.write_text(s)
