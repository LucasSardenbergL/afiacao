# CLAUDE.md — Afiação (Sistema Operacional B2B Sardenberg)

> Manual de **regras VIVAS** para agentes de código. O detalhe operacional de cada domínio vive em `docs/agent/*` (índice abaixo, carregado sob demanda); o **diário de PR** em `docs/historico/`; spec/plano profundo em `docs/superpowers/{specs,plans}/`.
> **Política (mantenha enxuto):** só **REGRA/invariante que vale sempre** fica aqui. Histórico → `docs/historico/`; lição de domínio → `docs/agent/`; pendência em voo → PR/issue. Ao concluir uma entrega, registre em `docs/historico/` (ou no doc/agent se for lição nova) — **não engorde este arquivo**. O CI vigia o tamanho (`bun run claude:size` — teto apertado; estourar = mover para `docs/`).

## Preferências do founder (Lucas)

- **🗣️ Idioma:** responda SEMPRE em **português brasileiro** — nesta e em QUALQUER sessão nova ou subagente spawnado. Código/rotas/commits/PRs já são pt-BR.
- **🪟 Contexto:** em sessões longas, **sugira `/compact` proativamente** (é lembrete — não há auto-compact por %, nem hook que dispare slash command). Subagentes têm janela própria.
- **🧭 Roadmap:** mantenha um **roadmap vivo no CHAT** (✅ feito · 🔄 andamento · ⏳ pendente · 🚧 bloqueado · ⏸️ adiado · 🧭 aguardando decisão) e re-renderize quando mudar — é como o founder acompanha. **NÃO** usar arquivo compartilhado (`docs/roadmap-sessao.md` é legado/ímã de conflito — não alimentar); se precisar persistir, no worktree da sessão ou no corpo do PR.
- **🗑️ Fecho de sessão:** quando o Lucas perguntar se pode **excluir/apagar a sessão** (qualquer fraseado), ANTES dê um **resumo de fecho completo** (problema → diagnóstico → decisões/Codex → o que foi implementado [arquivos/PRs/migrations] → verificação → pendências do founder + onde tudo está persistido) E rode **`bun run wt:status`** + ofereça `wt:clean`/`wt:reap` (higiene de RAM/Node — ver `docs/agent/worktrees.md`).
- **🤝 2ª opinião (Codex):** em decisão de arquitetura/metodologia/trade-off não-óbvio — e SEMPRE no money-path — eu proponho e conduzo `/codex` (consult/challenge) eu mesmo, sem o founder copiar/colar. Detalhe em `docs/agent/money-path.md`.

## Índice — `docs/agent/` (referência operacional, LEIA o doc ANTES de tocar o domínio)

| Domínio | Doc |
|---|---|
| banco · migration · RLS · **acesso read-only** · PostgREST | [database.md](docs/agent/database.md) |
| deploy Lovable (3 camadas manuais, verificação) | [deploy.md](docs/agent/deploy.md) |
| sync · cron · Sentinela · assinaturas de incidente | [sync.md](docs/agent/sync.md) |
| **money-path** (precisão>recall, prove-sql, Codex/Caminho B) | [money-path.md](docs/agent/money-path.md) |
| financeiro (engines A1-A4/DRE/funding, data de baixa/DSO-DPO) | [financeiro.md](docs/agent/financeiro.md) |
| reposição/compras (motor, cmc-first, portal Sayerlack) | [reposicao.md](docs/agent/reposicao.md) |
| base de conhecimento (boletim↔SKU, versionamento) | [knowledge-base.md](docs/agent/knowledge-base.md) |
| lente "Ver como" (impersonação, write-guard) | [impersonation.md](docs/agent/impersonation.md) |
| telefonia (WebRTC, SIP, LGPD) | [telefonia.md](docs/agent/telefonia.md) |
| skills & MCPs (roteamento canônico) | [skills.md](docs/agent/skills.md) |
| worktrees · multi-sessão · RAM/Node · `heavy` | [worktrees.md](docs/agent/worktrees.md) |

Diário de PR/entregas: `docs/historico/` (`bugs-resolvidos.md`, `programas-vendas.md`, `auditoria-ux-redesign.md`, `estoque-picking-recebimento.md`). Runbook passo-a-passo de banco/deploy: `docs/runbooks/lovable-supabase.md`.

## ⚠️ Armadilhas recorrentes (caras — a maioria money-path/banco; detalhe no doc/agent indicado)

- **Lovable = 3 deploys MANUAIS** (Publish frontend · edge pelo chat · migration no SQL Editor) — **merge na `main` ≠ produção**. Migration custom **não** auto-aplica (falha SILENCIOSA). **Nunca** mexer em `supabase/migrations/` (snapshot é a fonte de DR). → `deploy.md`/`database.md`
- **Acesso ao banco:** **leitura/diagnóstico EU rodo direto** via `~/.config/afiacao/psql-ro` (role `claude_ro`, read-only blindado — confiro migration aplicada/frescor/`pg_get_functiondef`/`net._http_response` sem o founder). **Escrita** só via SQL Editor do Lovable (founder cola). → `database.md` §1
- **PL/pgSQL é late-bound:** `CREATE` passa, a função só falha em RUNTIME → **teste EXECUTANDO** (PG17 `db/test-*.sh` / skill `prove-sql-money-path`), nunca só criando. → `money-path.md`
- **`CREATE OR REPLACE` função/view:** pré-flight `pg_get_functiondef`/`pg_get_viewdef` da PROD (apply manual diverge do repo); a última a recriar **vence**. VIEW só ACRESCENTA coluna no fim (preservar ordem exata). → `database.md`
- **Cron `net.http_post` precisa de `timeout_milliseconds` explícito** (default 5s mata silencioso; `cron.job_run_details=succeeded` só prova o ENQUEUE — a verdade HTTP está em `net._http_response`). `_data_health_compute`+`data_health_watchdog`+`fin_sync_heartbeat` são um conjunto ACOPLADO. → `sync.md`
- **PostgREST:** capa em 1.000 linhas silencioso (`.range()` + `.order` estável); **`.or()` quebra em UPDATE** (42703 mesmo a coluna existindo) → RPC SQL-pura; negação é **NULL-blind**. **Nunca** interpolar input em `.or()` cru (ESLint `no-restricted-syntax` barra — usar helpers `@/lib/postgrest`). → `database.md`
- **Supabase RLS:** `REVOKE FROM PUBLIC` **NÃO** tira `anon`/`authenticated` (grant explícito — revogar por nome); SECURITY DEFINER bypassa RLS (gate na fronteira). Tabela nova **sempre** com RLS. → `database.md`
- **Money-path: ausente ≠ zero** (`Number(null)===0` é fabricação) → degradar para `null`/baixa-confiança, **nunca** fabricar número. Sinal money-path **nunca** em coluna jsonb multi-writer (upsert destrutivo) → coluna dedicada + 1 writer. → `money-path.md`
- **Omie:** não confiar em `total_de_paginas` (paginar até página vazia + guard); enumeração pesada (~10k+) → bulk + `waitUntil` + retry, nunca N+1; após corrigir a FONTE, re-invocar o recompute (snapshots derivados não se regeneram). → `reposicao.md`/`sync.md`
- **Lente "Ver como":** `useAuth()` é SEMPRE real (escrita/identidade/RLS); só LEITURA usa `display*`/`effectiveUserId`. WebRTC fura o write-guard → gatear na fonte. → `impersonation.md`
- **Multi-sessão (worktrees paralelas):** coordene antes de tocar arquivo/função QUENTE — o "como" e o isolamento ficam na §Multi-sessão ao fim. → `worktrees.md`
- **Teste SQL negativo** com `WHEN OTHERS THEN 'OK'` é teatro → capturar a SQLSTATE esperada + re-lançar o resto + **falsificar** (sabotar a migration e exigir vermelho); RLS prova-se sob `SET ROLE authenticated` + GUC (psql é superuser, bypassaria). → `money-path.md`
- **Shell:** `cmd | tail` **ENGOLE o exit code** → `> log 2>&1; echo $?` quando o exit importa. Comandos pesados (test/build/typecheck/vitest) → prefixar **`heavy`** (semáforo de RAM da M2 8GB). → `worktrees.md`

## Merge (auto)

Todo PR não-draft **auto-mergeia (squash) quando o CI `validate` passa** (`.github/workflows/auto-merge.yml`, zero clique do founder). Para **segurar** um PR, deixe-o **DRAFT**. Nunca `gh pr merge --admin` de rotina (o auto-merge espera o verde — não bypassa o CI).

## Produto

**Afiação/Colacor** — sistema operacional B2B do grupo Colacor. 3 empresas em `src/contexts/CompanyContext.tsx`: `colacor` (Colacor, indústria de abrasivos), `oben` (Oben Comercial, distribuidora moveleira — compra/revende), `colacor_sc` (Colacor SC, serviços, Simples). Módulos (rotas em `src/App.tsx`, ~119 páginas lazy): Afiação (cliente), Vendas (`/sales`), Estoque (`/admin/estoque`, `/recebimento`), Reposição (`/admin/reposicao`), Financeiro (`/financeiro`), Tintométrico (`/tintometrico`), Inteligência/Farmer, Tarefas, Governança, Produção.

## Stack

React 18 + TS 5.8 (**strict**) + Vite 5 + react-router 6 (lazy). Estado: `@tanstack/react-query` (`staleTime 60s`, sem refetch-on-focus, `retry 2`). UI: shadcn/ui sobre Radix; Tailwind 3 + tokens v3 em `src/index.css`. Tipografia Geist/Newsreader. Forms: react-hook-form + zod. Backend: **Supabase** (prod ref `fzvklzpomgnyikkfkzai`). Analytics PostHog (via `track()` de `@/lib/analytics`). PWA Workbox (offline-first picking/recebimento + fila de mutação). Toasts: **`sonner`** (único — `import { toast } from 'sonner'`). Cmd-K global ativo. Host: Lovable Cloud.

### Scripts

```bash
bun dev · bun build · bun lint
bun run test        # vitest — CANÔNICO (é o que o CI roda); bun test (runner nativo) ≠ disto
bun run typecheck   # tsc --noEmit -p tsconfig.app.json (strict). NÃO usar tsc cru (no-op: root tem files:[])
heavy bun run test  # 'heavy' = semáforo de RAM (M2 8GB); prefixe test/build/typecheck/vitest
```

`| tail` engole o exit code (use `> log 2>&1; echo $?`). Health stack (`/health`): typecheck · lint · test · `bunx knip` (deadcode) · `shellcheck scripts/*.sh .claude/hooks/*.sh`. Worktree novo: `bun install` antes.

## Design System (v3 — "fintech premium": Vercel/Mercury/Stripe Dashboard)

Tokens em `src/index.css` (paleta quase-neutra low-fatigue; `--status-*` dessaturadas; radius 6px; motion easing Vercel; dark via `next-themes`; `density-compact` global). Direção completa: `docs/visual-direction/`. Benchmark UX: Linear/Notion/Carbon/Polaris/Retool (anti-referências: Material 3, Bootstrap, Stripe landing consumer). **Convenções de código novo:**

- Status colors: `text-status-success/warning/error/info` — **não** `text-emerald-600`/`text-red-600`.
- Filtros de lista: `useUrlState` — não `useState`. Listas grandes: `useInfiniteScroll` + `useInfiniteQuery`.
- Atalhos: `useRegisterShortcuts` (dialog `?` auto-descobre); Cmd-K: `useRegisterCommands` — não listener `keydown` solto.
- Toast: só `sonner`. Skeleton: `<PageSkeleton variant>` — não `<Loader2 spin>` de página inteira. Empty: `<EmptyState tone="operational">`.
- Touch: `<Button size="touch">` (44px) / `balcao` (56px); `pointer:coarse` já dá ≥44px global.
- Heading hero: `font-display` (Newsreader). Analytics: `track()` com `<area>.<action>` — não `posthog` direto.

## Auth & roles

`AppRole = 'employee' | 'customer' | 'master'`; `isStaff = isAdmin || isEmployee || isMaster` — tudo via **`useAuth()`** (não recriar; `useUserRole` foi consolidado nele). **Fail-closed:** query de role/approval falha → role `null`, approval `false`. Customers precisam de `is_approved`; staff é auto-aprovado. `commercial_roles` (gestor/vendedor) é paralelo ao role principal. Restrição sales-only por CPF: `useSalesOnlyRestriction`. As 5 personas operacionais (separador/conferente/comprador/vendedor externo/gestão) são **recortes de acesso**, não roles novos.

## Princípios não-negociáveis (briefing)

1. **Offline-first** picking/recebimento ✅ (Workbox + fila de mutação + optimistic). 2. Latência <100ms em scan 🟡 (`ScanBar` wedge HID; BarcodeDetector ainda não). 3. Densidade alta em telas operacionais ✅. 4. WCAG AA (AAA em críticas) — 44px touch global ✅. 5. Mobile-first chão de fábrica / desktop-first analítico 🟡. 6. Cmd-K + atalhos consistentes ✅.

## Convenções de código

Pages PascalCase; hooks `useX` camelCase; rotas **e** código em **pt-BR** (`/recebimento`, `agruparPorMes`); imports absolutos `@/`; tabelas Supabase `snake_case` PT. **LLM em edge:** código novo → Anthropic direto (`ANTHROPIC_API_KEY` + `claude-sonnet-4-6` + prompt caching + forced tool-use + gate `authorizeCronOrStaff`); legado usa o gateway Lovable/Gemini. Roteamento de skills (qual usar por tarefa): `docs/agent/skills.md`.

## gstack (REQUIRED)

Obrigatório para o trabalho assistido. O hook [`check-gstack.sh`](.claude/hooks/check-gstack.sh) **bloqueia o uso de skills** se faltar — com as instruções de instalação no próprio bloqueio. Não contornar. Web browsing → sempre `/browse`.

## Multi-sessão (regra — detalhe em `docs/agent/worktrees.md`)

**Uma sessão Claude por working tree.** NUNCA 2 sessões no diretório principal (`/Users/lucassardenberg/Projetos/afiacao`) — o branch-flip vaza entre elas (risco de perda). Worktrees isolam (`bun run wt <branch>`). **Antes de tocar arquivo/função QUENTE:** conferir `origin/main` + `gh pr list` + migrations paralelas (timestamp colidido é o aviso). Higiene de RAM/Node na M2 8GB: `wt:status`/`wt:clean`/`wt:reap`/`wt:prune` (numa sessão Claude EU rodo `bun install` ao detectar `node_modules` limpo). MCPs enxutas via `.claude/settings.json` (Serena off por padrão — religar pontual).
