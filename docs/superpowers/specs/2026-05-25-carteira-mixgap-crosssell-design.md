# Mix/Gap de cross-sell — Design

> **Status:** aprovado no brainstorm (2026-05-25, founder escolheu "regras de associação data-driven"). Codex consult moldou a arquitetura. Próximo: writing-plans.
> **Branch:** `feat/carteira-mixgap` (a partir de `main`).
> **Contexto:** continuação do programa Carteira-Omie (A+B+D shipados). KPI cortado da v1 do Sub-PR D, retomado agora como entrega de valor de produto (backlog técnico drenado).

## Problema
O vendedor não vê **oportunidades de cross-sell** na carteira: quais clientes dele estão sem uma categoria que clientes parecidos compram. Hoje o cross-sell existe (`useCrossSellEngine`) mas é product-level, pesado, varre TODOS os clientes no front, e não vira um KPI/lista acionável por carteira.

## Decisão (founder + codex)
**"Conjunto esperado" = regras de associação data-driven** (`farmer_association_rules`), não âncoras manuais nem cesta de segmento. **Arquitetura = RPC `get_meu_mixgap()` `SECURITY DEFINER`** escopada à carteira do dono (espelha `get_minha_positivacao`), server-side dona da verdade. **NÃO** reusar `useCrossSellEngine` (product-level, broad, client-side, pesado).

## Achado crítico (codex) — taxonomia de categoria
`farmer_association_rules` é **product-level** (`antecedent_product_ids[]` → `consequent_product_ids[]`, support/confidence/lift/sample_size). `farmer_category_conversion.category_id` parece categoria mas o `useCrossSellEngine` o usa como **product_id** — **NÃO** é sinal de categoria confiável. **Chave de categoria correta = `omie_products.familia`** (campo real e populado). `order_items.omie_codigo_produto` → `omie_products.omie_codigo_produto` → `familia`.

## Definição do gap
Unidade = **cliente × família faltante** (rollup pra família evita spam de produto).

Um gap qualifica só se TODOS:
1. Cliente está na **carteira elegível** do dono (`carteira_assignments.owner_user_id = auth.uid()`, `eligible=true`).
2. Cliente **comprou os produtos-antecedente** de uma regra (evidência explícita; rules são product-level).
3. Cliente **não comprou a família-consequente** nos últimos **12 meses** (lookback por `order_items` × `omie_products.familia`).
4. Regra passa por **pisos altos** (acima do engine atual que usa 0.05/1.0): `confidence ≥ 0.15`, `lift ≥ 1.5`, `sample_size ≥ 30` (opcional `support ≥ 0.005`).
5. **1 gap por cliente** (maior evidência), top-N clientes no total.

**Ranking** por força da evidência: `confidence × lift`, desempate por `evidence_count` (nº de regras distintas apontando a mesma família faltante). `farmer_category_conversion` fica **fora da v1** como gate (taxonomia product-level/instável) — futuro: gate por conversão quando a categoria estiver corrigida.

## Arquitetura
- **RPC `get_meu_mixgap()`** (`SECURITY DEFINER`, `search_path=public`, gate staff via `has_role`, sem param):
  1. eleg = carteira elegível do `auth.uid()`.
  2. compras = `order_items` (12m) dos elegíveis → famílias compradas por cliente (via `omie_products`).
  3. regras = `farmer_association_rules` com os pisos altos; unnest antecedent/consequent; map consequent product → `familia`.
  4. gap = pra cada cliente elegível: famílias-consequentes de regras cujos antecedentes ele comprou, MENOS as famílias que ele já compra. Top-1 por cliente, top-N global.
  5. retorna jsonb: `total_com_gap` (KPI) + `lista` [{ customer_user_id, nome, familia_faltante, familias_base, confidence, lift, evidence_count }].
- **Helper puro `src/lib/mixgap/` (TDD):** pisos/qualificação + ranking + montagem do "por quê" (texto). A SQL dá os números crus; o JS rankeia/formata (mesma divisão da positivação).
- **Hook `useMyMixGap()`** chama a RPC + helper.
- **UI:** seção no `FarmerCalls` (junto da positivação) — KPI + lista "Oportunidades de cross-sell" com o "por quê" concreto. Reusa o padrão visual de `ClientesAPositivarCard`.

## "Por quê" (texto da linha)
`Compra {familias_base}; clientes com esse padrão também compram {familia_faltante} — confiança {X}%, lift {Y}, {N} evidências.`

## Anti-vanity (codex)
- Sem UI de recomendação por produto. Sem multi-gap por cliente. Sem persistir recomendações geradas (a menos que o vendedor possa marcar resultado — futuro).
- Campo `evidence_count` pra regra fraca (1 evidência) não parecer igual a evidência repetida.

## Escopo cortado / YAGNI
- Gate por `farmer_category_conversion` (até a taxonomia categoria ser arrumada).
- Cesta de segmento e âncoras manuais (founder escolheu regras de associação).
- Marcar resultado da oportunidade (loop de conversão) — futuro.

## Rollout
1. SQL Editor: migration com a RPC `get_meu_mixgap()`.
2. Frontend (helper+hook+UI) via PR/CI.
3. Validar no app (FarmerCalls do vendedor) + checar os números via SQL.

## Riscos
1. **Produto→família**: mitigado por `omie_products.familia`. Se `familia` tiver buracos (produtos sem família), esses produtos não geram gap (degradação silenciosa aceitável; melhor que categoria errada).
2. **IDs nas regras** ✅ resolvido: `antecedent_product_ids`/`consequent_product_ids` = **`omie_products.id` (uuid como texto)** — rastreado via `useBundleEngine` (`omieToProductId` mapeia `omie_codigo_produto`→`omie_products.id`; `order_items.product_id` é o mesmo uuid). JOIN: `consequent_product_ids → omie_products.id → familia`; "comprou antecedente" = `order_items.product_id IN antecedent_product_ids`. ⚠️ Alguns `order_items.product_id` podem ser NULL (só `omie_codigo_produto`) → no JOIN, usar `oi.product_id = op.id OR (oi.product_id IS NULL AND oi.omie_codigo_produto = op.omie_codigo_produto)`.
3. **Volume**: RPC server-side, escopado à carteira; sem fan-out. Lista capada (top-N).
