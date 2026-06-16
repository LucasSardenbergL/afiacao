-- ============================================================================
-- Infra fora do schema `public` — complemento do schema-snapshot.sql
-- ============================================================================
-- O schema-snapshot.sql (--schema=public) NÃO cobre objetos que vivem fora de
-- public mas são necessários pra um rebuild FUNCIONAL. Este arquivo captura os
-- env-AGNÓSTICOS (buckets + realtime publication). Os env-ESPECÍFICOS (crons
-- com URL/secrets, extensions de plataforma, secret CRON_SECRET) ficam no
-- schema-rebuild-runbook.md. Idempotente. NÃO aplicar em prod existente.
-- Rodar DEPOIS do prelude + snapshot, num projeto Supabase NOVO. Capturado de
-- produção (fzvklzpomgnyikkfkzai) em 2026-05-24.
-- ============================================================================

-- Storage buckets (6) ---------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('aumentos','aumentos',false,NULL,NULL),
  ('avatars','avatars',true,2097152,ARRAY['image/jpeg','image/png','image/webp']),
  ('knowledge-base','knowledge-base',false,NULL,NULL),
  ('portal_screenshots','portal_screenshots',false,5242880,ARRAY['image/png','image/jpeg']),
  ('promocoes','promocoes',false,NULL,NULL),
  ('tool-photos','tool-photos',true,5242880,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Realtime publication (10 tabelas; idempotente; respeita FOR ALL TABLES) ------
DO $infra$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  IF NOT (SELECT puballtables FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['eventos_outlier','farmer_calls','nfe_recebimentos','order_messages',
      'orders','pedido_compra_sugerido','picking_tasks','sales_orders','sku_parametros','tint_importacoes']
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_rel pr
          JOIN pg_publication p ON p.oid = pr.prpubid
          JOIN pg_class c ON c.oid = pr.prrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE p.pubname = 'supabase_realtime' AND n.nspname = 'public' AND c.relname = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $infra$;
