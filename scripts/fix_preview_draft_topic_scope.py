from pathlib import Path

path = Path('src/admin.ts')
text = path.read_text()
old = "function readAutomationDraftFromForm(){var val=function(id){var e=document.getElementById(id);return e?e.value:''},num=function(id){var v=val(id);return v===''?null:Number(v)},list=document.getElementById('sourceList');var settings={contentTemplate:val('contentTemplate')||'offer',intervalMinutes:Number(val('intervalMinutes'))||60,windowStart:val('windowStart')||'09:00',windowEnd:val('windowEnd')||'22:00',telegramThreadId:currentThread(),telegramTopicName:currentThread()?currentTopicName():null,listId:list&&list.value||null,listName:list&&list.selectedIndex>0?list.options[list.selectedIndex].text.split(' · ')[0]:null};"
new = "function readAutomationDraftFromForm(){var val=function(id){var e=document.getElementById(id);return e?e.value:''},num=function(id){var v=val(id);return v===''?null:Number(v)},list=document.getElementById('sourceList'),topic=document.getElementById('telegramTopic'),thread=topic&&topic.value?Number(topic.value):null,topicName=(function(){if(!topic||!topic.value||topic.selectedIndex<0)return null;var label=topic.options[topic.selectedIndex]?topic.options[topic.selectedIndex].text:'';return label.replace(/\\s*[·-]\\s*#?\\d+\\s*$/,'').trim()||null})();var settings={contentTemplate:val('contentTemplate')||'offer',intervalMinutes:Number(val('intervalMinutes'))||60,windowStart:val('windowStart')||'09:00',windowEnd:val('windowEnd')||'22:00',telegramThreadId:Number.isInteger(thread)&&thread>0?thread:null,telegramTopicName:Number.isInteger(thread)&&thread>0?topicName:null,listId:list&&list.value||null,listName:list&&list.selectedIndex>0?list.options[list.selectedIndex].text.split(' · ')[0]:null};"
if old not in text:
    raise SystemExit('target readAutomationDraftFromForm snippet not found')
text = text.replace(old, new, 1)
path.write_text(text)
print('fixed readAutomationDraftFromForm topic scope')
