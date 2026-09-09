from pathlib import Path
import re

p = Path('src/admin.ts')
s = p.read_text()

def once(old, new, label):
    global s
    if old not in s:
        raise SystemExit(f'pattern not found: {label}')
    s = s.replace(old, new, 1)

once(
    'type AdminRuleInput = Record<string, unknown>;\n',
    '''type AdminRuleInput = Record<string, unknown>;
type TelegramTopicRow = {
  id: string;
  chat_id: string;
  thread_id: number;
  name: string;
  enabled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
''',
    'telegram topic type',
)

new_telegram_info = r'''async function telegramInfo(env: Env) {
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID) return {configured:false,topics:[]};
  const token=env.TELEGRAM_BOT_TOKEN; const chatId=env.TELEGRAM_CHAT_ID;
  async function call(method:string,body:JsonObject={}) { const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)}); const p=await r.json() as any; if(!r.ok||!p?.ok) throw new Error(p?.description||`Telegram HTTP ${r.status}`); return p.result; }
  const db=new SupabaseRest(env);
  const [me,chat,rules,storedTopics]=await Promise.all([
    call("getMe"),
    call("getChat",{chat_id:chatId}),
    db.select<AutomationRuleRow>("automation_rules",new URLSearchParams({select:"id,name,settings",order:"created_at.desc"})),
    db.select<TelegramTopicRow>("telegram_topics",new URLSearchParams({select:"*",chat_id:eq(chatId),enabled:"eq.true",order:"name.asc"})),
  ]);
  const topicMap=new Map<number,{name:string,stored:boolean}>();
  for(const topic of storedTopics){
    const id=Number(topic.thread_id);
    if(Number.isInteger(id)&&id>0) topicMap.set(id,{name:topic.name||`Tópico ${id}`,stored:true});
  }
  for(const rule of rules){
    const id=Number(rule.settings?.telegramThreadId);
    if(Number.isInteger(id)&&id>0&&!topicMap.has(id)){
      const name=typeof rule.settings?.telegramTopicName==="string"&&String(rule.settings.telegramTopicName).trim()?String(rule.settings.telegramTopicName).trim():`Tópico ${id}`;
      topicMap.set(id,{name,stored:false});
    }
  }
  const topics=Array.from(topicMap.entries()).map(([id,value])=>({id,name:value.name,stored:value.stored})).sort((a,b)=>a.name.localeCompare(b.name,"pt-BR"));
  return {configured:true,botUsername:me?.username||null,botName:me?.first_name||null,chatTitle:chat?.title||chat?.username||"Grupo Telegram",isForum:Boolean(chat?.is_forum),chatType:chat?.type||null,topics};
}'''
s, n = re.subn(r'async function telegramInfo\(env: Env\) \{.*?\n\}\n\nfunction buildPreviewSuggestions', new_telegram_info + '\n\nfunction buildPreviewSuggestions', s, count=1, flags=re.S)
if n != 1:
    raise SystemExit(f'telegramInfo replace failed: {n}')

once(
    '  if(request.method==="GET"&&path==="/api/admin/telegram") { try{return json(await telegramInfo(env));}catch(e){return json({configured:true,error:e instanceof Error?e.message:"Falha Telegram"},502);} }\n',
    '''  if(request.method==="GET"&&path==="/api/admin/telegram") { try{return json(await telegramInfo(env));}catch(e){return json({configured:true,error:e instanceof Error?e.message:"Falha Telegram"},502);} }
  if(request.method==="POST"&&path==="/api/admin/telegram/topics") {
    const body=await request.json().catch(()=>({})) as JsonObject;
    const threadId=Number(body.threadId);
    if(!Number.isInteger(threadId)||threadId<=0) return json({error:"Informe um ID de tópico válido."},400);
    const name=text(body.name,120)||`Tópico ${threadId}`;
    const chatId=required(env.TELEGRAM_CHAT_ID,"TELEGRAM_CHAT_ID");
    const rows=await db.insert<TelegramTopicRow>("telegram_topics?on_conflict=chat_id,thread_id",{
      chat_id:chatId,thread_id:threadId,name,enabled:true,updated_at:new Date().toISOString()
    },"resolution=merge-duplicates,return=representation");
    return json({ok:true,topic:{id:Number(rows[0]?.thread_id||threadId),name:rows[0]?.name||name,stored:true}},201);
  }
''',
    'topic api',
)

old_lists = '''<section class="view" id="view-lists">
  <div class="view-head"><div class="muted">Listas inteligentes funcionam como fontes reutilizáveis para as automações.</div><button class="btn primary" id="newListBtn">+ Nova lista inteligente</button></div>
  <div id="listsGrid" class="list-grid"></div>
</section>'''
new_lists = '''<section class="view" id="view-lists">
  <div class="view-head"><div class="muted">Listas inteligentes funcionam como fontes reutilizáveis para as automações.</div><button class="btn primary" id="newListBtn">+ Nova lista inteligente</button></div>
  <div class="list-help panel">
    <div class="list-help-title"><div><b>Como funcionam as listas?</b><div class="muted">Respostas rápidas para configurar, preencher e usar suas listas.</div></div><span class="pill purple">FAQ</span></div>
    <div class="faq-grid">
      <details class="faq-item" open><summary>Pra que serve uma lista?</summary><p>Ela organiza um conjunto de ofertas que atende aos seus filtros. Depois você pode usar a mesma lista como fonte de uma ou mais automações, sem configurar a busca do zero em cada uma.</p></details>
      <details class="faq-item"><summary>Não preencheu o número pedido. E agora?</summary><p>Isso é normal quando os filtros são fortes. Clique em <b>Atualizar produtos</b> novamente. A busca continua de onde parou, procura páginas novas da Shopee e adiciona somente produtos diferentes até tentar alcançar o tamanho alvo.</p></details>
      <details class="faq-item"><summary>Atualizar produtos apaga os que já encontrei?</summary><p>Não. Os produtos existentes são preservados. A atualização busca novos candidatos e acrescenta apenas itens que ainda não estão na lista.</p></details>
      <details class="faq-item"><summary>Por que a lista pode precisar de várias atualizações?</summary><p>Para mostrar resultados mais rápido e evitar uma busca longa demais de uma só vez. Cada atualização avança o cursor da pesquisa. Filtros como comissão muito alta podem exigir várias páginas até encontrar novos produtos elegíveis.</p></details>
      <details class="faq-item"><summary>O sistema evita produtos repetidos?</summary><p>Sim. Ele compara o anúncio e também a identidade aproximada do produto. Assim, tenta evitar o mesmo item vindo de outra loja, outro anúncio ou pequenas variações de título.</p></details>
      <details class="faq-item"><summary>O que acontece se meus filtros forem muito restritivos?</summary><p>A lista pode demorar mais para atingir o tamanho alvo ou não chegar a ele naquele momento. Você pode continuar atualizando ou flexibilizar comissão, desconto, preço ou estratégia.</p></details>
      <details class="faq-item"><summary>Como uso uma lista em uma automação?</summary><p>Na criação ou edição da automação, selecione a lista no campo <b>Lista fonte</b>. A automação passa a usar aquela estratégia e aqueles filtros como fonte de ofertas.</p></details>
      <details class="faq-item"><summary>O que significa “25 / 50”?</summary><p>O primeiro número é quantos produtos diferentes já foram encontrados e salvos. O segundo é o tamanho alvo definido para a lista. O alvo orienta a busca, mas filtros muito específicos podem exigir novas atualizações.</p></details>
    </div>
  </div>
  <div id="listsGrid" class="list-grid"></div>
</section>'''
once(old_lists, new_lists, 'lists FAQ')

old_settings = '<section class="view" id="view-settings"><div class="integration-grid" id="integrations"></div><div class="section"><div class="card" style="padding:18px"><b>Telegram</b><div id="telegramInfo" class="muted" style="margin:10px 0">Carregando…</div><div class="actions"><input id="telegramThreadTest" type="number" min="1" placeholder="ID do tópico (opcional)" style="border:1px solid var(--line);border-radius:10px;padding:9px"><button class="btn" id="telegramTestBtn">Enviar teste</button></div></div></div><div class="section"><div class="card" style="padding:18px"><b>Sessão administrativa</b><p class="muted">A chave fica somente nesta aba.</p><button class="btn danger" id="logoutBtn">Encerrar sessão</button></div></div></section>'
new_settings = '''<section class="view" id="view-settings"><div class="integration-grid" id="integrations"></div><div class="section"><div class="card telegram-manager"><div class="telegram-manager-head"><div><b>Telegram</b><div id="telegramInfo" class="muted" style="margin-top:7px">Carregando…</div></div><span class="pill green">Tópicos persistentes</span></div><div class="topic-register"><div class="field"><label>Nome do tópico</label><input id="telegramTopicRegistryName" maxlength="120" placeholder="Ex.: Descontos ALTÍSSIMOS"></div><div class="field"><label>ID do tópico</label><input id="telegramTopicRegistryId" type="number" min="1" placeholder="message_thread_id"></div><button class="btn primary" id="telegramTopicAddBtn">+ Cadastrar tópico</button></div><div class="muted topic-help">Cadastre o ID uma vez. Depois o tópico aparecerá automaticamente na criação/edição das automações e no teste do Telegram.</div><div id="telegramTopicsList" class="topic-registry"></div><div class="topic-test"><div class="field"><label>Enviar teste para</label><select id="telegramThreadTest"><option value="">Tópico Geral</option></select></div><button class="btn" id="telegramTestBtn">Enviar teste</button></div></div></div><div class="section"><div class="card" style="padding:18px"><b>Sessão administrativa</b><p class="muted">A chave fica somente nesta aba.</p><button class="btn danger" id="logoutBtn">Encerrar sessão</button></div></div></section>'''
once(old_settings, new_settings, 'settings telegram manager')

css = '''
.list-help{padding:16px;margin:0 0 16px;background:linear-gradient(145deg,rgba(8,18,39,.96),rgba(9,16,34,.9));border-color:#263d6c}.list-help-title{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.faq-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.faq-item{border:1px solid rgba(48,70,119,.68);border-radius:11px;background:rgba(7,15,34,.62);padding:0 11px}.faq-item[open]{border-color:rgba(119,82,255,.58);box-shadow:0 0 22px rgba(102,60,255,.08)}.faq-item summary{cursor:pointer;list-style:none;padding:11px 0;font-weight:800;font-size:11px;color:#e9eeff}.faq-item summary::-webkit-details-marker{display:none}.faq-item summary:after{content:'+';float:right;color:#8e78ff;font-size:16px;line-height:12px}.faq-item[open] summary:after{content:'–'}.faq-item p{margin:0 0 12px;color:#91a0c2;font-size:11px;line-height:1.55}.faq-item b{color:#dcd8ff}.telegram-manager{padding:18px}.telegram-manager-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.topic-register{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(170px,1fr) auto;gap:10px;align-items:end;margin-top:17px}.topic-register .btn{height:40px}.topic-help{margin:9px 0 13px}.topic-registry{display:grid;gap:7px}.topic-registry-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;border:1px solid rgba(45,66,112,.72);border-radius:10px;background:rgba(7,15,34,.62)}.topic-registry-row .topic-name{font-size:12px;font-weight:800;color:#eef3ff}.topic-registry-row .topic-id{font-size:10px;color:#8292b6}.topic-test{display:flex;align-items:end;gap:10px;margin-top:15px;padding-top:14px;border-top:1px solid rgba(45,66,112,.55)}.topic-test .field{min-width:260px}.topic-test select{background:#081127;border:1px solid #293d69;color:#edf2ff;border-radius:10px;padding:10px 11px}@media(max-width:760px){.faq-grid{grid-template-columns:1fr}.topic-register{grid-template-columns:1fr}.topic-test{display:grid;grid-template-columns:1fr}.topic-test .field{min-width:0}}
'''
once('</style></head><body>', css + '</style></head><body>', 'css additions')

old_load = "async function loadTelegram(){try{state.telegram=await api('/api/admin/telegram');var t=state.telegram;document.getElementById('telegramInfo').innerHTML=t.error?'<span class=\"red\">'+esc(t.error)+'</span>':t.configured?'<b>'+esc(t.chatTitle||'Telegram')+'</b> · bot @'+esc(t.botUsername||'—')+' · '+(t.isForum?'grupo com tópicos':'grupo comum'):'Não configurado';var r=(state.data.rules||[]).find(function(x){return x.enabled&&x.settings&&x.settings.telegramThreadId});if(r)document.getElementById('telegramThreadTest').value=r.settings.telegramThreadId}catch(e){document.getElementById('telegramInfo').textContent=e.message}}"
new_load = "function renderTelegramTopics(){var t=state.telegram||{},topics=t.topics||[],list=document.getElementById('telegramTopicsList'),test=document.getElementById('telegramThreadTest');if(list)list.innerHTML=topics.length?topics.map(function(x){return'<div class=\"topic-registry-row\"><div><div class=\"topic-name\">'+esc(x.name)+'</div><div class=\"topic-id\">ID #'+esc(x.id)+(x.stored?' · cadastrado':' · usado em automação')+'</div></div><span class=\"pill '+(x.stored?'green':'purple')+'\">disponível</span></div>'}).join(''):'<div class=\"empty\" style=\"padding:18px\">Nenhum tópico cadastrado ainda. O Tópico Geral continua disponível.</div>';if(test){var current=test.value;test.innerHTML='<option value=\"\">Tópico Geral</option>'+topics.map(function(x){return'<option value=\"'+esc(x.id)+'\">'+esc(x.name)+' · #'+esc(x.id)+'</option>'}).join('');if(current&&Array.from(test.options).some(function(o){return o.value===current}))test.value=current}}async function loadTelegram(){try{state.telegram=await api('/api/admin/telegram');var t=state.telegram;document.getElementById('telegramInfo').innerHTML=t.error?'<span class=\"red\">'+esc(t.error)+'</span>':t.configured?'<b>'+esc(t.chatTitle||'Telegram')+'</b> · bot @'+esc(t.botUsername||'—')+' · '+(t.isForum?'grupo com tópicos':'grupo comum'):'Não configurado';renderTelegramTopics()}catch(e){document.getElementById('telegramInfo').textContent=e.message}}"
once(old_load, new_load, 'load telegram ui')

old_test = "async function telegramTest(){if(!confirm('Enviar uma mensagem técnica real ao Telegram?'))return;var th=document.getElementById('telegramThreadTest').value;try{var out=await api('/api/admin/telegram/test',{method:'POST',body:JSON.stringify({confirm:'SEND_TEST',messageThreadId:th?Number(th):null})});toast('Teste enviado · ID '+(out.externalId||'—'))}catch(e){toast(e.message)}}"
new_test = "async function registerTelegramTopic(){var name=document.getElementById('telegramTopicRegistryName').value.trim(),id=document.getElementById('telegramTopicRegistryId').value;if(!id){toast('Informe o ID do tópico.');return}var btn=document.getElementById('telegramTopicAddBtn');btn.disabled=true;btn.textContent='Cadastrando…';try{await api('/api/admin/telegram/topics',{method:'POST',body:JSON.stringify({name:name,threadId:Number(id)})});document.getElementById('telegramTopicRegistryName').value='';document.getElementById('telegramTopicRegistryId').value='';toast('Tópico cadastrado e disponível nas automações.');await loadTelegram()}catch(e){toast(e.message)}finally{btn.disabled=false;btn.textContent='+ Cadastrar tópico'}}async function telegramTest(){if(!confirm('Enviar uma mensagem técnica real ao Telegram?'))return;var th=document.getElementById('telegramThreadTest').value;try{var out=await api('/api/admin/telegram/test',{method:'POST',body:JSON.stringify({confirm:'SEND_TEST',messageThreadId:th?Number(th):null})});toast('Teste enviado · ID '+(out.externalId||'—'))}catch(e){toast(e.message)}}"
once(old_test, new_test, 'register topic function')

once(
    "document.getElementById('telegramTestBtn').onclick=telegramTest;",
    "document.getElementById('telegramTopicAddBtn').onclick=registerTelegramTopic;document.getElementById('telegramThreadTest').onchange=function(){};document.getElementById('telegramTestBtn').onclick=telegramTest;",
    'topic click wiring',
)

p.write_text(s)
print('patched src/admin.ts')
