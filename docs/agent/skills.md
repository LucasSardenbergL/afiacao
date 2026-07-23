# Skills & MCPs — roteamento canônico (referência operacional)

> Caminho canônico por tarefa (muitas skills se sobrepõem — não escolher na sorte). O CLAUDE.md tem só o resumo. Atualizar esta tabela ao instalar/remover skill.

## Roteamento por tarefa

| Tarefa | Canônico | Nota / evitar |
|---|---|---|
| Revisar diff antes de mergear | **`/review`** (gstack) — SQL safety, trust boundary LLM, side effects condicionais | redundantes: `engineering:code-review`, superpowers review |
| Revisão de segurança | **`/security-review`** (oficial) | complementa `/review` — rode os dois em PR sensível |
| 3 vozes independentes sobre decisão de RISCO (PR crítico money-path/authz, tradeoff de arquitetura não-óbvio) | `triagem-3-modelos` (proprietária, global) — Claude (produto) + Codex (engenharia) + Gemini (triagem ampla) preenchem contrato JSON; decisão sai de REGRAS determinísticas, não de voto | degrau ACIMA do ritual `/codex`; NÃO p/ review simples (use `/review` ou `/codex`) |
| SAST profundo | `semgrep` (JS/TS rápido) / `codeql` (interprocedural) + `sarif-parsing` | análise estática real (≠ heurístico) |
| Auditar supply chain | `supply-chain-risk-auditor` (Trail of Bits) | |
| Debugar bug/falha | **`/investigate`** (gstack) — root-cause, 4 fases | `engineering:debug`/`systematic-debugging` (escolha 1) |
| Planejar feature multi-step | `writing-plans`→`executing-plans` (superpowers) | grande/arriscada → `/plan-eng-review`/`/autoplan` |
| Decidir se vale construir | `/office-hours` (gstack) | antes de `writing-plans` |
| Benchmark externo (link/PDF/case de concorrente) → programa de PRs | **`benchmark-externo`** (proprietária) — extrai práticas, varre `App.tsx`, tabela tem/parcial/gap com evidência `arquivo:linha` + persona cliente/staff, prioriza via Codex, programa em fases-PR | motor de origem de features; vem DEPOIS de `/office-hours` (vale construir?) e ANTES de `writing-plans`. ≠ `pesquisa-mercado-br`/`deep-research` (mercado amplo sem alvo no app) |
| Brainstorm | `brainstorming` (superpowers) | |
| Task Supabase (DB/Auth/Edge/RLS) | `supabase` (oficial) — SQL/RLS idiomático | |
| Mudança de banco sob Lovable | **`lovable-db-operator`** — migration + bloco SQL Editor + validação + audit | design com `supabase`, entrega com este |
| BI executivo / número de negócio via Lovable (brief da semana, vendas/estoque/inadimplência/margem) | **`bi-colacor`** (proprietária) — SQL read-only versionado p/ colar no Lovable→SQL Editor → interpreta → decisão; conhece as 4 grafias de empresa + confiabilidade do dado | leitura (≠ `lovable-db-operator`, que escreve); não `data:*`/`finance:*` (text-to-SQL sem nosso schema). Fechamento profundo (NCG/DRE-regime/tributário/contador) → `cfo-colacor` |
| Ritual de fechamento financeiro mensal / controladoria (NCG, DRE caixa-vs-competência, carga tributária por regime, projeção 13 semanas, perguntas pro contador) | **`cfo-colacor`** (proprietária) — SQL read-only p/ Lovable, ritual de 9 levas + relatório mensal + perguntas pro contador; **NÃO** apura imposto nem substitui contador | sobrepõe `bi-colacor` em inadimplência/caixa: número rápido/brief semanal → `bi-colacor`; fechamento profundo → esta. **Schema financeiro canônico mora na `bi-colacor`** (esta referencia, não duplica) |
| Plano de ação SEMANAL da carteira de um vendedor televendas (rota/cidade/dia, clientes em queda, mix ausente, cross-sell por ramo) | `farmer-industrial` (proprietária) — plano acionável do vendedor a partir da carteira existente | ≠ `bi-colacor` (número pontual/brief); esta produz o PLANO do Farmer |
| Decidir SE/QUANTO/QUANDO comprar de fornecedor ponderando o CAIXA da Oben (comprar agora × segurar × parcelar × antecipar × priorizar A/B/C) | `reposicao-caixa` (proprietária) — memorando de decisão de compra | ≠ motor de reposição do app (quantidade técnica); ≠ `cfo-colacor` (fechamento) — esta decide a COMPRA à luz do capital de giro |
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
| Corrigiu bug que é INSTÂNCIA de padrão repetível ("Nº laço", fix quase idêntico a anterior, série no git log) | **`matar-classe`** (proprietária) — passo 0 do PR de bugfix (instância ou classe?); assinatura grepável → varredura do repo INTEIRO → erradicação → gate estrutural falsificado → registro | nasce do catálogo de retrabalho 2026-07 (paginação: ~20 PRs da MESMA classe). Fix pontual pode sair 1º; varredura+gate na MESMA sessão ou chip com dono |
| Fechar sessão ("posso excluir?") | **`/fecho`** (proprietária) — PRs×CI, migrations×psql-ro, edges/Publish, chips, wt:status | veredito por EVIDÊNCIA, não memória |
| Continuar em sessão nova / split no 2º compact | **`/handoff-sessao`** (proprietária) — briefing determinístico, 1 entrega = 1 sessão | não usar `/context-restore` (pode pegar save de OUTRA sessão) |
| Objetivo multi-sessão ("continua o goal", "retoma o épico", entrega que atravessa várias sessões/PRs) | `goal` (proprietária) | complementa `/handoff-sessao` (contexto) e `/fecho` (encerramento); entrega de sessão única → roadmap no chat, sem goal |
| Ingerir CSV de base pública BR (RAIS/CNO/Receita/CNPJ) com DuckDB | receituário **`docs/agent/csv-governo-br.md`** | encoding CP1252/latin-1 + `delim=';'` + `quote=''` + `parallel=false` + `all_varchar` |

- ⚠️ **Colisão de nome:** `/review` (gstack, **canônico**) vs `review` (oficial code-review) — invocar via gstack.
- **Memória entre sessões:** **`claude-mem`** (plugin global ATIVO — **funcionando desde 2026-07-07**; 0 → 214 observações na 1ª hora). Conserto em 2 camadas: (1) o generator não achava o binário `claude` do app desktop — fix: shim `~/.claude-mem/claude-shim.sh` + `CLAUDE_CODE_PATH` em `~/.claude-mem/settings.json`; (2) o CLI headless não herda o login do app — resolvido com `/login` no CLI (se `Not logged in` voltar: terminal → `~/.claude-mem/claude-shim.sh` → `/login`). Limitação conhecida: memória fragmentada por worktree (cada um é um `project` distinto). Auto-memory nativo segue **desligado de propósito** (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` no settings global) — não ligar os dois (duplicaria).

## Skills stack-specific

Instaladas via `git clone` dos repos oficiais em `~/.claude/skills/` (sem auto-update — re-clonar pra atualizar): Supabase oficial · Vercel Eng (react/composition/web-design) · TanStack Query · Sentry (`sentry-react-sdk` só via router `sentry-sdk-setup`) · Trail of Bits (semgrep/codeql/sarif/supply-chain) · RBAC.

## MCPs conectados

- **Serena** (`mcp__plugin_serena_serena__*`) — análise **semântica via LSP**. Use **pontual** pra "**quem consome X?**" antes de mexer em algo com muitos consumidores (`find_referencing_symbols`/`find_symbol`). Melhor que grep (sem ruído de substring/comentário). ⚠️ LSP indexa a frio → o **1º símbolo costuma dar `TimeoutError`** (passe `relative_path` exato achado com `grep -rln`; pule o onboarding). **Desabilitada por padrão** na M2 (LSP pesado) — religar pontual em `.claude/settings.local.json` + `/reload-plugins`.
- **Context7** (`mcp__plugin_context7_context7__*`) — docs de lib de terceiro atualizadas em runtime (cutoff jan/2026). Fica LIGADA (remota/leve). Para API Claude/Anthropic use a skill `claude-api`.

## Codex (2ª opinião do founder)

Comandos, cota Plus (janela rolante de 7d que esgota) e o fallback "Caminho B" em `docs/agent/money-path.md`. Preferência: em decisão de arquitetura/metodologia não-óbvia e SEMPRE no money-path, eu proponho e conduzo `/codex` (consult/challenge) — sem o founder copiar/colar. **Transporte sempre assíncrono: `scripts/codex-async.sh`** (background, preflight de auth, retry, hard-stop) — a skill `/codex` carrega o ritual 1× por sessão; as consultas seguintes vão direto pelo script.

## Aliases de voz (ditado do founder)

O Lucas dita por voz; o ASR erra nomes recorrentes — decodifique de primeira em vez de tratar como termo novo:

| Ouço/leio no ditado | É |
|---|---|
| Kota · code · "code x" | **Codex** |
| geminar | **Gemini** |
| auto-munch · auto-murder | **auto-merge** |

Cresce conforme novos aparecerem (é o loop instrução-ditada → doc do CLAUDE.md).
