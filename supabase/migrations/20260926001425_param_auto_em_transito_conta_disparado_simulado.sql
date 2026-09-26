-- ============================================================
-- Reposição (parâmetros automáticos) — o em_transito do IMPACTO conta 'disparado_simulado'
-- Money-path. Recria atualizar_parametros_numericos_skus. ⚠️ NÃO auto-aplica (nome custom).
-- Pré-flight: md5(pg_get_functiondef) da PROD em 2026-09-26 = 8a348c85eaa95f0d92eba02baba2c0b9 =
-- o CORE da 20260712140000 (base deste arquivo; md5 reproduzido no PG17 por db/test-param-auto.sh).
-- ACL preservado por CREATE OR REPLACE. Par da 20260925225004 + edge omie-sync-estoque v1.2.
--
-- Por quê: o on-order é de FONTE ÚNICA entre 3 consumidores do mesmo predicado de status —
--   gerar_pedidos_sugeridos_ciclo (em_transito do motor), ESTA função (em_transito da posição que
--   calcula qtde_compra_antes/depois e impacto_rs do log) e a edge omie-sync-estoque, que TIRA do
--   estoque_pendente_entrada os POs desses status. A edge v1.2 passa a tirar 'disparado_simulado'
--   (o dry_run cria PO REAL no Omie); sem esta migration, o PO simulado contaria 0× aqui e o impacto
--   do log/tela/resumo sairia errado (ex.: físico 1, PO 4, PP 3, máx 5→7, custo R$100: posição
--   correta 5 e impacto 0; sem o status, posição 1 e impacto +R$200 — achado Codex, 2ª rodada).
--   Só afeta log/tela/e-mail: o fusível decide pela razão do máximo, não pelo impacto.
-- ORDEM: esta migration ANTES do deploy da edge v1.2 (antes do deploy, o PO simulado conta 2× só
--   aqui — sobreestima a posição; PROD: 0 linhas 'disparado_simulado' e modo_disparo = producao).
--
-- O que muda: 'disparado_simulado' na lista do em_transito. NADA mais do corpo é tocado (a CTE daqui
-- segue sem a guarda [FANTASMA] e sem o 2º ramo do motor — divergência PRÉ-EXISTENTE, fora do escopo).
-- Prova: db/test-param-auto.sh (bloco [SIMULADO]: controle com a versão da PROD = impacto 500,
-- conserto = 1000, falsificação comportamental + da postcondição).
-- Paridade das 3 listas: src/lib/reposicao/__tests__/edges-onorder-guardrail.test.ts.
-- Rollback: reaplicar o CORE da 20260712140000.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.atualizar_parametros_numericos_skus(p_empresa text, p_run_id uuid DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
  AS $$
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
    sku_descricao = COALESCE(d.sku_descricao, sp.sku_descricao),
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
        AND pcs2.data_ciclo >= (CURRENT_DATE - INTERVAL '7 days')
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
$$;

DO $post$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'atualizar_parametros_numericos_skus';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU: atualizar_parametros_numericos_skus nao existe apos o replace';
  END IF;
  -- Os LIKE medem o CODIGO: comentarios de linha e de bloco saem antes (o predicado esperado sobrevivendo
  -- so num comentario daria verde com o codigo revertido). Nenhum literal da funcao contem "--" nem "/*".
  v_def := regexp_replace(v_def, '/\*.*?\*/', '', 'g');
  v_def := regexp_replace(v_def, '--[^' || chr(10) || ']*', '', 'g');
  IF v_def NOT LIKE '%pcs2.status IN (''aprovado_aguardando_disparo'',''disparado'',''disparado_simulado'',''concluido_recebido'')%' THEN
    RAISE EXCEPTION 'POST FALHOU: em_transito do impacto nao conta disparado_simulado — com a edge v1.2 o PO do dry_run contaria 0x';
  END IF;
  IF v_def NOT LIKE '%ponto_pedido_sugerido, estoque_maximo_sugerido%' THEN
    RAISE EXCEPTION 'POST FALHOU: o log perdeu o valor sugerido (20260712140000) — o replace partiu da base errada';
  END IF;
  RAISE NOTICE 'OK: em_transito do impacto conta disparado_simulado + sugerido no log preservado';
END
$post$;

COMMIT;
