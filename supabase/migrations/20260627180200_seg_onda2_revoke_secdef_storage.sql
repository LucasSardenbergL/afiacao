-- ============================================================
-- 20260627180200_seg_onda2_revoke_secdef_storage.sql
-- Hardening de segurança — Onda 2 (superfície de autorização)
--
-- Fecha achados do scanner Lovable Security:
--   • "Public Can Execute SECURITY DEFINER Function" (51 funções executáveis por anon)
--   • "Avatars bucket has no public SELECT policy despite being a public bucket"
--   • "Task proof-of-completion bucket is missing UPDATE and DELETE policies"
--
-- Contexto (verificado em prod via psql-ro):
--   - authenticated tem grant EXPLÍCITO de EXECUTE → revogar PUBLIC não o afeta.
--   - a maioria das SECDEF concede a PUBLIC (=X/postgres) ALÉM de anon → revogar
--     ambos para barrar o anon de fato.
--   - get_public_tool_history é chamada pela página pública ToolPublicHistory.tsx
--     → fica na ALLOWLIST (mantém anon).
-- Idempotente: REVOKE do já-revogado é no-op; DROP POLICY IF EXISTS antes de CREATE.
-- ============================================================

-- ── 1) Revogar anon/PUBLIC das SECURITY DEFINER ─────────────────────────────
-- anon (não autenticado) não deve executar nenhuma SECDEF, exceto a allowlist pública.
-- authenticated mantém (grant explícito intacto). Triggers SECDEF: revoga anon+auth+public
-- (nunca são chamadas via RPC; o disparo do trigger roda como owner, independe de EXECUTE).
DO $$
DECLARE
  r record;
  allow text[] := ARRAY['get_public_tool_history'];  -- página pública (ToolPublicHistory.tsx)
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig,
           p.proname,
           pg_catalog.format_type(p.prorettype, NULL) = 'trigger' AS eh_trigger
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prokind = 'f'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')   -- só as que o anon hoje executa
  LOOP
    IF r.proname = ANY(allow) THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', r.sig);
    IF r.eh_trigger THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig);
    END IF;
  END LOOP;
END $$;

-- ── 2) Storage: avatars é bucket público mas sem policy de SELECT pública ────
-- O app exibe avatares via getPublicUrl (Profile.tsx) → leitura pública é o modelo
-- pretendido. Torna explícito (consistente com bucket.public = true).
DROP POLICY IF EXISTS "Public can view avatars" ON storage.objects;
CREATE POLICY "Public can view avatars"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'avatars');

-- ── 3) Storage: comprovações de tarefa sem policy de UPDATE/DELETE ───────────
-- Comprovação é prova de conclusão (imutável p/ operação: upload é upsert:false +
-- path único por timestamp). Mantém imutável p/ separador/conferente/gestor; dá
-- override administrativo (correção/LGPD) só ao master. Wrap (SELECT auth.uid())
-- = InitPlan 1× (database.md §4).
DROP POLICY IF EXISTS "tarefa_comprov_update_master" ON storage.objects;
CREATE POLICY "tarefa_comprov_update_master"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING      (bucket_id = 'tarefa-comprovacoes' AND public.has_role((SELECT auth.uid()), 'master'::public.app_role))
  WITH CHECK (bucket_id = 'tarefa-comprovacoes' AND public.has_role((SELECT auth.uid()), 'master'::public.app_role));

DROP POLICY IF EXISTS "tarefa_comprov_delete_master" ON storage.objects;
CREATE POLICY "tarefa_comprov_delete_master"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'tarefa-comprovacoes' AND public.has_role((SELECT auth.uid()), 'master'::public.app_role));
