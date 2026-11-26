-- db/medir-caca-candidatos-antes.sql — linha de base: 1ª página da v_caca_candidatos como FARMER (READ-ONLY).
--   bun run db:aplicar db/medir-caca-candidatos-antes.sql --ensaio   (SEMPRE --ensaio)
-- Esperado ANTES da correção: estourar o teto de 300 s do envelope (Nested Loop sobre estimativa rows=1).
DO $m$
DECLARE
  t0 timestamptz;
  n  bigint;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '700657a1-d75d-4c72-99b1-0a0f2065fa29', 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '700657a1-d75d-4c72-99b1-0a0f2065fa29', true);
  t0 := clock_timestamp();
  SELECT count(*) INTO n FROM (
    SELECT documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias, compra_em_outra_empresa,
           ultima_compra_grupo_dias, nome, telefone, cliente_user_id, contato_visivel
      FROM public.v_caca_candidatos ORDER BY documento, empresa_alvo LIMIT 1000 OFFSET 0) z;
  RAISE NOTICE 'MED pagina1 n=% ms=%', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
END
$m$;
