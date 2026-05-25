# Cobertura de teste dos helpers de `sku-param.ts` — Design Spec

> **Data:** 2026-05-25
> **Status:** continuação autônoma (Codex #3 na fila de cobertura). Helpers **puros** de apresentação extraídos do god-component da Reposição (`src/lib/reposicao/sku-param.ts`) sem teste. Dirigem o que o **comprador** lê na tela (badge de fonte de preço, classe ABC, valores BRL) — barato de travar, regressão silenciosa se mudar.

## Goal

Travar o comportamento dos 5 helpers puros de `sku-param.ts`. Sem mudança de código.

## Regras (do código)

- **`fonteBadgeVariant(fonte)`** → `'success'|'warning'|'danger'|'outline'`. Ordem importa: null/vazio → `danger`; contém `'compra'` **E** `'real'` → `success`; senão contém `'estim'` → `warning`; senão contém `'sem'` → `danger`; senão → `outline`. Case-insensitive.
- **`fonteBadgeLabel(fonte)`** → string. null/vazio → `'Sem preço'`; `compra`+`real` → `'Compra real'`; `estim` → `'Estimado'`; `sem` → `'Sem preço'`; **fallback devolve o `fonte` original (NÃO lowercased)**.
- **`classBadge(classe)`** → string. null → `'secondary'`; 1º char `'A'` → `'destructive'`; `'B'` → `'default'`; qualquer outro → `'secondary'`.
- **`fmt(v, dec=2)`** → string pt-BR. null/undefined → `'—'`; `0` formata (`'0,00'`, **não** `'—'` — guarda contra bug de falsy); respeita `dec`; separador de milhar `.` e decimal `,`.
- **`fmtBRL(v)`** → string pt-BR moeda. null/undefined → `'—'`; senão `'R$ …'` com **espaço não-quebrável (U+00A0)** após `R$`.

## Cenários

1. **`fonteBadgeVariant`**: `null`/`''` → danger; `'compra real'`/`'Compra Real'` → success; `'compra estimada'` (tem `compra` mas não `real`, tem `estim`) → warning; `'estimado'` → warning; `'sem preço'` → danger; `'qualquer'` → outline.
2. **`fonteBadgeLabel`**: `null` → 'Sem preço'; `'compra real'` → 'Compra real'; `'estim...'` → 'Estimado'; `'sem...'` → 'Sem preço'; fallback `'XPTO'` devolve `'XPTO'` verbatim.
3. **`classBadge`**: `null` → secondary; `'A'`/`'A2'` → destructive; `'B'` → default; `'C'`/`'X'` → secondary.
4. **`fmt`**: `null`/`undefined` → '—'; `0` → '0,00'; `1234.5` → '1.234,50'; `2.5` com `dec=1` → '2,5'; `1200` com `dec=0` → '1.200'.
5. **`fmtBRL`**: `null` → '—'; `0` → contém `'R$'` e `'0,00'`; `1234.5` → contém `'R$'` e `'1.234,50'` (asserts por `toContain` pra não acoplar ao NBSP).

## Testing

`src/lib/reposicao/__tests__/skuParam.test.ts` (vitest, sem mocks — funções puras). Suíte verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- Os `type`s (sem runtime); quem consome os helpers (page/sheet). Só a regra pura.
