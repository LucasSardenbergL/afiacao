# Picking Offline-Capable + Optimistic UI + Fix de Handler — Design Spec

> **Data:** 2026-05-24
> **Status:** aprovado no brainstorming, pronto pra planejar
> **Autor:** brainstorming colaborativo (Lucas + Claude) com 2ª opinião do codex (consult, reasoning high)

## Goal

Tornar o **picking de chão de fábrica offline-capaz de verdade**: o separador, com luva e conexão ruim, confirma itens separados e o sistema responde em <100ms, persiste a operação offline e sincroniza sozinho ao reconectar — sem perder nada e sem dupla aplicação. Junto, **corrigir um bug latente** do mecanismo offline já em produção (handlers de flush registrados por página) que pode deixar mutações presas na fila para sempre.

Princípio não-negociável do briefing (CLAUDE.md §6 item 1) que ainda não estava coberto para picking.

## Contexto técnico (estado atual — auditado 2026-05-24)

A maior parte do offline-first **já está mergeada em main** (o CLAUDE.md §6/§9b está desatualizado dizendo "scaffold"):

- **Workbox** migrado de `NetworkOnly` → `NetworkFirst` para `picking_*`/`nfe_*`/`orders`/`sales_orders`/`profiles`/`tint_`/`farmer_`; `auth`+`realtime` seguem `NetworkOnly`. NetworkFirst só cacheia GET. ([vite.config.ts:61-152](../../../vite.config.ts))
- **Fila offline** em localStorage: `src/lib/offline-queue.ts` — `enqueue(kind, vars)`, `flush(handler)`, `getOfflineQueueDepth`, `subscribeToOfflineQueue`. `QueuedMutation = {id, kind, variables, enqueuedAt, attempts, lastError}`. Telemetria PostHog (`offline.queued/flushed/cleared`) já presente.
- **`useOfflineMutation`** (`src/hooks/useOfflineMutation.ts`): online-try → se `!navigator.onLine` OU erro de rede, `enqueue` e retorna `null` com flag `queued=true`; erro de aplicação propaga.
- **`useOfflineFlush` + `registerOfflineHandler`** (`src/hooks/useOfflineFlush.ts`): no evento `online` (e no mount se a fila não está vazia), `flush()` despacha cada item pro handler registrado pra aquele `kind`. Montado uma vez no `AppShell` ([AppShell.tsx:733](../../../src/components/AppShell.tsx)).
- **Recebimento** (`RecebimentoConferencia`) já usa `useOfflineMutation` para `confirm-unit`/`report-divergencia`/`add-cte`; `handleFinalize` é bloqueado offline de propósito. Serviços idempotentes em `src/services/recebimento-confirm.ts` e `recebimento-divergencia.ts`.
- **`NetworkStatusIndicator`** já mostra badge da fila.

### Lacunas reais (foco desta PR)

1. **Picking não tem escrita nenhuma.** `AdminEstoquePicking` e `TouchPickingView` são read-only; `handleScan` só dá um toast ([AdminEstoquePicking.tsx:227](../../../src/pages/AdminEstoquePicking.tsx)). Os `picking_task_items` nunca são gravados pela UI. Não há o que enfileirar porque não há mutação.
2. **`useOfflineMutation` não faz optimistic UI.** Enfileira e retorna `null`; nenhuma atualização de cache. O padrão canônico do repo é `SalesOrders.deleteOrder` (snapshot → `setQueryData` → rollback).
3. **Bug latente:** `registerOfflineHandler` é chamado **só dentro do `RecebimentoConferencia`** (useEffect) e desregistra no unmount ([RecebimentoConferencia.tsx:183-197](../../../src/pages/RecebimentoConferencia.tsx)). Se o conferente confirma offline e **sai da página**, ao reconectar o `flush` não acha handler → o item fica **preso na fila indefinidamente**.

### Schema de picking (tipos gerados — sem migration necessária)

- `picking_task_items(id, picking_task_id, quantidade, quantidade_separada, status, lote_fefo, lote_separado, validade_fefo, separado_at, localizacao, justificativa_substituicao, product_codigo, omie_codigo_produto, product_descricao, ...)`
- `picking_events(id, event_type, picking_task_id, picking_task_item_id, lote_esperado, lote_informado, justificativa, metadata jsonb, user_id, created_at)` — log de auditoria. RLS `WITH CHECK (has_role staff)` — **não restringe `id`**, então `id` fornecido pelo cliente é aceito.

## Decisões do brainstorming

1. **Escopo desta PR:** Picking offline + Optimistic + fix do handler. **Fora:** order-draft offline (`submitOrder`) → PR2; `AdminEstoquePicking` segue read-only (foco no `TouchPickingView`).
2. **`submitOrder` offline foi descartado** (registrado pra PR2): o `omie-vendas-sync` monta `codigo_pedido_integracao = PV_${id}_${Date.now()}` ([omie-vendas-sync:1238](../../../supabase/functions/omie-vendas-sync/index.ts)) e cria PV **cobrado** no ERP, sem idempotência → replay duplicaria pedido. O caminho seguro é rascunho-local + submit online (já existe `useOrderDraft`), trabalho de PR2.
3. **Sem migration de banco.** A idempotência do evento usa o PK `id` fornecido pelo cliente.
4. **`useOfflineMutation` fica estável** (sem refactor do retorno `null`/`queued`) — não regredir o recebimento. O caller de picking gera o `eventId` antes e já o possui.
5. **Optimistic = "fila-como-overlay"** (mais simples e mais robusto que o overlay-separado sugerido pelo codex): a fila offline já é o estado pendente persistido; mescla-se sobre as linhas do servidor na renderização.
6. **Divergência FEFO não bloqueia** — permite com justificativa obrigatória + evento de auditoria. Bloquear travaria o separador no chão.

## Arquitetura

### Componente 1 — Registro centralizado de handlers (fix do bug)

Novo `src/lib/offline-handlers.ts`:

```ts
export function registerAllOfflineHandlers(): () => void
```

Registra **uma vez, no boot**, todos os handlers de flush por `kind`, chamando os serviços idempotentes:
- `recebimento.confirm-unit` → `confirmUnit` (`services/recebimento-confirm.ts`, já existe)
- `recebimento.report-divergencia` → `reportDivergencia` (`services/recebimento-divergencia.ts`, já existe)
- `recebimento.add-cte` → `addCte` (`services/recebimento-cte.ts`, já existe)
- `picking.confirm-item` → `confirmPickItem` (`services/picking-confirm.ts`, **novo**)

> Os três serviços de recebimento já existem e são auto-contidos — o registro central só os importa; não há extração a fazer.

Cada handler: chama o serviço → retorna `true` (sucesso/idempotente) ou `false`/throw (mantém na fila com `attempts++`).

Mudanças:
- `useOfflineFlush` (ou `AppShell`) chama `registerAllOfflineHandlers()` no mount, **antes/junto** do listener `online`.
- `RecebimentoConferencia` **remove** os três `registerOfflineHandler` por-página (continua usando `useOfflineMutation` para o caminho online). Isso conserta o item-preso: reconectar em **qualquer** tela drena a fila.

### Componente 2 — Mutação `picking.confirm-item`

Novo serviço `src/services/picking-confirm.ts` (auto-contido, no espelho dos `recebimento-*`):

```ts
export interface ConfirmPickItemVars {
  eventId: string;            // crypto.randomUUID() no bipe — chave de idempotência
  pickingTaskId: string;
  pickingTaskItemId: string;
  userId: string | null;
  quantidade: number;         // esperada (deriva status)
  quantidadeSeparada: number; // ABSOLUTO — nunca incremento
  loteEsperado: string | null;
  loteInformado: string | null;
  justificativa: string | null;
  confirmedAt: string;        // ISO
}

export async function confirmPickItem(vars: ConfirmPickItemVars): Promise<{ ok: true }>
```

Passos (ordem importa pra idempotência):
1. **INSERT `picking_events`** `{ id: eventId, picking_task_id, picking_task_item_id, event_type, lote_esperado, lote_informado, justificativa, user_id }`. `event_type = (loteInformado && loteEsperado && loteInformado !== loteEsperado) ? 'lote_divergente' : 'item_confirmado'`. Se o erro for `23505` (PK duplicada, replay) → **engole e segue** (já aplicado).
2. **UPDATE `picking_task_items` (absoluto)** por `id`: `quantidade_separada = quantidadeSeparada`, `status = quantidadeSeparada >= quantidade ? 'concluido' : 'em_andamento'`, `lote_separado = loteInformado`, `justificativa_substituicao = justificativa`, `separado_at = confirmedAt`. Idempotente por ser absoluto.

**FEFO:** divergência (lote bipado ≠ `lote_fefo`) exige `justificativa` (validado na UI antes de chamar) e gera `lote_divergente`. Não bloqueia.

**UI** — em `TouchPickingView` (`ActiveTaskView`), cada item ganha ação "Confirmar separação" (`Button size="touch"`):
- **Caminho rápido:** confirma `quantidade` cheia com `lote_fefo` → `item_confirmado`.
- **Divergência:** expande mini-form (stepper de qtd + campo de lote, default `lote_fefo`, + `justificativa` obrigatória quando lote/qtd divergem).
- Gera `eventId = crypto.randomUUID()` no clique e chama `useOfflineMutation({ kind: 'picking.confirm-item', mutationFn: confirmPickItem })`.
- `mutation.queued === true` → toast "Salvo offline — sincroniza ao reconectar"; senão toast de sucesso.

### Componente 3 — Optimistic "fila-como-overlay"

Adições em `src/lib/offline-queue.ts`:
```ts
export function getQueuedByKind<TVars>(kind: string): QueuedMutation<TVars>[]
```
(lê a fila do localStorage e filtra por `kind`.)

Novo helper puro `src/lib/picking/optimistic-merge.ts`:
```ts
export function applyQueuedPickConfirms(
  serverItems: PickingTaskItemRow[],
  queued: ConfirmPickItemVars[],
): { items: PickingTaskItemRow[]; pendingIds: Set<string> }
```
Para cada item do servidor, se houver confirm enfileirado com o mesmo `pickingTaskItemId`, sobrepõe `quantidade_separada`/`status`/`lote_separado`/`separado_at` com o valor pendente (**o último da fila vence**). Retorna a lista mesclada (tipo de linha **inalterado** — sem poluir o row type) **e** um `Set<string>` com os `pickingTaskItemId` pendentes, que a UI usa pra marcar "✓ pendente sync". Helper **puro** (testável sem React/Supabase).

Integração no `TouchPickingView.ActiveTaskView`:
- O `useQuery` dos itens usa `select` (ou pós-processamento) aplicando `applyQueuedPickConfirms(serverItems, getQueuedByKind('picking.confirm-item').map(q => q.variables))`.
- Após `mutateAsync`: `queryClient.setQueryData(['touch-pk-items', taskId], ...)` para feedback instantâneo **e** assina `subscribeToOfflineQueue` para re-mesclar quando a fila muda. (O merge a partir da fila garante sobrevivência a refetch do `NetworkFirst` e a reload do PWA.)
- No flush bem-sucedido (fila esvazia) → `invalidateQueries(['touch-pk-items'])` → verdade do servidor (merge vira no-op).

**Por que não há double-apply:** o handler de flush escreve **só no servidor**; o overlay vem da fila; quando o item sai da fila (sucesso), o merge deixa de aplicá-lo e o `invalidate` traz a verdade. UI optimista nunca roda no flush.

## Data flow (picking confirmar item, offline → online)

```
[separador bipa/confirma item]
  → eventId = randomUUID()
  → setQueryData (optimistic instantâneo)  + enqueue('picking.confirm-item', vars)   (navigator offline)
  → badge da fila sobe; item aparece "✓ pendente" (merge da fila)
[reconecta → evento 'online']
  → useOfflineFlush.flush(dispatcher)
  → dispatcher acha handler 'picking.confirm-item' (registrado no boot)
  → confirmPickItem(vars): INSERT event (id=eventId; 23505 → ok) + UPDATE absoluto
  → item sai da fila → invalidateQueries → linha reflete servidor
```

## Error handling

- **Erro de rede** (online mas request falha): `useOfflineMutation` já detecta e enfileira.
- **Replay (PK duplicada `23505`)** no INSERT do evento: engolido no serviço → idempotente.
- **Erro de aplicação** (ex. RLS, item inexistente): propaga; no flush vira `false`/throw → fica na fila com `attempts++` e `lastError` (visível pra debug). Não há retry exponencial (YAGNI — herdado do scaffold).
- **Quota de localStorage:** a fila é compacta (sem blobs). Mesma limitação já aceita do scaffold.

## Testing

TDD com vitest (baseline atual: **686 verdes / 122 arquivos**):
- `confirmPickItem`: (a) update absoluto + status derivado; (b) INSERT `23505` engolido (replay) ainda roda o update; (c) divergência gera `event_type='lote_divergente'`; (d) caso normal gera `item_confirmado`. Mock do `supabase` no estilo dos testes existentes.
- `applyQueuedPickConfirms`: merge de pendentes sobre o servidor (último vence; item sem pendente intacto; flag de pendência).
- `registerAllOfflineHandlers`: registra todos os kinds esperados (incl. `picking.confirm-item`) e o dispatcher os encontra.
- Não regredir os testes de `useOfflineMutation`/`useOfflineFlush` existentes.

**QA offline real (obrigatório, não só testes):** `bun dev` → abrir `TouchPickingView` numa task → DevTools Network "Offline" → confirmar itens → ver feedback <100ms + badge da fila subir + item "pendente" → voltar online → flush automático → fila zera → estado do servidor confere. Rodar `/qa` do gstack ou browser pra não regredir as telas online (recebimento incluso).

## Scope boundaries (fora desta PR)

- Order-draft offline (`submitOrder`) → **PR2** (vendedor externo no carro).
- `AdminEstoquePicking` permanece read-only (a mutação vai no `TouchPickingView`; reaproveitável depois).
- Sem migration; sem refactor do retorno de `useOfflineMutation`; sem Background Sync via service worker; sem retry exponencial.
- Atualizar o CLAUDE.md (§6/§9b) refletindo o estado real do offline-first → item de fechamento, não bloqueante.
