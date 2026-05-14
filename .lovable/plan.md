## Disparo assíncrono do portal Sayerlack

Hoje a edge function `enviar-pedido-portal-sayerlack` chama o Browserless e fica esperando até ~55s. Quando o portal Sayerlack está lento de verdade (>55s), o pedido falha mesmo que o portal aceitaria em 70-100s. Solução: desacoplar "disparar" de "esperar resposta" via callback.

## Arquitetura

```text
[Botão Disparar]
      |
      v
[enviar-pedido-portal-sayerlack]
   - valida mapeamentos + lock pessimista (pendente -> enviando)
   - dispara Browserless via EdgeRuntime.waitUntil (background)
   - retorna 202 em <2s para a UI
                        |
                        v
                  [Browserless executa script]
                  - login + adiciona itens + finaliza
                  - no fim: fetch(CALLBACK_URL, { pedido_id, ...resultado })
                        |
                        v
[sayerlack-portal-callback]  (NOVA edge, pública, x-callback-token)
   - valida token + idempotência (só age se status='enviando_portal')
   - sucesso: grava protocolo + chama criação do pedido de compra Omie
   - falha: grava erro + screenshot
                        |
                        v
[UI faz polling de 5s no status_envio_portal e atualiza]
```

## Mudanças

### 1. `enviar-pedido-portal-sayerlack/index.ts`
- Mantém validação, lock e montagem do payload Browserless
- A chamada `fetch(BROWSERLESS_URL, ...)` passa a rodar dentro de `EdgeRuntime.waitUntil(...)` — função retorna 202 imediatamente
- Remove o guard `TIMEOUT_INTERNO_MS = 55000` (Browserless pode usar até o cap dele)
- O `BROWSERLESS_FUNCTION` ganha um bloco final que faz `fetch(CALLBACK_URL, { headers: { 'x-callback-token': TOKEN }, body: JSON.stringify({ pedido_id, sucesso, protocolo, erro, screenshot_b64, trace }) })`
- Lote: dispara N pedidos em paralelo (cada um background) em vez de sequencial

### 2. NOVA `supabase/functions/sayerlack-portal-callback/index.ts`
- Pública (`verify_jwt = false` no `config.toml`), valida `x-callback-token` contra `SAYERLACK_CALLBACK_TOKEN`
- Body: `{ pedido_id, sucesso, protocolo?, erro?, screenshot_b64?, trace? }`
- Idempotente: `UPDATE ... WHERE id=? AND status_envio_portal='enviando_portal'`
- Se sucesso: extrai a lógica "criar pedido de compra Omie" hoje em `disparar-pedidos-aprovados/index.ts` para `_shared/criar-pedido-compra-omie.ts` e invoca aqui
- Se falha: persiste `portal_erro`, `portal_resposta`, `portal_screenshot_url` (upload no storage)

### 3. `disparar-pedidos-aprovados/index.ts`
- Hoje: dispara portal e espera síncrono antes de criar pedido Omie
- Depois: só dispara o portal (fire-and-forget); Omie é criado pelo callback
- Adiciona `?modo=watchdog`: marca como `falha_envio_portal` quem está em `enviando_portal` há mais de 3min

### 4. Watchdog (cron 5min)
- Insert via `supabase--insert` (não migration, contém anon key) chamando `disparar-pedidos-aprovados?modo=watchdog`

### 5. UI (`AdminPortalSayerlack.tsx` + `DispararAgoraButton.tsx`)
- Botão dispara, mostra toast "Em processamento" e fecha (sem spinner 60s)
- Lista faz `refetchInterval: 5000` enquanto houver pedido em `enviando_portal`
- Quando vira `enviado_portal` ou `falha_envio_portal`: toast + lista atualiza
- Indicador "em processamento há Xs" para pedidos com `enviado_portal_em` antigo

## Detalhes técnicos

- **`EdgeRuntime.waitUntil`**: API Supabase Edge que mantém worker rodando após response. Dá ~150s extras — suficiente para o cap de 60s do Browserless.
- **Token de callback**: novo secret `SAYERLACK_CALLBACK_TOKEN` (gerar uma vez). Browserless recebe via `context` injetado no payload.
- **Idempotência**: callback só atualiza se `status='enviando_portal'`. Callbacks duplicados ou tardios viram no-op.
- **URL pública callback**: `https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sayerlack-portal-callback` — Browserless alcança normalmente.
- **Rollback**: se algo der errado, basta reverter os arquivos e o watchdog libera os pedidos travados em até 3min.

## Critérios de sucesso

- Botão devolve resposta em <3s mesmo com portal lento
- Pedidos de 70-100s no portal passam a ter sucesso (hoje falham)
- Lote de 5 termina em ~60-90s (paralelo) vs ~5min (sequencial)
- Pedidos travados >3min em `enviando_portal` viram `falha_envio_portal` automaticamente

## Fora do escopo

- Otimização interna do script Puppeteer (opção 1) — pode somar depois sem conflito
- Retry automático de falhas — fica manual via "Disparar este pedido agora"
- Realtime (uso polling 5s; trocar por subscription depois é trivial)

## Pré-requisito

Vou pedir o secret `SAYERLACK_CALLBACK_TOKEN` antes de começar a implementação.