# Worktrees, multi-sessão & RAM/Node (referência operacional)

> Regras de isolamento + higiene de RAM na M2 8GB. O CLAUDE.md tem só o resumo. Scripts em `scripts/wt-*.sh`.

## Uma sessão Claude por working tree (regra)

- Cada sessão no **seu próprio worktree**. **NUNCA** 2 sessões no diretório principal (`/Users/lucassardenberg/Projetos/afiacao`) — compartilham o checkout, e o `git checkout`/troca de branch de uma **vaza** pra outra (branch-flip silencioso → commit no lugar errado, **risco de perda**).
- Worktrees de `.claude/worktrees/*` (criados pelo Claude Code) isolam automático. Helper: `bun run wt <branch> [base]` (`scripts/new-worktree.sh`, sibling `../afiacao-<branch>` a partir de `origin/main`).
- Rede de segurança: hook global `~/.claude/hooks/concurrent-session-guard.sh` (SessionStart) **avisa** 2ª sessão no principal (worktrees isentas).
- ⚠️ **Antes de tocar arquivo/função QUENTE:** `origin/main` atualizado + `gh pr list` + checar migrations de sessões paralelas (timestamp de migration colidido é o aviso).

## Higiene de RAM/Node (M2 8GB satura; **swap em uso = RAM cheia**)

| Comando | O quê (todos DRY-RUN por padrão; `--yes` executa) |
|---|---|
| `bun run wt:status` | raio-X **read-only**: RAM/swap/disco/total node_modules/sessões `claude` vivas/top-RSS |
| `bun run wt:clean` | apaga `node_modules` de worktrees **PARADOS** (~580 MB cada; pula atual/vivo/locked; rename atômico; reversível com `bun install`). `--include-current` ao fechar a sessão |
| `bun run wt:reap` | mata `vitest`/`esbuild` **órfãos** (RAM presa em processo, não em node_modules) |
| `bun run wt:prune` | remove worktree cuja **CONVERSA foi excluída** + trabalho 100% salvo (HEAD ancestral de origin/main OU PR mergeado == HEAD); `git fetch` obrigatório; **nunca `--force`**; não apaga a branch |
| `bun run wt:map` / `wt:label "<assunto>"` | lista worktrees com o assunto da sessão (▸atual ●viva ○parada) |

- **Numa sessão Claude EU rodo `bun install` automaticamente** ao detectar `node_modules` limpo (antes do 1º test/build/typecheck/dev) — o founder nunca roda à mão.
- **Ritual de fecho** (gatilho "posso excluir a sessão?"): resumo de fecho + `wt:status` + oferecer `wt:clean`/`wt:reap` (+`wt:prune`), reportando o que liberou.

## `heavy` (semáforo de RAM)

Prefixe comandos PESADOS (test/build/typecheck/vitest) com **`heavy`** (`~/.local/bin/heavy`, fonte `scripts/heavy.sh`) — limita quantos rodam ao mesmo tempo entre TODOS os worktrees (auto-dimensiona; 1 slot na M2 8GB). Override `AFIACAO_MAX_HEAVY=N`. Hook `heavy-guard` (PreToolUse Bash, `.claude/hooks/heavy-guard.sh`) **NEGA** test/build/typecheck rodado sem `heavy` (fail-safe: não age sem `heavy` instalado nem em leitura).

## MCPs enxutas

`.claude/settings.json` (comitado, **project > user**) desabilita 11 plugins sem uso no dev TS (adobe/mercadopago/sentry/slack/telegram/airtable/zapier/github/posthog/chrome-devtools/serena) + `ENABLE_CLAUDEAI_MCP_SERVERS=false`. **Mantidos:** superpowers/claude-mem/claude-md-management/context7. Religar pontual em `.claude/settings.local.json` (gitignored, precedência maior) + `/reload-plugins`. ⚠️ Desabilitar o **plugin** mata MCP **+ skills + hooks** dele. Worktrees criados via `bun run wt` (de `origin/main`) já nascem enxutos.
