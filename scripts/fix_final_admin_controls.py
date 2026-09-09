from pathlib import Path

path = Path('src/admin.ts')
text = path.read_text(encoding='utf-8')

old = "function enrichRequest(input,init){var url=typeof input==='string'?input:(input&&input.url)||'';if(!init||!init.body||!/^\\/api\\/admin\\/rules(?:\\/[0-9a-f-]{36})?$/i.test(url))return init;try{var body=JSON.parse(String(init.body));body.schedule_cron='0 9-22 * * *';body.settings=Object.assign({},body.settings||{},{intervalMinutes:Number(byId('intervalMinutes')&&byId('intervalMinutes').value)||60,windowStart:(byId('windowStart')&&byId('windowStart').value)||'09:00',windowEnd:(byId('windowEnd')&&byId('windowEnd').value)||'22:00',telegramThreadId:currentThread(),telegramTopicName:currentThread()?currentTopicName():null,listId:(byId('sourceList')&&byId('sourceList').value)||null,listName:(byId('sourceList')&&byId('sourceList').selectedIndex>0?byId('sourceList').options[byId('sourceList').selectedIndex].text.split(' · ')[0]:null)});return Object.assign({},init,{body:JSON.stringify(body)})}catch(e){return init}}"
new = "function enrichRequest(input,init){var url=typeof input==='string'?input:(input&&input.url)||'';if(!init||!init.body||!/^\\/api\\/admin\\/rules(?:\\/[0-9a-f-]{36})?$/i.test(url))return init;try{var body=JSON.parse(String(init.body));var full=body.name!==undefined||body.settings!==undefined||body.min_commission!==undefined||body.min_discount!==undefined||body.max_price!==undefined||body.sort!==undefined||body.schedule_cron!==undefined;if(!full)return init;body.schedule_cron='0 9-22 * * *';body.settings=Object.assign({},body.settings||{},{intervalMinutes:Number(byId('intervalMinutes')&&byId('intervalMinutes').value)||60,windowStart:(byId('windowStart')&&byId('windowStart').value)||'09:00',windowEnd:(byId('windowEnd')&&byId('windowEnd').value)||'22:00',telegramThreadId:currentThread(),telegramTopicName:currentThread()?currentTopicName():null,listId:(byId('sourceList')&&byId('sourceList').value)||null,listName:(byId('sourceList')&&byId('sourceList').selectedIndex>0?byId('sourceList').options[byId('sourceList').selectedIndex].text.split(' · ')[0]:null)});return Object.assign({},init,{body:JSON.stringify(body)})}catch(e){return init}}"
assert old in text, 'legacy enrichRequest not found'
text = text.replace(old, new)

old2 = "if(init&&init.body&&/^\\/api\\/admin\\/rules(?:\\/[0-9a-f-]{36})?$/i.test(url)){try{var body=JSON.parse(String(init.body));body=collectSmartSettings(body);init=Object.assign({},init,{body:JSON.stringify(body)})}catch(e){console.warn('smart payload',e)}}"
new2 = "if(init&&init.body&&/^\\/api\\/admin\\/rules(?:\\/[0-9a-f-]{36})?$/i.test(url)){try{var body=JSON.parse(String(init.body));var full=body.name!==undefined||body.settings!==undefined||body.min_commission!==undefined||body.min_discount!==undefined||body.max_price!==undefined||body.sort!==undefined||body.schedule_cron!==undefined;if(full){body=collectSmartSettings(body);init=Object.assign({},init,{body:JSON.stringify(body)})}}catch(e){console.warn('smart payload',e)}}"
assert old2 in text, 'smart fetch wrapper not found'
text = text.replace(old2, new2)

text = text.replace("'+(r.enabled?'Pausar':'Ativar')+'", "'+(r.enabled?'Pausar':'Retomar')+'")
text = text.replace("toast(r.enabled?'Automação pausada.':'Automação ativada.');", "toast(r.enabled?'Automação pausada.':'Automação retomada.');")

path.write_text(text, encoding='utf-8')
