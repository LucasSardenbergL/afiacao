-- #5 (auditoria 2026-06-04): catálogo tint legível por qualquer autenticado (defesa em profundidade).
--
-- tint_formulas / tint_skus tinham SELECT "Authenticated can view ... USING(true)" → qualquer
-- cliente logado lia o catálogo inteiro de cores + preço final + estrutura de SKU via PostgREST
-- (scraping de catálogo). A receita sensível (custo/margem via tint_formula_itens) JÁ está fechada
-- (RPC get_tint_price, #384); aqui é o catálogo em si.
--
-- Consumidores confirmados TODOS staff:
--   - useTintColorSelect (picker de cor): abre só ao adicionar produto tintométrico base, que só
--     existe no modo STAFF do wizard (Novo Pedido com abas de produto). O modo CLIENTE é Ordem de
--     Serviço de afiação (sem abas de produto) → nunca lê tint_formulas/tint_skus.
--   - useDirectTintImport, useTintometricoZone, TintCatalogo (staff/gated #1), useGlobalSearch (isStaff).
-- Logo, basta remover o SELECT aberto: o staff mantém leitura pela policy "Staff can manage *"
-- (FOR ALL, master/employee); o cliente passa a NÃO ter policy de SELECT → negado (fail-closed).

DROP POLICY IF EXISTS "Authenticated can view tint_formulas" ON public.tint_formulas;
DROP POLICY IF EXISTS "Authenticated can view tint_skus" ON public.tint_skus;
