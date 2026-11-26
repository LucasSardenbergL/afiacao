-- db/medir-caca-candidatos-antes.sql — linha de base da v_caca_candidatos como FARMER (READ-ONLY).
--   bun run db:aplicar db/medir-caca-candidatos-antes.sql --ensaio   (SEMPRE --ensaio)
-- Páginas do front (ORDER BY documento, empresa_alvo + LIMIT/OFFSET 1000) e, POR ÚLTIMO, a view
-- inteira sem LIMIT (a que a onda D viu estourar 300 s). NOTICE sai na hora: as páginas ficam no
-- log mesmo se a última estourar.
DO $m$
DECLARE
  t0 timestamptz;
  n  bigint;
  o  int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '700657a1-d75d-4c72-99b1-0a0f2065fa29', 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '700657a1-d75d-4c72-99b1-0a0f2065fa29', true);
  FOREACH o IN ARRAY ARRAY[0, 15000, 31000] LOOP
    t0 := clock_timestamp();
    SELECT count(*) INTO n FROM (
      SELECT documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias, compra_em_outra_empresa,
             ultima_compra_grupo_dias, nome, telefone, cliente_user_id, contato_visivel
        FROM public.v_caca_candidatos ORDER BY documento, empresa_alvo LIMIT 1000 OFFSET o) z;
    RAISE NOTICE 'MED pagina offset=% n=% ms=%', o, n, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
  END LOOP;
  t0 := clock_timestamp();
  SELECT count(*) INTO n FROM (SELECT * FROM public.v_caca_candidatos ORDER BY documento, empresa_alvo) z;
  RAISE NOTICE 'MED inteira n=% ms=%', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
END
$m$;
