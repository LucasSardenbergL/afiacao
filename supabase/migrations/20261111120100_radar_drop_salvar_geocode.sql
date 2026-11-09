-- ============================================================
-- Radar — pacote N, item 6: drop de public.radar_salvar_geocode (peso morto).
--
-- Escritor SECURITY DEFINER de lat/lng/geocode_status em radar_empresas, criado para o geocoding progressivo do
-- roteirizador (20260613230000, #812/#871). O chamador do front saiu em #884 (geocoding por CEP distinto, outro
-- caminho) e nada mais o chama. Conferido em 2026-11-09:
--   - repo: 0 chamadas em src/ e supabase/functions/ (git grep em origin/main; só testes db/ e auditorias);
--   - PROD (psql-ro): nenhuma função, view, trigger ou cron.job cita o nome; pg_depend sem dependente;
--   - PROD: geocode_status IS NULL e geocoded_em IS NULL nas 573.021 linhas — nunca gravou nada.
-- As colunas lat/lng/geocode_status/geocoded_em FICAM (radar_prospects_para_rota as lê; dropar coluna é outra
-- decisão). radar_rfb_descricao NÃO entra: a função que aplica a situação cadastral a chama (prosrc em PROD).
--
-- DDL destrutivo: aplicação do founder no SQL Editor (fora do envelope da sessão). Idempotente: DROP IF EXISTS.
-- ============================================================
BEGIN;

DROP FUNCTION IF EXISTS public.radar_salvar_geocode(text, double precision, double precision, text);

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'radar_salvar_geocode') THEN
    RAISE EXCEPTION 'N6 FALHOU: public.radar_salvar_geocode ainda existe (outra assinatura?) — o escritor morto segue exposto ao authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'radar_prospects_para_rota') THEN
    RAISE EXCEPTION 'N6 FALHOU: radar_prospects_para_rota sumiu — o drop não deveria tocar a leitura do roteirizador';
  END IF;
  RAISE NOTICE 'N6 OK: radar_salvar_geocode removida; radar_prospects_para_rota intacta';
END
$post$;

COMMIT;
