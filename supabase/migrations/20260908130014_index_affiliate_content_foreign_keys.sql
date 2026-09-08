create index if not exists publication_logs_rule_created_idx
  on public.publication_logs (rule_id, created_at desc);

create index if not exists published_offers_rule_published_idx
  on public.published_offers (rule_id, published_at desc);

create index if not exists published_offers_run_published_idx
  on public.published_offers (run_id, published_at desc);
