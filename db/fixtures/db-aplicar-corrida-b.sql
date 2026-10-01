-- db/fixtures/db-aplicar-corrida-b.sql — o apply B da prova db/test-pre-anti-deriva-concorrencia.sh.
-- CORRIDA_B_SENTINELA (o orquestrador acha o backend deste apply por esta palavra no corpo).
-- Outra mudança no MESMO objeto, revisada contra o MESMO predecessor que A. Sem fila, B commita
-- enquanto A está parado na barreira e A a apaga; com a fila, B espera A e a PRE de B recusa.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.corrida_alvo()');
  IF v_vivo IS NULL OR v_vivo NOT IN ('f150aad8dd266247b8908d3114492975', '1fe8f919431c965c3e7055c6f7bac3fa') THEN
    RAISE EXCEPTION 'PRE_RECUSOU corrida_alvo vivo=%', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.corrida_alvo() RETURNS text LANGUAGE sql STABLE AS $$SELECT 'B'$$;

DO $pos$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.corrida_alvo()'))
       IS DISTINCT FROM '1fe8f919431c965c3e7055c6f7bac3fa' THEN
    RAISE EXCEPTION 'POS_RECUSOU corrida_alvo';
  END IF;
END
$pos$;
