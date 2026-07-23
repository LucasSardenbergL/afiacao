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

- ⚠️ **Estado de PR/sessão alheia: ancore na verdade FRESCA, não num snapshot.** "PR de outra sessão está vermelho/aberto?" → `gh pr view <n> --json statusCheckRollup,state,mergedAt` (rollup do HEAD atual) — **nunca** um `gh run view --job=<id>` de run anterior (reflete commit já superado, não o head) nem o `prState` do `list_sessions` (cache curto — pode dizer `OPEN` já depois do merge). Caso real (2026-07-14): sinalizei à sessão do #1323 "validate vermelho pelo manifesto gate" lendo um log das 00:20; o PR já mergeara **VERDE** às 00:51 (a sessão dona resolvera os 5 órfãos sozinha) → heads-up cross-sessão obsoleto + retração. Vale ao **iniciar** qualquer sinalização/coordenação, não só ao commitar.

## Execução: inline vs subagente (Task)

- **Implementação money-path complexa (TDD + PG17 + edição multi-arquivo) → o controller executa INLINE**, não via subagente implementador. Repetido neste repo: subagentes-implementadores **divergem do pedido central** e exigem retrabalho (pularam a carteira-da-cidade que era o pedido central; removeram o `digitosCnae` que o plano pedia). O fio da disciplina por-task (TDD → PG17 → commit) o controller segura melhor mantendo o contexto.
- **Leitura/varredura/análise read-only delega BEM** — a janela própria do subagente poupa a do controller (varrer N arquivos e devolver só a conclusão, mapear consumidores de uma função, auditar um diretório). O thrash é na ESCRITA complexa, não na leitura.

## Colisão de migration multi-sessão (`wt:preflight` + hook)

Duas worktrees podem criar migrations que recriam o **mesmo objeto** SQL (função/view/trigger/policy). Como o apply é manual no SQL Editor, "a última a rodar vence" sobrescreve a outra **silenciosamente** (`database.md` §2). Três camadas, todas reusando `scripts/lib/migration-objects.ts` (o mesmo extrator do `audit:migrations`):

- **Comando** — `bun run wt:preflight supabase/migrations/<arq>.sql` (worktrees locais; `--full` agrega `origin/main`). Diz qual objeto colide e se a concorrente está **em voo** (não-commitada → 🔴 concorrência real) ou **já no histórico** (🟡 evolução serial, inócuo). Timestamp colidido com objetos distintos = 🟡 informativo. `function`/`view`/`trigger`/`rls_policy` = perigoso; `table`/`index`/`enum`/`cron` (`IF NOT EXISTS`/aditivo) = 🟡.
- **Hook** — `.claude/hooks/migration-collision-guard.sh` (PreToolUse Write/Edit em `supabase/migrations/*.sql`): roda o preflight local e **nega** só no 🔴. Fail-open (sem `bun`/`jq`/erro → no-op). Espelha o `heavy-guard` (exit 0 + JSON `permissionDecision:"deny"`).
- **Gate de apply** — Passo 2.5 da skill `lovable-db-operator`: roda o preflight antes de entregar o bloco do SQL Editor. É o chokepoint — pega qualquer caminho de criação (Write, Edit, heredoc), inclusive os que o hook não vê.

Limite conhecido (fase 1): não pega a *race fria* (duas sessões, nenhum arquivo escrito ainda), nem `ALTER TABLE`/`DROP+CREATE`. Testes: `scripts/test-migration-objects.ts` · `scripts/test-preflight-migration.sh` · `scripts/test-migration-collision-guard.sh`.

## Colisão de CÓDIGO multi-sessão: re-conferir ANTES do `gh pr create` (2026-07-21)

Irmã da colisão de migration acima, sem ferramenta equivalente — e o custo aqui não é sobrescrita
silenciosa, é **retrabalho** e o risco de duas correções divergentes do mesmo invariante entrarem
juntas. Cronologia medida (PRs de margem, mesmo dia):

```
#1495  criado 00:30 → merge 17:58   produtor (draft por 17h)
#1519  criado 17:01 → merge 21:40   helper SQL
#1524  criado 17:39 → merge 22:32   leitura fechada no frontend (resolvido, ver abaixo)
#1525  criado 17:41 → merge 17:47   consumidores  ← viveu 6 minutos
#1526  criado 17:47 → FECHADO       duplicata do #1525, 26 arquivos jogados fora
```

Quatro PRs sobre a mesma coluna em **46 minutos**. O #1526 foi aberto no minuto exato em que o
#1525 mergeou; a sessão dele conferiu `gh pr list` às 12:50 (viu só o #1495 em draft) e trabalhou
5h sem reconferir. Refazer o delta sobre a `main` — em vez de resolver 13 conflitos — derrubou o
diff de 26 arquivos para 8 (#1533).

**Três causas, em ordem de peso:**

1. **PR represado em draft é ÍMÃ.** O #1495 passou 17h anunciando "espero o consumidor ser
   blindado". Qualquer sessão que o lesse chegava ao mesmo conjunto de arquivos. Não precisou de
   chip: a sessão do #1526 veio de tarefa dirigida. ⇒ produtor em draft deve nomear no corpo quem
   está tocando o consumidor, ou não ficar represado.
2. **Assimetria de duração.** A janela de colisão é o tempo da sessão LONGA. Trabalho rigoroso
   (medir prod, Codex, TDD, falsificação) leva horas; um PR simples com auto-merge fecha em 6
   minutos. Quanto mais cuidadosa a sessão, mais exposta a ser atropelada.
3. **A checagem do início vence.** `gh pr list` no minuto 0 de uma sessão de 5h é uma foto velha.

**Regra:** re-conferir `gh pr list` **imediatamente antes do `gh pr create`**, filtrando pelo
domínio (`gh pr list --search "margem"`). Custa segundos; teria pego o #1525 seis minutos antes.

⚠️ **Trabalho derivado de achado COMPARTILHADO colide por DESENHO, não por azar (2026-07-23).**
Parecer do Codex, item de post-mortem, bug descrito em doc: a fonte é lida por VÁRIAS sessões, que
convergem para o mesmo item — a colisão deixa de ser acidente e passa a ser o resultado esperado.
Aí a checagem `origin/main` + `gh pr list` tem de vir **ANTES de implementar**, não só antes do
`gh pr create` — e varrendo por **TÍTULO/BRANCH do tema** (`gh pr list --state all --search "<termo>
in:title"`), **não** por arquivo: o PR concorrente pode consertar o mesmo achado sem tocar nenhum dos
arquivos que você planeja tocar. Caso medido: uma sessão rodou `/codex` retroativo sobre o #1550,
recebeu o achado [P1] de PII em `error.message` do PostgREST e implementou o conserto inteiro
(função de redação + testes + gates completos verdes, 5681 testes); só a re-checagem obrigatória
pré-commit revelou o **#1560** (`claude/telemetria-postgrest-pii-hardening`), de outra sessão, no
MESMO achado — e com desenho melhor: **allowlist** (`code` + `categoria`) contra a denylist que eu
havia escrito, que provei vazar PII interpolada sem delimitador (`cliente 123.456.789-00 (João da
Silva, joao@exemplo.com) sem permissão` passava inteiro — sem aspas e abaixo do teto de caracteres).
Implementação descartada por inteiro. **A re-checagem pré-`gh pr create` evita o PR duplicado; só a
pré-implementação evita a hora perdida.**

⚠️ **Checar colisão de ARQUIVO: `git diff` de TRÊS pontos, não de dois (2026-07-22).** A checagem
por PR acima tem uma irmã por diff — "a `main` mexeu num arquivo que EU também mexo?" — e o comando
óbvio **mente depois que você commita**. `git diff --name-only HEAD..origin/main` (DOIS pontos)
compara as duas árvores, então lista o que a `main` ganhou **mais o inverso dos seus próprios
commits**: antes de commitar, `HEAD` É a base e ele acerta por acidente; depois de commitar, ele
acusa os SEUS arquivos como se a `main` os tivesse tocado — falso positivo (me deu um "colisão!"
fantasma no #1551, um doc-only que a `main` nem havia tocado). Use **TRÊS pontos**, que ancora na
merge-base: `git diff --name-only HEAD...origin/main` lista só o que a `main` ganhou desde que você
divergiu (idêntico a `$(git merge-base HEAD origin/main)..origin/main`). Colisão REAL = a interseção
disso com os SEUS arquivos (`git diff --name-only origin/main...HEAD`, três pontos, HEAD por último).
Provado num repo descartável nos dois sentidos: o três-pontos remove o falso positivo **e** mantém o
verdadeiro (arquivo tocado pelos dois lados continua aparecendo — não vira falso-negativo). Regra de
bolso: **`A...B` para "o que um lado ganhou desde a base"; `A..B` de dois pontos quase nunca é o que
você quer aqui.** (As skills `fecho`/`lovable-deploy-verify` já usam `origin/main...HEAD` de três
pontos para classificar o PRÓPRIO diff — correto pelo mesmo motivo; o furo era só a checagem de
colisão feita à mão.)

⚠️ **A hipótese "são os chips" foi investigada e NÃO se sustenta** — registrado para não virar
folclore. Chips criam sessões, mas não escolhem o alvo; o que concentrou quatro sessões no mesmo
ponto foi o produtor represado. Nada na memória (claude-mem) registra decisão sobre chips×compact.

**Tensão real, não regressão de prática:** a regra do `CLAUDE.md` "2º compact → split com
`/handoff-sessao` (1 entrega = 1 sessão)" otimiza qualidade de contexto e paga com coordenação —
uma sessão só não colide consigo mesma. Ela nasceu de dor medida (sessão-épico com 14 compacts:
regressão de idioma, releituras, estado perdido). Trocar split por compact reduz colisão e traz a
degradação de volta; a saída barata é a re-checagem acima, que ataca a colisão sem desfazer a regra.

**Se for RESOLVER em vez de refazer** (#1524, mergeado 22:32 — o founder pediu para resolver o PR
já aberto): `git merge origin/main` e **a `main` vence por padrão** (`git checkout --theirs` em
todos os conflitos). Ela passou pelo CI e está em produção; sobrescrevê-la reverte trabalho
mergeado — mesma classe de falha do sync bidirecional do Lovable (`deploy.md`). Preserve só
**adição genuína não coberta**: dos 4 achados do Codex no #1524 sobraram 2, ausentes da `main`
justamente porque as sessões irmãs não rodaram segunda opinião — o diferencial de uma sessão lenta
tende a ser o que o rigor extra produziu, não o núcleo. Módulo duplicado **apaga-se**, não se
reconcilia (`lib/margem.ts` contra o `lib/format.ts` que já existia; as duas sessões chegaram a
criar `legendaCobertura`, mesmo nome, em arquivos diferentes). Spec que descreve plano já executado
por outras mãos sai junto — documento afirmando trabalho não realizado engana quem ler depois.
Resultado: 15 arquivos conflitantes → 9, e o PR passou a valer pelo que só ele tinha.

⚠️ **`MERGE_HEAD` em worktree NÃO fica em `.git/MERGE_HEAD`** — ali `.git` é *arquivo*, não
diretório. `test -f .git/MERGE_HEAD` dá falso-negativo e faz um merge íntegro parecer perdido
(custou uma tentativa de refazer do zero); use `$(git rev-parse --git-dir)/MERGE_HEAD`. E **não
rode `git stash` com merge em curso** — mexe no estado do merge; para salvar, copie os arquivos
para fora da árvore. O guard de `git reset --hard` pagou-se aqui: barrou o reset que teria
destruído o merge por causa desse diagnóstico errado.

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

Prefixe comandos PESADOS (test/build/typecheck/vitest) com **`heavy`** (`~/.local/bin/heavy`, fonte `scripts/heavy.sh`) — limita quantos rodam ao mesmo tempo entre TODOS os worktrees (auto-dimensiona; 1 slot na M2 8GB). Override `AFIACAO_MAX_HEAVY=N`.

⚠️ **`~/.local/bin/heavy` é CÓPIA, não symlink: mergear na `main` não atualiza o semáforo em uso** (mesma armadilha do Lovable — repo ≠ produção; o #1459 ficou mergeado e INERTE até a cópia manual). **Remédio: `bun run heavy:install`** (`scripts/heavy-install.sh`) — fonte **`origin/main`**, NÃO o `scripts/heavy.sh` desta worktree: em 2026-07-20, 32 das 39 worktrees carregavam o `heavy.sh` pré-#1459, então instalar "o daqui" andaria o semáforo **para trás** (`--daqui` força o local, para provar mudança em voo antes de mergear). A cópia é **atômica** (tmp no dir do DESTINO + `mv`): `cp` por cima do destino reescreve o MESMO inode e corrompe um `heavy` em execução, que relê o script por offset de byte — o `mv` publica inode novo e quem está na fila termina no arquivo antigo. Convivência de versões é segura (o antigo ignora o subdir `fila/`; só não entra no FIFO). O hook `vigia-worktree.sh` chama `heavy-install.sh --status` no SessionStart e segue o contrato de 4 estados: **sincronizado** e **em voo** (instalado == `scripts/heavy.sh` **desta** worktree, ≠ `origin/main` — alguém rodou `--daqui` de propósito) ficam em **silêncio**; **divergente** e **ausente** avisam; e se a comparação nem rodar (fonte ilegível, `mktemp` falhou, ou o próprio hook estourou o teto de 3s) o hook avisa **isso** — "não consegui verificar" —, nunca "divergente" (ausência de dado ≠ afirmação de divergência). Não auto-instala, porque o CI é ubuntu e **nunca prova o `heavy`** (`test-heavy.sh` é macOS-only). ⚠️ **Limite:** o silêncio do estado "em voo" só protege a worktree que rodou `--daqui` — nas outras, o `--status` compara contra o `heavy.sh` DELAS, dá **divergente**, e o hook sugere `bun run heavy:install` (no allowlist, roda sem prompt) — que reinstala `origin/main` por cima da mudança em voo. Se outra worktree instalou com `--daqui` de propósito, ignore o aviso ali. Symlink foi rejeitado: faria a versão em vigor ser função de qual branch o repo principal tem em check-out. Cobertura não é retroativa — worktree antiga não tem o hook novo nem o instalador.

**Três invariantes** (cada uma nasceu de bug medido em 2026-07-18, ~24 sessões/40 worktrees — `scripts/test-heavy.sh` prova as três sob concorrência, e cada asserção foi falsificada sabotando a correção):
1. **A vaga só volta quando a RAM volta.** O trap mata a ÁRVORE do filho (grupo de processos, via `set -m`) ANTES de soltar o slot. Antes, matar o wrapper deixava `bun`→`node tsc` vivos *e* devolvia a vaga: o semáforo mentia e o órfão seguia comendo a RAM cuja falta causou a espera.
2. **Capacidade é CONTAGEM, não índice.** Admissão compara slots vivos com o total. O mesmo defeito dava dois sinais opostos: índice baixo ocupado → travava e `--status` dizia `-1 livre(s)`; índice alto ocupado → sobrava índice no meio e um 3º furava um teto de 2. Política adotada: **piso dinâmico** — o total segue acompanhando a RAM real, mas as vagas saturam em 0 e a sobrecarga vira frase legível ("N acima do teto atual; drenando"). Rejeitadas: *persistir* congela um número medido num instante arbitrário; *sobre-inscrever* é o que o bug já fazia por acidente.
3. **Quem chega primeiro entra primeiro.** Fila FIFO por ticket (timestamp ns em `$LOCKDIR/fila`), visível em `heavy --status`. Antes era corrida de despertar — medido: 21min05 de espera perdendo para 2min00. O FIFO custa vazão (só a cabeça pode ocupar a vaga), então o poll é adaptativo: quem está a ≤2 posições de entrar checa a 0,2s, o resto da fila a 2s. Sem isso, 24 jobs curtos escoavam em 50s contra 10s do polling desordenado; com isso, 13s **e** ordem exata. Hook `heavy-guard` (PreToolUse Bash, `.claude/hooks/heavy-guard.sh`) **REESCREVE** test/build/typecheck sem `heavy` (updatedInput prefixa o semáforo — sem round-trip de negação nem classificador; fail-safe: não age sem `heavy` instalado nem em leitura; testes `scripts/test-heavy-guard.sh`). ⚠️ **"Existe" ≠ "é invocável":** o guard prefixa com o nome que PROVADAMENTE invoca — `heavy` quando resolve no PATH, senão o **caminho absoluto**. O PATH do hook vem do processo do app, não do perfil de shell (mesma causa do fallback do `timeout` no `vigia-worktree.sh`), então o arquivo pode existir em `~/.local/bin` e o nome nu não resolver: a reescrita antiga (`arquivo existe` → prefixa `heavy` nu) entregava um comando que morria em **exit 127**, com a mensagem apontando pro lugar errado. Medido 2026-07-20: nesta máquina o PATH do app tem `~/.local/bin`, então a correção é proteção **latente** — o que ela fecha é o modo de falha, não um sintoma de hoje. O `--status` reporta "instalado mas fora do PATH" como **nota na mensagem, sem exit code próprio**: o PATH que ele lê é o do processo que o chamou (certo à mão no terminal, o do app pelo hook), e um 5º estado faria o bloco 4 avisar em toda sessão sobre um problema inexistente no shell onde o `heavy` roda — nag que queimaria o aviso de divergência, e que quebraria o contrato de silêncio do `test-hooks-sessionstart.sh`. Comando LONGO (codex, verify por bytes, build grande) → `timeout: 600000` no Bash tool — o default de 2min mata no meio (35 mortes por exit 143 no diagnóstico 2026-07).

## `git stash` em script + fila do `heavy` = trabalho fora do working tree (2026-07-18)

Script de diagnóstico que faz `git stash push` → roda algo pesado → `git stash pop` **fica preso na fila
do semáforo com o stash JÁ empilhado**. Enquanto espera slot, `git status` está limpo e o diff parece ter
evaporado — e se o processo morrer ali (timeout do Bash tool, `pkill`, teardown da sessão), o `pop` nunca
roda. Aconteceu no #1425 com 407 linhas de money-path: recuperado íntegro de `stash@{0}` (o `git stash
list` mostra `WIP on <seu-branch>`), mas o susto é evitável.

- **Commite ANTES de qualquer experimento que mexa em git** — commit local é reversível e tira o trabalho
  do limbo; stash não sobrevive a processo morto no meio.
- Para comparar "com × sem" a mudança, prefira **worktree separado em `origin/main`** a stash no worktree vivo.
- `pgrep -f <id-do-background>` **não** encontra o processo (o ID do harness não aparece no comando) —
  concluir "morreu" por aí é falso negativo. Confira pelo comando real (`pgrep -f "<trecho do script>"`).
- **`bunx vitest` também passa pelo `heavy`** (o hook reescreve): tirar o prefixo não tira da fila.

## MCPs enxutas

`.claude/settings.json` (comitado, **project > user**) desabilita 11 plugins sem uso no dev TS (adobe/mercadopago/sentry/slack/telegram/airtable/zapier/github/posthog/chrome-devtools/serena) + `ENABLE_CLAUDEAI_MCP_SERVERS=false`. **Mantidos:** superpowers/claude-mem/claude-md-management/context7. Religar pontual em `.claude/settings.local.json` (gitignored, precedência maior) + `/reload-plugins`. ⚠️ Desabilitar o **plugin** mata MCP **+ skills + hooks** dele. Worktrees criados via `bun run wt` (de `origin/main`) já nascem enxutos.
