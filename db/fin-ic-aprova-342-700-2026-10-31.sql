-- Aprova (manual_matched) os pares IC oben→colacor de R$ 342,00 (2026-03-16) e R$ 700,00 (2026-06-18).
-- O founder os marcou "Ignorar" (desconsiderado) às 17:38Z de 2026-10-31, antes de corrigir no Omie a
-- categoria do CP da colacor de 2.09.05 para 2.01.01 (sync 18:12Z, DRE recalculado 18:16Z). Ele
-- confirmou no chat que o "Ignorar" foi engano e pediu a aprovação. A tela não desfaz linha ignorada.
-- Mantém resolvido_por (o founder); só troca status, resolvido_em e observacao.
-- ANTES (psql-ro, 2026-10-31):
--   513d55d2-b931-4991-936d-582ae9d7ea01 | desconsiderado | 700.00/700.00 | por 414a9727-ad1d-4998-914e-9c6ccf26cf50 | 2026-10-31 17:38:25.336+00 | obs NULL
--   b3361a80-85d1-472e-8799-541f85385c1a | desconsiderado | 342.00/342.00 | por 414a9727-ad1d-4998-914e-9c6ccf26cf50 | 2026-10-31 17:38:29.073+00 | obs NULL
DO $aprova$
DECLARE
  n integer;
BEGIN
  UPDATE public.fin_ic_matches
     SET status = 'manual_matched',
         resolvido_em = now(),
         observacao = 'aprovado a pedido do founder em 2026-10-31: o Ignorar das 17:38Z foi engano (CP recategorizado para 2.01.01)'
   WHERE id IN ('513d55d2-b931-4991-936d-582ae9d7ea01', 'b3361a80-85d1-472e-8799-541f85385c1a')
     AND status = 'desconsiderado'
     AND resolvido_por = '414a9727-ad1d-4998-914e-9c6ccf26cf50'
     AND cr_id IS NOT NULL AND cp_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN
    RAISE EXCEPTION 'APROVACAO_ESPERAVA_2_LINHAS: %', n;
  END IF;
END
$aprova$;
