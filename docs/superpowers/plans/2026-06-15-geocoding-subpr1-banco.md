# Geocoding por CEP — Sub-PR 1 (Banco) — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Banco: cada SQL passa por **prove-sql-money-path** (PG17 local + falsificação) ANTES, e o handoff de apply via **lovable-db-operator** (founder cola no SQL Editor — migration custom NÃO auto-aplica). Steps usam checkbox.

**Goal:** Fundação de geocoding por CEP no banco: `cep_geo` (SoT de coordenada por CEP) + `municipio_geo` (centróides IBGE p/ fallback) + RPCs de leitura que entregam coordenada já resolvida via JOIN — sem geocoding em tempo real ao abrir a tela.

**Architecture:** `cep_geo(cep PK)` e `municipio_geo(municipio_codigo PK)` como tabelas de referência (RLS, SELECT p/ authenticated, escrita só via RPC `SECURITY DEFINER`/service role). `normalizar_cep()` imutável. Upsert idempotente com **anti-downgrade** de precisão. As RPCs `carteira_por_municipio` e `radar_prospects_para_rota` ganham `LEFT JOIN cep_geo` + `COALESCE` com centróide de `municipio_geo`, devolvendo `lat/lng/precision`.

**Tech Stack:** PostgreSQL 17 (Supabase/Lovable Cloud) · prove-sql-money-path (harness PG17 local) · lovable-db-operator (handoff). Sem código de front neste sub-PR.

**Base:** branch `claude/geocoding-cep-escala` ← `origin/main`. Spec: `docs/superpowers/specs/2026-06-15-geocoding-cep-escala-design.md`.

**Acesso:** Claude tem LEITURA direta (`~/.config/afiacao/psql-ro`) p/ pré-flight e verificação pós-apply; escrita é o founder colando SQL.

---

## File Structure

- **Create** `supabase/migrations/<ts>_geocoding_cep_geo.sql` — gerado pelo lovable-db-operator (versionamento; apply é MANUAL). Contém: `normalizar_cep`, `cep_geo`, `municipio_geo`, RLS/grants, `cep_geo_upsert`, e o `CREATE OR REPLACE` das 2 RPCs de leitura.
- **Create** `db/test-geocoding-cep.sh` — harness PG17 (prove-sql) que aplica a migration REAL, semeia e roda asserts (positivos + negativos + falsificação).
- **Create** `scripts/municipio-geo-insert.ts` (ou edge function) — gera o INSERT dos 5.570 centróides IBGE a partir de dataset aberto (founder cola, ou roda via service role).
- **Modify (pré-flight, não no repo):** ler `pg_get_functiondef` VIVO de `carteira_por_municipio` e `radar_prospects_para_rota` (apply manual diverge do repo — a def de PROD é a base do `CREATE OR REPLACE`).

**Invariantes:** tabela nova SEMPRE com RLS + `REVOKE FROM PUBLIC, anon`. RPC `SECURITY DEFINER` com gate 1× no topo. VIEW/RPC só ACRESCENTA coluna no fim (preservar ordem). `useFarmerScoring` intocado. Anti-downgrade de precisão. Idempotência (rodar 2× = igual).

---

### Task 1: `normalizar_cep` + tabelas `cep_geo`/`municipio_geo` + RLS (PG17 prove)

**Files:** `supabase/migrations/<ts>_geocoding_cep_geo.sql` (parte 1), `db/test-geocoding-cep.sh`

- [ ] **Step 1: SQL das tabelas + função** (escrever no arquivo de migration):

```sql
-- normalização canônica de CEP (imutável → usável em índice/generated)
CREATE OR REPLACE FUNCTION normalizar_cep(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(COALESCE(p,''), '\D', '', 'g'), '')
$$;

CREATE TABLE IF NOT EXISTS cep_geo (
  cep              text PRIMARY KEY CHECK (cep ~ '^[0-9]{8}$'),
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  source           text NOT NULL,
  precision        text NOT NULL CHECK (precision IN ('rooftop','street','postcode_centroid','city_centroid','unknown')),
  confidence       numeric,
  municipio_codigo text,
  uf               text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  raw              jsonb
);

CREATE TABLE IF NOT EXISTS municipio_geo (
  municipio_codigo text PRIMARY KEY,
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  uf               text,
  nome             text,
  source           text NOT NULL DEFAULT 'ibge'
);

ALTER TABLE cep_geo       ENABLE ROW LEVEL SECURITY;
ALTER TABLE municipio_geo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cep_geo, municipio_geo FROM PUBLIC, anon;
GRANT SELECT ON cep_geo, municipio_geo TO authenticated;
CREATE POLICY cep_geo_sel ON cep_geo FOR SELECT TO authenticated USING (true);
CREATE POLICY municipio_geo_sel ON municipio_geo FOR SELECT TO authenticated USING (true);
-- escrita: nenhuma policy de INSERT/UPDATE → só SECURITY DEFINER / service role.
```

- [ ] **Step 2: Harness PG17** — `db/test-geocoding-cep.sh` (prove-sql-money-path): sobe PG17 descartável, aplica a migration REAL, e testa: `normalizar_cep('35.500-000')='35500000'`, `normalizar_cep('')` IS NULL; `cep_geo` rejeita CEP de 7 dígitos (CHECK); `precision` inválida rejeitada.
- [ ] **Step 3: Rodar → verde.** `bash db/test-geocoding-cep.sh` (Expected: asserts de schema passam).
- [ ] **Step 4: Falsificar** — quebrar o CHECK do `precision` na migration, re-rodar, exigir VERMELHO; reverter.
- [ ] **Step 5: Commit** `feat(geocoding): cep_geo + municipio_geo + normalizar_cep + RLS`

---

### Task 2: `cep_geo_upsert` — idempotente + anti-downgrade + gate (PG17 prove)

**Files:** migration (parte 2), `db/test-geocoding-cep.sh`

- [ ] **Step 1: SQL do upsert** (SECURITY DEFINER, gate staff/cron, anti-downgrade):

```sql
CREATE OR REPLACE FUNCTION cep_geo_upsert(
  p_cep text, p_lat double precision, p_lng double precision,
  p_source text, p_precision text, p_confidence numeric DEFAULT NULL,
  p_municipio_codigo text DEFAULT NULL, p_uf text DEFAULT NULL, p_raw jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cep text := normalizar_cep(p_cep);
BEGIN
  -- gate 1× no topo (staff ou cron) — reusar o helper canônico do projeto
  IF NOT authorize_cron_or_staff((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_cep IS NULL OR v_cep !~ '^[0-9]{8}$' THEN RETURN; END IF;
  INSERT INTO cep_geo AS c (cep,lat,lng,source,precision,confidence,municipio_codigo,uf,raw,updated_at)
  VALUES (v_cep,p_lat,p_lng,p_source,p_precision,p_confidence,p_municipio_codigo,p_uf,p_raw, now())
  ON CONFLICT (cep) DO UPDATE
    SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, source=EXCLUDED.source, precision=EXCLUDED.precision,
        confidence=EXCLUDED.confidence, raw=EXCLUDED.raw, updated_at=now()
    WHERE rank_precisao(EXCLUDED.precision) >= rank_precisao(c.precision); -- anti-downgrade
END $$;

-- ordem de precisão (maior = melhor)
CREATE OR REPLACE FUNCTION rank_precisao(p text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'rooftop' THEN 4 WHEN 'street' THEN 3
    WHEN 'postcode_centroid' THEN 2 WHEN 'city_centroid' THEN 1 ELSE 0 END
$$;
REVOKE ALL ON FUNCTION cep_geo_upsert(text,double precision,double precision,text,text,numeric,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cep_geo_upsert(text,double precision,double precision,text,text,numeric,text,text,jsonb) TO authenticated;
```

> **Pré-flight:** confirmar o nome real do helper de gate (`authorize_cron_or_staff` vs `authorizeCronOrStaff` SQL) via `\df` no psql-ro antes de escrever.

- [ ] **Step 2: Asserts PG17** — idempotência (chamar 2× mesmo CEP `street` → 1 linha, igual); anti-downgrade (`street` gravado, depois `city_centroid` NÃO sobrescreve; depois `rooftop` SOBRESCREVE); upgrade atualiza `updated_at`; CEP lixo → no-op.
- [ ] **Step 3: Gate RLS** — `SET ROLE authenticated` + GUC sem staff → `cep_geo_upsert` levanta `42501`; com staff → ok. (psql é superuser, bypassaria → provar sob role.)
- [ ] **Step 4: Rodar → verde** + **Falsificar** (inverter o `>=` do anti-downgrade → exigir que o teste de downgrade fique VERMELHO; reverter).
- [ ] **Step 5: Commit** `feat(geocoding): cep_geo_upsert idempotente + anti-downgrade + gate`

---

### Task 3: RPCs de leitura — JOIN cep_geo + COALESCE municipio_geo (PG17 prove)

**Files:** migration (parte 3), `db/test-geocoding-cep.sh`

- [ ] **Step 1: Pré-flight** — `pg_get_functiondef` VIVO de `carteira_por_municipio` e `radar_prospects_para_rota` (psql-ro). A def de PROD é a base; preservar ordem das colunas, **acrescentar `lat,lng,precision` no FIM**.
- [ ] **Step 2: `CREATE OR REPLACE`** — em cada RPC, resolver coordenada por COALESCE (a coluna de CEP é `cep` no radar, `zip_code` na carteira):

```sql
-- padrão (aplicar à SELECT de cada RPC, preservando o resto da def viva):
LEFT JOIN cep_geo       cg ON cg.cep = normalizar_cep(<fonte>.<cep|zip_code>)
LEFT JOIN municipio_geo mg ON mg.municipio_codigo = <fonte>.municipio_codigo
-- colunas novas no fim do SELECT:
, COALESCE(cg.lat, mg.lat)                              AS lat
, COALESCE(cg.lng, mg.lng)                              AS lng
, COALESCE(cg.precision, CASE WHEN mg.lat IS NOT NULL THEN 'city_centroid' END) AS precision
```

> Carteira: `municipio_codigo` pode não existir em `addresses` — se faltar, resolver via `radar_municipios` por `norm(city,uf)` (mesmo padrão do Sub-PR 1 do redesign) ou deixar `precision=null` quando sem CEP nem município. Decidir no pré-flight conforme as colunas reais de `addresses`.

- [ ] **Step 3: Asserts PG17** — semear `cep_geo` + `municipio_geo` + linhas; provar: (a) CEP presente → coord do `cep_geo` + precision real; (b) CEP ausente mas município presente → centróide + `precision='city_centroid'`; (c) ambos ausentes → `lat/lng NULL`, `precision NULL`; (d) ordem das colunas preservada (nomes na posição esperada).
- [ ] **Step 4: Rodar → verde** + **Falsificar** (trocar `COALESCE` por só `cg.lat` → exigir que o teste do fallback de município fique VERMELHO; reverter).
- [ ] **Step 5: Commit** `feat(geocoding): RPCs carteira/prospects resolvem coord via cep_geo + municipio_geo`

---

### Task 4: Carga `municipio_geo` (centróides IBGE)

**Files:** `scripts/municipio-geo-insert.ts`

- [ ] **Step 1: Sourcing** — obter os 5.570 centróides com `codigo_ibge` (7 díg) + lat/lng de dataset aberto (ex.: `kelvins/municipios-brasileiros` CSV, licença permissiva). Via `/browse`/curl. **Verificar** que `codigo_ibge` casa com `radar_empresas.municipio_codigo` (amostra: Divinópolis 3122306).
- [ ] **Step 2: Gerar INSERT idempotente** — `INSERT INTO municipio_geo(...) VALUES ... ON CONFLICT (municipio_codigo) DO NOTHING;` (5.570 linhas → arquivo .sql; founder cola, OU edge function se grande demais).
- [ ] **Step 3: Verificação (pós-apply, psql-ro)** — `SELECT count(*) FROM municipio_geo;` ≈ 5.570; `SELECT lat,lng FROM municipio_geo WHERE municipio_codigo='3122306';` (Divinópolis ~ -20.13,-44.88).
- [ ] **Step 4: Commit** `feat(geocoding): carga municipio_geo (centróides IBGE)`

---

### Task 5: Handoff lovable-db-operator + PR + apply

- [ ] **Step 1: lovable-db-operator** — gerar: o arquivo de migration final (Tasks 1-3), o **bloco pronto pro SQL Editor**, a **query de validação pós-apply**, a nota pro PR, e regenerar o audit de schema.
- [ ] **Step 2: PR** — `gh pr create` não-draft. Corpo: o que cria (cep_geo/municipio_geo/RPCs), que **migration + carga são apply MANUAL** seu, e a query de validação. Marcar que **nada funciona em prod até aplicar** (migration custom não auto-aplica — falha silenciosa).
- [ ] **Step 3: Founder aplica** — colar a migration no SQL Editor + a carga `municipio_geo`. Eu **verifico via psql-ro** (tabelas existem, RPCs com `pg_get_functiondef`, contagem do município, um SELECT de RPC retornando coord).
- [ ] **Step 4: Roadmap no chat** — Sub-PR 1 (banco) ✅ → Sub-PR 2 (front: consumir coord + lazy por CEP + precisão visível).

---

## Self-Review (writing-plans)

1. **Cobertura do spec (§3-§5, §8, §11-12):** tabelas `cep_geo`/`municipio_geo` ✓ · `normalizar_cep` ✓ · upsert idempotente + anti-downgrade ✓ · RPCs JOIN+COALESCE ✓ · fallback município ✓ · RLS/gate ✓ · carga IBGE ✓ · PG17 prove + falsificação ✓ · handoff manual ✓. (Front = Sub-PR 2, fora.)
2. **Placeholders:** SQL concreto nas Tasks 1-2; Task 3 usa pré-flight da def viva (correto p/ apply-manual-diverge) + delta concreto; Task 4 nomeia dataset + município de verificação.
3. **Consistência de tipos:** `precision` enum idêntico em tabela/upsert/RPC/rank_precisao. `normalizar_cep` usada em upsert e nos JOINs. `cep`(radar)/`zip_code`(carteira) explicitados.
4. **Riscos/decisões abertas:** (a) nome real do helper de gate — pré-flight; (b) `addresses.municipio_codigo` pode faltar → resolver via `radar_municipios` no pré-flight; (c) sourcing IBGE — dataset nomeado, com verificação de match de código. Nenhum bloqueia o início (Task 1 é autocontida).
