-- ============================================================
-- Radar de Clientes — recruzamento DIÁRIO de `ja_cliente` (bloco 1 do brainstorm do radar, 2026-10-18).
--
-- Até aqui `radar_recruzar_ja_cliente()` só rodava no `finalize` de um lote mensal — e só houve UM lote
-- (2026-05, carga manual). Cliente cadastrado no Omie FORA do radar (cadastro direto no ERP, import de
-- planilha) ficava `ja_cliente=false` por meses → lead duplicado na fila de prospecção.
--
-- Entrega:
--   • `radar_recruzar_ja_cliente_tick()` — entrypoint de JOB: chama a função original (não a toca: o
--     `finalize` da edge `radar-ingest` continua chamando-a direto) e grava UMA linha em
--     `acoes_execucoes` (slug `radar.recruzar_ja_cliente`, origem `automatica`, detalhes com
--     `marcados`/`candidatos_antes`/`ja_cliente_total`). É o ÚNICO escritor do slug (regra da casa).
--     Num cron SQL-local o `job_run_details.return_message` de um SELECT é só "1 row" — o valor
--     retornado NÃO fica registrado; o ledger é o que torna a contagem observável (`<UltimaExecucao>`).
--   • Erro da função original PROPAGA (não é engolido): `cron.job_run_details.status='failed'` carrega a
--     mensagem plpgsql real (docs/agent/sync.md — para SQL-local o job_run_details É a fonte primária).
--     A linha do ledger não sobrevive ao rollback — por desenho: ausência de `sucesso` recente é o sinal.
--     Só a GRAVAÇÃO do ledger é fail-open (observabilidade nunca derruba o trabalho).
--   • `cron.schedule('radar-recruzar-ja-cliente-diario', '15 6 * * *')` = 03:15 BRT (cron.timezone vazio
--     → UTC; BRT = UTC−3). Fora do expediente e longe dos jobs das 06:00/07:30 UTC. Upsert por nome.
--
-- pg_cron roda como `postgres` (owner), sem JWT: a função original é SECURITY DEFINER sem gate de
-- auth.uid() (pg_get_functiondef de PROD conferido em 2026-10-18; ACL {postgres, service_role}) — o
-- caso "gate de JWT × pg_cron" de money-path.md não se aplica. A prova roda em sessão limpa (sem GUC).
--
-- DONO: aplicar como `postgres` (SQL Editor do Lovable ou conector MCP) — `claude_rw` NÃO tem USAGE
-- em `cron` (medido: has_schema_privilege('claude_rw','cron','USAGE') = f), então `db:aplicar` não serve.
-- Idempotente: CREATE OR REPLACE + REVOKE + cron.schedule por nome. Postcondição no fim.
-- Prova: db/test-radar-recruzamento-diario.sh (PG17, migration REAL sobre esquema mínimo, --falsificar).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ini              timestamptz := clock_timestamp();
  v_marcados         integer;
  v_candidatos_antes bigint;
  v_ja_cliente_total bigint;
BEGIN
  -- Denominador ANTES do trabalho (fase-sem-sinal.md: contagem sem denominador não é sinal).
  SELECT count(*) INTO v_candidatos_antes FROM public.radar_empresas WHERE NOT ja_cliente;

  -- Erro aqui PROPAGA de propósito (ver cabeçalho).
  v_marcados := public.radar_recruzar_ja_cliente();

  SELECT count(*) INTO v_ja_cliente_total FROM public.radar_empresas WHERE ja_cliente;

  -- Registro ao FINAL, atômico com o trabalho; fail-open: observabilidade nunca derruba o recruzamento.
  BEGIN
    INSERT INTO public.acoes_execucoes
      (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES
      ('radar.recruzar_ja_cliente', 'automatica', v_ini, clock_timestamp(), 'sucesso',
       jsonb_build_object(
         'marcados', v_marcados,
         'candidatos_antes', v_candidatos_antes,
         'ja_cliente_total', v_ja_cliente_total));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_marcados;
END;
$function$;

-- Entrypoint de JOB: só o owner (postgres) e service_role executam — nomeando as roles (REPLACE preserva
-- ACL, mas a 1ª criação herda EXECUTE de PUBLIC).
REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente_tick() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'radar-recruzar-ja-cliente-diario',
  '15 6 * * *',
  $$SELECT public.radar_recruzar_ja_cliente_tick();$$
);

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'radar_recruzar_ja_cliente_tick' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: radar_recruzar_ja_cliente_tick ausente ou sem SECURITY DEFINER — o cron não teria o que chamar';
  END IF;
  IF has_function_privilege('anon', 'public.radar_recruzar_ja_cliente_tick()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.radar_recruzar_ja_cliente_tick()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A2 FALHOU: anon/authenticated executam o tick — qualquer sessão dispararia o recruzamento e gravaria no ledger';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'radar-recruzar-ja-cliente-diario'
      AND schedule = '15 6 * * *'
      AND command LIKE '%public.radar_recruzar_ja_cliente_tick()%'
      AND active
  ) THEN
    RAISE EXCEPTION 'A3 FALHOU: cron radar-recruzar-ja-cliente-diario não agendado às 06:15 UTC — ja_cliente só seria recruzado no próximo lote mensal';
  END IF;
  RAISE NOTICE 'radar: tick SECURITY DEFINER com ACL fechada + cron diário 03:15 BRT provados';
END
$post$;

COMMIT;
