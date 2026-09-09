from pathlib import Path

policy_path = Path('src/rule-policy.ts')
policy = policy_path.read_text(encoding='utf-8')
old = '''export function operationalState(rule: AutomationRuleRow, now = new Date()): RuleOperationalState {
  const settings = rule.settings || {};
  const timezone = rule.timezone || "America/Sao_Paulo";
  const local = localDateParts(now, timezone);
  const startDate = text(settings.activeStartDate);
  const endDate = text(settings.activeEndDate);
  if (endDate && local.dateKey > endDate) return "ended";
  if (startDate && local.dateKey < startDate) return rule.enabled ? "scheduled" : "paused";
  if (!rule.enabled) return "paused";
  return "active";
}
'''
new = '''export function operationalState(rule: AutomationRuleRow, now = new Date()): RuleOperationalState {
  const settings = rule.settings || {};
  const timezone = rule.timezone || "America/Sao_Paulo";
  const local = localDateParts(now, timezone);
  const startDate = text(settings.activeStartDate);
  const endDate = text(settings.activeEndDate);
  const startMinutes = clockMinutes(settings.windowStart, "09:00");
  const endMinutes = clockMinutes(settings.windowEnd, "22:00");
  const endedToday = Boolean(endDate && local.dateKey === endDate && startMinutes <= endMinutes && local.minutes > endMinutes);
  if (endDate && (local.dateKey > endDate || endedToday)) return "ended";
  if (startDate && local.dateKey < startDate) return rule.enabled ? "scheduled" : "paused";
  if (!rule.enabled) return "paused";
  return "active";
}
'''
assert old in policy, 'operationalState block not found'
policy_path.write_text(policy.replace(old, new), encoding='utf-8')

admin_path = Path('src/admin.ts')
admin = admin_path.read_text(encoding='utf-8')
old_state = "function stateOf(r){var s=r.settings||{},now=localKey(new Date()).key,start=s.activeStartDate||'',end=s.activeEndDate||'';if(end&&now>end)return'ended';if(start&&now<start)return r.enabled?'scheduled':'paused';if(!r.enabled)return'paused';var lr=(SMART.data&&SMART.data.runs||[]).find(function(x){return x.rule_id===r.id});if(lr&&lr.status==='failed')return'problem';return'active'}"
new_state = "function stateOf(r){var s=r.settings||{},d=new Date(),lk=localKey(d),now=lk.key,start=s.activeStartDate||'',end=s.activeEndDate||'',parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:r.timezone||'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(function(x){return[x.type,x.value]})),cur=Number(parts.hour)*60+Number(parts.minute),ws=minutes(s.windowStart,'09:00'),we=minutes(s.windowEnd,'22:00'),endedToday=end&&now===end&&ws<=we&&cur>we;if(end&&(now>end||endedToday))return'ended';if(start&&now<start)return r.enabled?'scheduled':'paused';if(!r.enabled)return'paused';var lr=(SMART.data&&SMART.data.runs||[]).find(function(x){return x.rule_id===r.id});if(lr&&lr.status==='failed')return'problem';return'active'}"
assert old_state in admin, 'stateOf block not found'
admin = admin.replace(old_state, new_state)
old_metric = "published=Number(SMART.data.metrics&&SMART.data.metrics.published24h||0),nexts="
new_metric = "todayKey=localKey(new Date()).key,published=(SMART.data.queue||[]).filter(function(q){return q.status==='published'&&q.published_at&&localKey(new Date(q.published_at)).key===todayKey}).length,nexts="
assert old_metric in admin, 'published metric block not found'
admin = admin.replace(old_metric, new_metric)
admin_path.write_text(admin, encoding='utf-8')
