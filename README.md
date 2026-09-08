# Affiliate Content Automation

Motor leve e independente para automatizar o ciclo **buscar ofertas → filtrar → gerar conteúdo → enfileirar → publicar**.

## Objetivo

Separar a automação de conteúdo do Afiliapulse, sem carregar billing, analytics pesado ou telas comerciais.

### Pipeline

```text
Redes de afiliados
  ↓
Adapters / Registry
  ↓
Ofertas normalizadas
  ↓
Filtro + ranking
  ↓
Gerador de conteúdo
  ↓
Fila de publicação
  ↓
Publishers / Registry
  ↓
Telegram · WhatsApp · Facebook · Instagram · Threads
```

## Redes previstas

- Shopee
- Amazon
- Mercado Livre
- Magalu
- AliExpress
- outras via adapters

## Princípios

- Uma interface comum para todas as redes de afiliados.
- Uma interface comum para todos os canais de publicação.
- Prevenção de duplicidade.
- Busca orientada por desconto, comissão e relevância.
- Infraestrutura pequena e barata.
- APIs oficiais quando disponíveis.

## Telegram

O primeiro canal de publicação implementado é o Telegram.

Variáveis necessárias no ambiente do servidor:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Nunca use `NEXT_PUBLIC_` nessas variáveis e nunca coloque tokens no Git. Em desenvolvimento, use `.env.local`; em produção, configure as variáveis no provedor de hospedagem.

### Testar o Telegram

Com o app rodando, envie um `POST` para:

```text
/api/telegram/test
```

Exemplo de corpo:

```json
{
  "message": "🔥 Oferta de teste!",
  "cta": "👉 Confira agora",
  "affiliateUrl": "https://example.com"
}
```

O endpoint retorna o `externalId`, que corresponde ao `message_id` retornado pelo Telegram.

## Teste da automação sem publicar

O endpoint abaixo executa busca + filtros + ranking + geração de conteúdo, mas não publica:

```text
POST /api/automation/test
```

Exemplo:

```json
{
  "keyword": "celular",
  "quantity": 5,
  "minCommission": 5,
  "minDiscount": 20,
  "maxPrice": 1500
}
```

Para esse teste, configure também:

```env
SHOPEE_APP_ID=
SHOPEE_SECRET=
```

## Publicação automática + deduplicação

O endpoint abaixo executa Shopee → filtros → copy → Telegram. Por segurança, `dryRun` é `true` por padrão.

```text
POST /api/automation/publish
```

Exemplo de publicação real:

```json
{
  "keyword": "celular",
  "quantity": 3,
  "minCommission": 5,
  "minDiscount": 20,
  "maxPrice": 1500,
  "avoidRepeatDays": 7,
  "dryRun": false
}
```

A deduplicação persistente usa Supabase e considera a combinação **oferta + canal**. Uma oferta já publicada no Telegram dentro de `avoidRepeatDays` recebe `skipped_duplicate` e não é enviada novamente.

Variáveis adicionais:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

`SUPABASE_SERVICE_ROLE_KEY` é exclusivamente server-side e nunca deve receber prefixo `NEXT_PUBLIC_`.

### Banco

A tabela `published_offers` é criada pela migration:

```text
supabase/migrations/0001_create_published_offers.sql
```

Ela possui índice por `published_at`, unicidade por `offer_key + channel` e RLS habilitado sem acesso para `anon`/`authenticated`. O acesso da aplicação é feito somente no servidor com a service role key.

## Estado atual

Fundação independente criada e camada central normalizada. A Shopee possui adapter/client real, o Telegram possui publisher real e a automação já está conectada à publicação. A deduplicação persistente foi adicionada com Supabase.

### Próximos passos

1. Scheduler/worker para execução automática.
2. Fila de publicação com retry e backoff.
3. Adapter Amazon.
4. Adapter Mercado Livre.
5. Adapter Magalu/AliExpress.
6. Publishers WhatsApp, Facebook, Instagram e Threads.
7. Regras de conteúdo específicas por canal.
