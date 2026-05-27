# CLAUDE.md — Afiação (Sistema Operacional B2B Sardenberg)

> Este arquivo orienta agentes de código (e humanos) trabalhando neste repositório. Última atualização: 2026-05-17 (auditoria de código completa — PRs #24-33 entregues: hotfixes de segurança, cleanup -2200 LoC, useUserRole consolidado, codemod sonner em engines IA, infinite scroll, perf gate em polls. Histórico anterior: auditoria UX 2026-05-13 em `docs/ux-audit/` + redesign visual v3 em `docs/visual-direction/`, ambos mergeados via PR #4).

> **🗣️ Idioma das sessões (preferência do Lucas, 2026-05-20):** responda SEMPRE em **português brasileiro** — nesta sessão e em **qualquer sessão nova ou subagente/sessão spawnada a partir de outra que tenhamos**. Toda comunicação com o usuário (texto, resumos, perguntas, descrição de PR) em pt-BR. Código, rotas, commits e PRs já são pt-BR (ver §5).

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
- **Tema**: `next-themes` 0.3 — light/dark com toggle (`ThemeToggle` no topbar; default light). Tokens em `src/index.css` v3 (ver §4)
- **Tipografia**: Geist Sans + Geist Mono (Vercel) como principais; Newsreader (display serif) em h1 de cockpits; Inter como fallback. Carregadas via Google Fonts em `index.html`
- **Animação**: `framer-motion` 12 (usado em alguns dialogs); motion principal via CSS (`index.css` keyframes + easing Vercel `cubic-bezier(0.16,1,0.3,1)`)
- **Forms**: `react-hook-form` 7.61 + `zod` 3.25 + `@hookform/resolvers`
- **Backend**: Supabase (Postgres + Auth + Storage + Realtime), 164 migrations em `supabase/migrations`, 48 Edge Functions em `supabase/functions`
- **Analytics**: `posthog-js` 1.226 — Product Analytics + Session Replay + Web Analytics. Wrapper em `src/lib/analytics.ts`, instrumentação em `src/components/shell/{PageViewTracker,AnalyticsIdentify}.tsx`. Eventos custom: `cmdk.opened`, `shortcut.triggered`, `theme.changed`, `company.changed`, `pedido.criado`, `picking.scanned`, `sidebar.favorite_*`. Env: `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST`
- **PWA**: `vite-plugin-pwa` com Workbox — `NetworkFirst` (fallback offline) para catálogo, picking, recebimento, orders/sales_orders, profiles e tint/farmer; `NetworkOnly` só para auth/realtime (ver §5)
- **OCR**: `tesseract.js` 5.0 (usado em `RecebimentoConferencia` / `LoteScannerOCR`)
- **Mapas**: `leaflet` 1.9 + `@types/leaflet` (route planner)
- **Charts**: `recharts` 2.15
- **Comando**: `cmdk` 1.1.1 — **command palette global ativo** (`Cmd+K`), montado em `AppShell` via `src/components/shell/CommandPalette.tsx` com busca global real (clientes/fórmulas/pedidos) + comandos contextuais + recentes
- **Voz/IA**: `@elevenlabs/react` 0.14 (transcribe)
- **Drag-and-drop**: `@hello-pangea/dnd` 17 (kanban)
- **Toasts**: `sonner` 1.7 — **sistema único**. O wrapper `useToast` + shim foram removidos (2026-05-25); todo código usa `import { toast } from 'sonner'` (`toast.success/error/info`)
- **Hospedagem**: Lovable Cloud (componentTagger em dev)

### Scripts

```bash
bun dev       # vite dev server (porta 8080)
bun build     # vite build (PWA gerado em production)
bun build:dev # build em modo dev (sem PWA)
bun lint      # eslint
bun run test  # vitest run — CANÔNICO, 241/241 passando, é o que roda em CI
bun test      # bun runner nativo — fast path local (~280ms vs ~3.9s do vitest);
              # cobertura parcial (não suporta vi.hoisted/vi.mocked/vi.importActual nem DOM completo).
              # bunfig.toml + src/test/bun-setup.ts polifillam localStorage/MediaStream/matchMedia.
bun preview   # vite preview
```

> ⚠️ **`bun test` ≠ `bun run test`**. `bun test` invoca o runner nativo do bun (não usa vitest.config.ts).
> Use pra loop rápido de TDD em tests que não dependem de DOM/React renderização. Resultado oficial é só do vitest.

> 🟢 **Prefixe comandos PESADOS com `heavy`** quando houver sessões/worktrees rodando em paralelo (máquina do Lucas é M2 8GB, satura fácil). `heavy` é um semáforo global (`~/.local/bin/heavy`, fonte em `scripts/heavy.sh`) que limita quantos test/build/typecheck rodam ao mesmo tempo entre TODOS os worktrees — os demais esperam a vez em vez de competir por CPU/RAM. Auto-dimensiona pelo HW (1 slot na M2 8GB; ~9 num M4 Pro 48GB). Use:
> ```bash
> heavy bun run test
> heavy bun run typecheck:strict
> heavy bun build
> heavy --status   # slots em uso
> ```
> Override: `AFIACAO_MAX_HEAVY=2 heavy …`. Comandos leves (`bun lint`, `bun dev`) não precisam.

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

## 4. Design System — v3 "fintech/SaaS premium" (Vercel/Mercury/Stripe Dashboard)

> Reposicionamento visual completo executado. Direção e spec em `docs/visual-direction/` (01-direcao, 02-tokens, 03-validacao, 04-identidade, 05-revisao-skill).

### Tokens (`src/index.css` — v3)

- **Paleta quase-neutra** (low-fatigue pra uso 8h): primary preto/branco minimal, escala neutra warm-leaning, background off-white `0 0% 99%` (cards `#FFF` flutuam sutilmente)
- **Status colors dessaturadas** — `--status-success/warning/error/info` (texto longo) + `--status-*-bold` (acentos curtos: badge "Live", dot). `--status-*-fg` + `--status-*-bg` pra pares de badge. Utilities `text-status-*`, `bg-status-*`, `text-status-*-bold` em `index.css`. **NÃO usar `text-emerald-600` etc. em código novo.**
- **Identidade por empresa**: `--company-colacor/oben/sc` (monogramas no CompanySwitcher)
- **Tipografia**: `font-sans` = Geist, `font-mono` = Geist Mono, `font-display` = Newsreader (serif, só h1 de cockpits). `tnum` global. h1 30px/500/-0.04em, h2 22px/500. Utilities `.kpi-value` (Geist Mono p/ KPIs grandes), `.kpi-delta`, `.font-tabular` (IDs/datas)
- **Radius**: `--radius: 0.375rem` (6px)
- **Shadows**: quase ausentes — profundidade via border 1px. Sombra só em overlay (`--shadow-md/lg`)
- **Motion**: easing Vercel `cubic-bezier(0.16,1,0.3,1)`, durations 150/200/300/500ms. Utilities `.stagger-children` (reveal cascateado), `.animate-shimmer` (skeleton), `.animate-shake`/`.animate-ping-slow` (network indicator). Respeita `prefers-reduced-motion`
- **Atmosphere**: `.bg-cockpit-hero` (gradient radial sutil) + `.noise` (grain SVG ~3%) em headers de cockpit
- **Modo dark**: classe `.dark` via `next-themes`. `<ThemeToggle>` no topbar, default light
- **Feature flag de rollback**: `useFeatureFlag('newVisual')` — quando `false`, `html.legacy-visual` reverte tokens críticos pros antigos. Toggle em `/settings`
- **Densidade**: `.density-compact` aplicada globalmente pelo AppShell

### Inspirações (atualizadas — `DesignPreview.tsx` showcase em `/design-preview`)

> Vercel + Mercury + Stripe Dashboard. Anti-referências: Material Design 3, Bootstrap genérico, Stripe landing page consumer. (O `DesignSystem.tsx` legado em `/design-system` ainda cita HubSpot/Gong — descontinuar.)

### shadcn/ui — componentes presentes (`src/components/ui`)

Todos os primitivos esperados + adições: `page-skeleton` (variantes cockpit/list/form/detail), `bulk-actions-bar`. Button tem variantes `touch` (44px) e `balcao` (56px) pra operação mobile/touchscreen.

### Padrões de layout

- **Desktop**: sidebar **light** coerente com conteúdo (colapsível, 240/56px) + topbar fixo (48px) + main com `pt-topbar` e `lg:ml-sidebar`
- **Mobile (<lg)**: sidebar vira drawer overlay (`MobileNav`), topbar mantido
- **Sidebar**: seções secundárias (Performance, Inteligência, Automação, Documentação) colapsáveis e fechadas por padrão; estado persiste em localStorage. **Favoritos pinados** no topo via `useSidebarFavorites` (até 5, estrela em hover do item)
- **Empty states**: `src/components/EmptyState.tsx` refatorado — `tone="operational"` (default B2B, denso, pattern de pontos sutil) e `tone="friendly"` (customer-facing). Adotado em SalesOrders, AdminCustomers, Recebimento
- **Bottom-nav legado** (`BottomNav.tsx`): silenciado dentro de AppShell

### Navegação (sidebar, `AppShell.tsx`)

Seções: Principal · Afiação · Vendas · Estoque · Reposição · Produção · Performance · Inteligência · Financeiro · Tintométrico · Automação · Gestão · Documentação. Badges numéricos em tempo real (refetch 30–60s). Wordmark "Colacor" (peso 500, tracking -0.045em + ponto gradient como assinatura).

### Topbar (`AppShell.tsx`)

Mobile menu (lg:hidden) · **Cmd-K pill central** (`CommandPaletteTrigger`) · **CompanySwitcher** (monograma colorido por empresa) · **NetworkStatusIndicator** (some quando online+fila vazia; shake/pulse quando offline/slow) · **ThemeToggle** · HelpDrawer · dropdown User. O `Bell` ornamental foi removido.

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
- **Cache** (a verdade é o `vite.config.ts` — esta seção já esteve stale): `NetworkFirst` (fallback offline + TTL curto) para catálogo (`tool_categories | default_prices | company_config | category_mappings`), `picking_tasks/units/lotes`, `nfe_recebimentos/itens/cte`, `orders | sales_orders | order_items | order_messages`, `profiles | user_tools`, e `tint_*/farmer_*` (TTL longo). **`NetworkOnly` só para `auth` + `realtime`.**
- **Fila de mutação offline ATIVA**: `lib/offline-queue.ts` (`enqueue`/`flush`/`getQueuedByKind`), `useOfflineMutation` (online-try → enqueue no erro de rede) + `useOfflineFlush`/`registerAllOfflineHandlers` (registro central no boot do AppShell — drena a fila ao reconectar em qualquer tela). Indicador de rede na UI: `useNetworkStatus()` + `<NetworkStatusIndicator/>` (badge de profundidade da fila no topbar).
- **Offline-first entregue** em picking (`confirmPickItem` idempotente + optimistic fila-como-overlay), recebimento (`confirmUnit/reportDivergencia/addCte`) e envio de pedido mesma-sessão (`useOfflineSubmit` rascunho-first). Ver §6 item 1 pro detalhe e PRs.

### Latência percebida & optimistic UI

- React Query default: `staleTime: 60s`, sem refetch em focus
- Nenhum padrão sistemático de `useMutation({ onMutate, onError: rollback })` para optimistic UI — auditar caso a caso
- Skeletons via `<Skeleton />` shadcn (uso esparso; em `App.tsx` o Suspense fallback é genérico 3-bloco)

### Atalhos de teclado

- `useRegisterShortcuts({ keys, label, group, handler })` — padrão canônico (registry global)
- `?` abre dialog com todos os atalhos registrados (auto-descoberta)
- `Cmd+K` (`useGlobalSearch`) montado em AppShell para busca global
- O hook legado `useKeyboardShortcuts.ts` foi deletado em PR #25 (zero consumidores)

### Barcode scanning

- Pacote `cmdk` instalado mas BarcodeDetector NÃO usado em nenhum lugar (`grep` zero ocorrências em `src/`)
- Único scanner é OCR Tesseract para lote/validade no recebimento (`LoteScannerOCR`)
- Briefing afirma "BarcodeDetector API" como integração — **aspiracional, não implementado**

### Telefonia (WebRTC vs Nvoip click-to-call)

Dois backends coexistem; o usuário escolhe via toggle em `/settings`:

- **Default (`useFeatureFlag('useWebRTCCall', false)` → false)**: `useNvoipCall` (Edge Function `nvoip-calls` + polling de status). Click-to-call: a Nvoip liga primeiro pro ramal Nvoip do vendedor (que atende no painel web), depois conecta com o cliente.
- **WebRTC opt-in (flag → true)**: `useWebRTCCall` (JsSIP + SIP over WebSocket). Vendedor liga **direto pelo navegador**, áudio bidirecional capturado como `localStream`/`remoteStream` (preparação pra transcrição ao vivo em PR2).

**Dispatcher**: `<Dialer />` em `src/components/call/Dialer.tsx` escolhe baseado em `useFeatureFlag('useWebRTCCall', false)`. WebRTCDialer é lazy-loaded — JsSIP só entra no bundle quando a flag liga.

**UI compartilhada**: ambos consomem `CallDialerView` em `src/components/call/CallDialerView.tsx`. Backend é identificado por badge "NVOIP" / "WEBRTC" no painel ativo.

**Credenciais SIP**: nunca em `VITE_*` (vazaria no bundle público). Servidas pela Edge Function `nvoip-sip-creds` (auth + role employee/master via `authorizeCronOrStaff` shared helper). Env vars do server: `NVOIP_SIP_WSS`, `NVOIP_SIP_DOMAIN`, `NVOIP_SIP_USER`, `NVOIP_SIP_PASS`.

**LGPD**: MP3 de aviso em `public/preroll/aviso-gravacao-lgpd.mp3` é mixado no `localStream` via `mixPrerollWithMic` (Web Audio API). URL configurada por `VITE_NVOIP_SIP_PREROLL_URL`. Caller é dono do AudioContext cleanup (`useWebRTCCall.endCall` libera).

**Cleanup crítico**: `useWebRTCCall` guarda `rawMicRef` (da `getUserMedia`) e `prerollCloseRef` separadamente do `localStream` mixado. Em `endCall`/unmount, ambos são fechados antes de SipClient.hangUp para liberar o microfone físico (red dot apaga imediatamente).

### Touch targets

- `index.css:228-230`: `button, a, [role="button"] { min-height: 32px; }` aplicado globalmente
- `button.tsx`: `default h-9 (36px)`, `sm h-8 (32px)`, `lg h-10 (40px)`, `icon h-9 w-9 (36px)`
- **Nenhuma variante atinge 44px**, o que viola o mínimo WCAG AA para uso com luva em chão de fábrica (briefing pede 44px+)

### Toast / feedback

- **Sonner é o único sistema ativo.** `ui/toaster.tsx` + `ui/toast.tsx` + `@radix-ui/react-toast` foram deletados em PR #25.
- O wrapper `use-toast.ts` (@deprecated) + o shim `ui/use-toast.ts` foram **removidos** (2026-05-25) — a migração dos callsites concluiu. **Todo código usa `import { toast } from 'sonner'` direto** (`toast.success/error/info`). Não existe mais `useToast`.

### Logger

- `src/lib/logger.ts` — wrapper estruturado com níveis (info/error/critical), usado consistente em AuthContext

### ⛔ Acesso ao banco — SOMENTE via Lovable (sem terminal, sem curl, sem CLI)

**O Lucas NÃO tem acesso a terminal/curl/Supabase CLI pro backend.** Todo acesso ao banco e edge functions é feito **exclusivamente pela UI do Lovable** (o SQL Editor do Lovable em `lovable.dev/projects/.../view=cloud&section=sql`, ou o chat AI do Lovable). Confirmado em 2026-05-19.

**NUNCA sugerir ao usuário:**
- ❌ comandos `curl` (ele não tem `$SUPABASE_URL`/`$CRON_SECRET` no shell — falha com "No host part in the URL")
- ❌ `supabase` CLI, `psql`, ou qualquer ferramenta de terminal
- ❌ acessar o Supabase Dashboard direto em `supabase.com/dashboard` — o projeto real (`fzvklzpomgnyikkfkzai`) é gerenciado pela org do Lovable e o Lucas recebe "You do not have access". O projeto `lkotrsfdvnwxqyevhffh` que aparece na conta dele é um projeto-teste vazio, NÃO o de produção.

**Como o usuário roda QUALQUER coisa no backend:**
- **SQL (DDL/DML/migrations/queries)** → cola no SQL Editor dentro do Lovable → Run
- **Invocar edge function** → pedir pro chat do Lovable invocar, OU via `net.http_post` no SQL Editor (se pg_net + auth configurados), OU acontece automático via triggers/cron
- Pra dar instrução de SQL, sempre rotular: "🟣 Lovable → SQL Editor → cola → Run"

### Migrations Supabase — ⚠️ aplicação manual obrigatória

**Lovable Cloud NÃO aplica automaticamente** migrations que você commita em `supabase/migrations/`. Confirmado experimentalmente em 2026-05-17:

- Migrations geradas pelo Lovable (formato `_UUID.sql`, ex: `_868822bb-e38c-4fcf-8879-c64e48bd7630.sql`) rodam quando você usa o builder visual dele
- Migrations com nome custom (`_user_departments.sql`, `_dashboard_visits.sql`, `_enable_realtime_dashboard_v3.sql`) commitadas via PR **ficam só no repo** e não tocam o banco

**Workflow obrigatório quando criar migration custom** (automatizado pela skill `lovable-db-operator` — ver §12; use-a sempre que for mexer no banco, ela empacota todo este ritual):

1. Cria o arquivo em `supabase/migrations/YYYYMMDDHHMMSS_<nome>.sql`
2. Mergeia o PR normal (commit fica no histórico do código)
3. **Entrega o SQL inline na conversa** em blocos separados (1 bloco por migration), prontos pra colar no **SQL Editor** (não fica enviando o founder pro arquivo no GitHub Raw ou pedindo `bunx supabase db push`)
4. Founder cola cada bloco no SQL Editor → Run → confirma "Success"
5. **Valida no final** com uma query de checagem (count de tabelas/triggers/funções criados) também pra colar no SQL Editor

**Formatação de blocos SQL na conversa** (preferência do founder, registrada 2026-05-19):

- Sempre usar fenced code block com ```` ```sql ```` — assim o app de chat renderiza o botão de copiar no canto superior do bloco.
- **Cada bloco SQL deve terminar com a tag de fechamento ```` ``` ```` numa linha sozinha**, sem texto ou explicação encostada nela. Texto após `\`\`\`` fora do bloco. Isso garante que o botão "Copy" do app cubra a área visível inteira e funcione mesmo quando o bloco é longo (founder rola até o fim e quer poder copiar dali também sem voltar pro topo).
- Quando entregar múltiplos blocos sequenciais (A→B→C→D), **um bloco SQL por mensagem**, com label "BLOCO A/B/C/D" antes e a query de validação (`SELECT 'BLOCO X OK' AS status, ...`) no final do bloco. Founder cola, vê "Success" + a contagem esperada, confirma, e aí mando o próximo.

**Migrations já entregues por este workflow** (referência):
- Fundação Tier 1 (15 migrations, 2026-05-17 → 18) — todas coladas via SQL Editor
- A1 Inteligência de Caixa (4 migrations, 2026-05-19) — idem
- `20260517100000_enable_realtime_dashboard_v3.sql`, `20260517120000_user_departments.sql`, `20260517140000_dashboard_visits.sql`
- **Carteira-Omie Sub-PR B (2026-05-24, PR #263)**: `20260524170000_scores_unique_por_cliente.sql` (BLOCO A) + `20260524180000_carteira_scores_owner_e_filas.sql` (BLOCO B) — aplicadas via SQL Editor. Rollout coordenado concluído e validado em produção: BLOCO A→B → re-deploy das 5 functions (`calculate-scores`, `scoring/visit-recalc-client`, `scoring/visit-recalc-batch`) → invocar `calculate-scores` (6908) → BLOCO C (enfileira carteira) → drain concorrente do `visit-score-recalc-client` (fila 6908→0) → `scoring-recalc-batch` → BLOCO D. **Estado final: `farmer_client_scores` e `customer_visit_scores` = 6908 linhas, 1 por cliente, `farmer_id` = dono (Regina 1890); 3 donos; filas com UNIQUE(customer_user_id); 3 triggers de enfileiramento resolvendo o dono via `carteira_assignments`.** Crons noturnos `scoring-recalc-batch-nightly` (`0 6 * * *`) e `visit-score-recalc-batch-nightly` (`0 7 * * *`) ativos rodando o código novo (enumeram só ativos 30d mapeados pro dono). **Módulo de scoring agora cobre TODA a carteira do Omie (não só "quem teve atividade"); cobertura de férias na UI (/settings → Permissões).**
- **Carteira-Omie Sub-PR D — Positivação & KPIs (2026-05-25, PR #279)**: `20260525120000_positivacao_kpis.sql` (BLOCO A) — aplicada via SQL Editor. Adiciona `sales_orders.order_date_kpi` (data do pedido pra KPI, de `infoCadastro.dInc` no sync; antigos = `created_at`/previsão), tabela `carteira_positivacao_snapshot` (+RLS) e RPC **`get_minha_positivacao()`** (`SECURITY DEFINER`, `auth.uid()`, anti-IDOR — dona da verdade: elegíveis × pedido válido MTD + lista "a positivar"). Functions deployadas: `omie-vendas-sync` (EDIT, grava `order_date_kpi`) + `carteira-positivacao-snapshot` (CREATE, cron mensal idempotente). Cron `carteira-positivacao-snapshot-mensal` (`0 8 1 * *`) ativo. Validado em prod (carteira elegível da Regina ~1890). UI: tela `FarmerCalls` lidera com Positivação MTD + lista "Clientes a Positivar" (heros Farmer/Hunter), atividade do dia rebaixada. **Pedido válido = não-cancelado/não-draft; KPIs por POSSE própria (cobertura é só visibilidade); cortados da v1: Mix/Gap, UI histórica, Receita vs Meta.** **Programa Carteira-Omie (Sub-PRs A+B+D) 100% em produção.**
- **Hardening de RLS dos scores de carteira (2026-05-25, PR #329)**: `20260526020000_rls_score_carteira_hardening.sql` — aplicada e validada via SQL Editor (`✅`). **Furo:** `farmer_client_scores` tinha policy `FOR ALL` ampla (`master OR employee`) → qualquer vendedor lia E **gerenciava** (UPDATE/DELETE/roubo de posse via `onConflict`) a carteira de TODOS via PostgREST; filtro por `farmer_id` no front era só display. Novo helper **`pode_ver_carteira_completa(uid)`** = `master OR (employee AND commercial_role IN gerencial/estrategico/super_admin)` (exige `employee` p/ não vazar pra `customer` com role sujo). `farmer_client_scores`: split do `FOR ALL` → SELECT = gestor/master OU própria carteira+cobertura (reusa `carteira_visivel_para`); IUD = `farmer_id=auth.uid()` OU gestor/master. `customer_visit_scores` (já own-scoped): SELECT ganha cobertura+gestor (corrige quebra silenciosa de `useMyVisitSuggestions` p/ carteiras cobertas); write por carteira. Chamadas em `(select …)` → initPlan. `service_role` bypassa (engines intactos); as RPCs view-as `_for(target)` da main são `SECURITY DEFINER` → não afetadas. 2 consults codex no desenho. ⚠️ **Timestamp realocado de `20260525220000`→`20260526020000`** (colidia com `20260525220000_viewas_access_targets.sql` de sessão paralela). **Follow-up de segurança das 5 tabelas-irmãs ENTREGUE (PR #340)** — ver bullet abaixo.
- **Hardening de RLS das 5 tabelas de relacionamento da carteira (2026-05-26, PR #340)**: `20260526040000_rls_carteira_relacionamento_hardening.sql` — aplicada e validada via SQL Editor (`✅`). Fecha a mesma exposição `FOR ALL master-OR-employee` (BFLA) do #329 em **`farmer_recommendations`, `farmer_bundle_recommendations`, `farmer_calls` (transcrição de ligações), `route_visits` (geo; posse via `visited_by`, NÃO `farmer_id`), `farmer_copilot_sessions`**. Split do `FOR ALL` → SELECT = gestor/master OR **own** (`farmer_id`/`visited_by`) OR carteira/cobertura (`carteira_visivel_para`); IUD = gestor/master OR own (assimetria leitura>escrita: cobertura lê, não muta). **Branch own no SELECT (≠ scores)**: aqui a coluna de posse é o criador *client-side* e o cliente vem de `sales_orders`, não de `carteira_assignments` (o `INSERT WITH CHECK` força `own=auth.uid()` → o branch own não vaza linha alheia); `calls`/`copilot` têm `customer_user_id` **nullable** → `carteira_visivel_para(NULL)=só master`, então o branch own garante leitura das próprias ligações/sessões sem cliente vinculado (subsume a velha "Farmers can view their own calls"). `pode_ver_carteira_completa` redeclarado verbatim (idempotente, bate 1:1 com o #329) p/ paste standalone; `TO authenticated`; `(select …)` → initPlan; `service_role` bypassa (engines de scoring intactas). 1 consult codex. Consumidores mapeados POR tabela antes de apertar (escritas client-side own-scoped; leituras amplas das tabs Intelligence são gestor/master-gated = `pode_ver_carteira_completa`; route planner `lastVisits` degrada honestamente fora-da-carteira). ⚠️ **Timestamp realocado `20260526020000`→`20260526040000`** (colidia com #329/scores + watchdog mergeados em paralelo).
- **"Ver como pessoa" — impersonação read-only master (2026-05-25, PRs #323 + #331)**: 3 migrations via SQL Editor — `20260525210000_viewas_rpcs_for.sql` (internals `_carteira_{mixgap,positivacao}_for_owner` + RPCs de vendedor refatoradas pra delegar + irmãs **master-only** `get_meu_mixgap_for`/`get_minha_positivacao_for` — **Pattern B** do Codex: gate `RAISE` no forbidden, internals `REVOKE`d de `authenticated`, contrato das RPCs de vendedor preservado); `20260525220000_viewas_access_targets.sql` (`get_user_access_profile_for` + `list_impersonation_targets` = donos de carteira, master-only); `20260525230000_impersonation_audit.sql` (tabela + `log_impersonation_start`/`end_impersonation`, `actor=auth.uid()` server-side, LGPD). **Sem edge function.** Client: `ImpersonationContext` (master-only, `sessionStorage`, `effectiveUserId` SÓ em leitura — a sessão continua a do master, todo write é do master; guard de CI `no-write-leak` por allowlist), hooks `useMy{Positivacao,MixGap,VisitSuggestions,CarteiraScores}` impersonation-aware (na impersonação escopam só à carteira do alvo, ignoram a cobertura do master), `ViewAsPicker` em `/meu-dia` (MasterDashboard) + **banner persistente** "Vendo como X — somente leitura · Sair" + CTA "Nova ligação" desabilitado. **#331:** `useEffect` restaura a impersonação do `sessionStorage` quando `isMaster` confirma (sem isso, F5 perdia — `isMaster` é false no mount). **Escopo data-only:** o **#221 (acesso por persona) foi FECHADO**, então a **camada de MENU está adiada** (impersona troca os DADOS; o menu segue o do master); `get_user_access_profile_for` + `useImpersonatedAccessProfile` ficam prontos pra quando uma fundação de acesso existir. **Codex review do gate: limpo.** Smoke em prod OK (picker/banner/audit; SPA preserva a sessão; RLS #329 não afeta — master lê tudo). **Não-objetivos v1:** impersonar cliente, gestor impersonar, agir como o alvo. Specs/planos em `docs/superpowers/{specs,plans}/2026-05-25-ver-como-persona-*`.

**RECOVERY no Supabase do Lovable (concluída 2026-05-19)**: como Fundação + A1 tinham sido aplicados por engano no Supabase standalone, foi feita re-aplicação completa no Supabase do Lovable via SQL Editor (5 blocos A→B→C→D→E idempotentes) + re-deploy das 5 edge functions via chat do Lovable. Estado final validado: **9/9 tabelas, 6/6 funções, 18/18 triggers anexados, ambas colunas (regime + snapshot_dre_caixa_id), unique constraint com regime, seed config 3 empresas, 3 CNPJs**. Edge functions Active no Lovable: `omie-financeiro` (EDIT, 1493 linhas, lida do repo), `fin-period-override`, `fin-suggest-mapping`, `fin-ic-reconcile`, `fin-cashflow-engine` (4 novas). **2 crons agendados e ativos** (BLOCO E): `fin-cashflow-snapshot-diario` (`0 10 * * *`, snapshot 13s por empresa×cenário) e `fin-ic-reconcile-daily` (`0 9 * * *`). **Módulo financeiro 100% completo e automatizado no Supabase de produção.**

**Programa "Estado da Arte do Financeiro" — status (atualizado 2026-05-25)**: sobre a Fundação/A1, executado em ondas (cada uma validada por consult Codex, TDD em helper puro espelhado no engine Deno, mergeada e em produção no Lovable). Specs/planos em `docs/superpowers/{specs,plans}/`; helpers em `src/lib/financeiro/`.
- ✅ **Onda 1 — NCG** (PCO sem double-count de tributo, estoque real via `fin_estoque_valor`, CCC com PME, rename "capital giro próprio"→"liquidez operacional líquida"). Helper `ncg-helpers.ts`. Mergeada no PR #138.
- ✅ **Onda 2 — Timing da projeção 13s** (curvas de aging calibradas por exposição, vencidos reagendados, ponte "após horizonte/AR impaired", PMR/PMP + inadimplência ponderados por R$, guard de folha por janela). Helper `aging-helpers.ts` (espelho em `fin-cashflow-engine`). PR #138.
- ✅ **Onda 3 — DRE v2 regime-aware** (em `omie-financeiro/calcularDRE`, helpers `dre-helpers.ts` + `dre-tabelas-tributarias.ts`): **3a** estrutural — deduções (ICMS/ISS/PIS/COFINS/IPI) vs IRPJ/CSLL; **DAS único no Simples** (nunca quebrado, LC 123); caixa por data real + fallback "caixa estimado"; mapping explícito no lugar do prefixo `'3.99'`; gate de confiança (PR #184). **3b** imposto teórico — Simples (RBT12 + anexo + fator-r) e presumido (trimestral + adicional 10% + PIS/COFINS) ao lado do realizado, degradação honesta p/ `null` (PR #188). Coluna opcional `fin_config_cashflow.dre_tributario` setada nas 3 empresas (Colacor SC = `{regime:simples, anexo:III}`). ⚠️ Trigger `trg_audit` foi **removido de `fin_config_cashflow`** (a função `fin_audit_trigger()` deriva período por `data_emissao`, coluna inexistente em config → quebrava UPDATE; migration `20260523210000_*`, PR #192).
- ✅ **A2 — Retorno & Valor** (ROIC / WACC hurdle-rate / EVA / spread + **ROIC incremental** + **normalização de comingling** reportado×normalizado). NOPAT = `EBIT − imposto absoluto do regime` (abaixo da linha, nunca `×(1−t)`); capital investido = giro (NCG) + ativo fixo manual − ajustes; Kd pré-imposto. Helper `valor-helpers.ts`, engine `fin-valor-engine` (**master-only**), tabela master-only `fin_valor_inputs`, rota `/financeiro/valor`. PR #223.
- ✅ **A3 — Cockpit de Valor** (lucro econômico = margem de contribuição − encargo de capital de giro, **por cliente e por SKU**; recomendação de preço/prazo; identidade contábil Σcliente.evp = Σsku.evp = empresa.evp). Helper `valor-cockpit-helpers.ts`, engine `fin-valor-cockpit` (**gestor comercial + master**, escopo Oben via `omie_products.account`, paginação fetchAll anti-truncamento PostgREST), coluna `fin_config_cashflow.cockpit_config`, rota `/financeiro/valor-cockpit`. PR #255.
- ✅ **A4 — Próxima Melhor Ação** (fila priorizada de alocação de capital compondo A1–A3: consertar valor → liberar caixa → crescer com spread>0 → benchmark do hurdle; caixa disponível por empresa **não cruza CNPJ**; crescer sem custo estimado → `falta_dado`, nunca assume custo 0). Helper `next-best-action-helpers.ts`, engine `fin-next-best-action` (**gestor+master**, compõe A1/A2/A3 via service_role em paralelo + timeout). Rota `/financeiro/proxima-acao`. PR #266.
- ✅ **Otimizador Tributário — Comparador de Regime** (Simples × Presumido × Real por CNPJ; aponta o regime ótimo + economia anual). Base de comparação **federal+CPP via decomposição da partilha do DAS** (não compara DAS cheio vs federais parciais — inverteria a recomendação); ICMS/ISS/IPI no eixo indireto sinalizado à parte; elegibilidade por **RBA** (não RBT12); Presumido anualizado c/ **adicional de IRPJ por trimestre** + receitas financeiras integrais na base IRPJ/CSLL; Real como **triagem de baixa confiança** (lucro ≈ resultado contábil sem LALUR; PIS/COFINS não-cumulativo 9,25% − crédito + 4,65% s/ receitas financeiras); **degradação honesta** = status `incompleto`/confiança baixa quando falta folha ou <12m de DRE (nunca fabrica recomendação). **3 passes Codex** (2 metodologia no spec + 1 adversária no código). Helper `regime-tributario-helpers.ts` (28 testes; tabela `PARTILHA_SIMPLES` LC 123 com teto de ISS 5%), engine `fin-regime-tributario` (**master-only**, espelho verbatim), tabela master-only `fin_regime_inputs`, rota `/financeiro/regime-tributario`. PR #291 (admin-merge — CI nunca rodou limpo por causa da rotatividade da main do Lovable; 4 checks bloqueantes validados localmente). ✅ **Em produção (2026-05-25)**: migration `20260524120000_fin_regime_inputs.sql` aplicada via SQL Editor (3 linhas seed, 2 policies master-only) + `fin-regime-tributario` deployada **verbatim da main** (Active no Lovable; sobrescreveu a versão que o Lovable improvisou antes do merge). **Resta só** preencher os inputs da contabilidade (folha, presunções, créditos) no dialog de cada empresa em `/financeiro/regime-tributario` → destrava a recomendação confiante (até lá mostra "estimativa incompleta" de propósito, por design da degradação honesta).
- ✅ **Otimizador de Compras — "comprar mais?" (net-R$ marginal)** (2026-05-25, PR #325). **Integrado na Reposição** (`/admin/reposicao/oportunidades`), NÃO é página nova de financeiro — pega as ideias do programa de valor e formula a área de oportunidades já existente (decisão do Lucas). Responde "vale comprar acima do ponto de reposição?" pelo **net-R$ marginal vs baseline** = `desconto + aumento_evitado + ruptura_evitada − capital_extra − impacto_prazo − frete_incremental`. Regras-chave (todas calibradas em 2 passes Codex + 1 adversária): **capital_extra é carregado desde o dia 0** (`valor_extra × cm_anual × ((q_base/d)+0.5×(q_extra/d))/365`); **aumento_evitado com janela temporal** (`max(0, q_cand − max(q_base, demanda×dias_ate_aumento))` — só conta o que adianta a compra ANTES do aumento anunciado); **ruptura_evitada = 0 na fase 1** (conservador, só sinaliza com flag — não fabrica ganho de disponibilidade); **campos atômicos anti-double-count**; **candidatos entre os thresholds da curva** + o `qtde_oportunidade` como candidato explícito (senão o cenário aumento-puro nunca era testado). **Degradação honesta**: sem demanda → `falta_dado`; grupo (não-SKU) → `simulacao_parcial`; recomenda `comprar_mais` só com escopo='sku' & net>0. **`qtdBase = max(qtde_base, max(lote_minimo, minimo_forcado))`** — o `minimo_forcado` já está no helper p/ atender o requisito futuro do Lucas (alguns itens da sugestão de pedido **obrigam quantidade mínima** — a "R" que força mínimo); **falta decidir ONDE persistir esse mínimo por SKU** (hoje o helper aceita o param, mas não há fonte/coluna/UI alimentando — trabalho de produto futuro). Helper **`src/lib/reposicao/compras-otimizador-helpers.ts`** (20 testes; `gerarCandidatos`/`avaliarComprarMais`). **SEM edge function** — roda client-side sobre a view (dado operacional, staff-readable, sem regra financeira sensível). View **`v_otimizador_compras_insumos`** (`security_invoker=on`, idempotente, **só junta fatos**: `v_oportunidade_economica_hoje` + `sku_parametros` (lote_minimo) + CTE `prazo` dedup'd de `fornecedor_prazo_pagamento_config` (padrao+ativo, 1 linha/fornecedor anti-duplicação de SKU) + CTE `frete` pivotado de EAV `fornecedor_custo_adicional_config` (tipo IN frete_perc_valor/frete_fixo/taxa_pedido); join por `empresa`+`fornecedor_nome`). ⚠️ **`custo_capital_efetivo_perc` é %/ANO** (cm_anual×100) — o front divide por 100 (`cm_anual = custo_capital_efetivo_perc/100`). Migration `20260525140000_v_otimizador_compras_insumos.sql` aplicada via SQL Editor. ✅ **Em produção** (CI da main verde pós-merge): view criada, **0 linhas hoje = estado vazio VÁLIDO** (sem promo/aumento ativo — base view == otimizador view == 0 prova que os LEFT JOINs não quebraram). Pra ver o net-R$ em ação: cadastrar promoção teste em `/admin/reposicao/promocoes` (volume_minimo + desconto, vigente hoje, num SKU com `sku_parametros`).
- ✅ **Hardening de segurança do `omie-financeiro` (2026-05-25, validado em revisão adversária com o Codex)** — 3 PRs money-path, TDD em helper puro espelhado verbatim no Deno, `deno check` sempre com erro-set inalterado:
  - **#322** — **injeção PostgREST no DRE**: `ano`/`mes`/`meses` vinham do body sem coerção runtime e entravam crus no `.or()` do `calcularDRE` (`{"mes":"01),or(id.gte.0"}` quebrava o `and()`). Helper `dre-period.ts` (valida inteiro no range; ausente→default, presente-inválido→`DrePeriodError`→HTTP 400) no boundary **e** re-assertado no `calcularDRE`. Fecha também o bug `ano+1` de dezembro.
  - **#324** — **allow-list de empresa** (`resolveCompanies` em `omie-request.ts` → 400 fora de `[oben,colacor,colacor_sc]`) + **`if (error) throw`** nas queries do DRE (`buscarCR`/`CP`/mappings/hist): falha de DB deixou de virar DRE zerada/mis-categorizada **persistida** no upsert.
  - **#327** — **gate master+gestor (BFLA)**: `validateCaller` aceitava QUALQUER `employee`; agora exige `master` (user_roles) OU gestor comercial (`commercial_roles` ∈ `{gerencial,estrategico,super_admin}`) — espelha o gate do `fin-valor-cockpit`. Helper `hasFinanceiroAccess`. Crons/service_role inalterados.
  - **Sweep das ~48 edge functions**: resto **sólido** (sem nova injeção `.or()`; `verify_jwt=false` todas gated por cron-secret/webhook-secret/JWT/WebAuthn). Único achado extra = nit de timing-compare baixíssimo no `omie-nfe-webhook` (`!==` vs o `timingSafeEq` do irmão `omie-webhook`) — follow-up opcional. Fora de escopo (consciente): tenant-scoping por empresa (org única, by-design) e validação de `maxPages`/`filtro_data` (baixo valor; `requestedRegime` já seguro). Specs em `docs/superpowers/specs/2026-05-25-{dre-period,omie-financeiro}-*`.
  - 🔴 **PENDENTE: 1 redeploy manual do `omie-financeiro`** via chat do Lovable cobre #322+#324+#327 (todos editam o mesmo arquivo; o deploy lê a main verbatim). Sem ele, #324 e #327 ficam só no código. (#322 chegou a ser deployado isolado, mas o redeploy pós-#327 é necessário p/ #324/#327.)
- ✅ **Custo Marginal de Funding — "de onde vem o caixa, e a que custo" (2026-05-27, PRs #345 + #364)**. Fecha o lado **fonte** do caixa (complemento do A4, que decide o **uso**). Master-only (tesouraria/CFO), padrão A2/regime. **Princípio (revisado por Codex):** tudo em **R$ no horizonte relevante**, taxa anualizada só pra exibir — comparar % a.a. de instrumentos com prazos diferentes pra cobrir um gap **pontual** escolhe errado. Pré-imposto (sem tax-shield, coerente Simples/Presumido). **Duas entregas:** (A — #345) **decisão de antecipação por título** de `fin_contas_receber`: custo da antecipação (`V − v_liq`; deságio comercial por fora + IOF de crédito PJ `0,38%+0,0082%/dia` só p/ desconto, factoring=0 + tarifa) vs. benchmark contextual — `gap` (há déficit até o vencimento) → fonte alternativa mais barata (capital de giro/cheque); `sobra` → retorno do melhor uso do caixa (A4) ou `cm_anual`. (B — #364) **planejador de cobertura de gap**: `identificarGap` (vale mais profundo da projeção 13s; horizonte **até a recuperação**, não a semana do vale) + `montarPlanoCobertura` (merit-order **em R$**, não % a.a.) empilhando **só fontes EXTERNAS** (capital de giro, cheque; cheque pode vencer gap curto → flag emergência) + **custo da inércia em R$**. **Decisões-chave de metodologia (2 rodadas Codex adversarial — 2 P1 no A, 3 P1+2 P2 no B):** ⚠️ **caixa próprio NÃO é fonte do planejador** (o gap vem da projeção que JÁ inclui o saldo atual → seria double-count; o gap é o que falta DEPOIS do caixa próprio); **gap×sobra pelo menor `saldo_final` projetado até o vencimento** (inclui a semana do vencimento); **simulação de 2 cenários** (`checaValeEmT`) sinaliza se antecipar cria vale futuro; **estrutural × calendário** (gap em ≥6/13 semanas → flag + "antecipar é rolagem, renegocie prazo/preço/estoque"); **por-CNPJ** (não cruza caixa entre empresas); **coobrigação obrigatória**; **CET (não taxa nominal) pra dívida**; **composição A4** consome só `caixa_livre` + `retorno_marginal` (dimensionado), não re-decide uso. **Degradação honesta em tudo** (sem taxa→`falta_dado`; sem cm_anual/A4 em sobra→`falta_dado`; sem projeção→contexto `indefinido`/cm_anual; custo da inércia=`null` sem cheque; taxa negativa→tratada como não-configurada — NUNCA fabrica recomendação). Helper **`src/lib/financeiro/funding-helpers.ts`** (35 testes, vitest) **espelhado verbatim** na edge **`fin-funding`** (master-only, compõe `fin-cashflow-engine` + `fin-next-best-action` + `empresa_configuracao_custos` (cm_anual) + `fin_contas_receber`). Tabela master-only **`fin_funding_inputs`** (migration `20260526100000`, RLS `role='master'`, 3 empresas seed) — taxas default por fonte + override. Hook `useFunding` + `FundingInputsDialog` + rota **`/financeiro/funding`** (decisão por título + planejador). ✅ **Em produção (2026-05-27)**: migration aplicada via SQL Editor (`linhas=3, policies=2`) + `fin-funding` deployada verbatim da main (706 linhas, Active; 401 no curl = gate master-only OK). **Resta só** preencher as taxas no dialog (botão "Editar taxas") — até lá a tela mostra "falta dado" de propósito. **Limitações v1 (ver `docs/FINANCEIRO_CONFIABILIDADE.md`):** granularidade da projeção é semanal; `cria_vale_em_T` só sinaliza (re-custo=v2); concentração por sacado é aviso; antecipação NÃO entra como fonte do planejador (v2); capacidade de dívida/cheque ilimitada (limite=v2); `caixa_livre`=`caixa_disponivel` do A4 (não desconta ação aprovada); risco de crédito/sem-coobrigação não valorado (v2).
- ⚠️ **Deploy é manual via chat do Lovable após cada merge** — `omie-financeiro`, `fin-cashflow-engine` e as engines de valor/ação/regime/funding (`fin-valor-engine`, `fin-valor-cockpit`, `fin-next-best-action`, `fin-regime-tributario`, `fin-funding`) leem o arquivo do repo (branch main). Sem isso, a main e a produção divergem.

**Padrão de cron descoberto no Supabase do Lovable (2026-05-19, referência pra futuros crons)**:
- `pg_cron` + `pg_net` já habilitados.
- **Project URL (Supabase do Lovable):** `https://fzvklzpomgnyikkfkzai.supabase.co` — confirma a identidade do Supabase correto (NÃO confundir com o standalone `lkotrsfdvnwxqyevhffh`).
- **Auth canônico de cron** (usado por ~25 crons que já rodam): header `'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)`. O secret `CRON_SECRET` já está no Cofre (Vault) — não precisa criar nem rotacionar. Coluna é `decrypted_secret` (não `value`); nome do secret é `CRON_SECRET` (maiúsculo).
- `cron.schedule(nome, schedule, comando)` faz **upsert por nome** → idempotente, pode rerodar.
- ✅ **Crons legados corrigidos (2026-05-19, BLOCO F+G)**: 3 crons da Reposição estavam com `x-cron-secret` placeholder (`<<COLE_O_CRON_SECRET_AQUI>>` / `<<48>>`) → falhavam 401. `gerar-pedidos-diario-oben` (9h15) e `disparar-pedidos-aprovados-oben` (13h) foram corrigidos pro padrão vault. `omie-cron-diario-oben` (diário 7h) era redundante com `afiacao_omie_oben_sync_incremental_2h` (mesma função/body, roda a cada 2h) → **deletado** via `cron.unschedule`. Lição: ao herdar crons de outro contexto, conferir se o `x-cron-secret` é placeholder antes de assumir que rodam.

- ✅ **Auditoria + recuperação de crons (2026-05-24)**: usuário reportou "dados desatualizados". Diagnóstico achou **401 sistêmico** — o `CRON_SECRET` no **Vault** divergiu da env var `CRON_SECRET` das **edge functions** (provável rotação/redeploy), então ~20 crons que mandam `x-cron-secret` do Vault levavam 401. **Lição-chave de diagnóstico:** `cron.job_run_details` mostra `succeeded` mesmo quando a edge function responde 401 — ele só registra que o `net.http_post` foi **enfileirado**. A verdade do HTTP está em **`net._http_response`** (status_code/content). Sempre cruzar os dois + frescor real das tabelas. **Fix:** rotacionei o `CRON_SECRET` (novo valor forte) no Vault **e** nas edge functions (chat do Lovable) — alinhou os dois lados, ~20 crons voltaram. Migrations: `20260524095612` (tira secret hardcoded de scoring/visit-recalc → lê do Vault), `20260524100500` (cria `fin-omie-sync-2x-diario` `0 8,14 * * *` + conserta `sayerlack-portal-watchdog` que lia secret de um GUC `app.settings.cron_secret` nunca setado).
- ✅ **Financeiro destravado (2026-05-24)**: contas a pagar/receber estavam **56 dias parados** por 3 motivos empilhados, todos escondidos atrás do 401: (1) **não existia cron** chamando `omie-financeiro` (só os `fin-*` que calculam EM CIMA dos dados) → criado o `fin-omie-sync-2x-diario`; (2) `omie-financeiro.validateCaller` **não aceitava `x-cron-secret`** (só `Bearer service_role`/JWT staff) → editado pra aceitar (preferido a pôr SERVICE_ROLE_KEY no Vault, que é lido por quem tem SQL Editor e bypassa toda RLS); (3) **bug nos triggers genéricos** `fin_audit_trigger` e `fin_period_lock_trigger` (migration `20260524102500`): o `CASE` de data fazia acesso **direto** `(NEW).data_movimento` — coluna que só existe em `fin_movimentacoes` — quebrando TODA gravação em `fin_contas_pagar/receber` com `column "data_movimento" not found`. **Padrão correto pra trigger multi-tabela:** ler campo via `(to_jsonb(rec)->>'col')::tipo` (tolera coluna ausente = NULL) em vez de `(NEW).col`. Também: `fin_period_lock_trigger` agora bypassa quando `auth.role()='service_role'` (sync do ERP espelha o Omie; a trava é pra edição humana via app — o snapshot do DRE preserva os números do fechamento). **Cobertura de paginação CP/CR (fix #1, 2026-05-24):** CP/CR/mov ficavam parciais porque o `sync_all` (uma invocação por empresa) tem **time-budget de 130s compartilhado**, e o **CP da colacor (116 págs) consumia tudo antes de CR/mov rodarem** (CR colacor parava em ~6 págs; mov em 0). ⚠️ **O `registros_por_pagina: 500` que tentei NÃO funciona — o Omie capa em 100/página e ignora valores maiores** (confirmado: deployado com 500, comportamento seguiu 100/pág; doc Omie diz limite 100). O 500 ficou no código mas é **no-op**. **Fix real = budget dedicado por entidade**, só via cron (sem editar a função): em vez de 1 cron `sync_all`/empresa, crons separados por entidade (`sync_contas_pagar`/`sync_contas_receber`/`sync_movimentacoes`) **escalonados no tempo**, cada invocação com os 130s inteiros → colacor CR (292 págs × ~0,4s ≈ 117s) cabe. Concorrência OK: as 3 empresas são **contas Omie distintas** (rate-limit por conta), então disparar as 3 juntas é seguro; escalono só entre entidades pra uma mesma conta não fazer CP+CR+mov ao mesmo tempo. Migration `20260525000000_*` cria os crons por-entidade e remove o `fin-omie-sync-2x-diario`. **Cursor de continuação (implementado, 2026-05-25):** mesmo dedicado, a colacor CR (~292 págs × ~1,1s ≈ 320s — gargalo é a latência do Omie, NÃO o banco; audit-skip do `service_role` em `20260525010000` deu só ganho marginal 115→126 págs) não cabe em 130s. Solução: tabela `fin_sync_cursor(company, resource, next_page)`; as actions `sync_contas_pagar/receber/movimentacoes` lêem `next_page` (param `startPage`), retomam de lá e gravam o progresso (NULL quando completam); cron `fin-sync-continuacao-10min` (`*/10`) avança só cursores pendentes (`next_page IS NOT NULL`) → colacor CR fecha em ~3 ciclos (~30 min); os crons por-entidade do #267 são o kickoff de cada passada nova. Migrations `20260525010000` (audit-skip) + `20260525020000` (cursor + cron). ⚠️ Requer redeploy do `omie-financeiro`.
- ✅ **Watchdog de integridade do sync + hardening do `omie-financeiro` + observabilidade do vendas (2026-05-26/27, PRs #321/#330/#338/#347, todos em prod)**. Dor original (este §5): o `CRON_SECRET` divergiu → ~20 crons 401 **silencioso**; `job_run_details` dizia "succeeded"; founder descobriu por reclamação dias depois. Agora há um vigia.
  - **Watchdog (SQL puro, sem edge function nova)**: funções `fin_sync_watchdog_check()` (cron `fin-sync-watchdog` `*/30`) + `fin_sync_heartbeat()` (cron `fin-sync-heartbeat` `0 11 * * 1-5`, dead-man-switch). Cruza 3 sinais por empresa×recurso (frescor `fin_sync_log.complete` >18h só p/ par ATIVO em 7d; erro recente; cursor `fin_sync_cursor.next_page` travado >2h) → grava em **`fin_alertas`** (UNIQUE parcial `(company,tipo) WHERE dismissed_at IS NULL` = anti-spam) e enfileira email em **`fornecedor_alerta`** (`tipo='outro'`, drenado por `dispatch-notifications`) só na **transição** ok→problema; dismiss ao resolver. Migration `20260525200000` (#321).
  - **Iteração 2 — varredura de órfãs (#330, migration `20260526030000_..sweep_orphans`)**: diagnóstico achou **25 linhas `fin_sync_log` travadas em `status='running'`** (até 57 dias) com **0 `error`** — porque o **`catch` do handler do `omie-financeiro` NÃO chamava `completeSync`** (+ kills `WORKER_RESOURCE_LIMIT`/timeout nem passam pelo catch) → a falha ficava órfã em `running`, nunca virava `error`, e o sinal `sync_error` NUNCA disparava (o bug **derrotava o próprio watchdog**). Fix duplo: (a) **código** — o catch agora finaliza o log como `error` (guarda `syncFinalized` p/ não sobrescrever sucesso; try/catch interno p/ não mascarar o 500); (b) **SQL** — o watchdog varre `running AND action LIKE 'sync_%' AND started_at < now()-30min` → `error` (`completed_at=now()` só p/ órfã <6h = alerta fresco, senão preserva `started_at` = limpa silencioso). **Premissa validada com dado: teto de duração legítima = 133s → `running` >30min é inequivocamente morto** (≠ staleness, não-confiável aqui pq o sync loga em rajada).
  - **Causa-raiz das órfãs de `sync_movimentacoes` (#338)**: mov completava em **p95 129s/max 131s** vs `TIME_BUDGET_MS=130s` e kill duro de 150s → raspava o teto e às vezes passava dos 150s antes de gravar cursor. Fix: **`TIME_BUDGET_MS` 130→100s** (folga; global, mas CP/CR/mov têm cursor+`*/10`, só faz mais ciclos) + `sync_movimentacoes` parou de gravar `metadata: {detalhes,resumo}` (payload Omie **bruto, 85% da linha ~1KB, que NINGUÉM lê** — `FinanceiroConciliacao`/`financeiroService` só usam campos já normalizados) → `metadata: null`. ⚠️ **Lição: o `metadata` NÃO era bomba de memória (linhas ~1,2KB); o driver das órfãs era o time-budget raspando, não memória.**
  - **Observabilidade do `omie-vendas-sync` (#347)**: o vendas NÃO logava em `fin_sync_log` → o watchdog não via falhas de vendas (silenciosas). Agora as 3 actions de SYNC (`sync_products`/`sync_estoque`/`sync_pedidos`) logam (running→complete/error, **best-effort**: falha de log nunca derruba o sync) com `action LIKE 'sync_%'` + `companies=[account]` → a varredura de órfãs + o sinal `sync_error` **cobrem vendas sem mudar o watchdog**. ⚠️ **O `WORKER_RESOURCE_LIMIT` do vendas NÃO era memória dos loads upfront** (diagnóstico: `sales_orders` ~1000, `omie_clientes` 6909 ≈ 2MB total) — NÃO otimizei memória (seria especulativo no money-path); só tornei observável. Causa real do resource-limit segue diagnosticável só pelos logs da edge no Lovable, se recorrer.
  - **Decisão de cadência (lição transversal)**: tentei na iter 1.5 uma staleness **adaptativa por par** (`2*avg_gap`) e deu **falso-positivo** — o `fin_sync_log` loga `complete` em RAJADA (a cada ~10min enquanto o cursor drena, depois silêncio quando idle), então "idle saudável" parece "quebrado". **Staleness por tempo-desde-complete é intrinsecamente não-confiável aqui; o sinal de `running` travado é o confiável.** Revertido.
  - **`farmer_copilot_sessions` SELECT own-only (#359, migration `20260527010000`)**: follow-up do #340 (que endureceu as 5 tabelas de relacionamento — ver §10). Das 2 tabelas sensíveis, decisão codex: **`farmer_calls` MANTÉM cobertura** (o Customer 360 lê por `customer_user_id` → o dono precisa do histórico COMPLETO de ligações do cliente; apertar quebraria a continuidade do 360), mas **`farmer_copilot_sessions` apertada pra own-only** (`pode_ver OR farmer_id=uid`) — é sessão de trabalho do vendedor com a IA, não histórico do cliente; nenhum consumidor lê por `customer_user_id`. Aplicada+validada em prod (`✅`).

**Sempre que adicionar migration nova**: avisar no PR description "**ATENÇÃO: migration manual necessária**" e colar o SQL no body do PR + entregar inline na conversa.

### Edge functions — caminho oficial Lovable (confirmado via docs.lovable.dev 2026-05-19)

> 🔴 **REGRA**: Edge functions no Lovable Cloud são **criadas e editadas pelo chat do Lovable**, NÃO pela UI de "Edge functions" do Cloud. A UI Cloud → Edge functions é **só pra visualizar logs, status e invocations**. Não há botão de "Create function" / "New function" ali.

> 🟢 **CAPACIDADE CONFIRMADA (2026-05-19, descoberta durante deploy de omie-financeiro)**: o Lovable AI **CONSEGUE ler arquivos do diretório `supabase/functions/<nome>/index.ts`** no repo do projeto. Inicialmente o founder achou que não — mas o próprio Lovable AI confirmou capacidade quando precisou montar a função após truncamento do histórico de chat. Caminho preferencial para edge function GRANDE (>500 linhas) ou EDIT de função existente: instruir Lovable AI a ler `supabase/functions/<nome>/index.ts` do repo e fazer deploy verbatim, em vez de pastear código no chat (que pode truncar). Para edge function nova pequena (<300 linhas) ou quando o arquivo ainda não existe no repo, continuar pastando código no chat.
>
> Doc oficial: `https://docs.lovable.dev/integrations/cloud` diz: *"Edge Functions: Easy to create — just describe the function you need in Lovable chat."*
>
> **Workflow correto pra entregar edge function nova ou edit**:
> 1. Eu monto um **prompt para o chat do Lovable** com:
>    - Instrução clara (ex: "Create a new Supabase edge function named `fin-period-override`" OU "Edit the existing edge function `omie-financeiro` and replace its code with the following:")
>    - Código completo do `index.ts` em fenced block, self-contained (com helpers inlineados se necessário — UI do Lovable parece não suportar convention `_shared/`)
>    - Lembrete pra NÃO modificar/reinterpretar o código (Lovable AI tende a "melhorar" — não queremos)
> 2. Founder cola o prompt no chat do Lovable
> 3. Lovable AI cria/edita a function
> 4. Verificar no Cloud → Edge functions se aparece "Active"
>
> **Não sugerir mais**: `supabase functions deploy` via CLI (mesmo com CLI já instalada — o founder ainda perderia tempo confirmando project ref e o standalone supabase ainda paira como armadilha). Mesmo que CLI funcione tecnicamente, o caminho oficial Lovable é via chat — e o founder prefere "colar e clicar".

**Auditoria de quais custom migrations estão aplicadas no banco**:

- Inventário completo em [`docs/migrations-audit.md`](docs/migrations-audit.md) (38 custom migrations, 262 objetos esperados — tables, indexes, functions, triggers, cron jobs, enum values, RLS policies)
- Script SQL pronto pra colar no Supabase SQL Editor em [`scripts/audit-custom-migrations.sql`](scripts/audit-custom-migrations.sql) — read-only, retorna duas tabelas: (a) `supabase_migrations.schema_migrations` cross-reference, (b) existência objeto-a-objeto via `pg_catalog`/`information_schema`. Linha com `❌` = precisa apply manual
- Regenerar quando adicionar migration nova: `bun run audit:migrations` (parser regex em `scripts/audit-custom-migrations.ts`, idempotente)
- **Audit de 2026-05-19**: 262 objetos checados, 2 gaps (`standard_processes` nunca aplicada + `idx_customer_contacts_birthday` partial). Fechados via `scripts/apply-missing-migrations-2026-05-19.sql` (verificado ok=true).
- **Audit de 2026-05-20**: 40 custom migrations / 274 objetos (re-gerado após PRs paralelos). Nova migration `20260520010000_scoring_visit_p1_fixes.sql` — **rodar `scripts/audit-custom-migrations.sql` no Studio pra confirmar apply**.
- ⚠️ O histórico de auditorias vive aqui (não no `docs/migrations-audit.md`, que é auto-gerado e sobrescrito a cada `bun run audit:migrations`).

### Snapshot de schema (`supabase/schema-snapshot.sql`) — ⚠️ o repo NÃO é rebuildável via migrations

> **As migrations em `supabase/migrations/` NÃO são uma cadeia restaurável.** Diagnóstico de 2026-05-24 (set-difference catálogo de produção × `CREATE`s das migrations): **~210 objetos existem em produção sem `CREATE` commitado** — 60 tabelas, 41 funções, 25 views, ~22 triggers, 5 enums, ~56 policies. Módulos inteiros (Reposição/DES/Picking) foram criados direto em produção pelo Lovable e nunca ganharam migration de criação; as migrations seguintes só `ALTER`am tabelas-fantasma (ex: `sku_parametros` é ALTERada em 20 migrations mas nunca criada). Um `supabase db reset` a partir do repo **quebra**.

Solução adotada (híbrido em fases, PR #244):
- **`supabase/schema-snapshot.sql`** — `pg_dump --schema-only --schema=public --no-owner --no-privileges` de produção (gerado pelo chat do Lovable; 23.745 linhas; contagens batem 1:1 com prod). É a **fonte de DR/auditoria/base de staging do schema**, NÃO um sistema de migrations.
- **`supabase/schema-extensions-prelude.sql`** + **`README-schema.md`** + **`schema-snapshot.manifest.md`** — pré-requisitos de extensions, runbook de restore e contagens pra revisar drift por diff. **Ler o README antes de restaurar** (só em projeto Supabase, por causa de `auth.*`; armadilhas `CREATE SCHEMA public`/`\restrict`/`pg_cron`).
- **Re-gerar:** prompt pro chat do Lovable (ver `README-schema.md`) → commitar o `.sql` → atualizar o manifest. Cadência: após módulo/tabela nova do Lovable, antes de staging, ou mensal.
- ✅ **Restore validado por replay local (2026-05-24)** via `db/verify-snapshot-replay.sh` (Postgres 17 + `db/stubs-supabase.sql`): prelude + stubs + snapshot em transação única (`ON_ERROR_STOP`) rodaram limpo e as contagens batem 1:1 com prod (212/37/4/86/76/14/474). Prova ordem/dependência/sintaxe do `public`, **não** runtime Supabase (RLS/auth reais) — esse nível ("Gold") ainda pede Supabase vazio/docker.
- **Complemento funcional ENTREGUE** (PR #246): `supabase/schema-infra-outside-public.sql` (buckets + realtime publication, idempotente), `schema-rebuild-runbook.md` (ordem de rebuild + recriação dos 33 crons + verificação) e `schema-security-report.md`. ⚠️ **NUNCA mexer em `supabase/migrations/`** (não mover snapshot pra lá, não arquivar migrations de lá) enquanto o Lovable é dono operacional do backend — decisão pós-codex: a pasta é reconhecida pelo ecossistema Lovable/Supabase → mexer arrisca confundir builder + tracking `schema_migrations` (por isso o archive das 222 foi DESCARTADO). **Pendente real = só a verificação "Gold"** (runtime Supabase real num projeto vazio/docker); o replay sintático/ordem/dependência já passou (ver bullet acima + `db/verify-snapshot-replay.sh`).

### Convenções de código

- Pages em PascalCase (`AdminReposicaoCockpit.tsx`)
- Hooks em camelCase com prefixo `use` (`useUnifiedOrder.ts`)
- Idioma: **português brasileiro** em rotas (`/recebimento`, `/reposicao`, `/tintometrico`) **e** em código (estados, labels, comments, nomes de funções tipo `agruparPorMes`)
- Imports absolutos via alias `@/` configurado em `vite.config.ts:92`
- Tabelas Supabase com nomes em `snake_case` português: `eventos_outlier`, `pedido_compra_sugerido`, `fornecedor_aumento_anunciado`, `picking_tasks`, `nfe_recebimentos`, etc.

---

## 6. Princípios não-negociáveis (do briefing) — status atualizado

1. **Offline-first em picking e recebimento** — ✅ **entregue** (Workbox `NetworkFirst` em PRs #40; recebimento via `useOfflineMutation` em #51/#54; **picking** em PR offline-picking-optimistic 2026-05-24). Hoje: `useOfflineMutation` (online-try → `enqueue` no erro de rede), `useOfflineFlush` + `registerAllOfflineHandlers` (registro **central no boot** do AppShell — reconectar em qualquer tela drena a fila), `confirmPickItem` idempotente (evento `id=eventId` anti-replay + update absoluto), e optimistic via **fila-como-overlay** (`applyQueuedPickConfirms` mescla a fila sobre o servidor; sobrevive a refetch `NetworkFirst` e reload). ⚠️ **Guard de re-entrância no `useOfflineFlush`** (`flushing` flag): sem ele, item que falha sempre re-disparava flush em loop (o `writeQueue` re-emite). Referência de optimistic com rollback: `SalesOrders.deleteOrder`. **`submitOrder` offline entregue** (#261, mesma-sessão): `useOfflineSubmit` (offline → salva rascunho + toast "salvo como rascunho", **não** envia; online → envia) + banner de reconexão com CTA manual "Enviar agora" no `UnifiedOrder` + label "Sem conexão — salvar rascunho" no `CartSummaryBar`. **NÃO enfileira** (`omie-vendas-sync` cria PV cobrado com `codigo_pedido_integracao = ..._${Date.now()}`, replay duplicaria). **Cross-sessão (enviar após fechar/reabrir o app offline) avaliado e deliberadamente NÃO feito (2026-05-25):** cart/notes/ordemCompra já restauram; o que falta (cliente/endereço/pagamento) é acoplado ao `selectCustomer` (multi-call online) → alto risco no caminho do dinheiro por ganho marginal num caso raro, ainda mais que o envio é sempre online (quem reabre pra enviar está online e re-seleciona em poucos toques). Não re-litigar sem dado de uso mostrando perda real de pedidos. Specs/plans: `docs/superpowers/{specs,plans}/2026-05-24-offline-*`.
2. **Latência percebida <100ms em scan** — 🟡 `ScanBar` com detecção wedge HID. Optimistic UI pattern aplicado em `SalesOrders.deleteOrder` (cache de `useInfiniteQuery` + rollback). BarcodeDetector API ainda não implementada.
3. **Densidade alta em telas operacionais** — ✅ `density-compact` global
4. **WCAG AA mínimo, AAA em críticas** — 🟡 focus-visible OK; variantes `touch` (44px)/`balcao` (56px) criadas no Button; contraste dos tokens validado em `docs/visual-direction/03-validacao.md`; falta adoção sistemática das variantes touch
5. **Mobile-first em chão de fábrica, desktop-first em analítico** — 🟡 `TouchPickingView` (`/admin/estoque/picking/mobile`) existe como scaffold; falta auto-detect mobile
6. **Cmd-k global, atalhos consistentes** — ✅ `Cmd+K` montado com busca global real; `useRegisterShortcuts` + dialog `?`; atalhos do Cockpit migrados pro registry

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
- **Paginação infinita**: `useInfiniteScroll(onLoadMore, enabled)` + `useInfiniteQuery` do React Query para listas grandes (referência: SalesOrders + AdminCustomers em PR #30).
- **Optimistic UI**: padrão `useMutation({ onMutate, onError })` direto (helper genérico `useOptimisticMutation` foi removido em PR #25 — re-criar se for ter consumidor real). Referência viva: `SalesOrders.deleteOrder` (cache de `useInfiniteQuery` + rollback).
- **Touch-friendly**: `<Button size="touch" />` (44px) ou `size="balcao"` (56px) em telas mobile/touchscreen.
- **Empty states**: `<EmptyState tone="operational" />` é o default B2B; `tone="friendly"` para customer-facing.
- **Skeletons**: `<PageSkeleton variant="cockpit | list | form | detail" />` em vez de spinner.
- **Status colors**: classes `text-status-success/warning/error/info` em vez de `text-emerald-600` etc.
- **Toast**: `import { toast } from 'sonner'` é o **único** caminho (`toast.success/error/info`); o wrapper `useToast` foi removido (2026-05-25).
- **Network**: `useNetworkStatus()` e `<NetworkStatusIndicator />` (montado no shell). `lib/offline-queue.ts` expõe `getOfflineQueueDepth`/`subscribeToOfflineQueue` (em uso) + `enqueue`/`flush`/`clearOfflineQueue` (definidos, sem consumidor — aguardam integração).
- **Bulk**: `<BulkActionsBar count actions />` (em uso em SalesOrders). O hook companion `useBulkSelection` foi removido em PR #25 (zero consumers); estados de seleção atualmente vivem em `useState<Set<string>>` direto na page.

### Convenções pós-auditoria

- **Não criar novos `useState` para filtros** em telas de lista — use `useUrlState`.
- **Não escrever `text-emerald-600` / `text-red-600` etc.** em código novo — use `text-status-*`.
- **Não criar novos atalhos via listener `keydown` solto** — use `useRegisterShortcuts`.
- **Não usar `<Loader2 spin />` centralizado** como fallback de página inteira — use `PageSkeleton`.
- **Não montar novo Toaster** — só Sonner está ativo no AppShell.
- **Não instrumentar evento via `posthog` direto** — use `track()` de `@/lib/analytics` com convenção `<area>.<action>`.
- **Não usar `Inter`/fonte genérica em headings novos** — `font-display` (Newsreader) em h1 de telas-hero; `.kpi-value` em valores grandes.
- **Não interpolar input em `.or()` do PostgREST via template literal** — usa os helpers de `@/lib/postgrest` (`ilikeOr`/`ilike`/`eqInt`/`eqText`/`orFilter`), que sanitizam os metacaracteres (`%_,()\"`) e bloqueiam injeção de cláusula. A regra ESLint `no-restricted-syntax` (escopada a `src/`) falha o lint se alguém montar `.or(\`...${...}...\`)` cru. Edge Functions (Deno) inlineiam o mesmo `sanitizeForPostgrestOr`/`ilikeOr`.

## 9b. Redesign visual + telemetria (entregue após a auditoria UX)

Trabalho posterior à Fase 4, no mesmo branch. Artefatos em `docs/visual-direction/`:

- ✅ **Direção visual** — reposicionamento "fintech/SaaS premium" (Vercel/Mercury/Stripe Dashboard). Tokens v3 em `src/index.css`, Geist + Newsreader, dark mode, sidebar light, paleta low-fatigue. Spec em `01-direcao.md` / `02-tokens.md`
- ✅ **Validação** — contraste WCAG calculado (`03-validacao.md`), audit de cores hardcoded (19 telas migradas + sweep de resíduos de sed)
- ✅ **Identidade** — wordmark Colacor, monogramas por empresa, sidebar enxuta (`04-identidade.md`)
- ✅ **Polish via skill `frontend-design`** — 7 quick wins aplicados, 13 itens documentados em `05-revisao-skill.md` (todos implementados em rodada posterior: serif display, atmosphere em cockpits, status-bold, kpi-delta, favoritos, etc.)
- ✅ **Search global no Cmd-K** — `useGlobalSearch` busca clientes/fórmulas/pedidos no Supabase; recentes em localStorage
- ✅ **Telemetria PostHog** — ver §2. Dashboard "Afiação — Adoção UX" criado (project 423408)
- 🟡 **Scaffolds pendentes de sprint próprio**: TouchPickingView **auto-detect mobile** (a confirmação offline de item já está integrada; falta só o roteamento automático mobile vs `/admin/estoque/picking/mobile`), segmentos de cliente / histórico NF-e em schema (hoje localStorage). Recebimento + picking + **envio de pedido (mesma-sessão, #261)** offline já **integrados** (ver §6 item 1). `submitOrder` offline cross-sessão foi avaliado e **deliberadamente não feito** (ver §6 item 1 — ganho marginal × risco no caminho do dinheiro). Scaffolds órfãos (`useBulkSelection`, `useOptimisticMutation`, `useKeyboardShortcuts`, `tint-cache`) foram deletados em PR #25 — re-criar quando voltarem a ter consumidor real.

> PR #4 foi mergeado em 2026-05-14. Auditoria pós-merge (PRs #24-33) capturou 4 issues bloqueantes que o PR #4 introduziu (SQL injection em useGlobalSearch, exposição de profiles sem gate, 66 classes Tailwind quebradas, PostHog DEV pollution) — todos corrigidos. **Lição operacional**: `bun lint && bun build` precisa virar required check no GitHub. ✅ **Feito** — CI (`.github/workflows/ci.yml`) + branch protection exigindo o check `validate` (ver §10). Disciplina: não bypassar com `--admin` de rotina.

---

## 10. Bugs/contradições/débitos — status atualizado

Resolvidos (auditoria 2026-05-13 e auditoria de código 2026-05-16/17):

- ✅ **Logo da sidebar** — `Scissors`+"Central" virou wordmark "Colacor" refinado
- ✅ **Bell ornamental** — removido; topbar agora tem NetworkStatusIndicator + ThemeToggle + CompanySwitcher + Cmd-K pill
- ✅ **Dois sistemas de toast** — só Sonner ativo; Toaster Radix infra deletada em PR #25; wrapper `use-toast.ts` + shim **removidos** em 2026-05-25 (migração concluída; sonner é a única fonte)
- ✅ **Touch targets** — variantes `touch`/`balcao` criadas no Button (adoção sistemática ainda pendente)
- ✅ **Logs silenciosos** — `cockpit_audit_log`, `fin_projecao_13_semanas`, `fin_confiabilidade` agora logam via `logger.warn`
- ✅ **NfeReceipt** — título "OBEN" hardcoded virou dinâmico por empresa
- ✅ **Rename `Afiação Colacor` → `Colacor`** — PR #27 (CompanyContext + index.html + manifest PWA)
- ✅ **BottomNav + Header mortos** — deletados em PR #26 (sempre `return null` dentro do shell, 67 mounts removidos)
- ✅ **`useUserRole.ts` duplicado + `isStaff` divergente** — consolidado em `useAuth()` (PR #28); 19 callsites migrados; `isCustomer` adicionado ao AuthContextType
- ✅ **`useUserRole` fail-OPEN** — corrigido pra fail-CLOSED (PR #24) antes da consolidação; depois o hook foi deletado
- ✅ **Discrepância Account/Empresa em SalesOrders** — `colacor_sc` adicionado ao tipo + Tab no filtro (PR #33)
- ✅ **`SalesOrders` / `AdminCustomers` sem paginação** — infinite scroll com `useInfiniteQuery` + IntersectionObserver (PR #30)
- ✅ **SQL injection em `useGlobalSearch.or()`** + **exposição de profiles sem gate isStaff** — corrigidos em PR #24 (escape PostgREST + gate)
- ✅ **PostHog DEV pollution** — `opt_in_capturing()` invertido pra `opt_out_capturing()` (PR #24)
- ✅ **`aumentos-ativos` polava pra customer** — gate `isStaff && !isSalesOnly` (PR #32)
- ✅ **Charts Recharts sem memo** — 3 components com `React.memo` (PR #32)
- ✅ **Cleanup dead code geral** — 18 arquivos órfãos + 13 deps + 12 default exports redundantes + re-exports inchados em orderSubmission/index.ts deletados em PR #25 (-2200 LoC total)
- ✅ **7 god-components da Reposição quebrados** (todos <1000 LoC, verificado 2026-05-23): AdminRoutePlanner 1661→**286** (extração presentacional + camada de dados pro hook `src/hooks/useRoutePlanner.ts`, PRs #169/#174/#177), AdminReposicaoAumentoDetail 1465→**387** (#166), AdminReposicaoNegociacaoParalela 1201→**702** (#157/#160), FinanceiroDashboard 1242→**299** (#161, frota), AdminReposicaoPromocaoDetail 1691→**534** (frota), AdminReposicaoPedidos 1572→**236** (frota), AdminReposicaoRevisao 1099→**615** (frota). Subcomponentes presentacionais vivem em `src/components/reposicao/<feature>/` (ex: `routePlanner/`, `aumentoDetail/`, `negociacaoParalela/`). Padrão: extrair leaf pieces (types/helpers/constants) → componentes presentacionais (item-cards/dialogs/seletores) → camada de dados pra hook; refs DOM-coupled (Leaflet) ficam na página.
- ✅ **Mutirão de god-components — ENCERRADO (2026-05-25, 40 componentes)**: continuação do item acima, processou os ~30 componentes médios restantes (~500–1000 LoC) pelo mesmo rito (hook `useX.ts` concentra estado/queries/mutations/derivados → presentacionais controlados em `src/components/<feature>/` → comportamento **verbatim 1:1** → testes vitest dos pedaços puros → revisão independente **FIEL 1:1** → CI `validate` → squash-merge). Entregas finais (PRs #277–#315): FarmerTacticalPlan (#277), Histórico/DES (#278), SLA Fornecedor (#280), Aumentos (#283), FarmerBundles (#286), Loyalty (#287), Notificações (#292), FinanceiroCockpit (#294), CustomerDashboard (#299), AIops (#300), SkuMapeamento (#305), AdminCustomers 982→**82** (#312), PosicaoAgora 502→**94** (#315). Bugfix oportunista junto: #309 (paginação de `loadScores` — carteira ~6.908 capada em 1.000 scores + defesa de scroll-lock do Radix). **POLÍTICA daqui pra frente:** não criar god-components novos; **split oportunista** quando tocar um arquivo grande por outro motivo (se valer a pena); **sem split preventivo abaixo de 500 LoC**. Critério pra splitar: **≥500 LoC + business-active + baixo risco**. O mutirão *dedicado* de extração está encerrado (decisão Lucas+Codex, 2026-05-25).
- ✅ **~50 `no-explicit-any` removidos via cast-cleanup** (PRs #181/#183/#186/#199/#202/#206, 2026-05-23). ⚠️ **Descoberta-chave: o `types.ts` NÃO estava stale.** Todas as tabelas referenciadas via `(supabase.from('X') as any)` (kb_documents/kb_chunks/kb_product_specs, customer_contacts/customer_processes/customer_visit_scores, farmer_calls/farmer_client_scores, commercial_roles, standard_processes, call_log) E colunas (`profiles.razao_social`) **JÁ existiam** nos tipos gerados — os casts eram legado defensivo dead-weight, removíveis sem editar o `types.ts`. **NÃO re-adicionar essas tabelas ao `types.ts`** (a #186 tentou e quebrou com `Duplicate identifier` TS2300; revertido). **Lição:** ao remover cast de arquivo que está no `tsconfig.strict.json` include, rodar `bun run typecheck:strict` (NÃO só o baseline `tsc --noEmit`) — a query agora tipada expõe `strictNullChecks` (ex: payload jsonb `ProcessEtapa[]`/`StandardProcessEtapa[]` precisa `as unknown as Json`; `.eq(col, id)` gated por `enabled:!!id` precisa `id!`; return `data as X` vira `data as unknown as X` quando a coluna jsonb não sobrepõe o tipo de domínio).

- ✅ **Stack de views SLA sincronizada com produção** (PRs #224 + #233, 2026-05-24): #224 recriou as 4 views verbatim da produção (drift P1 do codex no #203 — `v_fornecedor_lt_logistica_total` → `v_sku_lt_teorico` → `v_sku_sla_compliance` → `v_fornecedor_sla_compliance`; `security_invoker=on`; `CREATE OR REPLACE` em `v_sku_lt_teorico` p/ não esbarrar no dependente `v_sku_parametros_sugeridos`; aplicado em prod, `views_ok=4`). #233 restaurou 2 guardas perdidas na reescrita: join por `fornecedor_nome` em `v_sku_lt_teorico` + `n_observacoes NULL→poucos_dados` em `v_sku_sla_compliance` (impacto zero confirmado por diagnóstico).

Ainda pendentes (decisão de produto ou sprint próprio):

> ⚠️ **Esta lista derivou da realidade** — vários itens já foram entregues por sessões paralelas mas continuavam marcados como pendentes (causou retrabalho: uma sessão quase reimplementou o N+1 do Omie já feito em `4ef01743`). **Antes de pegar qualquer item, confirme com `git log --oneline -20 origin/main` + `gh pr list --state open` que ele não está feito/em voo.**

- **Drift schema×migrations + repo não-rebuildável** — ~210 objetos em produção sem `CREATE` commitado (detalhe em §5 "Snapshot de schema"). **Snapshot (#244) + complemento funcional (#246) entregues** (`schema-snapshot.sql` + prelude + `schema-infra-outside-public.sql` + `schema-rebuild-runbook.md` + `schema-security-report.md`); archive das migrations **descartado** (nunca mexer em `supabase/migrations/`). **Restore validado por replay local** (2026-05-24, `db/verify-snapshot-replay.sh`): sintaxe/ordem/dependência OK, contagens batem 1:1 com prod. Resta só a verificação "Gold" (runtime Supabase real num projeto vazio/docker).
- ✅ **2 P2s das views SLA — RESOLVIDOS (2026-05-27)**: (1) **3 views sem `security_invoker`** (`score_recalc_pending`, `visit_score_recalc_pending`, `v_oportunidade_economica_hoje`) → `security_invoker=on` (PR #344, migration `20260526060000_views_security_invoker_hardening.sql`). Investigado caso-a-caso: as 2 de fila são service_role-only (engines de scoring, zero impacto); a `v_oportunidade` tem cadeia 100% staff-readable (3 sub-views já invoker-on; bases `promocao_*`/`sku_parametros` = "Staff vê") + consumidores staff-gated (badge AppShell `isStaff&&!isSalesOnly`, cockpit Reposição) → neutro pra staff, fecha o bypass de não-staff. Aplicado+validado em prod (`✅`). (2) **JWT anon hardcoded no cron `sayerlack-portal-watchdog`** → recolado via Vault sem JWT (PR #350, migration `20260526080000_fix_sayerlack_cron_vault.sql` + `verify_jwt=false` declarado em `config.toml` e redeployado no Lovable). Dump real mostrou que o `x-cron-secret` já vinha do Vault; o JWT só passava o `verify_jwt` do gateway — com `verify_jwt=false` a função se gateia via `x-cron-secret` (`authorizeCronOrStaff`). Validado em prod: cron limpo (`✅`) + `net._http_response` 200 nos ciclos `*/5`, sem 401. ⚠️ **Lição:** mexer em cron que aponta pra edge function com `verify_jwt=true` exige **setar `verify_jwt=false` ANTES** de remover o JWT do header, senão o gateway dá 401 e o job para.
- ✅ **"A aprofundar" do report — AUDITADO (2026-05-27, eu + codex), RLS limpo**: 28 `USING(true)` + 11 `WITH CHECK(true)` → os 11 write-true são **todos** `FOR ALL TO service_role` (redundante, zero furo de escrita pra anon/authenticated); as 17 SELECT-true são catálogo público (6, by design) + referência `authenticated` (11: `omie_products`/`warehouses`/`tint_*`, consumidores verificados — wizard de pedido). **Decisões:** `default_prices` anon → **deixar** (catálogo público); `tint_formula_itens` (receita/IP) legível por qualquer logado → **aceitar + documentar**, RPC `SECURITY DEFINER` (preço-só) + SELECT staff-only fica em **backlog de hardening** (não-must-fix; toca money-path por ganho incerto). **Grant audit (EXECUTE por role) ACHOU + CORRIGIU 1 furo real:** `_carteira_mixgap_for_owner`/`_carteira_positivacao_for_owner` (internals SECDEF do view-as, sem gate próprio — o gate é nos wrappers `get_meu_*_for`) estavam **executáveis por `anon`**: a migration de criação (`20260525210000`) revogou de `PUBLIC, authenticated` mas **não de `anon`** (no Supabase `anon` tem grant explícito que `FROM PUBLIC` não pega) → **IDOR não-autenticado** (anon `POST /rpc/_carteira_mixgap_for_owner {p_owner}` puxava a carteira de qualquer dono). Fix: **`20260527140000_revoke_carteira_internals_anon.sql`** (`REVOKE ... FROM anon, authenticated, PUBLIC`; wrappers seguem OK — SECDEF executa como owner). ⚠️ **Lição:** no Supabase, pra travar uma função, `REVOKE FROM PUBLIC` NÃO basta — `anon`/`authenticated` têm grant EXPLÍCITO via default privileges; revogar deles por nome. Resto do grant audit = esperado (wrappers se auto-gateiam por auth.uid/master). Detalhe em `supabase/schema-security-report.md`.
- ✅ **RLS ampla em 5 tabelas-irmãs de carteira — RESOLVIDO (2026-05-26, PR #340)**: `farmer_recommendations`, `farmer_bundle_recommendations`, `farmer_calls`, `route_visits`, `farmer_copilot_sessions` tinham a mesma exposição `FOR ALL master-OR-employee` (BFLA) do #329 → endurecidas com o mesmo rito (split do `FOR ALL`: SELECT = gestor/master OR own OR carteira/cobertura; escrita = gestor/master OR own; reusa `carteira_visivel_para` + `pode_ver_carteira_completa`; `service_role` bypassa). Mapeei os consumidores **por tabela** antes de apertar: escritas client-side são own-scoped (`farmer_id`/`visited_by = user.id`); leituras amplas (tabs Intelligence gerencial) são gestor/master-gated; route planner `lastVisits` degrada honestamente p/ fora-da-carteira. `route_visits` usa `visited_by` (não `farmer_id`); `calls`/`copilot` têm `customer_user_id` nullable → branch own no SELECT. `farmer_performance_scores` NÃO foi tocada (já OK: view own-scoped + manage master-only). 1 consult codex. Migration `20260526040000_rls_carteira_relacionamento_hardening.sql`, aplicada+validada em prod (`✅`). Detalhe completo em §5.
- ✅ **Workbox NetworkFirst para picking/orders/recebimento** — `vite.config.ts` migrado de `NetworkOnly`→`NetworkFirst` (fallback offline + TTL curto) p/ `picking_tasks/units/lotes`, `orders/sales_orders/order_items`, `nfe_recebimentos`, `profiles`. Picking offline-capaz + optimistic (#250) + auto-detect mobile (#276) entregues. (§5 corrigida em 2026-05-25 pra refletir o `NetworkFirst` real.)
- ✅ **`SalesOrders.deleteOrder` — soft-delete entregue**: coluna `deleted_at` + partial index `idx_sales_orders_active` (lista filtra `deleted_at IS NULL`), optimistic remove + rollback quando o Omie falha, versão bulk com rollback parcial. Orquestração single extraída em `src/components/salesOrders/soft-delete.ts` (`softDeleteOrder`, testado). Sem UI de ver/restaurar excluídos (recuperação é parcial — o PV no Omie já foi excluído); follow-up se houver demanda.
- **TypeScript strict mode** — `tsconfig.app.json` tem `strict: false`, `noImplicitAny: false`. Resolve raiz de 1300 lint errors (97% `no-explicit-any`). **Infra incremental pronta**: `tsconfig.strict.json` lista files que passam strict (`strict: true` + `noImplicitAny` + `strictNullChecks` + `noUnusedLocals/Parameters`). Rodar via `bun run typecheck:strict`. CI bloqueia se regressão nos files migrados. Pra migrar mais files: garantir 0 `any` + tipos explícitos + adicionar ao `include` de `tsconfig.strict.json`. Convergência: quando 100% do `src/` estiver em strict, mover flags pra `tsconfig.app.json` e deletar `tsconfig.strict.json`. Progresso (2026-05-23): **`no-explicit-any` no repo = 0** — a eliminação de `any` está **concluída** (src + edge functions + tests; convergência de várias sessões). Fase atual = **PROMOÇÃO** (~409/629 files no `include`, ~65%). ⚠️ **COORDENAÇÃO (obrigatória — trabalho paralelo já causou retrabalho: a #161 decompôs `FinanceiroDashboard` enquanto outra sessão o tipava; e promover god-components quebrou o #180 por cascata transitiva):** antes de QUALQUER migração strict, leia [`docs/strict-migration-lanes.md`](docs/strict-migration-lanes.md) — tem o estado atual + lições (promova **leaf-first**; `typecheck:strict` só é confiável com **CPU calma**, senão dá falso-negativo; promover um arquivo puxa os imports transitivos pro programa strict). Rode `gh pr list --state open` + `git worktree list`, reserve sua fatia no **primeiro commit**, e **só toque sua fatia**. No `tsconfig.strict.json`, adicione paths **no fim do `include`** — **não reordene o array** (reordenar = conflito com todo PR em voo). A reestruturação "um tsconfig por lane" é flag-day (ver claim file).
- ✅ **N+1 patterns — concluído.** `omie-vendas-sync` + `omie-sync` resolvidos (Promise.all com concurrency, commit `4ef01743`). Frontend `useCrossSellEngine.ts` (profile batching) e `useFarmerExperiments.ts` ✅ resolvidos em PRs anteriores. Não há N+1 conhecido pendente.
- ✅ **`useToast` legado** — migração concluída e o wrapper + shim **removidos** (2026-05-25). Todo código usa `import { toast } from 'sonner'`.
- **~304 cores hardcoded em ~58 arquivos** (`text-emerald-600`/`bg-red-500` etc. — contagem real 2026-05-25, era subestimada como "41") — sweep pra `text-status-*`. É grande, **visual** e exige julgamento semântico por ocorrência (esse verde é "success" ou decorativo?), então quer `/design-review` depois. Top: Admin.tsx (12×), call/SpinSuggestionCard (8×), TintReconciliation/AdminGamification/StatusBadge (6× cada).
- **Adoção `useUrlState`** — ⚠️ contagem "5/119" stale: na verdade só **`CustomerListView.tsx`** usa hoje (verificado 2026-05-27). O estado de filtro migrou pros **hooks** no mutirão de god-components, então a adoção é nos hooks, não nas páginas. Convenção: migrar **oportunisticamente** ao tocar o arquivo — **não** em sweep dedicado (valor modesto por unidade).
- **📌 Handoff — frentes de dívida avaliadas e DELIBERADAMENTE adiadas (2026-05-27)**: após fechar saúde-do-sync + RLS §10, avaliei os 3 fronts de dívida genérica com o codex e **nenhum é ganho limpo agora** — não force, registre o gatilho:
  - **Cores hardcoded** (~304): só atacar **quando a sessão de design não estiver rodando** (colide nos arquivos de página). Excluído pelo founder enquanto design roda em paralelo.
  - **strict-mode** (promoção ~65%): só em **janela sem PRs em voo**, **1 leaf-file por PR**, sem reordenar o `include`, CPU calma (ver coordenação acima). Pior momento = repo multi-sessão ativo.
  - **`useUrlState`**: só **oportunístico** (ao tocar a tela por outro motivo).
  - **Testes**: os helpers money-critical (dre/aging/ncg/valor/regime/compras-otimizador) **já têm cobertura**; os arquivos sem teste são dados estáticos (`dre-tabelas-tributarias`) ou formatadores presentacionais (`sku-param`) → baixo valor. Só escrever teste **quando houver lógica nova** no money-path.
  - **Saúde de dados/cron**: espaço sendo construído pela #356 (Sentinela de Saúde de Dados) — não invadir.
- ✅ **Agrupamento de lazy chunks** — `vite.config.ts` tem `manualChunks` (em `rollupOptions`) agrupando os peers. (Ajustes finos de bucket conforme bundle crescer.)
- ✅ **CI obrigatório no GitHub** — `.github/workflows/ci.yml` (job `validate`: typecheck + typecheck:strict + test + build + **lint (errors-only)** — todos **bloqueantes**) roda em PR+push pra main, e a branch protection da `main` **exige o check `validate`** (`enforce_admins: false`, sem review obrigatório). PR #4 não se repete. **Lint virou bloqueante em 2026-05-26** (era informativo): a dívida de `no-explicit-any` foi zerada, então o lint passou a ser gate real — o que importa é que a regra de segurança `no-restricted-syntax` (anti-injeção PostgREST `.or()`, nível error, escopo `src/`) agora bloqueia o PR de verdade. **Warnings (hoje 82, todos `react-hooks/exhaustive-deps`) seguem não-bloqueantes** (eslint só falha em error); ratchet de warnings é follow-up.
  - ⚠️ **Disciplina de merge (regra, 2026-05-25):** **NÃO usar `gh pr merge --admin` de rotina.** O `--admin` bypassa o CI (permitido porque `enforce_admins=false`) e torna o gate teatro. Fluxo normal: `gh pr merge --squash` (ou `--squash --auto` pra mergear sozinho quando o `validate` passar, ~3 min). `--admin` é **só pra emergência do owner** (ex.: hotfix de prod com CI quebrado por causa externa).
  - **`strict: false` (decisão 2026-05-25):** a `main` exige o CI passar mas **NÃO** exige o PR estar atualizado com a main (sem treadmill de rebase). Motivo: repo multi-sessão de alta velocidade — `strict: true` forçava rebase a cada merge alheio (ou `--admin`), inviabilizando a disciplina acima. Regressões de interação entre PRs ficam pro CI de push-na-main pegar (fix-forward). Único conflito comum ao atualizar: os auto-gerados `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` → resolver com `bun run audit:migrations`.

---

## 11. Premissas de auditoria (confirmadas 2026-05-13)

Sem perguntas pendentes. Tudo confirmado pelo briefing oficial:

- **Empresas**: Colacor (indústria, vende industrializados) · Oben (distribuidora, compra e revende) · Colacor SC (serviços). `Afiação Colacor` no código vai virar `Colacor` em rename futuro.
- **5 personas operacionais** mapeadas via roles existentes + `commercial_roles` + futuro "departamento" (ver §5). Auditoria UX assume persona dominante conhecida por tela.
- **Offline-first em picking e recebimento**: ~~gap crítico (Workbox hoje `NetworkOnly`)~~ → ✅ **ENTREGUE** (NetworkFirst + fila offline + optimistic; ver §6 item 1). *[premissa de 2026-05-13, resolvida.]*
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

## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).

---

## 12. Skills instaladas — caminho canônico (consolidação 2026-05-14)

Há muitas skills instaladas (gstack ~40 comandos, superpowers 14, catálogo de marketplace, code-review oficial). Várias têm função sobreposta. **Para cada tarefa abaixo, use o caminho canônico e ignore os demais** — não escolher na sorte.

| Tarefa | Caminho canônico | Não usar (e por quê) |
| --- | --- | --- |
| **Revisar diff antes de mergear** | `/review` (gstack) — checa SQL safety, trust boundary de LLM, side effects condicionais | `engineering:code-review`, `simplify`, `requesting-/receiving-code-review` (superpowers). São redundantes; superpowers é processo multi-agente, não revisão de diff. |
| **Revisão de segurança** | `/security-review` (code-review oficial) | — complementa o `/review`, não substitui. Rode os dois antes de PR sensível. |
| **Debugar bug / falha / comportamento inesperado** | `/investigate` (gstack) — 4 fases, "no fixes without root cause" | `engineering:debug`, `systematic-debugging` (superpowers). Mesma filosofia, escolha uma só. |
| **Planejar feature multi-step** | `writing-plans` → `executing-plans` (superpowers) | `Plan` agent cru. Para feature grande/arriscada, escalar para `/plan-eng-review` ou `/autoplan` (gstack). |
| **Decidir se vale construir algo** | `/office-hours` (gstack) | — antes de `writing-plans`, não depois. |
| **Brainstorm / exploração de ideia** | `brainstorming` (superpowers) | `product-management:brainstorm`, `product-management:product-brainstorming`. |
| **Memória entre sessões** | auto-memory nativo do Claude Code (já ativo) | `claude-mem` está instalado mas **desativado de propósito** — não reativar, duplicaria escrita. Não usar `productivity:memory-management`. |
| **Navegar/testar no browser** | `/browse` (gstack) | `mcp__Claude_in_Chrome__*`, `mcp__Claude_Preview__*`. Já dito na seção gstack acima. |
| **QA da app rodando** | `/qa` (report + fix) ou `/qa-only` (só report) — gstack | — |
| **TDD ao escrever código** | `test-driven-development` (superpowers) | — disciplina de escrita; `engineering:testing-strategy` só para desenhar plano de teste do zero. |
| **Qualquer task Supabase (DB/Auth/Edge Functions/RLS/migrations)** | `supabase` (oficial) | `engineering:debug` genérico. O skill oficial conhece padrões idiomáticos de RLS/Edge Functions/CLI. |
| **Aplicar mudança de banco sob o constraint do Lovable** (criar tabela/coluna/índice/policy/função/trigger/enum/cron) | `lovable-db-operator` (project-scoped, `.claude/skills/`) — gera a migration, o bloco pra colar no SQL Editor, a query de validação pós-apply, a nota de PR e regenera o audit | Não substitui `supabase`/`supabase-postgres-best-practices`: esses desenham o SQL/RLS idiomático; o `lovable-db-operator` orquestra o **apply manual + validação** que o Lovable exige (§5). Use os dois juntos: design com `supabase`, entrega com `lovable-db-operator`. |
| **Otimizar query/schema Postgres** | `supabase-postgres-best-practices` (oficial) | — usar junto do `supabase` ao mexer em SQL/índices. |
| **Performance React (memo, waterfalls, bundle, N+1 em engines IA)** | `vercel-react-best-practices` | `engineering:tech-debt` genérico. 45 regras priorizadas por impacto. |
| **Refatorar god-component (>1000 LoC da Reposição) em compound components** | `vercel-composition-patterns` | — pareia com react-best-practices ao quebrar os 7 god-components do §10. |
| **Auditar UI/acessibilidade (WCAG AA/AAA)** | `vercel-web-design-guidelines` (fetcha regras em runtime) | `design:accessibility-review` (checklist menos rigoroso; ainda útil pra revisão manual). |
| **Optimistic UI / cache / mutações React Query** | `tanstack-query` | — receitas `onMutate`/`onError`/rollback; referência viva é `SalesOrders.deleteOrder`. |
| **Adicionar error monitoring (Sentry) ao app** | `sentry-react-sdk` (via router `sentry-sdk-setup`) | — só se houver decisão de produto de adotar Sentry; hoje só PostHog. |
| **SAST profundo (scan de vulnerabilidade)** | `semgrep` (rápido, JS/TS) ou `codeql` (interprocedural, requer build) + `sarif-parsing` pra agregar | complementam `cso` + `/security-review` (heurísticos); estes rodam análise estática real. |
| **Auditar supply chain de deps** | `supply-chain-risk-auditor` (Trail of Bits) | — pareia com `cso` (que faz dependency supply chain em alto nível). |
| **Modelar RBAC / mapear 5 personas → roles + departamentos** | `access-control-rbac` | — apoia o plano de personas do §5. |

**Colisão de nome conhecida:** existe `/review` do gstack e `review` do plugin oficial code-review. Tratamos o **`/review` do gstack como o canônico** para revisão de diff. Se o comando errado disparar, invocar explicitamente via gstack.

Esta tabela é viva — ao instalar/remover skill, atualizar aqui.

### Preferência do founder — segunda opinião de IA no brainstorming (registrada 2026-05-19)

> 🟢 **Toda vez que estivermos em brainstorming**, se fizer sentido pro tema (decisão de arquitetura, metodologia, trade-off não-óbvio), **proponho proativamente uma "discussão" com uma segunda IA** pra melhorar o produto final — e **eu mesmo conduzo via skill `/codex` (consult mode)**, sem fazer o founder copiar/colar pro ChatGPT manualmente (isso desgasta ele com idas e vindas). Fluxo: eu monto o brief, rodo `/codex` consult, leio a resposta, e incorporo o que faz sentido no design — só trago pro founder o resumo do que mudou e por quê. Se o founder preferir explicitamente levar pro ChatGPT dele numa ocasião, tudo bem, mas o default é eu resolver a segunda opinião in-tool via codex.
>
> **Status do codex (2026-05-19):** instalado via Homebrew cask (`codex` 0.130.0, em `/opt/homebrew/bin/codex`) e **autenticado** (`~/.codex/auth.json` existe). `npm` NÃO está no PATH desta máquina — se precisar reinstalar/atualizar, usar `brew upgrade codex`, não npm. Consult roda direto: `codex exec "<prompt>" -C <repo> -s read-only -c 'model_reasoning_effort="medium"' --enable web_search_cached --json`. Primeira consulta (A2 metodologia financeira) pegou furos reais de regime tributário — vale o investimento.

> **Lições (2026-05-24, sessão do baseline de schema):**
> - **Consultar codex em decisão de arquitetura não-óbvia paga.** A consulta sobre "como landar o squash" evitou um erro real: eu ia mexer em `supabase/migrations/` (mover baseline + arquivar 222) — o codex apontou que a pasta é reconhecida pelo ecossistema Lovable/Supabase e que isso arrisca confundir builder + tracking. Pivotei pra `db/`/`supabase/schema-*` sem tocar migrations (ver §5).
> - **Coordenação: checar `gh pr list` + estado da `main` ANTES de qualquer trabalho grande** (não só strict-migration — §10 já avisava pra aquele caso, mas vale pra TUDO). Nesta sessão uma sessão paralela (#244/#247) entregou o snapshot de schema enquanto eu construía um squash duplicado → retrabalho de reconciliação. Atualizar a branch com a main cedo (e ler docs/arquivos recém-mergeados) teria pego a colisão antes.

### 12b. Skills instaladas em 2026-05-19 (stack-specific, gaps do §10)

15 skills novas em `~/.claude/skills/` (instaladas via git clone dos repos oficiais, não via marketplace pois nenhuma está registrada lá):

- **Supabase oficial** (`supabase`, `supabase-postgres-best-practices`) — repo [supabase/agent-skills](https://github.com/supabase/agent-skills)
- **Vercel Engineering** (`vercel-react-best-practices`, `vercel-composition-patterns`, `vercel-web-design-guidelines`) — repo [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)
- **TanStack Query** (`tanstack-query`) — repo [secondsky/claude-skills](https://github.com/secondsky/claude-skills)
- **Sentry** (`sentry-sdk-setup` [router], `sentry-react-sdk`, `sentry-code-review`, `sentry-fix-issues`) — repo [getsentry/sentry-for-ai](https://github.com/getsentry/sentry-for-ai). `sentry-react-sdk` tem `disable-model-invocation: true` — só dispara via o router `sentry-sdk-setup`.
- **Trail of Bits security** (`semgrep`, `codeql`, `sarif-parsing`, `supply-chain-risk-auditor`) — repo [trailofbits/skills](https://github.com/trailofbits/skills)
- **RBAC** (`access-control-rbac`) — repo secondsky

> Atualização: para atualizar essas skills, re-clonar o repo de origem e re-copiar a pasta da skill em `~/.claude/skills/`. Não há auto-update (não são plugins de marketplace).

---

## 13. Health Stack (usado por `/health`)

Persistido em 2026-05-17 após primeira run completa do skill com sucesso.

- **typecheck**: `bun run typecheck:strict` (incremental strict em `tsconfig.strict.json`) + `bunx tsc --noEmit -p tsconfig.app.json` (baseline com `strict: false`, checa todo o `src/`+testes). ⚠️ **NÃO usar `bunx tsc --noEmit` cru** como baseline: o `tsconfig.json` root tem `"files": []` + `"references"` e, em modo não-build, o tsc ignora as references e checa só o `files` (vazio) → no-op silencioso (não type-checa o `src/`). Foi assim que 2 TS2741 reais (#325 `KpiCards.test.tsx`, #345 `FinanceiroFunding.tsx`) passaram pelo CI e só foram pegos pelo Lovable. O passo de typecheck do CI (`.github/workflows/ci.yml`) já usa `-p tsconfig.app.json` desde 2026-05-26.
- **lint**: `bun lint` (eslint flat config)
- **test**: `bun run test` (vitest run) — canônico, é o que CI executa. `bun test` (runner nativo) cobre só parte por causa de jsdom incompleto + `vi.hoisted/mocked/importActual` não suportados; bunfig.toml + src/test/bun-setup.ts polifillam localStorage/MediaStream/matchMedia mas alguns testes ainda falham. Sempre `bun run test` pra resultado oficial. Ver §2 pro detalhe.
- **deadcode**: `bunx knip --reporter compact`. ⚠️ Ignorar a seção "Unlisted dependencies (38)" — são imports `npm:` das Edge Functions Deno, false-positive pro runtime Node.
- **shell**: `shellcheck scripts/*.sh .claude/hooks/*.sh` (só 2 arquivos; `brew install shellcheck` se ainda não tiver).
- **gbrain**: não configurado neste projeto.

**Pre-flight**: worktrees novos precisam de `bun install` antes de `/health` (~3s pra extrair 955 packages).

---

## 14. Sessões paralelas — uma sessão por working tree (regra)

> Registrado 2026-05-24 após duas sessões Claude rodarem no MESMO diretório principal e trocarem de branch uma da outra (uma quase perdeu commits; só um guard por SHA salvou). Esta máquina roda MUITAS sessões em paralelo (rode `git worktree list` — costuma ter ~10 worktrees ativas em `.claude/worktrees/`).

**Regra:** cada sessão Claude trabalha no **seu próprio working tree**. NUNCA rode duas sessões ao mesmo tempo no diretório principal (`/Users/lucassardenberg/Projetos/afiacao`) — elas compartilham o mesmo checkout, e o `git checkout`/troca de branch de uma vaza pra outra (causa: branch-flip silencioso entre comandos → commit no lugar errado, risco de perda).

- **Worktrees são o padrão seguro** — cada uma tem checkout + branch próprios. As de `.claude/worktrees/*` que o Claude Code cria já isolam automaticamente. O problema só aparece quando uma sessão roda **direto na raiz** junto com outra.
- **Helper:** `bun run wt <branch> [base]` (`scripts/new-worktree.sh`) cria uma worktree isolada como sibling do repo (`../afiacao-<branch>`) a partir de `origin/main` (ou base custom) e imprime os próximos passos (`cd` + `bun install` + abrir a sessão lá).
- **Rede de segurança (hook global):** `~/.claude/hooks/concurrent-session-guard.sh`, registrado em `SessionStart` no `~/.claude/settings.json`, **avisa** (via `systemMessage`) quando uma 2ª sessão inicia no mesmo working tree principal. Worktrees ficam **isentas** (são o caso bom). É aviso, não bloqueio — mas pega o lapso de "abri sem perceber". É global (vale em qualquer repo), validado com shellcheck + pipe-test. Pra revisar/desligar: `/hooks` ou editar o `settings.json`.
