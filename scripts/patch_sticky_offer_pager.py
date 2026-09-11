from pathlib import Path

path = Path('src/admin.ts')
text = path.read_text()
old = ".catalog-pager{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin:0 0 14px}.catalog-pager .btn:disabled{opacity:.45;cursor:not-allowed}"
new = ".catalog-pager{display:flex;align-items:center;justify-content:flex-end;gap:10px;position:fixed;right:24px;bottom:24px;z-index:1200;margin:0;padding:9px 10px;border:1px solid rgba(88,111,175,.72);border-radius:14px;background:rgba(7,15,34,.94);box-shadow:0 16px 45px rgba(0,0,0,.42),0 0 24px rgba(111,76,255,.14);backdrop-filter:blur(12px)}.catalog-pager .btn:disabled{opacity:.45;cursor:not-allowed}#view-offers{padding-bottom:92px}@media(max-width:700px){.catalog-pager{left:12px;right:12px;bottom:12px;justify-content:center}.catalog-pager #offerPageLabel{flex:1;text-align:center}#view-offers{padding-bottom:104px}}"
if old not in text:
    raise SystemExit('catalog pager css anchor not found')
if text.count(old) != 1:
    raise SystemExit(f'catalog pager css anchor not unique: {text.count(old)}')
path.write_text(text.replace(old, new, 1))
print('sticky offer pager patch applied')
