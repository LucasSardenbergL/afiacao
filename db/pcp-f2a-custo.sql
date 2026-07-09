-- PCP Fase 2A — custo-padrão de material (LIXA) + fila de exceções classificada (vs CMC colacor_vendas).
-- Custo = Σ(componente: quantProdMalha × CMC) na MESMA data-posição. Ausente=NULL (NUNCA COALESCE(cmc,0)).
-- Sem escrita no Omie (2B). Aplicar no SQL Editor do Lovable (founder). NUNCA em supabase/migrations/. Idempotável (re-colar 2× = no-op).
--
-- Schemas REAIS (confirmados na sonda): pcp_config=(key text PK, value jsonb, updated_at); cmc_snapshot=(id,account,
--   omie_codigo_produto,data_posicao,cmc,synced_at); fn_pcp_papel_componente→abrasivo_base|cola|catalisador|fita|outro;
--   fn_pcp_num(text)→numeric (parser tolerante — reusado no cast do jsonb). Componente casado por idProdMalha→omie_products/cmc_snapshot.
--
-- Staff-gate das RPC de recompute: MESMO padrão da 1A (fn_pcp_refresh_itens/destilar_bom/materializar_excecoes):
--   SECURITY DEFINER + REVOKE ALL FROM PUBLIC,anon,authenticated (só owner/service-role/SQL Editor roda). SEM gate
--   auth.uid() interno (travaria o SQL Editor, onde auth.uid() é NULL). fn_pcp_cmc_vigente fica INVOKER (a policy
--   staff-only do cmc_snapshot é quem protege o custo — não vaza p/ não-staff).
--
-- FALSIFICAÇÃO PROVADA (test-pcp-f2a-custo.sh Step 17 — cada sabotagem→vermelho→revertida):
--   COALESCE(cmc,0)→#3 · remover guard unidade→#4 · sum→max(1 componente)→#5 · tirar validação de data→#6 ·
--   default possivel_erro_receita sem cruzar 1A→#10 · security_invoker=false→#13 · fn_pcp_cmc_vigente INVOKER→DEFINER→#14 ·
--   classe unidade_divergente/ambiguo→NULL (some da fila)→FIX1 · array vazio (itens=[]) tratado como ok→FIX7 (sem_estrutura some do motor+fila).
-- HARDENING (painel tri-modelo, sobre o código real): FIX1 fila inclui unidade_divergente/estrutura_ambigua (não somem) ·
--   FIX2 cmc sem linha em omie_products (unidade não confirmada)→incompleto · FIX3 quantProdMalha<=0→incompleto (não custeia 0) ·
--   FIX4 idProdMalha decimal/gigante→comp NULL (LEFT JOIN não acha CMC; NÃO aborta o recompute) · FIX5 fn_pcp_recompute_excecoes
--   valida config (versao/tol/drift) · FIX6 pg_advisory_xact_lock nas 2 RPC (padrão da 1B-M1 — DELETE+INSERT/upsert sem corrida) ·
--   FIX7 estrutura Omie vazia (itens=[] array vazio, 0 componentes)→sem_estrutura: custo NULL (não 0) e entra na fila como sem_estrutura (impacto=nCMC do acabado).
BEGIN;

-- ── 0) Config (pcp_config já existe da 1A; CREATE IF NOT EXISTS defensivo — shape REAL key/value jsonb) ──
CREATE TABLE IF NOT EXISTS public.pcp_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.pcp_config (key, value) VALUES
  ('custo_cmc_account',   '"colacor_vendas"'::jsonb),  -- conta do cmc_snapshot que dá o CMC do custo
  ('custo_versao_regra',  '"1"'::jsonb),               -- versão da regra (na chave — regra nova NÃO sobrescreve)
  ('custo_tolerancia_pct','0.05'::jsonb),              -- banda de divergência aceita antes de virar exceção
  ('custo_drift_pct',     '0.10'::jsonb)               -- Δ relativa de CMC entre 2 datas p/ suspeitar drift de preço
ON CONFLICT (key) DO NOTHING;

-- ── 1) Resultados versionados (1-writer: a RPC DEFINER; chave inclui versao_regra) ──
CREATE TABLE IF NOT EXISTS public.pcp_custo_padrao_resultados (
  omie_codigo_produto bigint NOT NULL,
  data_posicao        date   NOT NULL,
  versao_regra        text   NOT NULL,
  tipo_item           text,
  custo_abrasivo      numeric,
  custo_cola          numeric,
  custo_catalisador   numeric,
  custo_fita          numeric,
  custo_outros        numeric,                 -- material fora dos 4 papéis (não some)
  custo_total         numeric,                 -- NULL se custo_status <> 'ok'
  custo_status        text NOT NULL CHECK (custo_status IN ('ok','incompleto','unidade_divergente','ambiguo','sem_estrutura')),
  n_componentes       int NOT NULL,
  n_incompletos       int NOT NULL,
  detalhe             jsonb,
  derivado_em         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (omie_codigo_produto, data_posicao, versao_regra)
);
-- FIX 7: evolui o CHECK de custo_status idempotentemente — a tabela já existe em prod (entrega anterior) e
--   CREATE TABLE IF NOT EXISTS NÃO atualiza CHECK; sem isto o INSERT de 'sem_estrutura' (estrutura Omie vazia: itens=[]) violaria.
ALTER TABLE public.pcp_custo_padrao_resultados DROP CONSTRAINT IF EXISTS pcp_custo_padrao_resultados_custo_status_check;
ALTER TABLE public.pcp_custo_padrao_resultados ADD  CONSTRAINT pcp_custo_padrao_resultados_custo_status_check
  CHECK (custo_status IN ('ok','incompleto','unidade_divergente','ambiguo','sem_estrutura'));

-- ── 2) Fila de exceções — INCLUSIVA (incompletos/sem-nCMC entram); lados NULLABLE; impacto_r NOT NULL ordena TUDO ──
CREATE TABLE IF NOT EXISTS public.pcp_custo_excecoes (
  omie_codigo_produto bigint NOT NULL,
  data_posicao        date   NOT NULL,
  versao_regra        text   NOT NULL,
  tipo_item           text,
  custo_padrao_total  numeric,                 -- NULL quando cmc_incompleto
  ncmc_acabado        numeric,                 -- NULL quando ncmc_ausente
  divergencia_abs     numeric,                 -- NULL quando falta um lado
  divergencia_pct     numeric,
  impacto_r           numeric NOT NULL,        -- coalesce(div_abs, custo_parcial/total, ncmc, 0)
  classe_causa text NOT NULL CHECK (classe_causa IN
    ('possivel_erro_receita','drift_preco_provavel','causa_indeterminada',
     'material_fora_bucket','cmc_incompleto','ncmc_ausente','unidade_divergente','estrutura_ambigua','sem_estrutura')),
  custo_status text NOT NULL,
  derivado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (omie_codigo_produto, data_posicao, versao_regra)
);
CREATE INDEX IF NOT EXISTS idx_pcp_custo_exc_imp ON public.pcp_custo_excecoes (impacto_r DESC);
-- FIX 1/7: evolui o CHECK de classe_causa idempotentemente — a tabela já existe em prod (entrega anterior) e
--   CREATE TABLE IF NOT EXISTS NÃO atualiza CHECK; sem isto o INSERT de 'unidade_divergente'/'estrutura_ambigua'/'sem_estrutura' violaria.
ALTER TABLE public.pcp_custo_excecoes DROP CONSTRAINT IF EXISTS pcp_custo_excecoes_classe_causa_check;
ALTER TABLE public.pcp_custo_excecoes ADD  CONSTRAINT pcp_custo_excecoes_classe_causa_check
  CHECK (classe_causa IN ('possivel_erro_receita','drift_preco_provavel','causa_indeterminada',
     'material_fora_bucket','cmc_incompleto','ncmc_ausente','unidade_divergente','estrutura_ambigua','sem_estrutura'));

-- ── 3) CMC vigente (conta lida de config, ausente→NULL, INVOKER — RLS do cmc_snapshot protege) ──
CREATE OR REPLACE FUNCTION public.fn_pcp_cmc_vigente(
  p_cod bigint, p_data_posicao date, p_permitir_anterior boolean DEFAULT false)
RETURNS numeric LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT cmc FROM cmc_snapshot
   WHERE omie_codigo_produto = p_cod
     AND account = (SELECT value#>>'{}' FROM pcp_config WHERE key = 'custo_cmc_account')
     AND cmc > 0
     AND (data_posicao = p_data_posicao OR (p_permitir_anterior AND data_posicao <= p_data_posicao))
   ORDER BY data_posicao DESC
   LIMIT 1;
$$;

-- Helper de deploy: última data-posição da grade CMC (evita data hardcoded fora da grade). INVOKER.
CREATE OR REPLACE FUNCTION public.fn_pcp_ultima_data_posicao()
RETURNS date LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT max(data_posicao) FROM cmc_snapshot
   WHERE account = (SELECT value#>>'{}' FROM pcp_config WHERE key = 'custo_cmc_account');
$$;

-- Cobertura de CMC por tipo_item (security_invoker => a RLS do cmc_snapshot/pcp_itens barra não-staff; não vaza).
CREATE OR REPLACE VIEW public.vw_pcp_cmc_cobertura WITH (security_invoker = true) AS
  SELECT i.tipo_item,
         count(*) AS fabricados,
         count(*) FILTER (
           WHERE fn_pcp_cmc_vigente(m.omie_codigo_produto, (SELECT fn_pcp_ultima_data_posicao())) IS NOT NULL
         ) AS com_cmc
    FROM pcp_malha_staging m
    JOIN pcp_itens i ON i.omie_codigo_produto = m.omie_codigo_produto
   GROUP BY i.tipo_item;

-- ── 4) Drift de preço de um componente (2 datas de CMC com Δ relativa > p_drift). INVOKER; só a RPC DEFINER chama. ──
CREATE OR REPLACE FUNCTION public.fn_pcp_componente_tem_drift(p_cod bigint, p_data date, p_drift numeric)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH h AS (
    SELECT cmc FROM cmc_snapshot
     WHERE omie_codigo_produto = p_cod
       AND account = (SELECT value#>>'{}' FROM pcp_config WHERE key = 'custo_cmc_account')
       AND data_posicao <= p_data AND cmc > 0
     ORDER BY data_posicao DESC
     LIMIT 2
  )
  SELECT count(*) = 2 AND abs(max(cmc) - min(cmc)) / NULLIF(min(cmc), 0) > p_drift FROM h;
$$;

-- ── 5) Motor do custo-padrão — SET-BASED, jsonb com contrato, ausente→NULL. DEFINER; sem gate interno (REVOKE protege). ──
CREATE OR REPLACE FUNCTION public.fn_pcp_recompute_custo_padrao(p_data_posicao date)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account text := (SELECT value#>>'{}' FROM pcp_config WHERE key = 'custo_cmc_account');
  v_versao  text := (SELECT value#>>'{}' FROM pcp_config WHERE key = 'custo_versao_regra');
  v int;
BEGIN
  -- FIX 6: serializa recomputes concorrentes da MESMA data (upsert sem corrida) — padrão da 1B-M1 (fn_pcp_projetar_op).
  PERFORM pg_advisory_xact_lock(hashtextextended('pcp_custo_'||p_data_posicao::text, 0));
  IF v_account IS NULL OR v_versao IS NULL THEN
    RAISE EXCEPTION 'fn_pcp_recompute_custo_padrao: config custo_cmc_account/custo_versao_regra ausente';
  END IF;
  -- Valida a data contra a grade CMC: data fora da grade zeraria o custo em massa (todo cmc NULL) sem avisar.
  IF NOT EXISTS (SELECT 1 FROM cmc_snapshot WHERE account = v_account AND data_posicao = p_data_posicao) THEN
    RAISE EXCEPTION 'fn_pcp_recompute_custo_padrao: data-posição % inexistente na grade CMC (conta %)', p_data_posicao, v_account;
  END IF;

  WITH comp AS (
    SELECT
      s.omie_codigo_produto AS pai_cod,
      -- FIX 4: idProdMalha só vira bigint se for inteiro PURO e caber (length<=18); decimal ('1.5') ou gigante → NULL
      --   (LEFT JOIN não acha CMC → componente cai em falta/incompleto), NUNCA aborta o recompute. Fallbacks de chave preservados.
      CASE WHEN coalesce(it2->'ident'->>'idProdMalha', it2->'ident'->>'idMalha', it2->>'idProdMalha') ~ '^[0-9]+$'
            AND length(coalesce(it2->'ident'->>'idProdMalha', it2->'ident'->>'idMalha', it2->>'idProdMalha')) <= 18
           THEN coalesce(it2->'ident'->>'idProdMalha', it2->'ident'->>'idMalha', it2->>'idProdMalha')::bigint
      END AS comp_cod,
      coalesce(it2->'ident'->>'descrProdMalha', it2->>'descrProdMalha') AS comp_desc,
      fn_pcp_num(coalesce(it2->>'quantProdMalha', it2->>'quantidade')) AS qtd,
      upper(coalesce(it2->>'unidProdMalha', it2->>'unidade')) AS uom
    FROM pcp_malha_staging s
    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'itens') AS it2
    WHERE jsonb_typeof(s.payload->'itens') = 'array'
  ),
  enrich AS (
    SELECT c.*,
      upper(op.unidade) AS uom_estoque,
      fn_pcp_cmc_vigente(c.comp_cod, p_data_posicao) AS cmc,
      fn_pcp_papel_componente(c.comp_desc, op.familia) AS papel
    FROM comp c
    LEFT JOIN omie_products op ON op.omie_codigo_produto = c.comp_cod AND op.account = 'colacor'
  ),
  calc AS (
    SELECT e.*,
      (e.cmc IS NULL OR e.qtd IS NULL OR e.qtd <= 0 OR (e.cmc IS NOT NULL AND e.uom_estoque IS NULL)) AS falta,
      (e.uom_estoque IS NOT NULL AND e.uom IS NOT NULL AND e.uom <> e.uom_estoque) AS unidade_diverge,
      CASE
        WHEN e.cmc IS NULL OR e.qtd IS NULL OR e.qtd <= 0 THEN NULL                                    -- incompleto: NUNCA fabrica 0 (FIX 3: qtd<=0 tb)
        WHEN e.cmc IS NOT NULL AND e.uom_estoque IS NULL THEN NULL                                     -- FIX 2: cmc sem unidade de estoque confirmada → falta
        WHEN e.uom_estoque IS NOT NULL AND e.uom IS NOT NULL AND e.uom <> e.uom_estoque THEN NULL      -- guard de unidade
        ELSE e.qtd * e.cmc
      END AS custo
    FROM enrich e
  ),
  agg AS (
    SELECT pai_cod,
      sum(custo) FILTER (WHERE papel = 'abrasivo_base') AS custo_abrasivo,
      sum(custo) FILTER (WHERE papel = 'cola')          AS custo_cola,
      sum(custo) FILTER (WHERE papel = 'catalisador')   AS custo_catalisador,
      sum(custo) FILTER (WHERE papel = 'fita')          AS custo_fita,
      sum(custo) FILTER (WHERE papel = 'outro')         AS custo_outros,
      count(*)                        AS n_comp,
      count(*) FILTER (WHERE falta)   AS n_falta,
      count(*) FILTER (WHERE unidade_diverge) AS n_div,
      jsonb_agg(jsonb_build_object('cod', comp_cod, 'desc', comp_desc, 'qtd', qtd,
                                   'uom', uom, 'cmc', cmc, 'papel', papel, 'custo', custo)) AS detalhe
    FROM calc
    GROUP BY pai_cod
  )
  INSERT INTO pcp_custo_padrao_resultados (
    omie_codigo_produto, data_posicao, versao_regra, tipo_item,
    custo_abrasivo, custo_cola, custo_catalisador, custo_fita, custo_outros,
    custo_total, custo_status, n_componentes, n_incompletos, detalhe, derivado_em)
  SELECT
    s.omie_codigo_produto,
    p_data_posicao,
    v_versao,
    it.tipo_item,
    a.custo_abrasivo, a.custo_cola, a.custo_catalisador, a.custo_fita, a.custo_outros,
    CASE
      WHEN jsonb_typeof(s.payload->'itens') = 'array' AND a.pai_cod IS NOT NULL AND coalesce(a.n_div, 0) = 0 AND coalesce(a.n_falta, 0) = 0
      THEN coalesce(a.custo_abrasivo,0) + coalesce(a.custo_cola,0) + coalesce(a.custo_catalisador,0)
         + coalesce(a.custo_fita,0) + coalesce(a.custo_outros,0)
      ELSE NULL
    END AS custo_total,
    CASE
      WHEN jsonb_typeof(s.payload->'itens') IS DISTINCT FROM 'array' THEN 'ambiguo'
      WHEN a.pai_cod IS NULL THEN 'sem_estrutura'                                                    -- FIX 7: array vazio (itens=[], 0 componentes) → custo DESCONHECIDO, nunca 0
      WHEN coalesce(a.n_div, 0)   > 0 THEN 'unidade_divergente'
      WHEN coalesce(a.n_falta, 0) > 0 THEN 'incompleto'
      ELSE 'ok'
    END AS custo_status,
    coalesce(a.n_comp, 0),
    coalesce(a.n_falta, 0),
    coalesce(a.detalhe, '[]'::jsonb),
    now()
  FROM pcp_malha_staging s
  LEFT JOIN pcp_itens it ON it.omie_codigo_produto = s.omie_codigo_produto
  LEFT JOIN agg a        ON a.pai_cod = s.omie_codigo_produto
  ON CONFLICT (omie_codigo_produto, data_posicao, versao_regra) DO UPDATE SET
    tipo_item = EXCLUDED.tipo_item,
    custo_abrasivo = EXCLUDED.custo_abrasivo, custo_cola = EXCLUDED.custo_cola,
    custo_catalisador = EXCLUDED.custo_catalisador, custo_fita = EXCLUDED.custo_fita,
    custo_outros = EXCLUDED.custo_outros, custo_total = EXCLUDED.custo_total,
    custo_status = EXCLUDED.custo_status, n_componentes = EXCLUDED.n_componentes,
    n_incompletos = EXCLUDED.n_incompletos, detalhe = EXCLUDED.detalhe, derivado_em = now();

  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

-- ── 6) Fila de exceções — só LIXA (cinta/disco/folha/rolo; tingidor fora), inclusiva, classe PROVADA. DEFINER. ──
CREATE OR REPLACE FUNCTION public.fn_pcp_recompute_excecoes(p_data_posicao date)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_versao text    := (SELECT value#>>'{}' FROM pcp_config WHERE key = 'custo_versao_regra');
  v_tol    numeric := (SELECT (value#>>'{}')::numeric FROM pcp_config WHERE key = 'custo_tolerancia_pct');
  v_drift  numeric := (SELECT (value#>>'{}')::numeric FROM pcp_config WHERE key = 'custo_drift_pct');
  v int;
BEGIN
  -- FIX 6: serializa recomputes concorrentes da MESMA data (DELETE+INSERT da fila sem corrida) — padrão da 1B-M1.
  PERFORM pg_advisory_xact_lock(hashtextextended('pcp_custo_'||p_data_posicao::text, 0));
  -- FIX 5: valida config (como a fn de custo já faz) — versao/tol/drift ausentes zerariam/quebrariam a fila silenciosamente.
  IF v_versao IS NULL OR v_tol IS NULL OR v_drift IS NULL THEN
    RAISE EXCEPTION 'fn_pcp_recompute_excecoes: config custo_versao_regra/custo_tolerancia_pct/custo_drift_pct ausente';
  END IF;
  -- Reconstrói a fila da (data, versão) do zero: sem fila fantasma (o que regularizou some).
  DELETE FROM pcp_custo_excecoes WHERE data_posicao = p_data_posicao AND versao_regra = v_versao;

  WITH src AS (
    SELECT r.*,
      fn_pcp_cmc_vigente(r.omie_codigo_produto, p_data_posicao) AS ncmc,   -- MESMA data (coerência temporal)
      NULLIF(coalesce(r.custo_abrasivo,0) + coalesce(r.custo_cola,0) + coalesce(r.custo_catalisador,0)
           + coalesce(r.custo_fita,0) + coalesce(r.custo_outros,0), 0) AS custo_parcial
    FROM pcp_custo_padrao_resultados r
    WHERE r.data_posicao = p_data_posicao AND r.versao_regra = v_versao
      AND r.tipo_item IN ('cinta','disco','folha','rolo')
  ),
  calc AS (
    SELECT s.*,
      CASE WHEN s.custo_total IS NOT NULL AND s.ncmc IS NOT NULL THEN abs(s.custo_total - s.ncmc) END AS div_abs
    FROM src s
  ),
  cls AS (
    SELECT c.*,
      (c.div_abs / NULLIF(c.ncmc, 0)) AS div_pct,
      CASE
        WHEN c.custo_status = 'incompleto' THEN 'cmc_incompleto'                          -- entra na fila (total NULL)
        WHEN c.custo_status = 'unidade_divergente' THEN 'unidade_divergente'              -- FIX 1: entra na fila (não some p/ NULL)
        WHEN c.custo_status = 'ambiguo' THEN 'estrutura_ambigua'                          -- FIX 1: entra na fila (não some p/ NULL)
        WHEN c.custo_status = 'sem_estrutura' THEN 'sem_estrutura'                        -- FIX 7: estrutura Omie vazia → entra na fila (falta receita, não erro de custo)
        WHEN c.custo_status = 'ok' AND c.ncmc IS NULL THEN 'ncmc_ausente'                 -- ativo NÃO custeado
        WHEN c.custo_status = 'ok' AND c.ncmc IS NOT NULL
             AND (c.div_abs / NULLIF(c.ncmc, 0)) > v_tol THEN
          CASE
            WHEN coalesce(c.custo_outros, 0) > 0 THEN 'material_fora_bucket'
            WHEN EXISTS (SELECT 1 FROM pcp_bom_excecoes be
                          WHERE be.pai_codigo = c.omie_codigo_produto
                            AND be.status = 'excecao' AND be.disposicao IS NULL)
              THEN 'possivel_erro_receita'                                                -- PROVADO: cruza a 1A (oráculo)
            WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(c.detalhe) d
                          WHERE fn_pcp_componente_tem_drift((d->>'cod')::bigint, p_data_posicao, v_drift))
              THEN 'drift_preco_provavel'
            ELSE 'causa_indeterminada'                                                    -- default HONESTO (nunca acusa sem oráculo)
          END
        ELSE NULL                                                                        -- dentro da banda / ambiguo / unidade_divergente: fora da fila
      END AS classe
    FROM calc c
  )
  INSERT INTO pcp_custo_excecoes (
    omie_codigo_produto, data_posicao, versao_regra, tipo_item,
    custo_padrao_total, ncmc_acabado, divergencia_abs, divergencia_pct,
    impacto_r, classe_causa, custo_status, derivado_em)
  SELECT
    omie_codigo_produto, data_posicao, versao_regra, tipo_item,
    custo_total AS custo_padrao_total,
    ncmc        AS ncmc_acabado,
    div_abs     AS divergencia_abs,
    div_pct     AS divergencia_pct,
    CASE classe
      WHEN 'cmc_incompleto'     THEN coalesce(custo_parcial, ncmc, 0)
      WHEN 'unidade_divergente' THEN coalesce(custo_parcial, ncmc, 0)   -- FIX 1
      WHEN 'estrutura_ambigua'  THEN coalesce(custo_parcial, ncmc, 0)   -- FIX 1
      WHEN 'sem_estrutura'      THEN coalesce(ncmc, 0)                   -- FIX 7: único valor conhecido é o CMC do acabado (se houver)
      WHEN 'ncmc_ausente'       THEN coalesce(custo_total, 0)
      ELSE coalesce(div_abs, custo_total, ncmc, 0)
    END AS impacto_r,
    classe AS classe_causa,
    custo_status,
    now()
  FROM cls
  WHERE classe IS NOT NULL;

  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

-- Calibração da tolerância: distribuição de div_pct SÓ sobre dado saneado (ok, sem outros, com nCMC, sem exceção 1A).
CREATE OR REPLACE VIEW public.vw_pcp_custo_calibracao WITH (security_invoker = true) AS
  SELECT r.omie_codigo_produto, r.data_posicao, r.versao_regra, r.tipo_item,
         r.custo_total,
         fn_pcp_cmc_vigente(r.omie_codigo_produto, r.data_posicao) AS ncmc,
         abs(r.custo_total - fn_pcp_cmc_vigente(r.omie_codigo_produto, r.data_posicao))
           / NULLIF(fn_pcp_cmc_vigente(r.omie_codigo_produto, r.data_posicao), 0) AS div_pct
    FROM pcp_custo_padrao_resultados r
   WHERE r.custo_status = 'ok'
     AND coalesce(r.custo_outros, 0) = 0
     AND r.tipo_item IN ('cinta','disco','folha','rolo')
     AND fn_pcp_cmc_vigente(r.omie_codigo_produto, r.data_posicao) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pcp_bom_excecoes be
                      WHERE be.pai_codigo = r.omie_codigo_produto
                        AND be.status = 'excecao' AND be.disposicao IS NULL);

-- ── 7) RLS enabled (NÃO force — o writer é a RPC DEFINER) + policies staff-only + grants ──
ALTER TABLE public.pcp_custo_padrao_resultados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_custo_excecoes          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pcp_custo_res_select_staff ON public.pcp_custo_padrao_resultados;
CREATE POLICY pcp_custo_res_select_staff ON public.pcp_custo_padrao_resultados FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
DROP POLICY IF EXISTS pcp_custo_exc_select_staff ON public.pcp_custo_excecoes;
CREATE POLICY pcp_custo_exc_select_staff ON public.pcp_custo_excecoes FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));

REVOKE ALL ON public.pcp_custo_padrao_resultados, public.pcp_custo_excecoes FROM anon, authenticated;
GRANT SELECT ON public.pcp_custo_padrao_resultados, public.pcp_custo_excecoes TO authenticated;  -- policy filtra

-- Recompute: só owner/service-role/SQL Editor (mesmo padrão da 1A). Non-staff barrado pela ausência de EXECUTE.
REVOKE ALL ON FUNCTION public.fn_pcp_recompute_custo_padrao(date), public.fn_pcp_recompute_excecoes(date)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_pcp_componente_tem_drift(bigint, date, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_pcp_cmc_vigente(bigint, date, boolean), public.fn_pcp_ultima_data_posicao()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_pcp_cmc_vigente(bigint, date, boolean) TO authenticated;  -- INVOKER: a RLS do cmc barra
GRANT EXECUTE ON FUNCTION public.fn_pcp_ultima_data_posicao() TO authenticated;

REVOKE ALL ON public.vw_pcp_cmc_cobertura, public.vw_pcp_custo_calibracao FROM anon;
GRANT SELECT ON public.vw_pcp_cmc_cobertura, public.vw_pcp_custo_calibracao TO authenticated;  -- security_invoker => RLS barra

COMMIT;
