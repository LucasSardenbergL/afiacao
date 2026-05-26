# Hardening do `omie-financeiro` (follow-up do sweep do Codex) — Design Spec

> **Data:** 2026-05-25
> **Status:** follow-up do PR #322 (fix de injeção no DRE). Endereça 2 dos 4 itens do sweep adversário do Codex. Disciplina §FinanceiroProgram (helper puro TDD espelhado no Deno).

## Goal

Fechar mais dois gaps do sweep do Codex no `supabase/functions/omie-financeiro/index.ts`, sem mudar o comportamento legítimo:

- **#1 — allow-list de empresa**: `company`/`companies` vêm do body sem validação. Não é injetável (`.eq()` encoda), mas garbage → resultado vazio / chave-lixo silenciosa, e fora do conjunto conhecido o upsert de snapshot grava numa empresa fantasma.
- **#4 — `error` engolido nas queries do DRE**: `buscarCR`/`buscarCP` (e mappings/histReceita) faziam `const { data } = ...; return data ?? []`, ignorando `error`. Falha de DB (RLS, conexão) virava **DRE zerada/mis-categorizada persistida** no upsert — o ponto que o Codex classificou como integridade Média-Alta.

## Solução

**#1** — helper puro `src/lib/financeiro/omie-request.ts` (TDD), espelhado verbatim no Deno:
- `resolveCompanies({ companies, company, allowed })`: `companies` (array) tem precedência, cada item no allow-list; senão `company` único validado; ambos ausentes → todas as permitidas. Inválido/vazio/não-array/tipo errado → `OmieRequestError` → **HTTP 400**.
- Allow-list = `["oben","colacor","colacor_sc"]` (= `Company`). Aplicado no boundary (substitui `companies || (company ? [company] : [...])`).

**#4** — em `calcularDRE`, capturar `error` e `throw` nas queries que alimentam a DRE: `buscarCR` (competência+caixa), `buscarCP` (competência+caixa), `fin_categoria_dre_mapping`, e o histórico p/ RBT12 (`fin_dre_snapshots`). Erro de DB nunca é "sem linhas" → não persistir DRE incompleta. **`cfgRes` (coluna opcional `dre_tributario`) fica como está** — degradação proposital documentada (`maybeSingle` → null).

## Decisões (validadas com o Codex)

- THROW, não fallback silencioso (money-path: errar ruidosamente > gravar errado). `calcularDRE` não é envolto em try/catch por-empresa → um throw 500a a action (correto: o cron/UI vê a falha e re-tenta).
- `error` ≠ "sem linhas": throw em error não quebra o caso legítimo de tabela vazia (ex.: empresa nova sem histórico).

## Fora do escopo (sweep do Codex — registrados, não feitos)

- **#2 — `validateCaller` é role-scoped, não tenant-scoped**: é **decisão de PRODUTO** (o `CompanyContext` deixa staff trocar de empresa livremente → provavelmente não se quer escopar por empresa). Precisa do founder, não é hardening autônomo.
- **#3 — `maxPages`/`filtro_data_de`/`filtro_data_ate`**: operacionais, baixo valor; `requestedRegime` **já é seguro** (comparado por `===` a literais com default). Deferido.

## Validação

- `src/lib/financeiro/__tests__/omie-request.test.ts` — 7 casos (ausente→todas, válido, fora-do-allow-list→throw, vazio/não-array/tipo errado→throw). Verde. Suíte financeiro: 214/214.
- `deno check`: **mesmo erro-set antes/depois** (10 erros pré-existentes; zero introduzidos).
- Lint do helper/test: exit 0.

## Deploy (manual, §5)

Após o merge, **redeploy do `omie-financeiro` via chat do Lovable** (verbatim do repo na main).
