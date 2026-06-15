# CLAUDE.md — Afiação (Sistema Operacional B2B Sardenberg)

> Este arquivo orienta agentes de código (e humanos) trabalhando neste repositório. Última atualização: 2026-05-17 (auditoria de código completa — PRs #24-33 entregues: hotfixes de segurança, cleanup -2200 LoC, useUserRole consolidado, codemod sonner em engines IA, infinite scroll, perf gate em polls. Histórico anterior: auditoria UX 2026-05-13 em `docs/ux-audit/` + redesign visual v3 em `docs/visual-direction/`, ambos mergeados via PR #4).

> **🗣️ Idioma das sessões (preferência do Lucas, 2026-05-20):** responda SEMPRE em **português brasileiro** — nesta sessão e em **qualquer sessão nova ou subagente/sessão spawnada a partir de outra que tenhamos**. Toda comunicação com o usuário (texto, resumos, perguntas, descrição de PR) em pt-BR. Código, rotas, commits e PRs já são pt-BR (ver §5).

> **🪟 Gestão de contexto (preferência do Lucas, 2026-05-30):** em sessões longas, **sugira `/compact` proativamente** quando perceber sinais de contexto cheio (é lembrete, não automação — não tenho leitura contínua da % da janela). ⚠️ **Auto-compactar em 60% NÃO é viável e não deve ser re-tentado:** não existe setting de threshold (o auto-compact nativo só dispara perto do *limite*), nenhum hook dispara por % de contexto, e hook não invoca slash command (`/compact` não é programaticamente acionável — nem por hook, nem por mim). Quem quer "compactar cedo" usa: `/compact <foco>` manual + `/context` pra medir + subagentes (janela própria, não incham a sessão principal).

> **🧭 Roadmap da sessão (preferência do Lucas, 2026-06-01; revisado eu+codex 2026-06-14):** manter um **roadmap vivo** das atividades acordadas e **renderizá-lo no CHAT** sempre que mudar — é assim que o founder acompanha (o canal principal). ⚠️ **NÃO usar mais o arquivo global `docs/roadmap-sessao.md`**: era ímã de conflito multi-sessão (dezenas de worktrees gravando o mesmo arquivo = conflito de merge recorrente) e o founder acompanha pelo chat, não pelo arquivo. Se precisar PERSISTIR (sessão longa/retomável), guardar no worktree DA própria sessão ou no corpo do PR — **nunca** num arquivo compartilhado. **Prática padrão de TODA sessão** (nova ou spawnada): no começo, montar/retomar o roadmap; ao longo, manter em dia no chat; no fim, refletir o estado real. Legenda: ✅ feito · 🔄 em andamento · ⏳ pendente · 🚧 bloqueado · ⏸️ adiado · 🧭 aguardando decisão. (O `docs/roadmap-sessao.md` legado segue no repo até as sessões em voo drenarem — não recriar/alimentar.)

> **🗑️ Resumo de fecho antes de excluir a sessão (preferência do Lucas, 2026-06-13):** sempre que o Lucas perguntar se **pode excluir/apagar/deletar a sessão/conversa/chat** (qualquer fraseado — "posso excluir essa conversa?", "dá pra apagar?", "existe algo a mais a ser feito?"), responder ANTES com um **resumo de fecho COMPLETO do que a sessão se propôs a resolver — do problema até a solução implementada**: (1) **problema/pedido** original; (2) **diagnóstico/causa-raiz**; (3) **decisões de design** (incl. consultas ao Codex/2ª opinião e o que mudou por elas); (4) **o que foi implementado** (arquivos/helpers, PRs com número, migrations); (5) **verificação** (testes/typecheck/lint/build); (6) **pendências que dependem do founder** (merge, Publish no Lovable, migration manual, QA) + **onde tudo está persistido** (PRs, spec/plano em `docs/superpowers/`, git) — pra ele confirmar que nada se perde ao descartar o histórico. Vale pra QUALQUER sessão (nova ou spawnada). **➕ Higiene de Node/RAM no fecho (2026-06-14):** nesse MESMO gatilho (pergunta de excluir/encerrar/apagar a sessão), rodar TAMBÉM `bun run wt:status` (raio-X read-only de RAM/swap/disco/`node_modules`) e oferecer/rodar `bun run wt:clean` (libera os `node_modules` dos worktrees PARADOS — ~580 MB cada; pula o atual, os com sessão viva e os locked; reversível com `bun install`), reportando quanto liberou. A M2 8GB satura fácil — **swap em uso = sinal de RAM cheia**. Detalhe na §14b.

---

## 0. Como usar este arquivo + Armadilhas recorrentes

**Política (mantém enxuto — leia antes de adicionar linha aqui):** o CLAUDE.md guarda só **regras/invariantes que valem sempre**. **Histórico de PR/incidente** vai pra `docs/registro/`; **procedimento operacional** (banco, deploy, cron) pra `docs/runbooks/`; **pendência em voo** pro PR/issue do GitHub. Ao concluir uma entrega, registre em `docs/registro/<modulo>.md` — **NÃO** engorde este arquivo; só acrescente aqui se for uma **REGRA/LIÇÃO** nova. O CI vigia o tamanho (`bun run claude:size`: teto 90 KB / 12k palavras / linha ≤ 2.000 chars).

**Merge (auto, 2026-06-14):** todo PR não-draft **auto-mergeia (squash) quando o CI `validate` passa** — via `.github/workflows/auto-merge.yml` (zero clique do founder; o GitHub espera o check e mergeia + deleta a branch). Pra **segurar** um PR (não querer que mergeie sozinho), deixe-o **DRAFT**. Nunca `gh pr merge --admin` de rotina (bypassa o CI — o auto-merge **não** bypassa, espera o verde).

**Mapa de leitura sob demanda (se for tocar… leia antes):**

| Domínio | Onde |
| --- | --- |
| banco · migration · edge · deploy Lovable | [`docs/runbooks/lovable-supabase.md`](docs/runbooks/lovable-supabase.md) |
| histórico/contexto de um módulo já entregue | [`docs/registro/`](docs/registro/) (ver `README.md`) |
| bugs/débitos já resolvidos (PR + lição) | [`docs/registro/bugs-resolvidos.md`](docs/registro/bugs-resolvidos.md) |
| spec/plano profundo de uma feature | `docs/superpowers/{specs,plans}/` |

**⚠️ Armadilhas que se repetem (caras quando esquecidas — a maioria é money-path/banco):**

- **Lovable = 3 deploys MANUAIS independentes** (Publish frontend · deploy de edge pelo chat · migration no SQL Editor). **Merge na `main` ≠ produção.** Migration custom **não** auto-aplica; o repo **não** é rebuildável só por migrations (`schema-snapshot.sql` é a fonte de DR). Nunca mexer em `supabase/migrations/`.
- **PL/pgSQL é late-bound:** `CREATE` passa e a função só falha em RUNTIME — **teste EXECUTANDO** (PG17 local `db/test-*.sh`), não só criando. Já mordeu 3+ vezes (funções money-path quebradas atrás de chamador silencioso).
- **Antes de `CREATE OR REPLACE`:** comparar o `pg_get_functiondef`/`pg_get_viewdef` **VIVO de prod** com a versão-base (o apply manual diverge do repo). A última migration que recria a função/view **vence**, independe da ordem planejada.
- **`CREATE OR REPLACE VIEW` só ACRESCENTA coluna no fim** — preservar a ordem EXATA das colunas (3+ ocorrências).
- **`_data_health_compute` + `data_health_watchdog` + `fin_sync_heartbeat` são um conjunto ACOPLADO** — mexeu num, recria os três juntos partindo da migration de MAIOR timestamp (os IN-lists de push referenciam os `source` names).
- **Todo cron `net.http_post` precisa de `timeout_milliseconds` explícito** — o default de **5s mata silencioso** qualquer função >5s, e o `job_run_details` mente "succeeded".
- **`cron.job_run_details = succeeded` só prova o ENQUEUE** — a verdade do HTTP está em `net._http_response` (`content`/`error_msg`; filtrar `status_code>=500 OR NULL`). `503 LOAD_FUNCTION_ERROR` + zero `running` no log = edge não BOOTA → fix é redeploy, não código.
- **No Supabase `REVOKE FROM PUBLIC` NÃO tira `anon`/`authenticated`** (têm grant explícito via default privileges) — revogar deles por nome. SECURITY DEFINER bypassa RLS: gate na fronteira, avaliado 1× no topo.
- **PostgREST capa em 1.000 linhas SILENCIOSO** — listas completas exigem `.range()` + ordenação estável (`.order('id')`). E **`.or()` quebra em UPDATE/PATCH** (42703 mesmo a coluna existindo) → claim/UPDATE crítico via RPC SQL-pura.
- **Negação SQL/PostgREST é NULL-blind** (`NOT ILIKE`/`neq` excluem linha com a coluna NULL) — embrulhar em `.or('col.is.null,and(col.not.<op>.val,...)')` via helper de `@/lib/postgrest` (nunca interpolar input cru em `.or()` — ESLint `no-restricted-syntax` barra).
- **Money-path: ausente ≠ zero.** Degradar pra `null`/baixa-confiança/falha-fechada, **nunca** fabricar número (`Number(null)===0` é fabricação). Sinal money-path **nunca** em coluna JSONB compartilhada por vários writers (upsert jsonb é last-writer-wins destrutivo) — coluna dedicada + 1 writer autoritativo.
- **Omie: não confiar em `total_de_paginas`** (sub-reporta em lista grande) — paginar até página vazia + guard anti-loop; `registros_por_pagina>100` é ignorado. Enumeração pesada (~10k+) precisa de bulk reads + background (`waitUntil`) + retry, nunca N+1. Após corrigir a FONTE, snapshots derivados não se regeneram sozinhos — re-invocar o recompute.
- **Lente "Ver como pessoa":** `useAuth()` é SEMPRE real (sessão/escrita/identidade/RLS do master); só LEITURA usa `effectiveUserId`/`display*`. Nunca decidir escrita/identidade com `display*`. O write-guard bloqueia mutação na lente; WebRTC fura o guard → gatear na fonte.
- **`cmd | tail` ENGOLE o exit code** — quando o exit importa (gate/teste/CI local), redirecionar `> log 2>&1; echo $?`, nunca pipe pra `tail`.
- **Teste SQL negativo com `WHEN OTHERS THEN 'OK'` é teatro** — capturar a SQLSTATE esperada, re-lançar o resto, e provar por **falsificação** (sabotar a migration de propósito e exigir vermelho); RLS prova-se sob `SET ROLE authenticated` + GUC (o psql é superuser e bypassaria).
- **Multi-sessão:** antes de tocar arquivo/função QUENTE, conferir `origin/main` + `gh pr list` + migrations de sessões paralelas (timestamp colidido é o aviso). O `roadmap-sessao.md` e o `docs/migrations-audit.md` são ímãs de conflito → resolver com `git checkout --theirs` / `bun run audit:migrations`.
- **Codex** (2ª opinião, preferência do Lucas em decisão de arquitetura): `codex exec "<prompt>" -s read-only < /dev/null`; cota Plus é janela rolante e ESGOTA → "Caminho B" = validação própria exaustiva (PG17/grep) + Codex retroativo quando voltar.
- **Subagentes via Agent tool THRASHAM de contexto neste repo** → implementar inline. **(Reavaliar após esta faxina do CLAUDE.md — pode ter melhorado; é o teste objetivo de sucesso.)**

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
| Tarefas (cobrança) | `/tarefas` + card na Meu Dia | 1 | Vendedor (executa) / founder-gestor (atribui) |
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
> heavy bun run typecheck
> heavy bun build
> heavy --status   # slots em uso
> ```
> Override: `AFIACAO_MAX_HEAVY=2 heavy …`. Comandos leves (`bun lint`, `bun dev`) não precisam.

> ⚠️ **`bun run <cmd> | tail` ENGOLE o exit code** (o pipe retorna o status do `tail`, não do comando) → um teste/typecheck que **FALHA passa batido**. Quando o exit importa (gate, CI local, cadeia `&&`), redirecionar `> log 2>&1; echo $?` e checar o log — **nunca** pipe pra `tail`. (Mordeu em 2026-06-05: um `test exited 1` ficou escondido atrás de `| tail -4` e quase virou push de suíte vermelha.)

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

Mobile menu (lg:hidden) · **Cmd-K pill central** (`CommandPaletteTrigger`) · `ActiveOverrideBadge` · **CompanySwitcher** (monograma colorido por empresa) · **NetworkStatusIndicator** (**some no estado normal** — online + fila vazia → oculto; aparece só em **offline / conexão lenta / fila pendente** com shake/pulse [restaurado em 2026-06-11 a pedido do founder, que viu o ícone poluir o topbar da vendedora na lente; preserva o aviso de queda + fila, crítico p/ a persona offline]. ⚠️ entre ~2026-05 e 06-11 o componente renderizava SEMPRE — não confie em doc/código velho. Popover com **Tipo/RTT só p/ staff** [`displayIsStaff`, lente-aware]; status + fila "Operações pendentes" p/ todos) · **DataHealthBadge** (escudo de saúde de dados; só aparece em vermelho/âmbar — verde não polui — e **só p/ gestor/master** via `useDisplayAccess`, lente-aware; **apertado de `isStaff`→gestor/master em 2026-06-11** junto com o item de menu "Saúde de Dados", senão vendedora sales-only via o atalho sem ver o item) · **ThemeToggle** · botão **Melhorias** (Lightbulb, `displayIsStaff`) · **HelpDrawer** (esconde o "?" em rotas **sem ajuda mapeada** desde 2026-06-11 — antes abria painel "nada encontrado"; X duplicado removido) · dropdown User. O `Bell` ornamental foi removido.

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

> ⚠️ **Atualização (2026-06-06): WebRTC é o ÚNICO backend ATIVO.** O Nvoip click-to-call foi **descontinuado da UI** — `useCallBackend()` (`src/hooks/useCallBackend.ts:20`) retorna WebRTC **incondicionalmente**, e `useWebRTCCall` é só `return useWebRTCCallContext()`. `useNvoipCall`/`NvoipDialer` viram **código morto** (não há mais toggle de backend em `/settings`). A descrição de "dois backends + toggle" abaixo é **histórica**.

- **~~Default~~ — `useNvoipCall` (DESCONTINUADO na UI)**: Edge Function `nvoip-calls` + polling. Click-to-call: a Nvoip ligava primeiro pro ramal Nvoip do vendedor, depois conectava o cliente. **Inativo.**
- **WebRTC (ATIVO, único): `useWebRTCCall`** (JsSIP + SIP over WebSocket). Vendedor liga **direto pelo navegador**, áudio bidirecional `localStream`/`remoteStream`.

**Dispatcher**: `<Dialer />` em `src/components/call/Dialer.tsx` renderiza o `WebRTCDialer` (lazy). **Fonte ÚNICA da ligação**: `WebRTCCallContext.makeCall` (+ `acceptIncoming` p/ entrante) — por onde TODOS os callsites passam (`useWebRTCCall`/`useWebRTCCallContext`/`useCallBackend`; ex.: `AgendaTodayList`, `Telefonia`, `FarmerCalls`). ⚠️ **WebRTC NÃO passa pelo Supabase → fura o write-guard do client.** Por isso a lente "Ver como pessoa" guarda `makeCall`/`acceptIncoming` com `isLensActive()` **na fonte** (ver bullet da lente em §5).

**UI compartilhada**: ambos consomem `CallDialerView` em `src/components/call/CallDialerView.tsx`. Backend é identificado por badge "NVOIP" / "WEBRTC" no painel ativo.

**Credenciais SIP**: nunca em `VITE_*` (vazaria no bundle público). Servidas pela Edge Function `nvoip-sip-creds` (auth + role employee/master via `authorizeCronOrStaff` shared helper). Env vars do server: `NVOIP_SIP_WSS`, `NVOIP_SIP_DOMAIN`, `NVOIP_SIP_USER`, `NVOIP_SIP_PASS`.

**LGPD**: MP3 de aviso em `public/preroll/aviso-gravacao-lgpd.mp3` é mixado no `localStream` via `mixPrerollWithMic` (Web Audio API). URL configurada por `VITE_NVOIP_SIP_PREROLL_URL`. Caller é dono do AudioContext cleanup (`useWebRTCCall.endCall` libera).

**Cleanup crítico**: `useWebRTCCall` guarda `rawMicRef` (da `getUserMedia`) e `prerollCloseRef` separadamente do `localStream` mixado. Em `endCall`/unmount, ambos são fechados antes de SipClient.hangUp para liberar o microfone físico (red dot apaga imediatamente).

### Touch targets

- `index.css`: `button, a, [role="button"] { min-height: 32px; }` aplicado globalmente no desktop
- ✅ **WCAG 44px resolvido globalmente em touch (2026-05-28)**: `index.css` tem `@media (pointer: coarse) { button,a,[role=button]{min-height:44px} button{min-width:44px} }` — celular do separador/vendedor e kiosk touchscreen do operador tintométrico ganham 44px+ automaticamente; desktop fino (conferente/comprador/gestão) fica nos 32px densos (intencional). `min-height` em `<a>` inline é no-op (não quebra links de texto). Abordagem decidida eu+Codex (media query > espalhar `size=touch` por dezenas de telas). ⚠️ QA visual mobile pendente (o `/browse` headless não renderiza a SPA) — conferir no device. Follow-up: 56px (`size="balcao"`) explícito nos CTAs do balcão tintométrico quando houver tela de kiosk/atendimento dedicada (hoje só o scanner OCR usa `balcao`).
- `button.tsx`: `default h-9 (36px)`, `sm h-8 (32px)`, `lg h-10 (40px)`, `icon h-9 w-9 (36px)` — em `pointer:coarse` todos sobem pra ≥44px via a media query. Variantes explícitas `touch` (44px) / `balcao` (56px) seguem disponíveis pra forçar alvo grande independente do device.

### Programas Vendas/Rota/Buddy → [`docs/registro/programas-vendas.md`](docs/registro/programas-vendas.md)

> WhatsApp+Motor de Rota e o copiloto "Buddy" são programas ENTREGUES (resumo no registro; detalhe em `docs/superpowers/`). **Princípios vivos** (valem p/ código novo): a IA conversa mas **preço firme passa por gate humano**; **nunca inventa SKU/preço** (pricing determinístico do Omie); "contradição com evidência" (determinístico-primeiro, LLM só onde agrega).

### LLM em edge function — 2 caminhos (escolha consciente)

- **(a) Anthropic direto — CANÔNICO p/ código novo:** `Deno.env.get("ANTHROPIC_API_KEY")` (já é secret) + `model:"claude-sonnet-4-6"` + SDK `@anthropic-ai/sdk`, com **prompt caching** (system num breakpoint `cache_control:{type:'ephemeral'}` → ~$0.005/call) + **forced tool-use** (`tools`+`tool_choice`) p/ saída estruturada + gate `authorizeCronOrStaff`. Ver `claude-spin-analyze`/`tarefa-extrair-voz`/`kb-extract-specs`/`compare-customer-process`.
- **(b) Gateway Lovable — legado:** `LOVABLE_API_KEY` + `fetch('https://ai.lovable.dev/chat/v1')` + `model:"google/gemini-*"` (OpenAI-compat). Ver `copilot-analyze`/`generate-tactical-plan`/`identify-tool`.
- ⚠️ A "single-provider Anthropic em v1" **só é verdade nos caminhos NOVOS (a)** — vários edge legados usam o gateway Gemini (b). Preferir (a) em código novo.

### Toast / feedback

- **Sonner é o único sistema ativo.** `ui/toaster.tsx` + `ui/toast.tsx` + `@radix-ui/react-toast` foram deletados em PR #25.
- O wrapper `use-toast.ts` (@deprecated) + o shim `ui/use-toast.ts` foram **removidos** (2026-05-25) — a migração dos callsites concluiu. **Todo código usa `import { toast } from 'sonner'` direto** (`toast.success/error/info`). Não existe mais `useToast`.

### Logger

- `src/lib/logger.ts` — wrapper estruturado com níveis (info/error/critical), usado consistente em AuthContext

### Banco & deploy (Lovable) — regras-chave · detalhe em [`docs/runbooks/lovable-supabase.md`](docs/runbooks/lovable-supabase.md)

🔴 **NADA acontece sozinho no merge** — há **3 deploys MANUAIS e independentes**, e **merge na `main` ≠ produção**:
1. **Migrations** → o Lovable **NÃO** aplica migration custom (`supabase/migrations/*.sql`) sozinho; elas ficam SÓ no repo (**falha silenciosa**). Ritual: criar o arquivo → **colar o SQL no SQL Editor do Lovable → Run → validar com query de contagem** → avisar no PR "⚠️ migration manual". Use a skill `lovable-db-operator`.
2. **Frontend** → **Publish** manual no editor do Lovable (`steu.lovable.app` serve o build velho até publicar).
3. **Edge functions** → criadas/editadas pelo **chat do Lovable** (ele lê `supabase/functions/<nome>/index.ts` do repo; deploy verbatim), **não** pela UI Cloud (só mostra logs).

⛔ **Acesso ao banco é SÓ via Lovable SQL Editor** (o founder NÃO tem terminal/curl/CLI/Dashboard pro backend). Instrução sempre rotulada "🟣 Lovable → SQL Editor → cola → Run". Supabase de prod = `fzvklzpomgnyikkfkzai` (NÃO o standalone `lkotrsfdvnwxqyevhffh`).

⚠️ **Repo NÃO é rebuildável via migrations** (~210 objetos em prod sem `CREATE` commitado; módulos nasceram direto no Lovable). Fonte de DR = `supabase/schema-snapshot.sql` (pg_dump de prod). **Nunca mexer em `supabase/migrations/`** (é reconhecida pelo ecossistema Lovable/Supabase).

### Convenções de código

- Pages em PascalCase (`AdminReposicaoCockpit.tsx`)
- Hooks em camelCase com prefixo `use` (`useUnifiedOrder.ts`)
- Idioma: **português brasileiro** em rotas (`/recebimento`, `/reposicao`, `/tintometrico`) **e** em código (estados, labels, comments, nomes de funções tipo `agruparPorMes`)
- Imports absolutos via alias `@/` configurado em `vite.config.ts:92`
- Tabelas Supabase com nomes em `snake_case` português: `eventos_outlier`, `pedido_compra_sugerido`, `fornecedor_aumento_anunciado`, `picking_tasks`, `nfe_recebimentos`, etc.

---

## 6. Princípios não-negociáveis (do briefing) — status atualizado

1. **Offline-first em picking e recebimento** — ✅ **entregue** (Workbox `NetworkFirst` + fila de mutação offline + optimistic; picking/recebimento/envio-de-pedido same-session). O **closed-loop** — Picking Bridge da Oben (#567, ciclo nasce↔morre) e Recebimento honesto que ASSUME o lançamento antes manual no Omie (#576/#595) — em [docs/registro/estoque-picking-recebimento.md](docs/registro/estoque-picking-recebimento.md).
2. **Latência percebida <100ms em scan** — 🟡 `ScanBar` com detecção wedge HID. Optimistic UI pattern aplicado em `SalesOrders.deleteOrder` (cache de `useInfiniteQuery` + rollback). BarcodeDetector API ainda não implementada.
3. **Densidade alta em telas operacionais** — ✅ `density-compact` global
4. **WCAG AA mínimo, AAA em críticas** — 🟡→✅ focus-visible OK; **alvo de toque 44px resolvido globalmente em `pointer:coarse`** (media query no `index.css`, 2026-05-28 — cobre separador/vendedor/operador touchscreen sem tocar o desktop denso); variantes `touch`/`balcao` seguem pra casos explícitos; contraste dos tokens validado em `docs/visual-direction/03-validacao.md`
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

## 9. Padrões e convenções (pós-auditoria UX)

> A auditoria UX (2026-05-13) e o redesign visual v3 foram ENTREGUES — histórico em [docs/registro/auditoria-ux-redesign.md](docs/registro/auditoria-ux-redesign.md). Aqui ficam só as **convenções VIVAS** que orientam código novo.

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


## 10. Bugs/débitos resolvidos → [`docs/registro/bugs-resolvidos.md`](docs/registro/bugs-resolvidos.md)

> O histórico de bugs/contradições/débitos resolvidos (cada um com PR + lição) foi movido pra [docs/registro/bugs-resolvidos.md](docs/registro/bugs-resolvidos.md) na faxina de 2026-06-14. As lições que se repetem estão destiladas na seção **Armadilhas recorrentes**. Pendências ABERTAS de produto/sprint vivem nos PRs/issues do GitHub.

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
> **Status do codex (2026-06-09):** instalado (Homebrew, `codex` em `/opt/homebrew/bin`, login ChatGPT Plus — NÃO API key), modelo fixado `gpt-5.5` no `~/.codex/config.toml` (auto-update semanal preserva o reasoning). Consult: `codex exec "<prompt>" -C <repo> -s read-only < /dev/null` (sempre `< /dev/null` senão pendura no stdin; envolver em `timeout`). Reasoning default `high`; adversarial money-path pede `xhigh` explícito (`-c 'model_reasoning_effort="xhigh"'`). ⚠️ **Cota Plus é janela ROLANTE de 7 dias e ESGOTA** (já derrubou o codex por dias no meio de trabalho) → fallback "Caminho B": validação própria exaustiva (PG17/grep/auto-challenge) + Codex retroativo quando a cota voltar.

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

### 12c. MCPs conectados que valem usar (descobertos 2026-06-14) — Serena + Context7

Pesquisa de "skill nova que valha a pena" (2026-06-14) concluiu que **em skills públicas não há quase nada que o stack já não cubra melhor** (as mais instaladas de 2026 — code-reviewer/git-commit-writer/pr-writer/changelog/env-doctor — já são cobertas por `codex`+`/review`+`/code-review`+`/security-review`+`/ship`; as de "migration testing" tipo DBHub são **inferiores** ao padrão PG17 caseiro de `db/test-*.sh`). O achado real foi que **dois MCPs poderosos já estão conectados na máquina e estavam fora do radar** (o §12 listava só browse/chrome):

- **Serena MCP** (`mcp__plugin_serena_serena__*`) — **análise semântica de código via LSP** (não textual). Tools-chave: `find_referencing_symbols`, `find_symbol`, `find_implementations`, `get_symbols_overview`, `rename_symbol`. **Caminho canônico de uso:** quando precisar **"quem consome X?" antes de mexer em algo com muitos consumidores** — o ritual recorrente do §10 de **"mapear consumidores POR tabela/símbolo antes de apertar RLS"** (#329/#340/#792), refatorar god-component, ou achar todos os callsites de um hook lente-aware (`useAuth` real vs `display*`). **Por que > grep:** num teste real (2026-06-14) o grep de `useKbProductSpecs` deu 6 arquivos (com ruído de substring `...List` + menção em comentário + a própria def); o Serena deu **1 referenciador exato** (`AdminKnowledgeBaseDetail`), confirmando o guardrail "a venda nunca usa o hook singular" — foi mais preciso até que `grep -w` (excluiu a menção em docstring). Fluxo: `activate_project <path>` → `find_symbol` p/ localizar → `find_referencing_symbols`. ⚠️ **Custo real na M2 8GB:** o LSP indexa a frio → **o 1º símbolo costuma dar `TimeoutError`** (deu 2× no teste, respondeu na 3ª com `relative_path` restrito e LSP aquecido). Use **pontualmente** (ativar no worktree pra uma tarefa de "quem usa isto?"), **NÃO** deixar indexando as ~30 worktrees sempre (§14). Pule o `onboarding` do Serena (overhead pesado). Truque: ache o arquivo de definição com `grep -rln` (instantâneo) e passe o `relative_path` exato ao Serena pra encurtar o aquecimento do LSP.
- **Context7 MCP** (`mcp__plugin_context7_context7__query-docs` / `resolve-library-id`) — **docs atualizadas em runtime** de libs (Supabase, TanStack Query, Vite, Radix, react-hook-form…). Menos crítico (já há as skills `supabase`/`tanstack-query`/`vercel-*`), mas é o caminho honesto pra **checar API nova sem confiar em memória** (cutoff jan/2026). Usar quando o §"claude-api" não cobre (é específico de Claude/Anthropic) e a dúvida é sobre uma lib de terceiro.

> Gap que NENHUMA skill pública cobre (candidato a **criar**, ver §12d se existir): o fluxo **Lovable** — as 3 coisas que não acontecem sozinhas no merge (Publish do frontend / deploy de edge / migration no SQL Editor) + verificação de deploy pelos bytes do bundle + colisão de timestamp multi-sessão. O `lovable-db-operator` já cobre o lado do banco; falta uma irmã de **deploy/verificação**.

---

## 13. Health Stack (usado por `/health`)

Persistido em 2026-05-17 após primeira run completa do skill com sucesso.

- **typecheck**: `bun run typecheck` (= `tsc --noEmit -p tsconfig.app.json`, **strict desde 2026-05-30**, checa todo o `src/`+testes). ⚠️ **NÃO usar `bunx tsc --noEmit` cru**: o `tsconfig.json` root tem `"files": []` + `"references"` e, em modo não-build, o tsc ignora as references e checa só o `files` (vazio) → no-op silencioso (não type-checa o `src/`). Foi assim que 2 TS2741 reais (#325 `KpiCards.test.tsx`, #345 `FinanceiroFunding.tsx`) passaram pelo CI e só foram pegos pelo Lovable. ⚠️ **`bun run typecheck:strict` não existe mais** — a convergência (2026-05-30) deletou o `tsconfig.strict.json` e unificou no `typecheck` único (ver §10 "TypeScript strict mode").
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

### 14b. Limpeza de Node + MCPs enxutas — libera disco/RAM na M2 8GB (2026-06-14, decisão eu+codex)

> Origem: o Lucas roda dezenas de worktrees em paralelo numa M2 **8GB** (satura fácil, swap em uso constante). Dois ralos: cada worktree tem `node_modules` próprio (~580 MB → medido **~8,7 GB** presos em 25 worktrees) e cada plugin-MCP global sobe um processo no boot. Desenho revisado com o codex.

- **`bun run wt:status`** (`scripts/wt-status.sh`, read-only) — raio-X pra quando o Mac ficar lento: RAM disponível, **swap em uso** (sinal de saturação), disco, total de `node_modules`, sessões `claude` vivas (cwd→worktree) e top-RSS. Não muda nada.
- **`bun run wt:clean`** (`scripts/wt-clean.sh`) — apaga `node_modules` dos worktrees **PARADOS**. **DRY-RUN por padrão**; `--yes` executa; `--include-current` inclui o atual (use ao FECHAR a sessão dele). **Seguro:** pula o worktree **atual**, os com **sessão/processo vivo** (`lsof -a -c claude/bun/node/vite/tsx/vitest -d cwd`), os **`locked`** e os **symlink**; re-checa atividade + **rename atômico** antes do `rm` (não apaga debaixo de um `bun install` em curso). **Reversível:** pra reusar um worktree limpo, `cd` lá + `bun install` — e **numa sessão Claude, EU rodo o `bun install` automaticamente** ao detectar que o `node_modules` foi limpo (antes do 1º test/build/typecheck/dev); o founder **nunca** roda à mão. Só o `node_modules` (peças recriáveis) some — código, commits e arquivos do worktree ficam intactos. **NÃO remove o worktree** (só o Node) — enxugar a `git worktree list` é operação separada e manual (`git worktree remove`, só em worktree comprovadamente mergeado + sem nada não-pushado/ignored importante tipo `.env`).
- **`bun run wt:reap`** (`scripts/wt-reap.sh`) — irmão do `wt:clean`, mas pra **processos**: derruba `vitest`/`esbuild` **órfãos** (de worktree sem `claude` vivo) que seguem comendo RAM depois que a sessão morre. **DRY-RUN** por padrão; `--yes` mata (SIGTERM). **Seguro:** só toca processo cujo cwd está num worktree do projeto, **poupa o atual e todo worktree com `claude` vivo** (no aninhamento worktree-dentro-do-principal vale o match mais longo — um `claude` no principal NÃO salva o órfão de um filho). Decisão pura testada (`scripts/test-wt-reap.sh`). Use quando o `wt:status` acusa swap mas o `wt:clean` dá ~0 (RAM presa em processo, não em `node_modules`).
- **Hook `heavy-guard`** (`.claude/hooks/heavy-guard.sh` — PreToolUse Bash no `.claude/settings.json`) — **nega** test/build/typecheck/vitest rodado **sem `heavy`** e manda re-rodar com, pra ninguém furar o semáforo da §2 (N suítes em paralelo era o que estourava o swap). Fail-safe (não age): sem `heavy` instalado, com `heavy` já presente, ou em leitura/menção (`echo`/`cat`/`grep`/`git`). Vale em **sessões novas** (settings carrega no start). Testes: `scripts/test-heavy-guard.sh`. Pra zero-fricção o founder pode opcionalmente adicionar `Bash(heavy *)` à allow-list (NÃO incluído por padrão — alarga permissão).
- **Ritual de fecho** (ver bloco do topo): quando o Lucas pergunta "posso excluir a sessão?", além do resumo de fecho, rodar `wt:status` + `wt:clean` + `wt:reap` e reportar MB/processos liberados. O worktree ATUAL fica de fora por padrão (sessão viva); use `--include-current` só quando ele confirmar que vai fechar.
- **MCPs enxutas (critério: USO real do `pluginUsage`):** as MCPs vêm de PLUGINS globais; cada plugin-MCP local = processo no boot = RAM. O `.claude/settings.json` do repo (comitado, **project > user** na precedência) desabilita no Afiação **11 plugins** sem uso/peso no dev de TS: `adobe-for-creativity, mercadopago, sentry, slack, telegram, airtable, zapier, github, posthog, chrome-devtools-mcp, serena` — **+ `env ENABLE_CLAUDEAI_MCP_SERVERS=false`** (desliga os connectors da conta claude.ai: gmail/canva/drive/calendar — é tudo-ou-nada, não há toggle por-connector documentado). **Mantidos** (núcleo de dev): `superpowers, claude-mem, claude-md-management, context7`. ⚠️ **Context7 fica LIGADA** (remota/levíssima — chamada pra conferir API atualizada de libs; desabilitá-la poupava ~0 RAM, e é usada de verdade). **Serena fica desabilitada por padrão** (LSP local PESADO, trava a frio na M2 — o §12c já manda usá-la pontualmente); religar sob demanda ao mapear "quem usa esta função".
  - **Religar pontualmente** quando precisar no meio do código: `"<plugin>@claude-plugins-official": true` no **`.claude/settings.local.json`** (gitignored, precedência maior que o comitado) + `/reload-plugins`. Substitutos do dia-a-dia (por isso desabilitar não dói): serena→`grep`/Explore (ou religar p/ análise semântica), chrome-devtools→`/browse` (gstack), github→`gh` CLI no Bash, posthog→dashboard ou religar.
  - ⚠️ Desabilitar o **plugin** mata TUDO dele (MCP **+ skills + hooks**) — intencional p/ adobe/sentry/etc.; por isso superpowers/claude-md-management **ficam ligados**. Worktrees ANTIGOS só herdam o `.claude/settings.json` ao mergear a main; os criados via `bun run wt` (de `origin/main`) já nascem enxutos. Pra reabilitar tudo num projeto, é só remover/editar o `enabledPlugins` do `.claude/settings.json`.
