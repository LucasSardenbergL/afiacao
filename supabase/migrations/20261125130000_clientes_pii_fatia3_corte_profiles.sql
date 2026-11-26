-- Onda D da tela Clientes — fatia 3b: o CORTE. profiles deixa de entregar e-mail, telefone, documento
-- e CNPJ pela API. Spec: docs/superpowers/specs/2026-11-24-clientes-pii-por-carteira-design.md.
--
-- REVOKE SELECT de TABELA + GRANT SELECT só das colunas de IDENTIDADE/operação, para authenticated e anon
-- (precedente: 20261014120100). Leitor antigo quebra ALTO (42501), não some com linha calada.
-- O contato passa a sair só por:
--   · public.v_perfil_contato (mascarada fora da carteira/cobertura; gestão e master veem tudo; self vê o seu);
--   · public.contato_cliente_operacional (RPC por OBJETO, grava a exceção no ledger);
--   · public.v_perfil_equipe (e-mail de colega de staff, para staff).
--
-- PRÉ-REQUISITOS (não aplicar antes):
--   1. 20261125120000 aplicada (os leitores de SERVIDOR já saíram das colunas);
--   2. o front da fatia 3 PUBLICADO e com o BUILD_SHA servido = merge (os leitores do FRONT já saíram).
--
-- ⚠️ Coluna NOVA em profiles nasce SEM grant para authenticated/anon: quem a criar precisa de
--    GRANT SELECT (col) — senão 42501 no front (registrado em docs/agent/database.md §4).
-- INSERT/UPDATE/DELETE seguem no nível de TABELA (as policies de escrita não mudam). UPDATE … WHERE
-- user_id e upsert ON CONFLICT (user_id) só precisam de SELECT em user_id e nas colunas LIDAS.
-- service_role, postgres e os papéis sandbox_exec não mudam.
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — este arquivo não leva BEGIN/COMMIT).

REVOKE SELECT ON public.profiles FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  id, user_id, name, razao_social, created_at, updated_at, customer_type, cnae, avatar_url,
  is_employee, employee_code, business_hours_open, business_hours_close, is_approved,
  lunch_start, lunch_end, preferred_delivery_time, requires_po, is_prospect, prospect_source,
  prospect_origin_call_id
) ON public.profiles TO anon, authenticated;

DO $post$
DECLARE
  r text;
  c text;
  v_sem_grant text[];
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.profiles', 'SELECT') THEN
      RAISE EXCEPTION 'postcondicao: % ainda tem SELECT de tabela em profiles', r;
    END IF;
    FOREACH c IN ARRAY ARRAY['email', 'phone', 'document', 'cnpj'] LOOP
      IF has_column_privilege(r, 'public.profiles', c, 'SELECT') THEN
        RAISE EXCEPTION 'postcondicao: % le profiles.%', r, c;
      END IF;
    END LOOP;
    -- toda coluna que NÃO é contato continua legível (senão o app quebra por omissão)
    SELECT array_agg(a.attname ORDER BY a.attnum) INTO v_sem_grant
      FROM pg_attribute a
     WHERE a.attrelid = 'public.profiles'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname NOT IN ('email', 'phone', 'document', 'cnpj')
       AND NOT has_column_privilege(r, 'public.profiles', a.attname, 'SELECT');
    IF v_sem_grant IS NOT NULL THEN
      RAISE EXCEPTION 'postcondicao: % perdeu colunas de identidade: %', r, v_sem_grant;
    END IF;
    IF NOT has_table_privilege(r, 'public.profiles', 'INSERT')
       OR NOT has_table_privilege(r, 'public.profiles', 'UPDATE') THEN
      RAISE EXCEPTION 'postcondicao: % perdeu escrita em profiles', r;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: service_role perdeu SELECT em profiles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.profiles'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'postcondicao: profiles sem RLS';
  END IF;
END
$post$;
