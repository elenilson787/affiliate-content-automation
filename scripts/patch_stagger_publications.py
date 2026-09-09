from pathlib import Path

AUTO = Path("src/automation.ts")
ADMIN = Path("src/admin.ts")
MIG = Path("supabase/migrations/20260909193000_stagger_publications_by_rule_channel.sql")

text = AUTO.read_text(encoding="utf-8")

old = '''function intervalDueSlot(now: Date, timezone: string, settings: Record<string, unknown>, lastRunAt?: string | null) {
  const interval = intervalMinutes(settings);
  if (!interval) return null;
  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);
  if (!insidePublishWindow(slot, timezone, settings)) return null;
  if (lastRunAt) {
    const last = new Date(lastRunAt).getTime();
    if (Number.isFinite(last) && slot.getTime() - last < interval * 60_000) return null;
  }
  return slot;
}
'''
new = '''function nextValidPublicationSlot(start: Date, timezone: string, settings: Record<string, unknown>) {
  let candidate = new Date(start);
  candidate.setUTCSeconds(0, 0);
  const remainder = candidate.getUTCMinutes() % 5;
  if (remainder !== 0) candidate = new Date(candidate.getTime() + (5 - remainder) * 60_000);

  // Procura a próxima janela válida por até 14 dias. Isso também cobre janelas
  // que atravessam a meia-noite sem depender de conversões manuais de timezone.
  for (let i = 0; i < 4_032; i += 1) {
    if (insidePublishWindow(candidate, timezone, settings)) return candidate;
    candidate = new Date(candidate.getTime() + 5 * 60_000);
  }
  throw new Error("NO_VALID_PUBLICATION_WINDOW");
}

async function hasActiveRuleQueue(db: SupabaseRest, ruleId: string) {
  const rows = await db.select<{ id: string }>(
    "publication_queue",
    new URLSearchParams({
      select: "id",
      rule_id: eq(ruleId),
      status: "in.(pending,processing,retry)",
      limit: "1",
    }),
  );
  return rows.length > 0;
}

async function latestRulePublishedAt(db: SupabaseRest, ruleId: string, channel?: string) {
  const params = new URLSearchParams({
    select: "published_at",
    rule_id: eq(ruleId),
    status: "eq.published",
    order: "published_at.desc",
    limit: "1",
  });
  if (channel) params.set("channel", eq(channel));
  const rows = await db.select<{ published_at: string | null }>("publication_queue", params);
  return rows[0]?.published_at || null;
}

async function buildPublicationSlots(
  db: SupabaseRest,
  rule: AutomationRuleRow,
  slot: Date,
  count: number,
) {
  const interval = intervalMinutes(rule.settings);
  if (!interval) return Array.from({ length: count }, () => new Date(slot));

  const timezone = rule.timezone || "America/Sao_Paulo";
  const lastPublishedAt = await latestRulePublishedAt(db, rule.id);
  let firstCandidate = new Date(slot);
  if (lastPublishedAt) {
    const earliest = new Date(lastPublishedAt).getTime() + interval * 60_000;
    if (Number.isFinite(earliest) && earliest > firstCandidate.getTime()) firstCandidate = new Date(earliest);
  }

  const slots: Date[] = [];
  let current = nextValidPublicationSlot(firstCandidate, timezone, rule.settings);
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      current = nextValidPublicationSlot(
        new Date(current.getTime() + interval * 60_000),
        timezone,
        rule.settings,
      );
    }
    slots.push(new Date(current));
  }
  return slots;
}
'''
assert old in text, "intervalDueSlot block not found"
text = text.replace(old, new)

text = text.replace('''  const runId = triggerSource === "scheduler" ? await stableUuid(`scheduler:${rule.id}:${slotIso}`) : crypto.randomUUID();
  const nowIso = new Date().toISOString();
''', '''  const runId = triggerSource === "scheduler" ? await stableUuid(`scheduler:${rule.id}:${slotIso}`) : crypto.randomUUID();
''')

old = '''    const priority = numberSetting(rule.settings, "priority", 100, 0, 32_767);
    const maxAttempts = numberSetting(rule.settings, "maxAttempts", 3, 1, 20);
    const queueRows: QueueInsert[] = [];
'''
new = '''    const priority = numberSetting(rule.settings, "priority", 100, 0, 32_767);
    const maxAttempts = numberSetting(rule.settings, "maxAttempts", 3, 1, 20);
    const configuredInterval = intervalMinutes(rule.settings);
    const publicationSlots = await buildPublicationSlots(db, rule, slot, rule.quantity);
    const queueRows: QueueInsert[] = [];
'''
assert old in text, "priority block not found"
text = text.replace(old, new)

old = '''      selected.push(offer);
      for (const { channel, duplicate } of channelStates) {
        const content = generateContent(offer, channel, contentOptions(rule.settings));
        queueRows.push({
'''
new = '''      const publicationIndex = selected.length;
      const scheduledFor = publicationSlots[publicationIndex]?.toISOString() || slotIso;
      selected.push(offer);
      for (const { channel, duplicate } of channelStates) {
        const content = generateContent(offer, channel, contentOptions(rule.settings));
        queueRows.push({
'''
assert old in text, "selected push block not found"
text = text.replace(old, new)

text = text.replace('''          scheduled_for: nowIso,
          available_at: nowIso,
''', '''          scheduled_for: scheduledFor,
          available_at: scheduledFor,
''')

old = '''        searchCandidates: candidates.length,
        dedupeCandidatesSkipped,
      },
'''
new = '''        searchCandidates: candidates.length,
        dedupeCandidatesSkipped,
        publicationIntervalMinutes: configuredInterval,
        firstScheduledFor: selected.length ? publicationSlots[0]?.toISOString() || null : null,
        lastScheduledFor: selected.length ? publicationSlots[selected.length - 1]?.toISOString() || null : null,
      },
'''
assert old in text, "metadata block not found"
text = text.replace(old, new, 1)

old = '''export async function runRuleNow(env: Env, ruleId: string) {
  const db = new SupabaseRest(env);
  const rules = await db.select<AutomationRuleRow>(
    "automation_rules",
    new URLSearchParams({ select: "*", id: eq(ruleId), limit: "1" }),
  );
  if (!rules.length) throw new Error("AUTOMATION_RULE_NOT_FOUND");
  const execution = await executeRule(db, env, rules[0], new Date(), "manual");
'''
new = '''export async function runRuleNow(env: Env, ruleId: string) {
  const db = new SupabaseRest(env);
  const rules = await db.select<AutomationRuleRow>(
    "automation_rules",
    new URLSearchParams({ select: "*", id: eq(ruleId), limit: "1" }),
  );
  if (!rules.length) throw new Error("AUTOMATION_RULE_NOT_FOUND");
  if (!rules[0].dry_run && await hasActiveRuleQueue(db, ruleId)) {
    throw new Error("Esta automação já possui publicações pendentes. Aguarde a sequência atual terminar ou cancele a fila antes de executar novamente.");
  }
  const execution = await executeRule(db, env, rules[0], new Date(), "manual");
'''
assert old in text, "runRuleNow block not found"
text = text.replace(old, new)

old = '''  for (const rule of rules) {
    const timezone = rule.timezone || env.DEFAULT_TIMEZONE || "America/Sao_Paulo";
    let slot: Date | null = null;

    if (intervalMinutes(rule.settings)) {
      const lastRuns = await db.select<{ started_at: string }>(
        "automation_runs",
        new URLSearchParams({ select: "started_at", rule_id: eq(rule.id), order: "started_at.desc", limit: "1" }),
      );
      slot = intervalDueSlot(now, timezone, rule.settings, lastRuns[0]?.started_at);
    } else if (rule.schedule_cron?.trim()) {
      slot = findDueSlot(rule.schedule_cron, now, timezone, SCHEDULER_LOOKBACK_MINUTES);
    }

    if (!slot) continue;
    results.push(await executeRule(db, env, rule, slot));
  }
'''
new = '''  for (const rule of rules) {
    const timezone = rule.timezone || env.DEFAULT_TIMEZONE || "America/Sao_Paulo";
    let slot: Date | null = null;

    // Uma regra nunca cria uma segunda sequência enquanto a anterior ainda tiver
    // itens pendentes/processing/retry. Isso impede lotes concorrentes.
    if (!rule.dry_run && await hasActiveRuleQueue(db, rule.id)) continue;

    if (intervalMinutes(rule.settings)) {
      const candidate = new Date(now);
      candidate.setUTCSeconds(0, 0);
      if (insidePublishWindow(candidate, timezone, rule.settings)) slot = candidate;
    } else if (rule.schedule_cron?.trim()) {
      slot = findDueSlot(rule.schedule_cron, now, timezone, SCHEDULER_LOOKBACK_MINUTES);
    }

    if (!slot) continue;
    results.push(await executeRule(db, env, rule, slot));
  }
'''
assert old in text, "scheduler block not found"
text = text.replace(old, new)

old = '''async function publishQueueItem(db: SupabaseRest, env: Env, workerId: string, row: PublicationQueueRow) {
  try {
    const content = contentFromQueue(row);
'''
new = '''async function deferClaimIfTooSoon(db: SupabaseRest, workerId: string, row: PublicationQueueRow) {
  if (!row.rule_id) return null;
  const rules = await db.select<AutomationRuleRow>(
    "automation_rules",
    new URLSearchParams({ select: "*", id: eq(row.rule_id), limit: "1" }),
  );
  const rule = rules[0];
  if (!rule) return null;
  const interval = intervalMinutes(rule.settings);
  if (!interval) return null;

  const lastPublishedAt = await latestRulePublishedAt(db, rule.id, row.channel);
  if (!lastPublishedAt) return null;
  const earliestMs = new Date(lastPublishedAt).getTime() + interval * 60_000;
  if (!Number.isFinite(earliestMs) || Date.now() >= earliestMs) return null;

  const scheduled = nextValidPublicationSlot(
    new Date(earliestMs),
    rule.timezone || "America/Sao_Paulo",
    rule.settings,
  );
  const scheduledIso = scheduled.toISOString();
  const filters = new URLSearchParams({ id: eq(row.id), locked_by: eq(workerId) });
  await db.update("publication_queue", filters, {
    status: "pending",
    scheduled_for: scheduledIso,
    available_at: scheduledIso,
    attempts: Math.max(0, Number(row.attempts || 0) - 1),
    locked_at: null,
    locked_by: null,
  });
  await db.insert("publication_logs", {
    queue_id: row.id,
    run_id: row.run_id,
    rule_id: row.rule_id,
    event: "interval_deferred",
    status: "pending",
    message: `Publicação adiada para respeitar intervalo de ${interval} minuto(s).`,
    metadata: { intervalMinutes: interval, scheduledFor: scheduledIso },
  }, "return=minimal");
  return scheduledIso;
}

async function publishQueueItem(db: SupabaseRest, env: Env, workerId: string, row: PublicationQueueRow) {
  try {
    const deferredUntil = await deferClaimIfTooSoon(db, workerId, row);
    if (deferredUntil) {
      return { id: row.id, runId: row.run_id, status: "deferred" as const, scheduledFor: deferredUntil };
    }
    const content = contentFromQueue(row);
'''
assert old in text, "publishQueueItem block not found"
text = text.replace(old, new)

AUTO.write_text(text, encoding="utf-8")

admin = ADMIN.read_text(encoding="utf-8")
admin = admin.replace('<div class="field"><label>Quantidade / ciclo</label><input id="quantity" type="number" min="1" max="100" value="1"></div>', '<div class="field"><label>Produtos por sequência</label><input id="quantity" type="number" min="1" max="100" value="1"><div class="muted" style="font-size:10px;margin-top:5px">Os produtos são enfileirados respeitando o intervalo escolhido entre cada publicação.</div></div>')
admin = admin.replace("+' por ciclo</span>", "+' por sequência</span>")

old = '''  const nextRuns=Object.fromEntries(rules.map(r=>{ const last=runs.find((run:any)=>run.rule_id===r.id) as any; return [r.id,r.enabled?nextRuleSlot(r,last?.started_at?String(last.started_at):null,now):null]; }));'''
new = '''  const nextRuns=Object.fromEntries(rules.map(r=>{
    const nextQueued=(queue as any[])
      .filter(q=>q.rule_id===r.id&&["pending","processing","retry"].includes(String(q.status))&&q.scheduled_for)
      .sort((a,b)=>new Date(a.scheduled_for).getTime()-new Date(b.scheduled_for).getTime())[0];
    if(nextQueued) return [r.id,String(nextQueued.scheduled_for)];
    const last=runs.find((run:any)=>run.rule_id===r.id) as any;
    return [r.id,r.enabled?nextRuleSlot(r,last?.started_at?String(last.started_at):null,now):null];
  }));'''
assert old in admin, "admin nextRuns block not found"
admin = admin.replace(old, new)
ADMIN.write_text(admin, encoding="utf-8")

MIG.write_text('''-- Enforce at most one due queue item per automation/channel in each worker claim.
-- The application also reschedules a claimed item when the previous real
-- publication happened too recently, so delayed workers do not burst a backlog.
create or replace function public.claim_due_publications(
  p_worker_id text,
  p_limit integer default 10
)
returns setof public.publication_queue
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'p_worker_id is required';
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit must be between 1 and 100';
  end if;

  return query
  with due_groups as (
    select distinct q.rule_id, q.channel
    from public.publication_queue q
    where q.status in ('pending', 'retry')
      and q.scheduled_for <= now()
      and q.available_at <= now()
      and q.attempts < q.max_attempts
  ), candidates as (
    select picked.id, picked.priority, picked.scheduled_for, picked.created_at
    from due_groups g
    cross join lateral (
      select q.id, q.priority, q.scheduled_for, q.created_at
      from public.publication_queue q
      where q.rule_id is not distinct from g.rule_id
        and q.channel = g.channel
        and q.status in ('pending', 'retry')
        and q.scheduled_for <= now()
        and q.available_at <= now()
        and q.attempts < q.max_attempts
      order by q.priority asc, q.scheduled_for asc, q.created_at asc
      for update skip locked
      limit 1
    ) picked
    order by picked.priority asc, picked.scheduled_for asc, picked.created_at asc
    limit p_limit
  )
  update public.publication_queue q
  set
    status = 'processing',
    attempts = q.attempts + 1,
    locked_at = now(),
    locked_by = p_worker_id,
    updated_at = now()
  from candidates c
  where q.id = c.id
  returning q.*;
end;
$$;

revoke all on function public.claim_due_publications(text, integer) from public, anon, authenticated;
grant execute on function public.claim_due_publications(text, integer) to service_role;
''', encoding="utf-8")
