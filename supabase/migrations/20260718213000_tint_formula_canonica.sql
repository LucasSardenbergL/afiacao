-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico Fase 2 — fórmula CANÔNICA: elimina a duplicata SL×SAYERLACK
-- no picker SEM apagar/desativar nada (seleção de leitura, reversível).
--
-- Contexto (docs/superpowers/plans/2026-07-17-tint-receita-perdida-remediacao.md §Fase 2):
--   `subcolecao_id` está na unique key de tint_formulas → quando o sync passou a
--   mandar subcoleção `SL` (06/2026) onde o import de março mandava `1`/SAYERLACK,
--   o catálogo inteiro DUPLICOU: 465.419 chaves (account, sku_id, cor_id) com
--   exatamente 2 linhas ativas (1 SL viva + 1 SAYERLACK congelada). A busca do
--   balcão mostrava as 2 como linhas idênticas, com preço divergente por
--   construção (CSV preco_final_sayersystem só existe na SAYERLACK).
--
-- Regra canônica (1 linha por (account, sku_id, cor_id)):
--   rank 0 — SL com receita VÁLIDA (não-vazia + todo corante com custo válido)
--   rank 1 — outra geração (SAYERLACK/personalizada) com receita válida
--   rank 2 — SL inválida (linha viva vence a congelada quando nada vende)
--   rank 3 — resto; desempate final: id ASC (determinismo total)
--
--   "Receita válida" ESPELHA o critério por-fórmula da RPC get_tint_prices
--   (corantes_completos): todo item com corante→omie_products valor>0 + ativo
--   + volume_total_ml>0; conjunto vazio = inválida. [MIRROR get_tint_prices]
--   `base_disponivel` (omie do SKU) fica DELIBERADAMENTE fora do rank: gêmeas
--   compartilham o sku_id por construção da chave — não discrimina, só faria a
--   canônica flipar SL↔SAYERLACK quando o cadastro Omie mudar (medido em prod
--   2026-07-18: 316.605 SL com SKU órfão E receita ok; gêmea igualmente órfã).
--   "Sync recente" também fica fora do rank: updated_at da SL é re-tocado em
--   massa pelo conector (~3-4 dias por ciclo) e uma janela eliminatória faria o
--   catálogo INTEIRO flipar para a geração congelada de 03/2026 N dias após
--   qualquer pane do conector (que está parado desde 17/07). A última verdade
--   conhecida da SL nunca é mais velha que a SAYERLACK congelada; pane de
--   conector é problema de OBSERVABILIDADE (Sentinela), não de seleção.
--
-- Garantias (provadas em db/test-tint-canonica.sh, PG17 + falsificação):
--   • preferência SL quando válida; fallback SAYERLACK quando não há SL válida
--   • NÃO-DESAPARECIMENTO: toda chave ativa com sku segue com exatamente 1 linha
--     (as 12 combinações ACR MAX sem gêmea SL e as 907 personalizadas incluídas)
--   • determinismo: mesma entrada ⇒ mesma saída, sempre
--   • paridade do espelho: receita_valida ∧ base_disponivel ⟺ precoFinal da RPC
--
-- security_invoker=on OBRIGATÓRIO (lição #1375): a view lê como o CALLER e
-- herda a RLS staff-only de tint_formulas/tint_formula_itens/omie_products.
-- Customer autenticado: RLS devolve 0 linhas (picker é de staff — comportamento
-- idêntico ao acesso direto atual). Repetir o WITH em TODO futuro replace.
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
  rf.receita_valida
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
  'security_invoker=on: repetir o WITH em todo replace (#1375).';

-- View nova: default privileges do Supabase concedem a anon/authenticated —
-- revogar anon POR NOME (REVOKE FROM PUBLIC não tira grant explícito).
REVOKE ALL ON public.v_tint_formula_canonica FROM PUBLIC;
REVOKE ALL ON public.v_tint_formula_canonica FROM anon;
REVOKE ALL ON public.v_tint_formula_canonica FROM authenticated;
GRANT SELECT ON public.v_tint_formula_canonica TO authenticated;
GRANT SELECT ON public.v_tint_formula_canonica TO service_role;

-- O PostgREST só enxerga a view nova após recarregar o schema cache
-- (no PG local do harness é um no-op — canal sem listener).
NOTIFY pgrst, 'reload schema';
