# PCP Fase 2A — Custo-padrão & fila de exceções — Implementation Plan (v3)

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development (task-a-task). Steps em checkbox.
> Baseado na spec `docs/superpowers/specs/2026-07-06-pcp-fase2a-custo-design.md` (v2) + **Task 0 empírico** + **painel tri-modelo sobre o plano v2** (`scratchpad/painel-2a-plano/agregacao.md` — BLOCK: 4 P1).
> **v3** — incorpora as correções do painel: classe_causa cruza a 1A (não fabrica "erro de receita"), fila NÃO esconde incompletos/sem-nCMC, view sem vazamento, data-posição validada, RLS enabled (não forced — forced trava o writer), versão na chave, jsonb com contrato, tolerância saneada, conta em config. **Escopo (decisão founder): LIXA (cinta/disco/folha/rolo); tingidor FORA da fila** (Tingimix tem custeio próprio — F2 tardia). Money-path → prova PG17 executando + falsificação. SQL no SQL Editor; NUNCA em supabase/migrations/.

**Goal:** custo-padrão de material por SKU fabricado (Σ componentes × CMC vigente, por bucket, ausente→NULL), **versionado**, + **fila de exceções** priorizada por R$ que **inclui os incompletos/sem-custo** (visibilidade), com **classe de causa provada** (cruza `pcp_bom_excecoes` da 1A), comparando na **mesma data-posição**. Sem escrever no Omie (2B).

**Architecture:** `pcp_custo_padrao_resultados` (1-writer, chave inclui `versao_regra`) + `pcp_custo_excecoes` (fila derivada, inclui lixa incompleta/sem-nCMC). Leitura de CMC data-aware (`fn_pcp_cmc_vigente`, conta de `pcp_config`, INVOKER). Motor **set-based** (`fn_pcp_recompute_custo_padrao`) + derivador (`fn_pcp_recompute_excecoes`), staff-gated. Reusa `fn_pcp_papel_componente` (1A), `pcp_malha_staging.payload->itens`, `pcp_itens.tipo_item`, `pcp_bom_excecoes.pai_codigo`.

**Fora de escopo:** outbox/escrita Omie, backflush, veículo do desvio (2B); tingidor (custeio próprio); MOD/GGF por tempo (F3+); virar fonte na escada `cost_source`.

---

## Task 0: Sonda empírica — ✅ EXECUTADA (achados cravados)

- **Policy `cmc_snapshot`:** `select_staff: employee OR master` → **staff-only** ✅. `fn_pcp_cmc_vigente` INVOKER protege o custo.
- **Colunas `cmc_snapshot`:** `id, account, omie_codigo_produto, data_posicao, cmc, synced_at`. Sem unidade — CMC é R$/unidade-de-estoque (`omie_products.unidade`).
- **`unidProdMalha` vs `omie_products.unidade`:** **6732/6732 batem, 0 divergem** ⇒ custo = `qtd × CMC` **sem conversão**; `pcp_custo_unidade` vira **guard defensivo** (nunca dispara hoje).
- **Fabricados (com estrutura):** cinta 1407 · disco 248 · rolo 123 · tingidor 111 · folha 51. **Lixa = cinta/disco/folha/rolo** (escopo); tingidor fora.
- **`pcp_bom_excecoes`:** liga por **`pai_codigo` = SKU acabado**; `status`, `disposicao`. **166 SKUs com exceção viva** (0 dispostas) — o oráculo de "receita suspeita".
- **`percPerdaProdMalha`:** único ≠0 = `0.6`; perda NÃO aplicada (linhagem bateu 50% ao centavo sem ela); teste compara com/sem.
- **`data_posicao` mais recente:** `2026-06-15` (grade mensal, histórico ≥2 datas p/ drift).

---

## Task 1: Schema — resultados versionados + fila inclusiva

**Files:** Create `db/pcp-f2a-custo.sql`

- [ ] **Step 1: cabeçalho + config**

```sql
-- PCP Fase 2A — custo-padrão de material (LIXA) + fila de exceções (vs CMC colacor_vendas).
-- Custo = Σ(componente: quantProdMalha × CMC) na MESMA data-posição. Ausente=NULL. Sem escrita Omie (2B).
-- Aplicar no SQL Editor. NUNCA em supabase/migrations/. Idempotável.
BEGIN;
INSERT INTO pcp_config(chave,valor) VALUES ('custo_cmc_account','colacor_vendas') ON CONFLICT (chave) DO NOTHING;
INSERT INTO pcp_config(chave,valor) VALUES ('custo_versao_regra','1')            ON CONFLICT (chave) DO NOTHING;
INSERT INTO pcp_config(chave,valor) VALUES ('custo_tolerancia_pct','0.05')       ON CONFLICT (chave) DO NOTHING;
INSERT INTO pcp_config(chave,valor) VALUES ('custo_drift_pct','0.10')            ON CONFLICT (chave) DO NOTHING;
```

- [ ] **Step 2: `pcp_custo_padrao_resultados` (versão na chave — Codex P2-6)**

```sql
CREATE TABLE IF NOT EXISTS public.pcp_custo_padrao_resultados (
  omie_codigo_produto bigint NOT NULL,
  data_posicao        date   NOT NULL,
  versao_regra        text   NOT NULL,          -- de pcp_config; regra nova NÃO sobrescreve
  tipo_item           text,                     -- pcp_itens.tipo_item (segrega lixa × resto)
  custo_abrasivo numeric, custo_cola numeric, custo_catalisador numeric, custo_fita numeric,
  custo_outros   numeric,                        -- material fora dos 4 papéis (não some)
  custo_total    numeric,                        -- NULL se custo_status<>'ok'
  custo_status   text NOT NULL CHECK (custo_status IN ('ok','incompleto','unidade_divergente','ambiguo')),
  n_componentes int NOT NULL, n_incompletos int NOT NULL,
  detalhe jsonb, derivado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (omie_codigo_produto, data_posicao, versao_regra)
);
```

- [ ] **Step 3: `pcp_custo_excecoes` (fila — INCLUI incompletos/sem-nCMC; lados NULLABLE — Codex/Gemini P2-5)**

```sql
CREATE TABLE IF NOT EXISTS public.pcp_custo_excecoes (
  omie_codigo_produto bigint NOT NULL,
  data_posicao        date   NOT NULL,
  versao_regra        text   NOT NULL,
  tipo_item           text,
  custo_padrao_total  numeric,                   -- NULL quando cmc_incompleto
  ncmc_acabado        numeric,                   -- NULL quando ncmc_ausente
  divergencia_abs     numeric,                   -- NULL quando falta um lado
  divergencia_pct     numeric,
  impacto_r           numeric NOT NULL,          -- coalesce(divergencia_abs, custo_padrao_total, ncmc) — ordena TUDO
  classe_causa text NOT NULL CHECK (classe_causa IN
    ('possivel_erro_receita','drift_preco_provavel','causa_indeterminada',
     'material_fora_bucket','cmc_incompleto','ncmc_ausente')),
  custo_status text NOT NULL, derivado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (omie_codigo_produto, data_posicao, versao_regra)
);
CREATE INDEX IF NOT EXISTS idx_pcp_custo_exc_imp ON public.pcp_custo_excecoes (impacto_r DESC);
```

---

## Task 2: CMC vigente (conta de config, ausente→NULL) + helper de data + cobertura

**Files:** Modify `db/pcp-f2a-custo.sql`

- [ ] **Step 1: `fn_pcp_cmc_vigente(p_cod, p_data_posicao, p_permitir_anterior=false)`** — conta lida de `pcp_config` (`custo_cmc_account`), não hardcoded (Gemini P2-10). INVOKER; ausente→NULL; sem fallback salvo `p_permitir_anterior`.

```sql
CREATE OR REPLACE FUNCTION public.fn_pcp_cmc_vigente(
  p_cod bigint, p_data_posicao date, p_permitir_anterior boolean DEFAULT false)
RETURNS numeric LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT cmc FROM cmc_snapshot
   WHERE omie_codigo_produto = p_cod
     AND account = (SELECT valor FROM pcp_config WHERE chave='custo_cmc_account')
     AND cmc > 0
     AND (data_posicao = p_data_posicao OR (p_permitir_anterior AND data_posicao <= p_data_posicao))
   ORDER BY data_posicao DESC LIMIT 1;
$$;
```

- [ ] **Step 2: `fn_pcp_ultima_data_posicao()`** → `max(data_posicao)` do CMC da conta (helper de deploy — evita data hardcoded fora da grade, Codex P1-4).

- [ ] **Step 3: `vw_pcp_cmc_cobertura` com `security_invoker` (Codex P1-3 — não vazar)**

```sql
CREATE OR REPLACE VIEW public.vw_pcp_cmc_cobertura WITH (security_invoker = true) AS
  SELECT i.tipo_item,
         count(*) AS fabricados,
         count(*) FILTER (WHERE fn_pcp_cmc_vigente(m.omie_codigo_produto,(SELECT fn_pcp_ultima_data_posicao())) IS NOT NULL) AS com_cmc
    FROM pcp_malha_staging m JOIN pcp_itens i ON i.omie_codigo_produto=m.omie_codigo_produto
   GROUP BY i.tipo_item;
REVOKE ALL ON public.vw_pcp_cmc_cobertura FROM anon, authenticated;
GRANT SELECT ON public.vw_pcp_cmc_cobertura TO authenticated;  -- security_invoker => RLS do cmc_snapshot barra não-staff
```

---

## Task 3: Motor do custo-padrão — SET-BASED, jsonb com contrato, ausente→NULL

**Files:** Modify `db/pcp-f2a-custo.sql`

- [ ] **Step 1: `fn_pcp_recompute_custo_padrao(p_data_posicao date)`** — SECURITY DEFINER, staff-gate (`auth.uid()` + has_role master|employee), `SET search_path=public`.
  - **Validar data-posição** (Codex P1-4): `IF NOT EXISTS(SELECT 1 FROM cmc_snapshot WHERE account=<config> AND data_posicao=p_data_posicao) THEN RAISE EXCEPTION 'data-posição % inexistente na grade CMC'`.
  - **Contrato jsonb** (Codex P2-8): só processa `WHERE jsonb_typeof(payload->'itens')='array'`; SKU com itens ausente/objeto ⇒ `custo_status='ambiguo'`, custo_total NULL (não aborta, não fabrica).
  - **Motor set-based** (Codex/Claude P3) — `INSERT...SELECT` com CTEs:
    ```
    comp:   pcp_malha_staging × LATERAL jsonb_array_elements(payload->'itens') → cod, qtd(::numeric seguro), uom
    enrich: LEFT JOIN omie_products (unidade), fn_pcp_cmc_vigente(cod,p_data) AS cmc, fn_pcp_papel_componente(...) AS papel
    calc:   custo = CASE WHEN cmc IS NULL THEN NULL                       -- incompleto
                        WHEN uom_estoque IS NOT NULL AND uom<>uom_estoque THEN NULL  -- guard unidade
                        ELSE qtd*cmc END ; flags falta_cmc, unidade_diverge
    agg:    GROUP BY sku → sum(custo) FILTER por papel (abrasivo/cola/catalisador/fita/outros),
            n_comp, n_falta, n_div, jsonb_agg(detalhe)
    ```
    `custo_status` = `unidade_divergente` se n_div>0; `incompleto` se n_falta>0; `ambiguo` se itens não-array; senão `ok`. `custo_total` = Σ buckets **só se ok**, senão NULL. **Somar TODOS os componentes de cada papel** (não "canônico"). `tipo_item` de pcp_itens. Upsert por PK `(sku,data,versao)` (versão de config).
- [ ] **Step 2:** cola/catalisador (consumível indireto, spec §1.5): custo já sai de `qtd×CMC` da estrutura; **não** re-derivar por coeficiente. Fator de perda de mistura (se o founder der o número) multiplicaria a `qtd` da cola, de fonte independente, **nunca** calibrado pela divergência (Codex J). Ponto aberto — não implementar sem número.

---

## Task 4: Fila de exceções — inclusiva, temporal-coerente, classe PROVADA

**Files:** Modify `db/pcp-f2a-custo.sql`

- [ ] **Step 1: `fn_pcp_recompute_excecoes(p_data_posicao date)`** — staff-gated. Opera **só sobre LIXA** (`tipo_item IN ('cinta','disco','folha','rolo')` — tingidor fora, decisão founder). Para cada SKU de lixa em `_resultados` da data/versão:
  - **nCMC do acabado** = `fn_pcp_cmc_vigente(sku, p_data_posicao)` (mesma data — coerência temporal, Codex/Gemini B).
  - **Classe (precedência — não esconder o pior caso):**
    1. `custo_status='incompleto'` ⇒ **`cmc_incompleto`** (entra na fila; total NULL; `impacto_r = coalesce(custo_parcial, nCMC)`). Codex/Gemini P2-5.
    2. senão `custo_status='ok'` E `nCMC IS NULL` ⇒ **`ncmc_ausente`** (produto ativo NÃO custeado; `impacto_r = custo_total`). Gemini P2.
    3. senão (`ok` + nCMC): `div_abs=abs(total-nCMC)`, `div_pct=div_abs/NULLIF(nCMC,0)` (Codex P3). Só segue se `div_pct > tolerancia` (config, saneada).
       - `custo_outros>0` ⇒ **`material_fora_bucket`** (componente não-lixa numa receita de lixa — genuíno agora que tingidor saiu).
       - senão `pai_codigo ∈ pcp_bom_excecoes (status='excecao', disposicao vazia)` ⇒ **`possivel_erro_receita`** PROVADO (Codex P1-1 + Claude). A 1A é o oráculo de "estrutura suspeita".
       - senão ≥2 datas-posição de CMC com Δ componente > `custo_drift_pct` ⇒ **`drift_preco_provavel`**.
       - senão ⇒ **`causa_indeterminada`** (default HONESTO — nunca acusa receita sem oráculo).
  - Upsert idempotente; ordena por `impacto_r DESC`.
- [ ] **Step 2:** limpar da fila (mesma data/versão) o que saiu da banda/regularizou (sem fila fantasma).
- [ ] **Step 3: `vw_pcp_custo_calibracao`** (Codex P2-9) — a distribuição de `div_pct` **só sobre dado saneado** (`custo_status='ok'`, `custo_outros=0` ou NULL, `nCMC` presente, sem exceção 1A) — a base para calibrar `custo_tolerancia_pct`. Materializada como view p/ o founder inspecionar antes de fixar a banda.

---

## Task 5: RLS enabled (NÃO forced) + grants

**Files:** Modify `db/pcp-f2a-custo.sql`

- [ ] **Step 1:** (Codex P2-7 — FORCE trava o writer DEFINER; enabled + policy staff + revoke DML basta)

```sql
ALTER TABLE public.pcp_custo_padrao_resultados ENABLE ROW LEVEL SECURITY;  -- NÃO force: o writer é a RPC DEFINER
ALTER TABLE public.pcp_custo_excecoes          ENABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS + CREATE staff-only (master|employee) SELECT em cada.
REVOKE ALL ON public.pcp_custo_padrao_resultados, public.pcp_custo_excecoes FROM anon, authenticated;
GRANT SELECT ON public.pcp_custo_padrao_resultados, public.pcp_custo_excecoes TO authenticated;  -- policy filtra
REVOKE ALL ON FUNCTION public.fn_pcp_recompute_custo_padrao(date), public.fn_pcp_recompute_excecoes(date)
  FROM PUBLIC, anon, authenticated;                    -- só staff/cron via SQL Editor
REVOKE ALL ON FUNCTION public.fn_pcp_cmc_vigente(bigint,date,boolean), public.fn_pcp_ultima_data_posicao() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_pcp_cmc_vigente(bigint,date,boolean) TO authenticated;  -- RLS do cmc barra
COMMIT;
```

---

## Task 6: Prova PG17 (propriedades + falsificação)

**Files:** Create `db/test-pcp-f2a-custo.sh`

Harness PG17; roles; stub `auth.uid()/has_role` staff `..aaaa`/não-staff `..bbbb`; stubs `cmc_snapshot` (policy staff-only), `omie_products`, `pcp_malha_staging`, `pcp_itens`, `pcp_config`, `pcp_bom_excecoes`, `fn_pcp_papel_componente`. Asserts:

- [ ] **1 custo simples** — abrasivo(2×10)+cola(3×5) → 20/15, total 35 (**total = Σ buckets**).
- [ ] **2 soma completa** — componente `outro` → `custo_outros` (não some).
- [ ] **3 ausente→NULL** — sem CMC ⇒ `incompleto`, total NULL (não 0).
- [ ] **4 guard unidade** — `unidProdMalha`≠estoque ⇒ `unidade_divergente`, total NULL.
- [ ] **5 multi-componente** — 2 abrasivos somam (não "canônico").
- [ ] **6 data-posição inválida ABORTA** (Codex P1-4) — recompute em data fora da grade ⇒ RAISE (não NULL em massa).
- [ ] **7 jsonb malformado** (Codex P2-8) — itens objeto/ausente ⇒ `ambiguo`, não aborta.
- [ ] **8 fila inclui incompleto** (P2-5) — SKU lixa incompleto ⇒ linha `cmc_incompleto` na fila (não some).
- [ ] **9 fila inclui sem-nCMC** — SKU lixa ok sem nCMC ⇒ `ncmc_ausente`.
- [ ] **10 classe PROVADA** (P1-1) — SKU lixa que diverge **com** exceção 1A ⇒ `possivel_erro_receita`; **sem** exceção 1A e sem drift ⇒ `causa_indeterminada` (NÃO erro_receita).
- [ ] **11 tingidor fora** — SKU tingidor NÃO entra na fila.
- [ ] **12 coerência temporal** — acabado sem nCMC na data ⇒ ncmc_ausente (não exceção falsa de divergência).
- [ ] **13 view não vaza** (P1-3) — não-staff: `SELECT count(*) FROM vw_pcp_cmc_cobertura` respeita RLS (0/erro).
- [ ] **14 RLS** — staff lê; não-staff 0 linhas; recompute não-staff barra.
- [ ] **15 versão não sobrescreve** (P2-6) — recompute versão '2' coexiste com '1'.
- [ ] **16 idempotência** — recompute 2× mesma data/versão ⇒ igual.
- [ ] **17 FALSIFICAÇÃO** (sabota→vermelho→reverte): `COALESCE(cmc,0)`→#3; remover guard→#4; só 1º componente→#5; tirar validação de data→#6; default `possivel_erro_receita` sem cruzar 1A→#10; `security_invoker`off→#13; INVOKER→DEFINER no cmc→#14. Documentar no cabeçalho.
- [ ] **18** `heavy bash db/test-pcp-f2a-custo.sh > /tmp/t-2a.log 2>&1; echo exit=$?` → `PASS=N FAIL=0`.
- [ ] **19 commit** `feat(pcp): F2A — custo-padrão lixa (estrutura×CMC) + fila classificada (cruza 1A, inclui incompletos) + RLS + prova PG17`.

---

## Task 7: Diário

- [ ] `docs/historico/pcp.md` seção "Fase 2A": 2 tabelas, reposicionamento (híbrido→fila classificada), Task 0 (6732/6732), painel (BLOCK 4 P1 → v3), escopo lixa, classe cruzando 1A, conta única, PASS=N.

---

## Deploy (founder, manual)
1. `db/pcp-f2a-custo.sql` no SQL Editor → Run (idempotável).
2. `SELECT fn_pcp_recompute_custo_padrao(fn_pcp_ultima_data_posicao());` depois `SELECT fn_pcp_recompute_excecoes(fn_pcp_ultima_data_posicao());`
3. Verificação minha (psql-ro): cobertura por tipo_item, top-10 fila por impacto_r, distribuição de classe_causa, ncmc_ausente, RLS.

## Self-Review (autor)
- **4 P1 resolvidos:** classe cruza 1A + default indeterminado (T4) · tingidor fora + família (T1/T4) · view security_invoker (T2) · data-posição valida/aborta (T3/T6#6).
- **7 P2/P3:** fila inclui incompletos/sem-nCMC (T1/T4) · versao_regra (T1) · RLS enabled não forced (T5) · jsonb contrato (T3) · calibração saneada (T4#3) · conta em config (T2) · set-based/NULLIF/guard (T3). Guard unidade mantido (0 casos hoje).
- **Escopo:** lixa; tingidor fora (decisão founder). **Pendências:** fator de perda (sem número → não implementado); calibração da tolerância (view pronta p/ o founder).
