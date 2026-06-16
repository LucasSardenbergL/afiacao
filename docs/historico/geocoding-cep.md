# Geocoding por CEP (Roteirizador-campo) — entregas e lições

> Arco que dá ao mapa do **Roteirizador-campo** (`/admin/route-planner`, contexto `prospeccao`) coordenadas **pré-resolvidas e auditáveis por CEP**, com **OpenStreetMap/Nominatim mantido** e **Google Maps pago FORA** (decisão do founder). Fonte da verdade de coordenada por CEP = tabela `cep_geo`. Registre aqui ao concluir; regra viva vai pro CLAUDE.md, lição reutilizável pro `docs/agent/`.

## Visão geral

3 Sub-PRs + um **gate de medição** + uma **2ª opinião do Codex**. O mapa resolve `lat/lng` por `COALESCE(cep_geo, lat legado, centróide do município)` — **pino honestamente "aproximado"** quando cai no centróide (precisão > recall: nunca um pino errado no caminho do dinheiro = mapa de visita do vendedor). O `useFarmerScoring` (money-path de score) **não foi tocado**.

## Sub-PR 1 — Banco (✅ LIVE em prod)

Migrations manuais (SQL Editor do Lovable; `cep_geo`/`municipio_geo`/RPCs/`cep_geo_upsert`).

- **`cep_geo`** — PK `cep` (8 díg), `lat`/`lng`, `precision`, `source`, `uf`, `updated_at`. **SoT de coordenada por CEP**, 1 writer gated. RLS + `REVOKE FROM PUBLIC, anon`.
- **`municipio_geo`** — centróides oficiais por município (5.440 linhas), fallback grosso.
- **RPCs `carteira_por_municipio` / `radar_prospects_para_rota`** — resolvem `lat/lng` via `COALESCE(cep_geo, re.lat legado, centróide do município)` + devolvem `precision`.
- **`cep_geo_upsert`** — `SECURITY DEFINER`, gate `pode_ver_carteira_completa` (gestor/master), **idempotente + anti-downgrade** (`rank_precisao`: rooftop=4 > street=3 > postcode_centroid=2 > city_centroid=1; nunca rebaixa uma coord melhor que já exista).
- ⚠️ **`precision` é palavra reservada** no PG em `RETURNS TABLE` → citar como `"precision"`.

## Sub-PR 2 — Front (✅ merged [#884](https://github.com/LucasSardenbergL/afiacao/pull/884); ⏳ falta Publish)

Worker do mapa geocodifica o **CEP DISTINTO** (dedup 1.234 alvos ≈ 574 CEPs) e pinta **todos os alvos do mesmo CEP** de uma vez; carteira/prospects **não geocodificam mais in-memory** (adotam `lat/lng/precision` das RPCs).

- **`normalizarCep`** (puro, TDD) — 8 díg ou `null`.
- **`precisaoVisual`** (puro, TDD) — **fonte única** do "é aproximado?": `aproximado = !{rooftop,street,postcode_centroid}` → pino **oco/tracejado + "aprox."** (pino E chip da fila). `city_centroid`/`unknown` = aproximado.
- **`ordenarFilaGeocodeCep`** (puro, TDD) — fila por CEP, **marcados-na-rota primeiro**, dedup por CEP, re-derivada a cada ciclo (marcar um alvo re-prioriza o próximo pick; resolvidos/falhados saem → o loop termina).
- Mappers (`carteira-stop`/`prospect-stop`) adotam `temGeo = lat!=null && lng!=null` + `precisao` (removido `buildGeocodeQuery` órfão).

## Sub-PR 3 — Gate + edge-proxy + import da carteira (✅ merged [#891](https://github.com/LucasSardenbergL/afiacao/pull/891); ⏳ falta deploy edge + secret + Publish)

### Gate de medição (decidiu importar o CEP Aberto)
Núcleo TDD `src/lib/cep/medicao.ts` (haversine + cobertura + amostra estratificada determinística) + runner `scripts/cep-aberto/medir.ts`. Referência de "cidade certa" = **centróide IBGE oficial** (CSV kelvins, chave IBGE 7 díg = `cidade.ibge` da própria API). **Pivot**: Nominatim **descartado como referência** — não resolve CEP nu brasileiro (devolveu lixo, 5.850 km). Pacing **1,6 s/req** (429 abaixo disso). **Resultado (amostra 540 CEPs, 27 UFs): cobertura 91,5% · 98% na cidade certa (≤50 km do centróide) · mediana 3,9 km · p90 13 km · 0 erro.** Veredito: **vale importar**.

### 2ª opinião (Codex consult) → Caminho A + edge-proxy
229.107 CEPs distintos (228.605 prospects + 1.283 carteira); 229k via API por-CEP = ~102 h = **caminho morto**. Codex (e eu) convergimos em **A**: publicar #884 + importar a carteira agora (viável, 1.283 ≈ 35 min → SQL colável) + prospects no orgânico + **bulk completo adiado** (só via dump/arquivo limpo, nunca API por-CEP). Codex apontou o **edge-proxy** como maior ROI antes de qualquer bulk.

### Edge-proxy `cep-geo-resolver` (a peça shippable)
O worker do campo deixa de chamar o Nominatim **no browser** e passa a invocar a edge `supabase/functions/cep-geo-resolver` (Deno; gate `authorizeCronOrStaff` + `corsHeaders` do `_shared/auth.ts`; secret **`CEP_ABERTO_TOKEN`** server-side). Cadeia: **`cep_geo` cache (SoT) → CEP Aberto → não-resolvido**. Persiste via `cep_geo_upsert` **reencaminhando o JWT do staff** (anti-downgrade, **zero migration nova**). Miss/429/timeout → não-resolvido → o pino fica no **centróide do município** (a RPC já faz COALESCE) — aproximado honesto.

- **Desvio consciente do esboço do Codex:** **tirei o Nominatim da cadeia do CEP**. O gate provou que ele devolve lixo p/ CEP nu; o centróide do município é um fallback *aproximado honesto*, não um pino errado (precisão > recall). Nominatim segue só no **modo equipe** (endereço completo).
- **`interpretarResolver`** (puro, TDD — 8 testes) — **guard money-path**: só adota a coord se a edge disse `resolved:true` **E** `lat/lng` são números **finitos** (sem coerção string→número; ausente ≠ zero; nunca fabrica pino). Default `postcode_centroid`; preserva precisão melhor vinda do cache (ex.: rooftop).
- Worker: pacing **1,6 s** no campo (rate-limit CEP Aberto), 1,1 s no equipe; precisão preservada no cache de sessão.

### Import da carteira (SQL colável, idempotente)
Runner `scripts/cep-aberto/importar-carteira.ts` (token só via env, **nunca commitado**; pace 1,6 s + retry/backoff). 1.283 CEPs distintos → **1.204 hits (93,8%) · 79 miss · 0 erro** → `INSERT ... ON CONFLICT` anti-downgrade (`rank_precisao`) + `SELECT` de verificação; 90 KB / 1.204 linhas. Os 79 misses (6,2%) resolvem sozinhos depois via edge-proxy na 1ª visita.

### Estado de deploy (founder, MANUAL — `merge ≠ prod`)
1. Secret **`CEP_ABERTO_TOKEN`** no Supabase. 2. Deploy da edge **`cep-geo-resolver`** pelo chat do Lovable. 3. **Publish** do front (#884 + #891). 4. Colar o SQL da carteira no SQL Editor. Sem (1)+(2), o campo **degrada para centróides** (não quebra). Verificável por psql-ro: `cep_geo` crescendo com `source='cep_aberto'`.

## 🔑 Lições

1. **`precision` é reservado no PG** (`RETURNS TABLE`) → `"precision"` entre aspas.
2. **Ausente ≠ zero (money-path):** `interpretarResolver` só adota `lat/lng` **finitos**, sem coerção — miss vira `null`/centróide aproximado, **nunca um número fabricado**. Mesma disciplina do pino honesto (`precisaoVisual`).
3. **Nominatim não resolve CEP nu brasileiro** (lixo, milhares de km). Referência de gate confiável = **containment por município IBGE** (`cidade.ibge` da API → centróide oficial). Não usar Nominatim como verdade de CEP.
4. **Edge Deno não importa de `src/`** — a lógica testável (parser/guard) fica no cliente (`interpretarResolver`, em vitest); a edge não entra no lint/typecheck do CI (`eslint.config.js`/`tsconfig.app.json` escopados a `src/`).
5. **Reusar o writer gated server-side via JWT-forward** — a edge reencaminha o JWT do staff e chama o `cep_geo_upsert` existente (anti-downgrade, gate), em vez de criar RPC nova ou escrever direto. Gate na fronteira (`authorizeCronOrStaff`) + escrita com a identidade do usuário.
6. **Bulk por-CEP via API = caminho morto** (229k = 102 h, frágil/rate-limited). Bulk só via dump/arquivo limpo; o **orgânico (edge-proxy on-demand) + import da carteira** entregam o valor sem o bulk.
7. **SoT de coordenada por CEP = `cep_geo`, 1 writer** — todos os caminhos (Sub-PR 2 cliente, edge-proxy, import da carteira) convergem nele com anti-downgrade; snapshots derivados (mapa) saem dele por COALESCE.
