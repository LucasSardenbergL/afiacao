-- db/medir-caca-candidatos.sql — medição da v_caca_candidatos como FARMER (READ-ONLY).
--   bun run db:aplicar db/medir-caca-candidatos.sql --ensaio      (SEMPRE --ensaio: ROLLBACK, nada grava)
-- O envelope roda em SECURITY DEFINER (não aceita SET ROLE), mas o GUC do JWT vale: auth.uid() e
-- has_role() resolvem a farmer — é a lógica das views de RLS que pesa, não a RLS das tabelas base
-- (todas InitPlan). Saída: NOTICEs 'MED'/'PLAN' no log que o envelope imprime.
-- Farmer de referência: 700657a1-d75d-4c72-99b1-0a0f2065fa29 (employee + commercial_role farmer).
DO $m$
DECLARE
  r  text;
  t0 timestamptz;
  n  bigint;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '700657a1-d75d-4c72-99b1-0a0f2065fa29', 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '700657a1-d75d-4c72-99b1-0a0f2065fa29', true);
  RAISE NOTICE 'MED uid=% current_user=%', auth.uid(), current_user;

  t0 := clock_timestamp();
  SELECT count(*) INTO n FROM private.v_perfil_chaves_internas;
  RAISE NOTICE 'MED v_perfil_chaves_internas n=% ms=%', n,
    round(extract(epoch FROM clock_timestamp() - t0) * 1000);

  t0 := clock_timestamp();
  SELECT count(*) INTO n FROM public.v_perfil_contato;
  RAISE NOTICE 'MED v_perfil_contato n=% ms=%', n,
    round(extract(epoch FROM clock_timestamp() - t0) * 1000);

  FOR r IN EXECUTE $q$
    EXPLAIN SELECT documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias,
                   compra_em_outra_empresa, ultima_compra_grupo_dias, nome, telefone,
                   cliente_user_id, contato_visivel
              FROM public.v_caca_candidatos
             ORDER BY documento, empresa_alvo
             LIMIT 1000 OFFSET 0
  $q$ LOOP
    RAISE NOTICE 'PLAN %', r;
  END LOOP;
END
$m$;
