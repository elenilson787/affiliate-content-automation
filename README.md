# affiliate-content-automation

Motor independente de automação de conteúdo para afiliados.

O objetivo deste repositório é manter separado do AFILIAPULSE o núcleo responsável por:

1. consultar redes de afiliados;
2. normalizar ofertas;
3. aplicar filtros e ranking;
4. gerar conteúdo por canal;
5. evitar republicações recentes;
6. publicar em canais configurados.

## Estrutura atual

```text
lib/
├── affiliate/
│   └── shopee/
│       ├── adapter.ts
│       ├── client.ts
│       └── index.ts
├── publishers/
│   ├── index.ts
│   └── telegram.ts
├── affiliate-registry.ts
├── automation-engine.ts
├── content-engine.ts
├── dedupe-store.ts
├── offer-engine.ts
├── publisher-registry.ts
└── types.ts
```

## API atual

### `POST /api/automation/test`

Executa somente busca/filtro/geração de conteúdo e não publica.

### `POST /api/automation/publish`

Executa o fluxo completo. O parâmetro `dryRun` assume `true` quando não informado.

Exemplo:

```json
{
  "keyword": "fone bluetooth",
  "quantity": 3,
  "minCommission": 8,
  "minDiscount": 20,
  "maxPrice": 200,
  "avoidRepeatDays": 7,
  "dryRun": true
}
```

Para publicação real:

```json
{
  "keyword": "fone bluetooth",
  "quantity": 3,
  "avoidRepeatDays": 7,
  "dryRun": false
}
```

## Variáveis de ambiente

```env
SHOPEE_APP_ID=
SHOPEE_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

A `SUPABASE_SERVICE_ROLE_KEY` deve existir somente no backend.

## Supabase

A tabela `published_offers` é usada para deduplicação por oferta/canal.

As migrations ficam em:

```text
supabase/migrations/
```

O banco agora também contém a fundação para execução assíncrona:

- `automation_rules`
- `automation_runs`
- `publication_queue`
- `published_offers`
- `publication_logs`

Além de funções transacionais para claim, retry, conclusão e recuperação de locks vencidos.

## Próximos passos

- scheduler/worker;
- fila com retry/backoff;
- novos adapters de afiliados;
- novos publishers;
- observabilidade e painel operacional.
