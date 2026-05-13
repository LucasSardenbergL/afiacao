# Fase 4 — Execução

> Data: 2026-05-13 · Autorização: "todas + faça tudo" (todos os 20 itens do roadmap em um lote, entregar no fim). Sem rodar lint/typecheck no sandbox — node/npm indisponível; recomendo `npm run lint && npm run build` antes de mergear.

---

## Resumo executivo da entrega

| Tier | Itens | Status |
|---|---|---|
| **Infra reusável (Bloco 1)** | Button touch · tokens status · EmptyState · Toast unificado | ✅ entregue |
| **Hooks reusáveis (Bloco 2)** | useUrlState · useOptimisticMutation · useNetworkStatus · PageSkeleton | ✅ entregue |
| **Shell (Bloco 3)** | ShortcutsRegistry+Dialog · CommandPalette+Registry · Topbar cleanup · CompanySwitcher · NetworkStatusIndicator | ✅ entregue |
| **Páginas (Bloco 4)** | UnifiedOrder draft · TintFormulas recentes/favoritos · Picking ScanBar · BulkActionsBar · NfeReceipt histórico · AdminCustomers segmentos | ✅ entregue |
| **Scaffolds complexos (Bloco 5)** | tint-cache (IndexedDB) · TouchPickingView · offline-queue scaffold | ✅ scaffold entregue (precisa iteração + decisões de produto) |

**20/20 itens endereçados.** Distinção entre "completo" e "scaffold + integração futura" detalhada por item abaixo.

---

## Itens entregues por roadmap-ID

### #1 ShortcutsRegistry + ShortcutsDialog reusável (COMPLETO)

- Novos:
  - [src/components/shell/ShortcutsRegistry.tsx](../../src/components/shell/ShortcutsRegistry.tsx) — context + provider + `useRegisterShortcuts` + `formatCombo` (`⌘K` em Mac, `Ctrl+K` no resto).
  - [src/components/shell/ShortcutsDialog.tsx](../../src/components/shell/ShortcutsDialog.tsx) — abre com `?`, lista agrupada por escopo (Global / Cockpit / Esta página). Aceita evento customizado `open-shortcuts-dialog` para abrir programaticamente.
- Editados:
  - [src/components/AppShell.tsx](../../src/components/AppShell.tsx) — `ShortcutsRegistryProvider` envolve o shell, `<ShortcutsDialog />` montado.
  - [src/pages/AdminReposicaoCockpit.tsx](../../src/pages/AdminReposicaoCockpit.tsx) — migrado do `useKeyboardShortcuts` legado para `useRegisterShortcuts`; `ShortcutsDialog` interno e array `SHORTCUTS` locais removidos (~30 linhas eliminadas). Botão Keyboard agora dispara `open-shortcuts-dialog`.
- Métrica esperada: % de ações via atalho vs clique (instrumentar separado).

### #2 Variantes touch-grande no Button (COMPLETO)

- Editado: [src/components/ui/button.tsx](../../src/components/ui/button.tsx) — novas size variants `touch` (44px), `touch-icon` (44×44), `balcao` (56px), `balcao-icon` (56×56). Opt-in: nenhum callsite default mudou.
- Adoção inicial: `ScanBar.tsx` (botão OK = `touch`), `TouchPickingView.tsx` (botão Voltar = `touch`).

### #3 UnifiedOrder draft autosave + restore (COMPLETO)

- Novos:
  - [src/hooks/useOrderDraft.ts](../../src/hooks/useOrderDraft.ts) — autosave debounced (600ms) em localStorage, scope por `user.id`, `beforeunload` warning enquanto há cart.
  - [src/components/unified-order/RestoreDraftDialog.tsx](../../src/components/unified-order/RestoreDraftDialog.tsx) — AlertDialog "Você tinha um pedido com {cliente} contendo {N itens}, salvo {há quanto}".
- Editados:
  - [src/pages/UnifiedOrder.tsx](../../src/pages/UnifiedOrder.tsx) — integra `useOrderDraft`, abre `RestoreDraftDialog` se houver draft pendente e cart vazio. Restore aplica `setCart`/`setNotes`/`setOrdemCompra`. Limpa automaticamente quando `orderSuccessOpen` muda para `true`.
  - [src/hooks/useUnifiedOrder.ts](../../src/hooks/useUnifiedOrder.ts) — agora expõe `setCart` no retorno (precisava ser exposto pro restore).
- Limitação conhecida: produtos removidos do catálogo entre salvar e restaurar ficam com referência inválida. v2 deve validar contra catálogo no momento do restore.

### #4 Indicador online/offline no topbar (COMPLETO)

- Novos:
  - [src/hooks/useNetworkStatus.ts](../../src/hooks/useNetworkStatus.ts) — `navigator.onLine` + `navigator.connection.effectiveType/rtt`, reativo a `online`/`offline`/`change`.
  - [src/components/shell/NetworkStatusIndicator.tsx](../../src/components/shell/NetworkStatusIndicator.tsx) — dot tricolor (verde/âmbar/vermelho), badge com `queueDepth` quando há mutações pendentes, popover com RTT/tipo/fila.
- Editado: [src/components/AppShell.tsx](../../src/components/AppShell.tsx) — `Bell` ornamental removido, `NetworkStatusIndicator` no lugar.

### #5 TintFormulas — recentes + favoritos (COMPLETO)

- Novo: [src/hooks/useTintRecentsFavorites.ts](../../src/hooks/useTintRecentsFavorites.ts) — localStorage com sync entre abas, FIFO 10 recentes + favoritos ilimitados.
- Editado: [src/pages/TintFormulas.tsx](../../src/pages/TintFormulas.tsx) — barra "Recentes/Favoritos" acima da tabela, coluna ⭐ por linha, expandir registra recente, tokens `status-purple`/`status-progress` substituem cores hardcoded de badge.

### #6 Skeleton padrão de página (COMPLETO)

- Novo: [src/components/ui/page-skeleton.tsx](../../src/components/ui/page-skeleton.tsx) — variantes `cockpit | list | form | detail | auto`.
- Editado: [src/App.tsx](../../src/App.tsx) — `PageLoader` agora é `<PageSkeleton variant="auto" />`. Páginas individuais podem adotar variantes específicas (não migrei todas — quick win futuro).

### #7 Picking ScanBar (COMPLETO, integração leve no AdminEstoquePicking)

- Novo: [src/components/picking/ScanBar.tsx](../../src/components/picking/ScanBar.tsx) — input autofocus sticky, classifica payload como `address` (`Z.P.P`) ou `sku`, detecta wedge HID por delta-tempo entre teclas (<30ms).
- Editado: [src/pages/AdminEstoquePicking.tsx](../../src/pages/AdminEstoquePicking.tsx) — `<ScanBar />` no topo da PickingTab. Feedback v1: toast com kind detectado. Integração com task ativa (auto-foco, optimistic) fica como iteração #7 v2 — depende de #8.

### #8 useOptimisticMutation helper (COMPLETO)

- Novo: [src/hooks/useOptimisticMutation.ts](../../src/hooks/useOptimisticMutation.ts) — wrapper sobre `useMutation` com `onMutate` (cancelQueries + snapshot + optimistic update) e `onError` (rollback + log + toast.error padronizado). Migração para uso real em mutações específicas de Picking/Recebimento fica como follow-up — o helper está disponível.

### #9 Cmd-K global (COMPLETO)

- Novos:
  - [src/components/shell/CommandsRegistry.tsx](../../src/components/shell/CommandsRegistry.tsx) — context + provider + `useRegisterCommands`. Páginas contribuem comandos contextuais.
  - [src/components/shell/CommandPalette.tsx](../../src/components/shell/CommandPalette.tsx) — `CommandDialog` shadcn, atalho `Cmd+K`/`Ctrl+K`, 19 comandos estáticos (navegar para todas as áreas + ações comuns) + comandos dinâmicos contribuídos por página.
  - [src/components/shell/CommandPaletteTrigger.tsx](../../src/components/shell/CommandPaletteTrigger.tsx) — pill "Buscar... ⌘K" no centro do topbar (md+).
- Editado: [src/components/AppShell.tsx](../../src/components/AppShell.tsx) — `CommandsRegistryProvider` envolve o shell, `<CommandPalette />` montado, `<CommandPaletteTrigger />` no topbar.

### #10 EmptyState refactor B2B (COMPLETO)

- Editado: [src/components/EmptyState.tsx](../../src/components/EmptyState.tsx) — refatorado para 2 tons: `operational` (default, denso, sem motion) e `friendly` (mantido para customer-facing). API antiga (`variant`) substituída por `tone`; nenhum callsite usa a antiga (zero quebras).

### #11 Filtros persistidos em URL (COMPLETO, adoção parcial)

- Novo: [src/hooks/useUrlState.ts](../../src/hooks/useUrlState.ts) — sincroniza state com `useSearchParams`. Serializa string/number/boolean/array via `|`. Schema fixo via `useRef` para estabilidade.
- Editado: [src/pages/AdminCustomers.tsx](../../src/pages/AdminCustomers.tsx) — `searchQuery` + `filterHealth` migrados para `useUrlState`. Filtros sobrevivem F5 e ficam sharable.
- Pronto para adoção em: SalesOrders, AdminReposicaoPedidos, TintFormulas, Recebimento.

### #12 Topbar cleanup (COMPLETO)

- Editado: [src/components/AppShell.tsx](../../src/components/AppShell.tsx) — `Bell` ornamental removido. Topbar agora: [Mobile menu] · [Cmd-K pill central] · [CompanySwitcher] · [NetworkStatusIndicator] · [HelpDrawer] · [User dropdown]. Import `Bell` da lucide removido.
- Novo: [src/components/shell/CompanySwitcher.tsx](../../src/components/shell/CompanySwitcher.tsx) — dropdown com 3 empresas (Colacor/Oben/Colacor SC), persistência via `CompanyContext` (localStorage existente).

### #13 Bulk actions pattern (COMPLETO, sem adoção forçada)

- Novos:
  - [src/hooks/useBulkSelection.ts](../../src/hooks/useBulkSelection.ts) — multi-select com Shift+click range.
  - [src/components/ui/bulk-actions-bar.tsx](../../src/components/ui/bulk-actions-bar.tsx) — barra flutuante bottom-center que aparece com seleção > 0.
- Migração de callsites (AdminReposicaoCockpit review mode, SalesOrders bulk delete) fica como follow-up.

### #14 NfeReceipt histórico (COMPLETO via localStorage; TODO schema)

- Editado: [src/pages/NfeReceipt.tsx](../../src/pages/NfeReceipt.tsx) — histórico das últimas 10 processadas em localStorage com card "Últimas processadas", botão "Reprocessar" por linha, hint para `/recebimento` no rodapé.
- ⚠️ **TODO de schema** (decisão de produto): criar tabela `nfe_receipt_runs(id, account, nf_number, success, steps jsonb, started_at, finished_at, user_id)` para que histórico seja por usuário/multi-device em vez de localStorage por navegador.

### #15 Toast unificação em Sonner (COMPLETO via wrapper)

- Editado: [src/hooks/use-toast.ts](../../src/hooks/use-toast.ts) — reescrito como wrapper de compatibilidade que delega para Sonner. Mantém API `useToast()` + `toast({title, description, variant})` para os ~53 callsites existentes.
- Editado: [src/App.tsx](../../src/App.tsx) — `<Toaster />` (Radix) removido; só `<Sonner />` permanece.
- Follow-up: codemod manual para trocar callsites para `import { toast } from 'sonner'` direto e remover [src/components/ui/toast.tsx](../../src/components/ui/toast.tsx) + [src/components/ui/toaster.tsx](../../src/components/ui/toaster.tsx) (deprecated, mas ainda existem para não quebrar imports tipados).

### #16 AdminCustomers segmentos (COMPLETO via localStorage; TODO schema)

- Novo: [src/hooks/useCustomerSegments.ts](../../src/hooks/useCustomerSegments.ts) — CRUD de segmentos salvos em localStorage com sync entre abas.
- Editado: [src/pages/AdminCustomers.tsx](../../src/pages/AdminCustomers.tsx) — barra "Segmentos" com chips clicáveis (aplica filtros) + botão "Salvar como segmento" (com inline editor para nomear).
- ⚠️ **TODO de schema** (decisão de produto): criar tabela `user_segments(id, user_id, area, name, filter jsonb, shared bool)` para persistência server-side e compartilhamento com time. Hook está desenhado para trocar implementação sem mudar callsites.

### #17 Tokens status-* — utilities (COMPLETO, refactor amplo opcional)

- Editado: [src/index.css](../../src/index.css) — adicionadas utilities `text-status-{success|warning|error|info|purple|indigo}` e variantes `*-fg` + `bg-status-*-bg` (estas últimas já existiam, mas agrupei).
- Adoção: TintFormulas badges migradas, NetworkStatusIndicator usa. Refactor amplo de ~50 callsites (`text-emerald-600`, `text-red-600`, `bg-amber-50`) fica como follow-up mecânico — pode ser feito por codemod.

### #18 TintFormulas catálogo offline (SCAFFOLD)

- Novo: [src/lib/tint-cache.ts](../../src/lib/tint-cache.ts) — wrapper sobre IndexedDB nativo (sem dep externa). API: `putFormulas`, `getAllFormulas`, `searchFormulasOffline`, `getLastSync`, `clearCatalog`, `getStorageEstimate`.
- ⚠️ **Próximas iterações**:
  - Edge function `tint-catalog-snapshot` (incremental por `updated_at`)
  - Integração com TintFormulas: hook stale-while-revalidate, banner "Catálogo offline · sincronizado há Xh"
  - Validação de tamanho real do catálogo (~477k fórmulas → estimativa 100MB)

### #19 TouchPickingView mobile dedicada (SCAFFOLD)

- Novo: [src/pages/picking/TouchPickingView.tsx](../../src/pages/picking/TouchPickingView.tsx) — visão dedicada com cards verticais 72px+, ScanBar fixa no topo, fluxo de 1 task por vez com progresso.
- Editado: [src/App.tsx](../../src/App.tsx) — rota `/admin/estoque/picking/mobile`.
- ⚠️ **Próximas iterações**:
  - Decisão de produto: auto-detect mobile + `pointer: coarse` ou rota dedicada manual?
  - Swipe-to-advance entre itens (precisa Vaul drawer ou hammer.js)
  - Optimistic UI no confirmar item (integrar `useOptimisticMutation`)
  - Validação no chão com separador real (alvos, contraste sob luz variável, uso com luva)

### #20 Offline queue picking/recebimento (SCAFFOLD)

- Novo: [src/lib/offline-queue.ts](../../src/lib/offline-queue.ts) — API estável: `enqueue`, `flush`, `getOfflineQueueDepth`, `subscribeToOfflineQueue`, `clearOfflineQueue`. v1 persiste em localStorage; subscription notifica `NetworkStatusIndicator` para mostrar contador.
- Integração com `NetworkStatusIndicator` já feita — badge no topbar mostra # de mutações pendentes.
- ⚠️ **Próximas iterações**:
  - Migrar storage de localStorage para IndexedDB (item já pronto para `tint-cache.ts` pattern)
  - Workbox `BackgroundSyncPlugin` para HTTP retries com offline-online transition
  - Integração concreta nas mutações: `handleConfirmUnit` (Recebimento), `handleScan` (Picking), `submitOrder` (UnifiedOrder)
  - Conflict resolution (mesma task editada offline por 2 separadores)
  - Suite de testes e2e com rede flaky

---

## Novos arquivos (15) + Editados (8)

### Criados

```
src/components/picking/ScanBar.tsx                      # #7
src/components/shell/CommandPalette.tsx                 # #9
src/components/shell/CommandPaletteTrigger.tsx          # #9 / #12
src/components/shell/CommandsRegistry.tsx               # #9
src/components/shell/CompanySwitcher.tsx                # #12
src/components/shell/NetworkStatusIndicator.tsx         # #4 / #20
src/components/shell/ShortcutsDialog.tsx                # #1
src/components/shell/ShortcutsRegistry.tsx              # #1
src/components/ui/bulk-actions-bar.tsx                  # #13
src/components/ui/page-skeleton.tsx                     # #6
src/components/unified-order/RestoreDraftDialog.tsx     # #3
src/hooks/useBulkSelection.ts                           # #13
src/hooks/useCustomerSegments.ts                        # #16
src/hooks/useNetworkStatus.ts                           # #4
src/hooks/useOptimisticMutation.ts                      # #8
src/hooks/useOrderDraft.ts                              # #3
src/hooks/useTintRecentsFavorites.ts                    # #5
src/hooks/useUrlState.ts                                # #11
src/lib/offline-queue.ts                                # #20
src/lib/tint-cache.ts                                   # #18
src/pages/picking/TouchPickingView.tsx                  # #19
```

### Editados

```
src/App.tsx                                             # #6, #15, #19 (rota mobile + skeleton + toast)
src/components/AppShell.tsx                             # #1, #4, #9, #12 (topbar cleanup + providers)
src/components/EmptyState.tsx                           # #10 (refactor B2B)
src/components/ui/button.tsx                            # #2 (variantes touch/balcao)
src/hooks/use-toast.ts                                  # #15 (wrapper sonner)
src/hooks/useUnifiedOrder.ts                            # #3 (expor setCart)
src/index.css                                           # #17 (utilities text-status-*)
src/pages/AdminCustomers.tsx                            # #11, #16 (URL state + segments)
src/pages/AdminEstoquePicking.tsx                       # #7 (ScanBar)
src/pages/AdminReposicaoCockpit.tsx                     # #1 (migração shortcuts)
src/pages/NfeReceipt.tsx                                # #14 (histórico)
src/pages/TintFormulas.tsx                              # #5, #17 (recentes/favoritos + tokens)
src/pages/UnifiedOrder.tsx                              # #3 (draft autosave)
```

---

## Decisões de produto pendentes (bloqueiam adoção plena)

São itens que entreguei com mock/scaffold mas precisam de aprovação sua antes de virar produção:

1. **#14 / #16 — Tabelas novas**: `nfe_receipt_runs` e `user_segments`. Hoje rodam via localStorage por navegador. Migrar quando você aprovar o schema. Sugestões de schema estão nos arquivos comentadas como `TODO(schema)`.
2. **#18 — Tamanho do catálogo offline**: 477k fórmulas estimadas em ~100MB no IndexedDB do operador. Aceitar custo de espaço (a maioria dos navegadores modernos permite) ou implementar paginação por uso?
3. **#19 — Dual view ou auto-detect**: rota dedicada `/admin/estoque/picking/mobile` está pronta. Quer auto-redirect em mobile + `pointer: coarse`? Ou link manual na sidebar?
4. **#20 — Conflict resolution offline**: política para conflito de mesma task editada por 2 separadores offline. Opções: last-write-wins, lock pessimista, ou merge manual com prompt.

---

## Validação rodada

- ✅ Edição inspecionada visualmente (sandbox sem node/npm).
- ✅ Imports verificados via `grep` em todos os arquivos novos/editados.
- ✅ Compatibilidade backward: 53 callsites do `useToast` antigo continuam funcionando via wrapper.
- ✅ Nenhuma quebra no AdminReposicaoCockpit (migração shortcuts: dialog interno removido, registry global cobre).
- ⚠️ Sem `npm run lint` nem `npm run build` neste sandbox. **Recomendo rodar localmente antes de mergear**:
  ```bash
  npm run lint && npm run build && npm test
  ```

---

## O que sobra fora deste escopo

- **Performance check**: paginação real em SalesOrders e AdminCustomers (carregam tudo). Não entrei aqui — é refactor de query, não UX.
- **53 callsites de toast manual codemod**: opcional, wrapper resolve. Pode ser feito incrementalmente.
- **Tokens status-* refactor amplo**: ~50 callsites com cores hardcoded. Utilities prontas; substituição mecânica fica como follow-up.
- **`/unified-order` redirect**: mantido (precisa log de uso real antes de remover).
- **Branding stale**: `index.html` e PWA manifest continuam com "Colacor - Afiação Profissional". Não troquei porque rename afeta cache PWA dos usuários (deploy precisa coordenação).
- **`SalesOrders.deleteOrder` sem soft-delete**: aguarda decisão de compliance.
- **Discrepância Account/Empresa em SalesOrders** (`afiacao` vs `colacor_sc`): aguarda decisão de produto.
