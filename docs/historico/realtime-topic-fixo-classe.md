# Realtime: topic de canal fixo — a classe e a triagem (2026-10-21)

**Origem:** alerta `erro_app` (empresa oben, 20/out) "cannot add `postgres_changes` callbacks for
realtime:dashboard-vendas-sales_orders after `subscribe()`". Conserto do cockpit no #3302; esta nota
registra a extensão à classe.

## Mecânica (realtime-js 2.117 — conferida no `dist/`)

- `client.channel(topic)` **deduplica por topic**: devolve o canal existente se ainda estiver na lista.
- O canal só sai da lista no `_onClose`, ou seja, **depois** do `phx_leave` responder (ou do timeout do
  push, 10s). `removeChannel` é async.
- Dois modos de falha com topic fixo:
  1. **throw** — 2 instâncias VIVAS do mesmo topic: a 2ª recebe o canal em `joining/joined` e o `.on()`
     lança (o incidente).
  2. **morte calada** — unmount→remount, ou efeito re-rodando, antes do leave confirmar: recebe o canal
     em `leaving`. O `.on()` não lança, o `subscribe()` é no-op (só age se `isClosed()`), e o canal some
     quando o leave confirma. Nenhum erro, nenhum evento.
- Socket desconectado é seguro: o leave dispara `ok` na hora e o canal sai da lista na hora.

## A lição nova: identidade de OBJETO como dep é caminho determinístico

`usePushNotifications` tinha `user` (objeto) nas deps. O `AuthContext` faz `setUser(session?.user)` a
**cada** evento de auth, inclusive o TOKEN_REFRESHED (~1×/h). O resultado era objeto novo com o mesmo id,
o efeito re-rodando no MESMO tick e o canal fixo em `leaving` reaproveitado. A notificação de status de
pedido morria calada após o 1º refresh. Não é corrida rara: acontece toda hora.

**Regra de triagem:** o caminho real NÃO é "a página remonta?". É "o efeito re-roda ou remonta dentro de
1 RTT do leave?". Deps com objeto, ou com callback que depende de objeto, re-rodam por identidade sem
que nada visível mude.

## Triagem dos 8 canais (PR desta nota)

| Canal | Decisão | Motivo |
|---|---|---|
| `usePushNotifications` `order-status-changes`, `new-training-modules` | **corrigido** | re-run determinístico por TOKEN_REFRESHED (acima). Módulo `plataforma`, ativo. |
| `Recebimento` `nfe_recebimentos_changes` | intocado | 1 rota, deps `[queryClient]` (singleton); só remonta saindo e voltando antes do leave responder (~1 RTT). |
| `AdminReposicaoPedidos` `gerir-pedidos-realtime` | intocado | idem. |
| `OrderChat` `order-messages-${orderId}`, `Orders` `orders-user-${id}` | intocado | módulo `loja-afiacao` 🧊 congelado ("sem receber correção", `mapa-do-app.md`). Também só tem remount por rota. |
| `useWhatsappInbox` `wa-conversations`, `wa-thread-${id}` | intocado | módulo `telefonia-whatsapp-rota` 🧊 congelado. |

Já geracionais antes: `useCockpitChannel` (#3302) e `useWhatsappSla` (`slaRealtimeGen`).

**Ao descongelar** `loja-afiacao` ou `telefonia-whatsapp-rota`: refaça a triagem dos canais deles. Ao
criar canal novo, use topic geracional por padrão (contador de módulo `++gen` sufixado). Custa um token e
elimina as duas falhas.

**Teste-modelo:** `RealtimeClient` REAL importado de `@supabase/supabase-js` (não de
`@supabase/realtime-js`, porque o knip acusa unlisted dependency) e `removeChannel` mockado como no-op
para reproduzir a janela. Ver `src/hooks/__tests__/usePushNotifications.topic.test.tsx`.
