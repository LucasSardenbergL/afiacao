-- ============================================================
-- MÓDULO FINANCEIRO: Sync automático via pg_cron + pg_net
-- Executa sync diário de dados financeiros do Omie
-- 
-- PRÉ-REQUISITOS:
--   1. Habilitar pg_cron no Supabase Dashboard (Database → Extensions)
--   2. Habilitar pg_net no Supabase Dashboard (Database → Extensions)
--   3. Configurar as env vars OMIE_*_APP_KEY/SECRET nas Edge Functions
-- ============================================================

-- Função helper que chama a edge function via pg_net
CREATE OR REPLACE FUNCTION fin_trigger_sync(
  p_action text DEFAULT 'sync_all',
  p_companies text[] DEFAULT ARRAY['oben','colacor','colacor_sc']
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url text;
  v_anon_key text;
  v_payload jsonb;
BEGIN
  -- Pegar URL e anon key do Supabase
  v_url := current_setting('app.settings.supabase_url', true);
  v_anon_key := current_setting('app.settings.supabase_anon_key', true);
  
  -- Fallback: usar variáveis do vault ou hardcoded (configurar no Dashboard)
  IF v_url IS NULL THEN
    -- Usar a URL do projeto Supabase diretamente
    -- IMPORTANTE: Substituir pelo URL real do projeto
    v_url := coalesce(
      current_setting('supabase.url', true),
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1)
    );
  END IF;
  
  IF v_anon_key IS NULL THEN
    v_anon_key := coalesce(
      current_setting('supabase.anon_key', true),
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_service_role_key' LIMIT 1)
    );
  END IF;

  IF v_url IS NULL OR v_anon_key IS NULL THEN
    RAISE WARNING '[fin_trigger_sync] URL ou chave não configuradas. Configure via vault secrets.';
    RETURN;
  END IF;

  v_payload := jsonb_build_object(
    'action', p_action,
    'companies', to_jsonb(p_companies)
  );

  -- Chamar edge function via pg_net
  PERFORM net.http_post(
    url := v_url || '/functions/v1/omie-financeiro',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon_key
    ),
    body := v_payload
  );

  RAISE NOTICE '[fin_trigger_sync] Sync disparado: % para %', p_action, p_companies;
END;
$$;

-- Tabela de log de syncs para acompanhamento
CREATE TABLE IF NOT EXISTS fin_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  companies text[],
  status text DEFAULT 'triggered' CHECK (status IN ('triggered','running','complete','error')),
  results jsonb DEFAULT '{}',
  triggered_by text DEFAULT 'cron',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  error_message text
);

CREATE INDEX idx_fin_sync_log_started ON fin_sync_log(started_at DESC);

-- RLS
ALTER TABLE fin_sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fin_sync_log_select" ON fin_sync_log FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);
CREATE POLICY "fin_sync_log_service" ON fin_sync_log FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- CONFIGURAÇÃO DO CRON (executar manualmente no SQL Editor)
-- ============================================================
-- 
-- Após habilitar pg_cron no Dashboard, execute:
--
-- -- Sync diário às 6h (horário de Brasília = 9h UTC)
-- SELECT cron.schedule(
--   'fin-sync-diario',
--   '0 9 * * 1-6',  -- Seg a Sáb às 9h UTC (6h BRT)
--   $$SELECT fin_trigger_sync('sync_all')$$
-- );
--
-- -- Recalcular DRE do mês atual toda segunda às 7h BRT
-- SELECT cron.schedule(
--   'fin-dre-semanal',
--   '0 10 * * 1',  -- Segunda 10h UTC (7h BRT)
--   $$SELECT fin_trigger_sync('calcular_dre', ARRAY['oben','colacor','colacor_sc'])$$
-- );
--
-- -- Verificar crons ativos:
-- SELECT * FROM cron.job;
--
-- -- Remover um cron:
-- SELECT cron.unschedule('fin-sync-diario');
-- ============================================================
