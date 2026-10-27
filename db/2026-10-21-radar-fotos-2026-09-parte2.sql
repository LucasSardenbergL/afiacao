-- Recuperação do lote 2026-09 do Radar, parte 2 de 2 da FOTO RFB (passo (a) de radar_aplicar_situacao).
-- Mesma justificativa e mesmo UPDATE da parte 1 (db/2026-10-21-radar-fotos-2026-09-parte1.sql), na
-- metade de cima da faixa de CNPJ (>= mediana 45403608000103). Re-rodar é no-op.

UPDATE public.radar_empresas re
   SET rfb_situacao = s.situacao, rfb_situacao_data = s.data_situacao, rfb_situacao_lote = s.lote,
       updated_at = now()
  FROM public.radar_situacao_cadastral s
 WHERE s.lote = '2026-09' AND s.cnpj = re.cnpj AND s.cnpj >= '45403608000103'
   AND (re.rfb_situacao_lote IS NULL OR re.rfb_situacao_lote <= '2026-09')
   AND (re.rfb_situacao IS DISTINCT FROM s.situacao
        OR re.rfb_situacao_data IS DISTINCT FROM s.data_situacao
        OR re.rfb_situacao_lote IS DISTINCT FROM s.lote);

DO $post$
DECLARE v_sem bigint;
BEGIN
  SELECT count(*) INTO v_sem
    FROM public.radar_situacao_cadastral s JOIN public.radar_empresas re ON re.cnpj = s.cnpj
   WHERE s.lote = '2026-09' AND s.cnpj >= '45403608000103'
     AND (re.rfb_situacao_lote IS DISTINCT FROM '2026-09' OR re.rfb_situacao IS DISTINCT FROM s.situacao
          OR re.rfb_situacao_data IS DISTINCT FROM s.data_situacao);
  IF v_sem IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'POST: % empresas da parte 2 sem a foto RFB 2026-09', v_sem;
  END IF;
  RAISE NOTICE 'FOTOS_PARTE_2_OK';
END $post$;
