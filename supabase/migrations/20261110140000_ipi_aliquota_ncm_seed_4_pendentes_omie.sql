-- Alíquota de IPI dos 4 últimos NCMs Sayerlack sem cadastro (2026-11-08) — seed idempotente.
--
-- Eram os 4 que o sensor da Onda 1 ainda acusava depois de 20261109130000 (39073022, 49111090, 29163990, 32071090).
-- A prova vem do Omie OBEN, `produtos/recebimentonfe/ConsultarRecebimento`, varrendo TODOS os 1.223 recebimentos
-- (835 da RENNER SAYERLACK S/A, CNPJ 61.142.865/0006-91, nov/2023 → out/2026). Por item: cNCM, CST do IPI
-- (`itensIPI.cSitTribIPI`), nAliqIPI, nBCIPI, nValIPI. Só leitura; conferido linha a linha.
--   39073022 = 3,25% — CST 50: NF 000923122 (21/01/2026, KB.7820.00FG) vIPI 1,52 ÷ vBC 46,82; idem 000897969
--                      (30/06/2025, 1,53 ÷ 47,10) e 000838822 (15/03/2024, 1,35 ÷ 41,83). 3 de 3 NFs a 3,25%.
--   49111090 = 0%    — CST 51 (tributada, alíquota zero) em 27 linhas de 19 NFs, a última 000954165 (06/10/2026,
--                      CART.700CC e outras cartelas). Nenhuma linha com outro CST.
--   32071090 = 0%    — CST 51: NFs 000938767 (02/06/2026) e 000885575 (24/03/2025), GG.3842QT.
--   29163990 = 0%    — CST 51: NFs 000928889 (11/03/2026), 000899121 (10/07/2025) e 000831532 (17/01/2024), YG.1045FG.
-- As mesmas NFs trazem itens a 6,5% e 3,25% (CST 50; vTotalIPI > 0 em todas): alíquota zero não é artefato.

INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES
  ('39073022', 3.25, 'nf', 'Omie ConsultarRecebimento NF 000923122 (21/01/2026) Renner Sayerlack: KB.7820.00FG CST 50, vIPI 1,52 / vBC 46,82; idem NFs 000897969 e 000838822', '2026-11-08'),
  ('49111090', 0,    'nf', 'Omie ConsultarRecebimento 19 NFs Renner Sayerlack (nov/2023 a 06/10/2026, a última 000954165): cartelas de cores CST 51 (alíquota zero)', '2026-11-08'),
  ('32071090', 0,    'nf', 'Omie ConsultarRecebimento NFs 000938767 (02/06/2026) e 000885575 (24/03/2025) Renner Sayerlack: GG.3842QT CST 51 (alíquota zero)', '2026-11-08'),
  ('29163990', 0,    'nf', 'Omie ConsultarRecebimento NFs 000928889 (11/03/2026), 000899121 e 000831532 Renner Sayerlack: YG.1045FG CST 51 (alíquota zero)', '2026-11-08')
ON CONFLICT (ncm) DO NOTHING;

DO $post$
DECLARE
  v_ok   int;
  v_sem  int;
BEGIN
  SELECT count(*) INTO v_ok
    FROM public.ipi_aliquota_ncm
   WHERE (ncm, aliquota_pct) IN (('39073022', 3.25::numeric), ('49111090', 0::numeric), ('32071090', 0::numeric),
                                 ('29163990', 0::numeric));
  IF v_ok <> 4 THEN
    RAISE EXCEPTION 'postcondicao: esperava 4 NCMs com a aliquota medida, achei % (linha anterior com outro valor?)', v_ok;
  END IF;

  -- O sensor inteiro (não só estes 4): depois deste seed, nenhum SKU Sayerlack ativo fica sem alíquota.
  SELECT count(*) INTO v_sem
    FROM public.sku_fornecedor_externo s
    JOIN public.omie_products op
      ON op.omie_codigo_produto::text = s.sku_omie AND op.account = lower(s.empresa)
    LEFT JOIN public.ipi_aliquota_ncm a ON a.ncm = regexp_replace(op.ncm, '[^0-9]', '', 'g')
   WHERE s.ativo
     AND s.fornecedor_nome ILIKE '%sayer%'
     AND a.ncm IS NULL;
  IF v_sem <> 0 THEN
    RAISE EXCEPTION 'postcondicao: % SKU(s) Sayerlack ativos ainda sem aliquota', v_sem;
  END IF;

  RAISE NOTICE 'POSTCONDICAO_OK ipi_aliquota_ncm 4 NCMs pendentes; sensor Sayerlack = 0';
END
$post$;
