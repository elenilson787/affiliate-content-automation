# affiliate-content-automation

Motor independente de automação de conteúdo para afiliados, executado como **Cloudflare Worker nativo**.

## Arquitetura

```text
Cloudflare Cron (*/5 min)
        ↓
  scheduled()
        ↓
Supabase automation_rules
        ↓
Shopee Affiliate API
        ↓
filtros + ranking
        ↓
publication_queue
        ↓
claim_due_publications()
        ↓
Telegram Bot API
        ↓
complete_publication() / fail_publication()
        ↓
published_offers + publication_logs
```

O Supabase é a fonte de verdade para regras, execuções, fila, idempotência, locks, retry e histórico. O Worker apenas orquestra o ciclo.

## Endpoints

- `GET /health` — saúde e presença das configurações, sem revelar segredos.
- `POST /tick` — scheduler + worker em uma chamada.
- `POST /scheduler` — avalia regras agendadas e cria itens na fila.
- `POST /worker` — consome a fila pendente.
- `POST /test` — busca Shopee e gera preview sem publicar nem gravar fila.

Todos os endpoints `POST` exigem:

```text
Authorization: Bearer <AUTOMATION_SECRET>
```

## Agendamento

O Cron Trigger do Cloudflare executa a cada 5 minutos. Cada regra habilitada usa o campo `schedule_cron` e o campo `timezone` de `automation_rules`.

Exemplos:

```text
*/5 * * * *    a cada 5 minutos
*/15 * * * *   a cada 15 minutos
0 9 * * *      diariamente às 09:00 no timezone da regra
0 8 * * 1-5    segunda a sexta às 08:00
```

O scheduler verifica a janela dos últimos 5 minutos e cria um UUID determinístico por `regra + slot`, impedindo uma execução duplicada do mesmo horário.

## Dry run

Novas regras continuam seguras por padrão (`dry_run = true`). Nesse modo o Worker:

1. consulta as ofertas;
2. aplica filtros/ranking;
3. gera o conteúdo;
4. grava o resultado da execução;
5. **não cria publicação pendente e não envia ao Telegram**.

Para publicação real, altere a regra para `dry_run = false` somente após validar o preview.

## Secrets Cloudflare

Configure no projeto Cloudflare:

```bash
npx wrangler secret put SHOPEE_APP_ID
npx wrangler secret put SHOPEE_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put AUTOMATION_SECRET
```

`SUPABASE_SECRET_KEY` deve ser uma chave backend `sb_secret_*`. Durante a migração, o código ainda aceita `SUPABASE_SERVICE_ROLE_KEY`, mas ela não deve ser adicionada se a secret key nova já estiver configurada.

Nunca versione esses valores.

## Desenvolvimento local

```bash
npm install
npm run dev
```

Teste o cron local:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

Validação completa:

```bash
npm run check
```

## Deploy

```bash
npm run deploy
```

O `wrangler.jsonc` é a fonte de verdade do Worker e do Cron Trigger.

## Banco

Migrations versionadas em `supabase/migrations/` criam:

- `automation_rules`
- `automation_runs`
- `publication_queue`
- `published_offers`
- `publication_logs`

Funções transacionais usadas pelo Worker:

- `claim_due_publications`
- `complete_publication`
- `fail_publication`
- `recover_stale_publications`

A secret key existe somente no backend Cloudflare; `anon` e `authenticated` não recebem acesso às tabelas operacionais.
