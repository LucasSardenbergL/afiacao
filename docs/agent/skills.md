# Skills & MCPs — roteamento canônico (referência operacional)

> Caminho canônico por tarefa (muitas skills se sobrepõem — não escolher na sorte). O CLAUDE.md tem só o resumo. Atualizar esta tabela ao instalar/remover skill.

## Roteamento por tarefa

| Tarefa | Canônico | Nota / evitar |
|---|---|---|
| Revisar diff antes de mergear | **`/review`** (gstack) — SQL safety, trust boundary LLM, side effects condicionais | redundantes: `engineering:code-review`, superpowers review |
| Revisão de segurança | **`/security-review`** (oficial) | complementa `/review` — rode os dois em PR sensível |
| SAST profundo | `semgrep` (JS/TS rápido) / `codeql` (interprocedural) + `sarif-parsing` | análise estática real (≠ heurístico) |
| Auditar supply chain | `supply-chain-risk-auditor` (Trail of Bits) | |
| Debugar bug/falha | **`/investigate`** (gstack) — root-cause, 4 fases | `engineering:debug`/`systematic-debugging` (escolha 1) |
| Planejar feature multi-step | `writing-plans`→`executing-plans` (superpowers) | grande/arriscada → `/plan-eng-review`/`/autoplan` |
| Decidir se vale construir | `/office-hours` (gstack) | antes de `writing-plans` |
| Brainstorm | `brainstorming` (superpowers) | |
| Task Supabase (DB/Auth/Edge/RLS) | `supabase` (oficial) — SQL/RLS idiomático | |
| Mudança de banco sob Lovable | **`lovable-db-operator`** — migration + bloco SQL Editor + validação + audit | design com `supabase`, entrega com este |
| Otimizar query/schema PG | `supabase-postgres-best-practices` | |
| Provar SQL money-path | **`prove-sql-money-path`** (PG17 falsificável) | |
| Diagnosticar sync/cron | **`diagnose-supabase-sync`** (8 passos + queries `psql-ro`) | |
| Verificar deploy Lovable | **`lovable-deploy-verify`** | |
| Perf React | `vercel-react-best-practices` | |
| Refatorar god-component | `vercel-composition-patterns` | |
| UI/acessibilidade WCAG | `vercel-web-design-guidelines` | |
| Optimistic UI / React Query | `tanstack-query` | receitas `onMutate`/rollback |
| RBAC / personas→roles | `access-control-rbac` | |
| QA da app rodando | `/qa` (report+fix) / `/qa-only` (report) — gstack | |
| Navegar/testar no browser | **`/browse`** (gstack) | não `mcp__Claude_in_Chrome__*` |
| TDD ao escrever | `test-driven-development` (superpowers) | |

- ⚠️ **Colisão de nome:** `/review` (gstack, **canônico**) vs `review` (oficial code-review) — invocar via gstack.
- **Memória entre sessões:** auto-memory nativo. `claude-mem` instalado mas **DESATIVADO de propósito** (não reativar — duplicaria).

## Skills stack-specific

Instaladas via `git clone` dos repos oficiais em `~/.claude/skills/` (sem auto-update — re-clonar pra atualizar): Supabase oficial · Vercel Eng (react/composition/web-design) · TanStack Query · Sentry (`sentry-react-sdk` só via router `sentry-sdk-setup`) · Trail of Bits (semgrep/codeql/sarif/supply-chain) · RBAC.

## MCPs conectados

- **Serena** (`mcp__plugin_serena_serena__*`) — análise **semântica via LSP**. Use **pontual** pra "**quem consome X?**" antes de mexer em algo com muitos consumidores (`find_referencing_symbols`/`find_symbol`). Melhor que grep (sem ruído de substring/comentário). ⚠️ LSP indexa a frio → o **1º símbolo costuma dar `TimeoutError`** (passe `relative_path` exato achado com `grep -rln`; pule o onboarding). **Desabilitada por padrão** na M2 (LSP pesado) — religar pontual em `.claude/settings.local.json` + `/reload-plugins`.
- **Context7** (`mcp__plugin_context7_context7__*`) — docs de lib de terceiro atualizadas em runtime (cutoff jan/2026). Fica LIGADA (remota/leve). Para API Claude/Anthropic use a skill `claude-api`.

## Codex (2ª opinião do founder)

Comandos, cota Plus (janela rolante de 7d que esgota) e o fallback "Caminho B" em `docs/agent/money-path.md`. Preferência: em decisão de arquitetura/metodologia não-óbvia e SEMPRE no money-path, eu proponho e conduzo `/codex` (consult/challenge) — sem o founder copiar/colar.
