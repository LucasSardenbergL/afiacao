-- Radar: religa a publicação da carga mensal depois da migration 20261111120000 (publicação em passos curtos).
-- Para o `bun run db:aplicar` (sem envelope: a transação é do executor). Idempotente e fail-closed.
--
-- 1. TRAVA: a migration nova está no ar (procedure INVOKER, cron com `CALL` único) — sem ela, religar repetiria
--    o incidente de 2026-11-08 (UPSERT de 503.929 linhas numa transação, Realtime travado).
-- 2. Re-valida o lote 2026-10 que a contenção marcou `falhou`: o staging dele segue inteiro (503.929 linhas,
--    = carga_esperado) e medido em prod com 0 linhas de cadastro diferente e a MESMA membresia da foto vigente
--    (re-run). A publicação em passos vai examiná-lo, não reescrever nada, virar e esvaziar o staging — a 1ª
--    publicação real do desenho novo, sem mudar dado do leitor. Só re-valida se ainda estiver como a contenção
--    deixou (falhou + staging = esperado); senão não toca.
-- 3. Religa o job radar-publicar-lote (jobid lido pelo nome).
DO $trava$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.radar_carga_publicar(interval)')
                    AND prokind = 'p' AND NOT prosecdef AND proconfig IS NULL) THEN
    RAISE EXCEPTION 'TRAVA: public.radar_carga_publicar(interval) ausente — aplique a migration 20261111120000 antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-publicar-lote'
                    AND command = 'CALL public.radar_carga_publicar()') THEN
    RAISE EXCEPTION 'TRAVA: cron radar-publicar-lote sem o comando CALL único';
  END IF;
  IF EXISTS (SELECT 1 FROM public.radar_ingest_state WHERE carga_fase = 'validada') THEN
    RAISE EXCEPTION 'TRAVA: já há lote validado/em publicação — nada a re-validar';
  END IF;
END
$trava$;

UPDATE public.radar_ingest_state s
   SET carga_fase = 'validada', carga_erro = NULL, carga_validada_em = now(),
       carga_publicacao_iniciada_em = NULL, carga_cursor = NULL, carga_examinadas = NULL, carga_gravadas = NULL,
       carga_tentativas = NULL, carga_varrida_em = NULL, carga_recruzada_em = NULL
 WHERE s.mes_referencia = '2026-10'
   AND s.carga_fase = 'falhou'
   AND s.status = 'complete'
   AND s.carga_esperado = 503929
   AND (SELECT count(*) FROM public.radar_empresas_carga c WHERE c.lote = '2026-10') = s.carga_esperado;

SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'radar-publicar-lote'), active := true);

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.radar_ingest_state
                  WHERE mes_referencia = '2026-10' AND status = 'complete' AND carga_fase = 'validada'
                    AND carga_publicacao_iniciada_em IS NULL) THEN
    RAISE EXCEPTION 'POST: 2026-10 não ficou validado (staging mudou ou estado diferente do da contenção)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-publicar-lote' AND active
                    AND command = 'CALL public.radar_carga_publicar()' AND schedule = '*/15 0-5,7-23 * * *') THEN
    RAISE EXCEPTION 'POST: cron radar-publicar-lote não ficou ativo com o CALL';
  END IF;
  IF public.radar_lote_publicando() IS NOT NULL THEN
    RAISE EXCEPTION 'POST: re-run do vigente não pode ter P (radar_lote_publicando deveria ser NULL)';
  END IF;
  RAISE NOTICE 'radar publicação religada: 2026-10 validado (re-run), cron ativo';
END
$post$;
