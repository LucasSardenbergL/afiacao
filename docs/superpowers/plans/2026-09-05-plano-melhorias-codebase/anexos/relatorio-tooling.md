# Auditoria de tooling — CI · scripts · hooks · deps · build · worktrees · Lovable

Worktree auditado: `.claude/worktrees/intelligent-yalow-39d4e7` (branch `claude/code-improvements-plan-2bc5f9`, HEAD `9fe4e8880`), 2026-09-05. Read-only; medições em `$SP/*.txt|json|log`.

Legenda: I=Impacto · R=Risco da mudança · E=Esforço (1–5). Onde a lacuna já está documentada como follow-up, digo — o achado entra porque existe HOJE e há evidência nova.

---

## Achados

### T01 | Merge de PR NÃO dispara CI na main → 56 dispatches manuais em 30 dias e janela de main vermelha | infra
- **Evidência:** `.github/workflows/ci.yml:56-80` (decisão documentada: `schedule` diário como "piso útil", PAT/merge-queue descartados por custo); `.claude/skills/fecho/SKILL.md:224-231` (todo fecho de sessão roda `gh workflow run CI --ref main`); `gh run list` 30d: **107 `pull_request` · 56 `workflow_dispatch` · 8 `schedule` · 7 `push`** — e os 7 `push` são TODOS `gpt-engineer-app[bot]` (nenhum merge de PR gera run); branch protection: `required_checks=["validate"]`, `strict=false`, `pr_required=false`.
- **Por que importa:** a premissa "diário é o piso" foi tomada com poucos merges; hoje cada `/fecho` paga um run de ~9,5 min de runner (validate 574s + mutation 328s) — ≈8,4 h/mês — e a main continua validada só sob demanda. O incidente #1670+#1212 (main vermelha ~5 h por conflito semântico) é exatamente a classe que `strict=false` + "sem CI no merge" deixa aberta.
- **Proposta:** (a) `auto-merge.yml` com token de GitHub App ou fine-grained PAT (escopo só este repo: `contents:write`, `pull_requests:write`) — o push do squash passa a disparar `push:` e a Issue `ci-main-red` abre MINUTOS após o merge; o repo é **público** (`gh repo view`: `PUBLIC`) → minutos são grátis, o custo é só a credencial; ou (b) merge queue do GitHub (`merge_group` no `on:` + required check) — valida a COMBINAÇÃO antes da main e dispensa `strict`. Em ambos, remover o dispatch do `/fecho`.
- **I=4 · R=2 · E=2**

### T02 | 447 arquivos de teste de lógica pura rodam sob `jsdom` (environment global) — o step `Tests` é 49% do `validate` | teste/perf
- **Evidência:** `vitest.config.ts:8` `environment: "jsdom"` para tudo; **0** arquivos com `@vitest-environment node`; **447 de 751** `*.test.ts` não citam react/testing-library/document/window; CI (run 33940073390): `Tests` **221s** de 449s; local sob `heavy` (`health-test.log`): **819s**, buckets `environment 2184s` vs `tests 456s` (7573 testes, 751 arquivos) — 1 timeout falso (`erro-colapsado-em-vazio-gate.test.ts`, 20s), um dos 16/18 gates de `src/__tests__/` que varrem o fs.
- **Por que importa:** o setup do jsdom por arquivo é o maior custo da suíte, pago 447 vezes sem necessidade; é o step que mais falha (51/149 em 60d) e o que mais pesa na M2 8GB.
- **Proposta:** `environmentMatchGlobs` (vitest 3) — `**/*.test.tsx` → jsdom, `**/*.test.ts` → node — com `src/test/setup.ts` guardando `typeof window` (só `matchMedia` é shim de DOM, linha 86). Medir antes/depois; ganho ESTIMADO 30–50% do step (incerto — depende do peso real do jsdom no CI de 4 vCPU).
- **I=4 · R=2 · E=2**

### T03 | 36% das falhas de CI (53/149 em 60 dias) são gates de 0–2s que ninguém roda antes do push — não existe `gates:rapidos`/pre-push | infra/DX
- **Evidência:** falhas por step, 60d (`gh-fail-steps-250.txt`): knip **24** · authz:check **10** · hooks **8** · sonda:fingerprint **7** · sonda:bump 2 · claude:size 2; e **4 das 5 falhas recentes de `Tests`** são `scripts/docs-indice-gate-check.test.ts > o repo de verdade` (doc novo sem linha no índice). Tempo desses gates no CI: 0–2s cada (`gh-run-ok.json`). Local: `/health` cobre só typecheck·lint·test·knip·shellcheck (`CLAUDE.md:80`); `core.hooksPath` vazio, sem husky/lefthook, sem `ci:local` (grep 0).
- **Por que importa:** cada uma dessas falhas custa um ciclo de ~7,5 min + re-push num repo com auto-merge; a suíte inteira local leva 13,7 min, então ninguém a roda antes de cada PR — mas os 12 gates puros levam ~5s.
- **Proposta:** script `bun run gates:rapidos` = `sonda:fingerprint` (modo check) · `sonda:nova` · `canaria:bump` · `authz:check` · `authz:carimbo` · `bunpin:check` · `docs:indice` · `docs:citacoes` · `docs:links` · `claude:size` · `bunx knip` (~5s). Disparo: o hook `pr-collision-guard.sh` (PreToolUse em `gh pr create`) já intercepta o momento certo — nudge ou bloqueio se `gates:rapidos` não passou nesta sessão.
- **I=4 · R=1 · E=2**

### T04 | `edges:typecheck` resolve o registry AO VIVO sem `deno.lock` → main vermelha sem commit culpado (2026-08-15 e 2026-09-03) | infra/dependência
- **Evidência:** `ci.yml:189-236` (único step com rede; sem cache "de propósito" porque não há lock); `.gitignore:31` `deno.lock`; run 33761853248 (schedule 09-03): `Could not find npm package '@rolldown/binding-darwin-arm64' matching '1.2.7'`; **86** edges importam `npm:@supabase/supabase-js@2` (range) + 15 `npm:@anthropic-ai/sdk@^0.93.0` + 3 `npm:openai@^4.65.0` (`edge-imports.txt`); follow-up #4 aberto em `docs/historico/ci-testes-edge-deno.md:413` ("subiu de prioridade").
- **Por que importa:** 8 das 149 falhas em 60d são deste step; a única falha do `schedule` no período é dele — e o sinal `ci-main-red` disparado por drift alheio treina o founder a ignorar a Issue.
- **Proposta:** versionar `supabase/functions/deno.lock` (gerar com `deno cache --lock=... --frozen=false` sobre os 95 `index.ts`), passar `--lock` no gate e usá-lo como chave de `actions/cache` do `DENO_DIR` (o motivo documentado para não cachear cai). Ressalva a documentar: o Edge Runtime do Lovable NÃO lê o lock — a `fonte` continua fingerprint da fonte, não do bundle.
- **I=3 · R=2 · E=2** — (follow-up já documentado; evidência nova: 2ª ocorrência da classe)

### T05 | Três lockfiles: `bun.lockb` (template 2025-01-01, 1 commit) e `package-lock.json` (fóssil desde 2026-03-28) ao lado do `bun.lock` vivo | dependência
- **Evidência:** `git log`: `bun.lock` 34 commits (último 08-13) · `bun.lockb` **1** commit (`a5d5eec0f`, template) · `package-lock.json` 10 commits, último `cf5f1ecb0` 2026-03-28; CI usa `bun install --frozen-lockfile` (`ci.yml:125`) → é o `bun.lock` que vale; `.claude/skills/lovable-deploy-verify/evals/classify-eval.json:82` ainda classifica por `bun.lockb`; `docs/historico/faxina-knip-2026-07-07.md:53` já o chama de fóssil (fantasma `papaparse`).
- **Por que importa:** qualquer ferramenta npm-based (Dependabot, `npm audit`, um `npm install` distraído, e — INCERTO — o builder do Lovable) lê uma árvore 5 meses defasada; `bun.lockb` binário confunde diff/review e a skill de classificação.
- **Proposta:** apagar os dois num PR só; trocar `bun.lockb`→`bun.lock` no `classify-eval.json`; acrescentar ao `bunpin:check` a asserção "nenhum lockfile além de `bun.lock`" (o sync do Lovable pode recriá-los).
- **I=2 · R=1 · E=1**

### T06 | `vite.config.ts` (360 linhas: probe, PWA, `manualChunks`), `vitest.config.ts` e `tailwind.config.ts` não passam por NENHUM typecheck | código
- **Evidência:** `tsconfig.app.json:31` include `["src"]`; `tsconfig.scripts.json:71` include `scripts/**`+`db/**`; `tsconfig.node.json:21` include só `vite.config.ts` e é referenciado apenas pelo `tsconfig.json` raiz com `files: []` (no-op documentado em `ci.yml:8-15`); nenhum script/step roda `-p tsconfig.node.json` (grep 0); `vite build` transpila a config com esbuild (sem checagem).
- **Por que importa:** é o mesmo ponto cego que o #1720 fechou para `scripts/` — erro de tipo na config do build só aparece em runtime do build (ou nunca, se cair num ramo condicional como `isLovablePreview`).
- **Proposta:** `tsconfig.node.json.include += ["vitest.config.ts","tailwind.config.ts"]`; `typecheck` += `&& tsc --noEmit -p tsconfig.node.json`; step próprio no CI (~3s), pelo mesmo motivo do 2º tsc (nome próprio à falha).
- **I=2 · R=1 · E=1**

### T07 | ESLint: 74 warnings sem ratchet (comentário do CI diz "82, todos exhaustive-deps" — 25 são `react-refresh`) e a classe "thenable preguiçoso" documentada sem regra | código
- **Evidência:** `eslint.config.js:15-29` só `recommended` (+3 regras custom de segurança, boas); `health-lint.log`: **74 warnings = 49 `react-hooks/exhaustive-deps` + 25 `react-refresh/only-export-components`**; `ci.yml:44-48` desatualizado; `docs/agent/database.md:142` documenta "`void supabase.from(...)` não emite HTTP" e nenhuma regra vigia (varredura heurística: 21 candidatos, todos falsos-positivos — hoje **0 violações confirmadas**).
- **Por que importa:** sem ratchet, a contagem só é vigiada por memória; a regra `no-floating-promises` é a única que pega a classe money-path "esqueci o `await` num update" em tempo de lint — mas só com `checkThenables: true` (default `false` no typescript-eslint 8; o builder do PostgREST é thenable, não Promise).
- **Proposta:** (1) `"lint": "eslint . --max-warnings 74"` agora (E=1); (2) bloco type-aware SÓ em `src/services/**`, `src/hooks/**`, `src/queries/**` (`languageOptions.parserOptions.projectService: true`) com `@typescript-eslint/no-floating-promises` (`checkThenables: true`) + `no-misused-promises` — medir o tempo (lint hoje 16s CI/11s local); (3) `@typescript-eslint/switch-exhaustiveness-check` para as unions de status. Não recomendo `jsx-a11y`/`import/order` aqui (ruído > valor; `no-cycle` exige medição antes).
- **I=3 · R=2 · E=2**

### T08 | `shellcheck` não roda no CI; o PR #2093 que o instala está VERMELHO há 7 dias no próprio gate (87 achados: 72×SC2317, 15×SC2015) | infra
- **Evidência:** `grep -c shellcheck .github/workflows/ci.yml` = **0**; `CLAUDE.md:80` (só no `/health`); PR #2093 aberto, non-draft, criado 08-29, `validate: FAILURE` no step "Shell lint gate (shellcheck — scripts/ + hooks/ + db/)" (run 33225239552); superfície: **60** `scripts/*.sh` (11.025 LOC) + **17** hooks (1.870 LOC) + **275** `db/*.sh`; 30/60 scripts sem `set -e` (a maioria harness `set -u` — provavelmente deliberado), `pendencias.sh` sem `set` algum.
- **Por que importa:** 17 hooks rodam em TODA chamada de Bash de toda sessão e os harnesses de prova (`db/test-*.sh`) são a evidência do money-path — o PR #2093 nasceu justamente de 3 harnesses com bug que não ficava vermelho. Parado, ele vai apodrecer (conflito com `ci.yml`/`package.json`, superfície mais disputada).
- **Proposta:** destravar #2093 com ratchet: `--exclude=SC2317` (código "inalcançável" de funções chamadas por `trap`, já anotado manualmente em 4 arquivos) e `SC2015` como warning; mergear; apertar depois por arquivo tocado.
- **I=3 · R=1 · E=1**

### T09 | 79 worktrees VIVAS no disco (0 órfãs) = 16,7 GB; 22 com `node_modules` (~666 MB cada ≈ 14,6 GB); 70 anteriores a setembro | infra
- **Evidência:** `git worktree list` **79**, todas existem, `prunable=0`; `wt-du.txt` total **~16,7 GB**; idade por mtime de `.git`: mai 1 · jun 7 · jul 21 · ago 41 · set 9; `vigia-worktree.sh` só avisa swap e `node_modules` ausente; `wt:prune` exige "conversa excluída" (`docs/agent/worktrees.md:305`).
- **Por que importa:** a ferramenta existe (`wt:clean/prune/reap`) — o que falta é gatilho: 22 `node_modules` parados numa M2 8GB são RAM de Spotlight/indexação e 14 GB de SSD; as 70 worktrees antigas são o "ímã de conflito" que o CLAUDE.md descreve.
- **Proposta:** no `vigia-worktree.sh` (SessionStart) imprimir o dry-run de `wt:clean` quando houver ≥N `node_modules` parados; no `/fecho`, tornar `wt:clean --include-current --yes` padrão (hoje é oferta); `wt:prune --idade 30d` para worktree cujo HEAD é ancestral de `origin/main` mesmo com a conversa viva (trabalho está salvo por construção).
- **I=2 · R=2 · E=2**

### T10 | `lovable-watch` só compara `HEAD^..HEAD` (push multi-commit do bot passa em silêncio — documentado, sem fix) e a Issue #1109 tem 91 comentários | segurança/infra
- **Evidência:** `lovable-watch.yml:41` `git diff --name-only HEAD^ HEAD`; `github.event.before` não é usado (grep 0); `scripts/lovable-revert-scan.sh` aceita 1 sha; ponto cego registrado em `docs/agent/deploy.md:456` (2026-07-23); `#1109` aberta desde 06-27, **91 comentários**, último 09-05; `#1686` (reversão provada) 3 comentários; **23/300** commits da main são diretos do bot (10 "Work in progress" · 10 "Lovable update" · 2 "Changes" · 1 snapshot). O spec (`2026-06-26-lovable-revert-mitigation-design.md §4`) descarta auto-reversão e branch protection complexa — não reproponho.
- **Por que importa:** o mecanismo é só DETECÇÃO (nenhum gate — o bot precisa de push direto), então a qualidade do sinal é tudo: um comentário por commit numa Issue de 91 vira ruído, e o ponto cego do penúltimo commit é exatamente a reversão que importa.
- **Proposta:** iterar `git rev-list ${{ github.event.before }}..HEAD` e rodar scan + `lovable-revert-scan.sh <sha>` por commit (E=1); agregar: em vez de comentário por commit, atualizar uma TABELA no corpo da Issue (commit · arquivos · reversão S/N) e só comentar quando `reversao=true`.
- **I=3 · R=1 · E=1**

### T11 | Hooks/evals = 115s sequenciais no caminho crítico do `validate` (26%); 33 `test-*.sh` sem lib comum (278 linhas idênticas, `ok()` redefinido em 14) | teste/infra
- **Evidência:** timings CI: Hooks **45s** + Falsificação **49s** + Evals 7s + Falsificação-evals 14s = 115s de 449s; `package.json` `test:hooks` = loop sequencial de 30 scripts; `test-sh-dup.txt`: 13 linhas presentes em ≥10 dos 33 arquivos (278 ocorrências: `here=$(cd ...)`, `fail=0`, `exit "$fail"`, `tmp=$(mktemp -d)`, `trap ... EXIT`); `ok()` em 14 arquivos, `falha()` em 6, `source lib/` em **0**; 9/33 usam `/tmp/<nome fixo>` (risco para paralelizar).
- **Por que importa:** é o segundo maior bloco do `validate` e é embaraçosamente paralelo — como o `mutation-check` já é. A duplicação torna cada correção de harness (ex.: a lição PIPESTATUS/zsh) um patch em 30 lugares.
- **Proposta:** job `hooks` paralelo (com `validate` fazendo `needs: [hooks]` no fim, para manter o único required check) → `validate` ~-25% de parede; `scripts/lib/test-harness.sh` (ok/falha/tmp/trap/contador) adotado incrementalmente pelos scripts tocados.
- **I=3 · R=1 · E=2**

### T12 | Probe `__BUILD_ENV_KEYS__` "temporário" vivo desde 2026-06-19 e sem resposta — o build do Lovable nunca expôs SHA | código/documentação
- **Evidência:** `vite.config.ts:36-44,82-83`; `src/main.tsx:9,28` (`window.__BUILD_ENV_KEYS__`); `src/lib/build-id.ts:17` (`__COMMIT_SHA__` degrada para "dev" em prod); `docs/historico/fase-sem-sinal.md:1458` ("nenhuma env de SHA identificada até hoje — tanto que o probe ainda está lá").
- **Por que importa:** 11 semanas de probe = ou ninguém leu o resultado em prod, ou o resultado é vazio e ninguém registrou. Embarca nomes de env (filtrados) em todo bundle — risco baixo, mas é código morto com cara de sensor.
- **Proposta:** ler `window.__BUILD_ENV_KEYS__` no console de prod UMA vez; vazio → apagar o probe e registrar em `deploy.md` "Lovable não expõe SHA; identidade do frontend = build-id por hash de bundle"; se houver chave → adicioná-la a `resolveCommitSha()` e apagar o probe.
- **I=2 · R=1 · E=1**

### T13 | 22 majors atrasados — o que vale, o que espera, e o que NÃO pode hoje | dependência
- **Evidência:** `bun-outdated.txt`; peers em `bun.lock`: `lovable-tagger` `vite >=5 <8`, `vite-plugin-pwa` até `^7`, `@vitejs/plugin-react-swc@3` até `^7` → **Vite 8 é impossível hoje**; `@types/leaflet` em `dependencies` (`package.json:78`); `name: vite_react_shadcn_ts`/`0.0.0` (template Lovable — deixar); `overrides` (6) são todos transitivos de dev-tooling (`bun-why.txt`: eslint→minimatch@3→brace-expansion, jsdom→form-data, eslint→eslintrc→js-yaml, postcss→nanoid, vite-plugin-pwa→workbox→terser→serialize-javascript, knip→yaml) — `brace-expansion ^2` sobre `minimatch@3` (pede `^1.1.7`) é override CROSS-MAJOR que funciona por sorte.
- **Tabela (I/R/E por dep) na seção Medições.** Ordem sugerida: TS 5.9 + @types/node + knip + jsdom 26 (lote seguro) → react-router 7 → date-fns 4 → zod 4 → lucide 1.x (janela quieta: 592 arquivos) → Vite 7 (só com paridade do template Lovable) → eslint 10/react-hooks 7 → recharts 3. Adiar: Tailwind 4, React 19, TS 7 (tsgo), `@lovable.dev/mcp-js` 2.x (acoplado ao bundle `supabase/functions/mcp` e ao deploy Lovable).
- **Proposta imediata (E=1):** `bun update` dos pais dos overrides (eslint 9.39, jsdom, postcss, knip, vite-plugin-pwa 1.3) e remover os overrides que passarem a resolver sozinhos; mover `@types/leaflet` para devDependencies.
- **I=3 · R=3 · E=3** (agregado)

### T14 | Sem `concurrency` no `ci.yml`: pushes seguidos no mesmo PR rodam 2 CIs completos em paralelo | infra
- **Evidência:** `grep -c concurrency ci.yml` = 0; runs 33939256517 (02:30) e 33939502515 (02:35) na mesma branch, ambos ~400s, sobrepostos, ambos vermelhos pela mesma causa.
- **Por que importa:** runner ocupado atrasa a fila dos outros PRs (o `/fecho` já registra "cancelled por fila de runner" como armadilha).
- **Proposta:** `concurrency: { group: ci-${{ github.head_ref || github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }` — nunca cancelar na main.
- **I=2 · R=1 · E=1**

### T15 | PWA `globIgnores` por NOME de chunk de página, sem sentinela — renomear o arquivo re-inclui o chunk no precache em silêncio | código
- **Evidência:** `vite.config.ts:152-165` (`FarmerCopilot-*`, `AdminRoutePlanner-*`, `TechnicalDocs-*`, `DesignSystem-*`, `DesignPreview-*`, `UXRules-*` — nomes derivados do arquivo pelo Rollup; os `vendor-*` vêm de `manualChunks` e são estáveis); nenhum teste cita `globIgnores` (grep 0); build local: **337 chunks, 6.417 kB JS, precache 341 entradas / 5.674 KiB, 0 avisos >500 kB** (maiores: `vendor-elevenlabs` 456 kB, `vendor-charts` 433 kB, `WebRTCCallContext` 269 kB, 2×`index` ~230 kB).
- **Por que importa:** falha ABERTA: o chunk volta ao precache (offline-first) e ninguém vê — só o teto `maximumFileSizeToCacheInBytes` 5 MB segura.
- **Proposta:** pós-build no CI (após `Build`): script de 20 linhas que exige que cada padrão de `globIgnores` case ≥1 arquivo em `dist/assets` e que nenhum deles esteja no manifesto do `sw.js` — fail-closed.
- **I=2 · R=1 · E=1**

---

## Medições

### CI — `validate` (run 33940073390, PR verde típico; parede 449s ≈ 7,5 min) — 27 steps nomeados
| s | step | bloqueante | rede |
|---:|---|---|---|
| 3 | checkout (`fetch-depth: 0`, ~118 MB) | — | sim |
| 1+10 | Setup Bun 1.3.14 (semver estrito) + `bun install --frozen-lockfile` | — | sim |
| 34 | Type check (strict, `tsconfig.app.json`) | sim | não |
| 3 | Type check (scripts/ + db/) | sim | não |
| **221** | Tests (vitest, 751 arquivos / 7.573 testes) | sim | não |
| 3+5 | Setup Deno + Tests edges (`--no-remote`) | sim | setup sim / teste não |
| 8 | Type check edges (`deno check`, sem lock) | sim | **sim (registry vivo)** |
| 0/0/0/1 | sonda:bump (só PR) · sonda:fingerprint · sonda:nova (só PR) · canaria:bump (só PR) | sim | não |
| 18 | Build (`NODE_ENV=production`) | sim | não |
| 16 | Lint (errors only; 74 warnings) | sim | não |
| 0 | CLAUDE.md size budget (arquivo + seção, ratchet) | sim | não |
| **45** | Hooks guard tests (30 scripts, sequencial) | sim | não |
| **49** | Falsificação hooks | sim | não |
| 7+14 | Evals lovable-deploy-verify + falsificação | sim | não |
| 0/0/0 | authz:check · authz:carimbo · bunpin:check | sim | não |
| 0/1/1 | docs:indice · docs:citacoes · docs:links | sim | não |
| 2 | knip | sim | não |
| — | Alerta/fecho Issue `ci-main-red` (só main) | — | sim |

Jobs paralelos: `mutation-check` **328s** (303s no mutcheck; não-required, informativo, fora do `schedule` — desenho) · `authz-sentinela` (só main; carimbo authz). Sem `actions/cache` (bun: cache da action; deno: recusado até haver lock). Sem `concurrency`.

### CI — histórico
- 56 runs recentes: **7 falhas (12,5%)**; média `pull_request` verde **537s**, `workflow_dispatch` 574s, `push` 551s.
- 30 dias: 107 PR · **56 dispatch** · 8 schedule · 7 push (todos Lovable) · 115 auto-merge.
- Falhas 60 dias (149 runs): Tests 51 · knip 24 · typecheck 20 · Setup Bun 12 (todas 2026-07-16, incidente REST do GitHub, já mitigado) · authz:check 10 · edges typecheck 8 · hooks 8 · fingerprint 7 · lint 6 · sonda:bump 2 · claude:size 2 · mutcheck 1 · test:edges 1 · shellcheck (PR #2093) 1.
- 4/5 falhas recentes de `Tests` = `docs-indice-gate-check.test.ts > o repo de verdade`.

### Local (`heavy`, M2 8GB, `health-*.log`)
typecheck 35s · lint 11s (74 warnings) · knip 2s (0 achados) · **test 821s, 1 timeout falso** · build 941s na fila / **32s de build real** (337 chunks, 6.417 kB, 0 avisos).

### Dependências — majors (bun outdated 2026-09-05)
| dep | atual → latest | uso | I | R | E | nota |
|---|---|---|---|---|---|---|
| typescript | 5.8.3 → 5.9.3 (7.0.2) | — | 2 | 1 (5.9) / 3 (7) | 1 / 3 | 7 = tsgo; suporte do typescript-eslint incerto |
| jsdom (dev) | 20.0.3 → 30.0.1 | setup só shim `matchMedia` | 2 | 2 | 2 | pré-requisito para vitest 4/5 (incerto) |
| vitest (dev) | 3.2.6 → 5.0.0 | — | 2 | 3 | 3 | acoplado a jsdom/plugin-react-swc |
| vite (dev) | 5.4.21 → 8.2.2 | — | 3 | 3 | 3 | **8 bloqueado pelos peers**; 7 possível, conferir template Lovable |
| @vitejs/plugin-react-swc | 3.11 → 4.3 | — | 1 | 2 | 1 | exige vite ≥6 |
| react-router-dom | 6.30.4 → 7.18.3 | 202 arquivos; `v7_startTransition` já ligado; `<BrowserRouter>` (sem data router) | 2 | 2 | 2 | pacote continua existindo em v7 |
| lucide-react | 0.462 → 1.41 | **592 arquivos** | 2 | 3 | 2 | renomes de ícone; PR massivo × 79 worktrees → janela quieta |
| date-fns | 3.6 → 4.4 | 87 arquivos | 2 | 1 | 2 | v4 quase aditivo (TZ) |
| zod | 3.25 → 4.5 | 15 arquivos + 2 edges `npm:zod@^3.25` | 2 | 2 | 2 | `@hookform/resolvers` 5.9 suporta v4 |
| react-day-picker | 8.10 → 10.0 | 1 arquivo (calendar shadcn) | 1 | 2 | 2 | reescrever `calendar.tsx` |
| @hello-pangea/dnd | 17 → 18 | 3 arquivos | 1 | 1 | 1 | só dropa React ≤17 |
| @elevenlabs/react | 0.14 → 1.15 | 2 arquivos (copiloto de voz) | 2 | 3 | 3 | API `useConversation` mudou; teste manual |
| @lovable.dev/mcp-js | 0.20 → 2.0 | 4 arquivos + 3 edges pinadas + bundle gerado | 2 | 4 | 3 | só com orientação Lovable |
| tailwindcss | 3.4 → 4.3 | 10 `@apply`, tokens CSS, 2 plugins | 2 | 3 | 4 | adiar |
| tailwind-merge | 2.6 → 3.6 | — | 1 | 1 | 1 | junto com Tailwind 4 |
| recharts | 2.15 → 3.10 | vendor-charts 433 kB | 2 | 2 | 3 | financeiro |
| sonner | 1.7 → 2.0 | toasts | 1 | 1 | 1 | |
| tesseract.js | 5.1 → 7.0 | OCR lazy | 1 | 2 | 2 | |
| framer-motion | 12 → 13 | — | 1 | 1 | 1 | |
| eslint / @eslint/js | 9.32 → 10.x | — | 2 | 2 | 2 | flat config já |
| eslint-plugin-react-hooks | 5.2 → 7.1 | — | 2 | 3 | 2 | regras do React Compiler → novos erros |
| @types/node | 22 → 26 | scripts | 1 | 1 | 1 | |
| react / @types/react | 18.3 → 19.2 | tudo | 3 | 4 | 4 | fora de escopo agora |
| next-themes | 0.3 → 0.4 | 1 | 1 | 1 | 1 | |

Minors relevantes: `@supabase/supabase-js` 2.95→2.115 (frontend pinado pelo lock; **edges flutuam em `@2`** — T04), `@tanstack/react-query` 5.83→5.102, `posthog-js` instalado 1.373 (declarado `^1.226`), `knip` 6.14→6.34, `bun-types` 1.3.14 (alinhado ao pin do bun; bump = 3 lugares).

### Contagens
- `scripts/`: 154 arquivos (60 `.sh` 11.025 LOC · 49 `.ts` 20.859 LOC, dos quais 7.901 em `.test.ts` · 2 `.sql` 4.562 LOC); 33 `test-*.sh` = 6.433 LOC; 1 datado (`apply-missing-migrations-2026-05-19.sql`, 102 linhas, 1 citação); 0 scripts sem citação (os 6 "não citados" são `.test.ts` cobertos pelo `include` do vitest ou nomes construídos no loop do `test:hooks`).
- `.claude/hooks/`: 17 (1.870 LOC); settings: PreToolUse 9 comandos · PostToolUse 1 · SessionStart 2 · Stop 2 · InstructionsLoaded 1. `test:hooks` = 30 scripts (+2 fora por desenho: `hooks-suites-baseline.ts`).
- `.claude/skills/`: 15 skills, 67 arquivos, 756 KB (`lovable-deploy-verify` 244 KB, com evals rodando no CI).
- Lockfiles: `bun.lock` 348 KB · `bun.lockb` 199 KB · `package-lock.json` 470 KB.
- Worktrees: 79 registradas = 79 no disco; 22 com `node_modules`; ~16,7 GB.
- Lovable: 23/300 commits diretos na main (7,7%); 3 workflows (`ci`, `auto-merge`, `lovable-watch`); branch protection: required `validate`, `strict=false`, sem PR obrigatório, sem CODEOWNERS/rulesets.

---

## Descartei porque…
1. **Dois passos de `tsc` no CI** (`app` + `scripts`) — desenho documentado (`ci.yml:24-30`): `bun run typecheck` roda os dois para o LOCAL não dar verde falso; no CI cada config tem passo próprio para nomear a falha.
2. **`@typescript-eslint/no-unused-vars: off`** — `tsconfig.app.json:17-18` (`noUnusedLocals/Parameters`) e `tsconfig.scripts.json` cobrem com erro de tipo, mais forte que warning de lint.
3. **`mutation-check` 303s e não-required** — deliberado (`ci.yml:651-656`): informativo, paralelo, fora do `schedule` para não virar "vermelho sem leitor"; não está no caminho crítico.
4. **12 falhas em "Setup Bun"** — todas de 2026-07-16 (503 em `api.github.com/.../refs/tags`); classe fechada pelo pin semver estrito + gate `bunpin:check`.
5. **`test-heavy.sh`/`test-heavy-install.sh` fora do `test:hooks`** — `scripts/hooks-suites-baseline.ts` (`SUITES_FORA_DO_CI`) os declara com motivo; há gate que cobra a lista.
6. **Cache do `DENO_DIR` no CI** — recusado com medição (`ci.yml:209-213`, 681 MB, sem chave estável) — cai como consequência do T04, não é achado próprio.
7. **Lint de shell sobre cercas de skill** — medido e recusado em `docs/agent/skills.md` (7 achados, 0 defeitos reais).
8. **Drift `bun.lock` × `package.json`** — inexistente (`--frozen-lockfile` verde em 100% dos runs recentes).
9. **`name: vite_react_shadcn_ts` / `version 0.0.0`** — template Lovable; renomear pode confundir o sync e não compra nada.
10. **30 scripts sem `set -e`** — 28 são harnesses `set -u` que CONTAM falhas e precisam continuar após um assert vermelho; provável desenho. Só `pendencias.sh` (sem `set` algum) merece olhar — trivial, folded no T08.
