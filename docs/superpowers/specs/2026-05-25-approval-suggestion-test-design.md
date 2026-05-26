# Cobertura de teste do `calcApprovalSuggestion` — Design Spec

> **Data:** 2026-05-25
> **Status:** continuação autônoma (Codex #2 na fila de cobertura). Função **pura** de auto-aprovação de compras (`src/lib/reposicao/approvalSuggestion.ts`) sem teste — purchasing é money-adjacent e lógica pura gera testes duráveis.

## Goal

Travar as regras de `calcApprovalSuggestion(item)`: quando o item de sugestão de compra pode ser **auto-aprovado** (`mode:'auto'`) vs precisa de **revisão manual** (`mode:'review'` + razões). Sem mudança de código.

## Regras (do código)

`auto` exige TODAS: `num_skus > 0`; `status` contém `'pendente_aprovacao'` E sem `aprovado_em`/`cancelado_em`; `pedido_anterior_valor > 0`; e variação `|valor_total - anterior|/anterior ≤ 0.3` (`VALUE_DELTA_REVIEW_THRESHOLD`). Qualquer violação → `review` com a razão correspondente; razões acumulam.

## Cenários

1. **Auto (caminho limpo)**: qtd 5, status `pendente_aprovacao`, sem aprovado/cancelado, anterior 100, atual 100 (delta 0) → `{mode:'auto', reasons:[]}`.
2. **Qtd inválida** (0/null) → `review` + "Quantidade sugerida inválida".
3. **Status não-pendente** (ex.: `aprovado_em` setado, ou status `aprovado`) → `review` + "Confiança baixa/média — verificar status".
4. **Primeiro pedido** (anterior 0/null) → `review` + "Primeiro pedido — sem referência histórica".
5. **Delta > 30%** (atual 200, anterior 100 → 100%) → `review` + razão "Valor varia 100.0%".
6. **Boundary delta = 30%** (atual 130, anterior 100 → 0.3, NÃO > 0.3) com resto limpo → `auto` (não dispara a razão de variação).
7. **Acúmulo** (qtd 0 + primeiro pedido) → `review` com ≥2 razões.

## Testing

`src/lib/reposicao/__tests__/approvalSuggestion.test.ts` (vitest, sem mocks — função pura). Suíte verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- Quem consome a sugestão (UI/queries); só a regra pura.
