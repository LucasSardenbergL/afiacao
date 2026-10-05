# Skills & MCPs — roteamento canônico (referência operacional)

> Caminho canônico por tarefa (muitas skills se sobrepõem — não escolher na sorte). O CLAUDE.md tem só o resumo. Atualizar esta tabela ao instalar/remover skill.

## Roteamento por tarefa

| Tarefa | Canônico | Nota / evitar |
|---|---|---|
| Revisar diff antes de mergear | **`/review`** (gstack) — SQL safety, trust boundary LLM, side effects condicionais | redundantes: `engineering:code-review`, superpowers review |
| Revisão de segurança | **`/security-review`** (oficial) | complementa `/review` — rode os dois em PR sensível |
| Review de segurança do DIFF com histórico git e raio de impacto (PR sensível: authz, money-path) | `differential-review:differential-review` (Trail of Bits) | chame PELO NOME — o gatilho colide com `/security-review`; complementa, não substitui |
| Caçar falha silenciosa num diff (erro engolido, `catch` vazio, fallback impróprio) | agente `silent-failure-hunter` (Anthropic — só o agente do `pr-review-toolkit`) | complementa `/review`; o plugin inteiro custaria ~1.600 tok/turno (6 agentes) |
| 3 vozes independentes sobre decisão de RISCO (PR crítico money-path/authz, tradeoff de arquitetura não-óbvio) | `triagem-3-modelos` (proprietária, global) — Claude (produto) + Codex (engenharia) + Gemini (triagem ampla) preenchem contrato JSON; decisão sai de REGRAS determinísticas, não de voto | degrau ACIMA do ritual `/codex`; NÃO p/ review simples (use `/review` ou `/codex`) |
| SAST profundo | `static-analysis:semgrep` (JS/TS rápido) / `static-analysis:codeql` (interprocedural) + `static-analysis:sarif-parsing` (Trail of Bits) | análise estática real (≠ heurístico) |
| Converter a assinatura grepável do `matar-classe` em regra Semgrep (2º eixo de gate no CI) | `semgrep-rule-creator:semgrep-rule-creator` (Trail of Bits) | precisa do binário `semgrep` (Mac: 1.168) |
| Auditoria TRIMESTRAL de defaults fail-open (segredo de fallback, debug ligado, cripto fraca, acesso permissivo) | `/insecure-defaults:audit` (Trail of Bits) | workflow multiagente com verificadores Opus — caro; NÃO conhece RLS (RLS → `/security-review` + `supabase`) |
| Invariantes de motor de dinheiro (property-based) | `property-based-testing:property-based-testing` (Trail of Bits) | traz `fast-check` — a devDependency entra em PR próprio |
| Auditar supply chain de DEPENDÊNCIA | `supply-chain-risk-auditor:supply-chain-risk-auditor` (Trail of Bits) | skill/plugin de terceiro → gate `skill-scanner` (§Skills stack-specific) |
| LGPD — gravação de chamadas WebRTC, mapa de dados pessoais, retenção/eliminação | `lgpd-audit` / `lgpd-data-mapping` / `lgpd-retention-erasure` (goul4rt, MIT) | só 3 das 19: fase que dependa de irmã ausente → ler no upstream pinado (`ORIGEM.txt` de cada uma); exemplos em Prisma/Better Auth → traduzir p/ Supabase/RLS. Domínio: `telefonia.md` |
| Debugar bug/falha | **`/investigate`** (gstack) — root-cause, 4 fases | `engineering:debug`/`systematic-debugging` (escolha 1) |
| Planejar feature multi-step | `writing-plans`→`executing-plans` (superpowers) | grande/arriscada → `/plan-eng-review`/`/autoplan` |
| Decidir se vale construir | `/office-hours` (gstack) | antes de `writing-plans` |
| Benchmark externo (link/PDF/case de concorrente) → programa de PRs | **`benchmark-externo`** (proprietária) — extrai práticas, varre `App.tsx`, tabela tem/parcial/gap com evidência `arquivo:linha` + persona cliente/staff, prioriza via Codex, programa em fases-PR | motor de origem de features; vem DEPOIS de `/office-hours` (vale construir?) e ANTES de `writing-plans`. ≠ `pesquisa-mercado-br`/`deep-research` (mercado amplo sem alvo no app) |
| Brainstorm | `brainstorming` (superpowers) | |
| Task Supabase (DB/Auth/Edge/RLS) | `supabase` (oficial) — SQL/RLS idiomático | |
| Mudança de banco sob Lovable | **`lovable-db-operator`** — migration + bloco SQL Editor + validação + audit | design com `supabase`, entrega com este |
| BI executivo / número de negócio via Lovable (brief da semana, vendas/estoque/inadimplência/margem) | **`bi-colacor`** (proprietária) — SQL read-only versionado p/ colar no Lovable→SQL Editor → interpreta → decisão; conhece as 4 grafias de empresa + confiabilidade do dado | leitura (≠ `lovable-db-operator`, que escreve); não `data:*`/`finance:*` (text-to-SQL sem nosso schema). Fechamento profundo (NCG/DRE-regime/tributário/contador) → `cfo-colacor` |
| Ritual de fechamento financeiro mensal / controladoria (NCG, DRE caixa-vs-competência, carga tributária por regime, projeção 13 semanas, perguntas pro contador) | **`cfo-colacor`** (proprietária) — SQL read-only p/ Lovable, ritual de 9 levas + relatório mensal + perguntas pro contador; **NÃO** apura imposto nem substitui contador | sobrepõe `bi-colacor` em inadimplência/caixa: número rápido/brief semanal → `bi-colacor`; fechamento profundo → esta. **Schema financeiro canônico mora na `bi-colacor`** (esta referencia, não duplica). Reforma CBS/IBS 2026, Simples e NF-e → `references/openaccountants-brasil.md` (ponteiro pinado para guias externos; rascunho SEM revisão de CRC) |
| Plano de ação SEMANAL da carteira de um vendedor televendas (rota/cidade/dia, clientes em queda, mix ausente, cross-sell por ramo) | `farmer-industrial` (proprietária) — plano acionável do vendedor a partir da carteira existente | ≠ `bi-colacor` (número pontual/brief); esta produz o PLANO do Farmer |
| Decidir SE/QUANTO/QUANDO comprar de fornecedor ponderando o CAIXA da Oben (comprar agora × segurar × parcelar × antecipar × priorizar A/B/C) | `reposicao-caixa` (proprietária) — memorando de decisão de compra | ≠ motor de reposição do app (quantidade técnica); ≠ `cfo-colacor` (fechamento) — esta decide a COMPRA à luz do capital de giro |
| Otimizar query/schema PG | `supabase-postgres-best-practices` | |
| Provar SQL money-path | **`prove-sql-money-path`** (PG17 falsificável) | |
| Diagnosticar sync/cron | **`diagnose-supabase-sync`** (8 passos + queries `psql-ro`) | |
| Verificar deploy Lovable | **`lovable-deploy-verify`** | |
| Perf React | `vercel-react-best-practices` | |
| Refatorar god-component | `vercel-composition-patterns` | |
| UI/acessibilidade WCAG | `vercel-web-design-guidelines` | |
| Superfície NOVA fora do app (landing, protótipo, artefato visual, peça de marketing) | `frontend-design` (oficial) — direção estética autoral: tipografia/paleta/motion/layout próprios | ⚠️ **NÃO** usar em tela do app: a skill manda escolher fonte e paleta próprias, layout assimétrico e "grid-breaking" — e o DS v3 é FIXO (tokens `src/index.css`, Geist/Newsreader, radius 6px, `--status-*`, densidade alta). Dentro do app → `vercel-web-design-guidelines` + `docs/visual-direction/` |
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
- **Memória entre sessões:** **`claude-mem`** — **DESLIGADO desde 2026-09-28** (`"claude-mem@thedotmack": false` em `enabledPlugins` do `~/.claude/settings.json`) até o upstream [thedotmack/claude-mem#4129](https://github.com/thedotmack/claude-mem/pull/4129) (autocura do worker surdo) entrar: 3 bloqueios de prompt em 23 dias, 0 observações em 13 dos 14 dias anteriores, contexto do SessionStart medido em 0 bytes. **O #4129 entrou (v13.29.0, 30/09), mas religar NÃO devolve a memória sozinho** — causa raiz em `docs/historico/claude-mem-worker-vivo-mas-surdo.md` §05/10: o shim não acha o binário desde o layout do app de 02/10, o `/login` dura 8 h (só o `claude` de terminal renova o token que o observador usa) e o desarme de 19/08 tirou o `PostToolUse` (observação só incidental, via resumo — o sensor precisaria contar resumos). Religar = os passos da §05/10 + `true` + reiniciar as sessões. **Enquanto desligado, o sensor do bloco 6 do vigia NÃO mede** (lê o `enabledPlugins`, com a precedência do Claude Code: `--resumo` mudo; `bun run claude-mem:saude` diz `DESLIGADO (enabledPlugins)`) — aviso sobre o claude-mem nessa situação não é acionável: não faça `/login` nem reanimar. Como era quando ligado: (plugin global; **o `/login` de 07/07 EXPIROU e a memória morreu calada: medido no banco em 2026-09-25, a última observação é de 2026-07-27, com 3.260 prompts gravados depois dela** — o health mede o worker, não a memória. **Sensor desde 2026-09-25:** o SessionStart (bloco 6 do `vigia-worktree.sh`) avisa quando o contador de falhas de hook > 0 ou quando há prompts gravados sem observação (`bun run claude-mem:saude` = o mesmo relatório à mão; sonda ausente = `NAO MEDI`, nunca ok). E o worker pode ficar VIVO-MAS-SURDO bloqueando prompts de toda sessão: **`bun run claude-mem:reanimar -- --so-olhar`** diagnostica sem tocar em nada; sem a flag, recupera com evidência positiva e confirmação (só mata processo do próprio claude-mem, após 3 sondas falhando) — histórico e o que o upstream corrigiu em `docs/historico/claude-mem-worker-vivo-mas-surdo.md`). Conserto original em 2 camadas: (1) o generator não achava o binário `claude` do app desktop — fix: shim `~/.claude-mem/claude-shim.sh` + `CLAUDE_CODE_PATH` em `~/.claude-mem/settings.json`; (2) o CLI headless não herda o login do app — resolvido com `/login` no CLI (se `Not logged in` (ou `OAuth session expired`) voltar: **Terminal do macOS** → `~/.local/bin/claude` (o shim quebrou em 02/10) → `/login` — o painel de terminal do app abre o menu mas NÃO recebe a escolha; religado assim em 2026-09-27, e a memória voltou a gravar no mesmo dia). Limitação conhecida: memória fragmentada por worktree (cada um é um `project` distinto). Auto-memory nativo segue **desligado de propósito** (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` no settings global) — não ligar os dois (duplicaria).

## Editar uma skill: a citação é conferida por gate; a cerca ```bash não

`.claude/skills/` **entra no `docs:citacoes`** desde 2026-08-31 — `ALVOS_VIVOS` é <!--alvos-vivos:inicio-->`CLAUDE.md`,
`docs/agent`, `docs/visual-direction`, `docs/runbooks` e `.claude/skills`<!--alvos-vivos:fim-->
(`scripts/docs-citacoes-gate-check.ts:130`<!--cita: ALVOS_VIVOS-->). ⇒ **Citar `arquivo:linha` numa
skill EXIGE a âncora** `<!--cita: <trecho literal da linha>-->`, e o trecho tem de ser substring
LITERAL da linha citada; sem ela o gate reprova com "não tem âncora" mesmo que o número esteja certo.
Falsificado em 2026-09-05 nos dois eixos, sabotando `lovable-deploy-verify/SKILL.md`: citação
quebrada → **exit 1**, contador 35→34; âncora removida → **exit 1**. Antes era o oposto — a MESMA
sabotagem passava com **exit 0 e sem mover o contador** (2026-08-30, #2130), e foi essa lacuna que
criou o alvo: ligar a pasta custou zero vermelho e a 1ª varredura já achou a única citação
`arquivo:linha` das 35 skills apontando para uma linha VAZIA (corrigida no #2137)
(`scripts/docs-citacoes-gate-check.ts:115`<!--cita: entrou em 2026-08-31-->).

⚠️ **O que segue descoberto na skill é a cerca ```bash** — o gate lê `arquivo:linha`, não executa a
cerca (`scripts/docs-citacoes-gate-check.ts:126`<!--cita: continua descoberto-->). Verde ali é
ausência de dado, não aprovação. Mesma família de `docs/historico/gates-textuais-cegos.md`, por
ESCOPO DE VARREDURA em vez de stripper — e o custo é maior do que parece, porque a skill é justamente
onde o próximo agente vai buscar o comando pronto para copiar.

### Gate de cercas ```bash — medido e RECUSADO como lint (2026-08-31)

O `docs:citacoes` acima lê `arquivo:linha`; **não olha o que a cerca FAZ**. Foi por aí que um
`grep -E '^\+.*from "\.\.'` cego a `from "./x.ts"` atravessou o #2127 e só caiu na auditoria à mão
do #2136. A pergunta seguinte — "então instale um lint nas cercas" — foi MEDIDA nas 35 cercas das 9
skills, e a resposta é não:

| candidato | achados | defeitos reais |
|---|---|---|
| `bash -n` (sintaxe) | 1 | **0** |
| `shellcheck -S warning` | 7 | **0** |

Os 8 achados são **ruído do placeholder `<x>`**, que o bash lê como redirect (`<edge>`, `<saida.md>`):
neutralizando `<x>`→`PH_x`, ambos vão a **zero**. Ou seja, ligar qualquer um dos dois reprovaria 7
cercas sadias e pegaria defeito nenhum — e nenhum dos dois alcança erro **semântico**, que é a classe
que de fato machuca, porque um regex furado é sintaticamente perfeito.

⇒ **Não instale lint de shell sobre cerca de skill.** O que pegaria é a cerca EXECUTADA contra
fixture: **22 das 35 são puras** (texto/`git`, sem rede nem banco — a do #2127 entre elas), então o
denominador existe. Critério do "pura", para o número ser reproduzível: nenhuma POSIÇÃO DE COMANDO
(início de linha ou depois de `|`/`;`/`&`) casa `psql|gh|curl|npx|supabase|bun|npm|deno|docker|ssh|
nohup|~/.config` — o wrapper `~/.config/afiacao/psql-ro` conta como banco, e esquecê-lo devolve 27. Mas isso é mecanismo novo (anotação + fixture + runner), não configuração — e
enquanto não existir, a cerca de skill se confere **à mão** — ao contrário da citação `arquivo:linha`, que o gate já cobre.

⚠️ Ao contar cercas por natureza, filtre o COMANDO, não a substring: `supabase` casa o caminho
`supabase/functions/` e classifica como "toca o banco" justamente a cerca de `git`/`grep` que é o
caso mais testável. Mordido ao montar esta tabela — 12/23 virou 22/13 depois do conserto.

## Skills stack-specific

**Cópias em `~/.claude/skills/`** — pastas SEM `.git`, logo **sem proveniência** (só dá para datar por hash de conteúdo contra o upstream; atualizar = recopiar): Supabase oficial · Vercel Eng (react/composition/web-design) · TanStack Query · Sentry (`sentry-react-sdk` só via router `sentry-sdk-setup`) · RBAC.

**Pinadas (estado de 2026-09-27)** — nada aqui se atualiza sozinho; atualizar = decisão + gate:

| o quê | onde | pin |
|---|---|---|
| Trail of Bits: `static-analysis` 1.4.5 · `supply-chain-risk-auditor` 2.0.4 · `differential-review` 1.1.4 · `semgrep-rule-creator` 1.2.6 · `insecure-defaults` 2.0.3 · `property-based-testing` 1.2.2 | marketplace `trailofbits` = **diretório** `~/.claude/marketplaces-pinados/trailofbits`, com `autoUpdate: false` em `extraKnownMarketplaces` do `~/.claude/settings.json` | HEAD destacado em `0cc1c73` (2026-09-24, já com o fix #250 do semgrep) |
| superpowers 6.4.1 | plugin do `claude-plugins-official` | o sha que o marketplace oficial pina |
| gstack (a `VERSION` do clone; 1.91.2.0 em 2026-09-27) | clone git em `~/.claude/skills/gstack` | preparo semanal no launchd + "aplica o upgrade do gstack" (bullet abaixo) |
| agente `silent-failure-hunter` | `~/.claude/agents/` (verbatim) + `ORIGEM-silent-failure-hunter.txt` | `anthropics/claude-plugins-official@4ca561f` |
| `lgpd-audit` · `lgpd-data-mapping` · `lgpd-retention-erasure` | `~/.claude/skills/` + `LICENSE` + `ORIGEM.txt` | `goul4rt/lgpd-skills@d85d79a` |
| guias fiscais OpenAccountants | ponteiro no repo: `.claude/skills/cfo-colacor/references/openaccountants-brasil.md` (texto NÃO copiado — o repo é público) | `openaccountants@2338bb0c` |

- **Por que diretório, e não `marketplace add owner/repo#sha`:** o `#ref` vira `git clone --branch`, que não aceita sha ("Remote branch … not found"), e a ToB não tem tags. Sem pin, todo `plugin install X@trailofbits` atualiza o marketplace antes de instalar. Atualizar: `git -C ~/.claude/marketplaces-pinados/trailofbits fetch` → `checkout --detach <sha>` → gate abaixo → `claude plugin marketplace update trailofbits` → `claude plugin update <plugin>@trailofbits`.
- ⚠️ **`static-analysis` 1.4.5: o `run-scans.sh` tem 2 cegueiras que o fix #250 NÃO fechou** (medido 2026-09-27). (1) Expande o glob do `--include` contra o **CWD**: da raiz do repo, os rulesets JS/TS escaneiam **3 de 1.701 `.ts`** sem sinal nenhum, e o workflow `/static-analysis:semgrep-scan` herda o bug. Rode com `cd "$(mktemp -d)"` antes. Upstream: [trailofbits/skills#297](https://github.com/trailofbits/skills/issues/297), sem merge em `0cc1c73`; ao atualizar o pin, confira se o `set -f` entrou. (2) No semgrep 1.168, regra que não compila sai `warn` com **exit 0**, então `partial:false` não prova nada; a prova de carga é `tool.driver.rules` do SARIF × `semgrep --validate`. `p/yaml` do catálogo dá 404 (use `r/yaml`). Detalhe: [varredura-semgrep-2026-09-27.md](../historico/varredura-semgrep-2026-09-27.md).
- **Gate de supply chain, ANTES de instalar OU atualizar:** `uv tool install 'cisco-ai-skill-scanner==2.1.0'` e só os analisadores offline — `skill-scanner scan-all <dir> --recursive --use-behavioral --use-trigger --format json` (sem `--use-llm`, `--enable-meta`, `--adjudicate`, `--use-virustotal`, `--use-aidefense`, `--use-osv`) — e leia `hooks/hooks.json` + `scripts/` à mão. Em skill de segurança o CRITICAL costuma ser o próprio assunto (exemplo vulnerável na doc, harness de teste): trie POR ARQUIVO. Em atualização, escaneie também a versão instalada e revise só o DELTA (gstack 1.69→1.91: 1.932 → 1.498 achados, 415 novos, nenhum em código que dispara sozinho).
- **gstack: o upgrade é PREPARADO fora da sessão e APLICADO a pedido (2026-09-29).** O `auto_upgrade` e o `update_check` do gstack estão DESLIGADOS: dentro da sessão o classificador do modo auto barra o `git pull` + `./setup` (`[Code from External]`, ordem vinda de saída de ferramenta), e fora dela aplicar às cegas furaria o gate acima. O LaunchAgent `com.lucas.gstack-upgrade` (domingo 10h) roda `~/.gstack/auto-upgrade/atualizar-gstack.sh`, cópia de `scripts/gstack-auto-upgrade.sh` (instalar ou reinstalar depois de mudar o script: `bash scripts/gstack-auto-upgrade-instalar.sh`). Havendo versão nova, ele prepara o gate sozinho (scanner offline nas duas versões, delta, diff do que dispara sozinho) em `~/.gstack/auto-upgrade/revisao.md`, e o `vigia-gstack.sh` avisa 1x por dia. Quando o Lucas disser "aplica o upgrade do gstack": leia a revisão, dê o veredito do gate e rode, em background, `bash ~/.gstack/auto-upgrade/atualizar-gstack.sh --aplicar <alvo>`, que instala EXATAMENTE o sha revisado. Revisão com **GATE INCOMPLETO** (o scanner não rodou): o `--aplicar` recusa, e o remédio é refazer o preparo (o mesmo comando, sem `--aplicar`). Estado: `~/.gstack/auto-upgrade/status` e `log`. Registro: [gstack-upgrade-fora-da-sessao.md](../historico/gstack-upgrade-fora-da-sessao.md).
- **Custo antes de instalar:** `claude --plugin-dir <caminho> plugin details <nome>` projeta o custo sempre-ligado (o `pr-review-toolkit` inteiro dava ~1.600 tok/turno → entrou só 1 agente).
- **Sensor da listagem:** o `/skill-doctor` roda headless — `<binário do app> -p "/skill-doctor" < /dev/null` (comando local: não gasta API nem exige login). Coluna `context`: `-` = fora da listagem; `< 20` = só o nome, sem descrição.
- ⚠️ **Sessão do app desktop NÃO dispara o auto-update de plugin** (ele só roda em sessão interativa, após a 1ª mensagem): o superpowers ficou na 6.1.1 de 07/07 a 27/09. Plugin do marketplace oficial se atualiza à mão — `claude plugin marketplace update claude-plugins-official` → `claude plugin update <p>@claude-plugins-official`.
- ⚠️ **O `claude` do PATH só se atualiza quando roda** (`~/.local/bin/claude`, instalador nativo: ficou na 2.1.202 de 07/07 a 27/09; 2.1.283 desde então) e pode estar com o login vencido: na dúvida, use o binário do app, `~/Library/Application Support/Claude/claude-code/<versão>/<hash>/claude.app/Contents/MacOS/claude` (layout desde 02/10 — **o shim `~/.claude-mem/claude-shim.sh` ainda procura o layout antigo e sai 127**).
- **`skillOverrides` do `.claude/settings.json`:** 51 skills de terceiros nunca usadas (marketing, Adobe, mídia, Sentry) em `user-invocable-only` — continuam em `/nome` — e `frontend-design` + `context-restore` em `name-only` (o roteamento manda evitá-las; sem isso ganhavam descrição). Critério e medição: `docs/historico/piso-de-contexto.md` (2026-09-27). Skill de PLUGIN não aceita override — só desligando o plugin.

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
