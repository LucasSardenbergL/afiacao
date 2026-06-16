# Pedido Offline (submitOrder rascunho-first) — Design Spec

> **Data:** 2026-05-24
> **Status:** aprovado no brainstorming, pronto pra planejar
> **Autor:** brainstorming colaborativo (Lucas + Claude). Arquitetura (rascunho-first, NÃO enfileirar) validada pelo codex no PR1 (consult de 2026-05-24).
> **Sequência:** PR2 do programa offline-first (PR1 = picking + optimistic + fix de loop, mergeado em #250).

## Goal

Dar ao **vendedor externo no carro** (persona do briefing, "frequente offline") uma experiência sã ao enviar pedido sem conexão: em vez de um erro de rede, o pedido fica **salvo como rascunho** e, quando a conexão volta, um **CTA "Enviar agora"** dispara o envio online real. O `submitOrder` continua estritamente online (sem fila), porque criar o pedido offline é perigoso.

## Contexto técnico (estado atual)

- **`submitOrder`** (`src/services/orderSubmission/submitOrder.ts`) orquestra inserts em `sales_orders` + criação de **PV cobrado no Omie** via edge function `omie-vendas-sync` (que monta `codigo_pedido_integracao = PV_${id}_${Date.now()}` — sem idempotência). Replay offline→online **duplicaria pedido/PV no ERP**. O recibo depende dos números de PV que o Omie devolve (não existem offline). → **NÃO enfileirar** (decisão herdada do PR1, codex-validada).
- **Auto-save de rascunho já existe**: `useOrderDraft` (`src/hooks/useOrderDraft.ts`) salva `{ cart, customerCodigoCliente, customerName, notes, ordemCompra }` em localStorage enquanto o cart > 0 (scope = `user.id`), limpa quando `orderSuccessOpen` (sucesso), e oferece restauração via `RestoreDraftDialog` ao voltar à tela com cart vazio (`UnifiedOrder.tsx:59-113`).
- **Botão de envio** vive em `CartSummaryBar.tsx` (`onSubmit={h.submitOrder}`, `submitting`, `disableSubmit = submitting || serviceItems.some(s=>!s.servico) || vendedorDivergencias.length>0`, label "Enviar pedido").
- **Rede**: `useNetworkStatus()` (`src/hooks/useNetworkStatus.ts`) expõe `{ online, quality, ... }`; `NetworkStatusIndicator` já no shell. Workbox `NetworkFirst` (PR #40).
- **`submitOrder` hoje não tem consciência de rede**: offline, ele chama o insert/Omie e estoura erro de rede → toast "Erro ao criar pedido". Nenhum estado "salvo como rascunho" nem CTA de reconexão.

## Decisões do brainstorming

1. **Não enfileirar `submitOrder`** — modelo rascunho-first (online-only commit). Motivo: PV cobrado + não-idempotente + recibo depende do Omie.
2. **Reconexão = CTA manual** "Enviar agora" (não auto-enviar) — evita disparar PV no ERP num momento indesejado.
3. **Alcance = mesma sessão (MVP)** — cobre o caso real (app aberto, sinal cai e volta; estado de entrega/pagamento/volumes segue em memória). O rascunho atual (cart/cliente/notes) é o backstop pra "fechou o app". **Cross-sessão** (persistir entrega/pagamento/volumes e enviar após reabrir offline) fica como **follow-up**.
4. **Sem migration, sem mudança no `submitOrder`/Omie.** Só camada de UI/estado em volta do submit.
5. **Vale pra staff e customer** (ambos usam `UnifiedOrder`); o alvo é o vendedor, mas o gate é genérico.

## Arquitetura

### 1. Hook `src/hooks/useOfflineSubmit.ts` (novo)

Gate fino e testável em volta do submit:

```ts
import { useState, useCallback } from 'react';
import { toast } from 'sonner';

export interface UseOfflineSubmitOptions {
  /** Função de envio online real (ex: h.submitOrder). */
  submit: () => void | Promise<void>;
  /** Estado de rede (de useNetworkStatus). */
  online: boolean;
  /** Há conteúdo a enviar (cart > 0)? Gate o CTA de reconexão. */
  hasContent: boolean;
}

export interface UseOfflineSubmitReturn {
  /** Handler do botão de envio: offline → marca pendente + toast; online → submit(). */
  onSubmit: () => void;
  /** True quando offline (pra UI do botão). */
  offline: boolean;
  /** Mostra o banner de reconexão (online + havia intent offline + tem conteúdo). */
  showReconnectCta: boolean;
  /** Handler do CTA "Enviar agora": limpa pendente + submit(). */
  onReconnectSubmit: () => void;
}

export function useOfflineSubmit({ submit, online, hasContent }: UseOfflineSubmitOptions): UseOfflineSubmitReturn {
  const [pending, setPending] = useState(false);

  const onSubmit = useCallback(() => {
    if (!online) {
      setPending(true);
      toast.info('Sem conexão — salvo como rascunho. Enviaremos quando reconectar.');
      return;
    }
    setPending(false);
    void submit();
  }, [online, submit]);

  const onReconnectSubmit = useCallback(() => {
    setPending(false);
    void submit();
  }, [submit]);

  return {
    onSubmit,
    offline: !online,
    showReconnectCta: online && pending && hasContent,
    onReconnectSubmit,
  };
}
```

> Observação de invariante: `pending` só vira `true` por clique offline. Quando `online` volta e ainda há `pending` + conteúdo, `showReconnectCta` acende. Após `submit()` (CTA ou clique online), `pending` zera. O sucesso do pedido limpa o rascunho pelo mecanismo existente (`clearTrigger: orderSuccessOpen`).

### 2. `UnifiedOrder.tsx`

- `const net = useNetworkStatus();`
- `const offlineSubmit = useOfflineSubmit({ submit: h.submitOrder, online: net.online, hasContent: h.cart.length > 0 });`
- Passar `onSubmit={offlineSubmit.onSubmit}` (no lugar de `h.submitOrder`) e `offline={offlineSubmit.offline}` pro `CartSummaryBar`.
- Renderizar o **banner de reconexão** acima do conteúdo quando `offlineSubmit.showReconnectCta`:

```tsx
{offlineSubmit.showReconnectCta && (
  <div className="rounded-md border border-status-info-bold/30 bg-status-info-bg px-4 py-3 flex items-center justify-between gap-3">
    <div className="flex items-center gap-2 text-sm text-status-info-bold">
      <Wifi className="w-4 h-4" />
      Conexão restabelecida. Seu pedido está salvo como rascunho.
    </div>
    <Button size="sm" onClick={offlineSubmit.onReconnectSubmit} disabled={h.submitting}>
      Enviar pedido agora
    </Button>
  </div>
)}
```

### 3. `CartSummaryBar.tsx`

- Nova prop opcional `offline?: boolean`.
- Botão de envio: quando `offline`, **não desabilita** por causa da rede (o vendedor pode "salvar rascunho"); troca ícone/label:
  - online: `<Send/> Enviar pedido` (atual).
  - offline: `<CloudOff/> Sem conexão — salvar rascunho`.
- `onClick={onSubmit}` em ambos (o gate decide o comportamento). `disableSubmit` mantém as validações de negócio (serviço sem seleção, divergência de vendedor) — essas valem offline também.
- O botão de **orçamento** (`onSubmitQuote`) fica desabilitado offline (depende de rede; fora do escopo do gate).

## Data flow

```
[vendedor offline clica "Enviar"]
  → useOfflineSubmit.onSubmit: online=false → setPending(true) + toast "salvo como rascunho"
  → (submitOrder NÃO é chamado; rascunho já auto-salvo via useOrderDraft)
[sinal volta → useNetworkStatus.online = true]
  → showReconnectCta = true → banner aparece
[vendedor clica "Enviar pedido agora"]
  → onReconnectSubmit: setPending(false) + submitOrder() (online normal, PV real, recibo real)
  → sucesso → orderSuccessOpen → rascunho limpa (clearTrigger existente)
```

## Error handling

- **Offline no clique**: interceptado pelo gate (não chama submit). Rascunho persiste.
- **Rede cai NO MEIO do submit** (estava online ao clicar): o `submitOrder` atual já trata parcial (insert ok + Omie falha → "PV (pendente ERP)") e erros (try/catch → toast). O gate não muda isso — fora do escopo do MVP.
- **`navigator.onLine` falso-positivo** (diz online mas request falha): cai no tratamento de erro existente do `submitOrder`. Aceitável no MVP (não tentamos detectar via timeout).

## Testing

- **`useOfflineSubmit` (TDD, vitest + renderHook):**
  - offline + onSubmit → NÃO chama `submit`, marca pendente (e `offline === true`).
  - online + onSubmit → chama `submit`.
  - online + pendente + hasContent → `showReconnectCta === true`; sem conteúdo → false.
  - onReconnectSubmit → chama `submit` e zera pendente (CTA some).
  - (mock de `sonner`.)
- Suíte completa verde (847+ baseline).
- **QA manual offline:** `bun dev` → UnifiedOrder com cart → DevTools Offline → "Enviar" → ver toast "salvo como rascunho" + botão "Sem conexão — salvar rascunho" → reconectar → banner "Enviar pedido agora" → clicar → pedido criado normal.
- **`/design-review`** nos estados offline (botão) e reconnect (banner) com screenshots, ajustando contra o design system v3.

## Scope boundaries (fora desta PR)

- **Cross-sessão**: persistir entrega/pagamento/volumes/ready-date no rascunho e restaurá-los pra permitir envio após fechar/reabrir offline. Follow-up.
- **Detecção de rede por timeout/heartbeat** (além de `navigator.onLine`).
- **Enfileirar/idempotência de `submitOrder`** (exigiria UUID de pedido + unique constraint + dedup no edge function antes do Omie) — explicitamente descartado.
- `submitQuote` offline.
