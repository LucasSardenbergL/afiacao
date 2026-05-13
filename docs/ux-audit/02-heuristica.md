# Fase 2 — Auditoria heurística das 10 telas top

> Data: 2026-05-13 · Critérios: Nielsen H1-H10 (1-5) + Domínio D1-D6 (1-5). Para todo critério ≤3 há intervenção concreta proposta com referência visual nominal. Veredicto por tela ao final.

## Como ler

- **Score 5** — exemplar; serve de referência interna.
- **Score 4** — bom, sem ação necessária.
- **Score 3** — aceitável mas com fricção; intervenção desejada.
- **Score 2** — falha visível; intervenção necessária.
- **Score 1** — bloqueante; reescrita ou retrabalho profundo.

## Critérios

**Nielsen** — H1 status visível · H2 mundo real · H3 controle/liberdade · H4 consistência · H5 prevenção de erro · H6 reconhecimento > memória · H7 flex/eficiência · H8 minimalista · H9 recuperação de erro · H10 ajuda.

**Domínio** — D1 latência percebida · D2 densidade adequada · D3 ergonomia física (alvos, contraste, luva) · D4 offline resilience · D5 atalhos e cmd-k · D6 mobile vs desktop adequado.

---

# 1. `/admin/estoque/picking` — AdminEstoquePicking

**Persona**: Separador (mobile/luva) **+** gestão (desktop). Arquivo: [src/pages/AdminEstoquePicking.tsx](../../src/pages/AdminEstoquePicking.tsx)

A tela hoje é desktop-first com 4 KPIs no topo (Tasks Abertas, Pedidos Aguardando, SKUs Críticos, FEFO Compliance) e 4 abas (Picking, Estoque, Movimentações, Auditoria). Cada task expande inline para mostrar os itens com lote_fefo vs lote_separado. Não há scan visível; não há fluxo dedicado mobile do separador.

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 3 | KPIs claros, mas sem indicador de sync/realtime nem timestamp da última atualização. |
| H2 Mundo real | 4 | Termos do domínio corretos (FEFO, Lote, SKU, Tasks). |
| H3 Controle | 2 | Não há undo de operação de picking, voltar ao item anterior, nem "desfazer separação". |
| H4 Consistência | 4 | Tabs e tabelas consistentes com shadcn padrão do projeto. |
| H5 Prevenção | 3 | Lote separado divergente do FEFO recebe alerta visual amarelo, mas não bloqueia salvamento nem pede confirmação. |
| H6 Reconhecimento | 2 | Sem busca por código de produto na tela de picking, sem recentes, sem sugestões de próximo SKU mais próximo no endereço. |
| H7 Flex/eficiência | 1 | Zero atalhos. Nenhum scan. Sem bulk action. |
| H8 Minimalista | 4 | Sem decoração; tabela densa. |
| H9 Recup. erro | 3 | Erros viram toast genérico; sem retry ou fila para mutações falhadas. |
| H10 Ajuda | 2 | Sem tooltip nos KPIs (o que conta como "FEFO Compliance"?), sem onboarding, sem empty state informativo. |
| D1 Latência | 2 | Cada interação aguarda resposta Supabase; sem optimistic UI; refetch a 60s pode atrasar percepção de progresso. |
| D2 Densidade | 4 | Compact OK no desktop; mobile fica apertado mas legível. |
| D3 Ergonomia | 1 | Tabela inline com ChevronRight de 28px (`h-7 w-7`) é inviável com luva; sem alvos 44px+. |
| D4 Offline | 1 | NetworkOnly no Workbox para `picking_*` — perde tudo se cair sinal. |
| D5 Atalhos | 1 | Nenhum. |
| D6 Mobile/desktop | 2 | Tela claramente projetada para desktop; o separador mobile fica com tabela horizontal. |

**Intervenções** (para scores ≤3):

- **H3** — Botão "desfazer última separação" sticky no topo do drawer item, igual ao undo flutuante do Linear (snackbar com action). Aplica-se ao último `picking_event` da task atual (3s para reverter).
- **H5** — Quando lote informado ≠ lote_fefo, abrir modal de confirmação com motivo obrigatório (lista: "FEFO esgotado", "lote vencido", "outro"), pattern do "double-confirm" do Carbon. Bloqueio só com motivo registrado.
- **H6** — Campo de scan focado por padrão no topo da tela mobile (autofocus, keyboard `inputmode="numeric"`, `autocomplete="off"`). Padrão das telas de PoS Shopify Polaris/POS UX kit.
- **H7** — Atalhos no desktop: `s` foca scan, `n` próximo item, `d` divergência, `?` mostra dialog (já existe pattern em AdminReposicaoCockpit). Pra mobile, gesto swipe-right para avançar item (vaul drawer + swipe).
- **H9** — Implementar fila offline: ao falhar mutação, push para `localStorage` queue, badge "X separações na fila" no topo, retry automático com exponential backoff. Pattern do offline-queue do Linear iOS.
- **H10** — Tooltip explicativo em cada KPI (popover ao hover/long-press); empty state das tasks com link para "Como criar uma task de picking".
- **D1** — `useMutation({ onMutate })` para optimistic UI: ao bipar, atualizar lista visualmente antes do roundtrip (~50ms percebido vs 200-800ms). Reverter em onError com toast e som de erro.
- **D3** — Variante mobile dedicada "TouchPickingView": botões 56px, fonte base 16px, alto contraste, cards verticais grandes em vez de tabela, swipe para avançar. Referência visual: a tela de "Picking" do Shopify POS / Stocky.
- **D4** — Service worker com IndexedDB para `picking_tasks` e `picking_task_items`. Stale-while-revalidate. Mutation queue persistente com sync ao reconectar (`navigator.connection.onchange`). Indicador permanente "Offline · 3 separações na fila".
- **D5** — Ver H7.
- **D6** — Rota dedicada `/admin/estoque/picking/mobile` ou render condicional `useIsMobile()` com layout reescrito; o desktop continua sendo o cockpit do gestor.

**Veredicto**: **Reescrita necessária** para a perspectiva do separador — o cockpit do gestor pode ficar como está, mas a UX mobile do operador precisa ser uma tela própria.

---

# 2. `/recebimento/:id` — RecebimentoConferencia

**Persona**: Conferente (desktop/teclado, eventualmente mobile no chão). Arquivo: [src/pages/RecebimentoConferencia.tsx](../../src/pages/RecebimentoConferencia.tsx)

Tela de conferência item-a-item com OCR de lote (Tesseract via `LoteScannerOCR`), barra de progresso global "X de Y unidades", scanner full-screen overlay, modal de divergência, vinculação de CT-e, finalização que chama Edge function de efetivação.

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 5 | Excelente — barra global de progresso sticky, contador `X/Y unidades`, status badge por item. |
| H2 Mundo real | 5 | Lote, fabricação, validade, divergência, CT-e — vocabulário fiscal correto. |
| H3 Controle | 3 | Tem voltar e cancelar scan, mas sem "desfazer última leitura" (se bipou errado e salvou, precisa abrir modal de divergência). |
| H4 Consistência | 4 | Padrão de Card/Sheet/Dialog consistente; toast via sonner. |
| H5 Prevenção | 4 | Validação de chave CT-e (44 dígitos), divergência exige texto. Falta confirmação ao finalizar com itens não conferidos. |
| H6 Reconhecimento | 4 | "Repetir último lote" salva digitação repetida — bom uso de recente. |
| H7 Flex/eficiência | 2 | Sem atalhos (`s` scan, `r` repete último, `Enter` confirma); sem bulk action de "marcar todos OK"; sem importar lote em massa. |
| H8 Minimalista | 4 | Densidade boa; sem decoração desnecessária. |
| H9 Recup. erro | 3 | Toast com mensagem do servidor é exibido, mas sem retry e mutação não fica em fila. Erro de OCR não dá fallback claro. |
| H10 Ajuda | 3 | Sem tooltip explicando "metodo: ocr vs manual", "divergência" não tem hint do que isso vai bloquear no fluxo. |
| D1 Latência | 3 | OCR pode demorar 1-3s sem feedback granular (só "scanner full-screen"); confirmar unidade aguarda 200-500ms sem optimistic. |
| D2 Densidade | 5 | Excelente — `max-w-2xl`, espaçamento adequado para conferente. |
| D3 Ergonomia | 3 | Botões 36-40px no Sheet — OK no desktop, abaixo do limite mobile. Câmera OCR com luva fica dependente da preensão do device. |
| D4 Offline | 1 | NetworkOnly no Workbox; se cair sinal no meio da NF, perde tudo. |
| D5 Atalhos | 1 | Nenhum. |
| D6 Mobile/desktop | 4 | Layout `max-w-2xl` funciona razoavelmente em ambos; scanner é full-screen apropriado. |

**Intervenções**:

- **H3** — Snackbar undo "Lote 1234 registrado · Desfazer" por 4s após cada confirmação. Pattern Linear/Gmail. Reverte o último insert em `nfe_lotes_escaneados` e decrementa `quantidade_conferida`.
- **H7** — Atalhos: `s` abre scanner, `r` repete último lote, `Enter` confirma unidade, `d` abre divergência, `f` finaliza, `?` ajuda. Hook `useKeyboardShortcuts` já existe no projeto.
- **H9** — Em onError do `handleConfirmUnit`, push para fila local; mostrar banner "1 leitura aguardando reenvio" e retry exponencial. Mesma pattern proposta para Picking.
- **H10** — Adicionar `<Tooltip>` em "Divergência" explicando: "Marca o item como divergente e impede a efetivação automática até a resolução manual"; mesmo para "Vincular CT-e".
- **D1** — Optimistic UI no `handleConfirmUnit`: avançar `quantidade_conferida` na UI antes do servidor; reverter em erro. Para o OCR, adicionar `<Progress indeterminate />` durante a captura com mensagem ("Detectando lote...", "Lendo data de validade...").
- **D3** — Variante mobile com botões 48-56px no SheetContent (atualmente 36-40); ampliar área tocável de "Repetir último lote" e "Confirmar unidade".
- **D4** — Persistir `nfe_lotes_escaneados` em IndexedDB; queue de mutações; indicador de online/offline no header sticky. Sem isso, conferência em armazém com sinal ruim é roleta.
- **D5** — Ver H7.

**Veredicto**: **Precisa intervenção** — base é boa, mas atalhos + offline + optimistic faltam para virar referência interna.

---

# 3. `/admin/reposicao/cockpit` — AdminReposicaoCockpit

**Persona**: Comprador (desktop). Arquivo: [src/pages/AdminReposicaoCockpit.tsx](../../src/pages/AdminReposicaoCockpit.tsx) — 2210 linhas.

Tela de comando do comprador com Sparkles header, Smart Alerts, ProcessoComprasStepper, MetricsStrip, 3 tabs (Ciclo de hoje, Aplicar no Omie, Ciclos anteriores), tabela inline editável (qtd + aprovar/rejeitar por linha), seleção bulk em "review mode", export CSV, PDF, Audit Log colapsável, **e único uso real de useKeyboardShortcuts no projeto** (`g`, `e`, `1/2/3`, `r`, `m`, `?`).

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 4 | Stepper visual do processo de compra; alertas inline; falta indicador de freshness ("dados de 14:32"). |
| H2 Mundo real | 5 | "Ciclo de hoje", "Aplicar no Omie", "Confiança", "Bloqueado por guardrail" — domínio correto. |
| H3 Controle | 4 | Aprovar/rejeitar por linha; cancelar bulk com confirmação; falta undo da aprovação inline. |
| H4 Consistência | 4 | Boa consistência interna; algumas badges usam classes hardcoded (`bg-emerald-500/15`) em vez do token `status-success-bg`. |
| H5 Prevenção | 4 | "Aprovar tudo automático" tem confirmação modal e exige guardrails atendidos. Bom. |
| H6 Reconhecimento | 4 | Filtro por fornecedor/status; column visibility config persistida; recentes ausentes. |
| H7 Flex/eficiência | 5 | **Referência interna** — atalhos `g/e/1/2/3/r/m/?`, dialog de ajuda, bulk select, CSV/PDF export. |
| H8 Minimalista | 3 | Densidade alta mas com 7+ componentes empilhados (alerts + stepper + metrics + tabs + tabela + audit log) — risco de scroll fatigue. |
| H9 Recup. erro | 4 | Alert de "Etapa atual indisponível · Tentar novamente" é exemplar. |
| H10 Ajuda | 4 | Dialog de atalhos `?`; tooltips em "Confiança"; falta tooltip em métricas. |
| D1 Latência | 4 | Mutações inline têm spinner local no botão; refetch após mudança; sem optimistic mas a percepção é rápida. |
| D2 Densidade | 4 | Bem calibrada para comprador analítico. |
| D3 Ergonomia | 4 | Desktop, dispensa 44px. Foco visível, contraste OK. |
| D4 Offline | 2 | Não persiste; comprador remoto perde estado em queda de sinal. Risco moderado (não bloqueia chão). |
| D5 Atalhos | 5 | **Referência** — replicar para outras telas. |
| D6 Mobile/desktop | 3 | Não responde para mobile; tabela de 8+ colunas quebra em <md. Pode ser intencional, mas declarar. |

**Intervenções**:

- **H8** — Colapsar SmartAlertsSection e AuditLogSection por padrão (`Collapsible defaultOpen={false}`); reduzir a 1 MetricsStrip mais compacta no formato "5 KPIs em linha única" estilo Linear Insights. Permitir que o comprador feche o stepper se o ciclo do dia já passou.
- **D4** — Persistir filtros e column-visibility já em localStorage (parece já feito — confirmar). Para resiliência maior: cachear `pedido_compra_sugerido` da data atual em IndexedDB para leitura offline (read-only quando offline; bloquear mutação com banner).
- **D6** — Decidir: ou marca a tela explicitamente como "Apenas desktop" (banner em viewport <md), ou cria visão mobile reduzida (KPIs + lista vertical de pedidos com aprovar/rejeitar por card). Padrão Retool de "responsive containers".

**Veredicto**: **Aceitável** — a melhor tela do app hoje em UX. Pequenos ajustes para scroll fatigue e mobile (se quiserem usar no celular).

---

# 4. `/admin/reposicao/pedidos` — AdminReposicaoPedidos

**Persona**: Comprador. Arquivo: [src/pages/AdminReposicaoPedidos.tsx](../../src/pages/AdminReposicaoPedidos.tsx)

Lista de pedidos sugeridos do dia com Status + Status do envio ao portal B2B (drawer rico mostrando protocolo, screenshot, retry count, próximo retry), badges de status, ações de aprovar/cancelar, mutation `reenviar_portal`.

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 5 | PortalBadge com "Enviando…" animado, próximo retry em distance-now PT-BR, screenshot do portal, protocolo. Excelente. |
| H2 Mundo real | 5 | "Pendente envio", "Falha", "Aguardando", "Bloqueado por guardrail", "Cancelado (vazio)". |
| H3 Controle | 4 | Reenvio manual com confirmação; cancelar com motivo. Falta undo de cancelamento. |
| H4 Consistência | 4 | Mesma família visual do Cockpit; alguns badges com classes hardcoded. |
| H5 Prevenção | 4 | AlertDialog para reenvio; mensagens explícitas. |
| H6 Reconhecimento | 3 | Filtros existem mas sem persistência visível; recentes ausentes. |
| H7 Flex/eficiência | 3 | Sem atalhos; sem bulk reenvio; navegação entre pedidos requer voltar. |
| H8 Minimalista | 4 | Drawer denso mas legível. |
| H9 Recup. erro | 5 | Mensagens granulares de erro do portal; tentativas e backoff explícitos. Referência. |
| H10 Ajuda | 4 | Tooltip nos badges; ainda assim, "guardrail" sem explicação para o novato. |
| D1 Latência | 4 | Mutações com spinner; queryClient.invalidateQueries após sucesso. |
| D2 Densidade | 4 | Tabela densa correta para o perfil comprador. |
| D3 Ergonomia | 4 | Desktop. Botões h-8/h-9. |
| D4 Offline | 2 | Sem persistência local. |
| D5 Atalhos | 1 | Zero. |
| D6 Mobile/desktop | 3 | Drawer responsivo razoável; tabela quebra em <md. |

**Intervenções**:

- **H6** — Persistir filtros (search, fornecedor, status) em URL search params, igual padrão do TanStack Router/Linear. Permite compartilhar URL com colega ("vê esse filtro de pendentes da semana").
- **H7** — Atalhos: `j/k` para navegar entre pedidos da lista, `Enter` abre drawer, `a` aprovar, `c` cancelar, `r` reenviar portal, `?` ajuda. Estende `useKeyboardShortcuts`. Bulk reenvio multi-select.
- **H10** — Tooltip do termo "guardrail" com link "ver regras ativas em /admin/reposicao/parametros".
- **D4** — Cachear lista do dia em IndexedDB para leitura offline (read-only com banner).
- **D5** — Ver H7.
- **D6** — Cards verticais quando viewport <md, com botões 44px+. Padrão Polaris ResourceList em mobile.

**Veredicto**: **Precisa intervenção** — H1/H9 são exemplares mas faltam atalhos/persistência/offline.

---

# 5. `/sales` — SalesOrders

**Persona**: Vendedor (mobile/desktop) + gestão de vendas. Arquivo: [src/pages/SalesOrders.tsx](../../src/pages/SalesOrders.tsx)

Lista de pedidos consolidada (sales_orders + orders de afiação) com filtro por empresa (Tabs), busca por cliente/PV/item, ações compartilhar via WhatsApp, editar, excluir. `max-w-4xl` mobile-friendly. Cards verticais.

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 3 | Spinner inicial centralizado; sem indicador de freshness; sem skeleton. |
| H2 Mundo real | 4 | "Rascunho", "Enviado ao Omie", "Faturado" — bom. |
| H3 Controle | 3 | AlertDialog no excluir; sem undo após excluir; voltar via ChevronLeft. |
| H4 Consistência | 3 | StatusBadgeSimple para afiação coexiste com Badge variant para sales — duas linguagens visuais. |
| H5 Prevenção | 4 | Confirmação destrutiva no excluir. |
| H6 Reconhecimento | 4 | Busca por nome/PV/item/total; tabs com labels claras. |
| H7 Flex/eficiência | 1 | Sem atalhos, sem bulk, sem export. Vendedor com 200 pedidos faz scroll infinito. |
| H8 Minimalista | 3 | Cada card empilha 6-7 dados (cliente + badge + data + PV + status + total + qtd itens + 3 botões) — denso mas legível. Botões `h-7 w-7` minúsculos. |
| H9 Recup. erro | 3 | Toast no excluir; carregamento inicial só logga `console.error` sem mostrar nada para o usuário. |
| H10 Ajuda | 2 | Empty state genérico ("Nenhum pedido encontrado"); sem CTA, sem tip. |
| D1 Latência | 2 | Carrega TUDO de uma vez (sem paginação visível) — vendedor com carteira grande sente. |
| D2 Densidade | 4 | Cards adequados para mobile. |
| D3 Ergonomia | 2 | Botões `h-7 w-7` (28px) em mobile — inviável com luva ou em movimento (vendedor no carro). |
| D4 Offline | 1 | NetworkOnly no Workbox; vendedor offline no carro perde acesso. |
| D5 Atalhos | 1 | Zero. |
| D6 Mobile/desktop | 4 | Layout funciona em ambos; cards adequam-se. |

**Intervenções**:

- **H1** — Substituir spinner único por skeleton de 5 cards (já existe `<Skeleton>` shadcn). Adicionar timestamp de freshness ("atualizado há 2 min") no header.
- **H3** — Toast undo após exclusão (4s) que rollback a chamada `omie-vendas-sync`. Pattern Gmail.
- **H4** — Unificar StatusBadgeSimple com Badge usando `status-*` tokens — 1 fonte da verdade para mapping de status. Ver `index.css` linhas 282-311.
- **H7** — Atalhos: `n` novo pedido, `/` foca busca, `1/2/3/4` filtra empresa, `j/k` navega cards. Replicar pattern de Linear.
- **H8** — Reduzir botões a `h-9 w-9` mínimo (36px) ou consolidar 3 botões em DropdownMenu (...) — pattern Polaris ResourceList.
- **H9** — Erro de load com Alert + retry button ("Não conseguimos carregar seus pedidos. [Tentar novamente]").
- **H10** — Empty state com CTA "Criar primeiro pedido" + ilustração leve; em busca vazia, sugerir limpar filtros.
- **D1** — Paginação ou infinite scroll (cursor-based) em vez de carregar tudo. ~50 cards por página. React Query `useInfiniteQuery`. Adicionar `staleTime: 30s` e revalidar em foco.
- **D3** — Botões 44px+ em mobile via media query / variante "lg" do shadcn. Ver Carbon Design touch targets recommendations.
- **D4** — Stale-while-revalidate para `sales_orders` últimos 30d em IndexedDB; banner offline no topo.
- **D5** — Ver H7.

**Veredicto**: **Precisa intervenção** — uso diário do vendedor exige atalhos, paginação, alvos maiores e offline.

---

# 6. `/sales/new` (UnifiedOrder) — UnifiedOrder

**Persona**: Vendedor externo (mobile, offline) + cliente (afiação). Arquivo: [src/pages/UnifiedOrder.tsx](../../src/pages/UnifiedOrder.tsx)

Wizard de pedido com OrderStepper (Cliente → Itens → Revisão), 3 tabs (Oben/Colacor/Afiação), AI Assistant para staff, busca de cliente com validação de vendedor, recomendações cross-sell, CartSummaryBar com formas de pagamento, OrderSuccessDialog. Hook `useUnifiedOrder` agrega ~30k linhas de lógica.

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 4 | OrderStepper visível; loaders por seção; falta indicador "rascunho salvo automaticamente". |
| H2 Mundo real | 5 | "Cliente", "Itens", "Revisão", "Forma de pagamento", "Volumes". |
| H3 Controle | 3 | Voltar via ChevronLeft do navegador; remover item do cart OK; sem "salvar como rascunho explícito" nem desfazer adição. |
| H4 Consistência | 4 | Tabs + Forms shadcn. AI Assistant é único em UX (microfone); destoa visualmente mas é intencional. |
| H5 Prevenção | 3 | Validação de vendedor existe (vendedorDivergencias); falta confirmação ao sair do wizard com itens não submetidos (`beforeunload` ou modal). |
| H6 Reconhecimento | 4 | Histórico de compras do cliente, ranking de parcelas, recommendations cross-sell — bom. |
| H7 Flex/eficiência | 2 | Sem atalhos; busca de cliente sem `/` global; sem hotkey "+" para adicionar item. |
| H8 Minimalista | 3 | Tela carrega muita informação simultânea (AI + busca + tabs + cart + recomendações + summary bar). Vendedor novo se perde. |
| H9 Recup. erro | 3 | submitOrder loga e mostra toast genérico; sem fallback para retry; rascunho não persistido em offline. |
| H10 Ajuda | 2 | Sem tooltip nos campos não óbvios ("Volumes", "Ordem de compra obrigatória"); sem hint sobre o vendedorDivergencias. |
| D1 Latência | 3 | Múltiplas queries sequenciais (oben + colacor + customer + tools + serviços); sem optimistic ao adicionar ao cart. |
| D2 Densidade | 3 | Adequado para desktop; mobile fica empilhado e exige scroll vertical longo. |
| D3 Ergonomia | 3 | Botões padrão; sem variante touch-grande. Vendedor com luva grossa de transporte fica limitado. |
| D4 Offline | 1 | NetworkOnly em sales_orders/order_items; vendedor no carro perde a sessão se cair sinal. **Maior dor desta tela.** |
| D5 Atalhos | 1 | Zero. |
| D6 Mobile/desktop | 3 | Layout responsivo `lg:grid-cols-3` é desktop-first; o vendedor mobile recebe a página espremida. |

**Intervenções**:

- **H3** — Auto-save de rascunho no localStorage a cada mudança (debounce 500ms), com chave `draft_order_{customerId}`. Ao recarregar a página com cart vazio, oferecer "Você tinha um pedido em andamento. Restaurar?".
- **H5** — `useBeforeUnload` ou listener `beforeunload` quando `cart.length > 0 && !submitted`, com mensagem "Você tem itens não enviados. Sair mesmo assim?".
- **H7** — Atalhos: `c` foca cliente, `/` foca produto, `+` adiciona item, `Enter` confirma quantidade, `Cmd+S` salva rascunho explícito, `Cmd+Enter` envia pedido. Padrão Linear/Notion.
- **H8** — Reduzir AI Assistant a um botão flutuante (FAB) que abre modal — não disputa real estate principal. Recomendações compactadas em "5 sugestões" colapsável. Padrão Notion sidebar drawers.
- **H9** — Em onError do submitOrder, manter o cart, mostrar Alert com retry button + opção "salvar rascunho local".
- **H10** — Tooltips em "Volumes", "OC obrigatória", "Vendedor com divergência" (com link para o que isso significa).
- **D1** — Pré-fetch dos catálogos Oben/Colacor antes do step de itens (ainda no step Cliente). Optimistic UI ao adicionar ao cart (UI atualiza, hook persiste em background).
- **D2/D3** — Layout mobile específico: stepper colapsado, tabs verticais ou bottom sheet (vaul drawer) para itens, botões 48px+. Pattern Shopify Mobile POS.
- **D4** — IndexedDB para draft + queue de submissão. Vendedor cria pedido offline → quando volta online, dispara mutation. Banner persistente "Trabalhando offline · 2 pedidos na fila". **Esta é a intervenção mais crítica desta tela.**
- **D5** — Ver H7.
- **D6** — Ver D2/D3. Mobile-first refactor — não responsive afterthought.

**Veredicto**: **Reescrita necessária** para o vendedor mobile offline. O fluxo desktop-first interno está aceitável.

---

# 7. `/financeiro/cockpit` — FinanceiroCockpit

**Persona**: CFO / Controller (desktop). Arquivo: [src/pages/FinanceiroCockpit.tsx](../../src/pages/FinanceiroCockpit.tsx)

Cockpit consolidado: TransparencyBadge por empresa (% mapeado, % conciliado, status fechamento), 3 KPIs grandes (Caixa, Caixa Projetado, NCG), 4 mini cards (margens, inadimplência, aging crítico), tabela de Resultado por Empresa, Projeção 13 semanas, Top 5 inadimplentes, footer "Base dos números".

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 5 | TransparencyBadge é exemplar — mostra confiabilidade dos dados, % mapeado, status do fechamento. Pode virar referência. |
| H2 Mundo real | 5 | "Margem Bruta", "NCG", "Aging Crítico", "Regime de Caixa" — vocabulário CFO. |
| H3 Controle | 4 | DrillDown via setDrillDown; voltar fecha. Sem export do cockpit. |
| H4 Consistência | 3 | Cores hardcoded (`text-emerald-600`, `text-red-600`, `bg-amber-50`) em vez de tokens `status-*`. Quebra dark mode parcial. |
| H5 Prevenção | 4 | Footer "Base dos números" deixa claras as suposições. |
| H6 Reconhecimento | 4 | Mês corrente como default; nomes curtos das empresas. |
| H7 Flex/eficiência | 2 | Sem export PDF/Excel do cockpit; sem comparação mês anterior; sem atalhos. CFO normalmente quer levar o número para o board. |
| H8 Minimalista | 4 | Bem organizado; alguns elementos visuais (TransparencyBadge no header) ficam apertados. |
| H9 Recup. erro | 2 | `try/catch` silencioso em RPC e fin_confiabilidade — se a tabela não existir, **a tela carrega com dados parciais e o usuário não sabe**. |
| H10 Ajuda | 4 | Footer explicativo é bom; faltam tooltips por KPI ("Como calculamos NCG"). |
| D1 Latência | 3 | `loadAll` é paralelo OK, mas o for-loop sequencial de fin_confiabilidade (3 empresas) atrasa first paint. |
| D2 Densidade | 4 | Densidade adequada a CFO. |
| D3 Ergonomia | 5 | Desktop, sem necessidade de touch. |
| D4 Offline | 3 | Não-crítico para CFO; mas ler último snapshot offline ajuda. |
| D5 Atalhos | 1 | Zero. |
| D6 Mobile/desktop | 3 | Mobile lê mas tabela 13 semanas faz scroll horizontal feio. |

**Intervenções**:

- **H4** — Substituir cores hardcoded por classes `status-success-*`, `status-warning-*`, `status-error-*`. Base já existe em `index.css:282-311`. Garante coerência dark mode.
- **H7** — Botão "Exportar PDF" do cockpit inteiro (visualização print-friendly) e "Exportar XLSX" da tabela de DRE consolidada. Padrão Carbon Datagrid + Polaris export.
- **H7** — "Comparar com mês anterior" toggle que adiciona delta % em cada KPI ("R$ 1.2M, -8% vs Abr"). Padrão Linear Insights.
- **H9** — Banner amarelo no topo se `fin_confiabilidade` ou `fin_projecao_13_semanas` não retornaram dados — "Confiabilidade indisponível" e "Projeção indisponível" devem ser visíveis, não silenciosos. CFO precisa saber.
- **H10** — Popover com `<Info>` em cada KPI explicando fórmula ("NCG = CR aberto - CP aberto. Próximos 30 dias.").
- **D1** — Paralelizar fin_confiabilidade com `Promise.all`. Skeleton mais granular por bloco (não bloquear página inteira).
- **D5** — Atalhos: `e` exporta, `r` refetch, `1/2/3` foca por empresa, `?` ajuda.
- **D6** — Tabela de 13 semanas com `overflow-x-auto` mas em mobile vira gráfico (sparkline com tooltip) — visualização adequada ao espaço.

**Veredicto**: **Aceitável** — sólida, com TransparencyBadge sendo destaque. Falta export, atalhos e fallback explícito de dados parciais.

---

# 8. `/tintometrico/formulas` — TintFormulas

**Persona**: Operador tintométrico (desktop touchscreen, atendendo cliente em paralelo). Arquivo: [src/pages/TintFormulas.tsx](../../src/pages/TintFormulas.tsx)

Catálogo de fórmulas (~477k registros) com filtros (busca por código/nome, produto, base, switch personalizadas) + tabela paginada (50/pg) + linha expansível com receita de corantes e custo calculado.

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 3 | Skeleton durante load; sem indicador "buscando em 477k registros". Sem timestamp de sync. |
| H2 Mundo real | 4 | "Cor ID", "Nome cor", "Produto", "Base", "Embalagem", "Volume", "Personalizada" — vocabulário do balcão. |
| H3 Controle | 3 | Pagination sem "ir para página X" nem "última"; voltar para topo após expandir não é automático. |
| H4 Consistência | 3 | Cores das badges hardcoded (`bg-purple-500/10`, `bg-blue-500/10`); quebra padrão `status-*`. |
| H5 Prevenção | 4 | Filtros bem organizados; reset do produto reseta base — bom. |
| H6 Reconhecimento | 2 | Sem últimas fórmulas consultadas, sem favoritos do operador, sem busca por "RAL", "NCS", "Pantone" comuns no balcão. |
| H7 Flex/eficiência | 1 | Sem atalhos; sem busca cmd-k para "achar fórmula 12345" sem entrar na tela; sem favoritar; sem copiar receita rápida. |
| H8 Minimalista | 4 | Tabela limpa. |
| H9 Recup. erro | 2 | Sem error boundary visível; query sem fallback explícito. Em loja, "tela em branco" é catastrófico no atendimento. |
| H10 Ajuda | 2 | Sem tooltip explicando "personalizada", "preço CSV", "custo concentrado". Operador novato fica perdido. |
| D1 Latência | 2 | Busca via SQL `ilike %X%` em 477k registros sem índice trigram declarado — risco de 1-3s por busca. |
| D2 Densidade | 4 | Tabela densa apropriada. |
| D3 Ergonomia | 1 | Touchscreen mas linhas com `cursor-pointer` 28px de altura e ChevronUp/Down 16px. Operador no balcão atendendo cliente toca errado. |
| D4 Offline | 2 | Não cacheado; queda de sinal em loja = sem catálogo. Catálogo é semi-estático. |
| D5 Atalhos | 1 | Zero. |
| D6 Mobile/desktop | 3 | Layout funciona, mas é desktop-first; touchscreen do balcão precisa de ajustes. |

**Intervenções**:

- **H1** — Header com "X.XXX fórmulas · sincronizado há Xh". Skeleton durante load por bloco.
- **H6** — Top bar persistente "Recentes" (últimas 10 fórmulas consultadas via localStorage) e "Favoritos" (estrela na linha). Padrão Notion / Raycast favorites.
- **H6** — Adicionar busca por sinônimos / códigos comerciais comuns (RAL, Pantone, NCS) no campo Search com hint "Tente '7016' ou 'cinza ferro'".
- **H7** — Cmd-K global disparado de qualquer tela com query "fórmula <código>" leva direto à expansão. Botão copy "Copiar receita" na linha expandida (texto formatado para colar no dispenser ou WhatsApp).
- **H9** — Error boundary específica nesta página com mensagem "Catálogo temporariamente indisponível. Última versão sincronizada disponível offline." (depende de D4).
- **H10** — Tooltips: "Personalizada" = fora do catálogo padrão SAYERSYSTEM; "Preço CSV" = preço sugerido pelo fabricante; "Custo concentrado" = custo do corante por ml.
- **D1** — Garantir índice GIN trigram na coluna `nome_cor` e `cor_id` para `ilike` rápido. Debounce 200ms no input. Servidor com `pg_trgm`.
- **D3** — Linhas 56px+ no touchscreen (variante densidade especial para balcão). ChevronDown maior. Tap target da linha inteira para expandir.
- **D4** — Catálogo cacheado em IndexedDB com versionamento por `synced_at`. Permite operação 100% offline para consulta. Atualização incremental quando online.
- **D5** — Ver H7.
- **D6** — Renderizar variant "balcão" (touchscreen) quando viewport >= 1024 e `pointer: coarse` (touch detected).

**Veredicto**: **Reescrita necessária** — coração do atendimento no balcão. Hoje é uma tabela CRUD, precisa virar "buscador de fórmula otimizado para fluxo de atendimento".

---

# 9. `/nfe-receipt` — NfeReceipt

**Persona**: Almoxarife / conferente (desktop). Arquivo: [src/pages/NfeReceipt.tsx](../../src/pages/NfeReceipt.tsx)

Tela mínima: select empresa + input número NF + botão "Processar NF-e", chama Edge function `process-nfe`, mostra log de steps com ícones success/warning/error.

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 4 | Loader durante chamada; ícones por step; "Processando..." no final. |
| H2 Mundo real | 4 | "Processar NF-e" + log de etapas. Título "OBEN Recebimento NF-e" hardcoda OBEN — confunde quando seleciona Colacor. |
| H3 Controle | 2 | Sem cancelar processamento (Edge function pode demorar 30-60s); sem histórico das últimas tentativas. |
| H4 Consistência | 3 | Mistura emojis (✅ ❌) com ícones lucide. |
| H5 Prevenção | 3 | Sem confirmação "vai processar NF-e 12345 da Oben?"; reprocessar mesma NF não avisa. |
| H6 Reconhecimento | 1 | Sem histórico, sem últimas processadas, sem autocomplete de número de NF. |
| H7 Flex/eficiência | 3 | Enter aciona o botão (bom). Sem atalho global; sem bulk de NFs. |
| H8 Minimalista | 5 | Tela mínima e clara. |
| H9 Recup. erro | 3 | Mensagem do erro mostrada em log; sem retry com 1 clique; sem "ver detalhes técnicos". |
| H10 Ajuda | 2 | Sem explicação de quando usar essa tela vs `/recebimento`. |
| D1 Latência | 3 | Processamento síncrono pode travar 30s+; usuário não tem progresso granular (só steps quando completo). |
| D2 Densidade | 5 | Adequada. |
| D3 Ergonomia | 4 | Botões 36-40px desktop OK. |
| D4 Offline | 1 | Operação 100% online; não há fallback. |
| D5 Atalhos | 2 | Só Enter. |
| D6 Mobile/desktop | 4 | Funcional em ambos. |

**Intervenções**:

- **H2** — Título dinâmico: "Recebimento NF-e — {empresa selecionada}".
- **H3/H6** — Tabela "Últimas 10 processadas" abaixo do form com status final, link para reprocessar, link para `/recebimento/:id`.
- **H4** — Trocar emoji por ícone lucide (CheckCircle2, XCircle).
- **H5** — Confirmar reprocessamento se a NF já foi processada na última hora.
- **H7** — Atalhos: `/` foca número, `Enter` processa, `Esc` limpa.
- **H9** — Botão "Tentar novamente" no Badge final de erro; link "Ver log completo" com modal de detalhes.
- **H10** — Hint sob o botão: "Esta tela processa uma NF-e por número. Para conferência item-a-item, use Recebimento."
- **D1** — Stream de progresso da Edge function via Supabase Realtime ou polling — mostrar steps conforme aparecem, não só no final.
- **D4** — Não há como (depende de Edge function); sinalizar bloqueio com banner offline + estimar quando voltará.

**Veredicto**: **Precisa intervenção** — utility tool simples, mas o histórico e o reprocessamento mudam UX significativamente. Rebaixar prioridade no roadmap se outras telas mais críticas demandarem horas.

---

# 10. `/admin/customers` — AdminCustomers

**Persona**: Gestão comercial / vendedor / atendimento. Arquivo: [src/pages/AdminCustomers.tsx](../../src/pages/AdminCustomers.tsx) (vista parcial)

Lista densa com tabela de clientes (nome, doc, saúde com badge, gasto mensal, dias s/ compra, prioridade), filtro por health_class via DropdownMenu, busca, drill-down para Customer360View. Tem `requires_po` toggle inline.

| Critério | Score | Justificativa |
|---|---|---|
| H1 Status | 3 | Loader genérico; sem skeleton de tabela; sem timestamp da carteira. |
| H2 Mundo real | 4 | "Saúde", "Gasto mensal", "Dias s/ compra", "Prioridade", "Saudável/Alerta/Crítico" — vocabulário CRM correto. |
| H3 Controle | 3 | Voltar OK; toggle `requires_po` rollback em erro (bom); sem undo bulk. |
| H4 Consistência | 4 | Tabela com classes `status-*` (saudavel→success, alerta→pending, critico→danger). Bom uso dos tokens. |
| H5 Prevenção | 4 | Toggle `requires_po` com optimistic + rollback explícito. Bom padrão. |
| H6 Reconhecimento | 3 | Filtro por saúde + search; sem filtros salvos, sem segmentação visível. |
| H7 Flex/eficiência | 2 | Sem atalhos; sem bulk action (atribuir vendedor, exportar segmento, enviar campanha); sem export. |
| H8 Minimalista | 3 | Coluna "Prioridade" só com número (sem contexto); algumas colunas hidden em <md/<lg sem indicação. |
| H9 Recup. erro | 3 | Loader sem fallback de erro visível; toggle tem toast. |
| H10 Ajuda | 2 | Sem explicação de "health_score", "priority_score" (são scores derivados de modelo). Vendedor novo não entende. |
| D1 Latência | 3 | Carrega clientes + scores em sequência (pelo que vi); sem paginação visível. |
| D2 Densidade | 4 | Boa para gestão; tabela compacta. |
| D3 Ergonomia | 3 | Botões padrão; mobile esconde colunas mas a row ainda é só 40px. |
| D4 Offline | 2 | Não cacheado. |
| D5 Atalhos | 1 | Zero. |
| D6 Mobile/desktop | 3 | Tabela responsiva OK; profile 360 não revisado. |

**Intervenções**:

- **H1** — Skeleton de 8 linhas em vez de loader; mostrar "X clientes na carteira · atualizado há Xmin".
- **H6** — Filtros salvos em URL (sharable). Segmentos pré-definidos como chips ("Críticos sem compra 60d+", "Alta prioridade sem vendedor"). Padrão Linear / HubSpot Lists.
- **H7** — Atalhos: `/` foca search, `j/k` navega linhas, `Enter` abre cliente, `f` filtros, `e` export. Bulk select com Shift+click + ações "atribuir vendedor", "exportar CSV", "enviar campanha". Padrão Retool table actions.
- **H8** — Coluna "Prioridade" com mini-bar visual (0-100 progress) e tooltip "score derivado de gasto + recência + ticket médio".
- **H9** — Error state com "Não conseguimos carregar clientes. [Recarregar]".
- **H10** — Popover `<Info>` no header de cada coluna calculada explicando o método ("health_score: combina recência, frequência e margem dos últimos 180d").
- **D1** — Paginação cursor-based ou virtual scroll (`@tanstack/react-virtual`) para carteiras de 1k+ clientes.
- **D3** — Aumentar row mínima para 48px em mobile; touch target da linha inteira para drill-down.
- **D4** — Cachear top 100 clientes do vendedor em IndexedDB para consulta offline.
- **D5** — Ver H7.

**Veredicto**: **Precisa intervenção** — base sólida; falta atalhos, segmentos salvos, bulk e tooltip dos scores derivados.

---

# Resumo executivo da Fase 2

## Veredicto por tela

| # | Tela | Veredicto |
|---|---|---|
| 1 | AdminEstoquePicking | **Reescrita** (perspectiva separador mobile) |
| 2 | RecebimentoConferencia | Precisa intervenção |
| 3 | AdminReposicaoCockpit | **Aceitável** — referência interna |
| 4 | AdminReposicaoPedidos | Precisa intervenção |
| 5 | SalesOrders | Precisa intervenção |
| 6 | UnifiedOrder | **Reescrita** (vendedor mobile offline) |
| 7 | FinanceiroCockpit | **Aceitável** |
| 8 | TintFormulas | **Reescrita** (UX de balcão) |
| 9 | NfeReceipt | Precisa intervenção (escopo menor) |
| 10 | AdminCustomers | Precisa intervenção |

3 reescritas, 6 intervenções, 2 aceitáveis (Cockpit Reposição e Cockpit CFO).

## Padrões transversais que aparecem em ≥5 telas

1. **Zero atalhos de teclado fora do AdminReposicaoCockpit** — H7 e D5 cravados em 1 em todas as outras 9 telas.
2. **Zero offline-resilience real** — D4 cravado em 1-2 nas telas operacionais. Workbox `NetworkOnly` em quase todas as rotas críticas.
3. **Zero optimistic UI sistemática** — D1 oscila 2-4; toda mutação aguarda roundtrip.
4. **Touch targets abaixo de 44px** em telas mobile (`h-7 w-7`/`h-8 w-8` recorrente) — D3 com 1-3 em mobile/touchscreen.
5. **Cores hardcoded** (`text-emerald-600`, `bg-amber-50/15`) em vez de tokens `status-*` — quebra dark mode parcial e dificulta consistência.
6. **Empty states e error states genéricos ou silenciosos** — H9/H10 frequentemente 2-3.
7. **Sem cmd-k global / busca global** — confirma o gap arquitetural já mapeado em CLAUDE.md §11.
8. **Sem persistência de filtros / segmentos salvos / favoritos** — H6 frequentemente 2-3.

## Referências internas (replicar para o resto do app)

- `AdminReposicaoCockpit.useKeyboardShortcuts` + `ShortcutsDialog` — pattern de atalhos com dialog `?` deve virar lib do projeto.
- `AdminReposicaoPedidos.PortalDrawer` — modelagem de status de processamento async (pendente → enviando → enviado/falha + retry exponencial + screenshot) é referência para qualquer fluxo com integração externa.
- `FinanceiroCockpit.TransparencyBadge` — exibir confiabilidade dos dados como first-class UI é referência para qualquer dashboard com dados derivados.
- `RecebimentoConferencia.handleRepeatLote` — reaproveitamento de input recente é UX exemplar para reduzir digitação repetitiva.
- `RecebimentoConferencia` header sticky com Progress global — modelo para qualquer tela de fluxo linear.

## Observações fora do escopo de UX

- **Discrepância de Account/Empresa**: `SalesOrders.tsx` usa `Account = 'oben' | 'colacor' | 'afiacao' | 'all'` enquanto `CompanyContext` define `'colacor' | 'oben' | 'colacor_sc'`. "afiacao" como account vs CompanyContext é divergente — Colacor SC não aparece no filtro de SalesOrders.
- **NfeReceipt hardcoda "OBEN"** no título mesmo permitindo selecionar Colacor/Afiação — bug de copy.
- **`UnifiedOrder` redirect via `/unified-order` → `/sales/new`** — confirmar zero uso e remover.
- **`useSalesOrders` carrega TUDO sem paginação** — risco de performance em produção com volumes altos (`SalesOrders.tsx:72-131`).
- **`AdminCustomers.fetch` não revisado completamente** — pode ter o mesmo padrão de carregar tudo sem paginação.
- **`AdminReposicaoCockpit` faz fallback silencioso `await supabase.from('cockpit_audit_log' as any).insert(...)` com try/catch sem log** — perda de dados de auditoria potencialmente invisível.
- **`fin_confiabilidade` e `fin_projecao_13_semanas`** podem não existir no schema (try/catch silencioso em `FinanceiroCockpit.tsx:101-118`) — UX silenciosa esconde gap de schema.
- **`SalesOrders.deleteOrder` chama `omie-vendas-sync` ação `excluir_pedido`** — exclusão sem soft-delete; risco compliance.
- **Política de RLS não auditada nesta passada** (out-of-scope; lembrete do briefing).
