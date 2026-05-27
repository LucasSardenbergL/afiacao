-- Fase 3 (final) do hardening da receita tintométrica (spec
-- docs/superpowers/specs/2026-05-27-tint-recipe-hardening-design.md).
-- Fecha o vazamento: remove a policy permissiva `SELECT USING(true) TO authenticated`
-- que deixava QUALQUER usuário logado (incl. `customer`) baixar a base de receitas
-- via GET /rest/v1/tint_formula_itens (corante_id + qtd_ml = as proporções = IP).
--
-- Seguro porque, na ordem do rollout: a RPC `get_tint_price` (Fase 1) já compõe o
-- preço server-side e o front-end (Fase 2, PR #387) já consome a RPC em vez de ler
-- a tabela. A policy "Staff can manage tint_formula_itens" (FOR ALL, staff) que
-- permanece cobre o SELECT do operador (telas TintFormulas/TintPricing + imports);
-- a RPC (SECURITY DEFINER) lê de qualquer forma. Aplicada manualmente no Lovable
-- DEPOIS de confirmar o build do cutover live + paridade de preço (2026-05-27).

DROP POLICY IF EXISTS "Authenticated can view tint_formula_itens" ON public.tint_formula_itens;
