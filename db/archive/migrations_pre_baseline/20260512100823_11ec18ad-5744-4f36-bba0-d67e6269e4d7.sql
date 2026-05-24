-- Revoke EXECUTE from authenticated/anon/public on SECURITY DEFINER functions
-- that are only invoked by triggers, cron jobs, or service-role edge functions.

DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'auto_assign_commercial_super_admin',
    'auto_assign_user_role',
    'award_loyalty_points',
    'protect_master_config',
    'registrar_historico_sku_parametros',
    'set_status_envio_portal_on_disparo',
    'detectar_skus_sem_grupo',
    'fin_calcular_confiabilidade',
    'limpar_sugestoes_antigas'
  ];
  sig text;
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    FOR sig IN
      SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fn
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    END LOOP;
  END LOOP;
END $$;