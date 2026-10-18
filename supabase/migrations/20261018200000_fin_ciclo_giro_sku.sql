-- Giro de estoque por SKU (frente 3 do ciclo) + estoque de giro por empresa para o PME/NCG do engine.
-- Spec: docs/superpowers/specs/2026-10-18-ciclo-giro-sku-design.md (§5.0, §5.2, §5.4).
--
-- Por quê: fin_estoque_valor está vazia em prod e o engine lia o ausente como R$ 0 → PME 0d e NCG
-- sem estoque nas 3 empresas. A fonte real é inventory_position (saldo × cmc do Omie), MAS o "estoque"
-- do Omie mistura imobilizado e uso e consumo (colacor: R$ 1,48 mi tipo 08 — máquinas, dispensador).
--
-- Objetos:
--   _fin_estoque_tipo_fora / _fin_estoque_familia_fora / _fin_estoque_classe — ÚNICA dona da regra
--     giro | fora_giro | sem_classificacao (tipo SPED 07/08/09/99 OU família uso e consumo/imobilizado).
--   _fin_estoque_account — company → account de inventory_position (empresa inválida → P0001).
--   fin_estoque_giro_valor(company) — totais por classe (engine via service_role; diálogo de config
--     via cap_custo_ler). Sem SKU de giro com custo → valor_giro NULL, nunca 0.
--   fin_ciclo_giro_sku(company) — lista por SKU da aba Ciclo (só master + fin_user_can_access).
--
-- Ausente ≠ zero: valor_parado NULL sem custo; consumo/dias/ação NULL sem fonte de consumo confiável
-- (NF-e da empresa com ≥330 dias de histórico e atualizada há ≤7 dias); "nunca saiu" só vira
-- candidato a liquidar fora de cold start, substituição e compra recente (cmc_ledger ≤90 dias).

BEGIN;

CREATE OR REPLACE FUNCTION public._fin_estoque_tipo_fora(p_tipo text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT trim(p_tipo) IN ('07', '08', '09', '99')
$$;

CREATE OR REPLACE FUNCTION public._fin_estoque_familia_fora(p_familia text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT lower(trim(p_familia)) IN ('uso e consumo', 'imobilizado')
$$;

CREATE OR REPLACE FUNCTION public._fin_estoque_classe(p_tipo text, p_familia text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT CASE
    WHEN coalesce(public._fin_estoque_familia_fora(p_familia), false) THEN 'fora_giro'
    WHEN nullif(trim(p_tipo), '') IS NULL THEN 'sem_classificacao'
    WHEN public._fin_estoque_tipo_fora(p_tipo) THEN 'fora_giro'
    ELSE 'giro'
  END
$$;

CREATE OR REPLACE FUNCTION public._fin_estoque_account(p_company text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v text;
BEGIN
  v := CASE lower(trim(p_company))
         WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos'
       END;
  IF v IS NULL THEN
    RAISE EXCEPTION 'empresa invalida: %', p_company USING ERRCODE = 'P0001';
  END IF;
  RETURN v;
END
$$;

CREATE OR REPLACE FUNCTION public.fin_estoque_giro_valor(p_company text)
RETURNS TABLE(valor_giro numeric, valor_fora_giro numeric, valor_sem_classificacao numeric,
              skus_giro integer, skus_giro_com_custo integer, cobertura_pct numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_account text;
BEGIN
  IF NOT (coalesce(auth.role() = 'service_role', false)
          OR (auth.uid() IS NOT NULL AND coalesce(private.cap_custo_ler(auth.uid()), false))) THEN
    RAISE EXCEPTION 'ESTOQUE_SEM_PERFIL_FINANCEIRO' USING ERRCODE = '42501';
  END IF;
  v_account := public._fin_estoque_account(p_company);
  RETURN QUERY
    WITH base AS (
      SELECT ip.saldo, ip.cmc, public._fin_estoque_classe(op.tipo_produto, op.familia) AS classe
        FROM public.inventory_position ip
        LEFT JOIN public.omie_products op ON op.id = ip.product_id
       WHERE ip.account = v_account AND ip.saldo > 0
    )
    SELECT
      sum(saldo * cmc) FILTER (WHERE classe = 'giro' AND cmc > 0),
      sum(saldo * cmc) FILTER (WHERE classe = 'fora_giro' AND cmc > 0),
      sum(saldo * cmc) FILTER (WHERE classe = 'sem_classificacao' AND cmc > 0),
      (count(*) FILTER (WHERE classe = 'giro'))::integer,
      (count(*) FILTER (WHERE classe = 'giro' AND cmc > 0))::integer,
      CASE WHEN count(*) FILTER (WHERE classe = 'giro') = 0 THEN NULL
           ELSE round(100.0 * count(*) FILTER (WHERE classe = 'giro' AND cmc > 0)
                      / count(*) FILTER (WHERE classe = 'giro'), 2) END
    FROM base;
END
$$;

CREATE OR REPLACE FUNCTION public.fin_ciclo_giro_sku(p_company text)
RETURNS TABLE(omie_codigo_produto bigint, codigo text, descricao text, tipo_produto text, familia text,
              classe text, divergencia_cadastro boolean, saldo numeric, cmc numeric, valor_parado numeric,
              consumo_qtd_365d numeric, dias_cobertura numeric, ultima_saida date, dias_sem_saida integer,
              valor_excedente numeric, acao text, motivo_acao text, motivo_consumo text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  c_cobertura_alvo_dias CONSTANT int := 90;
  c_segurar_compra_dias CONSTANT int := 180;
  c_giro_morto_dias CONSTANT int := 270;
  c_compra_recente_dias CONSTANT int := 90;
  c_fonte_min_historico_dias CONSTANT int := 330;
  c_fonte_max_atraso_dias CONSTANT int := 7;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_account text;
  v_empresa text;
  v_min date;
  v_max date;
  v_motivo text;
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  v_account := public._fin_estoque_account(p_company);
  IF NOT public.fin_user_can_access(lower(trim(p_company))) THEN
    RAISE EXCEPTION 'CICLO_SEM_ACESSO_EMPRESA' USING ERRCODE = '42501';
  END IF;

  -- Fonte de consumo: NF-e da empresa (raiz de toda a demanda efetiva), com cobertura e frescor.
  v_empresa := CASE lower(trim(p_company)) WHEN 'oben' THEN 'OBEN' WHEN 'colacor' THEN 'COLACOR' END;
  IF v_empresa IS NULL THEN
    v_motivo := 'sem_consumo_por_sku';
  ELSE
    SELECT min(v.data_emissao), max(v.data_emissao) INTO v_min, v_max
      FROM public.venda_items_history v WHERE v.empresa = v_empresa;
    IF v_max IS NULL THEN
      v_motivo := 'sem_consumo_por_sku';
    ELSIF v_min > v_hoje - c_fonte_min_historico_dias THEN
      v_motivo := 'consumo_incompleto';
    ELSIF v_max < v_hoje - c_fonte_max_atraso_dias THEN
      v_motivo := 'consumo_desatualizado';
    END IF;
  END IF;

  RETURN QUERY
    -- MATERIALIZED em tudo que é lido por junção: v_pcp_malha_oben custa ~250 ms POR avaliação e,
    -- embutida num EXISTS correlacionado, era reavaliada por linha (medido em prod 2026-10-18:
    -- 2,5 s → timeout na forma correlacionada; 0,56 s materializada).
    WITH base AS MATERIALIZED (
      SELECT ip.omie_codigo_produto AS cod, op.codigo, op.descricao, op.tipo_produto, op.familia,
             op.unidade, ip.saldo, ip.cmc,
             public._fin_estoque_classe(op.tipo_produto, op.familia) AS classe,
             (nullif(trim(op.tipo_produto), '') IS NOT NULL AND nullif(trim(op.familia), '') IS NOT NULL
               AND public._fin_estoque_tipo_fora(op.tipo_produto)
                   <> public._fin_estoque_familia_fora(op.familia)) AS divergencia
        FROM public.inventory_position ip
        LEFT JOIN public.omie_products op ON op.id = ip.product_id
       WHERE ip.account = v_account AND ip.saldo > 0
    ),
    dem AS MATERIALIZED (
      SELECT d.sku_codigo_omie AS cod,
             sum(d.quantidade) FILTER (WHERE d.data_emissao >= v_hoje - 365) AS qtd,
             max(d.data_emissao) AS ultima
        FROM public.v_sku_demanda_efetiva d
       WHERE v_motivo IS NULL AND d.empresa = v_empresa
       GROUP BY d.sku_codigo_omie
    ),
    malha_un AS MATERIALIZED (
      SELECT mo.comp_oben AS cod, upper(trim(mo.unidade)) AS un
        FROM public.v_pcp_malha_oben mo
       WHERE v_motivo IS NULL AND v_empresa = 'OBEN'
    ),
    malha_divergente AS MATERIALIZED (
      SELECT DISTINCT m.cod FROM malha_un m JOIN base b ON b.cod = m.cod
       WHERE m.un IS DISTINCT FROM upper(trim(b.unidade))
    ),
    cold AS MATERIALIZED (
      SELECT DISTINCT sp.sku_codigo_omie AS cod FROM public.sku_parametros sp
       WHERE sp.empresa = v_empresa AND sp.parametro_cold_start IS TRUE
    ),
    subst AS MATERIALIZED (
      SELECT DISTINCT ss.sku_codigo_antigo AS cod_txt FROM public.sku_substituicao ss
       WHERE ss.empresa = v_empresa AND ss.status = 'aplicada' AND ss.acao_parametros = 'consolidar_demanda'
    ),
    recente AS MATERIALIZED (
      SELECT DISTINCT cl.omie_codigo_produto AS cod FROM public.cmc_ledger cl
       WHERE cl.account = v_account
         AND cl.observed_at >= ((v_hoje - c_compra_recente_dias)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    ),
    linha AS (
      SELECT b.*,
             CASE WHEN b.classe <> 'giro' THEN 'fora_do_giro'
                  WHEN v_motivo IS NOT NULL THEN v_motivo
                  WHEN md.cod IS NOT NULL THEN 'unidade_divergente'
             END AS mot_consumo,
             dm.qtd, dm.ultima,
             (co.cod IS NOT NULL) AS cold_start,
             (su.cod_txt IS NOT NULL) AS substituido,
             (re.cod IS NOT NULL) AS compra_recente
        FROM base b
        LEFT JOIN dem dm ON dm.cod = b.cod
        LEFT JOIN malha_divergente md ON md.cod = b.cod
        LEFT JOIN cold co ON co.cod = b.cod
        LEFT JOIN subst su ON su.cod_txt = b.cod::text
        LEFT JOIN recente re ON re.cod = b.cod
    ),
    calc AS (
      SELECT l.*,
             CASE WHEN l.mot_consumo IS NULL THEN coalesce(l.qtd, 0) END AS consumo,
             CASE WHEN l.mot_consumo IS NULL THEN l.ultima END AS ult
        FROM linha l
    ),
    met AS (
      SELECT c.*,
             CASE WHEN c.consumo > 0 THEN round(c.saldo / (c.consumo / 365.0), 1) END AS dias,
             (v_hoje - c.ult)::integer AS sem_saida
        FROM calc c
    )
    SELECT m.cod, m.codigo, m.descricao, m.tipo_produto, m.familia, m.classe, coalesce(m.divergencia, false),
           m.saldo, m.cmc,
           CASE WHEN m.cmc > 0 THEN m.saldo * m.cmc END,
           m.consumo, m.dias, m.ult, m.sem_saida,
           CASE WHEN m.consumo > 0 AND m.cmc > 0
                THEN round(greatest(0, m.saldo - m.consumo / 365.0 * c_cobertura_alvo_dias) * m.cmc, 2) END,
           CASE WHEN m.mot_consumo IS NOT NULL OR m.substituido THEN NULL
                WHEN m.ult IS NULL OR m.sem_saida >= c_giro_morto_dias THEN
                  CASE WHEN m.cold_start OR m.compra_recente THEN NULL ELSE 'liquidar' END
                WHEN m.dias > c_segurar_compra_dias THEN 'segurar_compra'
           END,
           CASE WHEN m.mot_consumo IS NOT NULL THEN NULL
                WHEN m.substituido THEN 'substituido'
                WHEN m.ult IS NULL OR m.sem_saida >= c_giro_morto_dias THEN
                  CASE WHEN m.cold_start THEN 'cold_start'
                       WHEN m.compra_recente THEN 'compra_recente' END
           END,
           m.mot_consumo
      FROM met m
     ORDER BY CASE WHEN m.cmc > 0 THEN m.saldo * m.cmc END DESC NULLS LAST, m.cod;
END
$$;

REVOKE ALL ON FUNCTION public._fin_estoque_tipo_fora(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fin_estoque_familia_fora(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fin_estoque_classe(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fin_estoque_account(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_estoque_giro_valor(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_ciclo_giro_sku(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_estoque_giro_valor(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_giro_sku(text) TO authenticated, service_role;

-- Postcondição embutida.
DO $post$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fin_estoque_giro_valor(text)', 'public.fin_ciclo_giro_sku(text)'] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
      RAISE EXCEPTION 'postcondicao: % sem SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: anon executa %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: authenticated nao executa %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public._fin_estoque_tipo_fora(text)', 'public._fin_estoque_familia_fora(text)',
                           'public._fin_estoque_classe(text,text)', 'public._fin_estoque_account(text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: helper interno exposto %', f;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public._fin_estoque_classe(text,text)'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'postcondicao: _fin_estoque_classe nao e IMMUTABLE';
  END IF;
  IF public._fin_estoque_classe('08', 'MAQUINAS') <> 'fora_giro'
     OR public._fin_estoque_classe('00', 'Uso e Consumo') <> 'fora_giro'
     OR public._fin_estoque_classe('99', NULL) <> 'fora_giro'
     OR public._fin_estoque_classe(NULL, NULL) <> 'sem_classificacao'
     OR public._fin_estoque_classe('00', 'TINTAS') <> 'giro' THEN
    RAISE EXCEPTION 'postcondicao: regra de classe divergente';
  END IF;
  RAISE NOTICE 'CICLO-GIRO-SKU-OK';
END
$post$;

COMMIT;
