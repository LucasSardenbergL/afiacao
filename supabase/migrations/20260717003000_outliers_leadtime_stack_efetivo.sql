-- Fase 0-ter — a stack de OUTLIERS de leadtime passa a ler a fonte deduplicada por NFe.
--
-- CONTEXTO: uma NFe que fatura N pedidos gera N cópias do mesmo item em
-- sku_leadtime_history (writer corrigido em #1345; o passivo é resíduo finito que não
-- cresce). Quem agrega sobre as LINHAS infla contagem e deprime desvio. A leitura vem
-- sendo quarentenada view por view via v_sku_leadtime_efetivo (1 linha por
-- (empresa, NFe, SKU)): #1343 cobriu v_sku_leadtime_estatisticas, #1354 cobriu
-- v_sku_sla_compliance + o gráfico do drill. Esta migration cobre a stack de outliers.
--
-- A stack vai JUNTA (detectar → estimar → resolver) porque a identidade da observação
-- muda: era `tracking_id` (a linha crua), passa a ser `dedup_key` (a NFe). Corrigir só o
-- detector deixaria o fluxo de resolução tentando excluir por uma identidade que a fonte
-- não expõe mais.
--
-- ─── O QUE ESTA MIGRATION CORRIGE (4 defeitos, medidos na prod antes do apply) ─────────
--
-- 1) FALSO-POSITIVO no detector (o dano real do dedup; medido: a grande maioria dos SKUs
--    flagrados hoje NÃO sobrevive à deduplicação). A multiplicidade deprime o
--    desvio-padrão, o z infla e a linha cruza o corte de 2σ. Note que o dano é o INVERSO
--    do previsto: a tese do falso-negativo (cópias idênticas ⇒ desvio 0 ⇒ z NULL ⇒ o
--    outlier real nunca é flagrado) tem ZERO instâncias na prod — os SKUs com desvio 0
--    são cópias de UMA observação real e, colapsados, reprovam no gate `>= 3` de
--    qualquer jeito. Não havia outlier escondido; havia ruído sendo emitido.
--
-- 2) BUG LATE-BOUND em estimar_impacto_exclusao_outlier: o ramo lt_atipico filtra por
--    `data_pedido`, coluna que NUNCA existiu (o nome real é `t1_data_pedido`). O CREATE
--    passou; a função sempre estourou 42703 em RUNTIME. É o gêmeo SQL do bug que o #1354
--    corrigiu no lado React (o gráfico do drill fazia .select("data_pedido")). A tela
--    chama essa RPC em todo evento lt_atipico aberto.
--
-- 3) ROUND-TRIP DE EXCLUSÃO QUEBRADO em dois pontos independentes: resolver_outlier
--    grava `tipo_observacao = 'leadtime'` e detectar_outliers_empresa procura por 'lt';
--    e a referência gravada cai no fallback `id::text` do evento (lt_atipico não tem
--    'nfe' nem 'pedido_compra' em `detalhes`), enquanto o detector compara com
--    `tracking_id`. Nunca casava. Inerte até hoje: observacoes_excluidas está vazia.
--
-- 4) INCOERÊNCIA DE `data_evento`: o detector grava a data de RECEBIMENTO (t4), mas o
--    gráfico do drill (#1354) plota o eixo X por t1_data_pedido e destaca o ponto cujo
--    dia é igual a `data_evento` — o destaque nunca casava. E `estimar_impacto` sempre
--    quis excluir por data de PEDIDO (o `data_pedido` do defeito 2). Toda a stack
--    assume t1; só o detector escrevia t4. `data_evento` passa a ser t1.
--
-- ─── REGRA DE COLAPSO: repontar NÃO é trocar o FROM ───────────────────────────────────
-- A view efetiva emite NULL onde as cópias divergem. Decidido campo a campo, MEDINDO:
--   • t1_data_pedido → NUNCA nulo entre os pares com lt conhecido (medido: 0 casos).
--     É o que vira `data_evento`. Guarda `IS NOT NULL` mesmo assim: a medição é um
--     retrato, o resíduo pode mudar, e `eventos_outlier.data_evento` é NOT NULL — um
--     nulo aqui derrubaria o INSERT com 23502 e mataria o detector INTEIRO (a venda
--     atípica junto, no mesmo CTE).
--   • t4_data_recebimento → nulo numa fração material dos pares COM lt conhecido (as
--     cópias divergem no recebimento mas concordam no lt). Era o `data_evento` antigo:
--     trocar só o FROM, mantendo t4, era exatamente a armadilha 23502 acima.
--   • lt_bruto_dias_uteis NULL → o par sai da estatística E não gera evento. Isso não é
--     sumiço silencioso: é a única leitura honesta. Não sabemos o leadtime daquela NFe
--     (as cópias discordam) — uma observação de valor desconhecido não pode compor média
--     nem ser candidata a outlier, e escolher representante fabricaria precisão (chance
--     1/N de acertar). Ausente ≠ zero.
--   • nfe_chave_acesso NULL → identidade cai em `dedup_key` ('tracking:<id>'), que a view
--     garante não-nula. Por isso a identidade é `dedup_key`, não `nfe_chave_acesso`.
--
-- ⚠️ MUDA A FILA: a maioria dos lt_atipico pendentes deixa de se sustentar (ou é artefato
--    da duplicação, ou perdeu a base ao colapsar). Eles são aposentados abaixo como
--    `resolvido_auto`, com trilha — não apagados. Os números que a tela exibia neles
--    (valor_esperado, desvios_padrao) vinham da estatística inflada: eram fabricados.
--
-- ⚠️ NÃO corrige (fora de escopo, medido e registrado): "excluir" um outlier de leadtime
--    segue COSMÉTICO — nem detectar_outliers_empresa (na CTE de estatística) nem
--    v_sku_leadtime_estatisticas subtraem observacoes_excluidas, então a exclusão não
--    alcança o motor de reposição, embora a tela chame
--    atualizar_parametros_numericos_skus depois e o estimar_impacto prometa "σ sem
--    outlier". Fazer a exclusão de fato alimentar o motor é feature de money-path, não
--    conserto — PR próprio.
--
-- Prova: db/test-outliers-leadtime-stack-efetivo.sh (PG17, asserts + falsificação).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) O detector: o ramo de LEADTIME passa a ler a fonte deduplicada
-- ─────────────────────────────────────────────────────────────────────────────
-- O ramo TIPO 1 (vendas atípicas) é byte-a-byte o da prod (conferido via
-- pg_get_functiondef antes do REPLACE): venda_items_history não tem o defeito de
-- duplicação e não é assunto desta migration.
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
  -- TIPO 1: VENDAS ATÍPICAS
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
      desvios_padrao, detalhes
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
      )
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
        -- `tracking_id` sai de propósito: a identidade não é mais a linha crua. Quem
        -- migrar dado velho, leia o backfill na seção 4.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) O estimador de impacto: mata o 42703 e passa a excluir a observação certa
-- ─────────────────────────────────────────────────────────────────────────────
-- O ramo venda_atipica é byte-a-byte o da prod. Só o ramo lt_atipico muda.
CREATE OR REPLACE FUNCTION public.estimar_impacto_exclusao_outlier(p_evento_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_evento RECORD;
  v_sigma_atual numeric;
  v_media_atual numeric;
  v_sigma_sem numeric;
  v_media_sem numeric;
  v_d numeric;
  v_lt numeric;
  v_z numeric := 1.65;
  v_em_atual numeric;
  v_em_sem numeric;
  v_dedup_key text;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Evento não encontrado');
  END IF;

  IF v_evento.tipo = 'venda_atipica' THEN
    SELECT AVG(quantidade), STDDEV_SAMP(quantidade) INTO v_media_atual, v_sigma_atual
    FROM venda_items_history
    WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND data_emissao >= CURRENT_DATE - INTERVAL '180 days' AND quantidade > 0;
    SELECT AVG(quantidade), STDDEV_SAMP(quantidade) INTO v_media_sem, v_sigma_sem
    FROM venda_items_history
    WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND data_emissao >= CURRENT_DATE - INTERVAL '180 days' AND quantidade > 0
      AND NOT (data_emissao::date = v_evento.data_evento AND nfe_chave_acesso::text = COALESCE(v_evento.detalhes->>'nfe', ''));
    SELECT demanda_media_diaria, lt_medio_dias_uteis INTO v_d, v_lt
    FROM sku_parametros WHERE empresa = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie LIMIT 1;
    v_d := COALESCE(v_d, v_media_atual);
    v_lt := COALESCE(v_lt, 10);
    v_em_atual := CEIL(v_z * COALESCE(v_sigma_atual, 0) * SQRT(v_lt));
    v_em_sem := CEIL(v_z * COALESCE(v_sigma_sem, 0) * SQRT(v_lt));
    RETURN jsonb_build_object(
      'tipo', 'venda_atipica',
      'sigma_atual', ROUND(COALESCE(v_sigma_atual, 0), 2),
      'sigma_sem', ROUND(COALESCE(v_sigma_sem, 0), 2),
      'media_atual', ROUND(COALESCE(v_media_atual, 0), 2),
      'media_sem', ROUND(COALESCE(v_media_sem, 0), 2),
      'em_atual', v_em_atual, 'em_sem', v_em_sem,
      'delta_em', v_em_sem - v_em_atual, 'd', v_d, 'lt', v_lt
    );
  ELSE
    -- A identidade da observação é o dedup_key. Evento antigo sem dedup_key (não
    -- alcançado pelo backfill da seção 4) não é estimável: devolver 0 de impacto seria
    -- fabricar "excluir não muda nada". A tela já degrada em `error` (ImpactoData.error).
    v_dedup_key := v_evento.detalhes->>'dedup_key';
    IF v_dedup_key IS NULL THEN
      RETURN jsonb_build_object(
        'tipo', 'lt_atipico',
        'error', 'Evento sem identidade de observação (dedup_key) — impacto não estimável'
      );
    END IF;

    -- Fonte efetiva: 1 observação por NFe. Antes lia sku_leadtime_history cru — média e
    -- sigma saíam ponderados pela multiplicidade da NFe.
    SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis) INTO v_media_atual, v_sigma_atual
    FROM v_sku_leadtime_efetivo
    WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND lt_bruto_dias_uteis IS NOT NULL;

    -- Era `NOT (data_pedido::date = v_evento.data_evento)`: `data_pedido` NUNCA existiu
    -- nesta tabela (é `t1_data_pedido`) ⇒ 42703 em runtime, sempre. E mesmo com o nome
    -- certo, excluir por DATA removeria toda observação que compartilhasse o dia; a
    -- identidade certa é a NFe.
    SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis) INTO v_media_sem, v_sigma_sem
    FROM v_sku_leadtime_efetivo
    WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND lt_bruto_dias_uteis IS NOT NULL
      AND dedup_key <> v_dedup_key;

    RETURN jsonb_build_object(
      'tipo', 'lt_atipico',
      'sigma_atual', ROUND(COALESCE(v_sigma_atual, 0), 2),
      'sigma_sem', ROUND(COALESCE(v_sigma_sem, 0), 2),
      'media_atual', ROUND(COALESCE(v_media_atual, 0), 2),
      'media_sem', ROUND(COALESCE(v_media_sem, 0), 2)
    );
  END IF;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) O resolvedor: grava a referência que o detector realmente procura
-- ─────────────────────────────────────────────────────────────────────────────
-- Única mudança: `referencia_original` para lt_atipico. O resto (gate, validação de
-- decisão, UPDATE do status, tipo_observacao, ON CONFLICT) é byte-a-byte o da prod —
-- inclusive o `ELSE 'leadtime'` do tipo_observacao, que já era o que o lt gravava.
CREATE OR REPLACE FUNCTION public.resolver_outlier(p_evento_id bigint, p_decisao text, p_justificativa text DEFAULT NULL::text, p_usuario_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_evento RECORD;
  v_novo_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_decisao NOT IN ('aceitar', 'excluir', 'ignorar') THEN
    RAISE EXCEPTION 'Decisão inválida: %. Use aceitar/excluir/ignorar', p_decisao;
  END IF;
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento outlier % não encontrado', p_evento_id;
  END IF;
  IF v_evento.status != 'pendente' THEN
    RAISE EXCEPTION 'Evento já resolvido com status: %', v_evento.status;
  END IF;
  v_novo_status := CASE p_decisao
    WHEN 'aceitar' THEN 'aceito'
    WHEN 'excluir' THEN 'excluido'
    WHEN 'ignorar' THEN 'ignorado'
  END;
  UPDATE eventos_outlier
  SET status = v_novo_status, decidido_em = now(),
      decidido_por = p_usuario_email, justificativa_decisao = p_justificativa
  WHERE id = p_evento_id;
  IF p_decisao = 'excluir' THEN
    INSERT INTO observacoes_excluidas (
      empresa, sku_codigo_omie, tipo_observacao, data_observacao,
      referencia_original, valor_excluido, excluido_por,
      evento_outlier_id, justificativa
    ) VALUES (
      v_evento.empresa, v_evento.sku_codigo_omie,
      CASE WHEN v_evento.tipo = 'venda_atipica' THEN 'venda' ELSE 'leadtime' END,
      v_evento.data_evento,
      -- `dedup_key` entra na FRENTE do COALESCE: é a identidade da observação de
      -- leadtime. Antes o COALESCE caía em `id::text` (o lt_atipico não tinha 'nfe' nem
      -- 'pedido_compra' em detalhes) e o detector comparava com tracking_id — nunca
      -- casava. Os outros tipos não têm 'dedup_key' e seguem exatamente como antes.
      -- ⚠️ Onde a NFe existe, 'nfe' == 'dedup_key' e o COALESCE antigo acertaria por
      -- coincidência; esta linha é o que mantém correto o caminho SEM NFe, em que
      -- dedup_key vira 'tracking:<id>' (hoje sem casos na prod — guarda de futuro, igual
      -- ao COALESCE da própria v_sku_leadtime_efetivo).
      COALESCE(v_evento.detalhes->>'dedup_key', v_evento.detalhes->>'nfe',
               v_evento.detalhes->>'pedido_compra', v_evento.id::text),
      v_evento.valor_observado, p_usuario_email, v_evento.id, p_justificativa
    )
    ON CONFLICT (empresa, sku_codigo_omie, tipo_observacao, data_observacao, referencia_original)
    DO UPDATE SET
      valor_excluido = EXCLUDED.valor_excluido,
      excluido_por = EXCLUDED.excluido_por,
      justificativa = EXCLUDED.justificativa,
      excluido_em = now();
  END IF;
  RETURN jsonb_build_object('evento_id', p_evento_id, 'novo_status', v_novo_status, 'decisao', p_decisao);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Backfill: os eventos existentes ganham a identidade nova
-- ─────────────────────────────────────────────────────────────────────────────
-- Sem isto o detector não reconheceria os eventos antigos (eles só têm `tracking_id`) e
-- emitiria um evento DUPLICADO para a mesma observação. `observacoes_excluidas` está
-- vazia na prod, então não há referência velha a migrar — só os eventos.
UPDATE public.eventos_outlier eo
SET detalhes = eo.detalhes || jsonb_strip_nulls(jsonb_build_object(
      'dedup_key', COALESCE(
        (SELECT pot.nfe_chave_acesso FROM public.purchase_orders_tracking pot
          WHERE pot.id::text = eo.detalhes->>'tracking_id'),
        'tracking:' || (eo.detalhes->>'tracking_id')),
      'nfe', (SELECT pot.nfe_chave_acesso FROM public.purchase_orders_tracking pot
               WHERE pot.id::text = eo.detalhes->>'tracking_id')
    ))
WHERE eo.tipo = 'lt_atipico'
  AND eo.detalhes ? 'tracking_id'
  AND NOT (eo.detalhes ? 'dedup_key');

-- `data_evento` dos eventos de leadtime passa a ser t1 (era t4). Alinha com o eixo X do
-- gráfico do drill (#1354), que destaca o ponto cujo dia é igual a `data_evento` — com
-- t4 o destaque nunca acendia. Vale para todo lt_atipico, inclusive já resolvido: a data
-- é descrição da observação, não registro da decisão (essa fica em decidido_em).
UPDATE public.eventos_outlier eo
SET data_evento = ef.t1_data_pedido::date
FROM public.v_sku_leadtime_efetivo ef
WHERE eo.tipo = 'lt_atipico'
  AND ef.empresa::text = eo.empresa
  AND ef.sku_codigo_omie::text = eo.sku_codigo_omie
  AND ef.dedup_key = eo.detalhes->>'dedup_key'
  AND ef.t1_data_pedido IS NOT NULL
  AND eo.data_evento IS DISTINCT FROM ef.t1_data_pedido::date;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Aposenta os pendentes que a fonte corrigida não sustenta
-- ─────────────────────────────────────────────────────────────────────────────
-- Decisão do founder (2026-07-16): aposentar com trilha em vez de deixar a fila exibindo
-- média e z fabricados. Status `resolvido_auto` (vocabulário que a tela já usa para
-- sku_inativado_omie); nada é apagado e a justificativa diz QUAL dos dois motivos.
-- Só mexe em `pendente`: decisão humana já registrada (aceito/excluido/ignorado) fica.
WITH est_ef AS (
  SELECT empresa::text AS empresa, sku_codigo_omie::text AS sku,
         AVG(lt_bruto_dias_uteis) AS m, STDDEV_SAMP(lt_bruto_dias_uteis) AS sd
  FROM public.v_sku_leadtime_efetivo
  WHERE lt_bruto_dias_uteis IS NOT NULL
  GROUP BY 1, 2
  HAVING COUNT(*) >= 3
),
avaliacao AS (
  SELECT eo.id,
         ef.lt_bruto_dias_uteis AS lt_ef,
         e.m AS m, e.sd AS sd
  FROM public.eventos_outlier eo
  LEFT JOIN public.v_sku_leadtime_efetivo ef
         ON ef.empresa::text = eo.empresa
        AND ef.sku_codigo_omie::text = eo.sku_codigo_omie
        AND ef.dedup_key = eo.detalhes->>'dedup_key'
  LEFT JOIN est_ef e
         ON e.empresa = eo.empresa
        AND e.sku = eo.sku_codigo_omie
  WHERE eo.tipo = 'lt_atipico' AND eo.status = 'pendente'
)
UPDATE public.eventos_outlier eo
SET status = 'resolvido_auto',
    decidido_em = now(),
    decidido_por = 'sistema (dedup NFe)',
    justificativa_decisao = CASE
      WHEN a.lt_ef IS NULL OR a.sd IS NULL OR a.sd = 0
        THEN 'Aposentado na correção da fonte de leadtime (dedup por NFe): sem base para avaliar — o leadtime desta NFe é indeterminado (as cópias divergem) ou o SKU não reúne 3 recebimentos independentes. O alerta original foi calculado sobre estatística inflada pela duplicação e não se sustenta.'
      ELSE 'Aposentado na correção da fonte de leadtime (dedup por NFe): reavaliado sobre 1 observação por NFe, o desvio não atinge o corte de 2 sigma. O alerta original foi calculado sobre estatística inflada pela duplicação.'
    END
FROM avaliacao a
WHERE eo.id = a.id
  -- Preserva o que a fonte corrigida AINDA flagra.
  AND NOT (a.sd IS NOT NULL AND a.sd > 0 AND a.lt_ef IS NOT NULL
           AND (a.lt_ef - a.m) / a.sd > 2);

COMMENT ON FUNCTION public.detectar_outliers_empresa(text) IS
  'Detecta vendas atípicas e leadtimes atípicos. O ramo de leadtime lê '
  'v_sku_leadtime_efetivo (1 observação por NFe): sobre a tabela crua, uma NFe que '
  'fatura N pedidos pesa N vezes, o que infla o gate >= 3 e deprime o desvio-padrão. '
  'Identidade da observação de leadtime = detalhes->>''dedup_key'' (não tracking_id).';
