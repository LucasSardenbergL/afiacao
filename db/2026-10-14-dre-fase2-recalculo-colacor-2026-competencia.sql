-- RECALCULA o DRE regime COMPETENCIA da colacor, jan–out/2026, com a DRE fase 2 (PR #3063) — 2026-10-14
-- Duas invocações em paralelo (jan–mai, jun–out): ~27 s/mês × 10 passa do teto pós-desconexão (#424).
--
-- PRÉ (conferidas aqui, senão aborta): mapa fase 2 colacor aplicado (24 pares, recibo #441) e a
-- omie-financeiro servida = v1.5 (sonda: DEPLOY CONFIRMADO, recibo #439). Nenhum mês de 2026 da
-- colacor fechado em fin_fechamentos (medido). O gatilho trg_fin_dre_snapshots_contrato_fase2
-- garante que um writer legado não deixaria metadado fase 2 ao lado do resultado.
DO $dre$
DECLARE v_versao text;
BEGIN
  IF (SELECT count(*) FROM public.fin_categoria_dre_mapping WHERE company = 'colacor' AND notas LIKE 'DRE fase 2:%') IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'mapa fase 2 colacor ausente/incompleto — recalcular agora gravaria a classificação antiga';
  END IF;
  SELECT t.versao INTO v_versao FROM (
    SELECT request_id, observado_em, versao FROM public.deploy_atestacoes WHERE edge = 'omie-financeiro'
    UNION ALL
    SELECT request_id, observado_em, versao FROM public.deploy_atestacoes_janela_viva() WHERE edge = 'omie-financeiro'
  ) t ORDER BY t.observado_em DESC, t.request_id DESC LIMIT 1;
  IF v_versao IS DISTINCT FROM 'v1.5-dre-fora-dre-composicao' THEN
    RAISE EXCEPTION 'omie-financeiro servida = % — esperado v1.5-dre-fora-dre-composicao', v_versao;
  END IF;
  PERFORM net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('action', 'calcular_dre', 'company', 'colacor', 'ano', 2026,
                               'meses', jsonb_build_array(1,2,3,4,5), 'regime', 'competencia'),
    timeout_milliseconds := 150000);
  PERFORM net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('action', 'calcular_dre', 'company', 'colacor', 'ano', 2026,
                               'meses', jsonb_build_array(6,7,8,9,10), 'regime', 'competencia'),
    timeout_milliseconds := 150000);
  RAISE NOTICE 'calcular_dre competencia colacor 2026 (1-5 e 6-10) disparado';
END
$dre$;
