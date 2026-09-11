from pathlib import Path

path = Path('src/admin.ts')
text = path.read_text()

old = '''function firstPlanDate(settings: JsonObject, timezone: string) {
  const today=planDateKey(new Date(),timezone); const configured=validDateKey(settings.activeStartDate); let key=configured&&configured>today?configured:today;
  const end=validDateKey(settings.activeEndDate); const allowed=planWeekdays(settings);
  for(let guard=0;guard<3700;guard+=1){ if(end&&key>end)return null; if(allowed.includes(dateKeyWeekday(key)))return key; key=shiftDateKey(key,1); }
  return null;
}
'''
new = old + '''function nextPlanDateAfter(settings: JsonObject, afterDate: string) {
  const end=validDateKey(settings.activeEndDate); const allowed=planWeekdays(settings); let key=shiftDateKey(afterDate,1);
  for(let guard=0;guard<3700;guard+=1){ if(end&&key>end)return null; if(allowed.includes(dateKeyWeekday(key)))return key; key=shiftDateKey(key,1); }
  return null;
}
'''
assert old in text, 'firstPlanDate anchor not found'
text = text.replace(old, new, 1)

old = '''  const dateKey=firstPlanDate(settings,timezone); if(!dateKey)return json({error:"Nenhum dia ativo disponível dentro do período selecionado."},422);
  const allSlots=planSlots(dateKey,settings,timezone); const MAX_PREVIEW_SLOTS=180; const slots=allSlots.slice(0,MAX_PREVIEW_SLOTS); const truncated=allSlots.length>slots.length;
'''
new = '''  const now=new Date(); const todayKey=planDateKey(now,timezone); const initialDateKey=firstPlanDate(settings,timezone); if(!initialDateKey)return json({error:"Nenhum dia ativo disponível dentro do período selecionado."},422);
  let dateKey=initialDateKey; let fullDaySlots=planSlots(dateKey,settings,timezone); let allSlots=dateKey===todayKey?fullDaySlots.filter((slot)=>slot.date.getTime()>=now.getTime()):fullDaySlots;
  let skippedPastSlots=Math.max(0,fullDaySlots.length-allSlots.length); let rolledToNextDay=false;
  if(dateKey===todayKey&&allSlots.length===0){
    const nextDate=nextPlanDateAfter(settings,dateKey);
    if(!nextDate)return json({error:"A janela de publicação de hoje já terminou e não há outro dia ativo disponível no período selecionado."},422);
    dateKey=nextDate; fullDaySlots=planSlots(dateKey,settings,timezone); allSlots=fullDaySlots; rolledToNextDay=true;
  }
  const adjustedForCurrentTime=initialDateKey===todayKey&&skippedPastSlots>0&&!rolledToNextDay;
  const currentLocalTime=new Intl.DateTimeFormat("pt-BR",{timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now);
  const MAX_PREVIEW_SLOTS=180; const slots=allSlots.slice(0,MAX_PREVIEW_SLOTS); const truncated=allSlots.length>slots.length;
'''
assert old in text, 'plan preview slot anchor not found'
text = text.replace(old, new, 1)

old = '''  return json({dryRun:true,firstDay:dateKey,totalSlots:allSlots.length,previewedSlots:slots.length,filled,missing:Math.max(0,allSlots.length-filled),coverage:allSlots.length?Math.round((filled/allSlots.length)*1000)/10:0,truncated,scanned,pages,continuous:activeDays==null,activeDays,futureDays,revalidateBeforePublish:true,slots:output,message:activeDays==null||(futureDays??0)>0?"Somente o primeiro dia é planejado agora. Nos próximos dias, novos produtos serão buscados automaticamente quando cada novo ciclo diário começar e serão revalidados perto de cada horário.":"A agenda abaixo cobre o único dia ativo selecionado."});
'''
new = '''  return json({dryRun:true,firstDay:dateKey,totalSlots:allSlots.length,fullDaySlots:fullDaySlots.length,previewedSlots:slots.length,filled,missing:Math.max(0,allSlots.length-filled),coverage:allSlots.length?Math.round((filled/allSlots.length)*1000)/10:0,truncated,scanned,pages,continuous:activeDays==null,activeDays,futureDays,revalidateBeforePublish:true,adjustedForCurrentTime,rolledToNextDay,skippedPastSlots,currentLocalTime,firstScheduledTime:output[0]?.time||null,slots:output,message:activeDays==null||(futureDays??0)>0?"Somente o primeiro dia é planejado agora. Nos próximos dias, novos produtos serão buscados automaticamente quando cada novo ciclo diário começar e serão revalidados perto de cada horário.":"A agenda abaixo cobre o único dia ativo selecionado."});
'''
assert old in text, 'response anchor not found'
text = text.replace(old, new, 1)

old = "var future=(res.continuous||Number(res.futureDays||0)>0)?'<div class=\"day-plan-note\">🔄 '+sEsc(res.message||'Os produtos dos próximos dias serão buscados automaticamente no novo ciclo diário.')+'</div>':'';var trunc="
new = "var currentNote=res.rolledToNextDay?'<div class=\"day-plan-note\">🕒 A janela de hoje já terminou. O planejamento foi movido para o próximo dia ativo e volta a usar a agenda diária completa.</div>':res.adjustedForCurrentTime?'<div class=\"day-plan-note\">🕒 Como o primeiro dia é hoje e agora são '+sEsc(res.currentLocalTime)+', '+sEsc(res.skippedPastSlots)+' horário(s) que já passaram foram ignorados. A agenda começa em '+sEsc(res.firstScheduledTime||'próximo horário')+'. Nos próximos dias, a grade volta ao horário inicial configurado.</div>':'';var future=(res.continuous||Number(res.futureDays||0)>0)?'<div class=\"day-plan-note\">🔄 '+sEsc(res.message||'Os produtos dos próximos dias serão buscados automaticamente no novo ciclo diário.')+'</div>':'';var trunc="
assert old in text, 'render note anchor not found'
text = text.replace(old, new, 1)

old = "+status+'</div><div class=\"day-plan-list\">'+rows+'</div>'+future+trunc+"
new = "+status+'</div>'+currentNote+'<div class=\"day-plan-list\">'+rows+'</div>'+future+trunc+"
assert old in text, 'render insertion anchor not found'
text = text.replace(old, new, 1)

path.write_text(text)
print('current-day planning patch applied')
