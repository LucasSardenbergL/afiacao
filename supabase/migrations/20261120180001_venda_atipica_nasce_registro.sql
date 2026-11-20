-- ============================================================================================
-- Venda atípica nasce REGISTRO, não fila (eventos_outlier.status = 'registrado').
--
-- PROBLEMA (prod, 2026-11-20): 142 dos 236 eventos 'pendente' são venda_atipica e ficam assim
-- para sempre. Ninguém os trata, porque não há o que decidir: o "crítico" mede só o tamanho do
-- pedido (z > 5 contra 180 dias), aceitar não move o motor (spec 2026-07-16) e a tela já classifica
-- venda atípica como REGISTRO (src/components/reposicao/alertas/types.ts). O pendente eterno infla
-- o badge de alertas do AppShell (useAlertasCriticos conta pendente crítico/atenção de QUALQUER tipo).
--
-- DECISÃO — (a) nascer em status de registro, e não (b) arquivar por idade num cron:
--   * (b) mantém N dias de "pendente" que nunca pediu decisão (o N seria arbitrário) e acrescenta
--     um cron com timeout/monitoramento próprios. Corrige o sintoma, não a classificação.
--   * (a) grava o que o evento É desde o nascimento: um fato registrado. Um writer só
--     (detectar_outliers_empresa), sem máquina nova.
--
-- STATUS NOVO 'registrado' (a coluna é text sem CHECK — conferido na prod, só a PK existe):
--   * Não é 'aceito' (decisão humana, conta em "Decididos hoje") nem 'resolvido_auto' (o robô
--     viu a condição sumir — ex.: SKU inativado voltou a ficar ativo). Ninguém resolveu nada aqui.
--   * decidido_em / decidido_por / justificativa_decisao ficam NULL: não se fabrica decisão.
--   * resolver_outlier não é chamado (ele recusa evento não-pendente, e usá-lo fingiria um humano).
--   * A deduplicação por NF (NOT EXISTS sobre eventos_outlier) ignora status: 'registrado' segue
--     impedindo o reflag da mesma NF.
--
-- ESCOPO: só o ramo venda_atipica. O ramo lt_atipico fica byte-a-byte o da prod; sku_sem_grupo
-- (detectar_skus_sem_grupo) e os tipos do Omie (edges) não são tocados.
--
-- Molde TRAVA → PRE → CREATE → backfill → PÓS (lovable-db-operator, "Recriar objeto VIVO").
-- Sem BEGIN/COMMIT: a transação é do executor (bun run db:aplicar). Pelo SQL Editor, envolva.
-- Prova PG17: db/test-venda-atipica-nasce-registro.sh.
-- ============================================================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade viva é VOLATILE — psql-ro 2026-11-20).
DO $trava$
BEGIN
  IF to_regprocedure('public.detectar_outliers_empresa(text)') IS NOT NULL THEN
    ALTER FUNCTION public.detectar_outliers_empresa(text) VOLATILE;
  END IF;
END
$trava$;

-- PRE: md5 do prosrc vivo ∈ {predecessor (prod 2026-11-20), este}. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.detectar_outliers_empresa(text)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('0e1a15546f5212bf873fdaaba7eaabb6', 'd51d3c9824616fc950ec45bbdc687185') THEN
    RAISE EXCEPTION 'PRE FALHOU: detectar_outliers_empresa vivo (md5 %) não é o predecessor revisado nem este', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.detectar_outliers_empresa(p_empresa text DEFAULT 'OBEN'::text)
 RETURNS TABLE(tipo text, novos_eventos integer, eventos_criticos integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_venda_novos INT := 0;
  v_venda_criticos INT := 0;
  v_lt_novos INT := 0;
  v_lt_criticos INT := 0;
BEGIN
  -- TIPO 1: VENDAS ATÍPICAS — nasce como REGISTRO ('registrado'), não como fila ('pendente').
  -- Pico de quantidade num pedido não pede decisão: aceitar não move o motor (spec 2026-07-16).
  -- decidido_em/por ficam NULL: ninguém decidiu, e o status não finge que alguém decidiu.
  WITH estatisticas AS (
    SELECT
      empresa::text as empresa,
      sku_codigo_omie::text as sku_codigo_omie,
      AVG(quantidade) as media_qtde_por_venda,
      STDDEV_SAMP(quantidade) as desvio_qtde_por_venda
    FROM venda_items_history
    WHERE data_emissao >= CURRENT_DATE - INTERVAL '180 days' AND quantidade > 0
    GROUP BY empresa::text, sku_codigo_omie::text
    HAVING COUNT(*) >= 5
  ),
  vendas_anomalas AS (
    SELECT
      v.empresa::text as empresa,
      v.sku_codigo_omie::text as sku_codigo_omie,
      v.data_emissao::date as data_evento,
      v.nfe_chave_acesso::text as nfe_chave_acesso,
      v.quantidade,
      e.media_qtde_por_venda, e.desvio_qtde_por_venda,
      (v.quantidade - e.media_qtde_por_venda) / NULLIF(e.desvio_qtde_por_venda, 0) as z
    FROM venda_items_history v
    JOIN estatisticas e
      ON e.empresa = v.empresa::text
      AND e.sku_codigo_omie = v.sku_codigo_omie::text
    WHERE v.empresa::text = p_empresa
      AND v.data_emissao >= CURRENT_DATE - INTERVAL '180 days'
      AND v.quantidade > 0
      AND e.desvio_qtde_por_venda > 0
      AND (v.quantidade - e.media_qtde_por_venda) / e.desvio_qtde_por_venda > 3
  ),
  para_inserir AS (
    SELECT va.*
    FROM vendas_anomalas va
    WHERE NOT EXISTS (
      SELECT 1 FROM eventos_outlier eo
      WHERE eo.empresa = va.empresa
        AND eo.sku_codigo_omie = va.sku_codigo_omie
        AND eo.data_evento = va.data_evento
        AND eo.tipo = 'venda_atipica'
        AND eo.detalhes->>'nfe' = va.nfe_chave_acesso
    )
    AND NOT EXISTS (
      SELECT 1 FROM observacoes_excluidas oe
      WHERE oe.empresa = va.empresa
        AND oe.sku_codigo_omie = va.sku_codigo_omie
        AND oe.tipo_observacao = 'venda'
        AND oe.referencia_original = va.nfe_chave_acesso
    )
  ),
  inseridos AS (
    INSERT INTO eventos_outlier (
      empresa, sku_codigo_omie, sku_descricao,
      tipo, severidade, data_evento, valor_observado, valor_esperado,
      desvios_padrao, detalhes, status
    )
    SELECT
      pi.empresa, pi.sku_codigo_omie,
      (SELECT MAX(sku_descricao) FROM venda_items_history
       WHERE sku_codigo_omie::text = pi.sku_codigo_omie),
      'venda_atipica',
      CASE WHEN pi.z > 5 THEN 'critico' WHEN pi.z > 4 THEN 'atencao' ELSE 'info' END,
      pi.data_evento, pi.quantidade,
      ROUND(pi.media_qtde_por_venda, 2), ROUND(pi.z, 2),
      jsonb_build_object(
        'nfe', pi.nfe_chave_acesso,
        'desvio_qtde', pi.desvio_qtde_por_venda,
        'mensagem', 'Venda de ' || pi.quantidade || ' unidades em 1 pedido. Média histórica por pedido: '
                    || ROUND(pi.media_qtde_por_venda, 1) || ' (± ' || ROUND(pi.desvio_qtde_por_venda, 1) || ')'
      ),
      'registrado'
    FROM para_inserir pi
    RETURNING severidade
  )
  SELECT COUNT(*), COUNT(*) FILTER (WHERE severidade = 'critico')
  INTO v_venda_novos, v_venda_criticos
  FROM inseridos;

  -- TIPO 2: LT ATÍPICOS — fonte = v_sku_leadtime_efetivo (1 observação por NFe).
  WITH estatisticas_lt AS (
    SELECT
      empresa::text as empresa,
      sku_codigo_omie::text as sku_codigo_omie,
      AVG(lt_bruto_dias_uteis) as lt_medio,
      STDDEV_SAMP(lt_bruto_dias_uteis) as lt_desvio
    FROM v_sku_leadtime_efetivo
    WHERE lt_bruto_dias_uteis IS NOT NULL
    GROUP BY empresa::text, sku_codigo_omie::text
    -- Agora o gate conta NFes distintas, não cópias da mesma NFe: >= 3 volta a significar
    -- "3 recebimentos independentes". Era aqui que a confiança era fabricada.
    HAVING COUNT(*) >= 3
  ),
  lts_anomalos AS (
    SELECT
      h.empresa::text as empresa,
      h.sku_codigo_omie::text as sku_codigo_omie,
      h.dedup_key as dedup_key,            -- identidade da observação (a NFe), não a linha
      h.nfe_chave_acesso as nfe_chave_acesso,
      h.t1_data_pedido::date as data_evento,
      h.lt_bruto_dias_uteis,
      e.lt_medio, e.lt_desvio,
      (h.lt_bruto_dias_uteis - e.lt_medio) / NULLIF(e.lt_desvio, 0) as z
    FROM v_sku_leadtime_efetivo h
    JOIN estatisticas_lt e
      ON e.empresa = h.empresa::text
      AND e.sku_codigo_omie = h.sku_codigo_omie::text
    WHERE h.empresa::text = p_empresa
      AND h.lt_bruto_dias_uteis IS NOT NULL
      -- eventos_outlier.data_evento é NOT NULL: sem t1 não há como datar a observação, e
      -- inventar data seria fabricar. A observação segue contando na estatística acima
      -- (o lt dela é conhecido); ela só não vira evento.
      AND h.t1_data_pedido IS NOT NULL
      AND e.lt_desvio > 0
      AND (h.lt_bruto_dias_uteis - e.lt_medio) / e.lt_desvio > 2
  ),
  para_inserir_lt AS (
    SELECT la.*
    FROM lts_anomalos la
    WHERE NOT EXISTS (
      SELECT 1 FROM eventos_outlier eo
      WHERE eo.empresa = la.empresa
        AND eo.sku_codigo_omie = la.sku_codigo_omie
        AND eo.tipo = 'lt_atipico'
        AND eo.detalhes->>'dedup_key' = la.dedup_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM observacoes_excluidas oe
      WHERE oe.empresa = la.empresa
        AND oe.sku_codigo_omie = la.sku_codigo_omie
        -- 'leadtime' é o que resolver_outlier grava. Antes procurava por 'lt' e nunca
        -- casava — a exclusão de um outlier de leadtime não impedia o reflag.
        AND oe.tipo_observacao = 'leadtime'
        AND oe.referencia_original = la.dedup_key
    )
  ),
  inseridos_lt AS (
    INSERT INTO eventos_outlier (
      empresa, sku_codigo_omie, sku_descricao,
      tipo, severidade, data_evento, valor_observado, valor_esperado,
      desvios_padrao, detalhes
    )
    SELECT
      pi.empresa, pi.sku_codigo_omie,
      (SELECT MAX(sku_descricao) FROM venda_items_history
       WHERE sku_codigo_omie::text = pi.sku_codigo_omie),
      'lt_atipico',
      CASE WHEN pi.z > 4 THEN 'critico' WHEN pi.z > 3 THEN 'atencao' ELSE 'info' END,
      pi.data_evento, pi.lt_bruto_dias_uteis,
      ROUND(pi.lt_medio, 1), ROUND(pi.z, 2),
      jsonb_build_object(
        'dedup_key', pi.dedup_key,
        'nfe', pi.nfe_chave_acesso,
        'lt_desvio', pi.lt_desvio,
        'mensagem', 'Pedido chegou em ' || pi.lt_bruto_dias_uteis || ' dias úteis. '
                    || 'Média histórica: ' || ROUND(pi.lt_medio, 1) || ' (± ' || ROUND(pi.lt_desvio, 1) || ')'
      )
    FROM para_inserir_lt pi
    RETURNING severidade
  )
  SELECT COUNT(*), COUNT(*) FILTER (WHERE severidade = 'critico')
  INTO v_lt_novos, v_lt_criticos
  FROM inseridos_lt;

  RETURN QUERY
  SELECT 'venda_atipica'::text, v_venda_novos, v_venda_criticos
  UNION ALL
  SELECT 'lt_atipico'::text, v_lt_novos, v_lt_criticos;
END;
$function$;

COMMENT ON FUNCTION public.detectar_outliers_empresa(text) IS
  'Detecta vendas atípicas e leadtimes atípicos. Venda atípica nasce status=''registrado'' '
  '(registro informativo: não pede decisão nem move o motor); lt_atipico nasce ''pendente''. '
  'O ramo de leadtime lê v_sku_leadtime_efetivo (1 observação por NFe): sobre a tabela crua, uma '
  'NFe que fatura N pedidos pesa N vezes, o que infla o gate >= 3 e deprime o desvio-padrão. '
  'Identidade da observação de leadtime = detalhes->>''dedup_key'' (não tracking_id).';

-- Backfill: o estoque pendente de venda atípica vira registro. Só status muda — as colunas de
-- decisão continuam NULL (ninguém decidiu). Idempotente: na 2ª rodada não há pendente para mexer.
UPDATE public.eventos_outlier
   SET status = 'registrado'
 WHERE tipo = 'venda_atipica'
   AND status = 'pendente';

-- PÓS
DO $pos$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.detectar_outliers_empresa(text)')) IS DISTINCT FROM 'd51d3c9824616fc950ec45bbdc687185' THEN
    RAISE EXCEPTION 'POS FALHOU: detectar_outliers_empresa não é o corpo desta migration';
  END IF;
  IF EXISTS (SELECT 1 FROM public.eventos_outlier WHERE tipo = 'venda_atipica' AND status = 'pendente') THEN
    RAISE EXCEPTION 'POS FALHOU: ainda há venda_atipica pendente';
  END IF;
  IF EXISTS (SELECT 1 FROM public.eventos_outlier WHERE status = 'registrado' AND tipo <> 'venda_atipica') THEN
    RAISE EXCEPTION 'POS FALHOU: status registrado vazou para outro tipo';
  END IF;
  IF EXISTS (SELECT 1 FROM public.eventos_outlier
              WHERE status = 'registrado'
                AND (decidido_em IS NOT NULL OR decidido_por IS NOT NULL OR justificativa_decisao IS NOT NULL)) THEN
    RAISE EXCEPTION 'POS FALHOU: registrado com decisão preenchida — fabricaria decisão humana';
  END IF;
  RAISE NOTICE 'POS OK: venda_atipica nasce registrado; 0 pendente';
END
$pos$;
