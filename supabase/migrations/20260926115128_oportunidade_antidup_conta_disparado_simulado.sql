-- ============================================================
-- Oportunidade — anti-compra-dupla [SIMETRIA-NORMAL] passa a ver 'disparado_simulado'
-- Money-path (compras). Recria gerar_pedidos_oportunidade_ciclo. ⚠️ NÃO auto-aplica (nome custom).
-- Pré-flight: md5(pg_get_functiondef) da PROD em 2026-09-26 = 614ee7e01b9e58008b9841b40585bacb =
-- o corpo da 20260922225449 (base deste arquivo; md5 reproduzido no PG17 local pelo harness).
-- ACL preservado por CREATE OR REPLACE. Provada em PG17: db/test-oportunidade-antidup-disparado-simulado.sh
-- (controle = versão da PROD oferece o SKU; conserto bloqueia; falsificação por lista).
--
-- Defeito (P1 LATENTE — compra dupla antecipada): os dois NOT EXISTS [SIMETRIA-NORMAL] (CTE do
-- header + INSERT de itens) listavam os status de pedido NORMAL que bloqueiam a oferta do SKU, SEM
-- 'disparado_simulado'. Mas o modo dry_run da edge disparar-pedidos-aprovados CHAMA IncluirPedCompra
-- e CRIA PEDIDO REAL no Omie (STATUS_FINAL_SUCESSO em email-politica.ts já o trata como sucesso; o
-- #2309 o fez estado pós-disparo no trigger de cancelamento; a 20260925225004 o pôs no em_transito
-- da gerar_pedidos_sugeridos_ciclo). Resultado: o SKU de um PO real do dry_run voltava a ser
-- ofertado no ciclo de oportunidade — e a qtde_oportunidade é compra ANTECIPADA, então o downside
-- da duplicata é maior que no motor normal.
-- Conserto: 'disparado_simulado' entra nas DUAS listas, logo após 'disparado' (mesma janela de 7
-- dias). A guarda [FANTASMA] não o alcança (exige status = 'aprovado_aguardando_disparo') — PO criado
-- no Omie bloqueia sempre DENTRO da janela (data_ciclo >= D−7; D−8 já libera, igual a 'disparado').
-- A janela conta do data_ciclo, não do disparo nem do recebimento: PO aberto há mais de 7 dias não
-- protege — limite PRÉ-EXISTENTE, fora do escopo (Codex desenho P2). Nada mais do corpo muda.
--
-- ⚠️ SINAL (PROD, psql-ro 2026-09-26): 0 linhas com status 'disparado_simulado' no histórico inteiro e
-- 0 pedidos de oportunidade já gerados — latente, não incidente; não recupera caixa hoje.
-- Guard permanente: edges-onorder-guardrail.test.ts passa a exigir em_transito do motor ⊆ cada lista
-- anti-dup daqui (status novo que vira "a caminho" tem de bloquear a oferta também).
--
-- Rollback: reaplicar a 20260922225449 (a anterior a recriar esta função).

BEGIN;

CREATE OR REPLACE FUNCTION public.gerar_pedidos_oportunidade_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE, p_cenarios text[] DEFAULT ARRAY['promo_flat'::text, 'promo_volume'::text, 'promo_e_aumento'::text, 'aumento_apenas'::text])
 RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total numeric, economia_bruta numeric, cenarios_cobertos text[])
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
              AND pcsn.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio','disparado','disparado_simulado','concluido_recebido')
              -- 'disparado_simulado' = PO REAL no Omie: o dry_run da edge disparar-pedidos-aprovados chama
              -- IncluirPedCompra. Espelha o em_transito do motor (20260925225004); fora da lista, o SKU desse
              -- PO voltava a ser ofertado aqui = compra dupla antecipada.
              -- [FANTASMA] espelha a guarda da RPC normal (migration 20260802120000, pedido #1276):
              -- erro TERMINAL do portal significa que NADA foi colocado no fornecedor, logo NAO ha
              -- compra para duplicar — e bloquear a oferta so queima a economia da promocao/aumento.
              -- Fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou n. do pedido
              -- no Omie) para o pedido seguir bloqueando. Comprar duas vezes queima caixa; aqui o
              -- downside e MAIOR que na RPC normal, porque a qtde de oportunidade e antecipada.
              -- IS NOT DISTINCT FROM, nao "=": negacao e NULL-blind. Com "=" e a coluna NULL o
              -- predicado inteiro vira NULL, NOT(NULL) e NULL, e o pedido SAUDAVEL desaparece do
              -- NOT EXISTS — destravando a oferta de TODO SKU em pedido aprovado (compra dupla em
              -- escala, nao so no caso fantasma). Pego pelo db/test-oportunidade-erro-terminal.sh.
              AND NOT (
                    pcsn.status = 'aprovado_aguardando_disparo'
                AND pcsn.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
                AND pcsn.portal_protocolo IS NULL
                AND pcsn.omie_pedido_compra_numero IS NULL
              )
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
            AND pcsn.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio','disparado','disparado_simulado','concluido_recebido')
            -- 'disparado_simulado' = PO REAL no Omie: o dry_run da edge disparar-pedidos-aprovados chama
            -- IncluirPedCompra. Espelha o em_transito do motor (20260925225004); fora da lista, o SKU desse
            -- PO voltava a ser ofertado aqui = compra dupla antecipada.
            -- [FANTASMA] espelha a guarda da RPC normal (migration 20260802120000, pedido #1276):
            -- erro TERMINAL do portal significa que NADA foi colocado no fornecedor, logo NAO ha
            -- compra para duplicar — e bloquear a oferta so queima a economia da promocao/aumento.
            -- Fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou n. do pedido
            -- no Omie) para o pedido seguir bloqueando. Comprar duas vezes queima caixa; aqui o
            -- downside e MAIOR que na RPC normal, porque a qtde de oportunidade e antecipada.
            -- IS NOT DISTINCT FROM, nao "=": negacao e NULL-blind. Com "=" e a coluna NULL o
            -- predicado inteiro vira NULL, NOT(NULL) e NULL, e o pedido SAUDAVEL desaparece do
            -- NOT EXISTS — destravando a oferta de TODO SKU em pedido aprovado (compra dupla em
            -- escala, nao so no caso fantasma). Pego pelo db/test-oportunidade-erro-terminal.sh.
            AND NOT (
                  pcsn.status = 'aprovado_aguardando_disparo'
              AND pcsn.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
              AND pcsn.portal_protocolo IS NULL
              AND pcsn.omie_pedido_compra_numero IS NULL
            )
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
$function$;

-- Postcondição: 'disparado_simulado' nas DUAS listas (header e itens divergiriam com uma só) e a
-- guarda [FANTASMA] da 20260922225449 intacta nos dois blocos.
DO $post$
DECLARE v_def text; v_n int;
  c_lista constant text := '''disparado'',''disparado_simulado'',''concluido_recebido''';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'gerar_pedidos_oportunidade_ciclo';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: gerar_pedidos_oportunidade_ciclo nao existe apos o replace';
  END IF;

  v_n := (length(v_def) - length(replace(v_def, c_lista, ''))) / length(c_lista);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: disparado_simulado em % lista(s), esperado 2 (header + itens) — PO real do dry_run seguiria re-ofertado', v_n;
  END IF;

  v_n := (length(v_def) - length(replace(v_def, 'erro_nao_retentavel', ''))) / length('erro_nao_retentavel');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: guarda [FANTASMA] aparece % vez(es), esperado 2', v_n;
  END IF;

  IF v_def NOT LIKE '%omie_pedido_compra_numero IS NULL%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: guarda sem o sinal do numero Omie — deixaria de ser fail-CLOSED';
  END IF;
END
$post$;

COMMIT;
