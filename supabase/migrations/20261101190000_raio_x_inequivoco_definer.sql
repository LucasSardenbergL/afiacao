-- Raio-X inequívoco: raio_x_inequivoco passa a SECURITY DEFINER (correção do 403 em prod, 2026-11-01).
--
-- Bug: a 20261101120000 criou raio_x_inequivoco como SECURITY INVOKER, e o corpo chama o helper interno
-- public._fin_estoque_classe, que a 20261018200000 fecha por privilégio (REVOKE de authenticated, com postcondição
-- "helper interno exposto"). Rodando como o usuário, a chamada da tela morria em 42501 → HTTP 403, e o app mostrava
-- "veredito inequívoco indisponível" (fail-closed: nenhum SKU vira inequívoco por omissão). O raio_x_decidir (DEFINER)
-- não era afetado: chama a função como postgres. A prova PG17 não pegou porque o stub do helper no harness herdava o
-- EXECUTE do default privileges — corrigido no mesmo PR (stub com a ACL de prod; a suíte fica VERMELHA sem esta migration).
--
-- Correção: mesmo padrão das demais RPCs de custo do Raio-X (decidir, planejar, congelar_coorte) — SECURITY DEFINER
-- com o gate private.cap_custo_ler(auth.uid()) no corpo (42501 para quem não tem custo). NÃO se abre o helper interno.
-- O CORPO É BYTE A BYTE O DA 20261101120000 (md5 do prosrc inalterado): muda só o cabeçalho. search_path já fixo
-- (public, pg_temp). Efeito colateral aceito: como DEFINER a função lê as tabelas sem RLS — o mesmo que já acontecia
-- quando chamada pelo decidir, e a saída é por SKU (flags, motivos, cobertura), sem linhas cruas de outras tabelas.
--
-- Caminho: bun run db:aplicar (sem BEGIN/COMMIT: a transação é do executor). Depende da 20261101120000 JÁ aplicada.
-- Prova: db/test-raio-x-inequivoco.sh (aplica esta logo depois da 20261101120000).

-- ── PRE: o corpo vivo tem de ser o da 20261101120000 (ou já este, re-aplicação) ─────────────────────────────────────
DO $pre$
DECLARE v text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.raio_x_inequivoco(text,bigint)'));
BEGIN
  IF v IS NULL OR v <> '903937e48b6a8d2bb5180ecf6eff85d4' THEN
    RAISE EXCEPTION 'PRE FALHOU: raio_x_inequivoco vivo (md5 %) não é o da 20261101120000 — reconcilie antes', v;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.raio_x_inequivoco(p_empresa text, p_sku bigint DEFAULT NULL)
RETURNS TABLE (
  sku_codigo_omie bigint, inequivoco boolean, motivos_espera text[],
  consumo_365 numeric, cobertura_dias numeric, ultima_entrada date, cold_start boolean, substituido boolean,
  corante boolean, cadastro_recente boolean, mercadoria_servidor boolean, qtd_liquidavel numeric, revisar_em date,
  fonte_ok boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  c_cobertura_dias CONSTANT int := 365;
  c_entrada_dias   CONSTANT int := 90;
  c_cadastro_dias  CONSTANT int := 90;
  c_preservar_dias CONSTANT int := 90;
  v_est  text;
  v_vnd  text;
  v_wh   text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_min  date;
  v_max  date;
  v_fonte boolean := false;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_STAFF' USING ERRCODE = '42501';
  END IF;
  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';           v_vnd := 'OBEN'; v_wh := 'OB';
    WHEN 'colacor' THEN v_est := 'colacor_vendas'; v_vnd := NULL;   v_wh := 'CC';
    ELSE RAISE EXCEPTION 'RAIO_X_EMPRESA_INVALIDA: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;
  -- Fonte de consumo confiável (régua da fin_ciclo_giro_sku §5.4-1): NF-e da empresa com ≥330d de histórico e ≤7d de atraso.
  IF v_vnd IS NOT NULL THEN
    SELECT min(v.data_emissao), max(v.data_emissao) INTO v_min, v_max FROM public.venda_items_history v WHERE v.empresa = v_vnd;
    v_fonte := v_max IS NOT NULL AND v_min <= v_hoje - 330 AND v_max >= v_hoje - 7;
  END IF;

  RETURN QUERY
  WITH e AS (
    SELECT x.* FROM (
      SELECT DISTINCT ON (ip.omie_codigo_produto) ip.omie_codigo_produto::bigint AS sku, ip.saldo
        FROM public.inventory_position ip
       WHERE ip.account = v_est AND (p_sku IS NULL OR ip.omie_codigo_produto = p_sku)
       ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST) x
    WHERE x.saldo > 0),
  p AS (
    SELECT e.sku, op.tipo_produto, op.familia, op.descricao, op.unidade, (op.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS cad,
           (op.omie_codigo_produto IS NOT NULL) AS tem_cadastro
      FROM e
      LEFT JOIN LATERAL (SELECT o.* FROM public.omie_products o
                          WHERE o.omie_codigo_produto = e.sku AND o.account = p_empresa
                          ORDER BY o.created_at DESC NULLS LAST LIMIT 1) op ON true),
  dem AS MATERIALIZED (
    -- unidade da venda ≠ unidade do estoque (CX × UN): a cobertura em unidades mistas MENTE → aguarda (Codex P1-2)
    SELECT d.sku_codigo_omie AS sku, sum(d.quantidade) AS q365,
           bool_or(d.sku_unidade IS NOT NULL AND p.unidade IS NOT NULL
                   AND upper(trim(d.sku_unidade)) IS DISTINCT FROM upper(trim(p.unidade))) AS un_divergente
      FROM public.v_sku_demanda_efetiva d
      LEFT JOIN p ON p.sku = d.sku_codigo_omie
     WHERE v_fonte AND d.empresa = v_vnd AND d.data_emissao >= v_hoje - 365
       AND (p_sku IS NULL OR d.sku_codigo_omie = p_sku)
     GROUP BY d.sku_codigo_omie),
  -- insumo cuja ficha está em QUARENTENA (perda > 0, unidade divergente, pai ambíguo): o consumo explodido some da view e
  -- viraria "zero" — desconhecido AGUARDA (Codex P1-3)
  qua AS (
    SELECT DISTINCT q.comp_oben AS sku FROM public.v_pcp_malha_oben_quarentena q
     WHERE p_empresa = 'oben' AND q.comp_oben IS NOT NULL AND (p_sku IS NULL OR q.comp_oben = p_sku)),
  -- ENTRADA: 3 evidências; a mais recente vale. Qualquer uma recente SEGURA (precisão > recall para liquidar).
  ent AS (
    SELECT z.sku, max(z.dt) AS ultima FROM (
      SELECT slh.sku_codigo_omie::bigint AS sku, slh.t4_data_recebimento::date AS dt
        FROM public.sku_leadtime_history slh
       WHERE v_vnd IS NOT NULL AND slh.empresa::text = v_vnd AND slh.quantidade_recebida > 0 AND slh.t4_data_recebimento IS NOT NULL   -- empresa é ENUM empresa_reposicao (Codex P1-1)
      UNION ALL
      SELECT ri.produto_omie_id, r.data_emissao::date
        FROM public.nfe_recebimento_itens ri
        JOIN public.nfe_recebimentos r ON r.id = ri.nfe_recebimento_id
        JOIN public.warehouses w ON w.id = r.warehouse_id
       WHERE w.code = v_wh AND ri.produto_omie_id IS NOT NULL
      UNION ALL
      SELECT cl.omie_codigo_produto, (cl.observed_at AT TIME ZONE 'America/Sao_Paulo')::date
        FROM public.cmc_ledger cl
       WHERE cl.account = CASE p_empresa WHEN 'oben' THEN 'vendas' ELSE 'colacor_vendas' END
    ) z
    WHERE (p_sku IS NULL OR z.sku = p_sku)
    GROUP BY z.sku),
  man AS (
    SELECT m.sku_codigo_omie AS sku, m.categoria FROM public.raio_x_classificacao_manual m WHERE m.empresa = p_empresa),
  base AS (
    SELECT p.sku, e.saldo, p.tipo_produto, p.familia, p.descricao, p.cad, p.tem_cadastro,
           dm.q365, coalesce(dm.un_divergente, false) AS un_divergente, (qua.sku IS NOT NULL) AS em_quarentena,
           CASE WHEN dm.q365 > 0 THEN round(e.saldo / (dm.q365 / 365.0), 1) END AS cob,
           ent.ultima,
           coalesce((SELECT sp.parametro_cold_start FROM public.sku_parametros sp
                      WHERE sp.empresa = v_vnd AND sp.sku_codigo_omie = p.sku LIMIT 1), false) AS cold,
           EXISTS (SELECT 1 FROM public.sku_substituicao ss
                    WHERE ss.empresa = v_vnd AND ss.sku_codigo_antigo = p.sku::text AND ss.status = 'aplicada') AS subst,
           (coalesce(p.familia, '') = 'Concentrados LC' AND coalesce(p.descricao, '') !~* '^AT[LP]') AS corante,
           (p.cad IS NOT NULL AND p.cad >= v_hoje - c_cadastro_dias) AS cad_recente,
           man.categoria AS manual,
           -- mercadoria pelo servidor = classe giro, não industrial (01/03), não uso e consumo/não-mercadoria do Raio-X
           (public._fin_estoque_classe(p.tipo_produto, p.familia) = 'giro'
             AND trim(coalesce(p.tipo_produto, '')) NOT IN ('01', '03')
             AND coalesce(p.familia, '') NOT IN ('Material de Uso e Consumo', 'Concentrados MixMachine', 'Imobilizado')
             AND coalesce(p.descricao, '') !~* '(MAQUINA|ESPECTRO|SOFTWARE|MOSTRUARIO|CARTELA|EXPOSITOR|DISPLAY|1000 ?KG)'
             AND NOT (coalesce(p.familia, '') = 'Concentrados LC' AND coalesce(p.descricao, '') ~* '^AT[LP]')) AS merc_regra
      FROM p
      JOIN e ON e.sku = p.sku
      LEFT JOIN dem dm ON dm.sku = p.sku
      LEFT JOIN qua ON qua.sku = p.sku
      LEFT JOIN ent ON ent.sku = p.sku
      LEFT JOIN man ON man.sku = p.sku),
  cls AS (
    -- classificação manual (raio_x_classificacao_manual) VENCE a regra; a regra é a do servidor, uma só vez
    SELECT b.*, CASE WHEN b.manual IS NOT NULL THEN b.manual = 'mercadoria' ELSE b.merc_regra END AS merc
      FROM base b),
  calc AS (
    SELECT b.*,
           ARRAY_REMOVE(ARRAY[
             CASE WHEN v_vnd IS NULL THEN 'sem_nf' END,
             CASE WHEN v_vnd IS NOT NULL AND NOT v_fonte THEN 'fonte_consumo_desatualizada' END,
             CASE WHEN NOT b.tem_cadastro OR nullif(trim(b.tipo_produto), '') IS NULL THEN 'cadastro_incompleto' END,
             CASE WHEN b.tem_cadastro AND nullif(trim(b.tipo_produto), '') IS NOT NULL AND NOT b.merc THEN 'nao_mercadoria' END,
             CASE WHEN v_fonte AND b.q365 > 0 AND b.cob <= c_cobertura_dias THEN 'cobertura_abaixo_365' END,
             CASE WHEN b.un_divergente THEN 'unidade_divergente' END,
             CASE WHEN b.em_quarentena THEN 'insumo_em_quarentena' END,
             CASE WHEN b.corante THEN 'corante' END,
             CASE WHEN b.ultima IS NOT NULL AND b.ultima >= v_hoje - c_entrada_dias THEN 'entrada_recente' END,
             CASE WHEN b.cold THEN 'cold_start' END,
             CASE WHEN b.subst THEN 'substituido' END,
             CASE WHEN b.cad_recente THEN 'cadastro_recente' END
           ]::text[], NULL) AS motivos
      FROM cls b)
  SELECT c.sku,
         (cardinality(c.motivos) = 0),
         c.motivos,
         CASE WHEN v_fonte THEN coalesce(c.q365, 0) END,
         CASE WHEN v_fonte THEN c.cob END,
         c.ultima,
         c.cold, c.subst, c.corante, c.cad_recente, c.merc,
         CASE WHEN cardinality(c.motivos) = 0
              THEN greatest(0, c.saldo - coalesce(c.q365, 0) / 365.0 * c_preservar_dias) END,
         CASE WHEN c.ultima IS NOT NULL AND c.ultima >= v_hoje - c_entrada_dias THEN c.ultima + c_entrada_dias END,
         v_fonte
    FROM calc c
   ORDER BY c.sku;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_inequivoco(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_inequivoco(text, bigint) TO authenticated;

-- ── PÓS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE f constant text := 'public.raio_x_inequivoco(text,bigint)'; r record;
BEGIN
  SELECT p.prosecdef, md5(p.prosrc) AS m, p.proconfig, p.prosrc INTO r FROM pg_proc p WHERE p.oid = f::regprocedure;
  IF NOT r.prosecdef THEN RAISE EXCEPTION 'postcondicao: % nao virou SECURITY DEFINER', f; END IF;
  IF r.m <> '903937e48b6a8d2bb5180ecf6eff85d4' THEN
    RAISE EXCEPTION 'postcondicao: corpo de % mudou (md5 %) — esta migration so troca o cabecalho', f, r.m;
  END IF;
  IF r.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'postcondicao: % DEFINER sem search_path fixo', f;
  END IF;
  IF position('private.cap_custo_ler(auth.uid())' IN r.prosrc) = 0 THEN
    RAISE EXCEPTION 'postcondicao: % DEFINER sem o gate cap_custo_ler no corpo', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon/public executa %', f;
  END IF;
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: authenticated nao executa %', f;
  END IF;
  IF has_function_privilege('authenticated', 'public._fin_estoque_classe(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: helper interno _fin_estoque_classe ficou exposto a authenticated';
  END IF;
  RAISE NOTICE 'RAIO-X-INEQUIVOCO-DEFINER-OK';
END
$pos$;
