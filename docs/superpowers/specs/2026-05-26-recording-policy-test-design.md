# Cobertura de teste do `recording-policy` (LGPD) — Design Spec

> **Data:** 2026-05-26
> **Status:** continuação autônoma (lane seguro/não-colidente; strict ocupado por sessão paralela, financeiro em churn). `src/lib/call-log/recording-policy.ts` decide se uma ligação é **auto-gravada + toca o aviso de consentimento (LGPD)** — sem teste. Ângulo legal/privacidade → vale travar.

## Goal

Travar a decisão de auto-gravação e a resolução de quem-está-na-linha. Sem mudança de código.

## Regras (do código)

- **`shouldAutoRecord(kind)`** → `true` para `cliente`/`fornecedor`; `false` para `desconhecido` (não grava número não-cadastrado).
- **`resolveCallParty(rawPhone)`** (async) → delega a `resolveCustomerByPhone`. Com match → `{ kind:'cliente', customerUserId, contactName, contactCargo, matchConfidence:'last8', phoneNormalized }`. Sem match → `{ kind:'desconhecido', customerUserId:null, matchConfidence:'none', phoneNormalized }`. Sempre preserva o telefone normalizado.

## Cenários

1. `shouldAutoRecord`: cliente/fornecedor → true; **desconhecido → false** (guard LGPD).
2. `resolveCallParty`: cadastrado → cliente + mapeia contato + `last8`; sem match → desconhecido + null + `none`, preservando o telefone.
3. Encadeamento: `shouldAutoRecord(resolveCallParty(...).kind)` — cadastrado grava, desconhecido não.

## Mock

- `vi.mock('@/lib/call-session/resolve-customer')` → `resolveCustomerByPhone` controlado (DB-backed; isola a política do lookup).

## Testing

`src/lib/call-log/__tests__/recording-policy.test.ts` (vitest). 5 casos, verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- O lookup real (`resolveCustomerByPhone`, mockado); o ramo `fornecedor` dormente (sem fonte de telefone hoje — `shouldAutoRecord` já o trata).
