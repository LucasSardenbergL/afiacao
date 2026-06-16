# Geocoding por CEP — Sub-PR 2 (front) Implementation Plan

> **For agentic workers:** executando INLINE (superpowers:executing-plans). Design aprovado em `docs/superpowers/specs/2026-06-15-geocoding-cep-escala-design.md` (§5, §8, §9). Sub-PR 1 (banco) já LIVE em prod (PR #876).

**Goal:** O roteirizador-campo consome `lat/lng/precision` já resolvidos pelas RPCs (Sub-PR 1), para de re-geocodificar a carteira em memória, e o worker geocodifica por **CEP distinto** (não por empresa) → `cep_geo_upsert`, pintando pino aproximado honesto para `city_centroid`.

**Architecture:** Helpers puros (TDD) + rewire do worker no `useRoutePlanner`. O worker do contexto **campo** (`prospeccao`) passa a deduplicar por CEP; o contexto **equipe** fica intocado (zero regressão). `precisaoVisual(precisao).aproximado` dirige ao mesmo tempo o estilo do pino E a inclusão na fila de geocode (city_centroid/unknown/null = aproximado → tenta upgrade por CEP; street/postcode/rooftop = bom → fora da fila).

**Tech Stack:** React 18 + TS strict + vitest. RPCs via `supabase.rpc(... as never)` (types.ts local stale — Lovable regenera). Nominatim 1/s (já existente). `cep_geo_upsert` persiste `postcode_centroid`.

---

## Invariantes (do design §11, não-negociáveis)

- **OSM/grátis**; Google pago FORA. `useFarmerScoring` **intocado**.
- Nominatim: geocodificar **CEP distinto**, nunca empresa, 1/s, **sempre persistir** (`cep_geo_upsert`).
- **Precisão honesta:** `city_centroid` é VISÍVEL como aproximado (pino oco/tracejado + "aprox.") — degradar, não fabricar.
- Equipe (`logistica/comercial/hibrido/manual`) = comportamento atual idêntico (worker por endereço preservado).
- Não baixar mais o `re.lat` legado: prospect com `precision='street'` (re.lat) NÃO entra na fila (não regredir pra postcode).

## Mapa de arquivos

- Create: `src/lib/route/cep.ts` (+ `.test.ts`) — `normalizarCep(raw)`.
- Modify: `src/lib/route/marker-visual.ts` (+ `.test.ts`) — `precisaoVisual(precisao)`.
- Modify: `src/lib/route/geocode-fila.ts` (+ `.test.ts`) — `ordenarFilaGeocodeCep(stops, estado)`.
- Modify: `src/lib/route/carteira-stop.ts` (+ `.test.ts`) — `CarteiraRow`/draft + adoção lat/lng/precision.
- Modify: `src/lib/route/prospect-stop.ts` (+ `.test.ts`) — `ProspectRow.precision` + adoção lat/lng (ungated).
- Modify: `src/components/reposicao/routePlanner/types.ts` — `RouteStop.precisao?` + tipo `Precisao`.
- Modify: `src/hooks/useRoutePlanner.ts` — worker CEP (prospeccao), carteira pré-resolvida, chip N CEPs, `cep_geo_upsert`.
- Modify: `src/pages/AdminRoutePlanner.tsx` — pino aproximado (`precisaoVisual`+`divIconAlvo`) + chip "N CEPs".

---

## T1 — `normalizarCep` (puro, TDD)

**Files:** Create `src/lib/route/cep.ts` + `src/lib/route/cep.test.ts`.

Espelha o SQL `normalizar_cep` (tira não-dígitos; vazio→null) E acrescenta a validade de 8 dígitos da PK `cep_geo` (CEP não-8 = não geocodificável → fora da fila/upsert).

- [ ] **Step 1: teste falhando** — `'35.500-001'→'35500001'`, `' 35500001 '→'35500001'`, `'123'→null`, `'355000012'(9)→null`, `''→null`, `null→null`, `undefined→null`.
- [ ] **Step 2: roda → falha** (`function not defined`).
- [ ] **Step 3: implementa** — `const d = (raw ?? '').replace(/\D/g, ''); return /^[0-9]{8}$/.test(d) ? d : null;`
- [ ] **Step 4: roda → passa.**
- [ ] **Step 5: commit.**

## T2 — `precisaoVisual` (puro, TDD)

**Files:** Modify `src/lib/route/marker-visual.ts` + `.test.ts`.

`precisaoVisual(precisao) → { aproximado: boolean; rotulo: string }`. `aproximado=true` para `'city_centroid'`/`'unknown'`/null/undefined (rotulo `'aprox.'`); `false` para `'rooftop'`/`'street'`/`'postcode_centroid'` (rotulo `''`). É o ÚNICO ponto de verdade do que é "aproximado" (pino E fila).

- [ ] **Step 1: teste falhando** — os 6+ casos acima.
- [ ] **Step 2: roda → falha.**
- [ ] **Step 3: implementa** o helper + `export type Precisao`.
- [ ] **Step 4: roda → passa.**
- [ ] **Step 5: commit.**

## T3 — `ordenarFilaGeocodeCep` (puro, TDD)

**Files:** Modify `src/lib/route/geocode-fila.ts` + `.test.ts`. Mantém `ordenarFilaGeocode` (equipe usa).

Dedup por CEP distinto. Pendente = `normalizarCep(zip)` válido E `precisaoVisual(precisao).aproximado` E cep ∉ resolvidos E cep ∉ falhados. Marcados-primeiro (CEP herda prioridade se QUALQUER stop dele está em `marcados`), depois ordem de 1ª aparição (estável). Devolve `CepPendente[] = {cep, cidade, uf}`.

- [ ] **Step 1: teste falhando** — dedup (3 stops/2 CEPs → 2), exclui precisão boa (street/postcode/rooftop), exclui resolvidos/falhados/cep-inválido, marcados-primeiro, estável.
- [ ] **Step 2: roda → falha.**
- [ ] **Step 3: implementa** `EstadoFilaCep` + `CepPendente` + função.
- [ ] **Step 4: roda → passa.**
- [ ] **Step 5: commit.**

## T4 — mappers adotam coord resolvida (TDD)

**Files:** Modify `carteira-stop.ts`/`.test.ts`, `prospect-stop.ts`/`.test.ts`, `types.ts`.

`CarteiraRow` += `lat/lng/precision` (RPC já devolve); `CarteiraStopDraft` += `lat?/lng?/precisao?`; `carteiraRowToStop` adota → **carteira vem pronta** (sem geocode em memória). `ProspectRow` += `precision`; `prospectRowToStopDraft` adota `row.lat/lng` **sempre que presentes** (não mais gated em `geocode_status='ok'` — a RPC já fez o COALESCE) + `precisao`. `RouteStop` += `precisao?: Precisao`.

- [ ] **Step 1: testes falhando** — carteira adota lat/lng/precisao; carteira sem coord (null) → undefined; prospect adota lat/lng do município (precision city_centroid) mesmo com `geocode_status` null; prospect street legado preserva.
- [ ] **Step 2: roda → falha.**
- [ ] **Step 3: implementa** as 3 mudanças.
- [ ] **Step 4: roda → passa.**
- [ ] **Step 5: commit.**

## T5 — hook: worker CEP + carteira pré-resolvida + chip N CEPs

**Files:** Modify `src/hooks/useRoutePlanner.ts`.

`loadCarteiraDaCidade`: base += `lat/lng/precisao` do draft (carteira deixa de depender do worker). `loadProspectStops`: base += `precisao`; cache de coord aceita as do RPC. Worker (efeito ~1/s): se `planningMode==='prospeccao'` → loop CEP via `ordenarFilaGeocodeCep`: query `"{cep}, {cidade}, {uf}, Brazil"`; hit → `cep_geo_upsert` (`postcode_centroid`) + patch de TODOS os stops com aquele CEP + `cepResolvidos.add(cep)`; miss → `cepFalhados.add(cep)`. `geocodingPendentes` = nº de CEPs distintos. Senão (equipe) → loop legado **idêntico**. Refs novos: `geocodedCepCoords` (cep→coord) reaplicado no efeito immediate-show; `cepResolvidos`/`cepFalhados`.

- [ ] **Step 1:** carteira mapper já entrega coord; remover dependência do worker pra carteira (vem do T4).
- [ ] **Step 2:** branch do worker por `planningMode`; loop CEP novo; equipe inalterado.
- [ ] **Step 3:** `cep_geo_upsert` (`as never`) no hit; patch same-CEP; chip = CEPs distintos.
- [ ] **Step 4:** `heavy bun run typecheck` verde.
- [ ] **Step 5: commit.**

## T6 — render: pino aproximado + chip "N CEPs"

**Files:** Modify `src/pages/AdminRoutePlanner.tsx` (e `divIconAlvo` onde estiver).

Campo: `const { aproximado } = precisaoVisual(stop.precisao)` → `divIconAlvo(tone, shape, numero, aproximado)` (oco/tracejado quando aproximado). Popup ganha "📍 aprox." quando aproximado. Chip: `localizando {geocodingPendentes} CEP{s>1?'s':''}…`.

- [ ] **Step 1:** `divIconAlvo` aceita `aproximado` (borda tracejada + fill translúcido).
- [ ] **Step 2:** consumir `precisaoVisual` no render + popup; chip "N CEPs".
- [ ] **Step 3:** `heavy bun run typecheck` + `bun lint` verdes.
- [ ] **Step 4: commit.**

## T7 — verde + PR

- [ ] `heavy bun run test` (suite toda) + `heavy bun run typecheck` + `bun lint` verdes.
- [ ] `bunx knip` (sem deadcode novo) se rápido.
- [ ] Auto-review do diff; push; abrir PR (não-draft → auto-merge no CI verde).
- [ ] Roadmap no chat: Sub-PR 2 ✅; handoff Sub-PR 3 (gated CEP Aberto).

## Verificação manual (founder, no device, pós-deploy front)

2ª visita à cidade instantânea; chip "N CEPs"; pino aproximado (oco) visível p/ centróide de município; carteira não re-geocodifica ao reabrir.
