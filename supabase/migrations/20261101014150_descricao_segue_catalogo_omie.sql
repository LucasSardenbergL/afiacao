-- ============================================================
-- Descrição do SKU segue o catálogo do Omie — no cadastro de reposição e nos alertas pendentes
--
-- Medido em prod (2026-11-01, psql-ro): omie_products sincroniza (última 01:30 SP), mas
--   · sku_parametros.sku_descricao: 9 de 606 SKUs OBEN com nome diferente do Omie (6 ativos). O cron
--     `reposicao-refresh-descricao-diario` (05:45 SP, 20260602101856) grava o nome do catálogo, e o
--     job de parâmetros `atualizar_parametros_numericos_skus` o DESFAZ: grava
--     COALESCE(v.sku_descricao, sp.sku_descricao), e v.sku_descricao é max() alfabético dos nomes nas
--     linhas de venda — não o mais recente. Nos 9 o nome que fica é o que ganha na ordem alfabética
--     ("DILUENTE PU DFZ.8040" no lugar de "DFA.4080"; "BASE FUNDO…" no lugar de "BASE BRIL 40…").
--   · eventos_outlier.sku_descricao: foto da criação. 27 alertas pendentes com nome que não é o do
--     Omie (ex.: "BASE MICROTEX TRANSP WFOT.6861 450ML", de maio, para o 405ML de hoje).
--
-- Mudança:
--   1. atualizar_parametros_numericos_skus: COALESCE(sp.sku_descricao, d.sku_descricao) — o job só
--      preenche nome vazio; quem escreve o nome é o refresh do catálogo. Única linha alterada do corpo
--      de PROD (md5 efcc4251…); fornecedor_nome e o resto ficam como estão.
--   2. atualizar_descricao_sku_parametros também reescreve a descrição dos alertas PENDENTES com o nome
--      do catálogo (qualquer status no Omie: alerta de SKU inativado mostra o nome dele). Alerta decidido
--      fica como foi registrado. O retorno continua sendo a contagem de sku_parametros.
--   3. Roda o refresh uma vez agora.
--
-- Molde TRAVA → PRE → CREATE → PÓS. Caminho: `bun run db:aplicar` (a transação é do executor).
-- CREATE OR REPLACE preserva o ACL — fotografado na PRE e comparado na PÓS.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (as duas são VOLATILE).
DO $trava$
BEGIN
  IF to_regprocedure('public.atualizar_parametros_numericos_skus(text, uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.atualizar_parametros_numericos_skus(text, uuid) VOLATILE;
  END IF;
  IF to_regprocedure('public.atualizar_descricao_sku_parametros(text)') IS NOT NULL THEN
    ALTER FUNCTION public.atualizar_descricao_sku_parametros(text) VOLATILE;
  END IF;
END
$trava$;

-- PRE: corpo vivo ∈ {predecessor de PROD revisado, este}. Ausente aborta. Fotografa o ACL.
CREATE TEMP TABLE _acl_antes ON COMMIT DROP AS
SELECT p.oid, p.proacl::text AS acl FROM pg_catalog.pg_proc p
 WHERE p.oid IN (to_regprocedure('public.atualizar_parametros_numericos_skus(text, uuid)'),
                 to_regprocedure('public.atualizar_descricao_sku_parametros(text)'));

DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.aceitos,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.atualizar_parametros_numericos_skus(text, uuid)', ARRAY['efcc4251ff6bf4a9480ac6a22f726918', '7dd792877291ae06362f4d8249fedbf1']),
        ('public.atualizar_descricao_sku_parametros(text)', ARRAY['9c0e5600fcc390f4dc0f53e2d737d48f', '03be42ac8b01c6f77671f5bf26cb8157'])
      ) AS x(alvo, aceitos)
  LOOP
    IF r.vivo IS NULL OR NOT (r.vivo = ANY (r.aceitos)) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

CREATE OR REPLACE FUNCTION public.atualizar_parametros_numericos_skus(p_empresa text, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  atualizados int := 0;
  v_mult numeric := COALESCE((SELECT value::numeric FROM public.company_config WHERE key='param_auto_fusivel_mult'), 3);
BEGIN
  PERFORM set_config('app.param_auto', CASE WHEN p_run_id IS NULL THEN 'manual' ELSE 'auto' END, true);

  DROP TABLE IF EXISTS tmp_param_decidido;
  CREATE TEMP TABLE tmp_param_decidido ON COMMIT DROP AS
  WITH base AS (
    SELECT sp.id, sp.empresa, sp.sku_codigo_omie,
           sp.ponto_pedido AS pp_antes, sp.estoque_minimo AS min_antes, sp.estoque_maximo AS max_antes,
           sp.estoque_seguranca AS ss_antes, sp.cobertura_alvo_dias AS cob_antes,
           sp.habilitado_reposicao_automatica AS habilitado,
           COALESCE(sp.tipo_reposicao,'automatica') AS tipo,
           v.sku_descricao, v.fornecedor_nome,
           v.estoque_minimo_sugerido AS min_sug, v.ponto_pedido_sugerido AS pp_sug,
           v.estoque_maximo_sugerido AS max_sug, v.estoque_seguranca_sugerido AS ss_sug,
           v.cobertura_alvo_dias AS cob_sug,
           v.demanda_media_diaria, v.demanda_sigma_diario, v.coef_variacao_ordem, v.num_ordens,
           v.valor_total_90d, v.lead_time_medio, v.lead_time_desvio, v.lt_p95_dias, v.fonte_leadtime,
           v.z_aplicado, v.classe_consolidada,
           pin.ponto_pedido_rejeitado, pin.estoque_maximo_rejeitado
    FROM public.sku_parametros sp
    JOIN public.v_sku_parametros_sugeridos v
      ON v.empresa = sp.empresa AND v.sku_codigo_omie = sp.sku_codigo_omie
    LEFT JOIN public.reposicao_param_pin pin
      ON pin.empresa = sp.empresa AND pin.sku_codigo_omie = sp.sku_codigo_omie::text
    WHERE sp.empresa = p_empresa
  )
  SELECT b.*,
    CASE
      WHEN b.pp_sug IS NULL OR b.max_sug IS NULL OR b.min_sug IS NULL
           OR b.ss_sug IS NULL OR b.cob_sug IS NULL THEN 'sem_mudanca'
      WHEN b.pp_sug = 'NaN'::numeric OR b.max_sug = 'NaN'::numeric OR b.min_sug = 'NaN'::numeric
           OR b.ss_sug = 'NaN'::numeric OR b.cob_sug = 'NaN'::numeric
           OR b.min_sug < 0 OR b.pp_sug < 0 OR b.max_sug < 0 OR b.ss_sug < 0
           OR b.max_sug < b.pp_sug OR b.pp_sug < b.min_sug OR b.cob_sug <= 0 THEN 'bloqueado_validacao'
      WHEN b.max_antes IS NULL OR b.max_antes <= 0 THEN 'bloqueado_validacao'
      WHEN b.ponto_pedido_rejeitado IS NOT NULL
           AND round(b.pp_sug) = round(b.ponto_pedido_rejeitado)
           AND round(b.max_sug) = round(b.estoque_maximo_rejeitado) THEN 'pinado'
      WHEN round(b.pp_sug) = round(b.pp_antes) AND round(b.max_sug) = round(b.max_antes) THEN 'sem_mudanca'
      WHEN b.max_antes > 0 AND round(b.max_sug) > v_mult * round(b.max_antes) THEN 'segurado'
      ELSE 'aplicado'
    END AS status
  FROM base b;

  UPDATE public.sku_parametros sp SET
    sku_descricao = COALESCE(sp.sku_descricao, d.sku_descricao),  -- o nome é do catálogo (atualizar_descricao_sku_parametros); daqui só preenche o vazio
    fornecedor_nome = COALESCE(d.fornecedor_nome, sp.fornecedor_nome),
    demanda_media_diaria = d.demanda_media_diaria,
    demanda_desvio_padrao = d.demanda_sigma_diario,
    demanda_coef_variacao = d.coef_variacao_ordem,
    demanda_dias_com_movimento = d.num_ordens,
    valor_vendido_90d = d.valor_total_90d,
    lt_medio_dias_uteis = d.lead_time_medio,
    lt_desvio_padrao_dias = d.lead_time_desvio,
    lt_p95_dias = d.lt_p95_dias,
    fonte_leadtime = d.fonte_leadtime,
    z_score = d.z_aplicado,
    estoque_seguranca   = CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE sp.estoque_seguranca END,
    ponto_pedido        = CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE sp.ponto_pedido END,
    estoque_minimo      = CASE WHEN d.status='aplicado' THEN d.min_sug ELSE sp.estoque_minimo END,
    cobertura_alvo_dias = CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE sp.cobertura_alvo_dias END,
    estoque_maximo      = CASE WHEN d.status='aplicado' THEN d.max_sug ELSE sp.estoque_maximo END,
    ultima_atualizacao_calculo = NOW()
  FROM tmp_param_decidido d WHERE sp.id = d.id;

  SELECT count(*) FILTER (WHERE status='aplicado') INTO atualizados FROM tmp_param_decidido;

  DELETE FROM public.reposicao_param_pin p
  USING tmp_param_decidido d
  WHERE p.empresa = d.empresa AND p.sku_codigo_omie = d.sku_codigo_omie::text
    AND d.status = 'aplicado' AND d.ponto_pedido_rejeitado IS NOT NULL;

  IF p_run_id IS NOT NULL THEN
    INSERT INTO public.reposicao_param_auto_log (
      run_id, empresa, sku_codigo_omie, sku_descricao, status,
      ponto_pedido_antes, ponto_pedido_depois, estoque_minimo_antes, estoque_minimo_depois,
      estoque_maximo_antes, estoque_maximo_depois, estoque_seguranca_antes, estoque_seguranca_depois,
      cobertura_antes, cobertura_depois,
      ponto_pedido_sugerido, estoque_maximo_sugerido,   -- NOVO: o que o cálculo propôs (p/ segurado = o barrado)
      demanda_media_diaria, lt_medio_dias_uteis, classe_consolidada, z_score
    )
    SELECT p_run_id, d.empresa, d.sku_codigo_omie::text, d.sku_descricao, d.status,
      d.pp_antes,  CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE d.pp_antes END,
      d.min_antes, CASE WHEN d.status='aplicado' THEN d.min_sug ELSE d.min_antes END,
      d.max_antes, CASE WHEN d.status='aplicado' THEN d.max_sug ELSE d.max_antes END,
      d.ss_antes,  CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE d.ss_antes END,
      d.cob_antes, CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE d.cob_antes END,
      d.pp_sug, d.max_sug,   -- NOVO: sugerido cru (independe do status; p/ segurado NÃO é depois=antes)
      d.demanda_media_diaria, d.lead_time_medio, d.classe_consolidada, d.z_aplicado
    FROM tmp_param_decidido d
    WHERE d.status IN ('aplicado','segurado','pinado','bloqueado_validacao')
      AND d.habilitado = true AND d.tipo = 'automatica';

    WITH em_transito AS (
      SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
      FROM public.pedido_compra_item pci
      JOIN public.pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
      WHERE pcs2.empresa = p_empresa
        AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido')  -- [SIMULADO] PO real do dry_run
        AND pcs2.data_ciclo >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '7 days')
      GROUP BY pcs2.empresa, pci.sku_codigo_omie
    ),
    posicao AS (
      SELECT l.id AS log_id,
             (COALESCE(sea.estoque_fisico,0) + COALESCE(sea.estoque_pendente_entrada,0)
                + COALESCE(et.qtde,0)) AS pos,
             ip.custo, ip.custo_fonte
      FROM public.reposicao_param_auto_log l
      LEFT JOIN public.sku_estoque_atual sea
        ON sea.empresa = l.empresa AND sea.sku_codigo_omie = l.sku_codigo_omie
      LEFT JOIN em_transito et
        ON et.empresa = l.empresa AND et.sku_codigo_omie = l.sku_codigo_omie
      LEFT JOIN LATERAL (
        SELECT CASE WHEN ip0.cmc > 0 THEN ip0.cmc
                    WHEN ip0.preco_medio > 0 THEN ip0.preco_medio
                    ELSE NULL END AS custo,
               CASE WHEN ip0.cmc > 0 THEN 'cmc'
                    WHEN ip0.preco_medio > 0 THEN 'preco_medio'
                    ELSE NULL END AS custo_fonte
        FROM public.inventory_position ip0
        WHERE ip0.omie_codigo_produto::text = l.sku_codigo_omie
          AND ip0.account = lower(p_empresa)
        LIMIT 1
      ) ip ON true
      WHERE l.run_id = p_run_id
        AND l.status IN ('aplicado','segurado')
    )
    UPDATE public.reposicao_param_auto_log l SET
      custo_unitario   = p.custo,
      custo_fonte      = p.custo_fonte,
      qtde_compra_antes  = CASE WHEN p.pos <= l.ponto_pedido_antes  THEN GREATEST(0, l.estoque_maximo_antes  - p.pos) ELSE 0 END,
      qtde_compra_depois = CASE WHEN p.pos <= l.ponto_pedido_depois THEN GREATEST(0, l.estoque_maximo_depois - p.pos) ELSE 0 END,
      impacto_rs = CASE WHEN p.custo IS NULL THEN NULL ELSE
        ( (CASE WHEN p.pos <= l.ponto_pedido_depois THEN GREATEST(0, l.estoque_maximo_depois - p.pos) ELSE 0 END)
        - (CASE WHEN p.pos <= l.ponto_pedido_antes  THEN GREATEST(0, l.estoque_maximo_antes  - p.pos) ELSE 0 END)
        ) * p.custo END
    FROM posicao p
    WHERE l.id = p.log_id;
  END IF;

  RETURN atualizados;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.atualizar_descricao_sku_parametros(p_empresa text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_atualizados int := 0;
BEGIN
  UPDATE sku_parametros sp
  SET sku_descricao = trim(op.descricao)
  FROM omie_products op
  WHERE op.omie_codigo_produto::text = sp.sku_codigo_omie::text
    AND op.account = lower(sp.empresa)
    AND op.ativo = true
    AND op.descricao IS NOT NULL
    AND length(trim(op.descricao)) > 0
    AND trim(op.descricao) IS DISTINCT FROM sp.sku_descricao
    AND sp.empresa = p_empresa;
  GET DIAGNOSTICS v_atualizados = ROW_COUNT;

  -- Alerta pendente mostra o nome de HOJE (a descrição do alerta é foto da criação).
  UPDATE eventos_outlier eo
  SET sku_descricao = trim(op.descricao)
  FROM omie_products op
  WHERE op.omie_codigo_produto::text = eo.sku_codigo_omie
    AND op.account = lower(eo.empresa)
    AND op.descricao IS NOT NULL
    AND length(trim(op.descricao)) > 0
    AND trim(op.descricao) IS DISTINCT FROM eo.sku_descricao
    AND eo.status = 'pendente'
    AND eo.empresa = p_empresa;

  RETURN v_atualizados;
END;
$function$;

-- Roda uma vez agora (o cron `reposicao-refresh-descricao-diario` faz o mesmo todo dia às 05:45 SP).
SELECT public.atualizar_descricao_sku_parametros('OBEN');

-- PÓS: corpos são ESTES, ACL igual ao de antes, e nada pendente com nome diferente do catálogo.
DO $pos$
DECLARE
  v_n integer;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.atualizar_parametros_numericos_skus(text, uuid)')) IS DISTINCT FROM '7dd792877291ae06362f4d8249fedbf1' THEN
    RAISE EXCEPTION 'POS FALHOU: atualizar_parametros_numericos_skus não é o corpo deste arquivo';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.atualizar_descricao_sku_parametros(text)')) IS DISTINCT FROM '03be42ac8b01c6f77671f5bf26cb8157' THEN
    RAISE EXCEPTION 'POS FALHOU: atualizar_descricao_sku_parametros não é o corpo deste arquivo';
  END IF;
  SELECT count(*) INTO v_n
    FROM _acl_antes a JOIN pg_catalog.pg_proc p ON p.oid = a.oid
   WHERE p.proacl::text IS DISTINCT FROM a.acl;
  IF v_n > 0 OR (SELECT count(*) FROM _acl_antes) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'POS FALHOU: ACL mudou (ou função ausente) em % função(ões)', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM eventos_outlier eo
    JOIN omie_products op ON op.omie_codigo_produto::text = eo.sku_codigo_omie AND op.account = lower(eo.empresa)
   WHERE eo.status = 'pendente' AND eo.empresa = 'OBEN'
     AND length(trim(op.descricao)) > 0
     AND trim(op.descricao) IS DISTINCT FROM eo.sku_descricao;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: % alerta(s) pendente(s) com descrição diferente do catálogo', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM sku_parametros sp
    JOIN omie_products op ON op.omie_codigo_produto = sp.sku_codigo_omie AND op.account = lower(sp.empresa)
   WHERE sp.empresa = 'OBEN' AND op.ativo = true
     AND length(trim(op.descricao)) > 0
     AND trim(op.descricao) IS DISTINCT FROM sp.sku_descricao;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: % SKU(s) ativo(s) em sku_parametros com descrição diferente do catálogo', v_n;
  END IF;
END
$pos$;
