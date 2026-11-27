-- Onda D da tela Clientes — fatia 4b-2b: corte de `addresses` por coluna.
-- Diário: docs/historico/clientes-onda-d-pii-carteira.md (§Fatia 4b-2).
--
-- Antes: `authenticated` lia a tabela inteira; a policy "Employees can view all addresses" dava a QUALQUER
-- staff a rua/número/complemento/bairro/CEP/rótulo de QUALQUER cliente, fora da carteira.
-- Agora: a leitura crua só tem as colunas de identidade/território (id, user_id, city, state, is_default,
-- is_from_omie, created_at). Rua, número, complemento, bairro, CEP e rótulo saem só por `v_endereco_contato`
-- (invoker=off, mascara fora da carteira; o dono vê tudo). A escrita não muda: INSERT/UPDATE/DELETE seguem
-- concedidos — os escritores do front não pedem RETURNING e só filtram por id/user_id (colunas que ficam).
--
-- PRÉ-REQUISITO DE FRONT: só aplicar com o Publish da 4b-2a SERVIDO (__BUILD_SHA__ conferido) — o front
-- antigo lê `addresses` com `select('*')` e quebraria. Dependentes em prod (psql-ro, 2026-11-27):
--   v_caca_candidatos / v_caca_compradores (invoker=on) usam só city, created_at, is_default, state, user_id;
--   v_endereco_contato é invoker=off (lê como dona); radar_vinculos_base só é chamada por SECDEF;
--   nenhuma policy de outra tabela nem trigger referencia `addresses`. Edges que leem a rua: service_role.
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — sem BEGIN/COMMIT). Idempotente.

REVOKE SELECT ON public.addresses FROM authenticated;
REVOKE SELECT ON public.addresses FROM PUBLIC, anon;
GRANT SELECT (id, user_id, city, state, is_default, is_from_omie, created_at) ON public.addresses TO authenticated;

COMMENT ON TABLE public.addresses IS
  'Onda D 4b-2b: leitura crua por authenticated só nas colunas de identidade/território; rua/CEP/rótulo só por v_endereco_contato (mascarada fora da carteira).';

DO $post$
DECLARE
  v_col text;
  v_ruim text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['label', 'street', 'number', 'complement', 'neighborhood', 'zip_code'] LOOP
    IF has_column_privilege('authenticated', 'public.addresses', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'C1 FALHOU: authenticated ainda lê addresses.% cru', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['id', 'user_id', 'city', 'state', 'is_default', 'is_from_omie', 'created_at'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.addresses', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'C2 FALHOU: authenticated perdeu addresses.% (front/views quebrariam)', v_col;
    END IF;
  END LOOP;
  IF has_any_column_privilege('anon', 'public.addresses', 'SELECT') THEN
    RAISE EXCEPTION 'C3 FALHOU: anon lê alguma coluna de addresses';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = 'public.addresses'::regclass AND a.grantee = 0 AND a.privilege_type = 'SELECT') THEN
    RAISE EXCEPTION 'C3 FALHOU: PUBLIC lê addresses';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.addresses', 'SELECT') THEN
    RAISE EXCEPTION 'C4 FALHOU: service_role perdeu SELECT em addresses (edges quebrariam)';
  END IF;
  IF NOT (has_table_privilege('authenticated', 'public.addresses', 'INSERT')
          AND has_table_privilege('authenticated', 'public.addresses', 'UPDATE')
          AND has_table_privilege('authenticated', 'public.addresses', 'DELETE')) THEN
    RAISE EXCEPTION 'C5 FALHOU: authenticated perdeu escrita em addresses (tela Endereços quebraria)';
  END IF;
  -- C6: nenhuma view invoker=on que dependa de addresses usa coluna cortada (leria como o chamador → 42501).
  SELECT string_agg(DISTINCT c.relname || '.' || a.attname, ', ') INTO v_ruim
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class c ON c.oid = r.ev_class
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.refobjid = 'public.addresses'::regclass AND d.refobjsubid > 0 AND c.oid <> d.refobjid
     AND coalesce((SELECT o.option_value FROM pg_options_to_table(c.reloptions) o
                    WHERE o.option_name = 'security_invoker'), 'off') IN ('on', 'true')
     AND NOT has_column_privilege('authenticated', 'public.addresses', a.attname, 'SELECT');
  IF v_ruim IS NOT NULL THEN
    RAISE EXCEPTION 'C6 FALHOU: view invoker=on lê coluna cortada: %', v_ruim;
  END IF;
  -- C7: o gate de leitura da rua continua lendo como dono (invoker=off) — senão o próprio cliente perde a rua.
  IF coalesce((SELECT o.option_value FROM pg_class c, pg_options_to_table(c.reloptions) o
                WHERE c.oid = 'public.v_endereco_contato'::regclass AND o.option_name = 'security_invoker'), 'off')
     IN ('on', 'true') THEN
    RAISE EXCEPTION 'C7 FALHOU: v_endereco_contato virou invoker=on (o dono perderia a rua)';
  END IF;
  RAISE NOTICE 'fatia 4b-2b ok: addresses cortada por coluna';
END
$post$;
