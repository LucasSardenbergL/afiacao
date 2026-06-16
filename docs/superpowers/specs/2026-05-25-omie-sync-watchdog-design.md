# Spec — Watchdog de integridade do sync Omie (iteração 1)

> Data: 2026-05-25 · Front ranqueado #1 ROI pelo codex · Sistema solo em produção, backend só via Lovable (SQL Editor + chat)

## Problema / motivação

Incidente real (CLAUDE.md §5): o `CRON_SECRET` do Vault divergiu da env var das edge functions → ~20 crons levaram **401 silencioso**. O `cron.job_run_details` reportava `succeeded` (só registra que o `net.http_post` foi enfileirado, não o HTTP real). O founder descobriu por **reclamação de "dados desatualizados", dias depois**. Hoje **nada vigia** o frescor/saúde do sync — a falha é silenciosa.

## Objetivo (iteração 1)

Detectar e **alertar** quando o sync Omie→financeiro **para** ou um cron financeiro/Omie **falha de verdade**, de forma **confiável e pouco barulhenta**, pra o founder saber **antes** de virar reclamação. Inclui um **heartbeat** (dead-man-switch) pra perceber se o próprio vigia/canal parou.

## Não-objetivos (YAGNI — confirmado com codex)

- Reconciliação contagem/valor Omie×Supabase (→ iteração 2).
- Dashboard/tela dedicada.
- Cobrir os ~20 crons; só os **financeiros/Omie críticos**.
- Auto-corrigir cursor/sync.
- Telegram / novo secret no Vault (a raiz do incidente foi divergência silenciosa de secret — não adicionar superfície).

## Arquitetura — cron SQL puro (sem edge function nova)

Decisão do codex: menos uma function pra deployar via chat Lovable, roda perto das tabelas, lê `net._http_response`/`fin_sync_log`/`fin_sync_cursor` e reusa os canais existentes. Tudo via `cron.schedule` (pg_cron já habilitado).

### Reuso de infra (nada de tabela/canal novo)

- **`fin_alertas`** = casa do alerta. Tem `UNIQUE(company, tipo) WHERE dismissed_at IS NULL` → **anti-spam grátis** (dispensa tabela de estado própria) e já é **renderizada in-app** no cockpit financeiro. severidade ∈ {info, aviso, critico}; company ∈ {oben, colacor, colacor_sc}; tem `contexto jsonb`.
- **`fornecedor_alerta` → `dispatch-notifications`** = canal de **email** (Gmail, já roda em cron; default `lucascoelhosardenberg@gmail.com`). `tipo` tem CHECK → usar `'outro'`; exige só `empresa`+`tipo`+`titulo` (campos de reposição nuláveis).

### Componente 1 — `fin-sync-watchdog` (cron a cada ~30min)

Detecta problemas por **sinais combinados** (codex: NÃO usar só `MAX(data_emissao)` — CR/CP/mov não têm movimento todo dia):

1. **Frescor (primário):** `fin_sync_log.completed_at` por empresa/recurso — sem sync `complete` há mais que o threshold = problema. (Responde "o sync rodou?", não "teve movimento?".)
2. **Falha HTTP (definitivo):** `net._http_response` com `status_code >= 400` em chamadas dos crons `fin-*`/`omie-*` nas últimas N h. É a verdade que o `job_run_details` esconde — exatamente o que mordeu no incidente.
3. **Cursor travado (secundário):** `fin_sync_cursor.next_page IS NOT NULL` há mais que Y (passada não fecha).

Para cada problema: `INSERT INTO fin_alertas (company, tipo, severidade='critico', mensagem, contexto) ... ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING`. **Se inseriu** (problema genuinamente novo, não dup) → enfileira email: `INSERT INTO fornecedor_alerta (empresa, tipo='outro', severidade='urgente', titulo, mensagem, status='pendente_notificacao')`. Quando o problema **deixa de ser detectado** → `dismissed_at = now()` no `fin_alertas` correspondente (re-alerta se recorrer).

> O `ON CONFLICT` na unique parcial faz o anti-spam: email só dispara na **transição** "ok→problema", não a cada tick.

### Componente 2 — `fin-sync-heartbeat` (cron diário, dias úteis)

Insere um `fornecedor_alerta` (`tipo='outro'`, titulo "Watchdog sync OK") com resumo: último `completed_at` por empresa/recurso, erros HTTP recentes, frescor CP/CR/mov → emailado. **Dead-man-switch**: se o email parar (canal morto), a ausência do heartbeat avisa o founder. Sem ele, o próprio email pode falhar silenciosamente (codex).

## Thresholds (iniciais, ajustáveis)

- Frescor: sem sync `complete` de uma empresa em **>18h** (syncs rodam 8h/14h + continuação) = stale.
- HTTP: qualquer `status_code >= 400` em cron fin/omie nas **últimas 6h**.
- Cursor: `next_page` pendente há **>2h**.

(Valores em `fin_config` ou constantes no SQL; calibrar após observar.)

## Constraint Lovable

Tudo é SQL → entregue via SQL Editor (`cron.schedule` + funções SQL), **sem deploy de edge function**. Cada bloco vem com query de validação (cron agendado + ativo; simular um alerta baixando o threshold temporariamente). Ritual via skill `lovable-db-operator`.

## Riscos / pontos abertos

- **Retenção do `net._http_response`:** pg_net poda linhas antigas; confirmar a janela disponível vs o threshold de 6h.
- **Calendário:** thresholds baseados em `fin_sync_log` (não em "teve movimento") já evitam falso-positivo de fim de semana; validar feriados.
- **Dívida semântica:** email via `fornecedor_alerta tipo='outro'` (tabela de fornecedor). Aceitável v1; caminho de email próprio do `fin_alertas` fica pra iteração 2.
- **Testabilidade:** lógica é SQL de cron → difícil unit-testar; validação = queries manuais + simular alerta. Registrar limite.

## Iteração 2 (futuro, fora deste spec)

Reconciliação contagem/valor Omie×Supabase; caminho de email nativo do `fin_alertas`; Telegram se o email se provar lento.
