# Diagnóstico — Onda 2 de Endurecimento de Edge Functions

Plan mode: apenas diagnóstico. Nenhum código ou agendamento será alterado.

## Legenda

- **authorizeCron**: aceita SOMENTE header `x-cron-secret` válido (uso exclusivo de cron / jobs internos).
- **authorizeCronOrStaff**: aceita `x-cron-secret` OU JWT de usuário staff/admin (cron + invocação manual no app).
- **service-role-only**: aceita SOMENTE chamadas com Bearer SERVICE_ROLE_KEY (sem usuário).
- "ANON_KEY" no cron significa header `Authorization: Bearer <anon JWT>` — não é staff nem service-role; com `verify_jwt=false` passa pelo gateway, mas em código a função tipicamente cai em "Unauthorized" (401) se exigir `getUser()`.

## Tabela — ordenada por risco (mais crítico primeiro)

| # | Função | (a) Auth atual no código | (b) Quem chama | (c) Caller no cron | (d) Sugestão | Justificativa (1 linha) |
|---|---|---|---|---|---|---|
| 1 | **process-recurring-orders** | Lê `x-cron-secret` E `getUser()` Authorization, mas **não bloqueia se ambos faltarem** (fluxo segue com SERVICE_ROLE) | Cron (diário 07:00) | `Bearer ANON_KEY` | **authorizeCron** | Cria/dispara pedidos recorrentes em massa — só cron deve invocar; nenhum app caller. |
| 2 | **dispatch-notifications** | Sem auth no handler; usa SERVICE_ROLE internamente; `verify_jwt=true` (default) — exige JWT válido qualquer | Cron (diário 11:10) + app (1) | `Bearer service_role_key` (via `current_setting`) | **authorizeCronOrStaff** | Dispara notificações a todos usuários; cron + reenvio manual de admin. |
| 3 | **monthly-report** | `verify_jwt=false`; sem checagem de role no handler | Cron (mensal dia 1, 09:00) + app (1) | `Bearer ANON_KEY` | **authorizeCronOrStaff** | Gera e envia relatórios mensais por e-mail; staff pode disparar manual. |
| 4 | **calculate-scores** | `getUser()` exige JWT de usuário (qualquer autenticado) | Cron (diário 06:00) + app (1) | `Bearer ANON_KEY` (vai falhar 401 hoje) | **authorizeCronOrStaff** | Recalcula scores/ranking; afeta visões gerenciais; admin reexecuta sob demanda. |
| 5 | **algorithm-a-audit** | `verify_jwt=false`; SERVICE_ROLE interno; sem role check | Cron (semanal dom 03:00) + app (1) | `Bearer ANON_KEY` | **authorizeCronOrStaff** | Auditoria do Algoritmo A; cron semanal + auditor admin manual. |
| 6 | **omie-analytics-sync** | `verify_jwt=true` (default); sem checagem de role | Cron (5 jobs: 06:00, 06:15, 07:00, 07:30, 02:00, */30, */2h) + app (1) | `Bearer ANON_KEY` | **authorizeCronOrStaff** | Núcleo de sincronia analítica Omie (produtos/pedidos/inventário/assoc rules/custos); cron pesado + replay admin. |
| 7 | **sync-reprocess** | `verify_jwt=true`; sem role check no handler | Cron (2 jobs: */2h e diário 02:30) | `Bearer ANON_KEY` | **authorizeCron** | Reprocessamento operacional/estratégico; sem caller no app — só cron. |
| 8 | **omie-sync-estoque** | `verify_jwt=false`; sem auth no handler | Cron (diário 09:00) | `Bearer ANON_KEY` | **authorizeCron** | Sync de estoque Omie agendado; nenhum app caller. |
| 9 | **omie-sync-metadados** | `verify_jwt=false`; sem auth no handler | Cron (diário 08:30) | `Bearer ANON_KEY` | **authorizeCron** | Sync de metadados (vendedores, condições etc.); nenhum app caller. |
| 10 | **omie-sync-status-produtos** | `verify_jwt=false`; SERVICE_ROLE interno; sem role check | Cron (diário 06:30) + app (1, AdminSkuMapeamento) | `Bearer ANON_KEY` | **authorizeCronOrStaff** | Atualiza status de produtos; admin pode reexecutar pelo painel SKU. |
| 11 | **omie-sync** | `verify_jwt=false`; sem checagem de role | Cron (horário "sync_services") + app (2, OmieService) | `Bearer ANON_KEY` | **authorizeCronOrStaff** | Sync genérica de serviços/clientes Omie; usada por app e cron horário. |

## Observações

- **Risco real hoje (sem mudança)**: as 4 funções que usam `getUser()` (`calculate-scores`, `process-recurring-orders` no caminho que não tem cron secret, e similares) **falham 401 quando chamadas pelo cron com ANON_KEY**, pois ANON não é usuário autenticado. As demais com `verify_jwt=false` e sem role check **executam mesmo com ANON**, o que é o problema oposto: qualquer um com a anon key pode disparar.
- **`x-cron-secret` em uso**: só já existe nas 3 funções da Onda 1 (`gerar-pedidos-diario`, `disparar-pedidos-aprovados`, `omie-cron-diario`) e parcialmente em `process-recurring-orders`.
- **`dispatch-notifications` é o único job no cron que já usa `service_role_key`** (via `current_setting('app.settings.service_role_key')`) — funciona, mas mistura padrão com os demais.
- **App callers confirmados** (via `invokeFunction`/`functions.invoke`):
  - 0 callers: `omie-sync-estoque`, `omie-sync-metadados`, `process-recurring-orders`, `sync-reprocess` → candidatos a `authorizeCron` (lockdown total).
  - 1+ callers: demais → `authorizeCronOrStaff`.
- **Nenhuma função listada é boa candidata a `service-role-only` puro**, pois ou já são chamadas pelo app (precisa staff JWT) ou são cron-only (mais limpo usar `x-cron-secret` que SERVICE_ROLE no header do cron).

## Próximo passo (após sua aprovação, em build mode)

1. Aplicar `authorizeCron` em: `process-recurring-orders`, `sync-reprocess`, `omie-sync-estoque`, `omie-sync-metadados`.
2. Aplicar `authorizeCronOrStaff` em: `dispatch-notifications`, `monthly-report`, `calculate-scores`, `algorithm-a-audit`, `omie-analytics-sync`, `omie-sync-status-produtos`, `omie-sync`.
3. Gerar SQL (sem executar) para reescrever os 13 cron jobs trocando `Authorization: Bearer ANON_KEY` por `x-cron-secret: <CRON_SECRET>`.
4. Garantir que cada app caller (8 invocações) já passa por `invokeFunction` com sessão staff válida — nenhum requer mudança de cliente.
