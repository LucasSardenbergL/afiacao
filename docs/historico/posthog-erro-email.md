# PostHog → erro de produção por e-mail — entregas e lições

> Ponte **PostHog Error Tracking → e-mail pro founder**: erro que "aparece na tela" do app vira issue no PostHog (com stack + session replay) e dispara um e-mail enxuto, PII-safe, pro `NOTIFICATION_EMAIL_TO`. O PostHog faz o trabalho pesado (captura, agrupamento, replay); a gente só constrói a ponte. Registre aqui ao concluir; regra viva vai pro CLAUDE.md, lição reutilizável pro `docs/agent/`. Spec/plano: `docs/superpowers/{specs,plans}/2026-06-04-posthog-erro-email-*`.

## Visão geral

Feature **NO AR** ([#610](https://github.com/LucasSardenbergL/afiacao/pull/610)), **provada E2E em produção** (alerta `id=76` enfileirado → notificado por e-mail). Revisão adversária do codex (gpt-5.5 xhigh) no design: 5 P1 + P2 incorporados (dedupe, anti-tempestade, payload incerto, PII interna, ordem da migration).

```
App (posthog-js) ── autocapture (window.onerror + unhandledrejection) [+ captureException no ErrorBoundary, ⏳ falta Publish]
   ▼
PostHog Error Tracking ── agrupa em "issue" único + grava session replay
   │  alerta "issue created/reopened" → destino HTTP Webhook (Active, projeto 423408)
   ▼
edge `posthog-error-webhook` (verify_jwt=false) ── valida header `x-posthog-webhook-secret` (constant-time) → parse defensivo → RPC
   ▼
RPC `enfileirar_erro_app` (SECURITY DEFINER, ATÔMICO) ── dedupe (`project:issue:action`) + circuit breaker (≥10/30min → 1 rollup) + insert
   ▼
`fornecedor_alerta` (tipo `erro_app`, status `pendente_notificacao`)
   ▼
`dispatch-notifications` (cron pg_cron `*/30`, ZERO edição) → Gmail → founder
```

## Componentes (✅ LIVE)

- **Migration `20260604170000_posthog_error_webhook.sql`** (manual, SQL Editor): tabela `posthog_error_webhook_log` (`dedupe_key` UNIQUE = índice do dedupe; RLS sem policies — só service_role/definer) + RPC `enfileirar_erro_app` + CHECK de `fornecedor_alerta.tipo` estendido com `erro_app` (**10 valores**, partindo dos 9 reais, NÃO do snapshot stale). RPC validada em **PG17 local**.
- **Edge `posthog-error-webhook`** (Deno; `verify_jwt=false`): auth por segredo no header em constant-time → 401; parse defensivo (nunca lança, guarda `payload_raw` ~8KB); chama a RPC via service_role; **500 em falha de RPC** (o PostHog retenta — a transação recria sem duplicar nem perder); 200 em sucesso/dedupe.
- **Helpers puros (TDD, vitest) — espelhados verbatim na edge** (Deno não importa de `src/`): `parse-webhook` (`parsePosthogIssuePayload`), `dedupe-key` (`buildDedupeKey`/`buildRollupKey`), `email-body` (`buildErroAppAlerta`, PII-safe), `sanitize-route` (`stripQueryString`), **`lista-url` (`buildListaUrl`) — adicionado neste follow-up**.
- **`dispatch-notifications`** — reusado verbatim (já pega `erro_app` sem filtro de tipo; o Gmail auto-linka a URL do PostHog).

### Anti-flood (3 camadas)
1. **PostHog agrupa** → 1 alerta por erro ÚNICO novo (não por ocorrência).
2. **Dedupe na edge** (`dedupe_key` UNIQUE) → retry/reenvio do webhook não duplica.
3. **Circuit breaker** (CAP 10 `erro_app`/30min → 1 rollup "Tempestade de erros no app" com link da LISTA) → deploy ruim com N erros distintos vira 1 e-mail.

### Conteúdo do e-mail (PII-safe)
Nome do erro + mensagem técnica + rota **sem query string** + link pra issue no PostHog. **Sem** stack, person, e-mail ou dado de cliente (ficam no PostHog, login-gated) — porque `fornecedor_alerta` é lido por `employee` no `AlertaDrawer` E vai pro Gmail.

## Follow-up — fix do `listaUrl` do rollup (este PR)

**Bug (inócuo) na derivação do link da LISTA de issues** usado SÓ no e-mail de rollup (tempestade). O regex era `info.issueUrl.replace(/\/issues?\/.*/i, '/error_tracking')`, mas a `issue_url` real do PostHog é `https://us.posthog.com/project/{id}/error_tracking/{uuid}` — **sem** `/issues/` → o replace era **no-op** → o "ver todos os erros" apontava pra issue específica, não pra lista. Fix: regex `…/\/error_tracking\/.*/ → '/error_tracking'`.

- **Inócuo hoje:** o rollup só dispara em "tempestade" (≥10 erros únicos/30min — raro).
- **Extraído pra helper `src/lib/posthog-error/lista-url.ts` (TDD)** + espelhado verbatim na edge, fechando a única transformação que vivia **inline/sem teste** na edge (foi exatamente onde o no-op passou despercebido).
- ⚠️ **Exige redeploy manual** da edge `posthog-error-webhook` (chat do Lovable, verbatim — `merge ≠ prod`).

## ⏳ Follow-ups PENDENTES do founder

| # | Pendência | Por quê / nota |
|---|---|---|
| 0 | **Redeploy da edge** `posthog-error-webhook` (chat do Lovable) | ativa o fix do `listaUrl` acima. |
| a | **Publish do front** no Lovable | ativa `captureException` no `ErrorBoundary` (crashes de React renderizados). O **autocapture já cobre** `window.onerror` + `unhandledrejection`; o Publish só acrescenta os erros que o boundary pega. (T3) |
| b | **Webhook "issue reopened"** no PostHog | quando começarem a marcar issues como **Resolved**. O dedupe já inclui `action` (`project:issue:action`) → `created` e `reopened` **NÃO se suprimem** — já está pronto pra receber, sem mudança de schema. |
| c | **Spike alert** (opcional) | cobre issue antiga que volta a explodir **sem reabrir** ("issue created/reopened" não pega esse caso). Gap aceito na v1. (§5.2.3/§14) |
| d | **Source maps (T6)** | `@posthog/rollup-plugin` no `vite.config.ts`, **env-guarded** (no-op sem token → build do Lovable não quebra). Stack **des-minificado no PostHog** (não no e-mail). Best-effort. |

## 🔑 Lições

1. **Bug "inócuo" sobrevive onde não há teste.** A derivação do `listaUrl` era a **única** transformação inline (não-extraída, sem teste) da edge — e foi lá que o regex no-op morou. Extrair pra helper puro + teste vitest fechou o gap; toda lógica pura da edge deve nascer em `src/lib/*` testada e ser espelhada verbatim.
2. **Edge Deno não entra no CI** (`tsconfig.app.json`/`eslint.config.js` escopados a `src/`; vitest idem). A prova de uma mudança na edge é o **helper espelhado** em `src/lib/` (vitest) + redeploy manual — a edge em si só roda em produção.
3. **`dedupe_key` com `action`** (`project:issue:action`) é o que permite `created`/`reopened` coexistirem — o follow-up (b) é só ligar o evento no PostHog, sem tocar banco.
4. **Atomicidade dedupe↔insert na RPC** (transação plpgsql, não em TS): se o log de dedupe fosse gravado antes e o insert falhasse, o retry do PostHog seria dedupado e o alerta **se perderia**. Por isso `enfileirar_erro_app` faz tudo numa transação e a edge devolve **500** em falha (deixa o PostHog retentar).
