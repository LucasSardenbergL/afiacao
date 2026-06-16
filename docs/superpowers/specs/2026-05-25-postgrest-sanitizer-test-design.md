# Cobertura de teste dos helpers de `postgrest.ts` — Design Spec

> **Data:** 2026-05-25
> **Status:** continuação autônoma (decidido com o Codex — top da fila por **valor × baixo risco**). Sanitizador **security-critical** do `.or()` do PostgREST (`src/lib/postgrest.ts`) sem teste. A regra ESLint do projeto (CLAUDE.md §9b) obriga usar esses helpers pra evitar injeção de cláusula; uma regressão silenciosa aqui = brecha de injeção. Função pura → teste durável.

## Goal

Travar o invariante de segurança: depois de sanitizar, o termo do usuário **não pode** introduzir separador de cláusula (`,`), agrupamento (`()`), escape (`\`), aspas (`"`) nem wildcard de ILIKE (`%` `_`). Sem mudança de código.

## Regras (do código)

- **`sanitizeForPostgrestOr(input)`** → remove **todo** caractere em `%`, `_`, `,`, `(`, `)`, `\`, `"`. O resto (incluindo `.`, espaço, acento, hífen, `;`) permanece literal.
- **`ilike(col, term)`** → `` `${col}.ilike.%${sanitize(term)}%` ``.
- **`ilikeOr(cols, term)`** → `cols.map(c => \`${c}.ilike.%${safe}%\`).join(',')` (1 termo sanitizado, N colunas). `[]` → `''`.
- **`eqInt(col, term)`** → `` `${col}.eq.${X}` `` onde `X` = `term.trim()` se for **só dígitos** (`/^\d+$/`), senão `'0'` (não casa nada — comportamento desejado). Mantém zeros à esquerda (`'007'`).
- **`eqText(col, value)`** → `` `${col}.eq.${sanitize(value)}` ``.
- **`orFilter(...clauses)`** → `clauses.join(',')`. Zero args → `''`.

## Cenários

1. **sanitize — texto limpo**: `'abrasivo 120'` inalterado (espaço e dígitos sobrevivem); acento/hífen/ponto sobrevivem (`'ção-1.5'`).
2. **sanitize — remove cada metacaractere**: `%`, `_`, `,`, `(`, `)`, `\`, `"` somem; vetor de injeção `'%,id.gt.0,('` → `'id.gt.0'` (sem vírgula/paren pra quebrar a cláusula → vira termo literal inofensivo).
3. **sanitize — string vazia** → `''`.
4. **ilike**: estrutura `col.ilike.%termo%`; termo malicioso `'a,b'` → `'col.ilike.%ab%'` (vírgula sumiu, estrutura intacta).
5. **ilikeOr**: N colunas, 1 termo → `c1.ilike.%t%,c2.ilike.%t%`; termo com vírgula NÃO injeta cláusula extra (conta de vírgulas = N-1); `[]` → `''`.
6. **eqInt**: `'42'`→`.eq.42`; `'  42  '`→`.eq.42` (trim); `'abc'`/`'4.5'`/`'1;DROP'`/`''`→`.eq.0`; `'007'`→`.eq.007`.
7. **eqText**: limpo passa; `'a,b)'`→`'col.eq.ab'`.
8. **orFilter**: junta com vírgula; zero args → `''`; 1 arg → ele mesmo.

## Testing

`src/lib/__tests__/postgrest.test.ts` (vitest, sem mocks — funções puras). Asserts incluem a **propriedade de segurança** (nenhum metacaractere sobrevive; nº de vírgulas no `ilikeOr` = colunas-1). Suíte verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- O comportamento real do PostgREST/supabase-js (integração); o espelho Deno do sanitizador nas Edge Functions (cópia à parte).
