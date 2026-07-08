# Worktrees, multi-sessão & RAM/Node (referência operacional)

> Regras de isolamento + higiene de RAM na M2 8GB. O CLAUDE.md tem só o resumo. Scripts em `scripts/wt-*.sh`.

## Uma sessão Claude por working tree (regra)

- Cada sessão no **seu próprio worktree**. **NUNCA** 2 sessões no diretório principal (`/Users/lucassardenberg/Projetos/afiacao`) — compartilham o checkout, e o `git checkout`/troca de branch de uma **vaza** pra outra (branch-flip silencioso → commit no lugar errado, **risco de perda**).
- Worktrees de `.claude/worktrees/*` (criados pelo Claude Code) isolam automático. Helper: `bun run wt <branch> [base]` (`scripts/new-worktree.sh`, sibling `../afiacao-<branch>` a partir de `origin/main`).
- Rede de segurança: hook global `~/.claude/hooks/concurrent-session-guard.sh` (SessionStart) **avisa** 2ª sessão no principal (worktrees isentas).
- ⚠️ **Antes de tocar arquivo/função QUENTE:** `origin/main` atualizado + `gh pr list` + checar migrations de sessões paralelas. Colisão de migration agora tem rede automática — ver "Colisão de migration multi-sessão" abaixo.
- ⚠️ **PR DRAFT parado em domínio QUENTE envelhece:** segurar um PR money-path em draft (gate humano) enquanto sessões paralelas avançam o MESMO domínio pode torná-lo redundante + caro (N rebases num alvo móvel). Antes de **retomar/reabrir** um PR parado — não só ao criá-lo — rechecar `gh pr list` + commits do domínio em `origin/main`; se o núcleo já mergeou, **fechar > reconciliar** (evita sinal/detector duplicado no mesmo helper). Caso real: #959 (`custo_proxy` do cockpit) suplantado em ~1 dia por #1003 (confiança por custo proxy) + #977 (lavagem de proveniência) — fechado, não reconciliado.
- ⚠️ **Chips/sessões paralelas no MESMO follow-up = retrabalho em domínio quente.** 2 chips do mesmo escopo (ou um chip rodando em paralelo a uma sessão inline já no tema) → PRs concorrentes no mesmo helper; o 1º a auto-mergear vence, o 2º fica redundante na parte sobreposta. **Deduplicar/encerrar chips do mesmo escopo ANTES de iniciar** (a sessão que já tem o contexto faz inline); se já colidiu, **fechar > reconciliar salvando só o DIFERENCIAL** num PR enxuto sobre o vencedor. Caso real (2026-06-24): folga ao hurdle do A3 — #1049 (contagem de quase-frágeis) mergeou 1º; #1056 (contagem + `min_folga`) virou redundante na contagem → fechado e reaberto como #1058 (só `min_folga_positiva_pp`, o diferencial) sobre o #1049.
- ⚠️ **Não recommitar em branch já squash-mergeada.** Depois que o auto-merge faz **squash** do PR, a origin/main ganha 1 commit novo que NÃO é ancestral dos commits locais da branch; continuar commitando/amendando ali recria trabalho já mergeado (quase-acidente que mordeu 2× no diagnóstico 2026-07). Padrão certo: **branch/worktree NOVO** pro follow-up. Rede automática: hook `.claude/hooks/branch-pos-squash-guard.sh` (PreToolUse Bash) **AVISA** (não nega, via `additionalContext` — o modelo lê e reconsidera) quando `git commit`/`--amend` roda numa branch com commits fora de `origin/main` **e** PR já `MERGED` (`gh`, resultado em cache curto por repo+branch pra não custar em todo commit). Fail-open total (sem `gh`/`jq`/`git`, rede fora, ou erro → no-op). Testes: `scripts/test-branch-pos-squash-guard.sh` (stub git+gh + falsificação por inversão do veredito).

## Execução: inline vs subagente (Task)

- **Implementação money-path complexa (TDD + PG17 + edição multi-arquivo) → o controller executa INLINE**, não via subagente implementador. Repetido neste repo: subagentes-implementadores **divergem do pedido central** e exigem retrabalho (pularam a carteira-da-cidade que era o pedido central; removeram o `digitosCnae` que o plano pedia). O fio da disciplina por-task (TDD → PG17 → commit) o controller segura melhor mantendo o contexto.
- **Leitura/varredura/análise read-only delega BEM** — a janela própria do subagente poupa a do controller (varrer N arquivos e devolver só a conclusão, mapear consumidores de uma função, auditar um diretório). O thrash é na ESCRITA complexa, não na leitura.

## Colisão de migration multi-sessão (`wt:preflight` + hook)

Duas worktrees podem criar migrations que recriam o **mesmo objeto** SQL (função/view/trigger/policy). Como o apply é manual no SQL Editor, "a última a rodar vence" sobrescreve a outra **silenciosamente** (`database.md` §2). Três camadas, todas reusando `scripts/lib/migration-objects.ts` (o mesmo extrator do `audit:migrations`):

- **Comando** — `bun run wt:preflight supabase/migrations/<arq>.sql` (worktrees locais; `--full` agrega `origin/main`). Diz qual objeto colide e se a concorrente está **em voo** (não-commitada → 🔴 concorrência real) ou **já no histórico** (🟡 evolução serial, inócuo). Timestamp colidido com objetos distintos = 🟡 informativo. `function`/`view`/`trigger`/`rls_policy` = perigoso; `table`/`index`/`enum`/`cron` (`IF NOT EXISTS`/aditivo) = 🟡.
- **Hook** — `.claude/hooks/migration-collision-guard.sh` (PreToolUse Write/Edit em `supabase/migrations/*.sql`): roda o preflight local e **nega** só no 🔴. Fail-open (sem `bun`/`jq`/erro → no-op). Espelha o `heavy-guard` (exit 0 + JSON `permissionDecision:"deny"`).
- **Gate de apply** — Passo 2.5 da skill `lovable-db-operator`: roda o preflight antes de entregar o bloco do SQL Editor. É o chokepoint — pega qualquer caminho de criação (Write, Edit, heredoc), inclusive os que o hook não vê.

Limite conhecido (fase 1): não pega a *race fria* (duas sessões, nenhum arquivo escrito ainda), nem `ALTER TABLE`/`DROP+CREATE`. Testes: `scripts/test-migration-objects.ts` · `scripts/test-preflight-migration.sh` · `scripts/test-migration-collision-guard.sh`.

## Higiene de RAM/Node (M2 8GB satura; **swap em uso = RAM cheia**)

| Comando | O quê (todos DRY-RUN por padrão; `--yes` executa) |
|---|---|
| `bun run wt:status` | raio-X **read-only**: RAM/swap/disco/total node_modules/sessões `claude` vivas/top-RSS |
| `bun run wt:clean` | apaga `node_modules` de worktrees **PARADOS** (~580 MB cada; pula atual/vivo/locked; rename atômico; reversível com `bun install`). `--include-current` ao fechar a sessão |
| `bun run wt:reap` | mata `vitest`/`esbuild` **órfãos** (RAM presa em processo, não em node_modules) |
| `bun run wt:prune` | remove worktree cuja **CONVERSA foi excluída** + trabalho 100% salvo (HEAD ancestral de origin/main OU PR mergeado == HEAD); `git fetch` obrigatório; **nunca `--force`**; não apaga a branch |
| `bun run wt:map` / `wt:label "<assunto>"` | lista worktrees com o assunto da sessão (▸atual ●viva ○parada) |

- **Worktree nasce pronto:** `bun run wt` roda `bun install` na criação; para worktree criado pelo app (`.claude/worktrees/*`), o hook `vigia-worktree.sh` (SessionStart) dispara `bun install` em background e avisa a sessão. ⚠️ **typecheck vermelho com `Cannot find module`/dep `@lovable/*` ausente = deps não instaladas, NÃO é CI vermelho** — o CI real se confere com `gh pr checks`. O mesmo hook alerta swap alto (>6GB) e >6 sessões Claude vivas — a alavanca real de RAM é FECHAR sessões (`wt:clean` num parque de sessões vivas libera 0MB).
- **Ritual de fecho** (gatilho "posso excluir a sessão?"): skill **`/fecho`** — PRs mergeados de verdade (gh), migrations aplicadas (psql-ro), edges/Publish, chips, resumo padrão, `wt:status` + ofertas de limpeza.

## `heavy` (semáforo de RAM)

Prefixe comandos PESADOS (test/build/typecheck/vitest) com **`heavy`** (`~/.local/bin/heavy`, fonte `scripts/heavy.sh`) — limita quantos rodam ao mesmo tempo entre TODOS os worktrees (auto-dimensiona; 1 slot na M2 8GB). Override `AFIACAO_MAX_HEAVY=N`. Hook `heavy-guard` (PreToolUse Bash, `.claude/hooks/heavy-guard.sh`) **REESCREVE** test/build/typecheck sem `heavy` (updatedInput prefixa o semáforo — sem round-trip de negação nem classificador; fail-safe: não age sem `heavy` instalado nem em leitura; testes `scripts/test-heavy-guard.sh`). Comando LONGO (codex, verify por bytes, build grande) → `timeout: 600000` no Bash tool — o default de 2min mata no meio (35 mortes por exit 143 no diagnóstico 2026-07).

## MCPs enxutas

`.claude/settings.json` (comitado, **project > user**) desabilita 11 plugins sem uso no dev TS (adobe/mercadopago/sentry/slack/telegram/airtable/zapier/github/posthog/chrome-devtools/serena) + `ENABLE_CLAUDEAI_MCP_SERVERS=false`. **Mantidos:** superpowers/claude-mem/claude-md-management/context7. Religar pontual em `.claude/settings.local.json` (gitignored, precedência maior) + `/reload-plugins`. ⚠️ Desabilitar o **plugin** mata MCP **+ skills + hooks** dele. Worktrees criados via `bun run wt` (de `origin/main`) já nascem enxutos.
