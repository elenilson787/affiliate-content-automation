from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"anchor not found: {label}")
    return text.replace(old, new, 1)

# offer-engine.ts
p = Path('lib/offer-engine.ts')
s = p.read_text()
s = replace_once(s,
'''export function offerLooksLikeAccessory(offer: Offer, keyword: string) {\n  if (keywordRequestsAccessory(keyword)) return false;''',
'''export function offerLooksLikeAccessory(offer: Offer, keyword: string) {\n  // Em "Todos os produtos" não aplicamos a lista de acessórios, porque itens\n  // como bolsa, capa e organizador podem ser o próprio produto desejado.\n  if (!normalized(keyword)) return false;\n  if (keywordRequestsAccessory(keyword)) return false;''',
'accessory all-scope')

old_rel = '''export function offerIsRelevant(offer: Offer, keyword: string) {\n  const haystack = normalized(`${offer.title} ${offer.category || ""}`);\n  const terms = normalized(keyword).split(/\\s+/).filter((term) => term.length >= 3);\n\n  if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) return false;\n  if (offerLooksLikeAccessory(offer, keyword)) return false;\n  return true;\n}\n'''
new_rel = '''const SEARCH_STOP_WORDS = new Set([\n  "a", "as", "o", "os", "de", "da", "das", "do", "dos", "e", "em", "com", "para", "por", "um", "uma",\n  "no", "na", "nos", "nas", "ao", "aos", "se", "que", "pra",\n]);\n\nexport function offerIsRelevant(offer: Offer, keyword: string) {\n  const normalizedKeyword = normalized(keyword);\n  if (!normalizedKeyword) return true;\n  if (offerLooksLikeAccessory(offer, keyword)) return false;\n\n  const haystack = normalized(`${offer.title} ${offer.category || ""}`);\n  if (haystack.includes(normalizedKeyword)) return true;\n\n  const terms = normalizedKeyword\n    .split(/\\s+/)\n    .filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term));\n  if (!terms.length) return true;\n\n  const matches = terms.filter((term) => haystack.includes(term)).length;\n  const required = terms.length <= 2 ? terms.length : Math.max(2, Math.ceil(terms.length * 0.6));\n  return matches >= required;\n}\n'''
s = replace_once(s, old_rel, new_rel, 'relevance')
s = replace_once(s,
'''  minDiscount?: number;\n  limit?: number;''',
'''  minDiscount?: number;\n  sort?: "commission" | "price" | "sales" | "discount";\n  limit?: number;''',
'selection sort type')

sort_helper = '''function compareOffers(a: Offer, b: Offer, sort: OfferSelectionInput["sort"]) {\n  const commissionA = Math.max(0, a.commissionPercent ?? 0);\n  const commissionB = Math.max(0, b.commissionPercent ?? 0);\n  const discountA = Math.max(0, a.discountPercent ?? discountPercent(a));\n  const discountB = Math.max(0, b.discountPercent ?? discountPercent(b));\n  const salesA = Math.max(0, offerSales(a) ?? 0);\n  const salesB = Math.max(0, offerSales(b) ?? 0);\n  const priceA = a.price ?? Number.POSITIVE_INFINITY;\n  const priceB = b.price ?? Number.POSITIVE_INFINITY;\n\n  if (sort === "commission") return commissionB - commissionA || discountB - discountA || salesB - salesA || rankOffer(b) - rankOffer(a);\n  if (sort === "discount") return discountB - discountA || commissionB - commissionA || salesB - salesA || rankOffer(b) - rankOffer(a);\n  if (sort === "sales") return salesB - salesA || commissionB - commissionA || discountB - discountA || rankOffer(b) - rankOffer(a);\n  if (sort === "price") return priceA - priceB || salesB - salesA || commissionB - commissionA || discountB - discountA;\n  return rankOffer(b) - rankOffer(a);\n}\n\n'''
s = replace_once(s, 'export function analyzeOffers(pool: Offer[], input: OfferSelectionInput) {', sort_helper + 'export function analyzeOffers(pool: Offer[], input: OfferSelectionInput) {', 'sort helper')
s = replace_once(s, '  candidates.sort((a, b) => rankOffer(b) - rankOffer(a));', '  candidates.sort((a, b) => compareOffers(a, b, input.sort));', 'candidate sort')
p.write_text(s)

# Shopee discovery sorting. The Shopee API does not expose a reliable discount sort;
# AFILIAPULSE discovers discount candidates through sales/catalog order and sorts locally.
p = Path('lib/affiliate/shopee/adapter.ts')
s = p.read_text()
s = replace_once(s,
'''        : request.sort === "sales"\n            ? 2\n            : 1;''',
'''        : request.sort === "sales" || request.sort === "discount"\n            ? 2\n            : 1;''',
'adapter discount discovery')
p.write_text(s)

# automation.ts: persist the same smart scope in scheduled/manual runs.
p = Path('src/automation.ts')
s = p.read_text()
s = replace_once(s,
'''      { maxPages: 3, pageSize: 50, excludeOffer },''',
'''      {\n        maxPages: 2,\n        pageSize: 50,\n        maxRequests: rule.settings.searchScope === "all" ? 10 : 8,\n        searchScope: rule.settings.searchScope === "all" ? "all" : "keyword",\n        excludeOffer,\n      },''',
'automation smart search')
p.write_text(s)

# admin.ts backend + form.
p = Path('src/admin.ts')
s = p.read_text()
s = replace_once(s,
'''function rulePatch(input: AdminRuleInput, creating = false, currentSettings: JsonObject = {}) {\n  const patch: JsonObject = {};\n  if (input.name !== undefined) { const v = text(input.name, 120); if (!v) throw new Error("Nome obrigatório."); patch.name = v; } else if (creating) throw new Error("Nome obrigatório.");\n  if (input.keyword !== undefined) { const v = text(input.keyword, 120); if (!v) throw new Error("Palavra-chave obrigatória."); patch.keyword = v; } else if (creating) throw new Error("Palavra-chave obrigatória.");''',
'''function rulePatch(input: AdminRuleInput, creating = false, currentSettings: JsonObject = {}) {\n  const patch: JsonObject = {};\n  const incomingSettings = input.settings && typeof input.settings === "object" && !Array.isArray(input.settings)\n    ? input.settings as JsonObject\n    : {};\n  const searchScope = (incomingSettings.searchScope ?? currentSettings.searchScope) === "all" ? "all" : "keyword";\n  if (input.name !== undefined) { const v = text(input.name, 120); if (!v) throw new Error("Nome obrigatório."); patch.name = v; } else if (creating) throw new Error("Nome obrigatório.");\n  if (input.keyword !== undefined) {\n    const v = text(input.keyword, 120) || "";\n    if (!v && searchScope !== "all") throw new Error("Informe a palavra-chave ou selecione Todos os produtos.");\n    patch.keyword = v;\n  } else if (creating) {\n    if (searchScope === "all") patch.keyword = "";\n    else throw new Error("Palavra-chave obrigatória.");\n  }''',
'admin keyword scope')

old_preview = '''  const keyword=rule?.keyword||text(body.keyword,120)||""; if(!keyword) return json({error:"Informe a palavra-chave."},400);\n  const quantity=Math.min(Math.max(Number(rule?.quantity||body.quantity||3),1),5); const settings=(rule?.settings||body.settings||{}) as JsonObject;'''
new_preview = '''  const settings=(rule?.settings||body.settings||{}) as JsonObject;\n  const searchScope=settings.searchScope==="all"?"all":"keyword";\n  const keyword=rule?.keyword??text(body.keyword,120)??"";\n  if(searchScope!=="all"&&!keyword) return json({error:"Informe a palavra-chave ou selecione Todos os produtos."},400);\n  const quantity=Math.min(Math.max(Number(rule?.quantity||body.quantity||3),1),5);'''
s = replace_once(s, old_preview, new_preview, 'preview scope')
s = replace_once(s,
'''  const result=await searchQualifiedOffers(provider,{keyword,minCommission,minDiscount,maxPrice,sort:rule?.sort||undefined},quantity,{maxPages:3,pageSize:50});''',
'''  const result=await searchQualifiedOffers(provider,{keyword,minCommission,minDiscount,maxPrice,sort:rule?.sort||body.sort as any||undefined},quantity,{maxPages:2,pageSize:50,maxRequests:searchScope==="all"?10:8,searchScope});''',
'preview smart search')
s = replace_once(s,
'''    diagnostics:result.diagnostics,\n    filters,''',
'''    diagnostics:result.diagnostics,\n    strategy:result.strategy,\n    searchScope,\n    filters,''',
'preview strategy response')

old_field = '''<div class=\\"field full\\"><label>Palavra-chave</label><input id=\\"keyword\\" required></div>'''
new_field = '''<div class=\\"field full\\"><label>Escopo da busca</label><select id=\\"searchScope\\" onchange=\\"var f=document.getElementById('keywordField');if(f)f.style.display=this.value==='all'?'none':''\\"><option value=\\"all\\">Todos os produtos / nichos</option><option value=\\"keyword\\">Palavra-chave / nicho específico</option></select><div class=\\"muted\\" style=\\"font-size:10px;margin-top:5px\\">“Todos os produtos” usa busca ampla por catálogo, comissão e popularidade, semelhante ao AFILIAPULSE.</div></div><div class=\\"field full\\" id=\\"keywordField\\"><label>Palavra-chave / nicho</label><input id=\\"keyword\\" placeholder=\\"Ex.: escova secadora, smartwatch, roupa pet\\"></div>'''
s = replace_once(s, old_field, new_field, 'search scope field')

# Card label
s = replace_once(s,
'''<div class=\\"rule-meta\\">'+esc(r.keyword)+' · '+(r.enabled?'Ativa':'Pausada')+''',
'''<div class=\\"rule-meta\\">'+esc(r.settings&&r.settings.searchScope==='all'?'Todos os produtos':r.keyword)+' · '+(r.enabled?'Ativa':'Pausada')+''',
'rule card scope')

# New/existing modal defaults.
s = replace_once(s,
'''['name','keyword'].forEach(function(k){document.getElementById(k).value=r?r[k]:''});document.getElementById('quantity').value''',
'''['name','keyword'].forEach(function(k){document.getElementById(k).value=r?r[k]:''});var scope=r?(r.settings&&r.settings.searchScope==='all'?'all':'keyword'):'all';document.getElementById('searchScope').value=scope;document.getElementById('keywordField').style.display=scope==='all'?'none':'';document.getElementById('quantity').value''',
'open modal scope')

# Save scope in settings.
s = replace_once(s,
'''settings.contentTemplate=document.getElementById('contentTemplate').value;var th=''',
'''settings.contentTemplate=document.getElementById('contentTemplate').value;settings.searchScope=document.getElementById('searchScope').value||'all';var th=''',
'form payload scope')

# Inline preview includes the scope.
s = replace_once(s,
'''var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()};''',
'''var settings={contentTemplate:(byId('contentTemplate')&&byId('contentTemplate').value)||'offer',searchScope:(byId('searchScope')&&byId('searchScope').value)||'all',telegramThreadId:currentThread(),telegramTopicName:currentTopicName()};''',
'inline preview scope')

# Show smarter discovery summary in diagnostics and successful preview.
s = s.replace("esc(scanned)+' analisadas · '+esc(res&&res.pages||0)+' página(s)'", "esc(scanned)+' anúncios únicos · '+esc(res&&res.strategy&&res.strategy.requests||res&&res.pages||0)+' consultas inteligentes'", 1)
s = s.replace("esc(res&&res.scanned||0)+' analisadas · '+esc(d.eligible||0)+' elegíveis'", "esc(res&&res.scanned||0)+' anúncios únicos · '+esc(d.eligible||0)+' elegíveis · '+esc(res&&res.strategy&&res.strategy.requests||res&&res.pages||0)+' consultas'", 1)

p.write_text(s)
