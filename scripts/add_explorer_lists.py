from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'pattern not found: {label}')
    return text.replace(old, new, 1)

admin_path = Path('src/admin.ts')
admin = admin_path.read_text()

admin = replace_once(
    admin,
    'import { required, type Env } from "./env";',
    'import { required, type Env } from "./env";\nimport { handleCatalogAdminApi } from "./catalog";',
    'admin import catalog',
)

admin = replace_once(
    admin,
    '  const url=new URL(request.url); const path=url.pathname; const db=new SupabaseRest(env);\n',
    '  const url=new URL(request.url); const path=url.pathname; const db=new SupabaseRest(env);\n  const catalogResponse=await handleCatalogAdminApi(request,env);\n  if(catalogResponse) return catalogResponse;\n',
    'admin catalog handler',
)

admin = replace_once(
    admin,
    '<button data-view="automations">⚙ <span>Automações</span></button><button data-view="queue">≡ <span>Fila</span></button>',
    '<button data-view="automations">⚙ <span>Automações</span></button><button data-view="offers">⌕ <span>Ofertas</span></button><button data-view="lists">✧ <span>Listas</span></button><button data-view="queue">≡ <span>Fila</span></button>',
    'sidebar offers lists',
)

admin = replace_once(
    "automations:['Automações','Gerencie regras e execuções'],queue:['Fila','Acompanhe e intervenha em publicações']",
    "automations:['Automações','Gerencie regras e execuções'],offers:['Ofertas','Explore oportunidades da Shopee'],lists:['Listas','Organize fontes inteligentes para suas automações'],queue:['Fila','Acompanhe e intervenha em publicações']",
    'titles offers lists',
)

admin = replace_once(
    '<section class="view" id="view-automations"><div class="view-head"><label class="check"><input id="showPaused" type="checkbox"> Mostrar pausadas</label></div><div id="rules" class="rule-list"></div></section>\n<section class="view" id="view-queue">',
    '''<section class="view" id="view-automations"><div class="view-head"><label class="check"><input id="showPaused" type="checkbox"> Mostrar pausadas</label></div><div id="rules" class="rule-list"></div></section>
<section class="view" id="view-offers">
  <div class="catalog-toolbar panel">
    <div class="preset-row" id="offerPresets">
      <button class="preset active" data-preset="recommended">✨ Recomendados</button>
      <button class="preset" data-preset="viral">🔥 Viral</button>
      <button class="preset" data-preset="sales">📈 Mais vendidos</button>
      <button class="preset" data-preset="commission">💰 Maior comissão</button>
      <button class="preset" data-preset="discount">🏷️ Maior desconto</button>
      <button class="preset" data-preset="new">🆕 Produtos novos</button>
    </div>
    <div class="catalog-filters">
      <div class="field"><label>Comissão mínima %</label><input id="offerMinCommission" type="number" min="0" max="100" step="0.1"></div>
      <div class="field"><label>Desconto mínimo %</label><input id="offerMinDiscount" type="number" min="0" max="100" step="0.1"></div>
      <div class="field"><label>Preço máximo</label><input id="offerMaxPrice" type="number" min="0" step="0.01"></div>
      <div class="field"><label>Ordenar</label><select id="offerSort"><option value="">Padrão da estratégia</option><option value="commission">Comissão</option><option value="discount">Desconto</option><option value="sales">Vendas</option><option value="price">Menor preço</option></select></div>
      <button class="btn primary catalog-search" id="offerSearchBtn">Buscar ofertas</button>
      <button class="btn" id="saveSearchListBtn">Salvar como lista</button>
    </div>
  </div>
  <div class="catalog-summary muted" id="offerSummary">Escolha uma estratégia e busque oportunidades.</div>
  <div class="offer-grid" id="offerGrid"></div>
</section>
<section class="view" id="view-lists">
  <div class="view-head"><div class="muted">Listas inteligentes funcionam como fontes reutilizáveis para as automações.</div><button class="btn primary" id="newListBtn">+ Nova lista inteligente</button></div>
  <div id="listsGrid" class="list-grid"></div>
</section>
<section class="view" id="view-queue">''',
    'views offers lists',
)

admin = replace_once(
    '<div class="field"><label>Quantidade / ciclo</label><input id="quantity" type="number" min="1" max="100" value="1"></div>',
    '<div class="field full"><label>Lista fonte (opcional)</label><select id="sourceList"><option value="">Busca inteligente direta</option></select><div class="muted" style="font-size:10px;margin-top:5px">Ao escolher uma lista, a automação usa os filtros e a estratégia dessa lista.</div></div><div class="field"><label>Quantidade / ciclo</label><input id="quantity" type="number" min="1" max="100" value="1"></div>',
    'automation source list field',
)

list_modal = '''
<div class="modal-backdrop" id="listModal"><div class="modal"><form id="listForm"><div class="modal-head"><h3>Nova lista inteligente</h3><button type="button" class="btn" id="closeListModal">Fechar</button></div><div class="modal-body"><div class="form-grid">
<div class="field full"><label>Nome da lista</label><input id="listName" maxlength="120" required placeholder="Ex.: Descontos Altíssimos"></div>
<div class="field full"><label>Descrição</label><input id="listDescription" maxlength="220" placeholder="Ex.: Produtos com desconto e comissão fortes"></div>
<div class="field full"><label>Estratégia</label><div class="preset-row compact" id="listPresets"><button type="button" class="preset active" data-list-preset="recommended">✨ Recomendados</button><button type="button" class="preset" data-list-preset="viral">🔥 Viral</button><button type="button" class="preset" data-list-preset="sales">📈 Vendidos</button><button type="button" class="preset" data-list-preset="commission">💰 Comissão</button><button type="button" class="preset" data-list-preset="discount">🏷️ Desconto</button><button type="button" class="preset" data-list-preset="new">🆕 Novos</button></div><input id="listPreset" type="hidden" value="recommended"></div>
<div class="field"><label>Comissão mínima %</label><input id="listMinCommission" type="number" min="0" max="100" step="0.1"></div>
<div class="field"><label>Desconto mínimo %</label><input id="listMinDiscount" type="number" min="0" max="100" step="0.1"></div>
<div class="field"><label>Preço máximo</label><input id="listMaxPrice" type="number" min="0" step="0.01"></div>
<div class="field"><label>Tamanho alvo</label><input id="listTargetSize" type="number" min="1" max="100" value="30"></div>
</div></div><div class="modal-foot"><button class="btn primary" type="submit">Criar e preencher lista</button></div></form></div></div>
'''
admin = replace_once(admin, '<div class="lock show" id="lock">', list_modal + '<div class="lock show" id="lock">', 'list modal')

catalog_css = '''
.catalog-toolbar{padding:16px;margin-bottom:14px;background:linear-gradient(145deg,rgba(8,17,38,.96),rgba(9,16,34,.92));border-color:#273d6b}.preset-row{display:flex;gap:8px;flex-wrap:wrap}.preset{border:1px solid #2c426d;background:#0a1530;color:#aab7d8;padding:9px 12px;border-radius:11px;cursor:pointer;font-weight:800;font-size:11px}.preset:hover,.preset.active{color:#fff;border-color:#7752ff;background:linear-gradient(135deg,rgba(95,53,255,.34),rgba(22,166,255,.18));box-shadow:0 0 18px rgba(106,63,255,.18)}.preset-row.compact .preset{padding:7px 9px}.catalog-filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) auto auto;gap:10px;align-items:end;margin-top:14px}.catalog-search{height:40px}.catalog-summary{margin:10px 2px 14px}.offer-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.offer-card{background:linear-gradient(145deg,rgba(8,18,39,.98),rgba(7,13,29,.97));border:1px solid #253b68;border-radius:16px;overflow:hidden;box-shadow:0 18px 42px rgba(0,0,0,.18);display:flex;flex-direction:column}.offer-card .photo{aspect-ratio:1.35/1;background:#09142b;display:grid;place-items:center;overflow:hidden}.offer-card .photo img{width:100%;height:100%;object-fit:contain;background:#fff}.offer-card .body{padding:13px;display:grid;gap:9px}.offer-card .title{font-size:13px;font-weight:850;line-height:1.35;color:#f1f5ff;min-height:36px}.offer-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.offer-metric{background:rgba(15,28,58,.72);border:1px solid rgba(45,65,111,.72);padding:7px;border-radius:9px}.offer-metric small{display:block;color:#7f8eb2;font-size:9px}.offer-metric b{font-size:11px;color:#e9eeff}.score{display:inline-flex;align-items:center;gap:5px;color:#27e9a2;font-weight:900}.offer-actions{display:flex;gap:7px;align-items:center}.offer-actions select{min-width:0;flex:1;background:#081127;border:1px solid #293d69;color:#edf2ff;border-radius:9px;padding:8px}.list-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.smart-list{background:linear-gradient(145deg,rgba(8,18,39,.98),rgba(7,13,29,.97));border:1px solid #253b68;border-radius:16px;padding:16px}.smart-list h4{margin:0;color:#f5f7ff}.list-meta{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.list-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:12px 0}.list-stat{padding:8px;border-radius:9px;background:rgba(14,27,57,.68);border:1px solid #243b67}.list-stat small{display:block;color:#7d8daf;font-size:9px}.list-stat b{font-size:12px}.list-items-preview{display:flex;gap:6px;margin:10px 0}.list-items-preview img{width:42px;height:42px;border-radius:9px;object-fit:cover;background:#fff;border:1px solid #29416e}@media(max-width:1100px){.offer-grid{grid-template-columns:repeat(2,1fr)}.catalog-filters{grid-template-columns:repeat(2,1fr)}.list-grid{grid-template-columns:1fr}}@media(max-width:700px){.offer-grid,.catalog-filters{grid-template-columns:1fr}.offer-card .photo{aspect-ratio:1.6/1}}
'''
admin = replace_once(admin, '</style></head>', catalog_css + '</style></head>', 'catalog css')

catalog_script = r'''
<script>(function(){
  var catalogState={preset:'recommended',offers:[],lists:[],items:[],loadedOffers:false};
  function q(id){return document.getElementById(id)}
  function ce(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]})}
  function auth(){return sessionStorage.getItem('automationSecret')||''}
  async function capi(path,opt){opt=opt||{};opt.headers=Object.assign({'authorization':'Bearer '+auth(),'content-type':'application/json'},opt.headers||{});var r=await fetch(path,opt),p=await r.json().catch(function(){return{}});if(!r.ok)throw new Error(p.message||p.error||'Falha');return p}
  function money(v){var n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n):'—'}
  function presetName(v){return{recommended:'Recomendados',viral:'Viral',sales:'Mais vendidos',commission:'Maior comissão',discount:'Maior desconto',new:'Produtos novos'}[v]||v}
  function listOptions(selected){var html='<option value="">Adicionar a uma lista…</option>';catalogState.lists.filter(function(l){return l.enabled}).forEach(function(l){html+='<option value="'+ce(l.id)+'"'+(selected===l.id?' selected':'')+'>'+ce(l.name)+'</option>'});return html}
  function renderOffers(){var grid=q('offerGrid');if(!grid)return;if(!catalogState.offers.length){grid.innerHTML='<div class="empty panel" style="grid-column:1/-1">Nenhuma oportunidade encontrada com os filtros atuais.</div>';return}grid.innerHTML=catalogState.offers.map(function(x,i){var o=x.offer||{},img=o.imageUrl?'<img src="'+ce(o.imageUrl)+'" loading="lazy">':'',price=o.price!=null?money(o.price):'—',discount=Number(x.discount||0),commission=Number(x.commission||0),sales=Number(x.sales||0),rating=Number(x.rating||0);return'<article class="offer-card"><div class="photo">'+img+'</div><div class="body"><div class="title">'+ce(o.title||'Oferta')+'</div><div><span class="score">◆ '+ce(x.score)+' / 100</span> <span class="muted">· '+ce(presetName(catalogState.preset))+'</span></div><div class="offer-metrics"><div class="offer-metric"><small>Preço</small><b>'+ce(price)+'</b></div><div class="offer-metric"><small>Desconto</small><b>'+ce(discount)+'%</b></div><div class="offer-metric"><small>Comissão</small><b>'+ce(commission)+'%</b></div><div class="offer-metric"><small>Vendas</small><b>'+ce(sales)+'</b></div><div class="offer-metric"><small>Avaliação</small><b>'+ce(rating||'novo')+'</b></div><div class="offer-metric"><small>Rede</small><b>Shopee</b></div></div><div class="offer-actions"><select data-offer-list="'+i+'">'+listOptions('')+'</select><button class="btn small primary" data-add-offer="'+i+'">Adicionar</button></div></div></article>'}).join('')}
  async function searchOffers(){var btn=q('offerSearchBtn');if(btn){btn.disabled=true;btn.textContent='Buscando…'}try{var payload={preset:catalogState.preset,minCommission:q('offerMinCommission')&&q('offerMinCommission').value,minDiscount:q('offerMinDiscount')&&q('offerMinDiscount').value,maxPrice:q('offerMaxPrice')&&q('offerMaxPrice').value,sort:q('offerSort')&&q('offerSort').value,limit:24};var r=await capi('/api/admin/explore',{method:'POST',body:JSON.stringify(payload)});catalogState.offers=r.offers||[];catalogState.loadedOffers=true;var s=q('offerSummary');if(s)s.textContent=(r.scanned||0)+' anúncios únicos analisados · '+(r.requests||0)+' consultas · '+catalogState.offers.length+' oportunidades exibidas';renderOffers()}catch(e){var s=q('offerSummary');if(s)s.textContent='Falha ao buscar ofertas: '+e.message}finally{if(btn){btn.disabled=false;btn.textContent='Buscar ofertas'}}}
  async function loadLists(){try{var r=await capi('/api/admin/lists');catalogState.lists=r.lists||[];catalogState.items=r.items||[];renderLists();renderOffers();populateSourceLists()}catch(e){var g=q('listsGrid');if(g)g.innerHTML='<div class="empty panel">'+ce(e.message)+'</div>'}}
  function populateSourceLists(){var sel=q('sourceList');if(!sel)return;var current=sel.value;sel.innerHTML='<option value="">Busca inteligente direta</option>'+catalogState.lists.filter(function(l){return l.enabled}).map(function(l){return'<option value="'+ce(l.id)+'">'+ce(l.name)+' · '+ce(presetName(l.preset))+'</option>'}).join('');if(current&&Array.from(sel.options).some(function(o){return o.value===current}))sel.value=current}
  function renderLists(){var g=q('listsGrid');if(!g)return;if(!catalogState.lists.length){g.innerHTML='<div class="empty panel">Você ainda não criou listas. Crie uma lista inteligente ou salve uma busca da aba Ofertas.</div>';return}g.innerHTML=catalogState.lists.map(function(l){var items=catalogState.items.filter(function(i){return i.list_id===l.id}),pics=items.slice(0,5).map(function(i){var u=i.offer_snapshot&&i.offer_snapshot.imageUrl;return u?'<img src="'+ce(u)+'" loading="lazy">':''}).join('');return'<div class="smart-list"><div style="display:flex;justify-content:space-between;gap:12px"><div><h4>'+ce(l.name)+'</h4><div class="muted">'+ce(l.description||'Lista inteligente')+'</div></div><span class="pill '+(l.enabled?'green':'amber')+'">'+(l.enabled?'ativa':'pausada')+'</span></div><div class="list-meta"><span class="pill purple">'+ce(presetName(l.preset))+'</span><span class="pill">'+ce(l.list_type)+'</span></div><div class="list-stats"><div class="list-stat"><small>Itens</small><b>'+ce(l.itemCount||items.length)+'</b></div><div class="list-stat"><small>Comissão mín.</small><b>'+ce(l.min_commission==null?'livre':l.min_commission+'%')+'</b></div><div class="list-stat"><small>Desconto mín.</small><b>'+ce(l.min_discount==null?'livre':l.min_discount+'%')+'</b></div></div><div class="list-items-preview">'+pics+'</div><div class="row-actions"><button class="btn small primary" data-refresh-list="'+ce(l.id)+'">Atualizar produtos</button><button class="btn small" data-toggle-list="'+ce(l.id)+'">'+(l.enabled?'Pausar':'Ativar')+'</button></div></div>'}).join('')}
  function openListModal(fromSearch){q('listModal').classList.add('show');q('listName').value='';q('listDescription').value='';q('listPreset').value=catalogState.preset||'recommended';q('listMinCommission').value=fromSearch&&q('offerMinCommission')?q('offerMinCommission').value:'';q('listMinDiscount').value=fromSearch&&q('offerMinDiscount')?q('offerMinDiscount').value:'';q('listMaxPrice').value=fromSearch&&q('offerMaxPrice')?q('offerMaxPrice').value:'';document.querySelectorAll('[data-list-preset]').forEach(function(b){b.classList.toggle('active',b.dataset.listPreset===q('listPreset').value)})}
  async function createList(e){e.preventDefault();var payload={name:q('listName').value,description:q('listDescription').value,preset:q('listPreset').value,listType:'intelligent',minCommission:q('listMinCommission').value,minDiscount:q('listMinDiscount').value,maxPrice:q('listMaxPrice').value,targetSize:q('listTargetSize').value,refresh:true};var submit=q('listForm').querySelector('button[type=submit]');submit.disabled=true;submit.textContent='Criando…';try{await capi('/api/admin/lists',{method:'POST',body:JSON.stringify(payload)});q('listModal').classList.remove('show');await loadLists()}catch(e2){alert('Não foi possível criar a lista: '+e2.message)}finally{submit.disabled=false;submit.textContent='Criar e preencher lista'}}
  async function refreshList(id,button){if(button){button.disabled=true;button.textContent='Atualizando…'}try{await capi('/api/admin/lists/'+id+'/refresh',{method:'POST',body:'{}'});await loadLists()}catch(e){alert(e.message)}finally{if(button){button.disabled=false;button.textContent='Atualizar produtos'}}}
  async function toggleList(id){var l=catalogState.lists.find(function(x){return x.id===id});if(!l)return;await capi('/api/admin/lists/'+id,{method:'PATCH',body:JSON.stringify({enabled:!l.enabled})});await loadLists()}
  async function addOffer(index,button){var select=document.querySelector('select[data-offer-list="'+index+'"]'),id=select&&select.value;if(!id){if(!catalogState.lists.length){openListModal(true);return}alert('Escolha uma lista para adicionar esta oferta.');return}var entry=catalogState.offers[index];if(!entry)return;if(button){button.disabled=true;button.textContent='Adicionando…'}try{await capi('/api/admin/lists/'+id+'/items',{method:'POST',body:JSON.stringify({offer:entry.offer})});await loadLists();if(button)button.textContent='Adicionado ✓'}catch(e){alert(e.message);if(button){button.disabled=false;button.textContent='Adicionar'}}}
  document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-preset],[data-list-preset],#offerSearchBtn,#saveSearchListBtn,#newListBtn,#closeListModal,[data-refresh-list],[data-toggle-list],[data-add-offer]');if(!t)return;if(t.dataset.preset){catalogState.preset=t.dataset.preset;document.querySelectorAll('[data-preset]').forEach(function(b){b.classList.toggle('active',b===t)});searchOffers();return}if(t.dataset.listPreset){q('listPreset').value=t.dataset.listPreset;document.querySelectorAll('[data-list-preset]').forEach(function(b){b.classList.toggle('active',b===t)});return}if(t.id==='offerSearchBtn'){searchOffers();return}if(t.id==='saveSearchListBtn'){openListModal(true);return}if(t.id==='newListBtn'){openListModal(false);return}if(t.id==='closeListModal'){q('listModal').classList.remove('show');return}if(t.dataset.refreshList){refreshList(t.dataset.refreshList,t);return}if(t.dataset.toggleList){toggleList(t.dataset.toggleList);return}if(t.dataset.addOffer){addOffer(Number(t.dataset.addOffer),t);return}},true);
  document.addEventListener('click',function(e){var nav=e.target.closest&&e.target.closest('.nav button[data-view]');if(!nav)return;setTimeout(function(){if(nav.dataset.view==='offers'&&!catalogState.loadedOffers)searchOffers();if(nav.dataset.view==='lists')loadLists()},30)},true);
  q('listForm')&&q('listForm').addEventListener('submit',createList);
  setTimeout(loadLists,350);
})();</script>
'''
admin = replace_once(admin, '</body></html>`;', catalog_script + '</body></html>`;', 'catalog script')

# Ensure the existing request enhancer stores list source metadata.
old_enrich = "telegramThreadId:currentThread(),telegramTopicName:currentThread()?currentTopicName():null});"
new_enrich = "telegramThreadId:currentThread(),telegramTopicName:currentThread()?currentTopicName():null,listId:(byId('sourceList')&&byId('sourceList').value)||null,listName:(byId('sourceList')&&byId('sourceList').selectedIndex>0?byId('sourceList').options[byId('sourceList').selectedIndex].text.split(' · ')[0]:null)});"
admin = replace_once(admin, old_enrich, new_enrich, 'source list enrich')

# Hydrate the source-list selector after lists are loaded.
old_hydrate_tail = "await refreshTopics(settings.telegramThreadId,settings.telegramTopicName);if(!rule){if(byId('threadId'))byId('threadId').value='';if(byId('topicName'))byId('topicName').value=''}setTimeout(function(){},120)"
new_hydrate_tail = "await refreshTopics(settings.telegramThreadId,settings.telegramTopicName);if(byId('sourceList')){var wanted=settings.listId?String(settings.listId):'';setTimeout(function(){if(byId('sourceList')&&Array.from(byId('sourceList').options).some(function(o){return o.value===wanted}))byId('sourceList').value=wanted},180)}if(!rule){if(byId('threadId'))byId('threadId').value='';if(byId('topicName'))byId('topicName').value=''}setTimeout(function(){},120)"
admin = replace_once(admin, old_hydrate_tail, new_hydrate_tail, 'source list hydrate')

admin_path.write_text(admin)

# Patch the scheduled executor so an automation can reuse a smart list's filters.
auto_path = Path('src/automation.ts')
auto = auto_path.read_text()
auto = replace_once(auto, 'import { boundedInt, required, type Env } from "./env";', 'import { boundedInt, required, type Env } from "./env";\nimport type { OfferListRow } from "./catalog";', 'automation list type import')
auto = replace_once(auto, 'async function searchOffers(\n  env: Env,\n  rule: AutomationRuleRow,', 'async function searchOffers(\n  db: SupabaseRest,\n  env: Env,\n  rule: AutomationRuleRow,', 'automation search signature')
needle = '''    const result = await searchQualifiedOffers(
      provider,
      {
        keyword: "",
        category: rule.category || undefined,
        minCommission: rule.min_commission ?? undefined,
        minDiscount: rule.min_discount ?? undefined,
        maxPrice: rule.max_price ?? undefined,
        sort: rule.sort || undefined,
      },'''
replacement = '''    const listId = typeof rule.settings.listId === "string" ? rule.settings.listId : "";
    let sourceList: OfferListRow | undefined;
    if (listId) {
      const rows = await db.select<OfferListRow>("offer_lists", new URLSearchParams({ select: "*", id: eq(listId), enabled: "eq.true", limit: "1" }));
      sourceList = rows[0];
    }
    const result = await searchQualifiedOffers(
      provider,
      {
        keyword: "",
        category: rule.category || undefined,
        minCommission: sourceList?.min_commission ?? rule.min_commission ?? undefined,
        minDiscount: sourceList?.min_discount ?? rule.min_discount ?? undefined,
        maxPrice: sourceList?.max_price ?? rule.max_price ?? undefined,
        sort: sourceList?.sort ?? rule.sort ?? undefined,
      },'''
auto = replace_once(auto, needle, replacement, 'automation list filters')
auto = replace_once(auto, 'const { selected: candidates, unsupportedNetworks, scanned, pages, excluded } = await searchOffers(\n      env, rule, candidateTarget, excludeOffer,', 'const { selected: candidates, unsupportedNetworks, scanned, pages, excluded } = await searchOffers(\n      db, env, rule, candidateTarget, excludeOffer,', 'automation search call')
auto_path.write_text(auto)
