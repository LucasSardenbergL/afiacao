# PostHog → erro de produção por e-mail — design

> Spec. Data: 2026-06-04. Autor: Claude + Lucas (founder). Revisão adversária: codex (gpt-5.5 xhigh) — 5 P1 + P2 incorporados (ver §15).

## 1. Objetivo

Erros de produção que "aparecem na tela" do app viram **issues no PostHog** (com stack + session replay) e disparam um **e-mail enxuto pro founder** (`NOTIFICATION_EMAIL_TO`), pra ele abrir o erro no PostHog e tratar no Claude Code. O PostHog faz o trabalho pesado (captura, agrupamento, replay); a gente só constrói a ponte PostHog→e-mail.

## 2. Estado atual (confirmado no código)

- **PostHog vivo** (`src/lib/analytics.ts`, `posthog-js ^1.226`). Session Replay ligado (`maskAllInputs:true`, mas `maskInputOptions.email:false`). `person_profiles:'identified_only'`. Opt-out em DEV. **Nenhum `captureException` ainda.**
- **`ErrorBoundary`** (`src/components/ErrorBoundary.tsx`) só faz `console.error` e mostra `error.message`. Montado em `App.tsx:203`, **abaixo** de `AuthProvider`/`ImpersonationProvider`/`CompanyProvider`/`ConditionalWebRTCProvider`.
- **Pipeline de e-mail pronto e validado** (WhatsApp SLA, ontem): `fornecedor_alerta` (`status='pendente_notificacao'`) → edge `dispatch-notifications` (cron pg_cron `*/30`) → Gmail pro `NOTIFICATION_EMAIL_TO`. Confirmado: **não filtra por tipo** (`dispatch-notifications/index.ts:281`, query só por status), renderiza `titulo`/`mensagem`/`metadata` no corpo, retry `tentativas<3`, `limit(50)`/ciclo sequencial.
- **CHECK de tipo atual** (verdade = última migration `20260604140000_whatsapp_sla_digest.sql`, NÃO o schema-snapshot que está stale com 7 valores): 9 valores — `promocao_suspensa, aumento_anunciado, promocao_nova, polling_erro, mapeamento_pendente, oportunidade_calculada, tarefa_atrasada, whatsapp_sla, outro`.

## 3. Decisões (fechadas com o founder)

| # | Decisão | Rejeitado |
|---|---------|-----------|
| D1 | **Canal:** PostHog captura/agrupa/replay → alerta "issue created/reopened" → **webhook** → edge nova → `fornecedor_alerta` → reusa `dispatch-notifications` → e-mail. | Pipeline 100% próprio (captura no browser); 100% nativo (alerta de insight por e-mail = threshold de volume, genérico). |
| D2 | **Latência:** ≤30 min — reusa o cron `*/30` do dispatch. Sem disparo imediato. | Disparo imediato (edge invoca dispatch na hora). |
| D3 | **Conteúdo do e-mail: enxuto + PII-safe** — nome do erro + mensagem técnica + rota sem query string + link pra issue no PostHog. **Sem** stack completo, person ou dados de cliente (ficam no PostHog, atrás do login). | Stack completo no e-mail (vaza PII pro Gmail E pra qualquer funcionário via `AlertaDrawer`). |

## 4. Arquitetura

```
App (posthog-js) ── captureException (ErrorBoundary) + autocapture (window.onerror/unhandledrejection)
   │
   ▼
PostHog Error Tracking ── agrupa em "issue" único + grava session replay
   │  (alerta "issue created/reopened" → destino HTTP Webhook)
   ▼
edge `posthog-error-webhook`  (verify_jwt=false)
   ├─ valida segredo (header, constant-time)
   ├─ loga payload_raw (modo descoberta + auditoria)
   ├─ parse defensivo → monta conteúdo individual PII-safe (TS, testável)
   └─ chama RPC `enfileirar_erro_app` (SECURITY DEFINER, ATÔMICO numa transação):
        DEDUPE (dedupe_key UNIQUE; já existe → no-op) +
        CIRCUIT BREAKER (≥CAP erro_app/30min → 1 rollup) +
        INSERT fornecedor_alerta(tipo='erro_app', status='pendente_notificacao')
   │
   ▼
dispatch-notifications (cron */30, JÁ existe, ZERO edição) → Gmail → founder
```

## 5. Componentes

### 5.1 Captura no front (mínima)
- **`src/lib/analytics.ts`**: +helper `captureException(error: unknown, context?: Record<string, unknown>): void` — wrapper igual ao `track` (no-op se `!initialized`; `try/catch` → `logger.warn`). Internamente `posthog.captureException(error, context)`.
- **`src/components/ErrorBoundary.tsx`**: no `componentDidCatch`, **adicionar** `captureException(error, { rota: stripQueryString(window.location.pathname + window.location.search), componentStack: errorInfo.componentStack })`. **Manter** o `console.error` (útil em DEV). Sem mudar a UI de fallback.
- **Autocapture** (config no painel, §5.2): cobre `window.onerror` + `unhandledrejection` (erros fora do boundary, ex. nos providers acima dele).
- ⚠️ **Não** ligar `capture_console_errors` no PostHog — senão o `console.error` do boundary vira um 2º `$exception` (dupla-contagem). Com só unhandled + `captureException` manual, não duplica.

### 5.2 Config no PostHog (founder faz no painel — sem código)
1. **Settings → Error tracking → Exception autocapture: ON** (unhandled errors + unhandled rejections). **Console errors: OFF.**
2. **Error tracking → Alerting → New notification** → trigger **"issue created or reopened"** → destino **HTTP Webhook** → URL da edge + **header** `x-posthog-webhook-secret: <segredo>`.
3. (Opcional, gap §14) **Spike alert** pra issue existente que volta a explodir sem reabrir.

### 5.3 Edge `supabase/functions/posthog-error-webhook/index.ts`
- `Deno.serve`; `verify_jwt=false` (declarar em `supabase/config.toml`). OPTIONS→CORS.
- **Auth:** lê o segredo de `Deno.env.get('POSTHOG_WEBHOOK_SECRET')`; compara com o header `x-posthog-webhook-secret` em **constant-time** (`timingSafeEqual`). Falha → 401. (Se um payload real trouxer assinatura HMAC, preferir verificá-la — confirmar no passo §12.)
- **Parse defensivo** (`parsePosthogIssuePayload`): extrai `{ issueId, name, message, issueUrl, firstSeen, action }` com fallbacks; nunca lança. Sempre guarda `payload_raw` (truncado ~8KB).
- **Monta o conteúdo individual** (`buildErroAppAlerta`, PII-safe — §6) em TS (testável): `{titulo, mensagem, metadata}` + `dedupe_key = buildDedupeKey({projectId, issueId, action})`.
- **Chama a RPC `enfileirar_erro_app`** (§5.4, SECURITY DEFINER, via service_role) passando o conteúdo individual + `rollup_key` (`buildRollupKey(now)`, janela 30min) + `lista_url` (link da lista de issues do PostHog) + `cap`. A RPC faz tudo numa **transação** — atomicidade dedupe↔insert é o ponto: se o log de dedupe fosse gravado **antes** e o insert do alerta falhasse, o retry do PostHog seria dedupado e o alerta **se perderia**. Dentro da transação:
   1. `insert posthog_error_webhook_log(dedupe_key) on conflict do nothing`; conflito → retorna `deduped` (nada criado).
   2. **circuit breaker:** conta `erro_app` em `criado_em > now()-'30min'`; `< CAP` (default **10**) → insere alerta individual (`tipo='erro_app', empresa='oben'` carrier, `severidade='atencao', status='pendente_notificacao'`, titulo/mensagem/metadata); `≥ CAP` → insere **1 rollup** (dedupado por `rollup_key`; titulo "Tempestade de erros no app", mensagem fixa + `lista_url`; não enumera — PII + simplicidade).
   3. `update` do log com `alerta_id`; retorna `status` (`deduped`/`enfileirado`/`rollup`) + `alerta_id`.
- **Erros:** falha na RPC → **500** (o PostHog retenta; a transação garante que o retry **recria** sem duplicar nem perder). Sucesso/dedupe → 200. **Nunca** 200 com insert falho (= perda silenciosa).
- Sempre `console.log` do `payload_raw` truncado (modo descoberta — pro 1º payload real e debug).

### 5.4 Migration `supabase/migrations/20260604170000_posthog_error_webhook.sql` (MANUAL)
- **Tabela `posthog_error_webhook_log`**: `id bigint generated always as identity pk`, `dedupe_key text not null unique`, `issue_id text`, `action text`, `payload_raw text`, `alerta_id bigint` (ref lógico p/ fornecedor_alerta), `criado_em timestamptz default now()`. `enable row level security` **sem policies** (só service_role/definer escrevem — padrão das tabelas de motor). O `dedupe_key` UNIQUE já é o índice do dedupe; o circuit breaker conta `fornecedor_alerta` (volume baixo, sem índice novo).
- **RPC `enfileirar_erro_app(p_dedupe_key, p_titulo, p_mensagem, p_metadata, p_rollup_key, p_lista_url, p_cap)` `SECURITY DEFINER` `set search_path=public`**: dedupe + circuit breaker + insert **atômico** (§5.3) numa única transação plpgsql; retorna `{status, alerta_id}`. `revoke execute from public, anon, authenticated; grant execute to service_role` (a edge chama via service_role; no Supabase, `REVOKE FROM PUBLIC` não basta — revogar de `anon`/`authenticated` por nome). Validada em **PostgreSQL 17 local** (padrão do projeto: asserts de dedupe/rollup/cap sobre o schema-snapshot).
- **Estende o CHECK** partindo dos **9 valores atuais** (NÃO do snapshot stale) + `erro_app`:
  ```sql
  alter table public.fornecedor_alerta drop constraint if exists fornecedor_alerta_tipo_check;
  alter table public.fornecedor_alerta add constraint fornecedor_alerta_tipo_check
    check (tipo in ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
                    'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla',
                    'erro_app','outro'));
  ```

### 5.5 `dispatch-notifications` — ZERO edição
Reusa verbatim. Já pega `erro_app` (sem filtro de tipo), renderiza `titulo`/`mensagem`/`metadata`, manda Gmail. O Gmail auto-linka URLs em texto → o link do PostHog fica clicável.

### 5.6 Source maps (best-effort, não bloqueante)
Tentativa na v1: adicionar o plugin oficial de source maps do PostHog ao `vite.config.ts`, **guardado por env** (`POSTHOG_*` ausente → no-op, build segue). Beneficia o stack **no PostHog** (onde o founder lê), não o e-mail. Se o build do Lovable não injetar a env / não cooperar → cai pra v2; **o e-mail nunca promete stack des-minificado** (só linka o PostHog). Decisão de incluir no escopo do plano como tarefa opcional/isolada.

## 6. Conteúdo do e-mail (PII-safe — `buildErroAppAlerta`)
- `titulo`: `Erro no app: <name truncado>`.
- `mensagem`: `<message técnica>` + `\n` + `Rota: <path sem query string>` + `\n` + `Ver no PostHog (stack + replay): <issueUrl>`.
- `metadata`: `{ erro: name, rota: pathSemQS, ocorrencias?: n, primeira_vez?: firstSeen }` — **só campos técnicos/seguros**.
- **Proibido** no titulo/mensagem/metadata: stack completo, `person`/e-mail, payload de formulário, query string, qualquer valor de dado de cliente. (Razão: `fornecedor_alerta` é lido por `employee` no `AlertaDrawer` `src/components/notificacoes/AlertaDrawer.tsx` + vai pro Gmail.)
- `severidade`: `atencao`.

## 7. Anti-flood (3 camadas)
1. **PostHog agrupa** → 1 alerta por erro ÚNICO novo (não por ocorrência). Repetição do mesmo erro não gera e-mail novo.
2. **Dedupe na edge** (`dedupe_key` UNIQUE) → retry/reenvio do webhook não duplica.
3. **Circuit breaker** (CAP 10/30min → rollup) → deploy ruim com muitos erros distintos vira 1 e-mail, não N. + o `limit(50)` do dispatch.

## 8. Segurança
- `verify_jwt=false` (webhook externo não manda JWT do Supabase) — correto e já é padrão no projeto.
- Segredo em **header** (`x-posthog-webhook-secret`), **não** em query string (não vaza em logs/URL). Comparação **constant-time**.
- Secret novo: `POSTHOG_WEBHOOK_SECRET` (env da edge, setado no Lovable). Forte, aleatório.
- Se o payload real trouxer assinatura HMAC do PostHog → preferir verificá-la (confirmar no §12).

## 9. PII / LGPD
- E-mail/alerta: §6 (sem PII). O detalhe sensível fica no PostHog (login-gated).
- ⚠️ **Observação registrada (fora de escopo):** `analytics.ts` tem `maskInputOptions.email:false` → e-mails aparecem no session replay. Reavaliar antes de distribuir links de replay amplamente. Não mexer agora (muda comportamento do replay existente).

## 10. Helpers puros (TDD, vitest) — espelhados verbatim no edge (Deno não importa de `src/`)
- `src/lib/posthog-error/parse-webhook.ts` — `parsePosthogIssuePayload(raw): IssueInfo` (defensivo, fallbacks, nunca lança).
- `src/lib/posthog-error/dedupe-key.ts` — `buildDedupeKey({projectId, issueId, action}): string` + `buildRollupKey(now): string` (janela de 30min).
- `src/lib/posthog-error/email-body.ts` — `buildErroAppAlerta(info): {titulo, mensagem, metadata}` (PII-safe; asserta ausência de stack/person).
- `src/lib/posthog-error/sanitize-route.ts` — `stripQueryString(url): string`.

> O **dedupe + circuit breaker + insert atômico** vive na RPC SQL `enfileirar_erro_app` (§5.4), validada em PG17 local — não em TS (precisa de transação). Os helpers TS acima cobrem o que é puro (parse, chaves, corpo PII-safe, rota).

## 11. Sequência de rollout (ORDEM OBRIGATÓRIA — codex P1)
1. **Migration** (§5.4: tabela + RPC + CHECK) colada no SQL Editor → validar (tabela + RPC + CHECK com 10 valores). **Antes de tudo** — senão a edge falha.
2. **Deploy da edge** `posthog-error-webhook` (via chat do Lovable, verbatim) + setar `POSTHOG_WEBHOOK_SECRET`.
3. **Testar** a edge: capturar 1 payload real (§12) → confirmar parse + insert + e-mail no próximo ciclo `*/30`.
4. **Habilitar o alerta** no PostHog (§5.2) só depois que a edge responde 200 a um payload real.
5. **Publish do front** (captura) — `captureException` no ErrorBoundary.

## 12. Passo de descoberta do payload (codex P1 — não codar o parser final às cegas)
A doc do PostHog **não garante** o JSON exato do webhook de alerta. Antes de finalizar o parser/template:
- Opção A: no PostHog, criar o alerta apontando pra **webhook.site**, disparar um erro de teste, copiar o payload real.
- Opção B: apontar pra edge (modo descoberta — ela já loga `payload_raw`), disparar erro de teste, ler o log no Lovable.
- Com o payload real em mãos, ajustar `parsePosthogIssuePayload` e o template. A edge é **defensiva** desde o dia 0 (extrai o que reconhece, guarda o raw) → funciona mesmo antes do refino.

## 13. Não-objetivos (YAGNI)
- Digest completo enumerando erros (o rollup só linka a lista do PostHog).
- Capturar `console.error` / erros engolidos em `catch` / erros async não-propagados (não viram exception; v2 se precisar).
- Disparo imediato (D2 = ≤30min).
- Mexer no `maskInputOptions`/replay existente.
- UI nova no app pra ver erros (o PostHog já é a UI).
- Stack des-minificado garantido (source maps é best-effort).

## 14. Limitações / gaps conhecidos
- **Cobertura do ErrorBoundary:** abaixo dos providers (`App.tsx:193`) → erro em `AuthProvider`/`CompanyProvider` fica fora do boundary, mas o **autocapture global** (`window.onerror`) cobre o que borbulhar pro window. Erro engolido em `catch`/async/toast não é capturado (by design).
- **Spike de issue existente:** "issue created/reopened" não cobre bug antigo que volta a explodir sem reabrir. Mitigação opcional: spike alert (§5.2). v1 aceita o gap.
- **Link de replay:** o alerta issue-level pode não trazer `$session_id` → linkamos a **issue** (não o replay direto); o founder abre o replay/"Fix with AI" lá dentro.
- **Latência:** ≤30 min (cron). Tempestade pode estender (backlog do `limit(50)`), mitigada pelo rollup.

## 15. Achados do codex incorporados (rastreabilidade)
- **P1 dedupe** → §5.3/§5.4 (`posthog_error_webhook_log` + `dedupe_key` UNIQUE).
- **P1 anti-tempestade** → §5.3/§7 (circuit breaker + rollup).
- **P1 payload incerto** → §5.3/§12 (parse defensivo + passo de descoberta).
- **P1 PII interna** → §6/§9 (e-mail enxuto; `fornecedor_alerta` lido por employee).
- **P1 ordem da migration** → §11.
- **P2** segredo header/constant-time (§8), não-`console_errors` (§5.1), link issue (§14), source maps best-effort (§5.6), cobertura ErrorBoundary (§14), 500-em-falha (§5.3), LGPD maskInputOptions (§9).
