# Aprovações fantasma: perfil placeholder do Omie sem origem (plano v7, lote 2 — C7)

**Data:** 2026-11-05/06 · **Plano:** `docs/superpowers/plans/2026-11-05-plano-melhoria-v7/README.md` §2 C7 · **Deploy:** edge `omie-cliente` v1.7 + backfill pelo `db:aplicar` (sem Publish: o front não mudou).

## Problema

A fila de aprovações (`src/pages/AdminApprovals.tsx`) e o KPI da home (`src/hooks/dashboard/useSistemaZone.ts`) excluem o cliente-fantasma do Omie por `prospect_source = 'omie_import'`. O import no servidor (#3496/#3501/#3511) e o `criar_perfil_local` da edge `omie-cliente` inseriam o `profile` do usuário Auth placeholder **sem origem**. Na prod (`psql-ro`, 2026-11-05) havia **16.070** perfis com `is_approved = false`, todos com `prospect_source` nulo e **0** com `omie_import`. A home dizia ~16 mil aprovações pendentes. A fila, sem `.range()` e em `created_at desc`, mostrava 1.000 fantasmas, e um pedido real de conta ficava fora da janela.

## Conserto

1. **Escritor.** `supabase/functions/omie-cliente/perfil-placeholder.ts` monta a linha do profile que nasce com o placeholder, já com `prospect_source = 'omie_import'`, e os **dois** inserts da edge passam por ele. O profile real reaproveitado por documento (`profileByDoc` no import, `matchedUserId` no `criar_perfil_local`) não passa por ali e mantém a origem que tem. A linha não carrega `is_approved` nem `is_employee`. O `VERSAO` foi para `v1.7-perfil-placeholder-com-origem`.
2. **Backfill por procedência:** `supabase/migrations/20261106022016_profiles_origem_omie_import_backfill.sql`. A prova de "nasceu do import" é o usuário Auth que a edge cria junto: e-mail `omie_<codigo>@placeholder.local` **e** `raw_user_meta_data.is_placeholder = true`. Por cima disso vêm as travas de pessoa real: nunca logou, não aprovado, não funcionário e sem papel além de `customer`. **Não** se usou data (10.406 nasceram em 01/11, mas há lotes de março e de julho) nem o mapa Omie: o mapa prova vínculo comercial, e o import vincula perfis preexistentes. Postcondições: P1 (cobertura: nenhum placeholder do critério sem origem), P2 (precisão: todo `omie_import` é placeholder intocado) e P3 (nenhum `omie_import` com papel de staff).

## Pré-voo e prova

- `psql-ro`: nenhum dos 16.070 tem `orders`, `push_subscriptions`, `webauthn_credentials`, `dashboard_visits`, `telemetria_vitals`, `commercial_roles`, `user_departments`, papel além de `customer` ou `is_employee`. Nenhuma função, view ou policy de prod referencia `prospect_source`. O CHECK já aceita `omie_import`. O UPDATE só dispara `update_profiles_updated_at`; os triggers de papel e de aprovação são `UPDATE OF` outras colunas.
- O `claude_ro` não lê `auth`, então o cruzamento com o placeholder foi medido no **ensaio** do `db:aplicar` (ROLLBACK): `antes=16070 · marcados=16070 · restam nao_placeholder=0 ja_logou=0 staff=0`, com P1–P3 verdes.
- Teste Deno `perfil-placeholder_test.ts`: a origem, os campos preservados, a ausência de `is_approved` e a **forma** do `index.ts` (os 2 inserts em `profiles` usam o helper, sem `upsert`). Falsificado com controle verde na mesma invocação: o insert montado à mão dá exit 1, a origem trocada dá exit 1 e o restaurado volta a 0.
- Codex (`gpt-6-astra`, high, 2 rodadas): "sem achado" em (a) perfil real marcado, (b) outro leitor dependente do NULL e (c) buraco no SQL ou postcondição teatral.

## Lição

Um prompt de revisão que manda "diga 'sem achado' e pare" faz o Codex parar no **primeiro** item sem achado. A rodada 1 respondeu só (a). Escreva "sem achado e passe ao PRÓXIMO item".

## Ordem de aplicação

Primeiro a edge v1.7 (para nenhum fantasma novo nascer sem origem depois do backfill), depois o backfill. A validação vai por fora, com o `psql-ro`: pendentes que a fila e o KPI contam (`is_approved = false` e origem ≠ `omie_import`) → 0.
