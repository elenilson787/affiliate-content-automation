from pathlib import Path
import re

path = Path('src/admin.ts')
text = path.read_text()
start = text.find('async function refreshInlinePreview(){')
if start < 0:
    raise SystemExit('refreshInlinePreview not found')
match = re.search(r'\n\s*(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(', text[start + 10:])
end = start + 10 + match.start() if match else min(len(text), start + 12000)
block = text[start:end]

thread_call = "currentThread()"
topic_call = "currentTopicName()"
if thread_call not in block and topic_call not in block:
    raise SystemExit('currentThread/currentTopicName calls not found in refreshInlinePreview')

safe_thread = "(function(){var e=document.getElementById('telegramTopic');var n=e&&e.value?Number(e.value):null;return Number.isInteger(n)&&n>0?n:null})()"
safe_topic = "(function(){var e=document.getElementById('telegramTopic');if(!e||!e.value||e.selectedIndex<0)return null;var label=e.options[e.selectedIndex]?e.options[e.selectedIndex].text:'';return label.replace(/\\s*[·-]\\s*#?\\d+\\s*$/,'').trim()||null})()"
block = block.replace(thread_call, safe_thread)
block = block.replace(topic_call, safe_topic)
text = text[:start] + block + text[end:]
path.write_text(text)
print('fixed currentThread/currentTopicName calls inside refreshInlinePreview')
