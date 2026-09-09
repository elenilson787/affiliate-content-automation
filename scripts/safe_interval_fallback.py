from pathlib import Path
p=Path('src/admin.ts')
s=p.read_text()
s=s.replace('else if (creating) patch.schedule_cron="*/5 * * * *";', 'else if (creating) patch.schedule_cron="0 9-22 * * *";', 1)
s=s.replace("<input id=\"cron\" type=\"hidden\" value=\"*/5 * * * *\">", "<input id=\"cron\" type=\"hidden\" value=\"0 9-22 * * *\">", 1)
s=s.replace("body.schedule_cron='*/5 * * * *';", "body.schedule_cron='0 9-22 * * *';", 1)
s=s.replace("byId('cron').value='*/5 * * * *'", "byId('cron').value='0 9-22 * * *'", 1)
p.write_text(s)
