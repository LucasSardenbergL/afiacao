-- Frente B — Mínimo de compra forçado por SKU (a "R" pedida pelo founder)
-- ============================================================================
-- Alguns SKUs OBRIGAM uma quantidade mínima de compra (fornecedor/embalagem) acima
-- do que o motor sugere naturalmente. Esta migration adiciona o piso:
--   PARTE A: coluna sku_parametros.minimo_forcado_manual (numeric NULL) + CHECK.
--   PARTE B: RPC gerar_pedidos_sugeridos_ciclo — qtde_final = piso(natural, mínimo).
--   PARTE C: view v_otimizador_compras_insumos expõe minimo_forcado_manual ao otimizador.
--
-- ⚠️ TIMESTAMP REALOCADO 20260604170000 → 20260604190000 e RPC REBASEADA:
--   três migrations nasceram com 20260604170000 em sessões paralelas; DUAS tocam ESTA RPC
--   money-path (esta + 20260604170000_reposicao_blindar_sku_sem_fornecedor). Para a minha
--   aplicar DEPOIS (timestamp maior) e NÃO apagar a blindagem da irmã, o corpo da RPC aqui
--   é VERBATIM de 20260604170000_reposicao_blindar_sku_sem_fornecedor (= 20260604140000 +
--   guarda "fornecedor_nome IS NOT NULL / btrim<>''"), acrescido das 4 marcas [MIN-FORCADO].
--   Assim esta RPC contém AMBAS as mudanças (blindagem de fornecedor + mínimo forçado).
--   Aplicar esta migration por ÚLTIMO entre as 20260604* que tocam a RPC.
--
-- Princípios (degradação honesta, money-path):
--   • PISO, NUNCA GATILHO — o mínimo só eleva item que JÁ passou no gate de necessidade
--     (estoque_efetivo <= ponto_pedido) E cujo qtde_natural > 0 (filtro inalterado). Nunca
--     força comprar item sobre-estocado.
--   • qtde_sugerida = natural (referência/audit); qtde_final = forçada (o que dispara ao Omie).
--   • NULL → sem piso = comportamento atual idêntico. CHECK rejeita <=0/NaN/Infinity.
-- NÃO regenera o ciclo aqui (Checkpoint consciente do founder). Idempotente. Aplicar manual
-- via SQL Editor do Lovable. Spec: docs/superpowers/specs/2026-06-04-reposicao-minimo-forcado-design.md
-- ============================================================================

-- ─── PARTE A — coluna + CHECK ───
ALTER TABLE public.sku_parametros ADD COLUMN IF NOT EXISTS minimo_forcado_manual numeric;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sku_parametros_minimo_forcado_valido' AND conrelid = 'public.sku_parametros'::regclass) THEN
    ALTER TABLE public.sku_parametros
      ADD CONSTRAINT sku_parametros_minimo_forcado_valido
      -- > 0 E < 'Infinity'::numeric. Em Postgres NaN ordena ACIMA de Infinity, então
      -- 'NaN'::numeric < 'Infinity'::numeric é FALSE → o CHECK rejeita NaN e Infinity.
      CHECK (minimo_forcado_manual IS NULL OR (minimo_forcado_manual > 0 AND minimo_forcado_manual < 'Infinity'::numeric));
  END IF;
END $$;

COMMENT ON COLUMN public.sku_parametros.minimo_forcado_manual IS
  'Mínimo de compra forçado por SKU (a "R"). Quando >0, a RPC gerar_pedidos_sugeridos_ciclo eleva qtde_final ao máximo entre a sugestão natural e este valor — só para item que JÁ precisa repor (qtde_natural>0). NULL = sem piso (padrão). CHECK rejeita <=0/NaN/Infinity.';

-- ─── PARTE B — RPC: blindagem de fornecedor (irmã) + piso do mínimo forçado ───
CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(
  p_empresa text DEFAULT 'OBEN'::text,
  p_data_ciclo date DEFAULT CURRENT_DATE
)
RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total_ciclo numeric, bloqueados integer)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pedidos INT := 0;
  v_skus INT := 0;
  v_valor NUMERIC := 0;
  v_bloqueados INT := 0;
BEGIN
  -- [fail-closed 2026-06-04] Se o sinal de classificação está ausente para a empresa
  -- (0 produtos com tipo_produto), RECUSA gerar compras — em vez de tratar todos os NULL
  -- como compráveis e arriscar comprar fabricado. (O incidente de 2026-06-04: sinal zerado
  -- por colisão de sync.) O vigia omie_tipo_produto_oben (Migration 2b) detecta e alerta.
  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL)
        FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa
    AND data_ciclo = p_data_ciclo
    AND status = 'pendente_aprovacao';

  WITH em_transito AS (
    SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
    FROM pedido_compra_item pci
    JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
    WHERE pcs2.empresa = p_empresa
      AND (
        -- fluxo normal (janela de 7 dias)
        (pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido')
         AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days'))
        OR
        -- Fix B: pedido confirmado no portal (fornecedor vai entregar) mas
        -- ainda sem registro no Omie. Conta independente da janela, até o Omie
        -- ser criado (omie_pedido_compra_numero) ou o pedido ser cancelado.
        (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal')
         AND pcs2.portal_protocolo IS NOT NULL
         AND pcs2.omie_pedido_compra_numero IS NULL
         AND pcs2.status NOT IN ('cancelado','expirado_sem_aprovacao'))
      )
    GROUP BY pcs2.empresa, pci.sku_codigo_omie
  ),
  preco_medio AS (
    SELECT slh.empresa::text AS empresa, slh.sku_codigo_omie::text AS sku_codigo_omie,
           AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0)) AS preco_unitario, COUNT(*) AS n
    FROM sku_leadtime_history slh
    WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0
    GROUP BY slh.empresa, slh.sku_codigo_omie
  ),
  skus_necessitando AS (
    SELECT sp.empresa, sp.sku_codigo_omie::text AS sku_codigo_omie, sp.sku_descricao,
      sp.fornecedor_nome, sg.grupo_codigo, sp.ponto_pedido, sp.estoque_maximo,
      COALESCE(sea.estoque_fisico, 0) AS estoque_fisico,
      COALESCE(sea.estoque_pendente_entrada, 0) AS estoque_pendente,
      COALESCE(et.qtde, 0) AS qtde_em_transito_recente,
      (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS estoque_efetivo,
      (sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0))) AS qtde_sugerida,
      -- [MIN-FORCADO 1/3] qtde_final = piso(natural, mínimo forçado). Espelha o helper puro
      -- aplicarMinimoForcado: CASE WHEN min>0 THEN GREATEST(natural, min) ELSE natural END.
      -- Sem piso-0 fantasma (ELSE devolve o natural intocado). A guarda "só item que precisa
      -- repor" é o filtro qtde_sugerida > 0 abaixo (sobre o NATURAL), inalterado.
      CASE WHEN sp.minimo_forcado_manual IS NOT NULL AND sp.minimo_forcado_manual > 0
           THEN GREATEST(
                  (sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0))),
                  sp.minimo_forcado_manual)
           ELSE (sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)))
      END AS qtde_final,
      -- Fix A: preco_medio (histórico de recebimento) → fallback p/ custo médio
      -- contábil do Omie (inventory_position.cmc) → 0 (guard no disparo barra).
      COALESCE(pm.preco_unitario, ip.cmc, 0) AS preco_unitario,
      (pm.n IS NULL) AS primeira_compra,
      fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text
    LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    LEFT JOIN em_transito et ON et.empresa = sp.empresa AND et.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN preco_medio pm ON pm.empresa = sp.empresa AND pm.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN inventory_position ip ON ip.omie_codigo_produto::text = sp.sku_codigo_omie::text AND ip.account = lower(p_empresa)
    LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
    WHERE sp.empresa = p_empresa
      AND sp.habilitado_reposicao_automatica = TRUE
      AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
      -- [sem-fornecedor 2026-06-04] SKU sem fornecedor NÃO gera pedido (ver cabeçalho:
      -- o GROUP BY criava o cabeçalho mas o JOIN NULL=NULL dos itens não casava → fantasma).
      -- Os excluídos aqui aparecem na view v_reposicao_sku_sem_fornecedor (não somem mudos).
      AND sp.fornecedor_nome IS NOT NULL
      AND btrim(sp.fornecedor_nome) <> ''
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND COALESCE(sso.ativo_no_omie, true) = true
      AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
      AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
      -- [04-fabricado] guarda na fonte: Produto Acabado ('04') = fabricado, nunca comprar.
      -- Subquery account-aware lê a COLUNA tipo_produto (ponte: fallback ao metadata legado).
      AND COALESCE((
        SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
        FROM omie_products op04
        WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
          AND op04.account = lower(p_empresa)
        LIMIT 1
      ), '') <> '04'
      AND sp.ponto_pedido IS NOT NULL
      AND sp.estoque_maximo IS NOT NULL
      AND (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) <= sp.ponto_pedido
  ),
  pedidos_por_fornecedor_grupo AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_corte_planejado, valor_total, num_skus, status,
      condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
      (p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz,
      -- [MIN-FORCADO 2/3] valor_total do header usa a quantidade FORÇADA (qtde_final).
      SUM(sn.qtde_final * sn.preco_unitario), COUNT(*),
      'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_necessitando sn
    -- Filtro de necessidade sobre o NATURAL (qtde_sugerida), inalterado: o mínimo forçado
    -- NÃO ativa item sobre-estocado — só eleva a quantidade de quem já ia ser comprado.
    WHERE sn.qtde_sugerida > 0
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao,
    estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra
  )
  -- [MIN-FORCADO 3/3] qtde_sugerida = natural (referência/audit); qtde_final = forçada (dispara
  -- ao Omie); valor_linha pela forçada. Quando minimo_forcado_manual é NULL, qtde_final = natural
  -- = comportamento atual idêntico.
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao,
    sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
    sn.qtde_sugerida, sn.qtde_final, sn.preco_unitario,
    sn.qtde_final * sn.preco_unitario, sn.primeira_compra
  FROM skus_necessitando sn
  JOIN pedidos_por_fornecedor_grupo pfg
    ON pfg.fornecedor_nome = sn.fornecedor_nome
   AND COALESCE(pfg.grupo_codigo,'') = COALESCE(sn.grupo_codigo,'')
  -- [MIN-FORCADO 4/4] Espelha NESTE insert de itens o filtro qtde_sugerida>0 que o header já tem.
  -- Na base, o item era inserido só por JOIN com o header (fornecedor,grupo), SEM filtro próprio →
  -- um item com natural<=0 que compartilha fornecedor/grupo com um válido era inserido. Sem mínimo
  -- isso é só lixo que o guard nQtde>0 do disparo barraria; COM mínimo forçado, o GREATEST elevaria
  -- esse item sobre-estocado a `min` (gatilho indevido). Este WHERE garante PISO, NÃO GATILHO. No
  -- caso normal (estoque_maximo>ponto_pedido) todos têm natural>0 → não exclui nada (idêntico).
  WHERE sn.qtde_sugerida > 0;

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

-- ─── PARTE C — Otimizador "comprar mais?" enxerga o mínimo forçado ───
-- CORPO VERBATIM de 20260530143818 (PARTE 2) + a coluna sp.minimo_forcado_manual.
-- security_invoker=on e os filtros 405ML/450ML preservados.
CREATE OR REPLACE VIEW v_otimizador_compras_insumos
WITH (security_invoker = on) AS
WITH frete AS (
  SELECT
    cac.empresa,
    cac.fornecedor_nome,
    max(cac.valor) FILTER (WHERE cac.tipo = 'frete_perc_valor') AS frete_perc_valor,
    max(cac.valor) FILTER (WHERE cac.tipo = 'frete_fixo')       AS frete_fixo,
    max(cac.valor) FILTER (WHERE cac.tipo = 'taxa_pedido')      AS frete_taxa_pedido
  FROM fornecedor_custo_adicional_config cac
  WHERE cac.ativo = true
  GROUP BY cac.empresa, cac.fornecedor_nome
),
prazo AS (
  SELECT
    ppc.empresa,
    ppc.fornecedor_nome,
    max(ppc.desconto_ou_encargo_perc) AS prazo_padrao_perc
  FROM fornecedor_prazo_pagamento_config ppc
  WHERE ppc.padrao = true AND ppc.ativo = true
  GROUP BY ppc.empresa, ppc.fornecedor_nome
)
SELECT
  o.*,
  sp.lote_minimo_fornecedor,
  sp.fornecedor_codigo_omie,
  p.prazo_padrao_perc,
  f.frete_perc_valor,
  f.frete_fixo,
  f.frete_taxa_pedido,
  -- [Codex P1] minimo_forcado_manual ao FIM do SELECT: CREATE OR REPLACE VIEW só permite ADICIONAR
  -- coluna no fim (não reordenar) — inseri-la no meio faria a migration falhar em prod.
  sp.minimo_forcado_manual
FROM v_oportunidade_economica_hoje o
LEFT JOIN sku_parametros sp
  ON sp.empresa = o.empresa AND sp.sku_codigo_omie = o.sku_codigo_omie
LEFT JOIN prazo p
  ON p.empresa = o.empresa AND p.fornecedor_nome = o.fornecedor_nome
LEFT JOIN frete f
  ON f.empresa = o.empresa AND f.fornecedor_nome = o.fornecedor_nome
LEFT JOIN omie_products op
  ON op.omie_codigo_produto::text = o.sku_codigo_omie::text
 AND op.account = lower(o.empresa)
WHERE COALESCE(op.descricao, '') NOT ILIKE '%405ML'
  AND COALESCE(op.descricao, '') NOT ILIKE '%450ML';

-- ─── Validação (não regenera o ciclo — Checkpoint consciente do founder) ───
SELECT 'MIGRATION minimo_forcado OK' AS status,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='sku_parametros' AND column_name='minimo_forcado_manual') AS coluna,
  (SELECT count(*) FROM pg_constraint WHERE conname='sku_parametros_minimo_forcado_valido') AS check_constraint,
  (SELECT count(*) FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo') AS rpc,
  (SELECT count(*) FROM pg_views WHERE viewname='v_otimizador_compras_insumos') AS view_otimizador;
