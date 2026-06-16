# Cobertura de teste do `phone.ts` (normalização BR) — Design Spec

> **Data:** 2026-05-25
> **Status:** continuação autônoma (decidido com o Codex — #2 da fila por valor × baixo risco). `src/lib/phone.ts` (normaliza/forma telefone BR pro formato da Nvoip) sem teste. Impacto operacional real: número mal normalizado = **ligação/WhatsApp pro destino errado**. Função pura → teste durável.

## Goal

Travar `normalizeBrPhone` e `formatBrPhone`: matriz de DDD, 8/9/10/11 dígitos, prefixo +55 e entradas sujas. Sem mudança de código.

## Regras (do código)

- **`normalizeBrPhone(input, defaultDdd='37')`**:
  - falsy (`null`/`undefined`/`''`) → `''`.
  - tira tudo que não é dígito.
  - se `length > 11` e começa com `55` → remove os 2 primeiros (código de país).
  - se `length > 11` e começa com `0` → remove zeros à esquerda.
  - se `length` é **8 ou 9** (sem DDD) → prefixa `defaultDdd`.
  - devolve os dígitos (sem validar DDD; lixo curto passa).
- **`formatBrPhone(input)`**: normaliza; `len 11` → `(DD) 9XXXX-XXXX`; `len 10` → `(DD) XXXX-XXXX`; senão devolve o **input original** (`input ?? ''`).

## Cenários (saídas verificadas via node)

`normalizeBrPhone`:
1. `null`/`undefined`/`''` → `''`.
2. `'(37) 99999-8888'` → `'37999998888'` (tira formatação).
3. `'99999-8888'` (9 díg, celular sem DDD) → `'37999998888'` (DDD padrão).
4. `'3333-4444'` (8 díg, fixo sem DDD) → `'3733334444'`.
5. `'5537999998888'` e `'+55 (37) 99999-8888'` (+55) → `'37999998888'`.
6. `'55999998888'` (11 díg começando com 55) → `'55999998888'` **inalterado** (regra do 55 só em `>11`; trata 55 como DDD).
7. `defaultDdd` custom: `normalizeBrPhone('999998888','11')` → `'11999998888'`.
8. `'123'` (lixo curto) → `'123'` (passa, não valida).

`formatBrPhone`:
9. `'99999-8888'` → `'(37) 99999-8888'` (11 díg).
10. `'3733334444'` e `'(37) 3333-4444'` → `'(37) 3333-4444'` (10 díg; reformata consistente).
11. `null` → `''`.
12. `'123'` (não bate 10/11) → `'123'` (devolve o input original).

## Testing

`src/lib/__tests__/phone.test.ts` (vitest, sem mocks — funções puras). Suíte verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- Validação de DDD real / discagem da Nvoip; o caso patológico `0055...` (prefixo duplo país+zero não é totalmente limpo — gap latente, não realista, deixado sem assert pra não travar comportamento bugado como esperado).
