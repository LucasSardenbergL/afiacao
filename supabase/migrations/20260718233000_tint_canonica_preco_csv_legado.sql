-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico Fase 2b — `preco_csv_legado`: devolve ao balcão a ESCOLHA da
-- vendedora entre o preço NOVO (cálculo da receita viva SL) e o preço da
-- VERSÃO ANTERIOR da tinta (CSV importado da geração SAYERLACK congelada).
--
-- Pedido do founder (2026-07-18, pós-apply da Fase 2): "na hora que tirasse o
-- pedido, que a vendedora escolhesse se vai ser o preço novo ou o preço de
-- versões antigas da tinta, mesmo a cor tendo sido atualizada."
--
-- Como: a canônica passa a expor `preco_csv_legado` = MAX(preco_final_
-- sayersystem) entre as linhas ATIVAS da mesma chave (account, sku_id, cor_id).
--   • canônica = SL (CSV próprio NULL) → vem o CSV da gêmea SAYERLACK antiga
--   • canônica = SAYERLACK (fallback)  → vem o próprio CSV
--   • chave sem CSV nenhum             → NULL (fonte "tabela" não aparece)
-- O front alimenta `selectTintPrice` com esta coluna: a fonte "Tabela" volta a
-- existir ao lado de "Calculado" no seletor do balcão, o default segue a regra
-- conservadora já provada (usa o MAIOR; nunca baixa silenciosamente) e BAIXAR
-- para o preço novo menor é escolha ATIVA da vendedora no seletor.
-- Só linhas ATIVAS alimentam o max — quando a Fase 5 desativar a geração
-- antiga (gate humano), o destino desta fonte é decisão explícita de lá.
--
-- REPLACE da view da Fase 2 (20260718213000): coluna nova SOMENTE NO FIM
-- (ordem das 12 anteriores preservada — regra do repo para REPLACE de view) e
-- o WITH (security_invoker = on) REPETIDO (omitir RESETA e vaza RLS — #1375).
-- Prova: db/test-tint-canonica.sh (aplica Fase 2 + 2b na ordem de prod;
-- C13 cobre os três casos acima; falsificação F5 exige o CSV da GÊMEA).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_tint_formula_canonica
WITH (security_invoker = on)
AS
SELECT
  f.id,
  f.account,
  f.sku_id,
  f.cor_id,
  f.nome_cor,
  f.preco_final_sayersystem,
  f.subcolecao_id,
  f.personalizada,
  f.updated_at,
  rf.is_sl,
  rf.tem_receita,
  rf.receita_valida,
  -- Fase 2b: CSV da chave (a "versão anterior da tinta" quando a canônica é SL)
  (SELECT max(g2.preco_final_sayersystem)
     FROM public.tint_formulas g2
    WHERE g2.account = f.account
      AND g2.sku_id  = f.sku_id
      AND g2.cor_id  = f.cor_id
      AND g2.desativada_em IS NULL) AS preco_csv_legado
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  -- rank de preferência da PRÓPRIA linha (bloco gêmeo do rank da gêmea, abaixo)
  SELECT v.is_sl,
         v.tem_receita,
         (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (
    SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s
              WHERE s.id = f.subcolecao_id
                AND s.account = f.account
                AND s.id_subcolecao_sayersystem = 'SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi
              WHERE fi.formula_id = f.id) AS tem_receita,
      -- [MIRROR get_tint_prices.corantes_completos] todo item precisa de corante
      -- com omie valor>0 + ativo + volume>0; item órfão de corante conta como ruim.
      NOT EXISTS (
        SELECT 1
        FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c  ON c.id = fi.corante_id
        LEFT JOIN public.omie_products op ON op.id = c.omie_product_id
        WHERE fi.formula_id = f.id
          AND NOT (COALESCE(op.valor_unitario, 0) > 0
                   AND COALESCE(op.ativo, false)
                   AND c.volume_total_ml IS NOT NULL
                   AND c.volume_total_ml > 0)
      ) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL
  AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    -- existe gêmea MELHOR na mesma chave? (rank menor; empate → menor id vence)
    SELECT 1
    FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      -- rank de preferência da GÊMEA — bloco gêmeo verbatim do rank acima
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (
        SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s
                  WHERE s.id = g.subcolecao_id
                    AND s.account = g.account
                    AND s.id_subcolecao_sayersystem = 'SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi
                  WHERE fi.formula_id = g.id) AS tem_receita,
          NOT EXISTS (
            SELECT 1
            FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c  ON c.id = fi.corante_id
            LEFT JOIN public.omie_products op ON op.id = c.omie_product_id
            WHERE fi.formula_id = g.id
              AND NOT (COALESCE(op.valor_unitario, 0) > 0
                       AND COALESCE(op.ativo, false)
                       AND c.volume_total_ml IS NOT NULL
                       AND c.volume_total_ml > 0)
          ) AS corantes_ok
      ) w
    ) rg
    WHERE g.account = f.account
      AND g.sku_id  = f.sku_id
      AND g.cor_id  = f.cor_id
      AND g.desativada_em IS NULL
      AND g.id <> f.id
      AND (rg.rank_pref < rf.rank_pref
           OR (rg.rank_pref = rf.rank_pref AND g.id < f.id))
  );

COMMENT ON VIEW public.v_tint_formula_canonica IS
  'Fase 2 tintométrico: 1 fórmula canônica por (account, sku_id, cor_id) — '
  'preferência SL válida, fallback SAYERLACK/personalizada; não desativa nada. '
  'receita_valida espelha corantes_completos da RPC get_tint_prices (validade '
  'POR FÓRMULA; base_disponivel fica fora — gêmeas compartilham o SKU). '
  'Fase 2b: preco_csv_legado = max CSV das linhas ativas da chave — devolve a '
  'fonte "Tabela" (versão anterior da tinta) ao seletor da vendedora. '
  'security_invoker=on: repetir o WITH em todo replace (#1375).';

-- Grants inalterados (REPLACE preserva ACL); re-afirmados por idempotência do bloco.
REVOKE ALL ON public.v_tint_formula_canonica FROM PUBLIC;
REVOKE ALL ON public.v_tint_formula_canonica FROM anon;
GRANT SELECT ON public.v_tint_formula_canonica TO authenticated;
GRANT SELECT ON public.v_tint_formula_canonica TO service_role;

-- Coluna nova precisa do schema cache recarregado no PostgREST
NOTIFY pgrst, 'reload schema';
