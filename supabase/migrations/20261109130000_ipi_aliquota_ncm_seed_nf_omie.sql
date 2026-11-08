-- Alíquota de IPI dos 5 NCMs Sayerlack que a onda 1 não conseguiu provar (2026-11-08) — seed idempotente.
--
-- A onda 1 (20261107120000) mediu só as ~90 NFs gravadas no banco (desde jan/2026), sem nenhuma linha destes NCMs.
-- Aqui a prova vem do Omie OBEN, `produtos/recebimentonfe/ConsultarRecebimento` (registro da NF-e de entrada
-- importada do XML do fornecedor: por item cNCM, CST do IPI, nAliqIPI, nBCIPI, nValIPI; Σ nValIPI = vTotalIPI em
-- cada NF). Emitente: RENNER SAYERLACK S/A, CNPJ 61.142.865/0006-91, série 7. Só leitura; conferido linha a linha.
--   39095012 = 3,25% — CST 50, vIPI 2,31 ÷ vBC 71,02 (NF 000937352, 21/05/2026, YC.1400FP); idem 000935816 e 000935216.
--   32099020 = 0%    — CST 51 (tributada, alíquota zero): NF 000938767 (02/06/2026) e 000935816 (08/05/2026), YO20.1464.00BB.
--   32091010 = 0%    — CST 51: NF 000923676 (26/01/2026, YTS.1284.254VQT); 257/259VQT na NF 000909541 (29/09/2025).
--   32159000 = 0%    — CST 51: NF 000915792 (12/11/2025, TY.1480.00BB).
--   27101230 = 0%    — CST 51: NF 000909354 (26/09/2025, DS.451LT) — a última entrada desse SKU no Omie.
-- As mesmas NFs trazem itens a 6,5% e 3,25% (CST 50): alíquota zero não é artefato de importação.

INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES
  ('39095012', 3.25, 'nf', 'Omie ConsultarRecebimento NF 000937352 (21/05/2026) Renner Sayerlack: YC.1400FP CST 50, vIPI 2,31 / vBC 71,02; idem NFs 000935816 e 000935216', '2026-11-08'),
  ('32099020', 0,    'nf', 'Omie ConsultarRecebimento NFs 000938767 (02/06/2026) e 000935816 (08/05/2026) Renner Sayerlack: YO20.1464.00BB CST 51 (alíquota zero)', '2026-11-08'),
  ('32091010', 0,    'nf', 'Omie ConsultarRecebimento NFs 000923676 (26/01/2026) e 000909541 (29/09/2025, YTS.1284.257VQT/259VQT) Renner Sayerlack: CST 51', '2026-11-08'),
  ('32159000', 0,    'nf', 'Omie ConsultarRecebimento NF 000915792 (12/11/2025) Renner Sayerlack: TY.1480.00BB CST 51', '2026-11-08'),
  ('27101230', 0,    'nf', 'Omie ConsultarRecebimento NF 000909354 (26/09/2025) Renner Sayerlack: DS.451LT CST 51 (última entrada do SKU no Omie)', '2026-11-08')
ON CONFLICT (ncm) DO NOTHING;

DO $post$
DECLARE
  v_ok   int;
  v_sem  int;
BEGIN
  SELECT count(*) INTO v_ok
    FROM public.ipi_aliquota_ncm
   WHERE (ncm, aliquota_pct) IN (('39095012', 3.25::numeric), ('32099020', 0::numeric), ('32091010', 0::numeric),
                                 ('32159000', 0::numeric), ('27101230', 0::numeric));
  IF v_ok <> 5 THEN
    RAISE EXCEPTION 'postcondicao: esperava 5 NCMs com a aliquota medida, achei % (linha anterior com outro valor?)', v_ok;
  END IF;

  SELECT count(*) INTO v_sem
    FROM public.sku_fornecedor_externo s
    JOIN public.omie_products op
      ON op.omie_codigo_produto::text = s.sku_omie AND op.account = lower(s.empresa)
    LEFT JOIN public.ipi_aliquota_ncm a ON a.ncm = regexp_replace(op.ncm, '[^0-9]', '', 'g')
   WHERE s.ativo
     AND s.fornecedor_nome ILIKE '%sayer%'
     AND regexp_replace(op.ncm, '[^0-9]', '', 'g') IN ('39095012', '32099020', '32091010', '32159000', '27101230')
     AND a.ncm IS NULL;
  IF v_sem <> 0 THEN
    RAISE EXCEPTION 'postcondicao: % SKU(s) Sayerlack ativos destes NCMs ainda sem aliquota', v_sem;
  END IF;

  RAISE NOTICE 'POSTCONDICAO_OK ipi_aliquota_ncm NCMs pendentes: 5 NCMs';
END
$post$;
