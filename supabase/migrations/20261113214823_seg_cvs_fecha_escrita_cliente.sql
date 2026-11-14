-- ============================================================
-- seg_cvs_fecha_escrita_cliente — fecha a escrita direta em customer_visit_scores (2026-11-13)
--
-- Achado (scanner Lovable "Any staff member can change another customer's visit scores" + revisão
-- Codex/Fable): as policies cvs_insert/update/delete_own_or_gestor aceitavam
-- `OR farmer_id = auth.uid()` SEM exigir role, e `anon`/`authenticated` tinham INSERT/UPDATE/DELETE
-- (conferido na PROD via psql-ro). Qualquer JWT — inclusive um customer recém-cadastrado, não
-- aprovado — inseria um score fabricado para todo cliente ainda sem linha (UNIQUE é só por
-- customer_user_id), e quem fosse `farmer_id` editava/apagava à vontade.
--
-- Escritores legítimos (conferidos): edges visit-score-recalc-client/-batch (service_role) e a
-- SECURITY DEFINER aplicar_exclusao_fornecedores (owner postgres, sem FORCE RLS). O front só LÊ
-- (useMyVisitSuggestions, useRouteContactList). Nenhuma função invoker faz FOR SHARE/UPDATE nesta
-- tabela (≠ farmer_client_scores, que precisou do GRANT UPDATE(updated_at) em 20261018160000).
-- ⇒ Fecha por GRANT (as duas pontas, anon E authenticated) e remove as policies de escrita,
--   que viram código morto e enganoso. A leitura (cvs_select_carteira) não muda.
--
-- Caminho: SQL Editor (REVOKE/DROP POLICY = DDL destrutivo → founder). Idempotente.
-- ============================================================
BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.customer_visit_scores FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS cvs_insert_own_or_gestor ON public.customer_visit_scores;
DROP POLICY IF EXISTS cvs_update_own_or_gestor ON public.customer_visit_scores;
DROP POLICY IF EXISTS cvs_delete_own_or_gestor ON public.customer_visit_scores;

COMMENT ON TABLE public.customer_visit_scores IS
  'Score de visita por cliente (1 linha por customer_user_id). ESCRITA só por service_role (edges '
  'visit-score-recalc-*) e SECURITY DEFINER; anon/authenticated só leem (cvs_select_carteira). '
  'Fechado em 20261113214823 — não reabrir escrita client-side.';

-- ---------- postcondição ----------
DO $post$
DECLARE
  r text;
  p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
      IF has_table_privilege(r, 'public.customer_visit_scores', p) THEN
        RAISE EXCEPTION 'A1 FALHOU: % ainda tem % em customer_visit_scores — score forjável pelo PostgREST', r, p;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_visit_scores'
              AND cmd IN ('INSERT','UPDATE','DELETE','ALL')) THEN
    RAISE EXCEPTION 'A2 FALHOU: sobrou policy de escrita em customer_visit_scores';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_visit_scores'
                  AND policyname = 'cvs_select_carteira' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'A3 FALHOU: cvs_select_carteira sumiu — roteiro e sugestões de visita ficam vazios';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.customer_visit_scores', 'SELECT') THEN
    RAISE EXCEPTION 'A4 FALHOU: authenticated perdeu SELECT — roteiro e sugestões de visita ficam vazios';
  END IF;

  IF NOT (has_table_privilege('service_role', 'public.customer_visit_scores', 'INSERT')
          AND has_table_privilege('service_role', 'public.customer_visit_scores', 'UPDATE')) THEN
    RAISE EXCEPTION 'A5 FALHOU: service_role sem INSERT/UPDATE — as edges de recálculo param de gravar';
  END IF;
END
$post$;

COMMIT;
SELECT 'OK seg_cvs_fecha_escrita_cliente' AS fim;
