-- Reposição — fixes do adversarial retroativo do Codex no #711 (P1.2 + P3.2)
-- ============================================================================
-- Spec: docs/superpowers/specs/2026-06-09-reposicao-intraday-alerta-3k-design.md (seção pós-review)
-- Codex xhigh 2026-06-11 (revisão retroativa, caminho B do #711). Dois fixes SQL:
--
-- (1) [SIMETRIA-NORMAL] gerar_pedidos_oportunidade_ciclo: a proteção anti-compra-dupla do #711
--     era UNILATERAL — a RPC normal não re-sugere SKU em oportunidade pendente (NOT EXISTS 4/4),
--     mas a oportunidade nascia COM SKU já presente em pedido normal economicamente ativo →
--     janela de ~70min/dia (11h05→12h15 UTC) onde aprovar os dois = compra dupla. Agora a
--     oportunidade DESVIA de SKU em pedido normal ativo (pendente/bloqueado/aprovado/falha_envio/
--     disparado/concluído ≤7d — espelha a janela do em_transito). Semanticamente correto: SKU que
--     precisa repor E tem campanha já ganha o desconto via aplicar_promocoes_no_ciclo NO pedido
--     normal; a oportunidade é pro SKU que NÃO está em compra. O NOT EXISTS vai nos DOIS WHEREs
--     (CTE oportunidades + INSERT de itens, que re-lê a view) — só no CTE divergiria
--     header.num_skus × itens. Corpo = VERBATIM do schema-snapshot + as 2 marcas.
--
-- (2) [CAST-SEGURO] reposicao_alerta_pedido_minimo_tick: `value::numeric` com config malformada
--     (ex.: 'abc') derrubava o tick com exceção → o alerta morria silenciosamente até alguém
--     consertar a config. Agora cast com EXCEPTION handler → config malformada = alerta
--     desligado (mesmo tratamento de config ausente), sem matar o cron.
--
-- (3) [FIX-AMBIGUIDADE] BÔNUS achado pelo PG17 ao EXECUTAR a função: o agregado final do corpo
--     do snapshot tem `SUM(valor_total)` ambíguo com a coluna OUT homônima do RETURNS TABLE →
--     erro de RUNTIME (o CREATE passa, late-bound). Se a def viva de prod == snapshot, a
--     geração de oportunidades FALHAVA silenciosamente em todo dia com evento (o wrapper
--     ciclo_oportunidade_do_dia só a chama em dia de corte de campanha/véspera de aumento;
--     a exceção propagava e o cron dava rollback). ⚠️ Aplicar esta migration pode LIGAR a
--     feature de pedidos de oportunidade (precedente: aplicar_promocoes, §10) — revisar a
--     1ª rodada com evento. Por isso o pré-flight pede o functiondef VIVO de prod.
--
-- ⚠️ Migration MANUAL (Lovable): colar no SQL Editor → Run. PRÉ-FLIGHT (anti-drift §10): a def
-- viva de prod de gerar_pedidos_oportunidade_ciclo deve conter 'Remove pedidos oportunidade
-- pendentes' e NÃO conter 'SIMETRIA-NORMAL' (ver query no fim). Divergência = ABORTAR.
-- ⚠️ REQUER redeploy da edge disparar-pedidos-aprovados (P1.1 corte expira só oportunidades +
-- P1.3 gate fail-closed em erro de leitura da config) via chat do Lovable.

BEGIN;

-- ── (1) gerar_pedidos_oportunidade_ciclo com [SIMETRIA-NORMAL] ───────────────
CREATE OR REPLACE FUNCTION public.gerar_pedidos_oportunidade_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE, p_cenarios text[] DEFAULT ARRAY['promo_flat'::text, 'promo_volume'::text, 'promo_e_aumento'::text, 'aumento_apenas'::text]) RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total numeric, economia_bruta numeric, cenarios_cobertos text[])
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_pedidos int := 0;
  v_skus int := 0;
  v_valor numeric := 0;
  v_economia numeric := 0;
  v_cenarios_encontrados text[];
BEGIN
  -- Remove pedidos oportunidade pendentes do mesmo ciclo (idempotente)
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa
    AND data_ciclo = p_data_ciclo
    AND tipo_ciclo LIKE 'oportunidade_%'
    AND status = 'pendente_aprovacao';

  -- Identifica cenários presentes
  SELECT array_agg(DISTINCT cenario) INTO v_cenarios_encontrados
  FROM v_oportunidade_economica_hoje
  WHERE empresa = p_empresa
    AND cenario = ANY(p_cenarios)
    AND economia_bruta_estimada > 0;

  -- Gera um pedido por (fornecedor, cenário_tipo)
  -- cenário_tipo: 'promo' (inclui flat, volume, promo_e_aumento) ou 'aumento'
  WITH oportunidades AS (
    SELECT *,
      CASE
        WHEN cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
          THEN 'oportunidade_promo'
        ELSE 'oportunidade_aumento'
      END AS tipo_ciclo_dest,
      CASE
        WHEN cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
          THEN campanha_id
        ELSE NULL
      END AS evento_promo_id,
      CASE
        WHEN cenario = 'aumento_apenas'
          THEN (aumentos_json -> 0 -> 0 ->> 'aumento_id')::bigint
        ELSE NULL
      END AS evento_aumento_id
    FROM v_oportunidade_economica_hoje voeh
    WHERE voeh.empresa = p_empresa
      AND voeh.cenario = ANY(p_cenarios)
      AND voeh.economia_bruta_estimada > 0
      AND voeh.qtde_oportunidade > 0
      -- [SIMETRIA-NORMAL] não oferecer SKU que JÁ está em pedido NORMAL economicamente ativo
      -- (espelha o NOT EXISTS 4/4 da RPC normal, na direção inversa — anti compra dupla).
      AND NOT EXISTS (
            SELECT 1
            FROM pedido_compra_item pcin
            JOIN pedido_compra_sugerido pcsn ON pcsn.id = pcin.pedido_id
            WHERE pcsn.empresa = p_empresa
              AND COALESCE(pcsn.tipo_ciclo, 'normal') = 'normal'
              AND pcsn.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio','disparado','concluido_recebido')
              AND pcsn.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
              AND pcin.sku_codigo_omie = voeh.sku_codigo_omie::text
          )
  ),
  pedidos_criados AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_corte_planejado, valor_total, num_skus, status,
      tipo_ciclo, origem_evento_id, origem_evento_tipo
    )
    SELECT
      o.empresa,
      o.fornecedor_nome,
      NULL,  -- oportunidade não respeita grupo; é um pedido único por fornecedor
      p_data_ciclo,
      (p_data_ciclo + TIME '18:00')::timestamptz,
      SUM(o.qtde_oportunidade * o.preco_item_eoq),
      COUNT(*),
      'pendente_aprovacao',
      o.tipo_ciclo_dest,
      COALESCE(o.evento_promo_id, o.evento_aumento_id),
      CASE WHEN o.evento_promo_id IS NOT NULL THEN 'campanha_promocao' ELSE 'aumento_anunciado' END
    FROM oportunidades o
    GROUP BY o.empresa, o.fornecedor_nome, o.tipo_ciclo_dest, o.evento_promo_id, o.evento_aumento_id
    RETURNING id, fornecedor_nome, tipo_ciclo, origem_evento_id, origem_evento_tipo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao,
    estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra,
    modo_promocao, promocao_item_id, preco_sem_desconto, desconto_perc_aplicado,
    economia_estimada_valor
  )
  SELECT
    pc.id,
    o.sku_codigo_omie,
    o.sku_descricao,
    NULL, NULL, NULL,  -- não aplicável em oportunidade
    o.qtde_oportunidade,
    o.qtde_oportunidade,
    o.preco_item_eoq * (1 - o.desconto_total_perc / 100),
    o.qtde_oportunidade * o.preco_item_eoq * (1 - o.desconto_total_perc / 100),
    false,
    CASE
      WHEN o.cenario IN ('promo_flat') THEN 'flat'
      WHEN o.cenario IN ('promo_volume', 'promo_e_aumento') THEN 'forward_buying'
      ELSE NULL
    END,
    o.promo_item_id,
    o.preco_item_eoq,
    o.desconto_total_perc,
    o.economia_bruta_estimada
  FROM v_oportunidade_economica_hoje o
  JOIN pedidos_criados pc ON (
    pc.fornecedor_nome = o.fornecedor_nome
    AND pc.tipo_ciclo = CASE
      WHEN o.cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
        THEN 'oportunidade_promo'
      ELSE 'oportunidade_aumento'
    END
  )
  WHERE o.empresa = p_empresa
    AND o.cenario = ANY(p_cenarios)
    AND o.economia_bruta_estimada > 0
    AND o.qtde_oportunidade > 0
    -- [SIMETRIA-NORMAL] mesmo filtro do CTE — o INSERT de itens re-lê a view; sem o espelho,
    -- um SKU excluído do header entraria como item de pedido criado por outros SKUs.
    AND NOT EXISTS (
          SELECT 1
          FROM pedido_compra_item pcin
          JOIN pedido_compra_sugerido pcsn ON pcsn.id = pcin.pedido_id
          WHERE pcsn.empresa = p_empresa
            AND COALESCE(pcsn.tipo_ciclo, 'normal') = 'normal'
            AND pcsn.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio','disparado','concluido_recebido')
            AND pcsn.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
            AND pcin.sku_codigo_omie = o.sku_codigo_omie::text
        );

  -- Agrega retorno
  -- [FIX-AMBIGUIDADE] o corpo do snapshot fazia SUM(valor_total) sem qualificar — colide com a
  -- coluna OUT homônima do RETURNS TABLE → "column reference valor_total is ambiguous" em
  -- RUNTIME (late-bound; o CREATE passa). Como o wrapper ciclo_oportunidade_do_dia só chama
  -- esta função em dia de corte de campanha/véspera de aumento, a falha era SILENCIOSA e
  -- ocorria exatamente nos dias com evento (rollback no cron — pedido de oportunidade nunca
  -- nascia). Mesmo modo-de-falha do incidente aplicar_promocoes (§10). Pego pelo PG17 que
  -- EXECUTA a função, não só a cria.
  SELECT
    COUNT(*),
    COALESCE(SUM(pcs0.num_skus), 0),
    COALESCE(SUM(pcs0.valor_total), 0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido pcs0
  WHERE pcs0.empresa = p_empresa
    AND pcs0.data_ciclo = p_data_ciclo
    AND pcs0.tipo_ciclo LIKE 'oportunidade_%'
    AND pcs0.status = 'pendente_aprovacao';

  SELECT COALESCE(SUM(economia_estimada_valor), 0)
  INTO v_economia
  FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.empresa = p_empresa
    AND pcs.data_ciclo = p_data_ciclo
    AND pcs.tipo_ciclo LIKE 'oportunidade_%'
    AND pcs.status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_economia, v_cenarios_encontrados;
END;
$$;

-- ── (2) Tick do alerta com cast seguro ───────────────────────────────────────
-- Idêntico à 20260609150000, exceto o bloco de leitura da config ([CAST-SEGURO]).
CREATE OR REPLACE FUNCTION public.reposicao_alerta_pedido_minimo_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_threshold numeric;
  v_fornecedor text;
  r RECORD;
BEGIN
  -- [CAST-SEGURO] config malformada (value não-numérico) não pode MATAR o tick — vira alerta
  -- desligado, igual a config ausente (o cron continua saudável; quem mexeu na config vê o
  -- alerta parar e conserta).
  BEGIN
    SELECT value::numeric INTO v_threshold
    FROM public.company_config WHERE key = 'reposicao_alerta_pedido_valor_minimo';
  EXCEPTION WHEN others THEN
    v_threshold := NULL;
  END;
  SELECT value INTO v_fornecedor
  FROM public.company_config WHERE key = 'reposicao_alerta_pedido_fornecedor_ilike';

  IF v_threshold IS NULL OR v_threshold <= 0
     OR v_fornecedor IS NULL OR btrim(v_fornecedor) = '' THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT pcs.empresa, pcs.fornecedor_nome,
           COALESCE(pcs.grupo_codigo, '') AS grupo_codigo,
           MAX(pcs.valor_total) AS valor,
           SUM(COALESCE(pcs.num_skus, 0)) AS num_skus,
           MAX(pcs.id) AS pedido_id
    FROM public.pedido_compra_sugerido pcs
    WHERE pcs.status = 'pendente_aprovacao'
      AND pcs.fornecedor_nome ILIKE v_fornecedor
      AND pcs.valor_total >= v_threshold
    GROUP BY 1, 2, 3
  LOOP
    INSERT INTO public.reposicao_alerta_pedido_minimo
      (empresa, fornecedor_nome, grupo_codigo, pedido_id, valor_alertado, valor_ultimo)
    VALUES (r.empresa, r.fornecedor_nome, r.grupo_codigo, r.pedido_id, r.valor, r.valor)
    ON CONFLICT (empresa, fornecedor_nome, grupo_codigo) WHERE resolvido_em IS NULL
    DO NOTHING;

    IF FOUND THEN
      INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES (
        lower(r.empresa),
        'reposicao_pedido_minimo',
        'atencao',
        '[Compras] Pedido ' || r.fornecedor_nome || ' atingiu R$ ' || round(r.valor)::text
          || ' — pronto pra aprovar',
        'O pedido sugerido de ' || r.fornecedor_nome
          || CASE WHEN r.grupo_codigo <> '' THEN ' (grupo ' || r.grupo_codigo || ')' ELSE '' END
          || ' acumulou R$ ' || round(r.valor)::text
          || ' (' || r.num_skus::text || ' SKUs) — acima do mínimo de faturamento (R$ '
          || round(v_threshold)::text || '). Aprovar dispara na hora: '
          || 'Reposição → Pedidos (https://steu.lovable.app/admin/reposicao/pedidos). '
          || 'Quando você aprovar (ou o pedido sair da régua), este aviso re-arma sozinho.',
        'pendente_notificacao'
      );
    ELSE
      UPDATE public.reposicao_alerta_pedido_minimo a
      SET valor_ultimo = r.valor, pedido_id = r.pedido_id
      WHERE a.empresa = r.empresa AND a.fornecedor_nome = r.fornecedor_nome
        AND a.grupo_codigo = r.grupo_codigo AND a.resolvido_em IS NULL;
    END IF;
  END LOOP;

  UPDATE public.reposicao_alerta_pedido_minimo a
  SET resolvido_em = now()
  WHERE a.resolvido_em IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.pedido_compra_sugerido pcs
      WHERE pcs.empresa = a.empresa
        AND pcs.fornecedor_nome = a.fornecedor_nome
        AND COALESCE(pcs.grupo_codigo, '') = a.grupo_codigo
        AND pcs.status = 'pendente_aprovacao'
        AND pcs.valor_total >= v_threshold
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() TO service_role;

COMMIT;

-- PRÉ-FLIGHT (rodar ANTES de aplicar; esperado: base_ok=true, ja_aplicada=false):
-- SELECT
--   (pg_get_functiondef('public.gerar_pedidos_oportunidade_ciclo(text,date,text[])'::regprocedure)
--      LIKE '%Remove pedidos oportunidade pendentes%') AS base_ok,
--   (pg_get_functiondef('public.gerar_pedidos_oportunidade_ciclo(text,date,text[])'::regprocedure)
--      LIKE '%SIMETRIA-NORMAL%') AS ja_aplicada;
--
-- Validação (rodar após o COMMIT):
-- SELECT 'FIXES CODEX OK' AS status,
--   (SELECT count(*) FROM pg_proc WHERE proname='gerar_pedidos_oportunidade_ciclo'
--     AND pg_get_functiondef(oid) LIKE '%SIMETRIA-NORMAL%') AS simetria_1,
--   (SELECT count(*) FROM pg_proc WHERE proname='reposicao_alerta_pedido_minimo_tick'
--     AND pg_get_functiondef(oid) LIKE '%CAST-SEGURO%') AS cast_seguro_1;
