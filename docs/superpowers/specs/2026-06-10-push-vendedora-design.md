# Push de verdade pra vendedora (Web Push) — design v1

> Frente 2 do programa "UX da Farmer" (2026-06-10). Frente 1 (home por persona + menu) em PR.
> Problema: NADA chega até a vendedora fora do app — e-mails de SLA/tarefa vão só pro founder
> (`dispatch-notifications` tem destinatário fixo `EMAIL_TO`); o `usePushNotifications` legado é
> notificação LOCAL via Realtime (só com o app aberto, foco no cliente de afiação).

## Decisão de arquitetura

**Web Push padrão (VAPID + Push API + service worker)** — sem vendor novo (OneSignal/FCM descartados),
protocolo gratuito do navegador. Viabilidade confirmada: `npm:web-push` roda no edge runtime Deno do
Supabase (guia testado no stack Lovable+PWA; nossas edges já usam `npm:` — ex. `@simplewebauthn/server`).

- **iOS 16.4+**: push só com PWA **instalado na tela de início** — fricção de onboarding único por
  vendedora (~5 pessoas, gerenciável por instrução do founder). Android Chrome: funciona direto.
- **Best-effort por design**: o push é um cutucão; a fonte da verdade continua sendo badge/card/inbox.
  Falha de push NUNCA pode quebrar o caminho que o dispara (webhook de mensagem, criação de tarefa).

## Peças

1. **Tabela `push_subscriptions`** (RLS own-only; service_role bypassa): `user_id`, `endpoint` UNIQUE,
   `subscription` jsonb (objeto completo do `PushSubscription.toJSON()`), `user_agent`, timestamps.
2. **SW**: `public/push-sw.js` (handlers `push` + `notificationclick`) injetado no SW gerado pelo
   vite-plugin-pwa via `workbox.importScripts` (generateSW suporta; sem migrar pra injectManifest).
3. **Front**: hook `usePushSubscription` (estados: unsupported / ios-precisa-instalar / pronto /
   ativo / negado) + `AtivarNotificacoesCard` no Meu Dia da vendedora (FarmerDashboardV2), dismissable.
   VAPID public key **hardcoded** (é pública por definição — evita fricção de env no Lovable).
4. **Edge `enviar-push`**: body `{ user_ids, titulo, corpo, url, tag }`, gate `x-cron-secret` (Vault),
   `npm:web-push`, TTL 1h; subscription 404/410 → DELETE (expirada). Helper de payload espelhado
   verbatim de `src/lib/push/payload.ts` (TDD).
5. **Produtores (SQL → `pg_net` → edge, padrão provado do projeto, `timeout_milliseconds` explícito)**:
   - **WhatsApp inbound** (maior valor): trigger AFTER INSERT em `whatsapp_messages` (`direction='in'`)
     → dona via `wa_owner_efetivo(customer_user_id)` (carteira+cobertura, reuso do SLA #587). Throttle
     sem tabela nova: pula se já houve msg `in` da MESMA conversa nos últimos 10min (burst = 1 push;
     `tag` por conversa agrupa no device). Conversa sem cliente/dona → sem push. **Corpo SEM o texto
     da mensagem** (LGPD lock screen): "Cliente X respondeu no WhatsApp".
   - **Tarefa nova**: trigger AFTER INSERT em `tarefas` → push pro `assigned_to`. Throttle 2min por
     responsável (criação em lote = 1 push).
   - **SLA estourado**: cron `*/15` chama `push_sla_tick()` — conversas na janela `[30, 50)` min úteis
     da `v_whatsapp_sla` → push pra dona. Janela + `tag` `sla-<conversa>` = no pior caso o 2º push
     substitui o 1º no device (sem duplicar visível).
   - Triggers são **best-effort blindados**: `EXCEPTION WHEN OTHERS → RAISE WARNING` (nunca derrubam
     o INSERT — o webhook do 360dialog e a criação de tarefa são mais importantes que o cutucão).

## Revisão adversarial (subagente, Caminho B) — achados incorporados

- **P1.1 (vazamento em device compartilhado)**: vendedora B logando no device onde A ativou
  ficava recebendo os pushes de A pra sempre (RLS own-only impedia o upsert de B reatribuir o
  endpoint). **Fix duplo**: RPCs SECURITY DEFINER `upsert_push_subscription` (endpoint pertence
  a quem está logado AGORA) + `delete_push_subscription`, e `limparPushDoDevice()` no `signOut`
  do AuthContext (unsubscribe + delete, best-effort; vive em `src/lib/push/device.ts` pra não
  criar ciclo de import).
- **P2.1 (re-push overnight do SLA)**: minutos úteis CONGELAM fora do expediente → conversa
  presa na janela seria re-enviada a noite/fim de semana inteiros (~248×). **Fix**: gate de
  expediente no `push_sla_tick` (mesma config da view). Limitação documentada: tick atrasado
  pode PULAR a janela (push perdido — best-effort; o card/badge é a verdade).
- **P2.4**: `push_sla_tick` ganhou EXCEPTION POR DONA (uma falha não derruba o tick das outras).
- **P2.5 (anti-amplificação)**: trigger só dispara em `direction='in' AND sender_user_id IS NULL`
  (inbound legítimo do webhook não tem sender humano — staff não faz o celular do colega apitar).
- **P2.2 (web-push em Deno é não-verificável local)**: `npm:web-push` usa node:crypto/https; o
  runtime tem node-compat mas o CI não checa edges → **smoke test ao vivo obrigatório no rollout**
  (ativar 1 device + `SELECT public._push_enviar(...)` no SQL Editor) antes de declarar pronto.
- **P2.3**: editar `public/push-sw.js` → RENOMEAR (versionar) — importScripts passa pelo HTTP cache.
- Aceitos sem fix (P3): push do SLA conta só a janela (não o backlog); throttle de tarefa sem
  índice (volume minúsculo); `serviceWorker.ready` pendura em DEV (PWA só monta em production —
  card fica oculto, sem quebra); pageview duplo na home.

## Não-objetivos v1

- Push pra cliente final (o legado Realtime já cobre o caso app-aberto).
- Preferências por tipo de evento (liga/desliga geral só — granularidade quando houver demanda).
- Retry/fila de push (best-effort; pg_net fire-and-forget).
- Deep-link pra conversa específica (`/whatsapp` v1; o inbox não tem query param de seleção).

## Rollout (3 passos manuais do founder, como sempre)

1. Migration no SQL Editor (bloco único).
2. Edge `enviar-push` via chat do Lovable + secrets `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`.
3. Publish do frontend. Vendedoras: ativar no card do Meu Dia (iPhone: instalar PWA antes).
