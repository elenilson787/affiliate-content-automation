from pathlib import Path
p = Path('scripts/add_first_day_plan.py')
t = p.read_text()
old = 'message:activeDays==null||futureDays>0?'
new = 'message:activeDays==null||(futureDays??0)>0?'
assert old in t, 'type-fix anchor not found'
t = t.replace(old, new, 1)
p.write_text(t)
exec(compile(t, str(p), 'exec'))
