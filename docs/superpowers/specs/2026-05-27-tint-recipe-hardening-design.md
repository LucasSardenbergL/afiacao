# Spec — Proteger a receita de tinta (`tint_formula_itens`) de cliente logado

**Status:** ✅ **CONCLUÍDO (2026-05-27)** — 3 fases entregues e em produção (RPC `get_tint_price` validada por paridade; helper testado `src/lib/tint/compute-price.ts` #384; cutover `useTintPricing`→RPC #387; `DROP POLICY` permissiva em `tint_formula_itens` migration `20260527190000`). Cliente logado não baixa mais a receita via REST; preço e telas de staff intactos. **Decisão de produto (Lucas, 2026-05-27): a receita É segredo a proteger — um cliente logado nunca deve conseguir extrair as proporções de corante.**

**Origem:** grant/RLS audit de 2026-05-27 (ver `supabase/schema-security-report.md` item "A aprofundar"). `tint_formula_itens` tem policy `SELECT USING(true) TO authenticated` → **qualquer logado, incluindo `customer`, pode `GET /rest/v1/tint_formula_itens` e baixar a base inteira de receitas** (corante_id + qtd_ml = a "receita" de matiz). É o IP central de um sistema tintométrico.

**Por que NÃO foi feito junto dos outros fixes:** toca o **caminho de dinheiro** (precificação de tinta custom no wizard de pedido). Exige RPC + refactor + teste do fluxo, não um REVOKE cirúrgico. Codex concordou: classe menor que os furos já corrigidos → passe próprio, com TDD.

---

## ✅ PASSO 0 — RESOLVIDO (2026-05-27): a UI **NÃO** mostra a receita ao cliente

Verificado: `useTintPricing` tem **um único consumidor** (`useTintColorSelect.ts:185`), que usa **só** `pricing.custoCorantes` (agregado, linha 298) + `precoFinal`. **`itensCorantes`/`coranteDescricao`/`qtdMl` não são renderizados em lugar nenhum do `src/`** (grep global vazio fora do hook e dos testes). Logo: **caso "cliente só precisa do preço"** → seguir o design abaixo, sem pré-requisito de UX.

### Passo 1 FEITO (PR helper-tdd): cálculo extraído + testado (oráculo do SQL)
`computeTintPrice` em **`src/lib/tint/compute-price.ts`** (puro, espelha verbatim a lógica que estava inline; 7 testes em `__tests__/compute-price.test.ts` cobrindo paridade + edge: sem omie_product_id, volume null/0, omie ausente, corante fantasma, fórmula vazia, mix). `useTintPricing` refatorado pra chamá-lo (comportamento idêntico, agora testado). **Este helper é o oráculo de paridade que o SQL da RPC do Passo 2 deve reproduzir.** Falta: Passo 2 (RPC + RLS, rollout faseado).

---

## ⚠️ PASSO 0 (original — gating): a UI mostra a receita ao cliente?

`useTintPricing` (`src/hooks/useTintPricing.ts`) retorna `TintPriceBreakdown` com **`itensCorantes`** (cada corante: `coranteDescricao` + `qtdMl`) — isto É a receita. É consumido em `src/components/tintColorSelect/useTintColorSelect.ts:185` (`useTintPricing(selectedFormula?.id)`), usado no wizard de pedido (`UnifiedOrder.tsx`, `SalesOrderEdit.tsx`) via `TintColorSelectDialog`.

**Verificar:** o `TintColorSelectDialog` / `useTintColorSelect` **renderiza `pricing.itensCorantes` pro cliente**, ou só usa `pricing.precoFinal`?
- Se **mostra o breakdown de corantes ao cliente** → esconder a receita é primeiro uma decisão de UX (parar de exibir); a RLS sozinha não adianta (o dado já está na tela). Resolver isso antes.
- Se **só usa `precoFinal`** (breakdown é detalhe de staff/operador, ou não renderizado) → seguir direto pro design abaixo.

Grep de partida: `grep -rn "itensCorantes\|\.pricing\b\|breakdown" src/components/tintColorSelect/`.

---

## Design (assumindo Passo 0 = "cliente só precisa do preço")

**Objetivo:** `customer` obtém o **preço** de uma fórmula sem conseguir ler as proporções; **staff** (operador/balcão) continua vendo a receita completa.

1. **RPC `SECURITY DEFINER` `get_tint_price(p_formula_id ...)`** em `public`:
   - Reimplementa a lógica de `useTintPricing` em SQL (lê `tint_formula_itens` + `tint_corantes` + `omie_products` como definer; computa `custoCorantes`/`precoFinal`).
   - **Gate por papel no corpo:** se `is_staff` (master/employee via `has_role`) → retorna `{ precoFinal, itensCorantes[] }` (breakdown completo, pro operador); senão → retorna **só** `{ precoFinal }` (sem `itensCorantes`).
   - `SET search_path = public`. `REVOKE ... FROM PUBLIC` + GRANT EXECUTE a `authenticated` (a RPC é o único caminho do cliente). ⚠️ **Lição do #369:** `REVOKE FROM PUBLIC` não basta — confira/ajuste `anon`/`authenticated` por nome.
2. **Restringir `tint_formula_itens`:** trocar a policy `SELECT USING(true) TO authenticated` por **staff-only** (`has_role(auth.uid(),'master'|'employee')`). A RPC (definer) segue lendo. Idem avaliar `tint_corantes`/`tint_formulas` — provavelmente OK manter (a receita = as PROPORÇÕES em `formula_itens`; a paleta de corantes e o header de fórmula são menos sensíveis; decidir caso a caso).
3. **Frontend `useTintPricing`:** trocar as 3 leituras de tabela por **1 chamada à RPC** (`supabase.rpc('get_tint_price', { p_formula_id })`). Manter o tipo `TintPriceBreakdown` (com `itensCorantes` possivelmente vazio pra cliente).

## Arquivos a tocar
- `src/hooks/useTintPricing.ts` — chamar a RPC em vez de ler tabelas.
- (talvez) `src/components/tintColorSelect/useTintColorSelect.ts` / `TintColorSelectDialog.tsx` — se o breakdown for exibido (ver Passo 0).
- migration nova (lovable-db-operator): cria a RPC + troca a policy de `tint_formula_itens`. **Migration manual no Lovable** + validação (a RPC existe; a policy de `tint_formula_itens` não é mais `USING(true)`; cliente via RPC recebe preço sem itens).

## Teste (money-path — obrigatório)
- TDD do cálculo de preço (helper puro espelhando o SQL: `custoPorMl = valor_unitario/volume_total_ml`, `custoItem = qtd_ml*custoPorMl`, soma) — paridade com o `useTintPricing` atual pra **não mudar o preço**.
- Fluxo de pedido: selecionar cor de tinta como **staff** (vê breakdown + preço) e como **customer** (vê só preço, mesmo valor). Confirmar que o pedido fecha com o preço certo.
- Confirmar que `GET /rest/v1/tint_formula_itens` como `customer` passa a retornar **vazio/403** (a receita deixou de vazar) e que a RPC `get_tint_price` ainda devolve o preço.

## Não-objetivos
- Não mexer em `tint_*` que não seja necessário pra fechar o vazamento da receita.
- Não otimizar a precificação — só mover de leitura-de-tabela pra RPC preservando o valor.

## Risco
Médio (money-path). Mitigado por: paridade de preço testada (TDD), gate de staff preservando o operador, e o fato de o único leitor cliente-facing ser o `useTintPricing`.
