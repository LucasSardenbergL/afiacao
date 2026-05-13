# CLAUDE.md — Afiação (Sistema Operacional B2B Sardenberg)

> Este arquivo orienta agentes de código (e humanos) trabalhando neste repositório. Última atualização: 2026-05-13 (auditoria UX completa, Fases 0-4 entregues e fix do `Bell` import aplicado — ver `docs/ux-audit/`).

---

## 1. Produto

**Afiação** é o sistema operacional B2B do grupo Colacor. O repositório nasceu como portal do serviço de afiação de ferramentas; o serviço foi absorvido como um módulo, **Colacor virou o nome-mãe** do app e do grupo, e o produto se expandiu para vendas, estoque, financeiro, tintometria, reposição inteligente, produção e governança das três empresas (uma indústria de abrasivos, uma distribuidora para indústria moveleira, uma prestadora de serviços).

### Empresas (estado real no código + modelo de negócio confirmado)

Definidas em `src/contexts/CompanyContext.tsx`:

| ID            | Nome no código        | Negócio                              | Modelo                        | Regime    |
| ------------- | --------------------- | ------------------------------------ | ----------------------------- | --------- |
| `colacor`     | Afiação Colacor ⚠️    | Indústria de abrasivos          | Vende itens industrializados  | presumido |
| `oben`        | Oben Comercial        | Distribuidora p/ indústria moveleira | Compra e revende              | presumido |
| `colacor_sc`  | Colacor SC            | Serviços                             | Presta serviço                | simples   |

> ⚠️ **Rename pendente** (registrado em §10): `Afiação Colacor` precisa virar `Colacor` no `CompanyContext`. A afiação é hoje um módulo dentro do app, não a identidade da empresa.

### Módulos efetivamente implementados (rotas em `src/App.tsx`)

| Módulo            | Prefixo de rota             | Páginas (qtd. aprox.) | Persona dominante                |
| ----------------- | --------------------------- | --------------------- | -------------------------------- |
| Cliente (afiação) | `/orders`, `/tools`, etc.   | ~15                   | Cliente final / staff de balcão  |
| Vendas            | `/sales/*`                  | ~7                    | Vendedor / comercial             |
| Estoque           | `/admin/estoque/*`, `/recebimento` | ~4              | Conferente / separador           |
| Reposição (compras) | `/admin/reposicao/*`      | ~20                   | Comprador / gestor de suprimentos |
| Financeiro        | `/financeiro/*`             | ~12                   | CFO / financeiro                 |
| Tintométrico      | `/tintometrico/*`           | ~12                   | Operador tintométrico / gestor    |
| Inteligência / Farmer | `/farmer/*`, `/intelligence`, `/ai-ops` | ~10 | Comercial / gestor               |
| Governança        | `/governance/*`, `/gestao/*` | ~8                    | Master                           |
| Produção          | `/producao`                 | 1                     | Operador fábrica                 |
| Documentação interna | `/design-system`, `/ux-rules`, `/docs`, `/admin/ajuda` | 4 | Dev / staff       |

Total: **119 páginas registradas** em `src/pages/`, com lazy-loading em `App.tsx:16-136`.

---

## 2. Stack

- **Frontend**: React 18.3.1 + TypeScript 5.8.3 + Vite 5.4.19 + `@vitejs/plugin-react-swc`
- **Roteamento**: react-router-dom 6.30.1 (lazy routes)
- **Estado servidor**: `@tanstack/react-query` 5.83.0 (`staleTime: 60s`, sem `refetchOnWindowFocus`, `retry: 2`)
- **UI**: shadcn/ui (50+ componentes em `src/components/ui`) sobre Radix UI primitives
- **Estilo**: Tailwind 3.4.17 + `tailwindcss-animate` + `@tailwindcss/typography`
- **Animação**: `framer-motion` 12 (usado em `EmptyState`, `BottomNav`, alguns dialogs)
- **Forms**: `react-hook-form` 7.61 + `zod` 3.25 + `@hookform/resolvers`
- **Backend**: Supabase (Postgres + Auth + Storage + Realtime), 164 migrations em `supabase/migrations`, 48 Edge Functions em `supabase/functions`
- **PWA**: `vite-plugin-pwa` com Workbox — `NetworkFirst` apenas para catálogo, `NetworkOnly` para `orders/profiles/sales_orders/order_items` (ver §5)
- **OCR**: `tesseract.js` 5.0 (usado em `RecebimentoConferencia` / `LoteScannerOCR`)
- **Mapas**: `leaflet` 1.9 + `@types/leaflet` (route planner)
- **Charts**: `recharts` 2.15
- **Comando**: `cmdk` 1.1.1 — **instalado mas NÃO usado como command palette global**, apenas o `Command` wrapper shadcn está disponível em `src/components/ui/command.tsx`
- **Voz/IA**: `@elevenlabs/react` 0.14 (transcribe)
- **Drag-and-drop**: `@hello-pangea/dnd` 17 (kanban)
- **Toasts**: `sonner` 1.7 + Radix toast (dois sistemas coexistem — ver §10)
- **Hospedagem**: Lovable Cloud (componentTagger em dev)

### Scripts

```bash
bun dev       # vite dev server (porta 8080)
bun build     # vite build (PWA gerado em production)
bun build:dev # build em modo dev (sem PWA)
bun lint      # eslint
bun test      # vitest run
bun preview   # vite preview
```

---

## 3. Estrutura de pastas

```
src/
├── App.tsx                  # Routes + providers (QueryClient, Tooltip, Toaster, Auth, Company, ErrorBoundary, Suspense)
├── main.tsx                 # Bootstrap
├── index.css                # Design tokens (CSS vars HSL), tipografia, utilitários
├── components/
│   ├── AppShell.tsx         # Sidebar desktop + topbar + mobile drawer (sem cmd-k, sem busca global)
│   ├── AppShellLayout.tsx   # Wrapper p/ Outlet
│   ├── BottomNav.tsx        # Inativa dentro de AppShell (return null via useInsideAppShell)
│   ├── Header.tsx           # Header mobile legado (também inativa dentro de AppShell)
│   ├── ui/                  # shadcn (50 componentes)
│   ├── admin-order/         # Subcomponentes da OS admin
│   ├── des/                 # Dashboard executivo seções
│   ├── financeiro/          # ...
│   ├── help/                # HelpDrawer
│   ├── intelligence/        # ...
│   ├── portalSayerlack/     # ...
│   ├── recebimento/         # LoteScannerOCR etc.
│   ├── reposicao/           # ...
│   └── unified-order/       # Wizard de pedido
├── contexts/
│   ├── AuthContext.tsx      # Roles + fail-closed approval
│   ├── CompanyContext.tsx   # 3 empresas (localStorage)
│   ├── AppShellContext.tsx  # Flag p/ headers legados se silenciarem
│   └── ReposicaoEmpresaContext.tsx
├── hooks/                   # 36 hooks (engines de bundle, copilot, cross-sell, tactical-plan, biometric, etc.)
├── integrations/supabase/   # Client + types gerados
├── lib/                     # format, logger, phone, agruparPorMes, help-utils, reposicao/
├── pages/                   # 119 páginas
├── queries/                 # Hooks de react-query (useProfile, useOrders, useUserTools)
├── services/                # ...
├── types/                   # ...
└── utils/                   # ...
supabase/
├── migrations/              # 164 arquivos timestamped
├── functions/               # 48 Edge Functions
└── config.toml
docs/
├── FINANCEIRO_CONFIABILIDADE.md
├── ONDA1_FOLHA_EVIDENCIAS.md
└── ONDA1_PLANO_OPERACIONAL.md
└── ux-audit/                # ← criado nesta auditoria
```

---

## 4. Design System (estado atual)

### Tokens (`src/index.css`)

- Cores em HSL via CSS vars (`--primary`, `--surface-0..3`, `--status-success/warning/error/info/pending/progress/danger/purple/indigo`, `--sidebar-*`)
- Modo dark via classe `.dark`
- Tipografia: Inter (sans), JetBrains Mono (mono), Space Grotesk e Bebas Neue carregados em `index.html` (legado — usados em Header/EmptyState como `font-display`)
- Escala de tamanho: 2xs(10) → xs(12) → sm(13) → **base(14, default body)** → md(15) → lg(16) → xl(18) → 2xl(20) → 3xl(24) → 4xl(30) → 5xl(36)
- Espaçamento custom: 0.5(2) / 1(4) / 1.5(6) / 2(8) / 3(12) / 4(16) / 5(20) / 6(24) / 8(32) / 10(40) / 12(48) / 16(64) / 20(80) / 24(96), mais tokens semânticos `sidebar(240)`, `sidebar-collapsed(56)`, `topbar(48)`
- Radius: `--radius: 0.5rem` (com lg/md/sm derivados)
- Shadows: xs / sm / md / lg / xl / focus
- Motion: `--duration-fast: 100ms`, `--duration-normal: 200ms`, `--duration-slow: 350ms`
- Densidade: classes `.density-compact` (row 36/input 32/card 12/gap 4) e `.density-comfortable` (row 44/input 40/card 16/gap 8). **AppShell aplica `density-compact` globalmente** (`AppShell.tsx:552`).

### Inspirações declaradas (na página `DesignSystem.tsx:115`)

> "Tokens, componentes e padrões — HubSpot Canvas + Shopify Polaris + Gong"

> ⚠️ **Realinhar para o briefing oficial**: Linear (velocidade percebida) · Notion (cmd-k) · Carbon Design System / IBM (densidade B2B) · Shopify Polaris (operacional) · Retool (internal tools). HubSpot Canvas e Gong saem da régua. A interseção real do existente é apenas Polaris.

### shadcn/ui — componentes presentes (`src/components/ui`)

Todos os primitivos esperados: accordion, alert-dialog, alert, avatar, badge, breadcrumb, button, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, form, hover-card, input-otp, input, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, switch, table, tabs, textarea, toast, toaster, toggle-group, toggle, tooltip.

### Padrões de layout

- **Desktop**: sidebar dark fixa à esquerda (colapsível, 240/56px) + topbar fixo no topo (48px) + main com `pt-topbar` e `lg:ml-sidebar`
- **Mobile (<lg)**: sidebar dark vira drawer overlay (`MobileNav`), topbar mantido, sem bottom-nav ativa
- **Bottom-nav legado** (`BottomNav.tsx`): existe mas é silenciada quando dentro de AppShell — só ativa em telas fora da Shell (rotas públicas)
- **Densidade**: compact (32px input / 36px row) aplicada globalmente — ver §11
- **Empty states**: `src/components/EmptyState.tsx` é "consumer-grade" (motion floating, ícone arredondado grande, descrição centralizada) — destoa do registro B2B do resto do shell

### Navegação (sidebar, `AppShell.tsx:38-127`)

Seções: Principal · Afiação · Vendas · Estoque · Reposição · Produção · Performance · Inteligência · Financeiro · Tintométrico · Automação · Gestão · Documentação. Badges numéricos com contagem em tempo real (refetch 30–60s) em: alertas outlier, pedidos pendentes, aumentos ativos, oportunidades, negociação paralela, notificações, alertas críticos parâmetros, financeiro atrasados, tint erros.

### Topbar (`AppShell.tsx:434-481`)

Apenas: botão mobile menu (lg:hidden) · HelpDrawer · botão Bell (sem badge, sem onClick, **ornamental**) · dropdown User (Meu perfil / Sair). **Sem campo de busca global, sem command palette, sem trocador de empresa, sem indicador de online/offline, sem indicador de empresa ativa.**

---

## 5. Padrões críticos do domínio

### Auth & roles

- `AppRole = 'employee' | 'customer' | 'master'` (em `src/contexts/AuthContext.tsx`)
- `isStaff = isAdmin || isEmployee || isMaster`
- Aprovação: customers precisam de `is_approved` no profile; staff é auto-aprovado
- **Fail-closed**: se a query de role/approval falha, role vai a `null` e approval a `false` (`AuthContext.tsx:62-113`) — bom para segurança
- Restrição "sales-only" por CPF: `useSalesOnlyRestriction` (`AppShell.tsx:138`) — esconde tudo exceto seção Vendas para CPFs listados em `company_config.sales_only_cpfs`
- Tabela paralela `commercial_roles` define funções comerciais (gestor / vendedor) sem ser parte do role principal

### Mapeamento de personas → acesso (decisão oficial)

As 5 personas operacionais não viram roles novos no banco — elas são **recortes de acesso** mapeados sobre os 3 roles existentes + `commercial_roles` + uma futura noção de "departamento":

| Persona              | Acesso esperado                                                                 | Como mapear hoje                            |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| Vendedor externo     | `/sales/*`, `/farmer/*`, `/admin/customers`                                     | `commercial_roles.commercial_role = vendedor` |
| Gestão (vendas)      | Tudo de vendas + dashboards + dashboards comerciais                             | `commercial_role = gestor`                  |
| Separador            | `/admin/estoque/picking` (mobile)                                               | Persona/dept de estoque (a criar)           |
| Conferente           | `/recebimento`, `/admin/estoque/recebimento` (desktop)                          | Persona/dept de estoque (a criar)           |
| Operador tintométrico | `/tintometrico` + telas de balcão                                              | Persona/dept tintométrico (a criar)         |
| Comprador            | `/admin/reposicao/*`                                                            | Persona/dept de compras (a criar)           |
| Gestão (geral)       | Cockpits financeiro/CFO, intelligence, governança                               | `master` ou `employee` + dept gestão        |

> Implementação concreta dessas personas é trabalho de produto futuro; nesta auditoria UX, **assumo que cada tela tem persona dominante conhecida** e diferencio densidade, alvo de toque, atalhos e fluxo conforme essa persona. As propostas de granularidade de acesso ficam fora do escopo, mas viram observação no roadmap.

### Offline & PWA (`vite.config.ts:21-89`)

- Workbox `registerType: autoUpdate`, `skipWaiting`, `clientsClaim`
- **Cache**: `NetworkFirst` SÓ para `tool_categories | default_prices | company_config | category_mappings` (1h)
- **NetworkOnly**: `orders | profiles | order_messages | user_tools | sales_orders | order_items` — **e também auth/realtime**
- Nenhum endpoint de `picking_*`, `nfe_*` ou `recebimento_*` está no workbox — **sem cache, sem offline**
- **Não há queue de mutação offline, nem indicador de online/offline na UI** (busca por `navigator.onLine` retorna 0 ocorrências em `src/`, exceto na documentação)
- A configuração atual é hostil ao princípio "offline-first em picking e recebimento" do briefing. Ver §11.

### Latência percebida & optimistic UI

- React Query default: `staleTime: 60s`, sem refetch em focus
- Nenhum padrão sistemático de `useMutation({ onMutate, onError: rollback })` para optimistic UI — auditar caso a caso
- Skeletons via `<Skeleton />` shadcn (uso esparso; em `App.tsx` o Suspense fallback é genérico 3-bloco)

### Atalhos de teclado

- `src/hooks/useKeyboardShortcuts.ts` — hook básico (sem modifiers, sem composição, sem registry, sem help overlay)
- Usado em apenas 1 página em produção: `AdminReposicaoCockpit.tsx`
- **Sem cmd-k global, sem `/` para busca, sem `j/k` navegação, sem `?` para help, sem `esc` cancela global**

### Barcode scanning

- Pacote `cmdk` instalado mas BarcodeDetector NÃO usado em nenhum lugar (`grep` zero ocorrências em `src/`)
- Único scanner é OCR Tesseract para lote/validade no recebimento (`LoteScannerOCR`)
- Briefing afirma "BarcodeDetector API" como integração — **aspiracional, não implementado**

### Touch targets

- `index.css:228-230`: `button, a, [role="button"] { min-height: 32px; }` aplicado globalmente
- `button.tsx`: `default h-9 (36px)`, `sm h-8 (32px)`, `lg h-10 (40px)`, `icon h-9 w-9 (36px)`
- **Nenhuma variante atinge 44px**, o que viola o mínimo WCAG AA para uso com luva em chão de fábrica (briefing pede 44px+)

### Toast / feedback

- Dois sistemas coexistem: `Toaster` (Radix-shadcn) em `components/ui/toaster.tsx` e `Sonner` em `components/ui/sonner.tsx`, ambos montados em `App.tsx:160-161`
- Auditar inconsistência de invocação (`toast()` de sonner vs `useToast()` de radix-shadcn)

### Logger

- `src/lib/logger.ts` — wrapper estruturado com níveis (info/error/critical), usado consistente em AuthContext

### Convenções de código

- Pages em PascalCase (`AdminReposicaoCockpit.tsx`)
- Hooks em camelCase com prefixo `use` (`useUnifiedOrder.ts`)
- Idioma: **português brasileiro** em rotas (`/recebimento`, `/reposicao`, `/tintometrico`) **e** em código (estados, labels, comments, nomes de funções tipo `agruparPorMes`)
- Imports absolutos via alias `@/` configurado em `vite.config.ts:92`
- Tabelas Supabase com nomes em `snake_case` português: `eventos_outlier`, `pedido_compra_sugerido`, `fornecedor_aumento_anunciado`, `picking_tasks`, `nfe_recebimentos`, etc.

---

## 6. Princípios não-negociáveis (do briefing)

1. **Offline-first em picking e recebimento** — hoje não implementado
2. **Latência percebida <100ms em scan de barcode** — hoje sem barcode
3. **Densidade alta em telas operacionais (B2B, não consumer)** — `density-compact` global é direção correta
4. **WCAG AA mínimo, AAA em críticas** — focus-visible OK; touch targets abaixo do mínimo
5. **Mobile-first em chão de fábrica, desktop-first em telas analíticas** — Shell atual é desktop-first em ambos
6. **Cmd-k global, atalhos consistentes (j/k navegação, esc cancela, e edit, / busca)** — hoje inexistente

---

## 7. Referências de UX a usar como benchmark

Conforme briefing oficial:

- **Linear** — velocidade percebida, command palette, optimistic UI, atalhos descobríveis
- **Notion** — cmd-k, hierarquia, in-context editing
- **Carbon Design System (IBM)** — densidade B2B
- **Shopify Polaris** — operacional B2B
- **Retool** — internal tools, tabelas densas, bulk actions

**Anti-referências (não usar)**: Material Design 3 (consumer-grade), aesthetic Stripe landing, Bootstrap genérico.

---

## 8. Perfis de usuário (do briefing) e suas restrições

| Persona              | Plataforma            | Restrições reais                                         |
| -------------------- | --------------------- | -------------------------------------------------------- |
| Separador almox.     | Mobile/handheld       | Luva, ambiente ruidoso, luz variável, Wi-Fi ruim, 1 mão  |
| Conferente           | Desktop + teclado     | Densidade altíssima, foco em volume                      |
| Comprador            | Desktop               | Análise tipo planilha, comparações                       |
| Vendedor externo     | Mobile, frequente offline | No carro, dirigindo entre clientes                   |
| Gestão               | Desktop               | Dashboards, KPIs, drill-down                             |

> Hoje o sistema **não diferencia** essas personas no role principal — a UX assume um staff genérico. Propor diferenciação onde a tela exigir.

---

## 9. Auditoria UX (entregue)

Quatro fases concluídas. Artefatos em `docs/ux-audit/`:

- ✅ **Fase 0** — Setup + este CLAUDE.md
- ✅ **Fase 1** — Inventário de telas em [docs/ux-audit/01-inventario.md](docs/ux-audit/01-inventario.md)
- ✅ **Fase 2** — Auditoria heurística (Nielsen + critérios de domínio D1-D6) das 10 telas top em [docs/ux-audit/02-heuristica.md](docs/ux-audit/02-heuristica.md)
- ✅ **Fase 3** — Roadmap ICE com top 20 intervenções em [docs/ux-audit/03-roadmap.md](docs/ux-audit/03-roadmap.md)
- ✅ **Fase 4** — Execução completa em [docs/ux-audit/04-execucao.md](docs/ux-audit/04-execucao.md) (20/20 itens entregues; alguns como scaffold pendente decisão de produto/schema)

### Padrões e infra novos disponíveis para uso geral

Resultado da Fase 4 — usar nas próximas features:

- **Atalhos**: `useRegisterShortcuts({ keys, label, group, handler })` em qualquer página. Dialog `?` global no shell mostra automaticamente.
- **Cmd-K**: `useRegisterCommands([{ id, label, group, perform }])` para contribuir comandos contextuais à palette.
- **Filtros sharable**: `useUrlState({ search: '', status: 'all' })` substitui useState com sync URL (replace, sem PII).
- **Optimistic UI**: `useOptimisticMutation({ queryKey, optimisticUpdate, successToast, errorToast })` em vez de useMutation cru para latência <100ms.
- **Touch-friendly**: `<Button size="touch" />` (44px) ou `size="balcao"` (56px) em telas mobile/touchscreen.
- **Empty states**: `<EmptyState tone="operational" />` é o default B2B; `tone="friendly"` para customer-facing.
- **Skeletons**: `<PageSkeleton variant="cockpit | list | form | detail" />` em vez de spinner.
- **Status colors**: classes `text-status-success/warning/error/info` em vez de `text-emerald-600` etc.
- **Toast**: `import { toast } from 'sonner'` é o canônico; `useToast` antigo continua via wrapper (legado).
- **Network**: `useNetworkStatus()` e `<NetworkStatusIndicator />` (montado no shell). Para fila offline: `enqueue()`/`flush()` de `@/lib/offline-queue`.
- **Bulk**: `useBulkSelection(orderedIds)` + `<BulkActionsBar count actions />` para tabelas com seleção múltipla.

### Convenções pós-auditoria

- **Não criar novos `useState` para filtros** em telas de lista — use `useUrlState`.
- **Não escrever `text-emerald-600` / `text-red-600` etc.** em código novo — use `text-status-*`.
- **Não criar novos atalhos via listener `keydown` solto** — use `useRegisterShortcuts`.
- **Não usar `<Loader2 spin />` centralizado** como fallback de página inteira — use `PageSkeleton`.
- **Não montar novo Toaster** — só Sonner está ativo no AppShell.

---

## 10. Bugs/contradições/débitos detectados (fora do escopo de UX)

Levantados durante a Fase 0; **não consertar agora**, apenas registrar:

- **Rename `Afiação Colacor` → `Colacor`** em `src/contexts/CompanyContext.tsx:13` — Colacor é hoje o nome-mãe, afiação virou módulo. Procurar referências em telas/badges também.
- **Branding stale**: `index.html` ainda diz "Colacor - Afiação Profissional" e PWA manifest tem `name: "Colacor - Afiação Profissional"` (`vite.config.ts:27`). Atualizar para refletir o B2B-OS multi-empresa Colacor.
- **Logo da sidebar**: `Scissors` (tesoura) + label "Central" (`AppShell.tsx:331-337`) — visualmente ainda alinhado ao escopo afiação original. Reavaliar identidade visual.
- **Bell ornamental**: botão de notificações no topbar (`AppShell.tsx:458-460`) não tem `onClick`, não tem badge — é apenas decoração.
- **BottomNav morta**: `BottomNav.tsx:34` faz `if (insideShell) return null;` — efetivamente desabilita a navegação inferior mobile.
- **Dois sistemas de toast** montados simultaneamente (`Toaster` + `Sonner`) — inconsistência futura provável.
- **`density-compact` global** com targets de 32px conflita com WCAG/uso com luva em telas mobile operacionais.
- **Workbox `NetworkOnly` para picking e orders** contradiz o princípio offline-first declarado no briefing.
- **`useUserRole.ts` duplica `AppRole` type** já exportado por `AuthContext.tsx` — manter como fonte única.
- **`isCustomer` em useUserRole** considera `customer` mas `isStaff` lá ignora `master` (`useUserRole.ts:70-71`) — divergente da definição em AuthContext (que inclui master em isStaff). Pode ser bug sutil de permissão.

---

## 11. Premissas de auditoria (confirmadas 2026-05-13)

Sem perguntas pendentes. Tudo confirmado pelo briefing oficial:

- **Empresas**: Colacor (indústria, vende industrializados) · Oben (distribuidora, compra e revende) · Colacor SC (serviços). `Afiação Colacor` no código vai virar `Colacor` em rename futuro.
- **5 personas operacionais** mapeadas via roles existentes + `commercial_roles` + futuro "departamento" (ver §5). Auditoria UX assume persona dominante conhecida por tela.
- **Offline-first em picking e recebimento**: gap crítico (Workbox hoje `NetworkOnly`). Propor no roadmap.
- **<100ms percebido em scan de barcode**: zero código. Propor implementação com optimistic UI.
- **Densidade alta operacional**: `density-compact` global é direção correta; auditar onde ainda é "consumer-grade" (`EmptyState.tsx`, `BottomNav.tsx`, `Header.tsx` legado).
- **WCAG AA mínimo, AAA em críticas**: focus-visible OK; **touch-targets 32px globais ficam abaixo** — propor variante 44px+ para telas mobile operacionais (separador, vendedor externo). Confirmado.
- **Mobile-first em chão, desktop-first em analítico**: AppShell hoje é desktop-first em ambos — auditar telas mobile-críticas.
- **Cmd-k global + atalhos consistentes**: `cmdk` instalado, `Command` shadcn presente, nada montado. Propor.
- **Optimistic UI em mutações operacionais**: princípio do briefing — auditar uso de `onMutate`/`onError` rollback no React Query (hoje esparso).
- **RLS em todas as tabelas**: fora do escopo desta auditoria UX. Se cruzar com tabela sem RLS, registro em "Observações fora do escopo" da fase.
- **Inspirações**: Linear · Notion · Carbon (IBM) · Polaris · Retool. DesignSystem.tsx atual declara HubSpot Canvas + Gong — realinhar.

### Glossário — termos que vão aparecer no roadmap

Pra ficar claro quando os termos entrarem na Fase 3:

- **Cmd-K (command palette)** — overlay de busca/comando que abre com `⌘K` ou `Ctrl+K`. Permite navegar para qualquer tela, executar ação ou buscar registro digitando 2-3 letras. É o padrão de Linear, Notion, Slack, Raycast: substitui menu, busca e atalhos numa única superfície. No nosso caso já temos a base (`cmdk` lib + `Command` shadcn), falta montar no AppShell com registry de comandos por persona.
- **BarcodeDetector API** — API nativa do navegador (Chrome/Edge/Android) que lê códigos de barras e QR direto da câmera, sem biblioteca pesada nem servidor. Latência típica <50ms. Substitui ZXing/Quagga e é o caminho moderno pra picking/recebimento. Tem fallback necessário para Safari/iOS onde a API ainda não está estável.
- **Optimistic UI** — atualizar a tela imediatamente como se a operação tivesse dado certo, e só reverter se o servidor recusar. No React Query: `useMutation({ onMutate, onError })`. Crítico para scan/picking — sem isso o usuário espera 200-800ms a cada bipe.
- **FEFO** (First Expire, First Out) — termo já no domínio: priorizar saída do lote com validade mais próxima. Já implementado em `RecebimentoConferencia` e visível como KPI em `AdminEstoquePicking` (lote_fefo).

Tudo isso vira critério ativo da Fase 2 (heurística D1–D6) e priorização ICE da Fase 3.
