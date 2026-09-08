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

## Estado atual

Fundação independente criada e camada central normalizada. A Shopee possui adapter/client real e o Telegram possui publisher real. O próximo passo é conectar o resultado da automação ao publisher Telegram, adicionar deduplicação persistente e depois criar os demais publishers e adapters.
