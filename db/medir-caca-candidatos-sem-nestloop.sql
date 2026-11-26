-- db/medir-caca-candidatos-sem-nestloop.sql — hipótese da correção, como FARMER (READ-ONLY).
--   bun run db:aplicar db/medir-caca-candidatos-sem-nestloop.sql --ensaio   (SEMPRE --ensaio)
-- Mesmo corpo da view, só com enable_nestloop=off na transação: se a causa é o Nested Loop
-- escolhido sobre a estimativa colapsada (rows=1), a página cai para ~1 s. Imprime o plano real.
DO $m$
DECLARE
  r  text;
  t0 timestamptz;
  n  bigint;
  d  text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '700657a1-d75d-4c72-99b1-0a0f2065fa29', 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '700657a1-d75d-4c72-99b1-0a0f2065fa29', true);
  PERFORM set_config('enable_nestloop', 'off', true);
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, TIMING OFF) SELECT documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias,
           compra_em_outra_empresa, ultima_compra_grupo_dias, nome, telefone, cliente_user_id, contato_visivel
      FROM public.v_caca_candidatos ORDER BY documento, empresa_alvo LIMIT 1000 OFFSET 0
  $q$ LOOP
    RAISE NOTICE 'PLAN %', r;
  END LOOP;
  t0 := clock_timestamp();
  SELECT count(*), md5(string_agg(z::text, '|' ORDER BY z.documento, z.empresa_alvo)) INTO n, d FROM (
    SELECT documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias, compra_em_outra_empresa,
           ultima_compra_grupo_dias, nome, telefone, cliente_user_id, contato_visivel
      FROM public.v_caca_candidatos) z;
  RAISE NOTICE 'MED total n=% md5=% ms=%', n, d, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
END
$m$;
