from pathlib import Path


def one(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"anchor not found: {label}")
    return text.replace(old, new, 1)

# Admin/backend + UI
p = Path('src/admin.ts')
s = p.read_text()

old = '''function rulePatch(input: AdminRuleInput, creating = false, currentSettings: JsonObject = {}) {\n  const patch: JsonObject = {};\n  const incomingSettings = input.settings && typeof input.settings === "object" && !Array.isArray(input.settings)\n    ? input.settings as JsonObject\n    : {};\n  const searchScope = (incomingSettings.searchScope ?? currentSettings.searchScope) === "all" ? "all" : "keyword";\n  if (input.name !== undefined) { const v = text(input.name, 120); if (!v) throw new Error("Nome obrigatório."); patch.name = v; } else if (creating) throw new Error("Nome obrigatório.");\n  if (input.keyword !== undefined) {\n    const v = text(input.keyword, 120) || "";\n    if (!v && searchScope !== "all") throw new Error("Informe a palavra-chave ou selecione Todos os produtos.");\n    patch.keyword = v;\n  } else if (creating) {\n    if (searchScope === "all") patch.keyword = "";\n    else throw new Error("Palavra-chave obrigatória.");\n  }'''
new = '''function rulePatch(input: AdminRuleInput, creating = false, currentSettings: JsonObject = {}) {\n  const patch: JsonObject = {};\n  if (input.name !== undefined) { const v = text(input.name, 120); if (!v) throw new Error("Nome obrigatório."); patch.name = v; } else if (creating) throw new Error("Nome obrigatório.");\n  // A busca comercial é ampla e baseada nos filtros/estratégias.\n  // Mantemos a coluna keyword vazia apenas por compatibilidade com o schema atual.\n  patch.keyword = "";'''
s = one(s, old, new, 'rulePatch keyword removal')

s = one(s,
'''    patch.settings = { ...currentSettings, ...(input.settings as JsonObject) };''',
'''    patch.settings = { ...currentSettings, ...(input.settings as JsonObject), searchScope: "all" };''',
'force all scope settings')

s = one(s,
'''    patch.settings={ purpose:"admin_ui", priority:100, maxAttempts:3, contentTemplate:"offer", intervalMinutes:60, windowStart:"09:00", windowEnd:"22:00", ...(patch.settings as JsonObject || {}) };''',
'''    patch.settings={ purpose:"admin_ui", priority:100, maxAttempts:3, contentTemplate:"offer", intervalMinutes:60, windowStart:"09:00", windowEnd:"22:00", ...(patch.settings as JsonObject || {}), searchScope:"all" };''',
'create all scope')

s = one(s,
'''  if (!diagnostics.scanned) return ["A Shopee não retornou itens para essa palavra-chave. Tente um termo mais comum ou mais curto."];''',
'''  if (!diagnostics.scanned) return ["A Shopee não retornou ofertas nas estratégias consultadas. Tente novamente em alguns instantes ou revise os filtros."];''',
'preview no-results suggestion')

s = one(s,
'''    { count: diagnostics.rejectedRelevance || 0, text: "Muitos itens não correspondem exatamente à palavra-chave. Tente um termo um pouco mais amplo." },''',
'''    { count: diagnostics.rejectedRelevance || 0, text: "Alguns anúncios foram descartados por relevância ou qualidade do produto." },''',
'preview relevance suggestion')

old = '''  const settings=(rule?.settings||body.settings||{}) as JsonObject;\n  const searchScope=settings.searchScope==="all"?"all":"keyword";\n  const keyword=rule?.keyword??text(body.keyword,120)??"";\n  if(searchScope!=="all"&&!keyword) return json({error:"Informe a palavra-chave ou selecione Todos os produtos."},400);\n  const quantity=Math.min(Math.max(Number(rule?.quantity||body.quantity||3),1),5);'''
new = '''  const settings=(rule?.settings||body.settings||{}) as JsonObject;\n  const searchScope="all" as const;\n  const keyword="";\n  const quantity=Math.min(Math.max(Number(rule?.quantity||body.quantity||3),1),5);'''
s = one(s, old, new, 'preview force all scope')

s = one(s,
'''  const result=await searchQualifiedOffers(provider,{keyword,minCommission,minDiscount,maxPrice,sort:requestedSort},quantity,{maxPages:2,pageSize:50,maxRequests:searchScope==="all"?10:8,searchScope});''',
'''  const result=await searchQualifiedOffers(provider,{keyword,minCommission,minDiscount,maxPrice,sort:requestedSort},quantity,{maxPages:2,pageSize:50,maxRequests:10,searchScope});''',
'preview max requests')

old_html = '''<div class="field full"><label>Escopo da busca</label><select id="searchScope" onchange="var f=document.getElementById('keywordField');if(f)f.style.display=this.value==='all'?'none':''"><option value="all">Todos os produtos / nichos</option><option value="keyword">Palavra-chave / nicho específico</option></select><div class="muted" style="font-size:10px;margin-top:5px">“Todos os produtos” procura ofertas em vários nichos e ordenações, semelhante ao AFILIAPULSE.</div></div><div class="field full" id="keywordField"><label>Palavra-chave / nicho</label><input id="keyword" placeholder="Ex.: escova secadora, smartwatch, roupa pet"></div>'''
new_html = '''<div class="field full"><label>Descrição</label><input id="description" maxlength="180" placeholder="Ex.: Ofertas gerais com alto desconto para o Telegram"><div class="muted" style="font-size:10px;margin-top:5px">A descrição serve apenas para identificar a automação. Ela não limita a busca de produtos.</div></div>'''
s = one(s, old_html, new_html, 'replace keyword UI with description')

s = one(s,
'''<option value="">Relevância</option>''',
'''<option value="">Recomendados</option>''',
'rename relevance')

s = one(s,
'''<div class="rule-meta">'+esc(r.settings&&r.settings.searchScope==='all'?'Todos os produtos':r.keyword)+' · '+(r.enabled?'Ativa':'Pausada')+''',
'''<div class="rule-meta">'+esc(r.settings&&r.settings.description?r.settings.description:'Busca inteligente · todos os produtos')+' · '+(r.enabled?'Ativa':'Pausada')+''',
'rule card description')

old_open = '''['name','keyword'].forEach(function(k){document.getElementById(k).value=r?r[k]:''});var scope=r?(r.settings&&r.settings.searchScope==='all'?'all':'keyword'):'all';document.getElementById('searchScope').value=scope;document.getElementById('keywordField').style.display=scope==='all'?'none':'';document.getElementById('quantity').value'''
new_open = '''document.getElementById('name').value=r?r.name:'';document.getElementById('description').value=r&&r.settings&&r.settings.description?r.settings.description:'';document.getElementById('quantity').value'''
s = one(s, old_open, new_open, 'open modal description')

s = one(s,
'''settings.contentTemplate=document.getElementById('contentTemplate').value;settings.searchScope=document.getElementById('searchScope').value||'all';var th=''',
'''settings.contentTemplate=document.getElementById('contentTemplate').value;settings.searchScope='all';settings.description=document.getElementById('description').value.trim();var th=''',
'form settings description')

s = one(s,
'''return{name:document.getElementById('name').value,keyword:document.getElementById('keyword').value,quantity:''',
'''return{name:document.getElementById('name').value,keyword:'',quantity:''',
'form keyword empty')

s = one(s,
'''<div id="livePreviewCard" class="live-preview-card"><div class="live-preview-placeholder">Informe uma palavra-chave e clique em “Atualizar prévia”. A foto e a mensagem aparecerão aqui antes de salvar a automação.</div></div>''',
'''<div id="livePreviewCard" class="live-preview-card"><div class="live-preview-placeholder">Clique em “Atualizar prévia”. A busca considera todos os produtos e aplica comissão, desconto, preço e ordenação definidos acima.</div></div>''',
'preview placeholder')

s = one(s,
'''setTimeout(function(){if(byId('keyword')&&byId('keyword').value.trim())refreshInlinePreview()},120)''',
'''setTimeout(function(){},120)''',
'hydrate keyword preview')

s = one(s,
'''var card=byId('livePreviewCard'),keyword=byId('keyword');if(!card||!keyword||!keyword.value.trim())return;if(card.dataset.loading==='1')return;''',
'''var card=byId('livePreviewCard');if(!card)return;if(card.dataset.loading==='1')return;''',
'preview keyword gate')

s = one(s,
'''var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',searchScope:(byId('searchScope')&&byId('searchScope').value)||'all',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()};''',
'''var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',searchScope:'all',description:(byId('description')&&byId('description').value.trim())||'',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()};''',
'inline preview settings')

s = one(s,
'''var payload={keyword:keyword.value.trim(),quantity:1,minCommission:byId('minCommission')&&byId('minCommission').value,minDiscount:byId('minDiscount')&&byId('minDiscount').value,maxPrice:byId('maxPrice')&&byId('maxPrice').value,settings:settings};''',
'''var payload={keyword:'',quantity:1,minCommission:byId('minCommission')&&byId('minCommission').value,minDiscount:byId('minDiscount')&&byId('minDiscount').value,maxPrice:byId('maxPrice')&&byId('maxPrice').value,sort:byId('sort')&&byId('sort').value,settings:settings};''',
'inline preview payload')

s = one(s,
'''  if(byId('keyword'))byId('keyword').addEventListener('blur',function(){refreshInlinePreview()});\n''',
'''\n''',
'remove keyword blur')

p.write_text(s)

# Scheduler/manual executions must also ignore legacy keywords and always search broadly.
p = Path('src/automation.ts')
s = p.read_text()
s = one(s,
'''        keyword: rule.keyword,''',
'''        keyword: "",''',
'automation keyword disabled')
s = one(s,
'''        maxRequests: rule.settings.searchScope === "all" ? 10 : 8,\n        searchScope: rule.settings.searchScope === "all" ? "all" : "keyword",''',
'''        maxRequests: 10,\n        searchScope: "all",''',
'automation force all scope')
p.write_text(s)
