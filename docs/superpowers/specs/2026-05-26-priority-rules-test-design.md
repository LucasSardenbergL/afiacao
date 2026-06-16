# Cobertura de teste do `priority-rules` (dashboard) — Design Spec

> **Data:** 2026-05-26
> **Status:** continuação autônoma. `src/lib/dashboard/priority-rules.ts` (escolhe o card de prioridade nº1 do dashboard por persona) sem teste. Lane seguro/não-colidente (arquivo de teste novo) — strict-mode está em sessão paralela; financeiro em churn. Pura → teste durável.

## Goal

Travar `variantFromScore` e `pickWinner` — a regra que decide o que o usuário vê primeiro no dashboard. Sem mudança de código.

## Regras (do código)

- **`variantFromScore(score)`** → thresholds inclusivos: `≥90` critical, `≥60` warning, `≥30` info, senão success.
- **`pickWinner(candidates, personaZoneOrder)`** → maior `score` vence; empate desempata por **ordem da zona em `personaZoneOrder`** (índice menor vence, via `indexOf`); `[]` → `null`; não muta a entrada (`[...candidates]`).

## Cenários

1. `variantFromScore`: boundaries 90/89, 60/59, 30/29, 0.
2. `pickWinner`: vazio→null; único→ele; maior score; empate→zona primeiro no order; tie-break usa a ordem da persona (não a de inserção); não muta a entrada.

## Testing

`src/lib/dashboard/__tests__/priority-rules.test.ts` (vitest, sem mocks). 10 casos, verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- O `item`/`icon` do candidato (irrelevante pro algoritmo); quem monta os candidates.
