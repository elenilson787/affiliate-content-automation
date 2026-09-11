from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'anchor not found: {label}')
    if text.count(old) != 1:
        raise SystemExit(f'anchor not unique ({text.count(old)}): {label}')
    return text.replace(old, new, 1)

# 1) Allow the shared production search engine to start from deeper result pages
# without changing any existing caller behavior.
automation_path = Path('src/automation.ts')
automation = automation_path.read_text()

automation = replace_once(
    automation,
    '''export async function searchOffersForRule(\n  db: SupabaseRest,\n  env: Env,\n  rule: AutomationRuleRow,\n  targetQuantity = rule.quantity,\n  excludeOffer?: (offer: Offer) => boolean,\n  slot = new Date(),\n) {''',
    '''export async function searchOffersForRule(\n  db: SupabaseRest,\n  env: Env,\n  rule: AutomationRuleRow,\n  targetQuantity = rule.quantity,\n  excludeOffer?: (offer: Offer) => boolean,\n  slot = new Date(),\n  searchTuning: { pageStart?: number; maxRequests?: number; maxPages?: number } = {},\n) {''',
    'searchOffersForRule signature',
)

automation = replace_once(
    automation,
    '''        { maxPages: 2, pageSize: 50, maxRequests: 8, searchScope: scope, excludeOffer },''',
    '''        {\n          maxPages: searchTuning.maxPages ?? 2,\n          pageSize: 50,\n          maxRequests: searchTuning.maxRequests ?? 8,\n          pageStart: searchTuning.pageStart ?? 1,\n          searchScope: scope,\n          excludeOffer,\n        },''',
    'primary search options',
)

automation = replace_once(
    automation,
    '''          { maxPages: 3, pageSize: 50, maxRequests: 10, searchScope: scope, excludeOffer },''',
    '''          {\n            maxPages: Math.max(searchTuning.maxPages ?? 3, 3),\n            pageSize: 50,\n            maxRequests: Math.max(searchTuning.maxRequests ?? 10, 10),\n            pageStart: searchTuning.pageStart ?? 1,\n            searchScope: scope,\n            excludeOffer,\n          },''',
    'fallback search options',
)

automation_path.write_text(automation)

# 2) Make first-day planning progressively search deeper pages while there are
# still empty slots. It is bounded and stops after two rounds without progress.
admin_path = Path('src/admin.ts')
admin = admin_path.read_text()

old_fill = '''  type Assignment={offer:Offer;commissionResolved:number|null;sourceNiche:string|null;scanned:number;pages:number}; const assignments=new Map<number,Assignment>(); let scanned=0,pages=0;\n  const fill=async(group:typeof slots,slotDate:Date)=>{ if(!group.length)return; const result=await searchOffersForRule(db,env,rule,group.length,excluded,slotDate); scanned+=result.scanned; pages+=result.pages; result.selected.forEach((offer,index)=>{ const target=group[index]; if(!target)return; planned.push(offer); assignments.set(target.index,{offer,commissionResolved:result.commissionResolved,sourceNiche:result.sourceNiche,scanned:result.scanned,pages:result.pages}); }); };'''

new_fill = '''  type Assignment={offer:Offer;commissionResolved:number|null;sourceNiche:string|null;scanned:number;pages:number}; const assignments=new Map<number,Assignment>(); let scanned=0,pages=0;\n  const MAX_PROGRESSIVE_ROUNDS=6; const PAGE_STRIDE=2; let progressiveRounds=0; let progressiveSearchExhausted=false;\n  const fill=async(group:typeof slots,slotDate:Date)=>{\n    if(!group.length)return;\n    let remaining=group.filter((slot)=>!assignments.has(slot.index));\n    let stalledRounds=0;\n    for(let round=0;round<MAX_PROGRESSIVE_ROUNDS&&remaining.length;round+=1){\n      const before=assignments.size;\n      const pageStart=1+round*PAGE_STRIDE;\n      const result=await searchOffersForRule(db,env,rule,remaining.length,excluded,slotDate,{pageStart,maxPages:2,maxRequests:8});\n      scanned+=result.scanned; pages+=result.pages; progressiveRounds=Math.max(progressiveRounds,round+1);\n      result.selected.forEach((offer,index)=>{ const target=remaining[index]; if(!target)return; planned.push(offer); assignments.set(target.index,{offer,commissionResolved:result.commissionResolved,sourceNiche:result.sourceNiche,scanned:result.scanned,pages:result.pages}); });\n      remaining=group.filter((slot)=>!assignments.has(slot.index));\n      if(assignments.size===before) stalledRounds+=1; else stalledRounds=0;\n      if(stalledRounds>=2){ progressiveSearchExhausted=true; break; }\n    }\n    if(remaining.length&&progressiveRounds>=MAX_PROGRESSIVE_ROUNDS) progressiveSearchExhausted=true;\n  };'''
admin = replace_once(admin, old_fill, new_fill, 'first day fill loop')

old_return = '''  return json({dryRun:true,firstDay:dateKey,totalSlots:allSlots.length,fullDaySlots:fullDaySlots.length,previewedSlots:slots.length,filled,missing:Math.max(0,allSlots.length-filled),coverage:allSlots.length?Math.round((filled/allSlots.length)*1000)/10:0,truncated,scanned,pages,continuous:activeDays==null,activeDays,futureDays,revalidateBeforePublish:true,adjustedForCurrentTime,rolledToNextDay,skippedPastSlots,currentLocalTime,firstScheduledTime:output[0]?.time||null,slots:output,message:activeDays==null||(futureDays??0)>0?"Somente o primeiro dia é planejado agora. Nos próximos dias, novos produtos serão buscados automaticamente quando cada novo ciclo diário começar e serão revalidados perto de cada horário.":"A agenda abaixo cobre o único dia ativo selecionado."});'''
new_return = '''  return json({dryRun:true,firstDay:dateKey,totalSlots:allSlots.length,fullDaySlots:fullDaySlots.length,previewedSlots:slots.length,filled,missing:Math.max(0,allSlots.length-filled),coverage:allSlots.length?Math.round((filled/allSlots.length)*1000)/10:0,truncated,scanned,pages,progressiveSearch:true,progressiveRounds,progressiveSearchExhausted,continuous:activeDays==null,activeDays,futureDays,revalidateBeforePublish:true,adjustedForCurrentTime,rolledToNextDay,skippedPastSlots,currentLocalTime,firstScheduledTime:output[0]?.time||null,slots:output,message:activeDays==null||(futureDays??0)>0?"Somente o primeiro dia é planejado agora. Nos próximos dias, novos produtos serão buscados automaticamente quando cada novo ciclo diário começar e serão revalidados perto de cada horário.":"A agenda abaixo cobre o único dia ativo selecionado."});'''
admin = replace_once(admin, old_return, new_return, 'plan preview return')

old_ui_tail = '''var future=(res.continuous||Number(res.futureDays||0)>0)?'<div class=\"day-plan-note\">🔄 '+sEsc(res.message||'Os produtos dos próximos dias serão buscados automaticamente no novo ciclo diário.')+'</div>':'';var trunc=res.truncated?'<div class=\"day-plan-note\">⚠ A agenda possui '+sEsc(res.totalSlots)+' horários; esta prévia exibiu os primeiros '+sEsc(res.previewedSlots)+'.</div>':'';body.innerHTML='''
new_ui_tail = '''var future=(res.continuous||Number(res.futureDays||0)>0)?'<div class=\"day-plan-note\">🔄 '+sEsc(res.message||'Os produtos dos próximos dias serão buscados automaticamente no novo ciclo diário.')+'</div>':'';var progressive=res.progressiveSearch?'<div class=\"day-plan-note\">🔎 Busca progressiva: '+sEsc(res.progressiveRounds||1)+' rodada(s), '+sEsc(res.pages||0)+' consulta(s). '+(res.progressiveSearchExhausted&&Number(res.missing||0)>0?'A busca profunda chegou ao limite seguro desta prévia; os horários pendentes continuarão sendo pesquisados na execução real.':'O sistema parou assim que preencheu os horários encontrados ou esgotou a rodada atual.')+'</div>':'';var trunc=res.truncated?'<div class=\"day-plan-note\">⚠ A agenda possui '+sEsc(res.totalSlots)+' horários; esta prévia exibiu os primeiros '+sEsc(res.previewedSlots)+'.</div>':'';body.innerHTML='''
admin = replace_once(admin, old_ui_tail, new_ui_tail, 'progressive UI note')

old_body_tail = '''+'</div>'+future+trunc+'<div class=\"day-plan-note\">ℹ Esta agenda comprova a cobertura encontrada agora.'''
new_body_tail = '''+'</div>'+progressive+future+trunc+'<div class=\"day-plan-note\">ℹ Esta agenda comprova a cobertura encontrada agora.'''
admin = replace_once(admin, old_body_tail, new_body_tail, 'progressive UI insertion')

admin_path.write_text(admin)
print('progressive first-day planning patch applied')
