-- ============================================================
-- Import de clientes: a varredura completa passa de SEMANAL a DIÁRIA.
--
-- Por quê (medido na 1ª rodada, 2026-11-01): página sem cliente novo anda a ~40/min, então uma varredura
-- das 3 contas sem novidade custa ~10–15 min de edge e ~535 chamadas ao Omie. Diária faz um cliente
-- novo no Omie virar vínculo em até 24 h, sem clique — mais barato do que um incremental por data, que
-- exigiria medir antes os filtros do ListarClientes (decisão do founder, 2026-11-02).
--
-- O que faz:
--  • CHECK de origem e private.clientes_import_semear_interno aceitam 'cron_diario' ('cron_semanal'
--    continua válido para o histórico).
--  • cron 'clientes-import-diario' às 07:45 UTC (04:45 SP): depois dos syncs Omie das 05:00–07:30 UTC e
--    antes do refresh de não vinculados (08:30 UTC), que assim já lista o retrato pós-varredura.
--  • remove o cron 'clientes-import-semanal'.
-- Molde TRAVA → PRE → CREATE → PÓS (recria função VIVA).
-- ============================================================

SELECT pg_advisory_xact_lock(hashtext('public.clientes_import_rodada'));

-- PRE anti-deriva: a função em prod tem de ser a da 20261101200000 (ou já esta, em re-apply).
DO $pre$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND p.proname = 'clientes_import_semear_interno';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: private.clientes_import_semear_interno ausente — aplique 20261101200000 antes';
  END IF;
  IF v_def NOT LIKE '%NOT IN (''manual'', ''cron_semanal'')%'
     AND v_def NOT LIKE '%NOT IN (''manual'', ''cron_semanal'', ''cron_diario'')%' THEN
    RAISE EXCEPTION 'PRE FALHOU: semear_interno em prod divergiu do repo — confira pg_get_functiondef antes de recriar';
  END IF;
END
$pre$;

ALTER TABLE public.clientes_import_rodada
  DROP CONSTRAINT IF EXISTS clientes_import_rodada_origem_check,
  ADD CONSTRAINT clientes_import_rodada_origem_check
    CHECK (origem IN ('manual', 'cron_semanal', 'cron_diario'));

CREATE OR REPLACE FUNCTION private.clientes_import_semear_interno(p_origem text, p_por uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_row public.clientes_import_rodada;
BEGIN
  IF p_origem IS NULL OR p_origem NOT IN ('manual', 'cron_semanal', 'cron_diario') THEN
    RAISE EXCEPTION 'origem inválida: %', coalesce(p_origem, 'NULL') USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.clientes_import_rodada (origem, solicitado_por)
  VALUES (p_origem, p_por)
  ON CONFLICT ((true)) WHERE concluida_em IS NULL AND falhou_em IS NULL DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('desfecho', 'semeada', 'rodada_id', v_row.id);
  END IF;
  SELECT * INTO v_row FROM public.clientes_import_rodada
   WHERE concluida_em IS NULL AND falhou_em IS NULL;
  RETURN jsonb_build_object('desfecho', 'ja_aberta', 'rodada_id', v_row.id,
                            'conta_slug', v_row.conta_slug, 'start_page', v_row.start_page);
END;
$$;
REVOKE ALL ON FUNCTION private.clientes_import_semear_interno(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.clientes_import_semear_interno(text, uuid) TO service_role;

-- Varredura completa diária: 07:45 UTC (04:45 SP). Se já há uma aberta, é no-op.
SELECT cron.schedule('clientes-import-diario', '45 7 * * *', $cmd$
  SELECT private.clientes_import_semear_interno('cron_diario', NULL);
$cmd$);

SELECT cron.unschedule('clientes-import-semanal')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clientes-import-semanal');

-- PÓS
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.clientes_import_rodada'::regclass
                    AND conname = 'clientes_import_rodada_origem_check'
                    AND pg_get_constraintdef(oid) LIKE '%cron_diario%') THEN
    RAISE EXCEPTION 'P1 FALHOU: CHECK de origem sem cron_diario — o cron diário seria recusado';
  END IF;
  IF pg_get_functiondef('private.clientes_import_semear_interno(text,uuid)'::regprocedure) NOT LIKE '%''cron_diario''%' THEN
    RAISE EXCEPTION 'P2 FALHOU: semear_interno não aceita cron_diario';
  END IF;
  IF has_function_privilege('authenticated', 'private.clientes_import_semear_interno(text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.clientes_import_semear_interno(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: semear_interno executável por authenticated/anon';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clientes-import-diario' AND active
                    AND schedule = '45 7 * * *'
                    AND command LIKE '%clientes_import_semear_interno(''cron_diario''%') THEN
    RAISE EXCEPTION 'P4 FALHOU: cron diário ausente, inativo ou com agenda errada';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clientes-import-semanal') THEN
    RAISE EXCEPTION 'P5 FALHOU: cron semanal ainda agendado — seriam 2 escritores de semeadura';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clientes-import-continuacao-1min' AND active) THEN
    RAISE EXCEPTION 'P6 FALHOU: cron de continuação de 1 min sumiu — a rodada semeada nunca andaria';
  END IF;
  RAISE NOTICE 'clientes_import varredura diaria pronta: cron clientes-import-diario 45 7 * * *';
END
$post$;
