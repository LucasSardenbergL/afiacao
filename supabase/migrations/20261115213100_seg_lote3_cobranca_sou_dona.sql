-- ============================================================
-- seg_lote3_cobranca_sou_dona — lote 3 do rescan do scanner Lovable Security (2026-11-15)
--
-- Item de banco do lote 3, conferido na PROD via psql-ro antes de escrever (o seed da cota
-- vive em 20261115213000_seg_lote3_cota_vision.sql):
--
-- Achado 43bd6b91: public.cobranca_dona(company, codigo) é SECURITY DEFINER, devolve o uuid
--     do vendedor dono de QUALQUER cliente, e authenticated tinha EXECUTE (inclusive customer).
--     Funcionava como oráculo da carteira: qualquer logado descobria a dona de qualquer código
--     Omie, por fora da RLS de carteira_assignments. O EXECUTE existia só porque as 3 policies
--     SELECT de cobranca_caso/promessa/evento chamam a função como o invocador.
--     O conserto (2ª opinião Codex, 2026-11-15): as policies passam a chamar o booleano
--     public.cobranca_sou_dona(company, codigo), que só responde "sou eu a dona?" para o próprio
--     auth.uid(), sem parâmetro de usuário. cobranca_dona sai de authenticated. As 4 funções
--     SECDEF que a usam (cobranca_fila, cobranca_caso_registrar, cobranca_regua_hoje,
--     cobranca_pode_agir) são do postgres e seguem chamando com o privilégio do dono.
--     A semântica das policies não muda: `coalesce(dona = uid, false)` vira o mesmo coalesce
--     dentro do helper, e o ramo da gestão fica intacto.
--
-- Idempotente (CREATE OR REPLACE, DROP POLICY IF EXISTS) e atômico (o envelope `db:aplicar` dá a transação; colado no SQL Editor, rode o arquivo
-- inteiro de uma vez): as policies trocam ANTES do REVOKE, senão a leitura de cobrança quebraria no meio. Postcondição
-- no fim aborta tudo se algo não ficou como deve.
-- ============================================================

-- ── (B) Booleano da dona para as policies; cobranca_dona fecha ────────────
CREATE OR REPLACE FUNCTION public.cobranca_sou_dona(p_company text, p_codigo bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  -- Sem parâmetro de usuário de propósito: só responde pelo próprio chamador. uid nulo → false.
  SELECT coalesce(public.cobranca_dona(p_company, p_codigo) = (SELECT auth.uid()), false)
$fn$;
REVOKE ALL ON FUNCTION public.cobranca_sou_dona(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cobranca_sou_dona(text, bigint) TO authenticated, service_role;

DROP POLICY IF EXISTS "cobranca_caso_select" ON public.cobranca_caso;
CREATE POLICY "cobranca_caso_select" ON public.cobranca_caso FOR SELECT
  USING (public.cobranca_sou_dona(company, omie_codigo_cliente)
         OR coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false));
DROP POLICY IF EXISTS "cobranca_promessa_select" ON public.cobranca_promessa;
CREATE POLICY "cobranca_promessa_select" ON public.cobranca_promessa FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.cobranca_caso c WHERE c.id = caso_id
                   AND (public.cobranca_sou_dona(c.company, c.omie_codigo_cliente)
                        OR coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false))));
DROP POLICY IF EXISTS "cobranca_evento_select" ON public.cobranca_evento;
CREATE POLICY "cobranca_evento_select" ON public.cobranca_evento FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.cobranca_caso c WHERE c.id = caso_id
                   AND (public.cobranca_sou_dona(c.company, c.omie_codigo_cliente)
                        OR coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false))));

-- As duas pontas (PUBLIC e anon) e agora authenticated; service_role segue (edges de cobrança).
REVOKE ALL ON FUNCTION public.cobranca_dona(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cobranca_dona(text, bigint) TO service_role;

-- ── Postcondição ──────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_pol text;
BEGIN
  IF has_function_privilege('authenticated', 'public.cobranca_dona(text,bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cobranca_dona(text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST: cobranca_dona ainda executável por authenticated ou anon';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.cobranca_dona(text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST: service_role perdeu cobranca_dona';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.cobranca_sou_dona(text,bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cobranca_sou_dona(text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST: ACL de cobranca_sou_dona errada (authenticated sim, anon não)';
  END IF;
  IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""']
            FROM pg_proc p WHERE p.oid = 'public.cobranca_sou_dona(text,bigint)'::regprocedure) THEN
    RAISE EXCEPTION 'POST: cobranca_sou_dona sem SECURITY DEFINER ou sem search_path vazio';
  END IF;

  -- Nenhuma policy pode seguir chamando cobranca_dona como o invocador (falharia com 42501).
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_pol
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'cobranca_dona\(';
  IF v_pol IS NOT NULL THEN
    RAISE EXCEPTION 'POST: policies ainda chamam cobranca_dona: %', v_pol;
  END IF;
  SELECT string_agg(t, ', ') INTO v_pol
    FROM unnest(ARRAY['cobranca_caso', 'cobranca_promessa', 'cobranca_evento']) AS t
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = t
                        AND p.policyname = t || '_select' AND p.qual ~ 'cobranca_sou_dona\(');
  IF v_pol IS NOT NULL THEN
    RAISE EXCEPTION 'POST: policy de leitura sem cobranca_sou_dona em: %', v_pol;
  END IF;

  RAISE NOTICE 'POST-OK seg_lote3_cobranca_sou_dona';
END
$post$;

