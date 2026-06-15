# Geocoding por CEP em escala — Design (fundação + CEP Aberto gated)

**Data:** 2026-06-15 · **Status:** direção APROVADA pelo founder (Opção 2: fundação primeiro, CEP Aberto como fast-follow gated)
**Decisores:** founder (escopo/produto) · Claude (arquitetura) · Codex/gpt-5.x (2ª opinião — sessão `019ecd5d-26cb-7831-a087-d9d837615eda`)
**Tela alvo:** `/admin/route-planner` (contexto campo) — mas a fundação serve qualquer mapa do produto.

> Continuação do redesign "Visitas em campo" (4 sub-PRs entregues). No uso real, o founder viu o mapa "plotando lento". Diagnóstico: não é render (os clusters do #871 resolvem) — é **geocoding**.

---

## 1. Problema (dados reais de produção, lidos via read-only)

- **`radar_empresas`: 526.176 empresas, 0 geocodificadas** (`geocode_status` 100% null). O `.slice(0,15)` histórico (removido no #871) fazia só ~15/sessão persistirem.
- **99,98% têm CEP válido** · **228.605 CEPs DISTINTOS** no Brasil (2,3 empresas/CEP). Divinópolis: 960 empresas / 574 CEPs.
- **Carteira `addresses`: 4.060 clientes, 98,1% com CEP válido** (3.983), mas **sem colunas de geo** → re-geocodifica em memória a cada abertura.
- **Gargalo único: Nominatim público a 1 req/s** (política OSM: scripts longos caem a 4 req/min, bulk desencorajado). 228k CEPs ÷ 1/s ≈ 63h — inviável no público.

## 2. Decisão de arquitetura

**`cep_geo` é a fonte única de verdade (SoT) de coordenada por CEP.** Prospects (`radar_empresas.cep`) e carteira (`addresses.zip_code`) fazem **JOIN por CEP normalizado** — nunca geocodificam por empresa, nunca ao abrir a tela. Geocodifica-se o **CEP distinto** (228k, não 526k), uma vez, e persiste.

Faseamento (decisão do founder, validada pelo Codex):
- **Fundação agora (este design):** `cep_geo` + `municipio_geo` + RPCs com JOIN + fallback + lazy por CEP. Grátis, OSM, zero dep externa.
- **Fast-follow GATED:** bulk do **CEP Aberto** (1,1M CEPs, ODbL) no `cep_geo` → 1ª visita também instantânea. **Só depois de medir cobertura** contra os 228k CEPs (Codex: "base colaborativa, meça antes de confiar").

Veredito do Codex (verbatim no chat): *"Perseguir rooftop agora é overengineering. CEP centróide com `confidence` resolve 80-95% do valor com muito menos risco."* — **precisão de CEP basta para rota de visita; rooftop fica para exceções.**

## 3. Modelo de dados (migrations manuais via Lovable SQL Editor)

```sql
-- Coordenada por CEP (SoT). PK = CEP de 8 dígitos normalizado.
cep_geo (
  cep              text PRIMARY KEY,           -- CHECK (cep ~ '^[0-9]{8}$')
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  source           text NOT NULL,              -- 'cep_aberto' | 'osm' | 'nominatim' | 'municipio'
  precision        text NOT NULL,              -- 'rooftop'|'street'|'postcode_centroid'|'city_centroid'|'unknown'
  confidence       numeric,                    -- 0..1, opcional
  municipio_codigo text, uf text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  raw              jsonb
)
-- Centróide de município (fallback). Fonte: malha/centroides IBGE (grátis, 5.570 linhas).
municipio_geo ( municipio_codigo text PRIMARY KEY, lat double precision, lng double precision,
  uf text, nome text, source text DEFAULT 'ibge' )
```

- **`addresses` NÃO ganha colunas de geo no v1** — casa no `cep_geo` pelo `zip_code` normalizado (98,1% cobertos). `addresses.lat/lng` rooftop para clientes estratégicos = **v1.1** (YAGNI agora).
- **RLS:** ambas as tabelas novas COM RLS. `cep_geo`/`municipio_geo` são referência → `GRANT SELECT TO authenticated`; escrita só via RPC `SECURITY DEFINER` (gate `authorizeCronOrStaff`) ou service role no edge. `REVOKE … FROM PUBLIC, anon`.

## 4. Cadeia de fallback (ordem de precisão — nunca "sumido")

1. **`cep_geo`** (source bom: rooftop/street/postcode_centroid).
2. **Lazy:** CEP ausente → geocodifica o **CEP** via Nominatim 1/s → persiste em `cep_geo` (`postcode_centroid`). Compartilhado por todas as empresas daquele CEP.
3. **`municipio_geo`** centróide (`city_centroid`) — fallback garantido por `municipio_codigo` (IBGE). O pino aparece, marcado como aproximado.
4. **Sem-coord** (CEP inválido E sem município) → fica na **lista** com aviso, fora do mapa.

**Regra anti-downgrade (idempotência):** ordem `rooftop > street > postcode_centroid > city_centroid`. `INSERT … ON CONFLICT (cep) DO UPDATE` **só sobrescreve se a nova precisão for ≥**. Nunca uma fonte pior apaga uma melhor.

## 5. Fluxo do mapa (novo)

- **RPCs `carteira_por_municipio` / `radar_prospects_para_rota`**: `LEFT JOIN cep_geo` por CEP normalizado, `COALESCE` com `municipio_geo` → devolvem `lat/lng/precision` **já resolvidos**. O front recebe coordenada pronta.
- **Front:** pinta os resolvidos na hora. Para CEPs ainda ausentes, o worker geocodifica **por CEP distinto** (não por empresa) a 1/s, persiste via RPC, e todos os alvos do CEP entram juntos. Chip "localizando N CEPs…" (evolução do chip do #871).
- **Precisão visível (money-path de confiança):** `precision='city_centroid'` pinta o pino como **aproximado** (oco/tracejado + "📍 aprox."). Ausente ≠ fabricar precisão — degrada honestamente.

## 6. Carga de dados — o nó operacional do Lovable

Escrita no banco = **SQL manual colado** pelo founder. Logo:
- **`municipio_geo` (5.570 linhas):** cabe num `INSERT` gerado (eu gero o SQL dos centróides IBGE; founder cola) **ou** edge function. Uma vez.
- **`cep_geo` lazy:** cresce sozinho via RPC (por CEP), sem carga manual.
- **`cep_geo` bulk (CEP Aberto, fast-follow):** **NÃO colável** (1,1M linhas) → **edge function** que baixa o dump e insere em batches com `waitUntil`/retry (precedente direto: `radar-ingest` dos 526k). Staging + `ON CONFLICT` + anti-downgrade.

## 7. Gate do fast-follow (CEP Aberto)

Antes de importar 1,1M linhas às cegas: um passo de **medição** (edge function/script):
1. Baixa o dump CEP Aberto.
2. `% matched` contra os 228.605 CEPs distintos nossos.
3. Amostra 200 CEPs/UF, mede erro visual (distância do centróide ao real).
**Só importa se cobertura + precisão passarem.** Licença **ODbL**: atribuição; uso interno B2B = baixo risco (atribuir se um dia expuser publicamente).

## 8. Módulos (isolados e testáveis)

- **SQL puro (PG17 `db/test-*.sh`):** `normalizar_cep()` imutável; upsert `cep_geo` idempotente + anti-downgrade; RPCs de leitura com `COALESCE` fallback; gate RLS sob `SET ROLE authenticated`.
- **Helpers puros (vitest, `src/lib/route/`):** `normalizarCep(raw)`, `precisaoVisual(precision) → {estilo, rotulo}` (pino oco/tracejado p/ aproximado), `ordenarFilaGeocodeCep(stops, estado)` — evolução do `ordenarFilaGeocode` atual, agora **deduplicando por CEP distinto** (marcados primeiro).
- **Edge function:** carga `municipio_geo` (IBGE) e, no fast-follow, import + medição do CEP Aberto.

## 9. Faseamento (sub-PRs, cada um verde e mergeável)

1. **Banco:** `cep_geo` + `municipio_geo` + carga IBGE + RPCs `carteira/prospects` com JOIN+COALESCE + `normalizar_cep` + upsert idempotente. Validação PG17 (prove-sql) + apply manual (lovable-db-operator).
2. **Front:** worker geocodifica por **CEP distinto** + persiste + cadeia de fallback + `precision` no pino + chip "N CEPs". Para de re-geocodificar a carteira. (Helpers puros TDD.)
3. **Fast-follow (gated):** medir cobertura CEP Aberto → edge function de import bulk → re-medir. Só se passar.

## 10. Fora de escopo (YAGNI)

Rooftop universal · Nominatim self-hosted · geocoder pago · `addresses.lat/lng` rooftop (v1.1) · geocoding por viewport · re-priorização dinâmica da fila em voo. Cada um vira follow-up sob demanda real.

## 11. Invariantes e armadilhas (não-negociáveis)

- **Banco só Lovable SQL Editor**; cargas grandes via **edge function** (não colar 1,1M). RPC `SECURITY DEFINER` com gate avaliado 1× no topo. Tabela nova **sempre** com RLS + `REVOKE FROM PUBLIC, anon`.
- **Idempotência:** staging + `ON CONFLICT` + **anti-downgrade** de precisão. Rodar a carga 2× = mesmo estado.
- **Nominatim:** geocodificar **CEP distinto**, nunca empresa, **nunca** bulk nacional no público (1/s, política). Persistir sempre.
- **Precisão honesta:** `city_centroid` é VISÍVEL como aproximado — não fabricar precisão (degradar, não mentir).
- **`useFarmerScoring` intocado** (money-path). **OSM/grátis**; Google pago FORA.
- Antes de tocar a RPC viva: `pg_get_functiondef` da prod (apply manual diverge do repo); VIEW/RPC só acrescenta no fim.

## 12. Testes

- **PG17 (prove-sql-money-path):** upsert idempotente (2× = igual); anti-downgrade (`street` não vira `city_centroid`); RPC `COALESCE` fallback correto (CEP → município → null); `normalizar_cep` (acento/espaço/8díg); gate RLS nega não-staff. Falsificação (sabotar → vermelho).
- **Vitest:** `normalizarCep`, `precisaoVisual`, `ordenarFilaGeocodeCep` (dedup por CEP, marcados primeiro).
- **Manual no device:** 2ª visita à cidade instantânea; chip "N CEPs"; pino aproximado visível; cidade nunca aberta cai no centróide do município.

## 13. Métrica de sucesso

1ª visita a uma cidade: de ~20 min (1.234 empresas × 1/s) para **~10 min (574 CEPs)** e **background**; **2ª visita: instantânea** (cache permanente). Carteira: **para de desperdiçar** geocode a cada abertura. Com o fast-follow do CEP Aberto: **1ª visita também instantânea** em qualquer praça.
