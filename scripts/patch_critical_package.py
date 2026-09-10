from pathlib import Path

admin_path = Path('src/admin.ts')
text = admin_path.read_text(encoding='utf-8')

# 1) Backend: não permita flexibilização sem meta e garanta piso seguro.
old = '''    patch.settings = { ...currentSettings, ...(input.settings as JsonObject), searchScope: "all" };
'''
new = '''    patch.settings = { ...currentSettings, ...(input.settings as JsonObject), searchScope: "all" };
    const nextSettings = patch.settings as JsonObject;
    if (Boolean(nextSettings.flexCommissionEnabled)) {
      const target = Number(patch.min_commission);
      if (!Number.isFinite(target) || target <= 0) {
        throw new Error("Informe uma comissão desejada maior que 0% antes de ativar a flexibilização.");
      }
      const step = Number(nextSettings.flexCommissionStep || 5);
      if (![5, 10].includes(step)) throw new Error("A redução da comissão deve ser de 5 ou 10 pontos percentuais.");
      const rawFloor = Number(nextSettings.flexCommissionFloor);
      const suggestedFloor = Math.max(1, Math.round(target * 0.6 * 10) / 10);
      const floor = Number.isFinite(rawFloor) && rawFloor > 0 ? rawFloor : suggestedFloor;
      if (floor > target) throw new Error("A comissão mínima absoluta não pode ser maior que a comissão desejada.");
      nextSettings.flexCommissionStep = step;
      nextSettings.flexCommissionFloor = Math.round(floor * 10) / 10;
    }
'''
assert old in text, 'backend settings anchor not found'
text = text.replace(old, new, 1)

# 2) Dashboard: somente agendas realmente ativas entram no planejamento do dia.
old = "function todayPlanned(r){if(stateOf(r)==='ended'||stateOf(r)==='scheduled')return 0;return localDateAllows(r,new Date())?capacity(r.settings||{}):0}"
new = "function todayPlanned(r){if(stateOf(r)!=='active')return 0;return localDateAllows(r,new Date())?capacity(r.settings||{}):0}"
assert old in text, 'todayPlanned anchor not found'
text = text.replace(old, new, 1)

start = text.index('function renderSmartDashboard(){')
end = text.index('function renderSmartAutomations()', start)
new_dashboard = r'''function renderSmartDashboard(){var root=document.getElementById('commercialDashboard');if(!root||!SMART.data)return;var rules=SMART.data.rules||[],counts={active:0,paused:0,scheduled:0,ended:0,problem:0};rules.forEach(function(r){counts[stateOf(r)]++});var todayKey=localKey(new Date()).key,published=(SMART.data.queue||[]).filter(function(q){return q.status==='published'&&q.published_at&&localKey(new Date(q.published_at)).key===todayKey}).length,activeRules=rules.filter(function(r){return stateOf(r)==='active'}),remaining=activeRules.reduce(function(n,r){return n+Math.max(0,todayPlanned(r)-todayPublishedFor(r))},0),nexts=activeRules.map(function(r){return{r:r,d:nextSlot(r,new Date())}}).filter(function(x){return x.d}).sort(function(a,b){return a.d-b.d}),next=nexts[0],alerts=(SMART.data.metrics&&SMART.data.metrics.failed24h||0)+counts.problem;var agenda=[];activeRules.forEach(function(r){var cursor=new Date();for(var i=0;i<3;i++){var d=nextSlot(r,cursor);if(!d)break;agenda.push({r:r,d:d});cursor=new Date(d.getTime()+intv(r.settings||{})*60000)}});agenda.sort(function(a,b){return a.d-b.d});var alertHtml=alerts?'<div class="smart-alert"><b>⚠ Atenção necessária</b><span>'+alerts+' falha(s) ou automação(ões) com problema nas últimas 24h.</span></div>':'';root.innerHTML='<div class="smart-metrics"><div class="smart-metric"><small>AUTOMAÇÕES</small><strong>'+counts.active+' ativas</strong><div class="detail">'+counts.paused+' pausada(s) · '+counts.scheduled+' programada(s) · '+counts.ended+' encerrada(s)</div></div><div class="smart-metric"><small>PUBLICADAS HOJE</small><strong>'+published+'</strong><div class="detail">publicações confirmadas hoje</div></div><div class="smart-metric"><small>RESTANTES HOJE</small><strong>'+remaining+'</strong><div class="detail">horários ainda previstos nas automações ativas</div></div><div class="smart-metric"><small>PRÓXIMA PUBLICAÇÃO</small><strong>'+(next?sFmt(next.d,true):'—')+'</strong><div class="detail">'+(next?sEsc(next.r.name+' · '+sourceText(next.r)):'Nenhuma publicação programada')+'</div></div></div>'+alertHtml+'<div class="smart-section"><div class="smart-section-head"><h3>Próximas publicações</h3><button class="btn small" data-smart-open-activity>Ver agenda completa</button></div><div class="smart-agenda">'+(agenda.length?agenda.slice(0,6).map(function(x){return'<div class="agenda-row"><div class="agenda-time">'+sFmt(x.d,true)+'</div><div><div class="agenda-title">'+sEsc(sourceText(x.r))+'</div><div class="agenda-sub">'+sEsc(x.r.name)+' · aguardando seleção da melhor oferta</div></div>'+stateBadge('scheduled')+'</div>'}).join(''):'<div class="empty">Nenhuma publicação prevista.</div>')+'</div></div><div class="smart-section"><div class="smart-section-head"><h3>Automações</h3></div><div class="smart-rule-list">'+(rules.length?rules.slice(0,6).map(ruleHtml).join(''):'<div class="empty">Nenhuma automação criada.</div>')+'</div></div>'}
'''
text = text[:start] + new_dashboard + text[end:]

# 3) Flexibilização: piso não parte mais de 0 e a UI depende de uma meta válida.
text = text.replace('id="flexCommissionFloor" type="number" min="0" max="100" step="0.1"', 'id="flexCommissionFloor" type="number" min="1" max="100" step="0.1"', 1)

start = text.index('function bindSmartForm(){')
end = text.index('function updateSourceFields()', start)
new_bind = r'''function suggestedCommissionFloor(target){return Math.max(1,Math.round(target*0.6*10)/10)}
function updateFlexUI(){var mc=document.getElementById('minCommission'),toggle=document.getElementById('flexCommissionEnabled'),fields=document.getElementById('flexFields'),floor=document.getElementById('flexCommissionFloor'),step=document.getElementById('flexCommissionStep');if(!toggle||!fields)return;var target=Number(mc&&mc.value),hasTarget=Number.isFinite(target)&&target>0;if(!hasTarget)toggle.checked=false;toggle.disabled=!hasTarget;var enabled=hasTarget&&toggle.checked;if(floor&&!floor.dataset.touched){floor.value=hasTarget?String(suggestedCommissionFloor(target)):''}if(floor)floor.disabled=!enabled;if(step)step.disabled=!enabled;fields.style.opacity=enabled?'1':'.48';var block=toggle.closest('.smart-form-block'),help=block&&block.querySelector('.muted');if(help)help.textContent=!hasTarget?'Informe primeiro uma comissão desejada para liberar a flexibilização.':enabled?('O sistema começa em '+target+'% e reduz gradualmente até '+(floor&&floor.value?floor.value:suggestedCommissionFloor(target))+'%. Cada nova vaga volta à meta original.'):'Ative esta opção somente se quiser permitir uma comissão menor quando não houver oferta suficiente na meta.'}
function bindSmartForm(){if(document.body.dataset.smartFormBound==='1')return;document.body.dataset.smartFormBound='1';document.addEventListener('change',function(e){var t=e.target;if(!t)return;var id=t.id||'';if(id==='sourceMode')updateSourceFields();if(['activeStartDate','activeEndDate','intervalMinutes','windowStart','windowEnd'].indexOf(id)>=0||t.hasAttribute('data-weekday'))updateCapacity();if(id==='flexCommissionEnabled'||id==='minCommission')updateFlexUI();if(t.hasAttribute('data-mix-check')){var w=document.querySelector('[data-mix-weight="'+t.dataset.mixCheck+'"]');if(w)w.disabled=!t.checked}});document.addEventListener('input',function(e){var t=e.target;if(!t)return;if(t.id==='minCommission'){var floor=document.getElementById('flexCommissionFloor');if(floor&&!floor.dataset.touched){var n=Number(t.value);floor.value=Number.isFinite(n)&&n>0?String(suggestedCommissionFloor(n)):''}updateFlexUI()}if(t.id==='flexCommissionFloor')t.dataset.touched='1'});updateFlexUI()}
'''
text = text[:start] + new_bind + text[end:]

# 4) Capacidade: recalcule sempre pelos valores atuais e mostre o resumo após a agenda.
start = text.index('function updateCapacity(){')
end = text.index('function hydrateSmartForm(', start)
new_capacity = r'''function updateCapacity(){var box=document.getElementById('capacityBox');if(!box)return;var start=document.getElementById('activeStartDate')?.value||smartDateToday(),end=document.getElementById('activeEndDate')?.value||'',rawInterval=Number(document.getElementById('intervalMinutes')?.value),i=Number.isFinite(rawInterval)&&rawInterval>0?rawInterval:60,a=minutes(document.getElementById('windowStart')?.value,'09:00'),b=minutes(document.getElementById('windowEnd')?.value,'22:00'),span=a<=b?b-a:1440-a+b,per=Math.floor(span/i)+1,checked=Array.from(document.querySelectorAll('[data-weekday]:checked'));if(!checked.length){box.innerHTML='<b>Selecione ao menos um dia da semana.</b>';return}if(end&&end<start){box.innerHTML='<b>Data final anterior à data inicial.</b>';return}var total=null;if(end){var d=new Date(start+'T00:00:00Z'),e=new Date(end+'T00:00:00Z'),active=0,allowed=checked.map(function(x){return Number(x.dataset.weekday)});for(var guard=0;d<=e&&guard<3700;guard++){if(allowed.indexOf(d.getUTCDay())>=0)active++;d=new Date(d.getTime()+86400000)}total=active*per}var intervalLabel=i<60?i+' min':i===60?'1 hora':i%60===0?(i/60)+' horas':Math.floor(i/60)+'h'+String(i%60).padStart(2,'0');box.innerHTML='<b>'+per+' publicações por dia ativo</b><div>'+((document.getElementById('windowStart')?.value||'09:00')+' → '+(document.getElementById('windowEnd')?.value||'22:00')+' · intervalo '+intervalLabel)+'. '+(total==null?'A automação continua enquanto estiver ativa.':total+' horários no período selecionado.')+' O produto é buscado perto de cada horário.</div>'}
function smartSection(id,title,description){var grid=document.querySelector('#ruleForm .form-grid'),section=document.getElementById(id);if(!grid)return null;if(!section){section=document.createElement('div');section.id=id;section.className='field full form-section-v2';section.innerHTML='<div class="form-section-v2-head"><h4>'+title+'</h4><span>'+description+'</span></div><div class="form-section-v2-grid"></div>';grid.appendChild(section)}return section.querySelector('.form-section-v2-grid')}
function moveSmartNode(target,node){if(target&&node&&!target.contains(node))target.appendChild(node)}
function organizeSmartForm(){var form=document.getElementById('ruleForm'),grid=form&&form.querySelector('.form-grid');if(!grid)return;var identity=smartSection('formIdentity','1 · Identificação','Dê um nome claro para reconhecer a automação.'),source=smartSection('formSource','2 · Fonte dos produtos','Escolha de onde virão as ofertas.'),quality=smartSection('formQuality','3 · Critérios das ofertas','Defina qualidade, comissão, desconto e repetição.'),agenda=smartSection('formAgenda','4 · Agenda','Defina período, dias, janela e frequência.'),destination=smartSection('formDestination','5 · Destino','Escolha onde a publicação será enviada.'),content=smartSection('formContent','6 · Conteúdo','Escolha o formato da mensagem e confira a prévia.'),execution=smartSection('formExecution','7 · Execução','Defina se ficará ativa e se está em modo de teste.');var field=function(id){var e=document.getElementById(id);return e&&e.closest('.field')};moveSmartNode(identity,field('name'));moveSmartNode(identity,field('description'));var sourceBlock=document.getElementById('sourceMode')?.closest('.smart-form-block');moveSmartNode(source,sourceBlock);moveSmartNode(source,field('sourceList'));moveSmartNode(quality,field('repeatDays'));moveSmartNode(quality,field('minCommission'));moveSmartNode(quality,field('minDiscount'));moveSmartNode(quality,field('maxPrice'));moveSmartNode(quality,field('sort'));moveSmartNode(quality,document.getElementById('flexCommissionEnabled')?.closest('.smart-form-block'));var dateBlock=document.getElementById('activeStartDate')?.closest('.smart-form-block');moveSmartNode(agenda,dateBlock);moveSmartNode(agenda,field('intervalMinutes'));var cap=document.getElementById('capacityBox');if(cap)moveSmartNode(agenda,cap);moveSmartNode(destination,field('telegramTopic')||field('threadId'));var tz=field('timezone');if(tz){var label=tz.querySelector('label');if(label)label.textContent='Fuso horário';moveSmartNode(destination,tz)}moveSmartNode(content,field('contentTemplate'));moveSmartNode(content,document.getElementById('livePreviewCard')?.closest('.field'));moveSmartNode(execution,field('enabled'));[sourceBlock,dateBlock].forEach(function(block){var title=block&&block.querySelector('.smart-form-title');if(title)title.style.display='none'});var scheduleField=field('intervalMinutes');if(scheduleField){var helper=scheduleField.querySelector('small.muted');if(helper)helper.textContent='A plataforma acompanha automaticamente a agenda e publica quando chegar cada horário configurado.'}updateCapacity();updateFlexUI()}
'''
text = text[:start] + new_capacity + text[end:]

# Hidratação: use piso sugerido de 60% da meta e reordene depois de todos os enhancements.
start = text.index('function hydrateSmartForm(')
end = text.index('function collectSmartSettings(', start)
new_hydrate = r'''function hydrateSmartForm(ruleId){ensureSmartForm();var r=ruleId&&SMART.data?(SMART.data.rules||[]).find(function(x){return x.id===ruleId}):null,s=r&&r.settings||{},target=Number(r&&r.min_commission);var start=document.getElementById('activeStartDate');if(start)start.value=s.activeStartDate||smartDateToday();var end=document.getElementById('activeEndDate');if(end)end.value=s.activeEndDate||'';var mode=document.getElementById('sourceMode');if(mode)mode.value=s.sourceMode||((s.listId)?'list':'all');var niche=document.getElementById('sourceNiche');if(niche)niche.value=s.niche||'casa_cozinha';document.querySelectorAll('[data-weekday]').forEach(function(e){e.checked=!Array.isArray(s.activeWeekdays)||s.activeWeekdays.length===0||s.activeWeekdays.map(Number).indexOf(Number(e.dataset.weekday))>=0});document.querySelectorAll('[data-mix-check]').forEach(function(e){var found=Array.isArray(s.nicheMix)?s.nicheMix.find(function(x){return x.niche===e.dataset.mixCheck}):null;e.checked=!!found;var w=document.querySelector('[data-mix-weight="'+e.dataset.mixCheck+'"]');if(w){w.disabled=!found;w.value=found?String(found.weight||20):'20'}});var fe=document.getElementById('flexCommissionEnabled');if(fe)fe.checked=!!s.flexCommissionEnabled&&Number.isFinite(target)&&target>0;var fs=document.getElementById('flexCommissionStep');if(fs)fs.value=String([5,10].includes(Number(s.flexCommissionStep))?Number(s.flexCommissionStep):5);var ff=document.getElementById('flexCommissionFloor');if(ff){ff.value=s.flexCommissionFloor!=null&&Number(s.flexCommissionFloor)>0?String(s.flexCommissionFloor):(Number.isFinite(target)&&target>0?String(suggestedCommissionFloor(target)):'');ff.dataset.touched=s.flexCommissionFloor!=null&&Number(s.flexCommissionFloor)>0?'1':''}updateSourceFields();organizeSmartForm();updateFlexUI();updateCapacity();setTimeout(function(){organizeSmartForm();updateFlexUI();updateCapacity()},260)}
'''
text = text[:start] + new_hydrate + text[end:]

# Payload: nunca grave piso 0 nem flex habilitado sem meta.
start = text.index('function collectSmartSettings(')
end = text.index('async function smartRefresh()', start)
new_collect = r'''function collectSmartSettings(body){ensureSmartForm();body.quantity=1;body.settings=Object.assign({},body.settings||{});var s=body.settings;s.scheduleMode='slots';s.activeStartDate=document.getElementById('activeStartDate')?.value||smartDateToday();s.activeEndDate=document.getElementById('activeEndDate')?.value||null;s.activeWeekdays=Array.from(document.querySelectorAll('[data-weekday]:checked')).map(function(e){return Number(e.dataset.weekday)});s.sourceMode=document.getElementById('sourceMode')?.value||'all';s.niche=s.sourceMode==='niche'?(document.getElementById('sourceNiche')?.value||null):null;s.nicheMix=s.sourceMode==='mix'?Array.from(document.querySelectorAll('[data-mix-check]:checked')).map(function(e){return{niche:e.dataset.mixCheck,weight:Number(document.querySelector('[data-mix-weight="'+e.dataset.mixCheck+'"]')?.value)||20}}):[];if(s.sourceMode!=='list'){s.listId=null;s.listName=null;var sl=document.getElementById('sourceList');if(sl)sl.value=''}var target=Number(body.min_commission);s.flexCommissionEnabled=Number.isFinite(target)&&target>0&&!!document.getElementById('flexCommissionEnabled')?.checked;s.flexCommissionStep=[5,10].includes(Number(document.getElementById('flexCommissionStep')?.value))?Number(document.getElementById('flexCommissionStep')?.value):5;if(s.flexCommissionEnabled){var floor=Number(document.getElementById('flexCommissionFloor')?.value);if(!Number.isFinite(floor)||floor<=0)floor=suggestedCommissionFloor(target);s.flexCommissionFloor=Math.min(target,Math.max(1,floor))}else{s.flexCommissionFloor=null}return body}
'''
text = text[:start] + new_collect + text[end:]

# Setup passa a organizar o modal imediatamente.
old = "ensureSmartForm()}\nvar previousFetch="
new = "ensureSmartForm();organizeSmartForm();updateFlexUI();updateCapacity()}\nvar previousFetch="
assert old in text, 'setupLayout tail not found'
text = text.replace(old, new, 1)

# Recalcule também em input, não apenas change (evita contador visual stale).
old = "document.addEventListener('change',function(e){if(['intervalMinutes','windowStart','windowEnd','activeStartDate','activeEndDate','sourceMode'].indexOf(e.target.id)>=0||e.target.hasAttribute('data-weekday'))updateCapacity()});"
new = "document.addEventListener('change',function(e){if(['intervalMinutes','windowStart','windowEnd','activeStartDate','activeEndDate','sourceMode'].indexOf(e.target.id)>=0||e.target.hasAttribute('data-weekday'))updateCapacity();if(e.target.id==='minCommission'||e.target.id==='flexCommissionEnabled')updateFlexUI()});document.addEventListener('input',function(e){if(['intervalMinutes','windowStart','windowEnd'].indexOf(e.target.id)>=0)updateCapacity()});"
assert old in text, 'delegated capacity listener not found'
text = text.replace(old, new, 1)

# CSS da nova organização do formulário e alerta do dashboard.
css = r'''
<style id="criticalPackageStyles">
.form-section-v2{border:1px solid rgba(105,91,255,.24);border-radius:14px;padding:13px;background:linear-gradient(180deg,rgba(12,24,48,.82),rgba(7,16,34,.74));margin:3px 0 8px}.form-section-v2-head{display:flex;gap:8px;align-items:baseline;justify-content:space-between;margin-bottom:10px}.form-section-v2-head h4{margin:0;font-size:12px;color:#f3f6ff}.form-section-v2-head span{font-size:9px;color:#7f8eae}.form-section-v2-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.form-section-v2-grid>.full,.form-section-v2-grid>.smart-form-block,.form-section-v2-grid>.capacity-box{grid-column:1/-1}.form-section-v2 .smart-form-block{margin:0;background:rgba(5,13,29,.34)}#flexCommissionEnabled:disabled{cursor:not-allowed;opacity:.45}.smart-alert{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid rgba(245,183,63,.35);background:rgba(245,183,63,.08);border-radius:12px;padding:10px 12px;margin:10px 0;color:#f5cf7b}.smart-alert span{font-size:10px;color:#c8b98e}.capacity-box{margin-top:2px!important}@media(max-width:760px){.form-section-v2-grid{grid-template-columns:1fr}.form-section-v2-grid>.field{grid-column:1}.form-section-v2-head{align-items:flex-start;flex-direction:column}}
</style>
'''
assert '</head>' in text
text = text.replace('</head>', css + '</head>', 1)

admin_path.write_text(text, encoding='utf-8')

# 5) Motor: se uma configuração antiga vier sem piso, use 60% da meta em vez de cair a zero ou não flexibilizar.
policy_path = Path('src/rule-policy.ts')
policy = policy_path.read_text(encoding='utf-8')
old = '''  const configuredFloor = Number(settings.flexCommissionFloor);
  const floor = enabled && Number.isFinite(configuredFloor)
    ? Math.max(0, Math.min(desired, configuredFloor))
    : desired;
'''
new = '''  const configuredFloor = Number(settings.flexCommissionFloor);
  const suggestedFloor = desired > 0 ? Math.max(1, Math.round(desired * 0.6 * 100) / 100) : 0;
  const floor = enabled
    ? (Number.isFinite(configuredFloor) && configuredFloor > 0
      ? Math.max(1, Math.min(desired, configuredFloor))
      : suggestedFloor)
    : desired;
'''
assert old in policy, 'commissionPlan floor anchor not found'
policy = policy.replace(old, new, 1)
policy_path.write_text(policy, encoding='utf-8')

# Sanity checks do pacote.
final = admin_path.read_text(encoding='utf-8')
assert "PUBLICADAS HOJE" in final
assert "RESTANTES HOJE" in final
assert "form-section-v2" in final
assert "Informe primeiro uma comissão desejada" in final
assert "function todayPlanned(r){if(stateOf(r)!=='active')" in final
print('critical package applied')
