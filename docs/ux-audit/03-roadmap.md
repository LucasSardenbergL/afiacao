# Fase 3 — Roadmap priorizado por ICE

> Data: 2026-05-13 · 20 intervenções derivadas dos padrões transversais e telas críticas da Fase 2. Ordenadas por ICE = Impact × Confidence × Ease (max 1000).
>
> **Esta fase NÃO toca em código.** A execução acontece na Fase 4, sob comando explícito por intervenção.

---

## Resumo executivo

### Top 3 problemas estruturais (aparecem em ≥5 telas)

1. **Zero atalhos sistêmicos / sem cmd-k.** Único exemplo real é o Cockpit de Reposição. As outras 9 telas top têm H7=1 e D5=1. Quem opera 8h/dia ali sente. Cobertura: intervenções #1, #9, #10.

2. **Zero offline-resilience operacional.** Workbox `NetworkOnly` em `picking_*`, `recebimento_*`, `sales_orders`, `orders`. Princípio do briefing ("offline-first em picking e recebimento") está hoje violado por arquitetura. Cobertura: intervenções #16, #17, #19.

3. **Touch targets <44px globais + ausência de variantes mobile-first** em telas críticas (separador, balcão tintométrico, vendedor externo). `density-compact` global empurra todos os botões para 32-36px, abaixo do recomendado WCAG AA para uso com luva. Cobertura: intervenções #2, #18.

### Top 3 quick wins (ICE ≥600 com Ease ≥8)

1. **#1 Atalhos + ShortcutsDialog reusável** (ICE 720) — extrai o pattern do Cockpit de Reposição como infra do AppShell. Habilita todas as outras propostas de atalho.
2. **#2 Variantes touch-grande no Button (44/56px)** (ICE 720) — destrava todas as telas mobile/balcão sem refactor profundo.
3. **#3 UnifiedOrder draft autosave + restore** (ICE 720) — corta a maior dor reportável do vendedor externo (perder pedido em queda de sinal) com 1 dia-dev e zero alteração de schema.

### Esforço total estimado

- **Quick wins (Ease ≥8)**: 8 intervenções · ~25-40 dias-dev
- **Médio (Ease 5-7)**: 9 intervenções · ~50-90 dias-dev
- **Pesado (Ease ≤4)**: 3 intervenções · ~30-60 dias-dev
- **Total**: ~105-190 dias-dev (1 sênior). Em sprints de 2 semanas com 1 dev = 5-10 sprints.

### Recomendação para o próximo sprint (2 semanas, 1 dev)

| # | Item | Dias-dev |
|---|---|---|
| #1 | Atalhos + ShortcutsDialog reusável | 2 |
| #2 | Variantes touch-grande no Button | 1 |
| #3 | UnifiedOrder draft autosave + restore | 1 |
| #4 | Indicador online/offline no AppShell topbar | 1 |
| #6 | Skeleton padrão de página + Suspense fallback contextual | 2 |
| #11 | Filtros persistidos em URL (pattern + uso em SalesOrders) | 3 |
| Buffer QA + ajustes | | 2 |

**~12 dias-dev, cabe em sprint de 2 semanas.** Entrega: cmd-k arquitetural fora ainda (#9 vai pro sprint 2), mas o eixo "atalhos + touch + persistência" desce em todas as telas operacionais já a partir da semana 1. Os quick wins #5 (toast) e #7 (tokens status-*) ficam para slot livre ou paralelos.

---

## Como ler cada intervenção

- **Nome curto** — chave de referência.
- **Tela/área afetada** — onde a mudança aparece.
- **Arquivos que mudam** — caminhos específicos (criar / editar / remover).
- **Diff conceitual em prosa** — sem código. O quê e onde, não o como.
- **Métrica que melhora** — proxy quantitativo concreto.
- **ICE** — Impact (1-10) × Confidence (1-10) × Ease (1-10) = score (max 1000).
- **Referência visual** — pattern nominal de Linear / Notion / Carbon / Polaris / Retool.
- **Dependências** — outras intervenções que precisam vir antes.
- **Risco** — baixo / médio / alto + qual.

---

# Roadmap (20 itens, ordenados por ICE)

## #1 — Atalhos globais + ShortcutsDialog reusável (ICE 720)

- **Tela/área**: AppShell + todas as 9 telas operacionais.
- **Arquivos**:
  - editar [src/hooks/useKeyboardShortcuts.ts](../../src/hooks/useKeyboardShortcuts.ts) — estender para suportar modifiers (`Cmd/Ctrl+K`), composições, escopo (página vs global), e nome legível por atalho
  - criar `src/components/shell/ShortcutsRegistryProvider.tsx` — context que coleta shortcuts montados em qualquer página
  - criar `src/components/shell/ShortcutsDialog.tsx` — overlay listando tudo agrupado por tela atual / global, abre com `?`
  - editar [src/components/AppShell.tsx](../../src/components/AppShell.tsx) — montar provider + dialog dentro do shell
  - editar [src/pages/AdminReposicaoCockpit.tsx](../../src/pages/AdminReposicaoCockpit.tsx) — migrar do hook local para registry global (validação)
- **Diff conceitual**: extrair o pattern já existente no Cockpit de Reposição (linha 2073-2084) como infra do AppShell. Páginas declaram shortcuts via hook que escreve no registry; o dialog `?` lê do registry e mostra agrupado por escopo. Sem isso, cada nova proposta de atalho duplica boilerplate.
- **Métrica que melhora**: % de ações executadas via atalho vs clique (instrumentar com analytics simples). Linha de base: ~0%. Meta: 30% no Cockpit em 30 dias.
- **ICE**: I=9 · C=10 · E=8 · = **720**
- **Referência visual**: dialog do Linear (`?` → painel à direita com seções "Navegação", "Edição", "Esta página"). Padrão também no Raycast.
- **Dependências**: nenhuma.
- **Risco**: baixo (extração).

---

## #2 — Variantes touch-grande no Button (44/56px) (ICE 720)

- **Tela/área**: telas mobile e touchscreen — Picking, RecebimentoConferencia, UnifiedOrder, TintFormulas, SalesOrders.
- **Arquivos**:
  - editar [src/components/ui/button.tsx](../../src/components/ui/button.tsx) — adicionar variantes `size: "touch"` (44px) e `size: "balcao"` (56px) ao cva
  - editar [src/index.css](../../src/index.css) — revisar regra global `button, a, [role="button"] { min-height: 32px; }` (linha 228-230) para não conflitar com variantes maiores
  - opcional: criar `src/components/ui/touch-input.tsx` — variante de Input com `h-12` para mobile
- **Diff conceitual**: hoje as variantes (sm/default/lg/icon) topam em 40px. Adicionar `touch` (44px) e `balcao` (56px) no `buttonVariants` cva. Não muda comportamento default; telas operacionais mobile passam a usar `<Button size="touch">`. Padrão Carbon Design Touch Targets.
- **Métrica que melhora**: taxa de mistap em mobile (precisa instrumentação) ou simples auditoria visual cobrindo 100% dos botões em /admin/estoque/picking e /tintometrico/formulas.
- **ICE**: I=8 · C=10 · E=9 · = **720**
- **Referência visual**: Carbon Touch Target spec (44×44 mínimo, 48×48 recomendado, 56×56 para uso com luva).
- **Dependências**: nenhuma.
- **Risco**: baixo (variante opt-in).

---

## #3 — UnifiedOrder: rascunho autosave + restore (ICE 720)

- **Tela/área**: `/sales/new` e `/new-order` (UnifiedOrder).
- **Arquivos**:
  - criar `src/hooks/useOrderDraft.ts` — debounced autosave em localStorage com chave `draft_order_{customerId}`
  - editar [src/hooks/useUnifiedOrder.ts](../../src/hooks/useUnifiedOrder.ts) — chamar useOrderDraft a cada mudança no cart/notes/seleções; ao montar, ler do storage e perguntar restauração
  - editar [src/pages/UnifiedOrder.tsx](../../src/pages/UnifiedOrder.tsx) — adicionar `<RestoreDraftDialog />` que aparece se houver draft pendente
  - criar `src/components/unified-order/RestoreDraftDialog.tsx`
- **Diff conceitual**: a cada mudança no estado do pedido (debounce 500ms), salvar snapshot no localStorage. Limpar ao submitOrder com sucesso. Ao recarregar a página com cart vazio mas draft existente, abrir dialog "Você tinha um pedido em andamento de {DD/MM HH:mm}. Restaurar?". Sem mexer em schema. Pré-requisito para a fila offline futura.
- **Métrica que melhora**: # de "pedidos perdidos" reportados por vendedor (suporte) — meta zero. Tempo médio de criação após queda de conexão (deve cair de ~10min/refazer para 0).
- **ICE**: I=9 · C=10 · E=8 · = **720**
- **Referência visual**: pattern Notion/Google Docs ("Recuperando rascunho..."). Dialog de restore parecido com o do Linear "Resume from draft?".
- **Dependências**: nenhuma.
- **Risco**: baixo. Atenção: garantir que limpa o draft após submit bem-sucedido (caso contrário re-restaura pedido já enviado).

---

## #4 — Indicador online/offline persistente no topbar (ICE 630)

- **Tela/área**: AppShell (todas as telas autenticadas).
- **Arquivos**:
  - criar `src/hooks/useNetworkStatus.ts` — wrapper sobre `navigator.onLine` + listeners + `navigator.connection` quando disponível
  - criar `src/components/shell/NetworkStatusIndicator.tsx`
  - editar [src/components/AppShell.tsx](../../src/components/AppShell.tsx) — substituir o botão `Bell` ornamental (linhas 458-460) pelo NetworkStatusIndicator
- **Diff conceitual**: dot verde "Online" / âmbar "Conexão lenta" / vermelho "Offline · X mutações na fila". Hover/click abre popover com detalhes (RTT estimado, último sync, ações pendentes — vinculável à fila do #16). Hoje o Bell ocupa esse slot e não faz nada. Substituição libera real estate sem custo.
- **Métrica que melhora**: # de tickets de suporte do tipo "perdi tudo, parecia funcionar mas não salvou" (dado qualitativo). Awareness do operador antes de ação destrutiva.
- **ICE**: I=7 · C=10 · E=9 · = **630**
- **Referência visual**: dot status do Linear (canto superior esquerdo do workspace) + popover de sync do Notion (mostra última sincronização).
- **Dependências**: nenhuma — full value sem fila offline. Ganha mais ainda quando #16 entrar.
- **Risco**: baixo.

---

## #5 — TintFormulas: recentes + favoritos no topo (ICE 567)

- **Tela/área**: `/tintometrico/formulas`.
- **Arquivos**:
  - editar [src/pages/TintFormulas.tsx](../../src/pages/TintFormulas.tsx) — adicionar barra superior persistente com 2 sub-seções (Recentes / Favoritos)
  - criar `src/hooks/useTintFavorites.ts` — read/write em localStorage por usuário (chave `tint_favorites_{userId}`)
  - reusar `src/lib/recents.ts` (ou criar) — registry de últimas 10 fórmulas consultadas
- **Diff conceitual**: ao abrir uma fórmula (expandir linha) ou usar via cmd-k, push para "recentes" (FIFO 10). Ícone de estrela por linha permite favoritar. Topo da tela mostra: "Recentes (5)" + "Favoritos (3)" como chips clicáveis que filtram a tabela. Sem mudança de schema. Plus opcional: botão "Copiar receita" na linha expandida (texto formatado para WhatsApp/dispenser).
- **Métrica que melhora**: tempo médio do operador para localizar fórmula durante atendimento (proxy: # de chars digitados na busca). Meta: cair pra 0 em fórmulas frequentes.
- **ICE**: I=9 · C=9 · E=7 · = **567**
- **Referência visual**: barra "Recentes" + "Favoritos" do Notion sidebar; favorito tipo Raycast (estrela inline).
- **Dependências**: nenhuma. Sinergia com #9 (cmd-k) — ao implementar cmd-k, expor "Buscar fórmula" como comando.
- **Risco**: baixo.

---

## #6 — Skeleton padrão de página + Suspense contextual (ICE 560)

- **Tela/área**: global (App.tsx Suspense fallback) + cada tela top.
- **Arquivos**:
  - criar `src/components/ui/page-skeleton.tsx` — variantes `cockpit` (KPIs + tabela), `list` (filtros + cards), `form` (steps + campos), `detail` (header + sections)
  - editar [src/App.tsx](../../src/App.tsx:138) — substituir `PageLoader` genérico por `<PageSkeleton variant="auto" />`; route-level fallback contextual via meta da rota
  - editar telas top que usam `Loader2` centralizado para usar PageSkeleton (Picking, SalesOrders, TintFormulas, AdminCustomers, FinanceiroCockpit já usa Skeleton — referência interna)
- **Diff conceitual**: hoje 6 das 10 telas top usam `<Loader2 spin />` centralizado durante load inicial — quebra continuidade visual. PageSkeleton mostra esqueleto da estrutura final, reduzindo CLS percebido. FinanceiroCockpit já implementa esse pattern manual; promover a componente.
- **Métrica que melhora**: Largest Contentful Paint percebido (não real — o tempo de servidor é o mesmo, mas a página parece carregar 30-50% mais rápido). Padrão Linear/Vercel.
- **ICE**: I=7 · C=10 · E=8 · = **560**
- **Referência visual**: skeleton do Linear (gradient shimmer + estrutura fiel à tela final).
- **Dependências**: nenhuma.
- **Risco**: baixo.

---

## #7 — AdminEstoquePicking: scan-first input com autofocus (ICE 560)

- **Tela/área**: `/admin/estoque/picking` — perfil separador.
- **Arquivos**:
  - editar [src/pages/AdminEstoquePicking.tsx](../../src/pages/AdminEstoquePicking.tsx) — adicionar `<ScanBar />` sticky no topo da PickingTab
  - criar `src/components/picking/ScanBar.tsx` — input autofocus, `inputmode="numeric"`, `autocomplete="off"`, debounce 50ms, suporte a leitura por wedge (HID barcode scanner) e digitação manual
  - opcional (depende #14): integração com BarcodeDetector API (câmera) para mobile
- **Diff conceitual**: barra fixa no topo focada por padrão. Operador chega na tela → digita ou bipa → barra detecta endereço (formato `Z.P.P`) ou SKU e route automaticamente para o item correspondente da task atual. Sem clique. Latência <100ms via #8 (optimistic).
- **Métrica que melhora**: tempo médio por separação (alvo: -30% após adoção). # de cliques por unidade separada (alvo: 0 na rotina padrão).
- **ICE**: I=10 · C=8 · E=7 · = **560**
- **Referência visual**: scan bar do Shopify POS / Stocky (input centralizado, fonte grande, foco automático).
- **Dependências**: #2 (touch variants para mobile) e #8 (optimistic) ampliam valor.
- **Risco**: médio — comportamento de wedge varia por modelo de leitor. Testar com 2-3 modelos antes de soltar.

---

## #8 — Helper `useOptimisticMutation` (ICE 504)

- **Tela/área**: infra reusável — ganho concreto em Picking, RecebimentoConferencia, UnifiedOrder, AdminCustomers.
- **Arquivos**:
  - criar `src/hooks/useOptimisticMutation.ts` — wrapper sobre `useMutation` com `onMutate`/`onError`/`onSettled` boilerplate, integrado com queryClient cache
  - documentar em [src/components/DesignSystem.tsx](../../src/pages/DesignSystem.tsx) seção "Padrões de mutação"
  - migrar 2-3 mutações operacionais de exemplo (handleConfirmUnit do Recebimento, deleteOrder do SalesOrders, requires_po toggle do AdminCustomers que **já usa o pattern** — referência interna)
- **Diff conceitual**: hoje cada mutação repete try/catch + setLoading + toast manual. Helper recebe `{ mutationFn, optimisticUpdate(cache), rollbackOn(err), invalidate: ['key'] }`. Ganho: optimistic UI por padrão; rollback consistente; menos boilerplate; toast de erro padronizado.
- **Métrica que melhora**: latência percebida em scan/picking <100ms (princípio do briefing). Linhas de código por mutação (-50%).
- **ICE**: I=9 · C=8 · E=7 · = **504**
- **Referência visual**: pattern do `tRPC + React Query optimistic` ou exemplos da própria docs do TanStack Query (`Optimistic Updates`).
- **Dependências**: nenhuma.
- **Risco**: médio — optimistic mal feito gera "fantasmas" se rollback falhar. Testar caso de borda: rede flaky com retry.

---

## #9 — Cmd-K global com registry de comandos (ICE 480)

- **Tela/área**: AppShell (toda a app).
- **Arquivos**:
  - criar `src/components/shell/CommandPalette.tsx` — overlay `cmdk` com fuse search, agrupa "Navegar para...", "Ações desta tela", "Buscar registro" (clientes, fórmulas, pedidos)
  - criar `src/components/shell/CommandsRegistryProvider.tsx` — análogo ao ShortcutsRegistry (#1), comandos contribuídos por página
  - editar [src/components/AppShell.tsx](../../src/components/AppShell.tsx) — montar palette com hotkey `Cmd+K`/`Ctrl+K`
  - editar topbar — adicionar pill "Cmd+K Buscar..." (placeholder visível)
- **Diff conceitual**: `cmdk` lib já está no projeto; `Command` shadcn em [src/components/ui/command.tsx](../../src/components/ui/command.tsx) também. Palette monta no portal, abre com `Cmd+K`. Registry inicial: rotas autorizadas por persona + comandos comuns ("Novo pedido", "Buscar cliente: {q}", "Fórmula {q}"). Versão 1 não precisa indexar Supabase em tempo real — busca debounced direta nas tabelas mais consultadas.
- **Métrica que melhora**: tempo de navegação entre telas (alvo: -50% para usuário power). Adoção (% de sessões com pelo menos 1 abertura de cmd-k em 30 dias).
- **ICE**: I=10 · C=8 · E=6 · = **480**
- **Referência visual**: cmd-k do Linear (groups por contexto) + Raycast (extensions). O do Notion serve como referência para "Find in...".
- **Dependências**: #1 (ShortcutsRegistry) é arquiteturalmente irmão — fazer junto economiza.
- **Risco**: médio — escopo pode inflacionar se quiser cobrir tudo na v1. Manter v1 minimal: navegar + 3 buscas (clientes, fórmulas, pedidos).

---

## #10 — EmptyState refactor para B2B (ICE 486)

- **Tela/área**: global. Telas com empty state hoje: Orders, SalesOrders, AdminCustomers, AdminEstoquePicking, todas as listas.
- **Arquivos**:
  - editar [src/components/EmptyState.tsx](../../src/components/EmptyState.tsx) — remover floating motion, ícone arredondado grande, decorative dots; tornar denso e B2B
  - opcional: criar variantes (`empty-search` com sugestão de limpar filtros, `empty-page` com CTA, `empty-loading-fail` com retry)
- **Diff conceitual**: o EmptyState atual é "consumer-grade" — ícone 80px com `motion.div animate y` flutuante, decorative dots, fonte 18px. Em telas operacionais vira ruído. Refactor para padrão Polaris EmptyState: ícone 24-32px, título 14-15px, descrição 13px, action button compacto. Sem motion. Mantém o componente; mudam os tokens internos.
- **Métrica que melhora**: consistência visual (auditoria); densidade adequada ao perfil B2B.
- **ICE**: I=6 · C=9 · E=9 · = **486**
- **Referência visual**: Polaris EmptyState compact + Carbon InlineNotification "no data".
- **Dependências**: nenhuma.
- **Risco**: baixo. Atenção: telas customer-facing (Orders, Tools) podem querer manter o estilo amigável — adicionar prop `tone: "operational" | "friendly"` resolve.

---

## #11 — Filtros persistidos em URL (ICE 504)

- **Tela/área**: SalesOrders, AdminCustomers, AdminReposicaoPedidos, AdminReposicaoCockpit, TintFormulas, Recebimento, Orders.
- **Arquivos**:
  - criar `src/hooks/useUrlState.ts` — hook genérico que sincroniza state com `useSearchParams`, com schema/serialização zod
  - migrar [src/pages/SalesOrders.tsx](../../src/pages/SalesOrders.tsx) (filtros: search, accountFilter) como referência
  - migrar [src/pages/AdminCustomers.tsx](../../src/pages/AdminCustomers.tsx) (filtros: searchQuery, filterHealth) — usa `useState` hoje, virar `useUrlState`
- **Diff conceitual**: hoje filtros são `useState` local — perdidos no F5, não compartilháveis. Hook sincroniza ↔ URL `?search=foo&account=oben`. Adoção incremental por tela. Padrão TanStack Router / Linear (URL representa o filtro completo).
- **Métrica que melhora**: # de URLs compartilhadas internamente (Slack/WhatsApp) com filtro pré-aplicado. Recuperação de contexto após F5.
- **ICE**: I=8 · C=9 · E=7 · = **504**
- **Referência visual**: URLs do Linear (`/team/X/active?priority=urgent&assignee=me`).
- **Dependências**: nenhuma.
- **Risco**: baixo. Atenção: PII em URL — filtros por `customer_id` ok, por `cnpj` plain text não.

---

## #12 — Topbar: cleanup do Bell + cmd-k trigger + company switcher (ICE 441)

- **Tela/área**: AppShell topbar.
- **Arquivos**:
  - editar [src/components/AppShell.tsx](../../src/components/AppShell.tsx) — remover `Bell` ornamental (linhas 458-460), adicionar `<CommandPaletteTrigger />`, `<CompanySwitcher />`, `<NetworkStatusIndicator />` (#4)
  - criar `src/components/shell/CompanySwitcher.tsx` — dropdown lendo de [src/contexts/CompanyContext.tsx](../../src/contexts/CompanyContext.tsx); persiste em localStorage (já faz)
- **Diff conceitual**: hoje o topbar tem só Bell+User. Reorganizar para: [logo] [breadcrumb opcional] —— [cmd-k pill] [company switcher pill] [network indicator dot] [help drawer] [user dropdown]. Bell pode voltar quando notificações reais existirem (hoje é falsa promessa de UX).
- **Métrica que melhora**: descoberta do cmd-k (presença visual de affordance). Awareness da empresa ativa (hoje não é exposta — usuário pode confundir contexto entre Oben/Colacor/SC).
- **ICE**: I=7 · C=9 · E=7 · = **441**
- **Referência visual**: topbar do Linear (cmd-k pill central + breadcrumb à esquerda + actions à direita).
- **Dependências**: #4 (NetworkStatusIndicator), #9 (Cmd-K palette). CompanySwitcher pode entrar antes dos outros.
- **Risco**: baixo. Validar com gestão se mostrar empresa ativa publicamente é OK (multi-tenant interno).

---

## #13 — Bulk actions pattern para tabelas (ICE 432)

- **Tela/área**: SalesOrders, AdminCustomers, AdminReposicaoPedidos, AdminReposicaoCockpit (tem parcialmente).
- **Arquivos**:
  - criar `src/components/ui/bulk-actions-bar.tsx` — barra flutuante que aparece quando `selected.length > 0`, com ações contextuais e botão "Limpar seleção"
  - criar `src/hooks/useBulkSelection.ts` — multi-select padrão (Shift+click range, Ctrl+click toggle, Esc limpa)
  - migrar AdminReposicaoCockpit (review mode → usar pattern) como referência
- **Diff conceitual**: cada tela hoje implementa multi-select e bulk de forma diferente (ou nem implementa). Pattern central + barra reusável padroniza visualmente e acelera adoção. Cobertura: aprovar/cancelar bulk em pedidos, atribuir vendedor em clientes, exportar segmento, marcar como entregue, etc.
- **Métrica que melhora**: tempo médio para operação em N itens (alvo: -80% vs N cliques individuais).
- **ICE**: I=8 · C=9 · E=6 · = **432**
- **Referência visual**: bulk actions bar do Retool table + Polaris ResourceList. Linear inbox bulk (visual reference).
- **Dependências**: nenhuma. Ganha sinergia com #11 (URL state — preservar seleção em query param).
- **Risco**: médio — Shift+click range em tabelas ordenadas/paginadas tem caso de borda (selecionar entre páginas). v1 cobre só dentro da página atual.

---

## #14 — NfeReceipt: histórico das últimas 10 + reprocessar (ICE 405)

- **Tela/área**: `/nfe-receipt`.
- **Arquivos**:
  - editar [src/pages/NfeReceipt.tsx](../../src/pages/NfeReceipt.tsx) — adicionar Card "Últimas processadas" abaixo do form, query a tabela de log (criar se não existe)
  - opcional: nova tabela `nfe_receipt_runs` (id, nf_number, account, started_at, finished_at, success, steps jsonb, user_id) — fora do escopo desta auditoria, mas necessário para o histórico funcionar
- **Diff conceitual**: hoje o operador processa uma NF e perde o registro ao recarregar. Histórico mostra status + timestamp + botão "Reprocessar" + link "Ver log completo". Reduz suporte ("Você processou minha NF?") e dá rastreabilidade.
- **Métrica que melhora**: # de tickets de suporte sobre status de processamento. Tempo médio para reprocessar erro intermitente.
- **ICE**: I=5 · C=9 · E=9 · = **405** (E=9 supõe que tabela de log existirá; se precisar criar schema, E baixa para 6)
- **Referência visual**: log de runs do Vercel deploy / GitHub Actions (lista compacta com status pill + timestamp).
- **Dependências**: schema de `nfe_receipt_runs` (decisão de produto/dados).
- **Risco**: baixo.

---

## #15 — Toast: unificar em Sonner, remover Radix duplicado (ICE 450)

- **Tela/área**: global.
- **Arquivos**:
  - editar [src/App.tsx](../../src/App.tsx:160-161) — remover `<Toaster />` (Radix), manter `<Sonner />`
  - remover [src/components/ui/toaster.tsx](../../src/components/ui/toaster.tsx), [src/components/ui/toast.tsx](../../src/components/ui/toast.tsx), [src/hooks/use-toast.ts](../../src/hooks/use-toast.ts) e [src/components/ui/use-toast.ts](../../src/components/ui/use-toast.ts)
  - codemod: substituir todos os imports de `useToast` / `toast` de `@/hooks/use-toast` por `import { toast } from 'sonner'` e migrar API (`toast({title, description, variant})` → `toast.success(title, { description })`)
- **Diff conceitual**: hoje os dois sistemas coexistem. Sonner tem API mais ergonômica e melhor stack (top-right unificado). Padronizar reduz inconsistência visual e bundle. Migrar ~30 callsites — codemod simples.
- **Métrica que melhora**: bundle size (-3-5kb gzip). Consistência visual de feedback.
- **ICE**: I=5 · C=10 · E=9 · = **450**
- **Referência visual**: Sonner stacking top-right (Vercel default).
- **Dependências**: nenhuma.
- **Risco**: baixo. Atenção: `toast.action({label, onClick})` API difere — checar callsites com action callback.

---

## #16 — AdminCustomers: segmentos salvos como chips (ICE 378)

- **Tela/área**: `/admin/customers`.
- **Arquivos**:
  - editar [src/pages/AdminCustomers.tsx](../../src/pages/AdminCustomers.tsx) — adicionar barra de chips "Meus segmentos" acima da tabela
  - criar tabela `user_segments` (id, user_id, name, filter_json, created_at) — schema novo
  - criar `src/hooks/useUserSegments.ts`
- **Diff conceitual**: vendedor define filtros frequentes (ex: "Críticos sem compra 60d+") e salva como segmento nomeado. Aparece como chip clicável. Reduz fricção de redefinir filtros toda vez. Cross-sell com #11 (URL state) — segmento é só um filter_json materializado.
- **Métrica que melhora**: # de segmentos criados por vendedor; tempo médio para acessar lista filtrada (-90%).
- **ICE**: I=7 · C=9 · E=6 · = **378**
- **Referência visual**: HubSpot Lists / Linear Views (sidebar com saved views).
- **Dependências**: #11 (URL state) — feito antes, segmento vira encapsulamento natural.
- **Risco**: baixo. Atenção: segmento global vs por vendedor — definir antes (provavelmente por vendedor com flag "compartilhar com time").

---

## #17 — Tokens status-* — eliminar cores hardcoded (ICE 378)

- **Tela/área**: ~10-15 telas (Picking, FinanceiroCockpit, AdminReposicaoPedidos, TintFormulas, etc.).
- **Arquivos**:
  - editar telas com `text-emerald-600`, `text-red-600`, `bg-amber-50`, `bg-emerald-500/15` etc. — substituir por classes utilitárias `status-success`, `status-warning`, `status-error`, ou tokens `text-status-success` (criar utilitário)
  - editar [src/index.css](../../src/index.css) — adicionar utilities `text-status-*` se faltarem (já tem `bg-status-*-bg`)
- **Diff conceitual**: hoje cores semânticas são duplicadas como classes Tailwind cruas em ~50 callsites. Quebra dark mode parcial e impede mudança global. Refactor padroniza para tokens semânticos. Pode ser parcial (refactor só telas top da Fase 2 já cobre 80% dos casos).
- **Métrica que melhora**: consistência dark mode (auditoria visual). Mudança futura de paleta (1 linha vs 50).
- **ICE**: I=6 · C=9 · E=7 · = **378**
- **Referência visual**: Carbon Design tokens system (todo signaling via tokens, não cores cruas).
- **Dependências**: nenhuma.
- **Risco**: baixo (refactor mecânico). Tem que rodar com olho — algumas cores são intencionais e não-status (ex: roxo de bundle).

---

## #18 — TintFormulas: catálogo offline em IndexedDB (ICE 360)

- **Tela/área**: `/tintometrico/formulas` e telas que consomem fórmulas.
- **Arquivos**:
  - criar `src/lib/tint-cache.ts` — wrapper sobre IndexedDB (via `idb` lib ou `Dexie`) com schema {formulas, corantes, embalagens, produtos, bases, version}
  - criar Edge function `tint-catalog-snapshot` — gera snapshot versionado do catálogo (incremental por updated_at)
  - editar [src/pages/TintFormulas.tsx](../../src/pages/TintFormulas.tsx) — query stale-while-revalidate; offline → ler de IndexedDB; banner "Catálogo offline · sincronizado há Xh"
- **Diff conceitual**: catálogo de ~477k fórmulas é semi-estático (atualizado por sync periódico do SAYERSYSTEM). Cachear cliente-side em IndexedDB libera operação 100% offline no balcão. Versão incremental: ao reconectar, busca diff `WHERE updated_at > last_sync`. Tamanho estimado: ~50-100MB no cliente — viável.
- **Métrica que melhora**: % de uptime efetivo do balcão durante quedas de internet (alvo: 100%). Latência de busca local (alvo: <50ms vs 500ms+ via Supabase).
- **ICE**: I=9 · C=8 · E=5 · = **360**
- **Referência visual**: Notion offline mode (página inteira disponível offline).
- **Dependências**: validar viabilidade de tamanho com PO (~100MB no IndexedDB do operador).
- **Risco**: alto — sync incremental tem casos de borda (delete de fórmulas, conflito de versionamento, espaço em disco). v1: snapshot completo + reload manual.

---

## #19 — AdminEstoquePicking: tela mobile dedicada (TouchPickingView) (ICE 320)

- **Tela/área**: `/admin/estoque/picking` — render condicional mobile.
- **Arquivos**:
  - criar `src/pages/picking/TouchPickingView.tsx` — layout vertical, cards 56px+, fonte base 16px, swipe-to-advance (Vaul drawer ou hammer.js)
  - editar [src/pages/AdminEstoquePicking.tsx](../../src/pages/AdminEstoquePicking.tsx) — render condicional baseado em `useIsMobile()` + `pointer: coarse` detection
  - reusar `src/components/picking/ScanBar.tsx` (do #7)
- **Diff conceitual**: hoje a tela é desktop-first; o separador mobile recebe a tabela horizontal apertada. Refactor cria visão dedicada: 1 task por vez, item destacado, scan focado, swipe-right para avançar, botões 56px. Desktop continua sendo o cockpit do gestor. Não é responsive — é dual-view.
- **Métrica que melhora**: tempo por separação no chão (alvo: -40%). Taxa de erro de bipagem.
- **ICE**: I=10 · C=8 · E=4 · = **320**
- **Referência visual**: tela "Pick" do Shopify Stocky / Magic Pick / Brightpearl.
- **Dependências**: #2 (touch variants), #7 (ScanBar), #8 (optimistic), #16 (offline queue) — todas multiplicam o valor desta. Faz sentido entrar depois delas.
- **Risco**: alto — exige protótipo testado com separador real antes de soltar.

---

## #20 — Offline queue + IndexedDB para picking e recebimento (ICE 210)

- **Tela/área**: AppShell + Picking + RecebimentoConferencia + UnifiedOrder (vendedor).
- **Arquivos**:
  - criar `src/lib/offline-queue.ts` — fila persistente em IndexedDB com retry exponencial; enqueue/flush/clear
  - criar `src/hooks/useOfflineMutation.ts` — wrapper que enfileira mutações quando offline e dispara quando volta
  - editar workbox em [vite.config.ts](../../vite.config.ts:54-85) — adicionar handlers para `picking_*`, `nfe_*`, `nfe_lotes_*` com strategy `NetworkFirst` + queue background sync
  - integrar com `<NetworkStatusIndicator />` (#4) — exibir contador "X mutações na fila"
  - editar mutações de Picking, RecebimentoConferencia para usar `useOfflineMutation`
- **Diff conceitual**: maior intervenção do roadmap. Substitui `NetworkOnly` atual por queue persistente. Operador pode trabalhar offline em picking/recebimento; mutações enfileiradas em IndexedDB + executadas em background quando reconecta. Workbox `BackgroundSyncPlugin` cobre o caminho HTTP; o hook cobre lógica de UI (estado pendente, conflict resolution).
- **Métrica que melhora**: # de tickets "perdi separação por queda de sinal" (alvo: zero). Uptime efetivo do almox em loja com sinal ruim. Princípio do briefing.
- **ICE**: I=10 · C=7 · E=3 · = **210**
- **Referência visual**: Linear iOS offline mode (cria issue offline, sync automático). Notion offline drafts.
- **Dependências**: #4 (NetworkStatusIndicator) para feedback visual, #8 (optimistic) — semantically irmão.
- **Risco**: **alto** — conflict resolution (mesma task editada offline por 2 separadores), expiração de fila, casos de borda de timeout. Requer suite de testes e2e dedicada. Estimativa conservadora: 3-4 semanas de dev.

---

# Sumário ordenado

| # | Intervenção | I | C | E | ICE | Tier | Sprint sugerido |
|---|---|---|---|---|---|---|---|
| 1 | Atalhos + ShortcutsDialog reusável | 9 | 10 | 8 | **720** | quick win | 1 |
| 2 | Variantes touch-grande no Button | 8 | 10 | 9 | **720** | quick win | 1 |
| 3 | UnifiedOrder draft autosave + restore | 9 | 10 | 8 | **720** | quick win | 1 |
| 4 | Indicador online/offline no topbar | 7 | 10 | 9 | **630** | quick win | 1 |
| 5 | TintFormulas recentes + favoritos | 9 | 9 | 7 | **567** | médio | 2 |
| 6 | Skeleton padrão de página | 7 | 10 | 8 | **560** | quick win | 1 |
| 7 | Picking scan-first input | 10 | 8 | 7 | **560** | médio | 2 |
| 8 | useOptimisticMutation helper | 9 | 8 | 7 | **504** | médio | 2 |
| 9 | Cmd-K global | 10 | 8 | 6 | **480** | médio | 2 |
| 10 | EmptyState refactor B2B | 6 | 9 | 9 | **486** | quick win | 1 |
| 11 | Filtros persistidos em URL | 8 | 9 | 7 | **504** | médio | 1-2 |
| 12 | Topbar cleanup + cmd-k pill + switcher | 7 | 9 | 7 | **441** | médio | 2 |
| 13 | Bulk actions pattern | 8 | 9 | 6 | **432** | médio | 3 |
| 14 | NfeReceipt histórico | 5 | 9 | 9 | **405** | quick win | 3 |
| 15 | Toast unificação Sonner | 5 | 10 | 9 | **450** | quick win | 1 (slot livre) |
| 16 | AdminCustomers segmentos | 7 | 9 | 6 | **378** | médio | 3 |
| 17 | Tokens status-* refactor | 6 | 9 | 7 | **378** | médio | 1-2 (paralelo) |
| 18 | TintFormulas catálogo offline | 9 | 8 | 5 | **360** | pesado | 4 |
| 19 | TouchPickingView mobile dedicada | 10 | 8 | 4 | **320** | pesado | 4-5 |
| 20 | Offline queue picking/recebimento | 10 | 7 | 3 | **210** | pesado | 5-6 |

---

## Notas finais

### Já feito durante a auditoria (Fase 2 → conserto direto, fora do escopo de UX)

Estes 3 itens foram corrigidos diretamente, com permissão explícita do PO ao final da Fase 2:

- ✅ [src/pages/NfeReceipt.tsx](../../src/pages/NfeReceipt.tsx) — título dinâmico por empresa selecionada (era "OBEN" hardcoded).
- ✅ [src/pages/FinanceiroCockpit.tsx](../../src/pages/FinanceiroCockpit.tsx) — try/catch silenciosos de `fin_projecao_13_semanas` e `fin_confiabilidade` agora logam via `logger.warn`.
- ✅ [src/pages/AdminReposicaoCockpit.tsx](../../src/pages/AdminReposicaoCockpit.tsx) — try/catch silencioso de `cockpit_audit_log` agora loga via `logger.warn` (auditoria deixa de se perder em silêncio).

### Observações fora do escopo NÃO consertadas (pedem decisão de produto antes)

Mantidas no roadmap conceitual, mas exigem alinhamento antes de tocar:

- **Discrepância Account/Empresa em SalesOrders** — `Account = 'oben' | 'colacor' | 'afiacao' | 'all'` divergente de `CompanyContext = 'colacor' | 'oben' | 'colacor_sc'`. Pergunta: "afiacao" (SalesOrders) e "colacor_sc" (CompanyContext) são a mesma coisa, ou Colacor SC ainda não tem pedidos no fluxo de vendas?
- **`/unified-order` redirect** — manter ou remover. Decisão depende de log de uso real.
- **`SalesOrders` carrega TUDO sem paginação** — refactor ICE-incluído (#11 cobre filtros; paginação real é trabalho à parte). Precisa decisão sobre cursor pagination vs infinite scroll.
- **`SalesOrders.deleteOrder` sem soft-delete** — risco compliance. Precisa decisão sobre política de retenção e auditoria de exclusão.
- **`Bell` ornamental no topbar** — endereçado pelo #4 / #12 (cleanup), mas decisão sobre central de notificações real é pendente.
- **Branding stale `Colacor - Afiação Profissional`** em `index.html` e `vite.config.ts` PWA manifest — rename simples mas afeta cache PWA dos usuários (split deploy ou flush).

### Como o roadmap se mapeia aos princípios do briefing

| Princípio do briefing | Coberto por |
|---|---|
| Offline-first em picking e recebimento | #20 (core), #18 (TintFormulas) |
| Latência percebida <100ms em scan | #7, #8 |
| Densidade alta em telas operacionais | já alinhado (`density-compact`); #10 reforça |
| WCAG AA mínimo, AAA em críticas | #2 (touch), #17 (tokens — contraste) |
| Mobile-first em chão de fábrica | #2, #7, #19 |
| Cmd-K global + atalhos consistentes | #1, #9, #12 |
| Optimistic UI em mutações operacionais | #8 (helper), aplicado em #7, #20 |

Os 6 princípios estão endereçados. Nenhum gap não-coberto.

### Antes de iniciar a Fase 4

Pra cada intervenção que entrar no sprint, preciso:

1. **Sinal verde nominal** ("aprova #1", "aprova #2 e #3 juntos", etc.).
2. **Confirmação de premissas** marcadas como "decisão pendente" nos itens (ex: schema novo no #14 e #16, viabilidade de tamanho no #18, política de exclusão no SalesOrders).
3. **Ordem sugerida vs ordem que você quer** — se quiser puxar #20 antes do #4, viável; só perde sinergia.

Aguardando sua priorização do sprint.
