-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — fix SEMÂNTICO de `preco_csv_legado` (opção 2 do P1 B do
-- parecer Codex xhigh sobre o #1439; decisão do founder 2026-07-20).
--
-- O problema que fecha: a expressão da Fase 2b (20260718233000) é
-- max(preco_final_sayersystem) sobre TODAS as linhas ativas da chave
-- (account, sku_id, cor_id) — o que INCLUI a própria linha canônica. Hoje
-- funciona porque a geração SL tem preco_final_sayersystem NULL em 100%
-- (medido 2026-07-18; re-medido 2026-07-20: 0 linhas SL ativas com CSV):
-- quando a canônica é SL, o max vem na prática da gêmea SAYERLACK — a
-- "versão anterior da tinta". O RISCO era latente: se o sync um dia popular
-- o campo na geração SL, o max passaria a incluir a própria SL e a fonte
-- "Tabela importada" do balcão deixaria de significar "preço da versão
-- anterior" — sem ninguém perceber (o rótulo neutro do #1458 mitigou a UI;
-- este fix fecha a SEMÂNTICA na origem).
--
-- Regra nova (só o ramo SL muda):
--   • canônica SL     → max SÓ entre linhas não-SL ativas da chave
--                       (o CSV próprio da SL — e de qualquer outra SL — fica FORA)
--   • canônica não-SL → comportamento ATUAL intacto (max de todas as ativas,
--                       inclusive uma SL com CSV, se um dia existir)
--   • sem CSV elegível na chave → NULL (fonte "tabela" não aparece no balcão)
--
-- Baseline pré-apply (psql-ro, 2026-07-20): 0 linhas SL ativas com
-- preco_final_sayersystem NOT NULL ⇒ o delta é NO-OP no dado atual —
-- nenhuma chave muda de valor hoje; é blindagem future-proof pura.
--
-- REPLACE: ordem das 13 colunas PRESERVADA (só a EXPRESSÃO da 13ª muda) e
-- WITH (security_invoker = on) REPETIDO (omitir RESETA a opção e a view
-- passa a bypassar RLS — armadilha #1375).
-- Prova: db/test-tint-canonica.sh (aplica as 3 migrations na ordem de prod;
-- C14 = future-proof SL com CSV próprio ignorado; C15 = ramo não-SL intacto;
-- falsificações F6/F7 dirigidas à expressão nova).
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
  -- CSV da "versão anterior da tinta": canônica SL → só linhas não-SL contam
  -- (o CSV próprio da SL nunca entra); canônica não-SL → max de todas as
  -- ativas (comportamento da 20260718233000, preservado verbatim).
  (SELECT max(g2.preco_final_sayersystem)
     FROM public.tint_formulas g2
    WHERE g2.account = f.account
      AND g2.sku_id  = f.sku_id
      AND g2.cor_id  = f.cor_id
      AND g2.desativada_em IS NULL
      AND (NOT rf.is_sl
           OR NOT EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                          WHERE s2.id = g2.subcolecao_id
                            AND s2.account = g2.account
                            AND s2.id_subcolecao_sayersystem = 'SL'))) AS preco_csv_legado
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
  'Fase 2b (semântica fixada 2026-07-20): preco_csv_legado = max CSV das linhas '
  'ativas da chave; quando a canônica é SL, só linhas NÃO-SL contam — o CSV '
  'próprio da SL nunca entra (a fonte "Tabela" é sempre a versão anterior). '
  'security_invoker=on: repetir o WITH em todo replace (#1375).';

-- Grants inalterados (REPLACE preserva ACL); re-afirmados por idempotência do bloco.
REVOKE ALL ON public.v_tint_formula_canonica FROM PUBLIC;
REVOKE ALL ON public.v_tint_formula_canonica FROM anon;
GRANT SELECT ON public.v_tint_formula_canonica TO authenticated;
GRANT SELECT ON public.v_tint_formula_canonica TO service_role;

-- Sem coluna nova (só a expressão muda), mas o reload é barato e mantém o padrão
NOTIFY pgrst, 'reload schema';
