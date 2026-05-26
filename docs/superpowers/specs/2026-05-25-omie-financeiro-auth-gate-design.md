# Gate de acesso do `omie-financeiro` (master + gestor) — Design Spec

> **Data:** 2026-05-25
> **Status:** follow-up #2 do sweep do Codex (PR #322/#324). Matriz de permissão **decidida pelo founder** (2026-05-25): master + gestor comercial. Disciplina §FinanceiroProgram (helper puro TDD espelhado no Deno).

## Problema (gap de autorização server-side, BFLA/BOLA-ish)

`validateCaller` do `omie-financeiro` aceitava **qualquer** `employee` ou `master` (via JWT). Mas a function expõe dados financeiros sensíveis (DRE, saldos, contas a pagar/receber das 3 empresas) e dispara sync com o ERP Omie. No frontend, os cockpits financeiros são gated master-only ou gestor+master — mas **UI gate não é controle de segurança**: um `employee` comum (ex.: separador) com JWT válido podia chamar a function direto (curl/fetch) e ler/sincronizar.

Confirmado em revisão adversária com o Codex como gap real; a **matriz** (quem pode) foi reservada pro founder.

## Decisão (founder)

**master + gestor comercial.** Espelha o gate canônico do `fin-valor-cockpit`/`fin-next-best-action`:
- `master` em `user_roles.role`, **OU**
- `commercial_roles.commercial_role` ∈ `{gerencial, estrategico, super_admin}`.
- **cron/service_role** seguem livres (inalterados — os crons rodam o sync).
- `employee` comum e `vendedor` (commercial não-gestor) → **403**.

## Solução

Helper puro `hasFinanceiroAccess({ userRoles, commercialRoles })` em `src/lib/financeiro/omie-request.ts` (TDD, deny-by-default), espelhado verbatim no Deno. `validateCaller` passa a buscar `user_roles` + `commercial_roles` (via `db` service_role → sem esbarrar em RLS) e delega a decisão ao helper.

Granularidade: **função inteira** (não por-action) — todas as actions do `omie-financeiro` são financeiras/sync (sync_*, calcular_dre[_year], resumo, debug_raw); nenhuma é operacional pra employee comum.

## Validação

- `src/lib/financeiro/__tests__/omie-request.test.ts` — +6 casos de `hasFinanceiroAccess` (master→true; gerencial/estrategico/super_admin→true; master vence; employee→false; vendedor→false; null/vazio→false). Suíte financeiro: **220/220**.
- `deno check`: mesmo erro-set antes/depois (zero introduzidos).
- Lint: exit 0.

## Risco / breakage

- Crons (cron-secret/service_role): **não afetados**.
- UI financeira: usuários são master/gestor → ok.
- O que pode quebrar: caller direto ou tela esquecida usando `employee` puro — que é exatamente o acesso indevido que se quer cortar (descoberta = feature).

## Deploy (manual, §5)

Após o merge, **redeploy do `omie-financeiro` via chat do Lovable** (verbatim do repo na main).

## Out-of-scope

- Tenant-scoping por empresa (org única, staff troca livremente → by-design, não é gap).
- `maxPages`/`filtro_data_*` (operacionais, baixo valor; `requestedRegime` já seguro).
