-- Asserts da RPC enfileirar_erro_app. Requer a migration 20260604170000 aplicada.
DO $$
DECLARE r jsonb; n_alertas int; n_log int;
BEGIN
  -- limpa estado de teste
  delete from public.fornecedor_alerta where tipo='erro_app';
  delete from public.posthog_error_webhook_log;

  -- 1. enfileira individual
  r := public.enfileirar_erro_app('p:i1:created','i1','created','{}','Erro no app: A','msg A','{"erro":"A"}'::jsonb,'rollup:1','http://x',10);
  ASSERT r->>'status' = 'enfileirado', 'primeiro insert = enfileirado';
  SELECT count(*) INTO n_alertas FROM public.fornecedor_alerta WHERE tipo='erro_app';
  ASSERT n_alertas = 1, 'criou 1 alerta';

  -- 2. dedupe: MESMA chave não duplica
  r := public.enfileirar_erro_app('p:i1:created','i1','created','{}','x','x','{}'::jsonb,'rollup:1','http://x',10);
  ASSERT r->>'status' = 'deduped', 'mesma dedupe_key = deduped';
  SELECT count(*) INTO n_alertas FROM public.fornecedor_alerta WHERE tipo='erro_app';
  ASSERT n_alertas = 1, 'dedupe NÃO criou 2º alerta';

  -- 3. circuit breaker: com cap=2, o 3º vira rollup
  delete from public.fornecedor_alerta where tipo='erro_app';
  delete from public.posthog_error_webhook_log;
  PERFORM public.enfileirar_erro_app('p:a:created','a','created','{}','A','A','{}'::jsonb,'rollup:9','u',2);
  PERFORM public.enfileirar_erro_app('p:b:created','b','created','{}','B','B','{}'::jsonb,'rollup:9','u',2);
  r := public.enfileirar_erro_app('p:c:created','c','created','{}','C','C','{}'::jsonb,'rollup:9','u',2);
  ASSERT r->>'status' = 'rollup', '3º acima do cap=2 → rollup';
  SELECT count(*) INTO n_alertas FROM public.fornecedor_alerta WHERE tipo='erro_app' AND metadata->>'kind'='rollup';
  ASSERT n_alertas = 1, 'criou 1 rollup';

  -- 4. rollup suprimido: 4º na mesma janela não cria 2º rollup
  r := public.enfileirar_erro_app('p:d:created','d','created','{}','D','D','{}'::jsonb,'rollup:9','u',2);
  ASSERT r->>'status' = 'rollup_suprimido', '4º na mesma janela = rollup_suprimido';
  SELECT count(*) INTO n_alertas FROM public.fornecedor_alerta WHERE tipo='erro_app' AND metadata->>'kind'='rollup';
  ASSERT n_alertas = 1, 'continua 1 rollup só';

  -- 5. log preenchido
  SELECT count(*) INTO n_log FROM public.posthog_error_webhook_log;
  ASSERT n_log >= 4, 'log tem as chaves processadas';

  RAISE NOTICE 'OK: enfileirar_erro_app (dedupe + circuit breaker + rollup)';
END $$;

-- 6. CHECK aceita erro_app, rejeita tipo inválido
DO $$
BEGIN
  BEGIN
    INSERT INTO public.fornecedor_alerta(tipo,empresa,severidade,status,titulo)
      VALUES ('tipo_que_nao_existe','oben','info','pendente_notificacao','x');
    ASSERT false, 'CHECK deveria rejeitar tipo inválido';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'OK: CHECK rejeita tipo inválido e aceita erro_app';
END $$;
