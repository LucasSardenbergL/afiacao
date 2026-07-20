# CLAUDE.md — Afiação (Sistema Operacional B2B Sardenberg)

> Manual de **regras VIVAS** para agentes de código. O detalhe operacional de cada domínio vive em `docs/agent/*` (índice abaixo, carregado sob demanda); o **diário de PR** em `docs/historico/`; spec/plano profundo em `docs/superpowers/{specs,plans}/`.
> **Política (mantenha enxuto):** só **REGRA/invariante que vale sempre** fica aqui. Histórico → `docs/historico/`; lição de domínio → `docs/agent/`; pendência em voo → PR/issue. Ao concluir uma entrega, registre em `docs/historico/` (ou no doc/agent se for lição nova) — **não engorde este arquivo**. O CI vigia o tamanho (`bun run claude:size` — teto apertado; estourar = mover para `docs/`).

## Preferências do founder (Lucas)

- **🗣️ Idioma:** responda SEMPRE em **português brasileiro** — nesta e em QUALQUER sessão nova ou subagente spawnado. Código/rotas/commits/PRs já são pt-BR.
- **🪟 Contexto:** em sessões longas, **sugira `/compact foco: <próximo passo>` proativamente** (compact sem foco preserva mal; não há auto-compact por %). **No 2º compact da MESMA sessão → proponha split com `/handoff-sessao`** (1 entrega = 1 sessão). Subagentes têm janela própria.
- **🧭 Roadmap:** mantenha um **roadmap vivo no CHAT** (✅ feito · 🔄 andamento · ⏳ pendente · 🚧 bloqueado · ⏸️ adiado · 🧭 aguardando decisão) e re-renderize quando mudar — é como o founder acompanha. **NÃO** criar arquivo compartilhado de roadmap (vira ímã de conflito entre worktrees); se precisar persistir, no worktree da sessão ou no corpo do PR.
- **🗑️ Fecho de sessão:** quando o Lucas perguntar se pode **excluir/apagar a sessão** (qualquer fraseado) → **invoque a skill `/fecho`** (checklist com EVIDÊNCIA: PRs mergeados de verdade · migrations aplicadas via psql-ro · edges/Publish · chips com título exato · resumo padrão · `wt:status` + ofertas de limpeza).
- **🤝 2ª opinião (Codex):** em decisão de arquitetura/metodologia/trade-off não-óbvio — e SEMPRE no money-path — eu proponho e conduzo o ritual `/codex` eu mesmo, sem o founder copiar/colar. **Transporte: `scripts/codex-async.sh` em background** (preflight+retry — NUNCA `codex exec` cru em foreground segurando a sessão). Detalhe em `docs/agent/money-path.md`.
- **💻 Comando pro seu terminal:** entregue sempre com `cd <path do worktree>` ANTES — o terminal do founder não fica no worktree (sem o `cd` → "fatal: not a git repository").
- **🎫 Chip ao criar (`spawn_task`):** anuncie no chat o **título exato** + que **quem clica é o founder** — senão o rastreio se perde depois ("não sei qual é este chip").
- **🔐 Segredo nunca em texto plano no chat** (secret/token/`decrypted_secret`) — a transcrição persiste em disco; use placeholder e o Supabase secrets.

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
| tintométrico (fórmula↔receita, preço fail-closed, import) | [tintometrico.md](docs/agent/tintometrico.md) |
| lente "Ver como" (impersonação, write-guard) | [impersonation.md](docs/agent/impersonation.md) |
| telefonia (WebRTC, SIP, LGPD) | [telefonia.md](docs/agent/telefonia.md) |
| skills & MCPs (roteamento canônico) | [skills.md](docs/agent/skills.md) |
| **mapa do app** ("onde faço X" · rotas/módulos por gate) | [mapa-do-app.md](docs/agent/mapa-do-app.md) |
| worktrees · multi-sessão · RAM/Node · `heavy` | [worktrees.md](docs/agent/worktrees.md) |

Diário de PR/entregas: `docs/historico/` (`bugs-resolvidos.md`, `programas-vendas.md`, `auditoria-ux-redesign.md`, `estoque-picking-recebimento.md`). Runbook passo-a-passo de banco/deploy: `docs/runbooks/lovable-supabase.md`.

## ⚠️ Armadilhas recorrentes (caras — a maioria money-path/banco; detalhe no doc/agent indicado)

- **Lovable = 3 deploys MANUAIS** (Publish frontend · edge pelo chat · migration no SQL Editor) — **merge na `main` ≠ produção**. Migration custom **não** auto-aplica (falha SILENCIOSA). **Nunca** mexer em `supabase/migrations/` (snapshot é a fonte de DR). → `deploy.md`/`database.md`
- **Acesso ao banco:** **leitura/diagnóstico EU rodo direto** via `~/.config/afiacao/psql-ro` (role `claude_ro`, read-only blindado — confiro migration aplicada/frescor/`pg_get_functiondef`/`net._http_response` sem o founder). **Escrita** só via SQL Editor do Lovable (founder cola). → `database.md` §1
- **Sync bidirecional do Lovable pode REVERTER a main:** commit "Changes" empurra o workspace VELHO por cima de arquivo recém-mergeado (#1445→#1478: apagou o wiring da edge 4h após o merge; 3 deploys "verbatim da main" deployaram a main JÁ revertida — o deploy estava certo, a main é que tinha voltado). Após merge que toca `supabase/functions/`, **confira `git log -S <símbolo-novo>` do arquivo** antes de pedir o deploy; se um "Changes" atropelou, restaure por PR. → `deploy.md`
- **PL/pgSQL é late-bound:** `CREATE` passa, a função só falha em RUNTIME → **teste EXECUTANDO** (PG17 `db/test-*.sh` / skill `prove-sql-money-path`), nunca só criando. → `money-path.md`
- **`CREATE OR REPLACE` função/view:** pré-flight `pg_get_functiondef`/`pg_get_viewdef` da PROD (apply manual diverge do repo); a última a recriar **vence**. VIEW só ACRESCENTA coluna no fim (preservar ordem exata). **Omitir o `WITH (security_invoker=on)` RESETA a opção** (não preserva) → a view passa a ler como o OWNER e **bypassa RLS**: falha ABERTA, muda autorização e não comportamento — o CI não vê. Repita o `WITH` em TODO replace (#1375: 5 views vazando, 1 p/ `anon`). → `database.md`
- **Cron `net.http_post` precisa de `timeout_milliseconds` explícito** (default 5s mata silencioso; `cron.job_run_details=succeeded` só prova o ENQUEUE — a verdade HTTP está em `net._http_response`). `_data_health_compute`+`data_health_watchdog`+`fin_sync_heartbeat` são um conjunto ACOPLADO. → `sync.md`
- **PostgREST:** capa em 1.000 linhas silencioso (`.range()` + `.order` estável); **`.or()` quebra em UPDATE** (42703 mesmo a coluna existindo) → RPC SQL-pura; negação é **NULL-blind**. **Nunca** interpolar input em `.or()` cru (ESLint `no-restricted-syntax` barra — usar helpers `@/lib/postgrest`). → `database.md`
- **Supabase RLS:** `REVOKE FROM PUBLIC` **NÃO** tira `anon`/`authenticated` (grant explícito — revogar por nome); SECURITY DEFINER bypassa RLS (gate na fronteira). Tabela nova **sempre** com RLS. → `database.md`
- **Money-path: ausente ≠ zero** (`Number(null)===0` é fabricação) → degradar para `null`/baixa-confiança, **nunca** fabricar número. Sinal money-path **nunca** em coluna jsonb multi-writer (upsert destrutivo) → coluna dedicada + 1 writer. → `money-path.md`
- **Cliente do grupo = 2 cadastros Omie LEGÍTIMOS** (`servicos`/Colacor SC + `vendas`/Oben — CNPJs distintos por vantagem fiscal): os **1.633 users `@placeholder.local` sem `profiles`** são **aliases fiscais** (alias ativo + `eligible=false` pela B-lite, prod desde 2026-06-13), **NÃO lixo de import** → **nunca deleção ad-hoc** de `auth.users` (CASCADE cobre só 14 tabelas: 59 pedidos + 836 endereços + 1.459 scores virariam uuid pendurado). Mas **canonicalizar o histórico é decisão legítima de produto** (follow-up do spec) — preserve `sales_orders.account`/proveniência ERP e migre referência a referência. `@placeholder.local`/`ja_logou=0` valem p/ **6.910 dos 6.914** users (discriminante = ausência de `profiles`); `eligible` **não** é fronteira estrutural (scoring/agenda/RLS não filtram). Já redescoberto 2×. → `database.md` §5
- **Omie:** não confiar em `total_de_paginas` (paginar até página vazia + guard); enumeração pesada (~10k+) → bulk + `waitUntil` + retry, nunca N+1; após corrigir a FONTE, re-invocar o recompute (snapshots derivados não se regeneram). → `reposicao.md`/`sync.md`
- **Lente "Ver como":** `useAuth()` é SEMPRE real (escrita/identidade/RLS); só LEITURA usa `display*`/`effectiveUserId`. WebRTC fura o write-guard → gatear na fonte. → `impersonation.md`
- **Multi-sessão (worktrees paralelas):** coordene antes de tocar arquivo/função QUENTE — o "como" e o isolamento ficam na §Multi-sessão ao fim. → `worktrees.md`
- **Teste SQL negativo** com `WHEN OTHERS THEN 'OK'` é teatro → capturar a SQLSTATE esperada + re-lançar o resto + **falsificar** (sabotar a migration e exigir vermelho); RLS prova-se sob `SET ROLE authenticated` + GUC (psql é superuser, bypassaria). Mas **falsificar em UM ambiente não prova a asserção** — a sabotagem entra, fica vermelha no shell de quem escreveu e VERDE no do founder (#1483: `grep -qi "não consegui verificar"` casa "NÃO CONSEGUI…" sob `pt_BR.UTF-8`, que dobra `Ã`↔`ã`, e **não** sob `LC_ALL=C`; a asserção falsificava por acidente de ambiente, não por desenho). Rode a falsificação nos locales que importam (`C` **e** `pt_BR.UTF-8`) e case string **exclusiva do ramo certo, ASCII, caixa fixa, sem `-i`**. → `money-path.md`
- **Validação só conta com EVIDÊNCIA POSITIVA** — rode o comando autoritativo, confirme que **terminou** e capture `exit 0`. Ausência de sinal NÃO é aprovação: processo enfileirado (`heavy` esperando vaga), log sem linha de conclusão, `grep` sem ocorrência e linter que não tem a regra são **ausência de dado**. Três instâncias numa sessão (2026-07-18): `deno lint` limpo lido como CI verde (o CI é ESLint — cada linter só enxerga a PRÓPRIA supressão), `heavy` na fila lido como typecheck concluído, `grep -c "error TS"`=0 sobre log que só tinha "aguardando vez". `cmd | tail` **ENGOLE o exit code** → `> log 2>&1; echo $?`. No zsh, `echo "$json" | jq` **corrompe o JSON** (o `echo` interpreta o `\n` escapado, virando newline cru: `{"a":"x\ny"}` dá exit 5 — custou um falso alarme de "o hook emite JSON inválido", com o hook correto) → validar sempre com `printf '%s' "$x" | jq`. E o binário do seu shell pode não ser o do script (`grep` aqui é shim p/ `ugrep`, que dobra acento em TODO locale) → `command grep` ao reproduzir. Comandos pesados (test/build/typecheck/vitest) → prefixar **`heavy`** (semáforo de RAM da M2 8GB). → `worktrees.md`, `deploy.md`
- **Edge tem suíte PRÓPRIA (Deno) e ela BLOQUEIA o CI** (`test:edges`, step do `validate`) — `bun run test`/vitest cobre só `src/`+`scripts/`, então teste de edge quebrado passava VERDE até 2026-07-18. Roda com **`--no-remote`**: teste de edge **não pode ter import remoto** (`jsr:`/`npm:`) — senão o jsr.io entra no caminho de entrega de TODO PR. Precisa de dep? Extraia a lógica PURA e teste ela. Gate de CI **não se espelha por analogia**: o pin do bun tem gate porque o formato estrito ELIMINA um request; o do deno não tem, porque a `setup-deno` busca `dl.deno.land` em qualquer formato. → `docs/historico/ci-testes-edge-deno.md`
- **Manifesto de módulos:** arquivo NOVO em `src/` precisa de dono em `src/lib/modulos/manifesto.ts` (`codigo`/`testes`) — senão `manifesto.gate` falha no CI (órfão, falha SÓ no CI, não no typecheck/lint local). Teste que importa código de OUTRO módulo (ex.: `.test` sob glob de `plataforma` importando `loja-afiacao`) = vazamento de fronteira → co-localize fonte+teste no MESMO módulo, não registre na baseline. → `docs/historico/modularizacao.md`

## Merge (auto)

Todo PR não-draft **auto-mergeia (squash) quando o CI `validate` passa** (`.github/workflows/auto-merge.yml`, zero clique do founder). Para **segurar** um PR, deixe-o **DRAFT**. Nunca `gh pr merge --admin` de rotina (o auto-merge espera o verde — não bypassa o CI). **Ao criar/atualizar PR: arme `scripts/pr-watch.sh <nº>` em background** (Bash `run_in_background:true`) e, no desfecho, avise via PushNotification (mergeado/conflito/CI vermelho) — o founder não fica de poller. **Exit 6 ≠ 5:** 5 = consultei e o PR segue sem desfecho; **6 = NÃO consegui consultar** (rede/rate-limit/máquina dormindo) → estado DESCONHECIDO, confirme com `gh pr view <nº>` **antes** de avisar — reportar "não mergeou" num 6 é falso negativo (o #1396 tinha mergeado). A janela conta **vigília**, não relógio de parede (o tempo suspenso volta pro deadline) → watcher vivo além dos N min nominais é esperado, não travamento.

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
- Ação global (sincronizar/importar/recalcular/gerar): `useMutationComRegistro` + `<UltimaExecucao acao>` (`src/components/execucoes/`) — não `useMutation` cru; edge single-shot com cron registra server-side (`_shared/registro-execucao.ts`). **1 escritor por slug**; ação sobre UM registro: estado no próprio registro.
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
