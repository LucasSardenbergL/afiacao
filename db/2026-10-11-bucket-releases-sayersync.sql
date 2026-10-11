-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Bucket `releases` — de onde o conector SayerSync (connector/sayersync) baixa a própria atualização.
--
-- POR QUÊ: o auto-update do conector (`update.go`, 1×/dia) lê
--   https://fzvklzpomgnyikkfkzai.supabase.co/storage/v1/object/public/releases/sayersync/manifest.json
-- e esse bucket nunca existiu (curl em 2026-10-11 → `Bucket not found`). O founder não tem acesso ao
-- painel do Supabase (Lovable Cloud), então a publicação passa pelo app: a aba "Releases" em
-- Tintométrico → Integração sobe o `.exe` e depois o `manifest.json`, autenticada como master.
--
-- DESENHO:
--   · leitura PÚBLICA — o conector baixa sem auth (rota /object/public não passa por RLS);
--   · escrita (INSERT/UPDATE) só master, via RLS em `storage.objects`;
--   · SELECT master também: o upsert do manifest é INSERT … ON CONFLICT DO UPDATE, e UPDATE sob RLS
--     acha 0 linhas sem uma policy SELECT que torne a linha visível (docs/agent/database.md);
--   · SEM policy de DELETE: binário publicado é imutável (a tela sobe .exe com upsert=false).
--
-- Sem BEGIN/COMMIT: a transação é do envelope (`bun run db:aplicar`). Idempotente: bucket com
-- ON CONFLICT DO NOTHING, policies criadas só se ausentes (nada é dropado).
-- Prova de RLS (master permitido; employee/customer/anon negados): db/test-bucket-releases.sh.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

DO $prevoo$
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'pre-voo: storage.buckets/storage.objects ausentes nesta base';
  END IF;
  IF to_regprocedure('public.has_role(uuid, public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'pre-voo: public.has_role(uuid, app_role) ausente nesta base';
  END IF;
END
$prevoo$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('releases', 'releases', true, 52428800, ARRAY['application/octet-stream', 'application/json'])
ON CONFLICT (id) DO NOTHING;

DO $policies$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'releases_select_master') THEN
    CREATE POLICY releases_select_master ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'releases' AND public.has_role((SELECT auth.uid()), 'master'::public.app_role));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'releases_insert_master') THEN
    CREATE POLICY releases_insert_master ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'releases' AND public.has_role((SELECT auth.uid()), 'master'::public.app_role));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'releases_update_master') THEN
    CREATE POLICY releases_update_master ON storage.objects
      FOR UPDATE TO authenticated
      USING      (bucket_id = 'releases' AND public.has_role((SELECT auth.uid()), 'master'::public.app_role))
      WITH CHECK (bucket_id = 'releases' AND public.has_role((SELECT auth.uid()), 'master'::public.app_role));
  END IF;
END
$policies$;

-- Postcondição: pelo que o banco responde, não pelo que o INSERT/CREATE "deveria" ter feito. Um bucket
-- `releases` pré-existente e PRIVADO passaria pelo ON CONFLICT e quebraria o conector em silêncio.
DO $post$
DECLARE
  v_public boolean;
  v_n      int;
  v_soltas int;
BEGIN
  SELECT public INTO v_public FROM storage.buckets WHERE id = 'releases';
  IF v_public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'postcondicao: bucket releases ausente ou nao-publico (public=%)', v_public;
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('releases_select_master', 'releases_insert_master', 'releases_update_master')
     AND roles = '{authenticated}'::name[]
     AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%has_role%master%';
  IF v_n IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'postcondicao: esperava 3 policies releases_* master-only em storage.objects, achei %', v_n;
  END IF;

  -- Nenhuma OUTRA policy pode abrir escrita no bucket (ex.: uma `bucket_id = 'releases'` solta).
  SELECT count(*) INTO v_soltas FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname NOT LIKE 'releases\_%'
     AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%''releases''%';
  IF v_soltas IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'postcondicao: % policy(ies) alheias citam o bucket releases', v_soltas;
  END IF;
END
$post$;
