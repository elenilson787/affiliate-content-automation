from pathlib import Path

path = Path('src/admin.ts')
text = path.read_text()
start = text.find('function readAutomationDraftFromForm(){')
if start < 0:
    raise SystemExit('readAutomationDraftFromForm not found')
end = text.find('function collectSmartSettings', start)
if end < 0:
    raise SystemExit('collectSmartSettings marker not found')
block = text[start:end]
old = 'telegramThreadId:currentThread(),telegramTopicName:currentTopicName()'
if old not in block:
    raise SystemExit('currentThread/currentTopicName usage not found in draft reader')
new = '''telegramThreadId:(function(){var e=document.getElementById('telegramTopic');var n=e&&e.value?Number(e.value):null;return Number.isInteger(n)&&n>0?n:null})(),telegramTopicName:(function(){var e=document.getElementById('telegramTopic');if(!e||!e.value||e.selectedIndex<0)return null;var label=e.options[e.selectedIndex]?e.options[e.selectedIndex].text:'';return label.replace(/\\s*[·-]\\s*#?\\d+\\s*$/,'').trim()||null})()'''
block = block.replace(old, new, 1)
text = text[:start] + block + text[end:]
path.write_text(text)
print('fixed preview topic scope')
