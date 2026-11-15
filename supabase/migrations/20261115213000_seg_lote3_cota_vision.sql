-- ============================================================
-- seg_lote3_cota_vision — lote 3 do rescan do scanner Lovable Security (2026-11-15)
--
-- Cota de IA da edge promocao-extrair-via-vision. A edge v1.2 passa a consumir
-- `ia_consumir_cota(user, 'promocao-extrair-via-vision')` quando o principal é staff. A RPC é
-- FAIL-CLOSED: sem linha em ia_uso_limite ela nega com 'sem_limite', e a edge devolve erro.
-- Por isso este seed vai ANTES do deploy da edge. Uso medido na PROD (promocao_campanha, até
-- 2026-11-15): pico de 11 extrações por hora e 12 por dia pela UI. O teto fica em 30/h e 100/dia
-- por usuário (folga de ~3x). ON CONFLICT DO NOTHING: se o founder já ajustou, o ajuste vence.
-- ============================================================
BEGIN;

INSERT INTO public.ia_uso_limite (funcao, limite_hora, limite_dia)
VALUES ('promocao-extrair-via-vision', 30, 100)
ON CONFLICT (funcao) DO NOTHING;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ia_uso_limite
                  WHERE funcao = 'promocao-extrair-via-vision' AND limite_hora > 0 AND limite_dia > 0) THEN
    RAISE EXCEPTION 'POST: ia_uso_limite sem a linha promocao-extrair-via-vision';
  END IF;
  RAISE NOTICE 'POST-OK seg_lote3_cota_vision';
END
$post$;

COMMIT;
