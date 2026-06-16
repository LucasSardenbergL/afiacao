# Cobertura de teste do `calculateRendimento` — Design Spec

> **Data:** 2026-05-25
> **Status:** continuação autônoma (decidido com o Codex — #3 da fila). `src/lib/knowledge-base/calculate-rendimento.ts` calcula litros de tinta necessários (rendimento + demãos) — money/spec-adjacent, sem teste. Fórmula transparente e auto-consistente (cobertura de tinta padrão) → travo o comportamento observável com confiança.

## Goal

Travar `calculateRendimento(input)`: escolha de demãos, rendimento explícito vs. derivado de densidade+gramatura, caminhos de dados insuficientes, e o cálculo de litros. Sem mudança de código.

## Regras (do código)

- `demaos = demaosOverride ?? spec.demaos_recomendadas ?? 1`. Sem override **e** sem `demaos_recomendadas` → warning `'Demãos não informadas no boletim — assumindo 1.'`.
- **Rendimento explícito**: `rendimento_m2_por_litro != null && > 0` → usa direto; `calculo` = `'Rendimento do boletim: X m²/L'`.
- **Derivado**: senão, se `densidade_g_cm3` truthy **e** (`gramatura_min` ou `gramatura_max`) → `gramaturaMedia = (min+max)/2` (faltando uma ponta, usa a outra), `rendimento = densidade*1000 / gramaturaMedia`; warning `'Rendimento derivado da densidade + gramatura (boletim não informa explicitamente).'`.
- **Insuficiente**: senão → warning `'Spec sem rendimento, densidade ou gramatura — dados insuficientes pro cálculo.'`, retorna `rendimento=0, litros=0, calculo='Dados insuficientes'`.
- Após derivar, se `rendimento <= 0` → retorna zeros (mantém `calculo`).
- `litros = (areaM2 / rendimento) * demaos`.

## Cenários (valores verificados via node)

1. **Explícito**: `{rendimento:10, demaos_recomendadas:2}`, area 100 → demaos 2, rendimento 10, litros **20**, `warnings:[]`, calculo contém `'Rendimento do boletim: 10'`.
2. **Override** sobrepõe spec: demaosOverride 3 → demaos 3, litros **30**, sem warning de demãos.
3. **Sem demãos**: `{rendimento:10}` (sem demaos_recomendadas, sem override) → demaos 1, warning de demãos presente.
4. **Derivado**: `{densidade:1.2, gramatura_min:100, gramatura_max:200, demaos_recomendadas:1}`, area 80 → média 150, rendimento **8**, litros **10**, warning de derivação, calculo contém `'Derivado'`.
5. **Derivado só com min**: `{densidade:1.2, gramatura_min:120}` → média 120, rendimento **10**.
6. **Rendimento explícito 0 → cai pra derivação**: `{rendimento:0, densidade:1.2, gramatura_min:150}` → rendimento **8** (não trata 0 como válido).
7. **Insuficiente**: `{rendimento:null}` sem densidade/gramatura → rendimento 0, litros 0, calculo `'Dados insuficientes'`, warning de insuficiência.
8. **Área 0**: rendimento 10, area 0 → litros **0**, sem warning.

## Testing

`src/lib/knowledge-base/__tests__/calculate-rendimento.test.ts` (vitest, sem mocks — função pura). `toContain` na memória de cálculo (string longa); igualdade nos números. Suíte verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- Correção contábil/química da fórmula (assumida correta — cobertura de tinta padrão); o guard `rendimento <= 0` pós-derivação é praticamente inalcançável com input realista (não forçado).
