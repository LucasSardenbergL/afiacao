-- ============================================================
-- seg_scanner_politicas_select_abertas — fecha os achados do scanner Lovable Security (2026-11-13)
--
-- Achado 1 (CRÍTICO) "Some access rules let everyone through — 15 tables": políticas SELECT com
--   USING (true). Nenhuma era de escrita (todas SELECT). Destino por tabela:
--   • staff-only (has_role master/employee): tint_corantes (preco_litro = CUSTO), tint_bases,
--     tint_produtos, tint_embalagens, tint_colecoes, tint_subcolecoes, warehouses, category_mappings,
--     cep_geo, municipio_geo. Leitores: páginas de staff, edges com service_role e RPCs SECURITY
--     DEFINER (bypassam RLS). Os fluxos tint do pedido já dependem de tint_skus/tint_formulas, que
--     são staff-only — o customer não tinha caminho por eles.
--   • staff OU usuário APROVADO (profiles.is_approved): default_prices (preço — era lido por ANON),
--     omie_servicos, tool_specifications, training_modules (este mantendo is_active). O customer
--     aprovado precisa deles em /new-order, /tools e /training; o recém-cadastrado não aprovado, não.
--   • tool_categories FICA PÚBLICA por desenho: Auth.tsx lê ANTES do login (cadastro). Catálogo
--     sem dado sensível — marcar como aceito no scanner.
-- Achado 3 (WARNING) company_cnpjs: SELECT `auth.role()='authenticated'` → staff-only. Só a edge
--   fin-ic-reconcile (service_role) e a SECDEF fin_consolidado_intercompany leem; nada em src/.
-- Achado 2 (INFO) avatars: "Public can view avatars" deixava QUALQUER UM listar o bucket. O bucket é
--   public=true, então a URL pública (getPublicUrl em Profile.tsx) é servida SEM política de SELECT;
--   a política só acrescentava o LIST. O upsert do dono segue: "Owners can list their avatars" torna
--   a própria linha visível (database.md §7). Reverte a regressão de 20260627180200.
--
-- Helper: só has_role (não criar helper novo — oráculo). Subselect em volta de tudo (initplan).
-- Caminho: SQL Editor (DROP POLICY = DDL destrutivo + storage = schema de sistema → founder).
-- Idempotente: DROP IF EXISTS + CREATE. Postcondição $post$ aborta se algo não pegou.
-- ============================================================
BEGIN;

-- ---------- staff-only ----------
DO $staff$
DECLARE
  t text;
  velhas jsonb := jsonb_build_object(
    'tint_corantes',     'Authenticated can view tint_corantes',
    'tint_bases',        'Authenticated can view tint_bases',
    'tint_produtos',     'Authenticated can view tint_produtos',
    'tint_embalagens',   'Authenticated can view tint_embalagens',
    'tint_colecoes',     'Authenticated can view tint_colecoes',
    'tint_subcolecoes',  'Authenticated can view tint_subcolecoes',
    'warehouses',        'Authenticated users can view warehouses',
    'category_mappings', 'Anyone can view category mappings',
    'cep_geo',           'cep_geo_sel',
    'municipio_geo',     'municipio_geo_sel',
    'company_cnpjs',     'company_cnpjs_select_authenticated'
  );
BEGIN
  FOR t IN SELECT jsonb_object_keys(velhas) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', velhas->>t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_staff', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
      || '(SELECT public.has_role((SELECT auth.uid()), ''master''::public.app_role))'
      || ' OR (SELECT public.has_role((SELECT auth.uid()), ''employee''::public.app_role)))',
      t || '_select_staff', t);
  END LOOP;
END
$staff$;

-- ---------- staff OU aprovado ----------
DO $aprov$
DECLARE
  t text;
  extra text;
  velhas jsonb := jsonb_build_object(
    'default_prices',      'Anyone can view default prices',
    'omie_servicos',       'Anyone can view omie services mapping',
    'tool_specifications', 'Anyone can read tool specifications',
    'training_modules',    'Anyone can view active training modules'
  );
BEGIN
  FOR t IN SELECT jsonb_object_keys(velhas) LOOP
    extra := CASE WHEN t = 'training_modules' THEN 'is_active AND ' ELSE '' END;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', velhas->>t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_aprovados', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s('
      || '(SELECT public.has_role((SELECT auth.uid()), ''master''::public.app_role))'
      || ' OR (SELECT public.has_role((SELECT auth.uid()), ''employee''::public.app_role))'
      || ' OR (SELECT EXISTS (SELECT 1 FROM public.profiles p'
      || ' WHERE p.user_id = (SELECT auth.uid()) AND p.is_approved))))',
      t || '_select_aprovados', t, extra);
  END LOOP;
END
$aprov$;

-- ---------- avatars: tira o LIST público ----------
DROP POLICY IF EXISTS "Public can view avatars" ON storage.objects;

-- ---------- postcondição ----------
DO $post$
DECLARE
  n int;
BEGIN
  -- nenhuma SELECT trivial sobrou nas 15 tabelas (tool_categories é a exceção declarada)
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('tint_corantes','tint_bases','tint_produtos','tint_embalagens','tint_colecoes',
                       'tint_subcolecoes','warehouses','category_mappings','cep_geo','municipio_geo',
                       'company_cnpjs','default_prices','omie_servicos','tool_specifications',
                       'training_modules')
     AND cmd = 'SELECT'
     AND (qual = 'true' OR qual ILIKE '%auth.role()%');
  IF n <> 0 THEN
    RAISE EXCEPTION 'A1 FALHOU: % politica(s) SELECT trivial(is) ainda ativa(s) — o achado do scanner continua aberto', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND cmd = 'SELECT' AND roles = '{authenticated}'
     AND policyname IN ('tint_corantes_select_staff','tint_bases_select_staff','tint_produtos_select_staff',
                        'tint_embalagens_select_staff','tint_colecoes_select_staff',
                        'tint_subcolecoes_select_staff','warehouses_select_staff',
                        'category_mappings_select_staff','cep_geo_select_staff',
                        'municipio_geo_select_staff','company_cnpjs_select_staff')
     AND qual ILIKE '%has_role%employee%';
  IF n <> 11 THEN
    RAISE EXCEPTION 'A2 FALHOU: % de 11 politicas *_select_staff — staff perderia leitura', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND cmd = 'SELECT' AND roles = '{authenticated}'
     AND policyname IN ('default_prices_select_aprovados','omie_servicos_select_aprovados',
                        'tool_specifications_select_aprovados','training_modules_select_aprovados')
     AND qual ILIKE '%is_approved%' AND qual ILIKE '%has_role%';
  IF n <> 4 THEN
    RAISE EXCEPTION 'A3 FALHOU: % de 4 politicas *_select_aprovados — customer aprovado perderia o pedido', n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND policyname = 'training_modules_select_aprovados' AND qual ILIKE '%is_active%') THEN
    RAISE EXCEPTION 'A4 FALHOU: training_modules sem filtro is_active — customer veria modulo inativo';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND policyname = 'Public can view avatars') THEN
    RAISE EXCEPTION 'A5 FALHOU: "Public can view avatars" ainda existe — bucket continua listavel';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'Owners can list their avatars' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'A6 FALHOU: sem "Owners can list their avatars" — upsert do avatar mutaria 0 linhas';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tool_categories'
                  AND policyname = 'Anyone can view tool categories') THEN
    RAISE EXCEPTION 'A7 FALHOU: tool_categories perdeu a leitura publica — cadastro pre-login quebra';
  END IF;
END
$post$;

COMMIT;
SELECT 'OK seg_scanner_politicas_select_abertas' AS fim;
