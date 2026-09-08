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

## Estado atual

A fundação inicial foi extraída do Afiliapulse e está sendo reconstruída aqui de forma independente. O próximo marco é implementar o adapter real da Shopee e conectar a busca automática ao pipeline.
