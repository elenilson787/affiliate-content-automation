from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'pattern not found: {label}')
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str, flags=0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'regex pattern not found exactly once: {label} ({count})')
    return updated

# -----------------------------------------------------------------------------
# 1) Motor de busca: permitir começar de páginas posteriores e ampliar orçamento.
# -----------------------------------------------------------------------------
search_path = Path('lib/search-engine.ts')
search = search_path.read_text()
search = replace_once(
    search,
    '  maxRequests?: number;\n  searchScope?: SearchScope;',
    '  maxRequests?: number;\n  pageStart?: number;\n  searchScope?: SearchScope;',
    'search options pageStart',
)
search = replace_once(
    search,
    '  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 2), 1), 5);\n  const scope: SearchScope = options.searchScope === "all" ? "all" : "keyword";\n  const maxRequests = Math.min(Math.max(Math.trunc(options.maxRequests ?? (scope === "all" ? 10 : 8)), 1), 20);',
    '  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 2), 1), 20);\n  const pageStart = Math.min(Math.max(Math.trunc(options.pageStart ?? 1), 1), 500);\n  const scope: SearchScope = options.searchScope === "all" ? "all" : "keyword";\n  const maxRequests = Math.min(Math.max(Math.trunc(options.maxRequests ?? (scope === "all" ? 10 : 8)), 1), 60);',
    'search page limits',
)
search = replace_once(search, '      await runRequest(query, sort, 1);', '      await runRequest(query, sort, pageStart);', 'search initial page')
search = replace_once(
    search,
    '    const primaryQuery = queries[0] || "";\n    for (let page = 2; page <= maxPages && requests < maxRequests; page += 1) {',
    '    const primaryQuery = queries[0] || "";\n    const lastPage = Math.min(500, pageStart + maxPages - 1);\n    for (let page = pageStart + 1; page <= lastPage && requests < maxRequests; page += 1) {',
    'search subsequent pages',
)
search_path.write_text(search)

# -----------------------------------------------------------------------------
# 2) Catálogo: cursor, exclusão de páginas anteriores e preenchimento progressivo.
# -----------------------------------------------------------------------------
catalog_path = Path('src/catalog.ts')
catalog = catalog_path.read_text()
catalog = replace_once(
    catalog,
    'import { discountPercent, offerKey, offerRating, offerSales } from "../lib/offer-engine";',
    'import { discountPercent, offerKey, offerRating, offerSales, productFingerprint } from "../lib/offer-engine";',
    'catalog fingerprint import',
)

explore_block = r'''type ExploreOptions = {
  startPage?: number;
  pageSpan?: number;
  maxRequests?: number;
  excludeOfferKeys?: string[];
  excludeFingerprints?: string[];
};

export async function exploreOffers(env: Env, filters: ExploreFilters, options: ExploreOptions = {}) {
  const provider = createShopeeProvider({
    appId: required(env.SHOPEE_APP_ID, "SHOPEE_APP_ID"),
    secret: required(env.SHOPEE_SECRET, "SHOPEE_SECRET"),
  });
  const startPage = Math.min(Math.max(Math.trunc(options.startPage ?? 1), 1), 500);
  const pageSpan = Math.min(Math.max(Math.trunc(options.pageSpan ?? 1), 1), 5);
  const maxRequests = Math.min(Math.max(Math.trunc(options.maxRequests ?? 8), 1), 30);
  const excludedKeys = new Set((options.excludeOfferKeys || []).slice(0, 500));
  const excludedFingerprints = new Set((options.excludeFingerprints || []).slice(0, 500));
  const discoveryTarget = Math.min(Math.max(filters.limit * 4, 40), 100);
  const search = await searchQualifiedOffers(
    provider,
    {
      keyword: "",
      minCommission: filters.minCommission ?? undefined,
      minDiscount: filters.minDiscount ?? undefined,
      maxPrice: filters.maxPrice ?? undefined,
      sort: presetSort(filters.preset, filters.sort),
    },
    discoveryTarget,
    {
      maxPages: pageSpan,
      pageStart: startPage,
      pageSize: 50,
      maxRequests,
      searchScope: "all",
      excludeOffer: (offer) => excludedKeys.has(offerKey(offer)) || excludedFingerprints.has(productFingerprint(offer)),
    },
  );
  let offers = search.selected.filter((offer) => {
    const price = offer.price ?? 0;
    const sales = metric(offer, "sales");
    const rating = metric(offer, "rating");
    if (filters.minPrice != null && price < filters.minPrice) return false;
    if (filters.minSales != null && sales < filters.minSales) return false;
    if (filters.minRating != null && rating < filters.minRating) return false;
    return true;
  });
  offers = sortOffers(offers, filters.preset, filters.sort).slice(0, filters.limit);
  const nextCursor = Math.min(501, startPage + pageSpan);
  return {
    offers: offers.map((offer) => ({
      offer,
      key: offerKey(offer),
      fingerprint: productFingerprint(offer),
      score: opportunityScore(offer, filters.preset),
      sales: metric(offer, "sales"),
      rating: metric(offer, "rating"),
      discount: Math.round((offer.discountPercent ?? discountPercent(offer)) * 10) / 10,
      commission: Math.round((offer.commissionPercent ?? 0) * 10) / 10,
    })),
    scanned: search.scanned,
    requests: search.strategy.requests,
    diagnostics: search.diagnostics,
    strategy: search.strategy,
    filters,
    cursor: startPage,
    nextCursor,
    hasMore: nextCursor <= 500 && search.scanned > 0,
  };
}

'''
catalog = regex_once(
    catalog,
    r'export async function exploreOffers\(env: Env, filters: ExploreFilters\) \{.*?\n\}\n\n(?=function listFilters)',
    explore_block,
    'catalog explore function',
    flags=re.S,
)

refresh_block = r'''async function refreshList(db: SupabaseRest, env: Env, id: string) {
  const rows = await db.select<OfferListRow>("offer_lists", new URLSearchParams({ select: "*", id: eq(id), limit: "1" }));
  const list = rows[0];
  if (!list) return json({ error: "Lista não encontrada." }, 404);
  if (list.list_type === "manual") return json({ error: "Lista manual não usa atualização inteligente." }, 409);

  const existing = await db.select<OfferListItemRow>(
    "offer_list_items",
    new URLSearchParams({ select: "*", list_id: eq(id), order: "created_at.asc", limit: "500" }),
  );
  const targetSize = Math.min(Math.max(list.target_size || 1, 1), 100);
  if (existing.length >= targetSize) {
    return json({ ok: true, listId: id, refreshed: 0, totalItems: existing.length, targetSize, complete: true, exhausted: false });
  }

  const rules = (list.rules || {}) as JsonObject;
  const startPage = Math.min(Math.max(Math.trunc(Number(rules.searchCursor) || 1), 1), 500);
  const existingKeys = existing.map((item) => item.offer_key);
  const existingFingerprints = existing
    .map((item) => item.offer_snapshot ? productFingerprint(item.offer_snapshot) : "")
    .filter(Boolean);
  const remaining = targetSize - existing.length;
  const filters = { ...listFilters(list), limit: Math.min(Math.max(remaining * 3, 24), 60) };
  const result = await exploreOffers(env, filters, {
    startPage,
    pageSpan: 1,
    maxRequests: 6,
    excludeOfferKeys: existingKeys,
    excludeFingerprints: existingFingerprints,
  });

  const seenKeys = new Set(existingKeys);
  const seenFingerprints = new Set(existingFingerprints);
  const fresh = result.offers
    .map(({ offer }) => offer)
    .filter((offer) => {
      const key = offerKey(offer);
      const fingerprint = productFingerprint(offer);
      if (seenKeys.has(key) || seenFingerprints.has(fingerprint)) return false;
      seenKeys.add(key);
      seenFingerprints.add(fingerprint);
      return true;
    })
    .slice(0, remaining);

  const payload = fresh.map((offer) => ({
    id: crypto.randomUUID(),
    list_id: list.id,
    offer_key: offerKey(offer),
    network: offer.network,
    offer_id: offer.id,
    offer_snapshot: offer,
    source: "smart" as const,
    pinned: false,
  }));
  if (payload.length) {
    await db.insert<OfferListItemRow>(
      "offer_list_items?on_conflict=list_id,offer_key",
      payload,
      "resolution=merge-duplicates,return=representation",
    );
  }

  const totalItems = existing.length + payload.length;
  const emptyWaves = payload.length ? 0 : Math.min(Math.max(Number(rules.searchEmptyWaves) || 0, 0) + 1, 99);
  const exhausted = !result.hasMore || emptyWaves >= 5;
  const nextRules: JsonObject = {
    ...rules,
    searchCursor: exhausted ? 1 : result.nextCursor,
    searchEmptyWaves: exhausted ? 0 : emptyWaves,
    lastRefreshAt: new Date().toISOString(),
    lastSearchScanned: result.scanned,
    lastSearchRequests: result.requests,
  };
  await db.update("offer_lists", new URLSearchParams({ id: eq(id) }), { rules: nextRules, updated_at: new Date().toISOString() });

  return json({
    ok: true,
    listId: id,
    refreshed: payload.length,
    totalItems,
    targetSize,
    complete: totalItems >= targetSize,
    exhausted,
    nextCursor: result.nextCursor,
    scanned: result.scanned,
    requests: result.requests,
  });
}

'''
catalog = regex_once(
    catalog,
    r'async function refreshList\(db: SupabaseRest, env: Env, id: string\) \{.*?\n\}\n\n(?=async function addItem)',
    refresh_block,
    'catalog progressive refresh',
    flags=re.S,
)

catalog = replace_once(
    catalog,
    '  if (request.method === "POST" && path === "/api/admin/explore") {\n    const body = await request.json().catch(() => ({})) as JsonObject;\n    const filters = parseExploreFilters(body);\n    return json(await exploreOffers(env, filters));\n  }',
    '''  if (request.method === "POST" && path === "/api/admin/explore") {
    const body = await request.json().catch(() => ({})) as JsonObject;
    const filters = parseExploreFilters(body);
    const cursor = integerOrNull(body.cursor, 1, 500) ?? 1;
    const excludeOfferKeys = Array.isArray(body.excludeOfferKeys) ? body.excludeOfferKeys.filter((v): v is string => typeof v === "string").slice(0, 500) : [];
    const excludeFingerprints = Array.isArray(body.excludeFingerprints) ? body.excludeFingerprints.filter((v): v is string => typeof v === "string").slice(0, 500) : [];
    return json(await exploreOffers(env, filters, { startPage: cursor, pageSpan: 1, maxRequests: 8, excludeOfferKeys, excludeFingerprints }));
  }''',
    'catalog explore endpoint cursor',
)

catalog_path.write_text(catalog)

# -----------------------------------------------------------------------------
# 3) Painel: paginação sob demanda + preenchimento automático de listas.
# -----------------------------------------------------------------------------
admin_path = Path('src/admin.ts')
admin = admin_path.read_text()
admin = replace_once(
    admin,
    '<div class="catalog-summary muted" id="offerSummary">Escolha uma estratégia e busque oportunidades.</div>\n  <div class="offer-grid" id="offerGrid"></div>',
    '<div class="catalog-summary muted" id="offerSummary">Escolha uma estratégia e busque oportunidades.</div>\n  <div class="catalog-pager" id="offerPager" style="display:none"><button class="btn small" id="offerPrevBtn">← Anterior</button><span id="offerPageLabel" class="muted">Página 1</span><button class="btn small primary" id="offerNextBtn">Próximo →</button></div>\n  <div class="offer-grid" id="offerGrid"></div>',
    'admin pager html',
)
admin = replace_once(
    admin,
    '.catalog-summary{margin:10px 2px 14px}.offer-grid{',
    '.catalog-summary{margin:10px 2px 10px}.catalog-pager{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin:0 0 14px}.catalog-pager .btn:disabled{opacity:.45;cursor:not-allowed}.offer-grid{',
    'admin pager css',
)
admin = replace_once(
    admin,
    "var catalogState={preset:'recommended',offers:[],lists:[],items:[],loadedOffers:false};",
    "var catalogState={preset:'recommended',offers:[],lists:[],items:[],loadedOffers:false,pages:[],pageIndex:0,cursor:1,seenKeys:[],seenFingerprints:[],hasMore:true};",
    'admin catalog state',
)

new_search_js = r'''  function renderPager(){var p=q('offerPager');if(!p)return;var hasPages=catalogState.pages.length>0;p.style.display=hasPages&&(catalogState.pageIndex>0||catalogState.hasMore)?'flex':'none';var label=q('offerPageLabel');if(label)label.textContent='Página '+(catalogState.pageIndex+1)+' · '+(catalogState.offers||[]).length+' oferta(s)';var prev=q('offerPrevBtn'),next=q('offerNextBtn');if(prev)prev.disabled=catalogState.pageIndex<=0;if(next)next.disabled=!catalogState.hasMore&&catalogState.pageIndex>=catalogState.pages.length-1}
  function resetOfferPaging(){catalogState.pages=[];catalogState.pageIndex=0;catalogState.cursor=1;catalogState.seenKeys=[];catalogState.seenFingerprints=[];catalogState.hasMore=true;catalogState.offers=[]}
  function offerPayload(){return{preset:catalogState.preset,minCommission:q('offerMinCommission')&&q('offerMinCommission').value,minDiscount:q('offerMinDiscount')&&q('offerMinDiscount').value,maxPrice:q('offerMaxPrice')&&q('offerMaxPrice').value,sort:q('offerSort')&&q('offerSort').value,limit:12,cursor:catalogState.cursor,excludeOfferKeys:catalogState.seenKeys,excludeFingerprints:catalogState.seenFingerprints}}
  async function fetchOfferPage(reset){var btn=q('offerSearchBtn');if(reset)resetOfferPaging();if(btn){btn.disabled=true;btn.textContent='Buscando…'}try{var r=null,pageOffers=[],attempts=0,totalScanned=0,totalRequests=0;do{r=await capi('/api/admin/explore',{method:'POST',body:JSON.stringify(offerPayload())});pageOffers=r.offers||[];totalScanned+=Number(r.scanned||0);totalRequests+=Number(r.requests||0);catalogState.cursor=Number(r.nextCursor||catalogState.cursor+1);catalogState.hasMore=Boolean(r.hasMore);attempts+=1}while(!pageOffers.length&&catalogState.hasMore&&attempts<3);if(pageOffers.length){catalogState.pages.push(pageOffers);catalogState.pageIndex=catalogState.pages.length-1;catalogState.offers=pageOffers;pageOffers.forEach(function(x){if(x.key&&!catalogState.seenKeys.includes(x.key))catalogState.seenKeys.push(x.key);if(x.fingerprint&&!catalogState.seenFingerprints.includes(x.fingerprint))catalogState.seenFingerprints.push(x.fingerprint)})}else{catalogState.offers=[];if(reset)catalogState.pages=[]}catalogState.loadedOffers=true;var s=q('offerSummary');if(s)s.textContent=totalScanned+' anúncios únicos analisados nesta busca · '+totalRequests+' consultas · '+pageOffers.length+' oportunidade(s) nesta página'+(catalogState.hasMore?' · há mais resultados':' · fim dos resultados encontrados');renderOffers();renderPager()}catch(e){var s=q('offerSummary');if(s)s.textContent='Falha ao buscar ofertas: '+e.message}finally{if(btn){btn.disabled=false;btn.textContent='Buscar ofertas'}}}
  async function searchOffers(){return fetchOfferPage(true)}
  async function nextOfferPage(){if(catalogState.pageIndex<catalogState.pages.length-1){catalogState.pageIndex+=1;catalogState.offers=catalogState.pages[catalogState.pageIndex];renderOffers();renderPager();return}if(catalogState.hasMore)await fetchOfferPage(false)}
  function prevOfferPage(){if(catalogState.pageIndex<=0)return;catalogState.pageIndex-=1;catalogState.offers=catalogState.pages[catalogState.pageIndex];renderOffers();renderPager()}
'''
admin = regex_once(
    admin,
    r'  async function searchOffers\(\)\{.*?\n  async function loadLists\(\)\{',
    new_search_js + "  async function loadLists(){",
    'admin search pagination js',
    flags=re.S,
)

admin = regex_once(
    admin,
    r'  async function createList\(e\)\{.*?\n  async function refreshList\(id,button\)\{',
    r'''  async function createList(e){e.preventDefault();var payload={name:q('listName').value,description:q('listDescription').value,preset:q('listPreset').value,listType:'intelligent',minCommission:q('listMinCommission').value,minDiscount:q('listMinDiscount').value,maxPrice:q('listMaxPrice').value,targetSize:q('listTargetSize').value,refresh:false};var submit=q('listForm').querySelector('button[type=submit]');submit.disabled=true;submit.textContent='Criando…';try{var created=await capi('/api/admin/lists',{method:'POST',body:JSON.stringify(payload)});q('listModal').classList.remove('show');await loadLists();var id=created.list&&created.list.id;if(id){var button=document.querySelector('[data-refresh-list="'+id+'"]');await refreshList(id,button)}}catch(e2){alert('Não foi possível criar a lista: '+e2.message)}finally{submit.disabled=false;submit.textContent='Criar e preencher lista'}}
  async function refreshList(id,button){''',
    'admin create list progressive',
    flags=re.S,
)

admin = regex_once(
    admin,
    r'  async function refreshList\(id,button\)\{.*?\n  async function toggleList\(id\)\{',
    r'''  async function refreshList(id,button){var cycles=0,last=null;if(button){button.disabled=true;button.textContent='Buscando…'}try{do{last=await capi('/api/admin/lists/'+id+'/refresh',{method:'POST',body:'{}'});cycles+=1;if(button)button.textContent='Buscando '+Number(last.totalItems||0)+'/'+Number(last.targetSize||0)+'…'}while(last&&!last.complete&&!last.exhausted&&cycles<10);await loadLists();if(last&&!last.complete&&!last.exhausted)alert('A busca avançou bastante, mas atingiu o limite de segurança desta rodada. Clique em “Atualizar produtos” para continuar exatamente de onde parou.');else if(last&&last.exhausted&&!last.complete)alert('A busca percorreu várias páginas e não encontrou produtos suficientes para completar o volume com esses filtros.');}catch(e){alert(e.message)}finally{if(button){button.disabled=false;button.textContent='Atualizar produtos'}}}
  async function toggleList(id){''',
    'admin auto fill list',
    flags=re.S,
)

admin = replace_once(
    admin,
    "<div class=\"list-stat\"><small>Itens</small><b>'+ce(l.itemCount||items.length)+'</b></div>",
    "<div class=\"list-stat\"><small>Itens</small><b>'+ce(l.itemCount||items.length)+' / '+ce(l.target_size||'—')+'</b></div>",
    'admin list target display',
)

admin = replace_once(
    admin,
    "[data-preset],[data-list-preset],#offerSearchBtn,#saveSearchListBtn,#newListBtn,#closeListModal,[data-refresh-list],[data-toggle-list],[data-add-offer]",
    "[data-preset],[data-list-preset],#offerSearchBtn,#offerPrevBtn,#offerNextBtn,#saveSearchListBtn,#newListBtn,#closeListModal,[data-refresh-list],[data-toggle-list],[data-add-offer]",
    'admin pager click selector',
)
admin = replace_once(
    admin,
    "if(t.id==='offerSearchBtn'){searchOffers();return}if(t.id==='saveSearchListBtn')",
    "if(t.id==='offerSearchBtn'){searchOffers();return}if(t.id==='offerPrevBtn'){prevOfferPage();return}if(t.id==='offerNextBtn'){nextOfferPage();return}if(t.id==='saveSearchListBtn')",
    'admin pager click actions',
)

admin_path.write_text(admin)
print('progressive search patch applied')
