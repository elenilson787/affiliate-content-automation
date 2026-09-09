from pathlib import Path

# --- 1) Dedupe inteligente por similaridade de produto ---
p = Path('lib/offer-engine.ts')
s = p.read_text()

s = s.replace(
'''export function productFingerprint(offer: Offer) {\n  return normalized(offer.title);\n}\n''',
'''const PRODUCT_NOISE = new Set([\n  "de", "da", "do", "das", "dos", "e", "em", "para", "com", "sem", "por", "um", "uma",\n  "novo", "nova", "original", "oficial", "produto", "promocao", "oferta", "kit", "conjunto", "profissional",\n  "alta", "velocidade", "bivolt", "voltagem", "110v", "127v", "220v", "110", "127", "220",\n]);\n\nfunction identityTokens(title: string) {\n  return normalized(title)\n    .split(/\\s+/)\n    .filter((token) => token.length >= 2 && !PRODUCT_NOISE.has(token));\n}\n\nfunction modelTokens(tokens: string[]) {\n  return tokens.filter((token) => /[a-z]/.test(token) && /\\d/.test(token) && token.length >= 3);\n}\n\nfunction likelyBrand(tokens: string[]) {\n  const generic = new Set([\n    "escova", "secadora", "secador", "cabelo", "modeladora", "alisadora", "multifuncional", "rotativa",\n    "eletrica", "eletrico", "air", "styler", "dryer", "hair", "shark",\n  ]);\n  return tokens.find((token) => !generic.has(token) && !/^\\d+$/.test(token)) || "";\n}\n\nfunction diceSimilarity(a: string[], b: string[]) {\n  if (!a.length || !b.length) return 0;\n  const left = new Set(a);\n  const right = new Set(b);\n  let intersection = 0;\n  for (const token of left) if (right.has(token)) intersection += 1;\n  return (2 * intersection) / (left.size + right.size);\n}\n\nexport function productFingerprint(offer: Offer) {\n  return Array.from(new Set(identityTokens(offer.title))).sort().join(" ");\n}\n\nexport function productsLookEquivalent(a: Offer, b: Offer) {\n  const left = identityTokens(a.title);\n  const right = identityTokens(b.title);\n  if (!left.length || !right.length) return false;\n\n  const leftModels = modelTokens(left);\n  const rightModels = modelTokens(right);\n  if (leftModels.some((model) => rightModels.includes(model))) return true;\n\n  const similarity = diceSimilarity(left, right);\n  const leftBrand = likelyBrand(left);\n  const rightBrand = likelyBrand(right);\n  const sameBrand = Boolean(leftBrand && rightBrand && leftBrand === rightBrand);\n\n  // Títulos do mesmo item em lojas diferentes normalmente ficam acima de 0,80.\n  // Para a mesma marca/família, usamos limiar menor para evitar variantes quase idênticas\n  // (ex.: 5 em 1 vs 7 em 1) ocupando ciclos consecutivos.\n  return similarity >= 0.8 || (sameBrand && similarity >= 0.64);\n}\n''')

old = '''  const seenOffers = new Set<string>();\n  const seenProducts = new Set<string>();\n\n  return pool\n'''
new = '''  const seenOffers = new Set<string>();\n  const seenProducts: Offer[] = [];\n\n  return pool\n'''
if old not in s:
    raise SystemExit('offer-engine seen block mismatch')
s = s.replace(old, new, 1)

old = '''    .filter((offer) => {\n      const key = offerKey(offer);\n      const product = productFingerprint(offer);\n      if (seenOffers.has(key) || seenProducts.has(product)) return false;\n      seenOffers.add(key);\n      seenProducts.add(product);\n      return true;\n    })\n'''
new = '''    .filter((offer) => {\n      const key = offerKey(offer);\n      if (seenOffers.has(key) || seenProducts.some((existing) => productsLookEquivalent(existing, offer))) return false;\n      seenOffers.add(key);\n      seenProducts.push(offer);\n      return true;\n    })\n'''
if old not in s:
    raise SystemExit('offer-engine dedupe block mismatch')
s = s.replace(old, new, 1)
p.write_text(s)

# --- 2) Busca adaptativa: até 150, mas normalmente para em 50 quando já há oferta fresca ---
p = Path('lib/search-engine.ts')
p.write_text('''import type { AffiliateProvider, Offer, SearchRequest } from "./types";\nimport { selectOffers } from "./offer-engine";\n\nexport type QualifiedSearchResult = {\n  selected: Offer[];\n  scanned: number;\n  pages: number;\n  excluded: number;\n};\n\ntype SearchOptions = {\n  maxPages?: number;\n  pageSize?: number;\n  excludeOffer?: (offer: Offer) => boolean;\n};\n\nexport async function searchQualifiedOffers(\n  provider: AffiliateProvider,\n  request: SearchRequest,\n  quantity: number,\n  options: SearchOptions = {},\n): Promise<QualifiedSearchResult> {\n  const target = Math.min(Math.max(Math.trunc(quantity), 1), 100);\n  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 3), 1), 5);\n  const pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 50), 1), 50);\n  const pool: Offer[] = [];\n  let selected: Offer[] = [];\n  let pages = 0;\n  let excluded = 0;\n\n  for (let page = 1; page <= maxPages; page += 1) {\n    const batch = await provider.search({ ...request, page, limit: pageSize });\n    pages = page;\n    pool.push(...batch);\n\n    // Mantemos uma reserva de candidatas para poder descartar equivalentes já publicados\n    // sem obrigar a buscar 3 páginas em todo ciclo.\n    const reserve = options.excludeOffer ? Math.min(Math.max(target * 8, 12), 50) : target;\n    const qualified = selectOffers(pool, {\n      keyword: request.keyword,\n      minCommission: request.minCommission,\n      minDiscount: request.minDiscount,\n      maxPrice: request.maxPrice,\n      limit: reserve,\n    });\n\n    const fresh = options.excludeOffer ? qualified.filter((offer) => !options.excludeOffer!(offer)) : qualified;\n    excluded = Math.max(0, qualified.length - fresh.length);\n    selected = fresh.slice(0, target);\n\n    if (selected.length >= target) break;\n    if (batch.length < pageSize) break;\n  }\n\n  return { selected, scanned: pool.length, pages, excluded };\n}\n''')

# --- 3) Histórico: dedupe pelo produto, não só pelo item_id da loja ---
p = Path('src/automation.ts')
s = p.read_text()
s = s.replace('import { offerKey } from "../lib/offer-engine";', 'import { offerKey, productsLookEquivalent } from "../lib/offer-engine";')

old = '''async function wasPublishedRecently(db: SupabaseRest, key: string, channel: string, days: number) {\n  if (days <= 0) return false;\n  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();\n  const params = new URLSearchParams({\n    select: "id",\n    offer_key: eq(key),\n    channel: eq(channel),\n    published_at: `gte.${cutoff}`,\n    limit: "1",\n  });\n  const rows = await db.select<{ id: number }>("published_offers", params);\n  return rows.length > 0;\n}\n'''
new = '''type RecentPublishedQueue = {\n  offer_key: string;\n  channel: string;\n  offer_snapshot: Offer;\n  published_at: string | null;\n};\n\nasync function loadRecentPublishedQueue(db: SupabaseRest, channels: string[], days: number) {\n  if (days <= 0 || channels.length === 0) return [] as RecentPublishedQueue[];\n  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();\n  const params = new URLSearchParams({\n    select: "offer_key,channel,offer_snapshot,published_at",\n    status: "eq.published",\n    published_at: `gte.${cutoff}`,\n    order: "published_at.desc",\n    limit: "500",\n  });\n  return db.select<RecentPublishedQueue>("publication_queue", params);\n}\n\nfunction wasProductPublishedRecently(recent: RecentPublishedQueue[], offer: Offer, channel: string) {\n  const key = offerKey(offer);\n  return recent.some((row) =>\n    row.channel === channel &&\n    (row.offer_key === key || (row.offer_snapshot && productsLookEquivalent(offer, row.offer_snapshot)))\n  );\n}\n'''
if old not in s:
    raise SystemExit('automation history function mismatch')
s = s.replace(old, new, 1)

# Replace searchOffers to support history-aware exclusion.
old = '''async function searchOffers(env: Env, rule: AutomationRuleRow, targetQuantity = rule.quantity) {\n  const selected: Offer[] = [];\n  const unsupportedNetworks: string[] = [];\n  let scanned = 0;\n  let pages = 0;\n\n  for (const network of rule.networks) {\n    if (network !== "shopee") {\n      unsupportedNetworks.push(network);\n      continue;\n    }\n\n    const provider = createShopeeProvider({\n      appId: required(env.SHOPEE_APP_ID, "SHOPEE_APP_ID"),\n      secret: required(env.SHOPEE_SECRET, "SHOPEE_SECRET"),\n    });\n\n    const result = await searchQualifiedOffers(\n      provider,\n      {\n        keyword: rule.keyword,\n        category: rule.category || undefined,\n        minCommission: rule.min_commission ?? undefined,\n        minDiscount: rule.min_discount ?? undefined,\n        maxPrice: rule.max_price ?? undefined,\n        sort: rule.sort || undefined,\n      },\n      targetQuantity,\n      { maxPages: 3, pageSize: 50 },\n    );\n\n    selected.push(...result.selected);\n    scanned += result.scanned;\n    pages += result.pages;\n  }\n\n  const uniqueSelected = Array.from(new Map(selected.map((offer) => [offerKey(offer), offer])).values()).slice(0, targetQuantity);\n  return { selected: uniqueSelected, unsupportedNetworks, scanned, pages };\n}\n'''
new = '''async function searchOffers(\n  env: Env,\n  rule: AutomationRuleRow,\n  targetQuantity = rule.quantity,\n  excludeOffer?: (offer: Offer) => boolean,\n) {\n  const selected: Offer[] = [];\n  const unsupportedNetworks: string[] = [];\n  let scanned = 0;\n  let pages = 0;\n  let excluded = 0;\n\n  for (const network of rule.networks) {\n    if (network !== "shopee") {\n      unsupportedNetworks.push(network);\n      continue;\n    }\n\n    const provider = createShopeeProvider({\n      appId: required(env.SHOPEE_APP_ID, "SHOPEE_APP_ID"),\n      secret: required(env.SHOPEE_SECRET, "SHOPEE_SECRET"),\n    });\n\n    const result = await searchQualifiedOffers(\n      provider,\n      {\n        keyword: rule.keyword,\n        category: rule.category || undefined,\n        minCommission: rule.min_commission ?? undefined,\n        minDiscount: rule.min_discount ?? undefined,\n        maxPrice: rule.max_price ?? undefined,\n        sort: rule.sort || undefined,\n      },\n      targetQuantity,\n      { maxPages: 3, pageSize: 50, excludeOffer },\n    );\n\n    selected.push(...result.selected);\n    scanned += result.scanned;\n    pages += result.pages;\n    excluded += result.excluded;\n  }\n\n  const uniqueSelected: Offer[] = [];\n  for (const offer of selected) {\n    if (!uniqueSelected.some((existing) => productsLookEquivalent(existing, offer))) uniqueSelected.push(offer);\n    if (uniqueSelected.length >= targetQuantity) break;\n  }\n  return { selected: uniqueSelected, unsupportedNetworks, scanned, pages, excluded };\n}\n'''
if old not in s:
    raise SystemExit('automation searchOffers mismatch')
s = s.replace(old, new, 1)

old = '''    const candidateTarget = rule.dry_run ? rule.quantity : Math.min(Math.max(rule.quantity * 10, 20), 50);\n    const { selected: candidates, unsupportedNetworks, scanned, pages } = await searchOffers(env, rule, candidateTarget);\n'''
new = '''    const recentPublished = rule.dry_run ? [] : await loadRecentPublishedQueue(db, rule.channels, rule.avoid_repeat_days);\n    const excludeOffer = rule.dry_run\n      ? undefined\n      : (offer: Offer) => rule.channels.length > 0 && rule.channels.every((channel) =>\n          wasProductPublishedRecently(recentPublished, offer, channel)\n        );\n    const candidateTarget = rule.quantity;\n    const { selected: candidates, unsupportedNetworks, scanned, pages, excluded } = await searchOffers(\n      env, rule, candidateTarget, excludeOffer,\n    );\n'''
if old not in s:
    raise SystemExit('automation candidateTarget mismatch')
s = s.replace(old, new, 1)

old = '''      const key = offerKey(offer);\n      const channelStates = await Promise.all(\n        rule.channels.map(async (channel) => ({\n          channel,\n          duplicate: await wasPublishedRecently(db, key, channel, rule.avoid_repeat_days),\n        })),\n      );\n'''
new = '''      const key = offerKey(offer);\n      const channelStates = rule.channels.map((channel) => ({\n        channel,\n        duplicate: wasProductPublishedRecently(recentPublished, offer, channel),\n      }));\n'''
if old not in s:
    raise SystemExit('automation channelStates mismatch')
s = s.replace(old, new, 1)

# Since search already excludes candidates duplicated across all channels, carry that into logs.
s = s.replace('''    let dedupeCandidatesSkipped = 0;\n''', '''    let dedupeCandidatesSkipped = excluded;\n''', 1)

p.write_text(s)

# --- 4) Tema Cyberpunk aprovado: override global para TODAS as abas ---
p = Path('src/admin.ts')
s = p.read_text()
cyber = r'''
/* Cyberpunk Black Theme — aprovado em 09/09/2026 */
:root{
  --bg:#050816;--panel:rgba(10,17,38,.82);--ink:#f5f7ff;--muted:#8f9ab8;--line:#223258;
  --brand:#7c3cff;--brand2:#a855f7;--green:#14f195;--red:#ff4d78;--amber:#ffb84d;
  --cyan:#19c8ff;--blue:#3b82f6;--shadow:0 18px 55px rgba(0,0,0,.38),0 0 28px rgba(91,61,255,.08)
}
html{background:#040713;color-scheme:dark}
body{background:
  radial-gradient(circle at 78% 8%,rgba(64,77,255,.15),transparent 27%),
  radial-gradient(circle at 28% 32%,rgba(124,58,237,.12),transparent 30%),
  linear-gradient(180deg,#050816 0%,#070b18 48%,#040712 100%);color:var(--ink);min-height:100vh}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.22;background-image:
  linear-gradient(rgba(72,106,190,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(72,106,190,.09) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,black,transparent 88%)}
.sidebar{background:linear-gradient(180deg,rgba(5,9,23,.98),rgba(6,10,24,.96));border-right:1px solid rgba(91,118,190,.28);box-shadow:12px 0 45px rgba(0,0,0,.22)}
.logo{background:linear-gradient(135deg,#5b35ff,#9b45ff);box-shadow:0 0 26px rgba(124,60,255,.62),inset 0 0 18px rgba(255,255,255,.14)}
.brand h1,.top h2,.section-head h3,.rule-name,.integration b,.modal-head h3,.lock-card h2{color:#f7f8ff}
.nav button{color:#a8b3cf;border:1px solid transparent;transition:.18s ease}
.nav button.active,.nav button:hover{background:linear-gradient(90deg,rgba(106,57,255,.25),rgba(38,80,190,.12));color:#c4b5fd;border-color:rgba(126,74,255,.48);box-shadow:0 0 22px rgba(108,54,255,.16),inset 3px 0 0 #8257ff}
.main{position:relative;background:transparent}
.top{padding-bottom:16px;border-bottom:1px solid rgba(63,84,137,.22)}
.top:before{content:"AUTOMAÇÃO • DADOS • PERFORMANCE";position:absolute;right:30px;top:8px;color:rgba(110,139,222,.11);font-size:10px;letter-spacing:.32em;pointer-events:none}
.btn{background:linear-gradient(180deg,rgba(13,22,45,.92),rgba(8,15,32,.95));border-color:#283b68;color:#cbd5f3;box-shadow:inset 0 0 0 1px rgba(255,255,255,.015);transition:.18s ease}
.btn:hover{border-color:#6d55ff;color:#fff;box-shadow:0 0 18px rgba(104,72,255,.18);transform:translateY(-1px)}
.btn.primary{background:linear-gradient(135deg,#6d39ff,#7c45ff 55%,#9b48ff);border-color:#9d6bff;color:white;box-shadow:0 0 24px rgba(110,57,255,.34)}
.btn.danger{color:#ff7a96;border-color:rgba(255,77,120,.35)}
.metric,.panel,.rule-card,.integration,.modal,.lock-card{background:linear-gradient(145deg,rgba(12,22,48,.88),rgba(7,13,29,.92));border-color:rgba(52,79,137,.58);box-shadow:var(--shadow);backdrop-filter:blur(15px)}
.metric{position:relative;overflow:hidden}.metric:after{content:"";position:absolute;inset:auto -20% -70% 20%;height:90px;background:radial-gradient(circle,rgba(64,108,255,.17),transparent 68%);pointer-events:none}
.metric:nth-child(1){border-bottom-color:#7c3cff}.metric:nth-child(2){border-bottom-color:#22b8ff}.metric:nth-child(3){border-bottom-color:#ffb84d}.metric:nth-child(4){border-bottom-color:#14f195}
.metric .value{color:#fff;text-shadow:0 0 18px rgba(127,92,255,.18)}
.rule-card{border-color:rgba(78,74,196,.65);box-shadow:0 0 0 1px rgba(113,74,255,.08),0 18px 50px rgba(0,0,0,.25),0 0 28px rgba(84,47,255,.08)}
.rule-card:hover{border-color:rgba(116,79,255,.92);box-shadow:0 0 30px rgba(97,60,255,.12),0 18px 50px rgba(0,0,0,.28)}
.pill{background:#111a31;color:#9ca9c8;border:1px solid rgba(61,81,129,.48)}
.pill.purple{background:rgba(109,57,255,.18);color:#b9a7ff;border-color:rgba(127,84,255,.42)}
.pill.green{background:rgba(20,241,149,.1);color:#28f2a2;border-color:rgba(20,241,149,.28)}
.pill.amber{background:rgba(255,184,77,.1);color:#ffc569;border-color:rgba(255,184,77,.28)}
.table th{background:rgba(15,28,56,.9);color:#8293bd;border-bottom-color:#29426f}.table td{border-bottom-color:rgba(41,59,98,.52);color:#dfe6fa}.table tr:hover td{background:rgba(23,42,78,.28)}
.thumb{background:#0d1730;border-color:#2c426e}.product-title{color:#f5f7ff}.muted{color:#8593b4!important}
.status{border:1px solid transparent}.status.published,.status.completed{background:rgba(20,241,149,.1);color:#25e99e;border-color:rgba(20,241,149,.22)}
.status.failed{background:rgba(255,77,120,.1);color:#ff7696;border-color:rgba(255,77,120,.22)}
.status.pending,.status.processing,.status.retry,.status.running{background:rgba(255,184,77,.1);color:#ffc267;border-color:rgba(255,184,77,.22)}
.status.skipped_duplicate{background:rgba(124,60,255,.12);color:#b49cff;border-color:rgba(124,60,255,.24)}
.log{border-bottom-color:rgba(42,60,98,.55)}
.integration{position:relative;overflow:hidden}.integration:after{content:"";position:absolute;right:-20px;top:-35px;width:90px;height:90px;border-radius:50%;background:radial-gradient(circle,rgba(25,200,255,.11),transparent 70%)}
.dot{box-shadow:0 0 12px rgba(20,241,149,.72)}.dot.off{box-shadow:0 0 12px rgba(255,77,120,.62)}
.field input,.field select,.lock-card input{background:#081127;border-color:#293d69;color:#edf2ff}.field input:focus,.field select:focus,.lock-card input:focus{border-color:#7c4dff;box-shadow:0 0 0 3px rgba(124,77,255,.12),0 0 18px rgba(124,77,255,.08)}
.modal-backdrop,.lock{background:rgba(1,4,12,.74);backdrop-filter:blur(10px)}
.toast{background:#0b1429;border:1px solid #354d7e;color:#f5f7ff;box-shadow:0 0 30px rgba(56,83,255,.18)}
.mini{background:linear-gradient(145deg,rgba(11,22,44,.95),rgba(7,13,28,.96));border-color:#2a416d;color:#93a3c7;box-shadow:0 0 18px rgba(0,0,0,.18)}
.sidebar-foot .mini b{color:#18e99a;text-shadow:0 0 11px rgba(20,241,149,.35)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:#050916}::-webkit-scrollbar-thumb{background:#263a68;border-radius:10px;border:2px solid #050916}::-webkit-scrollbar-thumb:hover{background:#4d46a8}
'''
if '/* Cyberpunk Black Theme' not in s:
    if '</style>' not in s:
        raise SystemExit('admin style closing tag missing')
    s = s.replace('</style>', cyber + '\n</style>', 1)
p.write_text(s)
