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
- **PWA**: `vite-plugin-pwa` com Workbox — `NetworkFirst` apenas para catálogo, `NetworkOnly` para `orders/profiles/sales_orders/order_items` (ver §5)
- **OCR**: `tesseract.js` 5.0 (usado em `RecebimentoConferencia` / `LoteScannerOCR`)
- **Mapas**: `leaflet` 1.9 + `@types/leaflet` (route planner)
- **Charts**: `recharts` 2.15
- **Comando**: `cmdk` 1.1.1 — **command palette global ativo** (`Cmd+K`), montado em `AppShell` via `src/components/shell/CommandPalette.tsx` com busca global real (clientes/fórmulas/pedidos) + comandos contextuais + recentes
- **Voz/IA**: `@elevenlabs/react` 0.14 (transcribe)
- **Drag-and-drop**: `@hello-pangea/dnd` 17 (kanban)
- **Toasts**: `sonner` 1.7 — sistema único. `useToast` legado continua via wrapper de compat em `src/hooks/use-toast.ts`
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
- `use-toast.ts` permanece como **wrapper de compat (@deprecated)** delegando pra Sonner — preserva os ~100 callsites legados sem refactor imediato.
- Engines IA novos (`useBundleEngine`, `useTacticalPlan`, `useFarmerExperiments`, `useFarmerPerformance`) já migrados pra `import { toast } from 'sonner'` direto (PR #29). Convenção pra código novo: usar sonner direto.

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

**RECOVERY no Supabase do Lovable (concluída 2026-05-19)**: como Fundação + A1 tinham sido aplicados por engano no Supabase standalone, foi feita re-aplicação completa no Supabase do Lovable via SQL Editor (5 blocos A→B→C→D→E idempotentes) + re-deploy das 5 edge functions via chat do Lovable. Estado final validado: **9/9 tabelas, 6/6 funções, 18/18 triggers anexados, ambas colunas (regime + snapshot_dre_caixa_id), unique constraint com regime, seed config 3 empresas, 3 CNPJs**. Edge functions Active no Lovable: `omie-financeiro` (EDIT, 1493 linhas, lida do repo), `fin-period-override`, `fin-suggest-mapping`, `fin-ic-reconcile`, `fin-cashflow-engine` (4 novas). **2 crons agendados e ativos** (BLOCO E): `fin-cashflow-snapshot-diario` (`0 10 * * *`, snapshot 13s por empresa×cenário) e `fin-ic-reconcile-daily` (`0 9 * * *`). **Módulo financeiro 100% completo e automatizado no Supabase de produção.**

**Programa "Estado da Arte do Financeiro" — status (atualizado 2026-05-23)**: sobre a Fundação/A1, executado em ondas (cada uma validada por consult Codex, TDD em helper puro espelhado no engine Deno, mergeada e em produção no Lovable). Specs/planos em `docs/superpowers/{specs,plans}/`; helpers em `src/lib/financeiro/`.
- ✅ **Onda 1 — NCG** (PCO sem double-count de tributo, estoque real via `fin_estoque_valor`, CCC com PME, rename "capital giro próprio"→"liquidez operacional líquida"). Helper `ncg-helpers.ts`. Mergeada no PR #138.
- ✅ **Onda 2 — Timing da projeção 13s** (curvas de aging calibradas por exposição, vencidos reagendados, ponte "após horizonte/AR impaired", PMR/PMP + inadimplência ponderados por R$, guard de folha por janela). Helper `aging-helpers.ts` (espelho em `fin-cashflow-engine`). PR #138.
- ✅ **Onda 3 — DRE v2 regime-aware** (em `omie-financeiro/calcularDRE`, helpers `dre-helpers.ts` + `dre-tabelas-tributarias.ts`): **3a** estrutural — deduções (ICMS/ISS/PIS/COFINS/IPI) vs IRPJ/CSLL; **DAS único no Simples** (nunca quebrado, LC 123); caixa por data real + fallback "caixa estimado"; mapping explícito no lugar do prefixo `'3.99'`; gate de confiança (PR #184). **3b** imposto teórico — Simples (RBT12 + anexo + fator-r) e presumido (trimestral + adicional 10% + PIS/COFINS) ao lado do realizado, degradação honesta p/ `null` (PR #188). Coluna opcional `fin_config_cashflow.dre_tributario` setada nas 3 empresas (Colacor SC = `{regime:simples, anexo:III}`). ⚠️ Trigger `trg_audit` foi **removido de `fin_config_cashflow`** (a função `fin_audit_trigger()` deriva período por `data_emissao`, coluna inexistente em config → quebrava UPDATE; migration `20260523210000_*`, PR #192).
- ⏳ **A2 — Retorno & Valor** (ROIC / WACC hurdle-rate / EVA / spread + **ROIC incremental** headline + **normalização de comingling** reportado×normalizado): **spec aprovado e commitado** em `docs/superpowers/specs/2026-05-23-financeiro-a2-retorno-valor-design.md`, na branch **`feat/financeiro-a2-retorno-valor`**. NOPAT = `EBIT − imposto absoluto do regime` (nunca `×(1−t)`); capital investido = giro (NCG) computado + ativo fixo manual − ajustes; Kd pré-imposto (tax-shield≈0 nos 2 regimes). **Falta** (próxima sessão): writing-plans → implementar `src/lib/financeiro/valor-helpers.ts` (TDD) + espelho no engine + coluna opcional `fin_config_cashflow.valor_inputs` + rota `/financeiro/valor` + UI (master only) + docs → deploy via chat Lovable + PR. **Retomar com:** "continuar A2 a partir do spec na branch feat/financeiro-a2-retorno-valor".
- ⚠️ **Deploy é manual via chat do Lovable após cada merge** — `omie-financeiro` e `fin-cashflow-engine` leem o arquivo do repo (branch main). Sem isso, a main e a produção divergem.

**Padrão de cron descoberto no Supabase do Lovable (2026-05-19, referência pra futuros crons)**:
- `pg_cron` + `pg_net` já habilitados.
- **Project URL (Supabase do Lovable):** `https://fzvklzpomgnyikkfkzai.supabase.co` — confirma a identidade do Supabase correto (NÃO confundir com o standalone `lkotrsfdvnwxqyevhffh`).
- **Auth canônico de cron** (usado por ~25 crons que já rodam): header `'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)`. O secret `CRON_SECRET` já está no Cofre (Vault) — não precisa criar nem rotacionar. Coluna é `decrypted_secret` (não `value`); nome do secret é `CRON_SECRET` (maiúsculo).
- `cron.schedule(nome, schedule, comando)` faz **upsert por nome** → idempotente, pode rerodar.
- ✅ **Crons legados corrigidos (2026-05-19, BLOCO F+G)**: 3 crons da Reposição estavam com `x-cron-secret` placeholder (`<<COLE_O_CRON_SECRET_AQUI>>` / `<<48>>`) → falhavam 401. `gerar-pedidos-diario-oben` (9h15) e `disparar-pedidos-aprovados-oben` (13h) foram corrigidos pro padrão vault. `omie-cron-diario-oben` (diário 7h) era redundante com `afiacao_omie_oben_sync_incremental_2h` (mesma função/body, roda a cada 2h) → **deletado** via `cron.unschedule`. Lição: ao herdar crons de outro contexto, conferir se o `x-cron-secret` é placeholder antes de assumir que rodam.

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
- ⚠️ **Restore ainda NÃO foi testado** num projeto vazio — até passar, é inventário, não seguro de DR.
- O **baseline-squash funcional completo** (captura de infra fora de `public` — crons/buckets/realtime/nomes de secrets — + archive das 222 migrations + verificação de replay + runbook) está planejado na branch **`feat/baseline-squash-schema`** (spec + plano de 10 tasks prontos), a executar quando houver necessidade real de staging/DR funcional. Usa o mesmo dump como insumo.

### Convenções de código

- Pages em PascalCase (`AdminReposicaoCockpit.tsx`)
- Hooks em camelCase com prefixo `use` (`useUnifiedOrder.ts`)
- Idioma: **português brasileiro** em rotas (`/recebimento`, `/reposicao`, `/tintometrico`) **e** em código (estados, labels, comments, nomes de funções tipo `agruparPorMes`)
- Imports absolutos via alias `@/` configurado em `vite.config.ts:92`
- Tabelas Supabase com nomes em `snake_case` português: `eventos_outlier`, `pedido_compra_sugerido`, `fornecedor_aumento_anunciado`, `picking_tasks`, `nfe_recebimentos`, etc.

---

## 6. Princípios não-negociáveis (do briefing) — status atualizado

1. **Offline-first em picking e recebimento** — 🟡 `lib/offline-queue.ts` + `useNetworkStatus` + `NetworkStatusIndicator` montados (apenas leitura: `getOfflineQueueDepth`/`subscribeToOfflineQueue`). Falta integrar `enqueue`/`flush` nas mutações reais (`handleConfirmUnit`, `handleScan`, `handleReportDivergencia`, `submitOrder`) e migrar Workbox de `NetworkOnly`. `useOptimisticMutation` foi deletado em PR #25 (era scaffold sem consumidor) — quando voltar pra integração de optimistic, criar pattern equivalente direto via `useMutation({ onMutate, onError })` (ver SalesOrders deleteOrder como referência inline).
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
- **Toast**: `import { toast } from 'sonner'` é o canônico; `useToast` antigo continua via wrapper (`@deprecated`).
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

## 9b. Redesign visual + telemetria (entregue após a auditoria UX)

Trabalho posterior à Fase 4, no mesmo branch. Artefatos em `docs/visual-direction/`:

- ✅ **Direção visual** — reposicionamento "fintech/SaaS premium" (Vercel/Mercury/Stripe Dashboard). Tokens v3 em `src/index.css`, Geist + Newsreader, dark mode, sidebar light, paleta low-fatigue. Spec em `01-direcao.md` / `02-tokens.md`
- ✅ **Validação** — contraste WCAG calculado (`03-validacao.md`), audit de cores hardcoded (19 telas migradas + sweep de resíduos de sed)
- ✅ **Identidade** — wordmark Colacor, monogramas por empresa, sidebar enxuta (`04-identidade.md`)
- ✅ **Polish via skill `frontend-design`** — 7 quick wins aplicados, 13 itens documentados em `05-revisao-skill.md` (todos implementados em rodada posterior: serif display, atmosphere em cockpits, status-bold, kpi-delta, favoritos, etc.)
- ✅ **Search global no Cmd-K** — `useGlobalSearch` busca clientes/fórmulas/pedidos no Supabase; recentes em localStorage
- ✅ **Telemetria PostHog** — ver §2. Dashboard "Afiação — Adoção UX" criado (project 423408)
- 🟡 **Scaffolds pendentes de sprint próprio**: offline-queue integração real (handleConfirmUnit/handleScan/submitOrder), TouchPickingView auto-detect mobile, segmentos de cliente / histórico NF-e em schema (hoje localStorage). Scaffolds órfãos (`useBulkSelection`, `useOptimisticMutation`, `useKeyboardShortcuts`, `tint-cache`) foram deletados em PR #25 — re-criar quando voltarem a ter consumidor real.

> PR #4 foi mergeado em 2026-05-14. Auditoria pós-merge (PRs #24-33) capturou 4 issues bloqueantes que o PR #4 introduziu (SQL injection em useGlobalSearch, exposição de profiles sem gate, 66 classes Tailwind quebradas, PostHog DEV pollution) — todos corrigidos. **Lição operacional**: `bun lint && bun build` precisa virar required check no GitHub.

---

## 10. Bugs/contradições/débitos — status atualizado

Resolvidos (auditoria 2026-05-13 e auditoria de código 2026-05-16/17):

- ✅ **Logo da sidebar** — `Scissors`+"Central" virou wordmark "Colacor" refinado
- ✅ **Bell ornamental** — removido; topbar agora tem NetworkStatusIndicator + ThemeToggle + CompanySwitcher + Cmd-K pill
- ✅ **Dois sistemas de toast** — só Sonner ativo; Toaster Radix infra deletada em PR #25; `use-toast.ts` é wrapper `@deprecated` (PR #29)
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
- ✅ **~50 `no-explicit-any` removidos via cast-cleanup** (PRs #181/#183/#186/#199/#202/#206, 2026-05-23). ⚠️ **Descoberta-chave: o `types.ts` NÃO estava stale.** Todas as tabelas referenciadas via `(supabase.from('X') as any)` (kb_documents/kb_chunks/kb_product_specs, customer_contacts/customer_processes/customer_visit_scores, farmer_calls/farmer_client_scores, commercial_roles, standard_processes, call_log) E colunas (`profiles.razao_social`) **JÁ existiam** nos tipos gerados — os casts eram legado defensivo dead-weight, removíveis sem editar o `types.ts`. **NÃO re-adicionar essas tabelas ao `types.ts`** (a #186 tentou e quebrou com `Duplicate identifier` TS2300; revertido). **Lição:** ao remover cast de arquivo que está no `tsconfig.strict.json` include, rodar `bun run typecheck:strict` (NÃO só o baseline `tsc --noEmit`) — a query agora tipada expõe `strictNullChecks` (ex: payload jsonb `ProcessEtapa[]`/`StandardProcessEtapa[]` precisa `as unknown as Json`; `.eq(col, id)` gated por `enabled:!!id` precisa `id!`; return `data as X` vira `data as unknown as X` quando a coluna jsonb não sobrepõe o tipo de domínio).

Ainda pendentes (decisão de produto ou sprint próprio):

- **Drift schema×migrations + repo não-rebuildável** — ~210 objetos em produção sem `CREATE` commitado (detalhe em §5 "Snapshot de schema"). **Fase 1 (snapshot) entregue** (PR #244): `supabase/schema-snapshot.sql` + prelude + README + manifest como artefato de DR/auditoria. **Pendente:** (a) testar o restore num projeto Supabase vazio (até lá é inventário, não seguro de DR de verdade); (b) **baseline-squash funcional completo** na branch `feat/baseline-squash-schema` (spec + plano de 10 tasks prontos) quando precisar de staging/DR funcional.
- **Workbox `NetworkOnly` para picking e orders** — contradiz offline-first; `offline-queue.ts` exposto mas não integrado nas mutações reais
- **`SalesOrders.deleteOrder` sem soft-delete** — exclusão direta no Omie; risco compliance. Precisa migration SQL (coluna `deleted_at`) + flag UI
- **TypeScript strict mode** — `tsconfig.app.json` tem `strict: false`, `noImplicitAny: false`. Resolve raiz de 1300 lint errors (97% `no-explicit-any`). **Infra incremental pronta**: `tsconfig.strict.json` lista files que passam strict (`strict: true` + `noImplicitAny` + `strictNullChecks` + `noUnusedLocals/Parameters`). Rodar via `bun run typecheck:strict`. CI bloqueia se regressão nos files migrados. Pra migrar mais files: garantir 0 `any` + tipos explícitos + adicionar ao `include` de `tsconfig.strict.json`. Convergência: quando 100% do `src/` estiver em strict, mover flags pra `tsconfig.app.json` e deletar `tsconfig.strict.json`. Progresso (2026-05-23): **`no-explicit-any` no repo = 0** — a eliminação de `any` está **concluída** (src + edge functions + tests; convergência de várias sessões). Fase atual = **PROMOÇÃO** (~409/629 files no `include`, ~65%). ⚠️ **COORDENAÇÃO (obrigatória — trabalho paralelo já causou retrabalho: a #161 decompôs `FinanceiroDashboard` enquanto outra sessão o tipava; e promover god-components quebrou o #180 por cascata transitiva):** antes de QUALQUER migração strict, leia [`docs/strict-migration-lanes.md`](docs/strict-migration-lanes.md) — tem o estado atual + lições (promova **leaf-first**; `typecheck:strict` só é confiável com **CPU calma**, senão dá falso-negativo; promover um arquivo puxa os imports transitivos pro programa strict). Rode `gh pr list --state open` + `git worktree list`, reserve sua fatia no **primeiro commit**, e **só toque sua fatia**. No `tsconfig.strict.json`, adicione paths **no fim do `include`** — **não reordene o array** (reordenar = conflito com todo PR em voo). A reestruturação "um tsconfig por lane" é flag-day (ver claim file).
- **N+1 patterns remanescentes**: `omie-vendas-sync:765` (pagination sequencial de profiles, ~4 RTT por sync — não crítico) + `omie-sync:1180-1196` (6 deletes serial por order delete — manual path, não crítico). Frontend `useCrossSellEngine.ts:226-233` (profile batching, ~36 RTT em 3598 clientes) ✅ resolvido em PR de profile-fetch paralelo. `useFarmerExperiments.ts:108-122,251-272` ✅ resolvidos em PRs anteriores (comments "antes era N+1" no código).
- **~100 callsites de `useToast` legados** — migrar gradualmente pra `import { toast } from 'sonner'`
- **41 cores hardcoded** (`text-emerald-600` etc.) — sweep pra `text-status-*`. Top 5: Admin (21×), des/PosicaoAtualTab (12×), des/SimuladorTab (11×), AdminPortalSayerlack (10×), AdminRoutePlanner (9×)
- **Adoção `useUrlState`** — hoje 5/119 páginas; migrar `useState` de filtros conforme arquivos forem tocados
- **119 lazy chunks sem agrupação** em App.tsx — agrupar peers (ex: 20 telas de Reposição = 1 chunk via `manualChunks`)
- **`bun lint && bun build` como required check no GitHub** — operacional; PR #4 provou que sem isso o time mergeia código quebrado (66 classes Tailwind quebradas em prod)

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

- **typecheck**: `bun run typecheck:strict` (incremental strict em `tsconfig.strict.json`) + `bunx tsc --noEmit` (baseline com `strict: false`)
- **lint**: `bun lint` (eslint flat config)
- **test**: `bun run test` (vitest run) — canônico, é o que CI executa. `bun test` (runner nativo) cobre só parte por causa de jsdom incompleto + `vi.hoisted/mocked/importActual` não suportados; bunfig.toml + src/test/bun-setup.ts polifillam localStorage/MediaStream/matchMedia mas alguns testes ainda falham. Sempre `bun run test` pra resultado oficial. Ver §2 pro detalhe.
- **deadcode**: `bunx knip --reporter compact`. ⚠️ Ignorar a seção "Unlisted dependencies (38)" — são imports `npm:` das Edge Functions Deno, false-positive pro runtime Node.
- **shell**: `shellcheck scripts/*.sh .claude/hooks/*.sh` (só 2 arquivos; `brew install shellcheck` se ainda não tiver).
- **gbrain**: não configurado neste projeto.

**Pre-flight**: worktrees novos precisam de `bun install` antes de `/health` (~3s pra extrair 955 packages).
