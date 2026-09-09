-- Enforce at most one due queue item per automation/channel in each worker claim.
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
