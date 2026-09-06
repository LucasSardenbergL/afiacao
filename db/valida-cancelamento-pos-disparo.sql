-- Validação pós-apply de 20260906152235_cancelamento_pos_disparo_trigger_e_rpc.sql
-- Read-only. O marcador `[APLICADA]`/`[NAO-APLICADA]` e ASCII de caixa fixa DE PROPOSITO:
-- e o que o harness casa, sem depender de acento/emoji sobreviverem a um copiar-colar. Sabe dizer "NÃO APLICADA" antes do Run — uma validação que só sabe dizer "✅"
-- não valida nada. Falsificada nos dois sentidos em db/test-cancelamento-pos-disparo.sh (grupo V).
WITH eixos AS (
  SELECT
    EXISTS (SELECT 1 FROM pg_trigger t
             WHERE t.tgrelid='public.pedido_compra_sugerido'::regclass
               AND t.tgname='trg_valida_cancelamento_pos_disparo'
               AND NOT t.tgisinternal AND t.tgenabled='O')                       AS trigger_armado,
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='corrigir_cancelamento_pos_disparo'
               AND p.prosecdef)                                                  AS rpc_definer,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='pedido_compra_sugerido'
        AND column_name LIKE 'cancelamento_pos_disparo_%')                       AS n_colunas,
    EXISTS (SELECT 1 FROM pg_class
             WHERE relname='reposicao_cancelamento_pos_disparo_audit'
               AND relnamespace='public'::regnamespace AND relrowsecurity)       AS trilha_com_rls,
    EXISTS (SELECT 1 FROM pg_class
             WHERE relname='vw_cancelamento_pos_disparo_sem_evidencia'
               AND relnamespace='public'::regnamespace
               AND reloptions::text LIKE '%security_invoker=%on%')               AS view_invoker
)
SELECT
  CASE WHEN trigger_armado AND rpc_definer AND n_colunas = 4 AND trilha_com_rls AND view_invoker
       THEN '[APLICADA] ✅ — trigger armado, RPC DEFINER, 4 colunas de evidência, trilha com RLS, view security_invoker'
       ELSE '[NAO-APLICADA] ❌ (ou incompleta) — '
            || CASE WHEN NOT trigger_armado THEN 'trigger ausente/desabilitado; '   ELSE '' END
            || CASE WHEN NOT rpc_definer    THEN 'RPC ausente ou não-DEFINER; '     ELSE '' END
            || CASE WHEN n_colunas <> 4     THEN 'colunas de evidência: '||n_colunas||'/4; ' ELSE '' END
            || CASE WHEN NOT trilha_com_rls THEN 'trilha ausente ou sem RLS; '      ELSE '' END
            || CASE WHEN NOT view_invoker   THEN 'view ausente ou sem security_invoker; ' ELSE '' END
  END AS status
FROM eixos;
