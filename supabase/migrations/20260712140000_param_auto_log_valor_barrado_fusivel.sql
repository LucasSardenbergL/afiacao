-- Reposição — resumo diário: mostrar O VALOR que o fusível barrou (não só o nome do item segurado)
-- ============================================================================
-- Pedido do founder: no e-mail, o item segurado deve dizer O QUE o fusível impediu — ex.:
--   "SAYERMASSA JATOBA — quis subir máx 2 → 7 (barrado)" — pra o "confira" ser acionável.
--
-- PROBLEMA: o log (reposicao_param_auto_log) grava, para um SEGURADO, depois=antes e DESCARTA o
--   valor sugerido que foi barrado (o core só persiste o sugerido implicitamente em 'aplicado', via
--   depois=sug). Então o e-mail não tinha de onde ler "o que o fusível queria fazer".
--
-- CORREÇÃO (3 partes, money-path — toca o CORE que decide aplicar/segurar):
--   (1) ALTER: 2 colunas novas no log — ponto_pedido_sugerido / estoque_maximo_sugerido (o que o
--       cálculo SUGERIU, independente do status). Para segurado = o valor barrado. Nullable (linhas
--       antigas ficam NULL — degradam honesto).
--   (2) CORE atualizar_parametros_numericos_skus: grava d.pp_sug / d.max_sug no INSERT do log. Resto
--       VERBATIM da versão viva em prod (pg_get_functiondef 2026-07-12, == BLOCO D 20260605150000,
--       regra do fusível = só multiplicador; zero drift). Mudança ADITIVA: só acrescenta 2 colunas ao
--       INSERT — não altera decisão, UPDATE de config, impacto nem gating.
--   (3) TICK reposicao_param_auto_resumo_tick: na seção "Segurados pelo fusível", mostra
--       "quis subir máx <antes> → <sugerido> (barrado; giro <d>/dia)". DEGRADAÇÃO GRACIOSA: se o
--       sugerido faltar (run gravado pelo core ANTIGO, ex.: o de hoje), cai no formato só-nome
--       "(máx atual <antes>, giro <d>/dia)" — nunca "→ ?" feio. Resto = o corpo do #1302
--       (altas/reduções/fallback), INCLUÍDO aqui verbatim ("a última a recriar vence").
--
-- Ordem no bloco: ALTER antes do CORE (senão o INSERT referencia coluna inexistente em runtime).
-- Provado em PostgreSQL 17 local (db/test-param-auto.sh): core grava sugerido (B→400) · tick mostra
-- "quis subir máx 100 → 400" · degradação graciosa (sugerido NULL → só-nome) · falsificação (core não
-- grava → valor barrado some; tick formato-#1302 → "quis subir" some).
BEGIN;

-- ── (1) Colunas do sugerido no log (o que o cálculo propôs; p/ segurado = o barrado) ──
ALTER TABLE public.reposicao_param_auto_log
  ADD COLUMN IF NOT EXISTS ponto_pedido_sugerido numeric,
  ADD COLUMN IF NOT EXISTS estoque_maximo_sugerido numeric;

-- ── (2) CORE: grava o sugerido no log (VERBATIM da prod EXCETO 2 colunas no INSERT) ──
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
        AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
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

-- ── (3) TICK: seção "Segurados" mostra o valor barrado (degradação graciosa se sugerido faltar) ──
CREATE OR REPLACE FUNCTION public.reposicao_param_auto_resumo_tick()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE
  r record;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_corpo text;
  v_altas text;
  v_reducoes text;
  v_segurados text;
  v_sem_efeito int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('param_auto_resumo'));
  SELECT * INTO r FROM public.reposicao_param_auto_run
    WHERE data_negocio_brt=v_hoje AND status='completo' AND resumo_enviado_em IS NULL
    ORDER BY concluido_em DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF COALESCE(r.total_aplicados,0)=0 AND COALESCE(r.total_segurados,0)=0 THEN
    UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;
    RETURN;
  END IF;

  SELECT string_agg(format('• %s: PP %s→%s, máx %s→%s (R$ +%s)',
            coalesce(nullif(btrim(sku_descricao), ''), sku_codigo_omie),
            coalesce(ponto_pedido_antes::text,'—'), coalesce(ponto_pedido_depois::text,'—'),
            coalesce(estoque_maximo_antes::text,'—'), coalesce(estoque_maximo_depois::text,'—'),
            round(impacto_rs)::text), E'\n' ORDER BY impacto_rs DESC)
    INTO v_altas FROM (
      SELECT * FROM public.reposicao_param_auto_log
      WHERE run_id=r.id AND status='aplicado' AND impacto_rs > 0
      ORDER BY impacto_rs DESC LIMIT 5) t;

  SELECT string_agg(format('• %s: PP %s→%s, máx %s→%s (R$ %s)',
            coalesce(nullif(btrim(sku_descricao), ''), sku_codigo_omie),
            coalesce(ponto_pedido_antes::text,'—'), coalesce(ponto_pedido_depois::text,'—'),
            coalesce(estoque_maximo_antes::text,'—'), coalesce(estoque_maximo_depois::text,'—'),
            round(impacto_rs)::text), E'\n' ORDER BY impacto_rs ASC)
    INTO v_reducoes FROM (
      SELECT * FROM public.reposicao_param_auto_log
      WHERE run_id=r.id AND status='aplicado' AND impacto_rs < 0
      ORDER BY impacto_rs ASC LIMIT 5) t;

  -- Segurados: mostra O QUE o fusível barrou (máx atual → sugerido). Se o sugerido faltar (run gravado
  -- pelo core antigo), cai no formato só-nome — nunca "→ ?".
  SELECT string_agg(
           CASE WHEN estoque_maximo_sugerido IS NOT NULL THEN
             format(E'• %s\n  quis subir máx %s → %s (barrado; giro %s/dia)',
               coalesce(nullif(btrim(sku_descricao), ''), sku_codigo_omie),
               coalesce(estoque_maximo_antes::text,'—'), estoque_maximo_sugerido::text,
               coalesce(round(demanda_media_diaria, 2)::text,'?'))
           ELSE
             format('• %s (máx atual %s, giro %s/dia)',
               coalesce(nullif(btrim(sku_descricao), ''), sku_codigo_omie),
               coalesce(estoque_maximo_antes::text,'—'),
               coalesce(round(demanda_media_diaria, 2)::text,'?'))
           END, E'\n' ORDER BY estoque_maximo_sugerido DESC NULLS LAST, estoque_maximo_antes DESC NULLS LAST)
    INTO v_segurados FROM (
      SELECT * FROM public.reposicao_param_auto_log
      WHERE run_id=r.id AND status='segurado'
      ORDER BY estoque_maximo_sugerido DESC NULLS LAST, estoque_maximo_antes DESC NULLS LAST LIMIT 5) t;

  SELECT count(*) INTO v_sem_efeito FROM public.reposicao_param_auto_log
    WHERE run_id=r.id AND status='aplicado' AND impacto_rs = 0;

  v_corpo :=
       format('%s parâmetros mudaram hoje (OBEN).', r.total_aplicados)
    || format(E'\nImpacto estimado total: R$ %s%s', round(COALESCE(r.impacto_total_rs,0)),
         CASE WHEN COALESCE(r.impacto_desconhecido_n,0)>0 THEN ' (+'||r.impacto_desconhecido_n||' sem custo)' ELSE '' END)
    || CASE WHEN v_altas    IS NOT NULL THEN E'\n\nMaiores altas:\n'    || v_altas    ELSE '' END
    || CASE WHEN v_reducoes IS NOT NULL THEN E'\n\nMaiores reduções:\n' || v_reducoes ELSE '' END
    || format(E'\n\nSegurados pelo fusível (confira): %s', COALESCE(r.total_segurados,0))
    || CASE WHEN v_segurados IS NOT NULL THEN E'\n' || v_segurados ELSE '' END
    || CASE WHEN COALESCE(v_sem_efeito,0) > 0
            THEN format(E'\n\n+%s ajuste(s) sem efeito na compra de hoje.', v_sem_efeito) ELSE '' END
    || E'\n\nVeja e reverta em: /admin/reposicao/mudancas-automaticas';

  INSERT INTO public.fornecedor_alerta (tipo, titulo, mensagem, empresa, severidade, status)
    VALUES ('param_auto_resumo', 'Parâmetros de reposição — resumo do dia', v_corpo, r.empresa, 'info', 'pendente_notificacao');
  UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;
END;
$$;
REVOKE ALL ON FUNCTION public.reposicao_param_auto_resumo_tick() FROM anon, authenticated, public;

COMMIT;

SELECT 'param_auto_log_valor_barrado_fusivel OK' AS status;
