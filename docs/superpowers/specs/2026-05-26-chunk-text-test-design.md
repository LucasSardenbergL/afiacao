# Cobertura de teste do `chunkText` (RAG) — Design Spec

> **Data:** 2026-05-26
> **Status:** continuação autônoma (lane seguro/não-colidente). `src/lib/knowledge-base/chunk-text.ts` (quebra texto em chunks p/ embeddings/RAG) sem teste. Pura, sem deps. 

## Goal

Travar a quebra greedy por caractere com overlap. Sem mudança de código.

## Regras (do código, `CHARS_PER_TOKEN=4`)

- `maxChars = maxTokens*4`; `overlapChars = overlap*4`; `step = max(1, maxChars - overlapChars)` (piso 1 evita loop infinito).
- texto vazio → `[]`.
- `len ≤ maxChars` → 1 chunk `{content, charStart:0, charEnd:len, tokenEstimate:ceil(len/4)}`.
- senão greedy: `pos=0`; chunk `[pos, min(pos+maxChars,len)]`; break se chegou ao fim; `pos += step`.

## Cenários

1. vazio → [].
2. `len ≤ maxChars` → 1 chunk; `tokenEstimate = ceil(len/4)`.
3. boundary `len === maxChars` → 1 chunk.
4. longo → múltiplos chunks; overlap entre consecutivos = `overlapChars`; último encerra no fim; `content === slice(charStart,charEnd)`.
5. `overlap=0` → contíguos (sem sobreposição).
6. `overlap ≥ maxTokens` (step degenerado) → **termina** (piso 1), cobre até o fim — guard anti-loop.

## Testing

`src/lib/knowledge-base/__tests__/chunk-text.test.ts` (vitest, sem mocks). 6 casos, verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- Split por sentença (refinamento futuro citado no código); a heurística de tokens (4 chars).
