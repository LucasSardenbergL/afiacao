# Sentinela Ativo (push) — Design

**Data:** 2026-05-27
**Status:** aprovado pelo founder, pronto pra writing-plans

## Objetivo

Tornar o Sentinela de Saúde de Dados **ativo**: um cron que avalia os checks de saúde
server-side e **dispara alerta** (email, via o pipe existente) na **transição ok→degradado**,
pros domínios **vendas, estoque, reposição e carteira**. Fecha o modo-de-falha raiz do
incidente de 2026-05-27 (4 syncs falharam silenciosos por 8 dias porque o `get_data_health()`
é **pull-only** — só mostra problema quando alguém abre o badge/página, e ninguém abriu).

## Contexto

- O Sentinela hoje (`get_data_health()`, RPC SECURITY DEFINER) tem 8 checks de frescor em 5
  domínios (financeiro: saldo/CR/CP; omie_sync; vendas: `fin_sync_log` sync_pedidos; estoque:
  `inventory_position.synced_at`; reposição: `pedido_compra_sugerido.data_ciclo`; carteira:
  `farmer_client_scores.calculated_at`). Consumido só por PULL: badge no topbar, página
  `/gestao/saude-dados`, `<DataHealthBanner>` inline (refetch 120s, só com a tela aberta).
- Já existe um vigia parcial: `fin_sync_watchdog_check()` (cron `fin-sync-watchdog` `*/30`) +
  `fin_sync_heartbeat()` (cron `fin-sync-heartbeat` `0 11 * * 1-5`). Ele cobre **só o sync
  financeiro** (`fin_sync_log` contas_pagar/receber/movimentacoes por empresa + cursor travado),
  de forma mais granular que os checks financeiros do Sentinela.
- Infra de alerta reutilizável (confirmada):
  - **`fin_alertas`** — tabela de estado dos alertas. `company` CHECK `{oben,colacor,colacor_sc}`,
    `severidade` CHECK `{info,aviso,critico}`, `dismissed_at`. UNIQUE parcial
    `(company, tipo) WHERE dismissed_at IS NULL` (anti-spam: 1 alerta aberto por company+tipo).
  - **`fornecedor_alerta`** — fila de email. `severidade` CHECK `{info,atencao,urgente}`,
    `tipo` CHECK inclui `'outro'`, `status` default `'pendente_notificacao'`.
  - **`dispatch-notifications`** (edge) drena `fornecedor_alerta` por `status='pendente_notificacao'`
    e envia email via Gmail API. Mesmo pipe que o `fin_sync_watchdog` já usa.

## Princípios

- **Fonte única de verdade**: os checks vivem em UMA função; dashboard e watchdog leem dela.
  Reimplementar os checks no watchdog é proibido (causaria dashboard verde × alerta divergente).
- **Sem verde silencioso**: `unknown`/`broken`/`stale` alertam; o cron nunca transforma
  `unknown` em silêncio.
- **Donos por domínio**: o watchdog NÃO toca financeiro (dono é o `fin_sync_watchdog`). Cobre
  só vendas, estoque, reposição, carteira. Tipos distintos (`data_health_*` vs `sync_*`).
- **Baixo ruído**: 1 email na transição ok→degradado; silêncio enquanto persiste; dismiss
  silencioso na recuperação; heartbeat diário como liveness + lembrete suave. SEM aviso de
  recuperação, SEM re-nag (decisão do founder).

## Arquitetura

Três funções SQL + 1 cron novo + extensão do heartbeat existente. Tudo SECURITY DEFINER,
`SET search_path = public, pg_temp`. Migrations aplicadas manualmente via SQL Editor do Lovable
(constraint do projeto — ver CLAUDE.md §5).

### 1. `_data_health_compute()` — fonte única de verdade
- Função interna, SECURITY DEFINER, **SEM gate de `auth.uid()`**, `SET search_path`.
- Retorna a MESMA TABLE de hoje (os 8 checks: source, domain, status, age_seconds,
  expected_max_age_seconds, freshness_basis, message, last_error, probable_cause, how_to_fix,
  severity) — o corpo é exatamente o `WITH checks AS (...)` atual do `get_data_health()`,
  **sem** a redação por papel (devolve o payload técnico completo).
- `REVOKE ALL ... FROM PUBLIC, anon, authenticated` (no Supabase, revogar de `anon`/`authenticated`
  explicitamente — `FROM PUBLIC` não basta). Só funções definer/cron a chamam.

### 2. `get_data_health()` — wrapper público (refactor)
- Mantém a assinatura e o REVOKE/GRANT atuais (`TO authenticated`).
- Corpo novo: gate `IF auth.uid() IS NULL THEN RAISE`; `v_full := pode_ver_carteira_completa(...)`;
  `RETURN QUERY SELECT source, domain, status, age_seconds, expected_max_age_seconds,
  freshness_basis, message, CASE WHEN v_full THEN last_error ELSE NULL END, (idem probable_cause,
  how_to_fix), severity FROM _data_health_compute()`.
- **Comportamento idêntico ao atual pro frontend** — nenhuma mudança no client (hook/badge/página/banner).

### 3. `data_health_watchdog()` — o vigia
- SECURITY DEFINER, `SET search_path`, RETURNS void.
- Lê `_data_health_compute()` UMA vez para um cursor/loop sobre os checks **dos 4 domínios**
  (`domain IN ('vendas','estoque','carteira')` + os de reposição que têm `domain='estoque'` —
  na prática: `source IN ('vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores')`).
- Para cada check:
  - **`status <> 'ok'`** (broken/stale/unknown):
    ```
    INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
    VALUES ('oben', 'data_health_'||source, <sev_fin>, message,
            jsonb_build_object('source',source,'domain',domain,'status',status,
                               'age_seconds',age_seconds,'freshness_basis',freshness_basis))
    ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
    IF FOUND THEN
      INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES ('oben','outro', <sev_forn>, '[Saúde de dados] '||source, message, 'pendente_notificacao');
    END IF;
    ```
  - **`status = 'ok'`**:
    ```
    UPDATE fin_alertas SET dismissed_at = now()
    WHERE company='oben' AND tipo='data_health_'||source AND dismissed_at IS NULL;
    ```
- `company='oben'` é o carrier (CHECK não aceita 'global'; o `fin_sync_heartbeat` já usa 'oben'
  pra alerta não-específico). O `tipo` único por source garante o dedup correto.
- **Mapa de severidade** (a partir do `severity` do check):
  - `'critical'` → `fin_alertas.severidade='critico'`, `fornecedor_alerta.severidade='urgente'`
  - `'warning'` → `fin_alertas.severidade='aviso'`, `fornecedor_alerta.severidade='atencao'`
  - (os 4 checks cobertos: vendas_pedidos=critical; estoque/reposição/carteira=warning)

### 4. Heartbeat (dead-man-switch) — estender `fin_sync_heartbeat()`
- Anexar à mensagem diária existente uma seção: "Saúde de dados: N alertas ativos" (count de
  `fin_alertas WHERE tipo LIKE 'data_health_%' AND dismissed_at IS NULL`) + resumo dos 4 checks
  (source: status, via `_data_health_compute()`).
- **1 email diário consolidado** (sem 2º heartbeat). Se parar de chegar → o vigia morreu.

### 5. Cron
- `SELECT cron.schedule('data-health-watchdog', '*/30 * * * *', $$SELECT public.data_health_watchdog()$$)`.
- É função SQL local (roda como postgres, dono) — **sem `net.http_post`**, logo SEM a armadilha
  do timeout default de 5s do pg_net. Versionado em migration (lição do incidente: crons versionados).

## Migrations (aplicação manual via SQL Editor)

1. `_data_health_compute()` + refactor de `get_data_health()` (wrapper) — uma migration (o corpo
   dos checks migra da função pública pra interna; o wrapper passa a chamá-la). Validar paridade:
   o `get_data_health()` deve devolver exatamente as mesmas linhas/redação de antes.
2. `data_health_watchdog()` + extensão do `fin_sync_heartbeat()` + cron `data-health-watchdog`.

## Validação manual roteirizada (em prod, via SQL Editor)

1. **Paridade do refactor**: rodar `get_data_health()` (impersonando master) → 8 checks idênticos
   aos de hoje, com redação por papel preservada (testar também sem impersonar full → last_error/
   probable_cause/how_to_fix nulos).
2. **Estado saudável → sem alerta**: `SELECT data_health_watchdog()` com tudo ok → nenhuma linha
   nova em `fin_alertas` (tipo `data_health_*`), nenhum email enfileirado.
3. **Transição → alerta**: forçar um check stale (ex.: nenhum sync_pedidos recente, ou mexer numa
   tabela de teste) → rodar o watchdog → 1 linha em `fin_alertas` + 1 em `fornecedor_alerta`
   (`pendente_notificacao`). Rodar de novo → DO NOTHING (sem 2º email).
4. **Recuperação → dismiss**: voltar o check a ok → rodar → `fin_alertas.dismissed_at` setado,
   sem novo email.
5. **Heartbeat**: `SELECT fin_sync_heartbeat()` → email com a seção "Saúde de dados".

## Coexistência com `fin_sync_watchdog`

- Domínios disjuntos: `data_health_watchdog` NÃO avalia financeiro (saldo/CR/CP/omie_sync). O
  `fin_sync_watchdog` continua dono do sync financeiro (mais granular).
- Tipos distintos no `fin_alertas` (`data_health_*` vs `sync_*`) → o UNIQUE parcial não colide.
- Ambos enfileiram em `fornecedor_alerta` com `tipo='outro'` — sem conflito (a fila não tem unique).

## Riscos / armadilhas (do codex)

- **Divergência de regra** (maior risco) → mitigado pela fonte única `_data_health_compute()`.
- **SECURITY DEFINER inseguro** → `SET search_path='public','pg_temp'`, schema explícito, REVOKE
  da interna de anon/authenticated/PUBLIC.
- **"Sem dado = vermelho"** → o cron alerta em unknown/broken (não silencia).
- **Frescor por timestamp errado** → os checks já usam o campo de ingestão real (synced_at,
  calculated_at, fin_sync_log.completed_at), não created_at-Omie.
- **Canal de alerta também falha** → o heartbeat diário é o dead-man-switch; se `fornecedor_alerta`
  empilhar `pendente_notificacao` sem virar `notificado`, é sinal de que o dispatch parou
  (observação pra v2: um check do próprio canal).

## Escopo cortado (YAGNI)

- Sem aviso de recuperação; sem re-nag; sem UI nova (badge/página/banner já existem); sem tocar
  financeiro; sem suite de teste SQL nova (validação manual roteirizada); sem monitor do próprio
  canal de alerta (observação pra v2).
