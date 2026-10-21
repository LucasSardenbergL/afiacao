-- Recuperação do lote 2026-09 do Radar, parte 1 de 2 da FOTO RFB (passo (a) de radar_aplicar_situacao).
-- Por quê: a recuperação inteira (db/2026-10-21-radar-finalize-2026-09.sql) estourou o statement_timeout
-- de 300s do db:aplicar na tentativa #688 (o ensaio passou em ~4 min, no limite). O passo (a) — ~553k
-- UPDATEs em radar_empresas — é a parte pesada; aqui ele vai em 2 metades por faixa de CNPJ (mediana
-- 45403608000103). É o MESMO UPDATE da função (cópia literal do predicado: nunca regride, só grava
-- quando muda), então re-rodar é no-op e a função, chamada depois pelo finalize, encontra 0 a gravar.
-- Não mexe em prospeccao_status, alerta nem radar_ingest_state — isso fica com o finalize.

UPDATE public.radar_empresas re
   SET rfb_situacao = s.situacao, rfb_situacao_data = s.data_situacao, rfb_situacao_lote = s.lote,
       updated_at = now()
  FROM public.radar_situacao_cadastral s
 WHERE s.lote = '2026-09' AND s.cnpj = re.cnpj AND s.cnpj < '45403608000103'
   AND (re.rfb_situacao_lote IS NULL OR re.rfb_situacao_lote <= '2026-09')
   AND (re.rfb_situacao IS DISTINCT FROM s.situacao
        OR re.rfb_situacao_data IS DISTINCT FROM s.data_situacao
        OR re.rfb_situacao_lote IS DISTINCT FROM s.lote);

DO $post$
DECLARE v_sem bigint;
BEGIN
  SELECT count(*) INTO v_sem
    FROM public.radar_situacao_cadastral s JOIN public.radar_empresas re ON re.cnpj = s.cnpj
   WHERE s.lote = '2026-09' AND s.cnpj < '45403608000103'
     AND (re.rfb_situacao_lote IS DISTINCT FROM '2026-09' OR re.rfb_situacao IS DISTINCT FROM s.situacao
          OR re.rfb_situacao_data IS DISTINCT FROM s.data_situacao);
  IF v_sem <> 0 THEN
    RAISE EXCEPTION 'POST: % empresas da parte 1 sem a foto RFB 2026-09', v_sem;
  END IF;
  RAISE NOTICE 'FOTOS_PARTE_1_OK';
END $post$;
