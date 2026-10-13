-- Validação pós-apply de 20261013094000_fin_movimentacoes_resumo_encargos.sql (read-only).
-- Esperado depois do Run: 13 | t | t | f. Antes do apply: 0 | (vazio) | (vazio) | (vazio).
-- Executada pela prova db/test-fin-encargos-titulo.sh (V1) — o validador também é código.
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fin_movimentacoes'
      AND column_name IN ('resumo_val_pago','resumo_val_liquido','resumo_desconto','resumo_juros',
                          'resumo_multa','resumo_val_aberto','resumo_liquidado','valor_titulo',
                          'tipo_documento','omie_ncodbaixa','data_pagamento_omie','data_credito_omie',
                          'resumo_lido_em'))                                         AS colunas_13,
  (SELECT convalidated FROM pg_constraint
    WHERE conrelid = 'public.fin_movimentacoes'::regclass
      AND conname = 'fin_movimentacoes_resumo_finito')                             AS check_validado,
  (SELECT 'security_invoker=on' = ANY (reloptions) FROM pg_class
    WHERE oid = to_regclass('public.v_titulo_encargos_cr'))                        AS view_invoker,
  has_table_privilege('anon', to_regclass('public.v_titulo_encargos_cr'), 'SELECT') AS anon_le;
