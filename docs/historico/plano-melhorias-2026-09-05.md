# Varredura completa do repo → plano de melhorias (2026-09-05)

> Entrega: [`docs/superpowers/plans/2026-09-05-plano-melhorias-codebase/README.md`](../superpowers/plans/2026-09-05-plano-melhorias-codebase/README.md) (PR #2191) — 60 itens pontuados por `(Impacto+Risco)×(6−Esforço)` em 5 fases, com os 8 relatórios de auditoria íntegros em `anexos/`. Este arquivo é o registro; o plano é o documento.

## O que foi feito

- 8 auditorias read-only por eixo (subagentes Fable): frontend · domínio/lib · edges · banco · tooling/CI · testes · docs/backlog herdado · segurança — cada uma com evidência `arquivo:linha`, confirmação de que a lacuna existe hoje, e seção "descartei porque".
- Medições próprias: health stack completo (`heavy`), HogQL read-only (pageviews/eventos por rota, 90 dias), `psql-ro` (usuários por papel, atividade por tabela em 30/90 dias, tamanho/bloat, 93 crons e custo por job), LOC por módulo do manifesto.
- Calibrações contra prod antes de aceitar achado: objetos fantasma confirmados inexistentes; quarentena TEM RLS (o "sem RLS" era artefato do snapshot do bot); `wa_owner_efetivo` executável por `authenticated`; das 9 SECDEF executáveis por `anon`, 8 são trigger functions.

## A lição (a classe, não a instância)

**"Verde" mecânico não mede desproporção.** Typecheck/lint/knip zerados, 7.571 testes verdes e 336/336 tabelas com RLS convivem com: 5 usuários ativos e 15 rotas visitadas em 90 dias para ~295k LOC/173 páginas; 162 de 338 tabelas jamais escritas; 2 telas roteadas sobre tabela/RPC inexistente em prod (passaram no typecheck por `as never`); 16 P1 de julho ainda abertos; 26 edges sem sonda. O sensor que faltava é **uso real × superfície** (PostHog + `pg_stat` + manifesto) — e a maior alavanca é decisão de produto (triagem de módulos), não código.

## Onde continua

- Fase 0, lote 1 (M-01..M-04, money-path de recebimento/reposição/margem): chip "Fechar Fase 0 lote 1: P1 money-path (M-01..M-04)" — briefing durável no corpo do PR #2191.
- Decisões do founder: §6 do plano (triagem de superfície, objetos fantasma, CI na main, harness PG17 no CI, retenção LGPD, upgrades, `tint_*`, pendências da auditoria UX).
- KPIs para re-medir em 90 dias: §8 do plano.
