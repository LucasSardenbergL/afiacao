-- db/fixtures/db-aplicar-corrida-a.sql — o apply A da prova db/test-pre-anti-deriva-concorrencia.sh.
-- CORRIDA_A_SENTINELA (o orquestrador acha o backend deste apply por esta palavra no corpo).
-- PRE anti-deriva SEM trava de arquivo — o que se prova com esta fixture é a fila do EXECUTOR —,
-- uma BARREIRA que só existe no teste, depois o CREATE OR REPLACE e a PÓS.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.corrida_alvo()');
  IF v_vivo IS NULL OR v_vivo NOT IN ('f150aad8dd266247b8908d3114492975', 'ce03e1a9b01768d820b237f85779e1bf') THEN
    RAISE EXCEPTION 'PRE_RECUSOU corrida_alvo vivo=%', v_vivo;
  END IF;
END
$pre$;

-- BARREIRA: o orquestrador segura esta chave; A para AQUI, depois da PRE e antes do CREATE. O
-- lock_timeout do executor (15 s) vale para esta espera também — 60 s só aqui, contra runner lento.
SET LOCAL lock_timeout = '60s';
SELECT pg_advisory_xact_lock(731000001);

CREATE OR REPLACE FUNCTION public.corrida_alvo() RETURNS text LANGUAGE sql STABLE AS $$SELECT 'A'$$;

DO $pos$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.corrida_alvo()'))
       IS DISTINCT FROM 'ce03e1a9b01768d820b237f85779e1bf' THEN
    RAISE EXCEPTION 'POS_RECUSOU corrida_alvo';
  END IF;
END
$pos$;
