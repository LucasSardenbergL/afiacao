-- Portal Sayerlack, pontos cegos, Onda 1 (plano 2026-11-06, itens 1.1 a 1.3).
--
-- Alíquota de IPI por NCM MEDIDA nas NFs de entrada Sayerlack já gravadas em nfe_recebimento_itens.
-- Prova por linha: valor_total do item = round2(quantidade_nfe × valor_unitario) + IPI, então
-- alíquota = (valor_total − vProd) ÷ vProd. O método reproduz os NCMs já semeados com fonte 'nf'
-- (NF 000953881: 38140090 350,74 → 373,54 = 6,5%; 32081020 696,69 → 719,33 = 3,25%).
--
--   29209090  0%    NFs 000954782 (09/10/2026) e 000954853 (13/10/2026), 0,9 QT × 22,40: vProd 20,16 = total 20,16
--   32041920  0%    NFs 000955263, 000956299, 000956681, 000957061 (15 a 27/10/2026), 5 linhas, a maior de
--                   vProd 476,20 = total 476,20 (6,5% daria 30,95 e 3,25% daria 15,48)
--   32110000  6,5%  NFs 000954165 (06/10/2026) e 000954380 (07/10/2026), 0,225 × 55,5556: vProd 12,50 →
--                   total 13,31 = round2(12,50 × 6,5%) = 0,81 (3,25% daria 0,41)
--
-- Os outros 5 NCMs do plano (27101230 32091010 32099020 32159000 39095012) não aparecem em nenhuma NF
-- gravada: não entram aqui (ausente ≠ zero). A importação continua recusando com CP006 até que a
-- alíquota seja informada.
--
-- Idempotente: ON CONFLICT DO NOTHING. Postcondição: as 3 linhas existem com EXATAMENTE estes valores (uma
-- linha anterior com outro valor faria o DO NOTHING esconder a divergência, então ela aborta) e nenhum
-- SKU destes NCMs no de-para Sayerlack ativo fica sem alíquota.
-- Sem BEGIN/COMMIT: a transação é do executor (db:aplicar).

INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES
  ('29209090', 0,   'nf', 'NFs 000954782 (09/10/2026) e 000954853 (13/10/2026) Renner Sayerlack, nfe_recebimento_itens: vProd 20,16 = valor_total 20,16 (DPA.1505QT/PRD00813)', '2026-11-07'),
  ('32041920', 0,   'nf', 'NFs 000955263, 000956299, 000956681, 000957061 (15 a 27/10/2026) Renner Sayerlack, nfe_recebimento_itens: 5 linhas com valor_total = vProd, a maior 476,20 (PRD00338)', '2026-11-07'),
  ('32110000', 6.5, 'nf', 'NFs 000954165 (06/10/2026) e 000954380 (07/10/2026) Renner Sayerlack, nfe_recebimento_itens: vProd 12,50 → valor_total 13,31 = IPI 0,81 (PA.2988L2/PRD00686)', '2026-11-07')
ON CONFLICT (ncm) DO NOTHING;

DO $post$
DECLARE
  v_ok   int;
  v_sem  int;
BEGIN
  SELECT count(*) INTO v_ok
    FROM public.ipi_aliquota_ncm
   WHERE (ncm, aliquota_pct) IN (('29209090', 0::numeric), ('32041920', 0::numeric), ('32110000', 6.5::numeric));
  IF v_ok <> 3 THEN
    RAISE EXCEPTION 'postcondicao: esperava 3 NCMs com a aliquota medida, achei % (linha anterior com outro valor?)', v_ok;
  END IF;

  SELECT count(*) INTO v_sem
    FROM public.sku_fornecedor_externo s
    JOIN public.omie_products op
      ON op.omie_codigo_produto::text = s.sku_omie AND op.account = lower(s.empresa)
    LEFT JOIN public.ipi_aliquota_ncm a ON a.ncm = regexp_replace(op.ncm, '[^0-9]', '', 'g')
   WHERE s.ativo
     AND s.fornecedor_nome ILIKE '%sayer%'
     AND regexp_replace(op.ncm, '[^0-9]', '', 'g') IN ('29209090', '32041920', '32110000')
     AND a.ncm IS NULL;
  IF v_sem <> 0 THEN
    RAISE EXCEPTION 'postcondicao: % SKU(s) Sayerlack ativos destes NCMs ainda sem aliquota', v_sem;
  END IF;

  RAISE NOTICE 'POSTCONDICAO_OK ipi_aliquota_ncm onda1: 3 NCMs';
END
$post$;
