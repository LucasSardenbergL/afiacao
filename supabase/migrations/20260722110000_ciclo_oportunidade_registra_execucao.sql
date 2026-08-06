-- Registro de execução do ciclo de oportunidade DENTRO da função SQL (escritor único do slug
-- 'reposicao.gerar_ciclo_oportunidade'): captura o clique manual (RPC autenticada, auth.uid()
-- presente) E o cron afiacao_ciclo_oportunidade_diario das 11:05 (roda como postgres, auth.uid()
-- NULL → origem 'automatica') na MESMA legenda <UltimaExecucao>.
--
-- Base do REPLACE: pg_get_functiondef de PRODUÇÃO em 2026-07-20 (pré-flight da armadilha do
-- CLAUDE.md — o repo pode divergir do prod; a última a recriar vence). Preserva assinatura,
-- LANGUAGE, SECURITY INVOKER e SET search_path EXATOS.
--
-- Desenho do registro: INSERT ÚNICO ao FINAL (não início/fim) — se o ciclo der ROLLBACK, a
-- transação leva o INSERT junto e não sobra linha órfã 'executando'; se commitou, a linha nasce
-- atômica com o ciclo. FAIL-OPEN: falha no registro NUNCA derruba o ciclo (money-path).

-- Helper privado (INVOKER): classifica origem por auth.uid() e insere fail-open.
CREATE OR REPLACE FUNCTION public._registrar_ciclo_oportunidade(p_inicio timestamptz, p_detalhes jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- v_uid atribuído no CORPO, não no DECLARE: erro na inicialização de DECLARE fura o
  -- EXCEPTION do próprio bloco (provado no harness) — e o fail-open tem que ser total.
  v_uid uuid;
  v_nome text := NULL;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NOT NULL THEN
    BEGIN
      SELECT p.name INTO v_nome FROM public.profiles p WHERE p.user_id = v_uid;
    EXCEPTION WHEN OTHERS THEN
      v_nome := NULL;
    END;
  END IF;
  INSERT INTO public.acoes_execucoes
    (acao, origem, executado_por, executado_por_nome, iniciado_em, finalizado_em, status, detalhes)
  VALUES
    ('reposicao.gerar_ciclo_oportunidade',
     CASE WHEN v_uid IS NULL THEN 'automatica' ELSE 'manual' END,
     v_uid, v_nome, p_inicio, clock_timestamp(), 'sucesso', p_detalhes);
EXCEPTION WHEN OTHERS THEN
  -- FAIL-OPEN: registro é observabilidade — nunca derruba o ciclo.
  NULL;
END;
$function$;

-- Helper não é API pública: anon fora; authenticated PRECISA executar (a função principal é
-- INVOKER — o clique manual roda o helper como o caller staff).
REVOKE EXECUTE ON FUNCTION public._registrar_ciclo_oportunidade(timestamptz, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._registrar_ciclo_oportunidade(timestamptz, jsonb) TO authenticated;

-- Função principal: corpo de PRODUÇÃO + v_inicio + os 2 pontos de registro (um por RETURN).
CREATE OR REPLACE FUNCTION public.ciclo_oportunidade_do_dia(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(executou boolean, motivo text, pedidos_gerados integer, skus_incluidos integer, economia_estimada numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_campanhas_hoje int;
  v_aumentos_hoje int;
  v_result record;
  v_motivo text := '';
  v_inicio timestamptz := clock_timestamp();
BEGIN
  -- Quantas campanhas têm corte hoje?
  SELECT COUNT(*) INTO v_campanhas_hoje
  FROM promocao_campanha
  WHERE empresa = p_empresa
    AND estado = 'ativa'
    AND data_corte_pedido = p_data_ciclo
    AND permite_pedido_oportunidade = true;

  -- Quantos aumentos entram em vigência amanhã (corte é véspera)?
  SELECT COUNT(*) INTO v_aumentos_hoje
  FROM fornecedor_aumento_anunciado
  WHERE empresa = p_empresa
    AND estado IN ('ativo', 'vigente')
    AND data_vigencia = p_data_ciclo + INTERVAL '1 day';

  IF v_campanhas_hoje = 0 AND v_aumentos_hoje = 0 THEN
    PERFORM public._registrar_ciclo_oportunidade(v_inicio,
      jsonb_build_object('executou', false, 'motivo', 'sem_eventos_hoje', 'empresa', p_empresa));
    RETURN QUERY SELECT false, 'sem_eventos_hoje'::text, 0, 0, 0::numeric;
    RETURN;
  END IF;

  v_motivo := CASE
    WHEN v_campanhas_hoje > 0 AND v_aumentos_hoje > 0 THEN 'promo_e_aumento'
    WHEN v_campanhas_hoje > 0 THEN 'corte_promocao'
    ELSE 'vespera_aumento'
  END;

  -- Chama a função de geração
  SELECT * INTO v_result
  FROM gerar_pedidos_oportunidade_ciclo(p_empresa, p_data_ciclo)
  LIMIT 1;

  -- Gera alerta informando que ciclo oportunidade rodou
  INSERT INTO fornecedor_alerta (
    empresa, tipo, severidade, titulo, mensagem
  ) VALUES (
    p_empresa, 'oportunidade_calculada', 'atencao',
    'Ciclo oportunidade gerado: ' || v_motivo,
    format('Foram gerados %s pedidos cobrindo %s SKUs com economia bruta estimada de R$ %s. Revisar em /admin/reposicao/pedidos.',
           v_result.pedidos_gerados, v_result.skus_incluidos, v_result.valor_total)
  );

  PERFORM public._registrar_ciclo_oportunidade(v_inicio,
    jsonb_build_object('executou', true, 'motivo', v_motivo, 'empresa', p_empresa,
                       'pedidos_gerados', v_result.pedidos_gerados,
                       'skus_incluidos', v_result.skus_incluidos,
                       'economia_estimada', v_result.valor_total));

  RETURN QUERY SELECT true, v_motivo, v_result.pedidos_gerados, v_result.skus_incluidos, v_result.valor_total;
END;
$function$;
