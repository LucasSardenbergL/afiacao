-- ============================================================
-- Captura mensal de preços Sayerlack (embalagem econômica) — Fase 1
-- Spec: docs/superpowers/specs/2026-07-14-sayerlack-captura-preco-embalagem-design.md
-- Três entregas nesta migration:
--   1) run-log da captura: sku_preco_captura_run + sku_preco_captura_run_item
--      (a tabela de preço NUNCA registra ausência — "ausente ≠ zero"; é do
--      run-log que UI/vigia leem inativação e parcialidade do run)
--   2) cron mensal sayerlack-captura-precos-mensal (0 9 10-12 * * = 06:00 BRT
--      dias 10-12; auto-retry 11/12 — a edge sai cedo se já houve run ok no mês)
--   3) embalagem_preco_stale_horas 24→960 (40d): com cadência mensal, 24h
--      marcaria a tela como stale o mês inteiro (ruído)
-- Kill-switch embalagem_captura_automatica_habilitada NÃO muda aqui (segue
-- false; ligar é decisão do founder, sem deploy).
-- Idempotente: re-colar no SQL Editor é seguro (re-run = no-op).
-- ============================================================

-- ------------------------------------------------------------
-- 1a) Run da captura (1 linha por execução da edge)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sku_preco_captura_run (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa              text NOT NULL,
  disparo              text NOT NULL CHECK (disparo IN ('cron','manual','reajuste')),
  modo                 text NOT NULL CHECK (modo IN ('spike','full')),
  status               text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','parcial','falha')),
  iniciado_em          timestamptz NOT NULL DEFAULT now(),
  terminado_em         timestamptz,
  total_alvo           integer,
  total_ok             integer,
  total_nao_encontrado integer,
  total_falha          integer,
  -- linhas restantes no rascunho do portal ao fim do run (esperado 0 — prova
  -- de que a captura não deixou estado; null = browser não reportou)
  linhas_finais_portal integer,
  evidencia_url        text,
  erro                 text,
  criado_por           text
);

CREATE INDEX IF NOT EXISTS idx_sku_preco_captura_run_lookup
  ON public.sku_preco_captura_run (empresa, iniciado_em DESC);

ALTER TABLE public.sku_preco_captura_run ENABLE ROW LEVEL SECURITY;

-- SELECT staff; ESCRITA só service-role (a edge). Sem policy de INSERT/UPDATE/
-- DELETE: RLS ligada nega escrita a anon/authenticated (deny-by-default);
-- service_role tem BYPASSRLS (confirmado em prod — database.md §7).
DROP POLICY IF EXISTS "sku_preco_captura_run_select_staff" ON public.sku_preco_captura_run;
CREATE POLICY "sku_preco_captura_run_select_staff"
  ON public.sku_preco_captura_run
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
    OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
  );

-- ------------------------------------------------------------
-- 1b) Resultado por embalagem dentro do run
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sku_preco_captura_run_item (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           uuid NOT NULL REFERENCES public.sku_preco_captura_run(id) ON DELETE CASCADE,
  empresa          text NOT NULL,
  sku_codigo_omie  text NOT NULL,
  sku_portal       text NOT NULL,
  resultado        text NOT NULL CHECK (resultado IN ('ok','nao_encontrado','falha')),
  -- preço é OPCIONAL aqui (o run-item registra também a ausência); quando
  -- presente, >0 — nunca 0 fabricado. A linha oficial de preço vive em
  -- sku_preco_fornecedor_capturado (preco > 0 NOT NULL, CHECK existente).
  preco            numeric CHECK (preco IS NULL OR preco > 0),
  fonte            text CHECK (fonte IS NULL OR fonte IN ('portal_capturado_ok','portal_capturado_parcial')),
  detalhe          text,
  criado_em        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_preco_captura_run_item_run
  ON public.sku_preco_captura_run_item (run_id);

-- o vigia da Fase 2 varre "run-item recente nao_encontrado" por empresa
CREATE INDEX IF NOT EXISTS idx_sku_preco_captura_run_item_recente
  ON public.sku_preco_captura_run_item (empresa, criado_em DESC);

ALTER TABLE public.sku_preco_captura_run_item ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sku_preco_captura_run_item_select_staff" ON public.sku_preco_captura_run_item;
CREATE POLICY "sku_preco_captura_run_item_select_staff"
  ON public.sku_preco_captura_run_item
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
    OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
  );

-- ------------------------------------------------------------
-- 2) Cron mensal (06:00 BRT dias 10, 11 e 12 — auto-retry; a edge é quem
--    decide sair cedo pelo run-log: "já houve run ok no mês" é idempotência
--    de NEGÓCIO, não de scheduler)
--    net.http_post SÓ ENFILEIRA; timeout_milliseconds EXPLÍCITO (o default de
--    5s mata silencioso — sync.md); a verdade HTTP vive em net._http_response.
-- ------------------------------------------------------------
DO $do$
BEGIN
  PERFORM cron.unschedule('sayerlack-captura-precos-mensal');
EXCEPTION WHEN OTHERS THEN NULL;  -- idempotente: ignora se o job ainda não existe
END
$do$;

SELECT cron.schedule(
  'sayerlack-captura-precos-mensal',
  '0 9 10-12 * *',
  $job$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sayerlack-captura-precos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := '{"modo":"full","empresa":"oben"}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);

-- ------------------------------------------------------------
-- 3) Janela de stale da tela: 24h → 960h (40 dias)
--    Guard "value = '24'": se o founder já ajustou o valor manualmente para
--    outra coisa, re-colar esta migration NÃO sobrescreve a decisão dele.
-- ------------------------------------------------------------
UPDATE public.company_config
SET value = '960', updated_at = now()
WHERE key = 'embalagem_preco_stale_horas'
  AND value = '24';
