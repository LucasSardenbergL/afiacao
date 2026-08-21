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

Irmã da colisão de migration acima — e o custo aqui não é sobrescrita
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

⚠️ **Sincronize antes de MEDIR — número tirado de base defasada é achado FALSO (2026-08-06).** A
mesma foto velha que causa retrabalho de código também contamina *medição*: uma sessão reportou
`bun run claude:size` = **2589 palavras** contra os **2495** reais da `origin/main`, porque a
worktree fora criada antes do #1733 e media a base sem ele. O erro é traiçoeiro porque a medição
*roda* e *sai verde* — não há sinal de que o denominador está errado (a regra "ausência de sinal não
é aprovação" na direção que ENGANA em vez de esconder). ⇒ toda medição que vira decisão (orçamento
de arquivo, contagem de call-sites, varredura de classe) começa por `git fetch` + medir
`git show origin/main:<arquivo>`, nunca a cópia da worktree. Irmã da re-medição de classe do
§paginação ("re-MEÇA contra a `origin/main` do instante, não contra a sua árvore").

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

⚠️ **E a varredura por TÍTULO é CEGA a quem já MERGEOU (2026-08-15).** Falsificado contra 3
duplicatas do mesmo dia: `git log origin/main --format='%s' | grep -c <símbolo>` → **0** para
`reposicao_pos_marcador` e `DENO_NO_PACKAGE_JSON`; `git grep <símbolo> origin/main` → **1** para os
dois. Duas causas independentes, cada uma bastando sozinha: (a) `gh pr list` lista **aberto** por
padrão, e o entregador já mergeara; (b) **o PR entrega sob o tema DELE** — o `c542210c` registrou a
RPC no manifesto como consequência de *"o eixo do gate passa a ver COMPRAS"*, sem nenhum termo que
você buscaria; quanto mais amplo o PR alheio, mais invisível ao título e mais provável que tenha
comido o seu item (ali comeu DOIS — o registro da RPC e um follow-up de doc, no mesmo commit).
⇒ procure o **ARTEFATO**, não o discurso sobre ele: `git fetch && git grep <símbolo> origin/main`
(`git log -S` para quem introduziu). O símbolo é literal e está na main se alguém entregou, tenha o
PR o nome que tiver — e sem o `git fetch` na frente o grep devolve "não existe" com cara de
procura de verdade. Caso completo: [duplicata-por-objetivo.md](../historico/duplicata-por-objetivo.md).

**…e o SÍMBOLO ainda é cego ao vocabulário alheio (2026-08-19, #1786).** O grep por artefato
resolve o eixo "título não descreve o conteúdo", mas cria outro ponto cego: ele só acha quem
escolheu a MESMA palavra que você. Nesta sessão, os follow-ups do challenge Codex incluíam
"medir cobertura útil em vez de `n > 0`" no sensor do farmer. A busca por `baskets`,
`pisoCobertura` e `insumos.baskets` em `origin/main` deu **0 hits nos três** — e o trabalho
equivalente já estava mergeado havia ~1h, sob o nome `carteira_com_historico_utilizavel`
(#1786). Zero hit não significou "ninguém fez"; significou "ninguém fez com o MEU nome".

⇒ O invariante não é o símbolo, é o **ARQUIVO**: `git log origin/main -- <path>` (ou
`--since=<data>`) lista quem mexeu ali seja qual for o vocabulário. Use os dois eixos — símbolo
para achar o artefato exato, arquivo para achar o CONCORRENTE. Regra prática: rode o `git log`
pelo arquivo que você está prestes a editar, **não** pelo conceito que você está prestes a criar.

Custo evitado ali: o `baskets` obrigatório teria degradado o head pela mesma causa que `regras`
já degradava — motivo apontando o sintoma, não a causa. Detectado a tempo de rebaixá-lo a
evidência; o diferencial real (a mecânica de cobertura, que o #1786 não tocou) foi preservado.

**Rede automática (2026-08-18):** hook `.claude/hooks/pr-duplicata-guard.sh` (PreToolUse Bash) —
irmão do `pr-collision-guard.sh`, que cobre só o eixo ARQUIVO. Nos DOIS chokepoints (`git commit` e
`gh pr create`) ele testa, por **(arquivo, símbolo)**, três vias: ausente do arquivo na merge-base + introduzido por mim +
**já presente no mesmo arquivo na `origin/main`**. As três juntas são a assinatura da duplicata; se a
main não andou naquele arquivo, (1) e (3) se contradizem e o hook cala — o silêncio é estrutural, não
sorte. **AVISA** via `additionalContext`, nunca nega (PR que ESTENDE de propósito o recém-mergeado
existe). Fail-open total (sem `jq`/`git`, sem merge-base, arquivo ausente da main → no-op).
⚠️ **O escopo por ARQUIVO foi medido, não escolhido:** `reposicao_pos_marcador` já vivia em 10
arquivos (migrations) na merge-base, então um teste repo-wide de "símbolo novo" o excluiria → falso
negativo em 1 das 3 ocorrências. Candidato = identificador de ≥12 chars com `_` ou corcova camelCase
(filtro de forma que mantém prosa portuguesa de `.md` fora). Testes:
`scripts/test-pr-duplicata-guard.sh` — 13 casos + **falsificação por sabotagem de cada via E de cada
decisão do gatilho 2** numa CÓPIA do hook (remover a via 1 ou a via 3, trocar o escopo por repo-wide,
fazer o commit olhar `mb..HEAD` em vez do índice, ou matar o dedupe: cada uma tem de virar vermelho).
⚠️ Ele **não rodava no CI** até 2026-08-18: o #1769 criou o arquivo e não o pôs no laço do
`test:hooks` (que listava os guards por nome). Teste órfão é `grep` sem ocorrência — ausência de
dado com cara de verde; corrigido junto com o gatilho 2.
**Limite:** pega o símbolo que você **escreve**; a duplicata cujo artefato é puro comportamento (mesma
correção, símbolos diferentes — o caso `DENO_NO_PACKAGE_JSON` só é pego porque o nome coincide)
continua fora do alcance, como a race fria de duas sessões sem PR aberto.

⚠️ **E o gatilho desceu para o `git commit` — o mesmo furo de TEMPO do guard irmão (2026-08-18).**
No `gh pr create` o trabalho JÁ está pronto: a detecção evita o merge duplicado, não o DESPERDÍCIO
(#1757 6 arq/+270; #1764 1 arq/+29, morto 36s depois de criado). O que muda no commit é a **fonte do
"meu trabalho"**: o alvo do diff passa a ser o **ÍNDICE** (`git diff <mb> --cached` = STAGED ∪ commits
da branch numa expressão só) e a **ÁRVORE** em `git commit -a`. Olhar só o `mb..HEAD` seria TEATRO —
no PRIMEIRO commit ele é VAZIO e o #1764 tinha 1 commit só; é a sabotagem (D) do teste, que tem de
emudecer o caso do #1764. Anti-alarm-fatigue (1 aviso por (branch, conjunto de achados); achado novo
fura o silêncio; o `create` nunca é silenciado) e a **ausência de cache de rede** vieram idênticos do
`pr-collision-guard`: o que corta ruído é o dedupe do AVISO (por conteúdo), nunca cache da RESPOSTA
(por tempo).

**Descer aqui não custa alarme NOVO, e isso é estrutural — não estimativa.** Disparar exige o símbolo
ausente em `<mb>:<arquivo>` **e** presente em `origin/main:<arquivo>` ⇒ a main mexeu naquele arquivo
desde a merge-base ⇒ o arquivo já está no conjunto (a) do `pr-collision-guard`, que avisa no commit
desde o #1770. Ou seja: **o conjunto de disparos deste guard é subconjunto do daquele** — ele nunca
fala onde o irmão cala, só acrescenta PRECISÃO (nomeia o símbolo) dentro de um aviso que já sairia.
Foi esse teorema, e não uma aposta de ruído, que autorizou a descida.

⚠️ **A precisão do eixo OBJETIVO é MODESTA — medido, não suposto (2026-08-18).** Replay do teste de
3 vias sobre **797 pares de PRs mergeados concorrentemente** (janela de 8h, 60 PRs): num teto
**pessimista** (merge-base propositalmente velha) o par (arquivo,símbolo) dispara em **51 de 134**
pares que compartilham arquivo — e como os dois PRs de cada par mergearam, ali todo disparo é falso
positivo.
A causa é o que conta como símbolo: "novo NO arquivo" inclui nome **referenciado**, não só criado
(`AUTHZ_MANIFEST`, `service_role`), e o ruído concentra em arquivo append-only compartilhado
(`docs/historico/*.md` + `scripts/audit-custom-migrations.sql` sozinhos = 27 dos 51). ⇒ a mensagem diz
"**possível** duplicata" e manda CONFERIR com `git log -S`; lê-la como veredito é erro de leitura.
**Filtrar `docs/` foi REJEITADO:** a ocorrência 2 das 3 reais era exatamente um follow-up de doc — o
filtro compraria silêncio ao preço de um falso negativo já medido.

**O que NÃO foi medido (registrado, não resolvido):** o falso positivo que só o gatilho do commit
pode criar — símbolo escrito no commit K e REMOVIDO até a ponta da branch, que o `create` nunca
veria. O replay por-commit das 60 branches reais (buscadas por `refs/pull/N/head`, que dão o
merge-base VERDADEIRO) foi montado e **não terminou** (~50min, morto antes do fim) ⇒ esse número não
existe; não o invente. O que existe é o limite superior: **38 das 60 branches têm 1 commit só** — ali
o gatilho dispara uma vez, com o trabalho inteiro no índice, e é a avaliação do `create` mais cedo,
sem janela nenhuma para transitório. Sobram 22 branches (2 a 9 commits) onde o transitório é
possível; e mesmo lá o aviso era VERDADEIRO no instante em que saiu (o símbolo estava escrito e
estava na main). ⇒ classe pequena e limitada, não zero.

**Custo que a descida introduz (medido no repo real, 2026-08-18):** ~4,2s por `git commit` — `git
fetch origin main` ~0,8-1,1s + ~170ms por arquivo (3 invocações de `git` cada, teto de 25 ⇒ pior
caso ~5s) — e isso **soma** com o fetch do `pr-collision-guard`, que roda no mesmo gatilho. Antes
era 1× por PR; agora é por commit. Não há como cortar pelo lado da rede: pular o fetch por
recência é justamente o cache de estado volátil rejeitado no #1770, e grep contra `origin/main`
defasada devolve "não existe" com cara de procura de verdade. Fica REGISTRADO, não otimizado —
otimizar sem sinal de incômodo é a fase N+1 sem sinal da fase N.

**Rede automática (2026-07-23):** hook `.claude/hooks/pr-collision-guard.sh` (PreToolUse Bash)
re-executa a conferência POR ARQUIVO na hora do `gh pr create` — fetch fresco + interseção de TRÊS
pontos com a `origin/main` + `gh pr list --json files` dos PRs abertos de outras branches — e
**AVISA** via `additionalContext` (nunca nega; fail-open granular: gh fora → checa só a main).
Testes: `scripts/test-pr-collision-guard.sh` (stub git+gh + falsificação por sabotagem do veredito).
Limites: cobre a re-checagem por ARQUIVO no create; a varredura por TEMA/título e a checagem
**pré-implementação** (bloco acima) seguem manuais — e a race fria (duas sessões, nenhum PR aberto)
continua fora do alcance.

⚠️ **A detecção no `gh pr create` evita a DUPLICATA, não o DESPERDÍCIO — o gatilho desceu para o
`git commit` (2026-08-15).** Dois PRs escritos, testados e jogados fora no mesmo dia, **com as duas
checagens da regra feitas**:

```
#1757  trabalho commitado 01:13 → PR criado 17:28 (16h depois!) → fechado 17:39   6 arq, +270
#1754  vencedor da mesma edge, mergeou 01:37 — 24min APÓS o commit do perdedor
#1764  vencedor (#1763) mergeou 18:12; commit do perdedor 18:21 → PR 18:21 → fechado 18:22  1 arq, +29
#1763  criado 18:07 → merge 18:12 — viveu 5min16s
```

Este é o eixo **TEMPO** (*quando* conferir); o eixo **OBJETIVO** (*o que* procurar — o artefato, não
o título) é o do bloco acima. Os dois são independentes: aqui as duas checagens da regra FORAM
feitas e no prazo — e ainda assim custaram dois PRs.

O detector **funcionou**: o #1764 morreu 36s depois de criado. O furo é de TIMING — no `create` o
trabalho já está pronto, então a rede evita o merge duplicado e não a hora perdida. O `git commit` é
o chokepoint anterior e é cadenciado pelo **trabalho**, não pelo relógio (as janelas medidas foram de
24min e 9min; um "re-cheque a cada 30min" acerta por sorte). No commit das 01:13 o #1754 estava
ABERTO → a via (b) do hook teria avisado; às 18:21 o #1763 já estava na main → via (a). Cobre os dois.

Detalhes que decidem entre rede e teatro:

- **O conjunto de arquivos é STAGED ∪ commits da branch** (∪ working-tree só em `git commit -a`).
  Olhar só o diff de 3 pontos seria TEATRO: no **primeiro** commit ele é VAZIO (provado em repo
  descartável) — e o #1764 tinha 1 commit só, exatamente o caso cego.
- **Anti-alarm-fatigue:** avisa 1× por (branch, conjunto colidente); colisão nova fura o silêncio, e
  o `gh pr create` nunca é silenciado (é o último portão). Commit é frequente — aviso repetido cega.
- **Sem cache da resposta do `gh`.** Uma versão com TTL de 2min foi escrita e DESCARTADA: mascarou
  colisão verdadeira nos próprios testes. Cache de "PRs abertos" não é como o do
  `branch-pos-squash-guard` — "meu PR já mergeou" é **monotônico**, "quais PRs estão abertos" é
  **volátil**, e cache de estado volátil num guard é falso-negativo silencioso. O que corta ruído é o
  dedupe do AVISO (por conteúdo), não cache da RESPOSTA (por tempo).

**Rejeitados (para não voltarem como ideia nova):**

- **PR draft vazio no minuto zero como "lock" consultável.** O post-mortem do #1526 aponta *"PR
  represado em draft é ÍMÃ"* como causa nº 1 de colisão; ~20 worktrees × draft vazio poluiriam o
  `gh pr list` e degradariam o sinal da própria checagem que se quer preservar; e um draft que saia
  do rascunho por engano auto-mergeia vazio. **Branch vazia + `git ls-remote`** troca poluição de PR
  por poluição de refs e só expõe nome/SHA — o escopo teria de caber no nome da branch (no #1764 o
  vencedor era `claude/mystifying-wescoff-e5c20d`, nome aleatório: invisível por nome).
- **Re-checagem periódica por relógio** (a cada N min): erra por sorte nas janelas medidas, e é
  ritual puro — o custo recai sobre quem já está no meio do trabalho.

**Limites conhecidos** (registrados, não resolvidos): o hook AVISA com `permissionDecision:"allow"`,
então o commit **acontece** e o aviso chega ao modelo na volta seguinte — serve para interromper a
escrita, não para barrar o commit. O dedupe é por conteúdo do aviso: um PR concorrente que muda de
conteúdo mantendo os mesmos arquivos não re-avisa dentro do TTL. E a **latência commit→PR** (as 16h
do #1757) não tem sensor — trabalho pronto e não publicado é exposição pura, e hoje só a disciplina
cobre isso. A 2ª opinião do Codex (2026-08-18) propõe para isso um *lease* local na primeira mutação
(as worktrees compartilham o `git-common-dir`) + um Stop guard de "commits sem PR"; ambos ficaram
FORA desta entrega por escopo — e valem só com sinal de que o backstop do commit não bastou.


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
| `bun run wt:orfas` | **read-only**: o inverso do `wt:prune` — cataloga a sessão cujo worktree JÁ foi removido (a pasta de transcript em `~/.claude/projects` sobrevive ao `worktree remove`) e diz **quais são CANDIDATAS a ter trabalho fora da main**. Em 2026-08-06: 104 órfãs, 15 com commit não entregue. `--todas` mostra as entregues; uma só chamada `gh pr list`. ⚠️ **Filtro de triagem, não veredito** — mede COMMIT fora da main, e com squash o conteúdo pode ter chegado por outro PR: das 40 candidatas de 2026-08-07, as **2 money-path estavam entregues**. Confirme cada uma com `mb=$(git merge-base origin/main <branch>) && git diff "$mb" <branch>` antes de agir. ⚠️ **`--is-ancestor` NÃO serve de prova aqui** (o auto-merge faz squash → nunca é ancestral) — a prova é `headRefOid` do PR MERGED == tip, e o que sobrou é `git rev-list --count <headRefOid>..<branch> --not origin/main`. As 4 armadilhas: [medicao-trabalho-nao-entregue.md](../historico/medicao-trabalho-nao-entregue.md) |

- **Worktree nasce pronto:** `bun run wt` roda `bun install` na criação; para worktree criado pelo app (`.claude/worktrees/*`), o hook `vigia-worktree.sh` (SessionStart) dispara `bun install` em background e avisa a sessão. ⚠️ **typecheck vermelho com `Cannot find module`/dep `@lovable/*` ausente = deps não instaladas, NÃO é CI vermelho** — o CI real se confere com `gh pr checks`. O mesmo hook alerta swap alto (>6GB) e >6 sessões Claude vivas — a alavanca real de RAM é FECHAR sessões (`wt:clean` num parque de sessões vivas libera 0MB).
- **Ritual de fecho** (gatilho "posso excluir a sessão?"): skill **`/fecho`** — PRs mergeados de verdade (gh), migrations aplicadas (psql-ro), edges/Publish, chips, resumo padrão, `wt:status` + ofertas de limpeza.

## `heavy` (semáforo de RAM)

Prefixe comandos PESADOS (test/build/typecheck/vitest) com **`heavy`** (`~/.local/bin/heavy`, fonte `scripts/heavy.sh`) — limita quantos rodam ao mesmo tempo entre TODOS os worktrees (auto-dimensiona; 1 slot na M2 8GB). Override `AFIACAO_MAX_HEAVY=N`.

⚠️ **`~/.local/bin/heavy` é CÓPIA, não symlink: mergear na `main` não atualiza o semáforo em uso** (mesma armadilha do Lovable — repo ≠ produção; o #1459 ficou mergeado e INERTE até a cópia manual). **Remédio: `bun run heavy:install`** (`scripts/heavy-install.sh`) — fonte **`origin/main`**, NÃO o `scripts/heavy.sh` desta worktree: em 2026-07-20, 32 das 39 worktrees carregavam o `heavy.sh` pré-#1459, então instalar "o daqui" andaria o semáforo **para trás** (`--daqui` força o local, para provar mudança em voo antes de mergear). A cópia é **atômica** (tmp no dir do DESTINO + `mv`): `cp` por cima do destino reescreve o MESMO inode e corrompe um `heavy` em execução, que relê o script por offset de byte — o `mv` publica inode novo e quem está na fila termina no arquivo antigo. Convivência de versões é segura (o antigo ignora o subdir `fila/`; só não entra no FIFO). O hook `vigia-worktree.sh` chama `heavy-install.sh --status` no SessionStart e segue o contrato de 4 estados: **sincronizado** e **em voo** (instalado == `scripts/heavy.sh` **desta** worktree, ≠ `origin/main` — alguém rodou `--daqui` de propósito) ficam em **silêncio**; **divergente** e **ausente** avisam; e se a comparação nem rodar (fonte ilegível, `mktemp` falhou, ou o próprio hook estourou o teto de 3s) o hook avisa **isso** — "não consegui verificar" —, nunca "divergente" (ausência de dado ≠ afirmação de divergência). Não auto-instala, porque o CI é ubuntu e **nunca prova o `heavy`** (`test-heavy.sh` é macOS-only). ⚠️ **Limite:** o silêncio do estado "em voo" só protege a worktree que rodou `--daqui` — nas outras, o `--status` compara contra o `heavy.sh` DELAS, dá **divergente**, e o hook sugere `bun run heavy:install` (no allowlist, roda sem prompt) — que reinstala `origin/main` por cima da mudança em voo. Se outra worktree instalou com `--daqui` de propósito, ignore o aviso ali. Symlink foi rejeitado: faria a versão em vigor ser função de qual branch o repo principal tem em check-out. Cobertura não é retroativa — worktree antiga não tem o hook novo nem o instalador.

**Três invariantes** (cada uma nasceu de bug medido em 2026-07-18, ~24 sessões/40 worktrees — `scripts/test-heavy.sh` prova as três sob concorrência, e cada asserção foi falsificada sabotando a correção):
1. **A vaga só volta quando a RAM volta.** O trap mata a ÁRVORE do filho (grupo de processos, via `set -m`) ANTES de soltar o slot. Antes, matar o wrapper deixava `bun`→`node tsc` vivos *e* devolvia a vaga: o semáforo mentia e o órfão seguia comendo a RAM cuja falta causou a espera.
2. **Capacidade é CONTAGEM, não índice.** Admissão compara slots vivos com o total. O mesmo defeito dava dois sinais opostos: índice baixo ocupado → travava e `--status` dizia `-1 livre(s)`; índice alto ocupado → sobrava índice no meio e um 3º furava um teto de 2. Política adotada: **piso dinâmico** — o total segue acompanhando a RAM real, mas as vagas saturam em 0 e a sobrecarga vira frase legível ("N acima do teto atual; drenando"). Rejeitadas: *persistir* congela um número medido num instante arbitrário; *sobre-inscrever* é o que o bug já fazia por acidente.
3. **Quem chega primeiro entra primeiro.** Fila FIFO por ticket (timestamp ns em `$LOCKDIR/fila`), visível em `heavy --status`. Antes era corrida de despertar — medido: 21min05 de espera perdendo para 2min00. O FIFO custa vazão (só a cabeça pode ocupar a vaga), então o poll é adaptativo: quem está a ≤2 posições de entrar checa a 0,2s, o resto da fila a 2s. Sem isso, 24 jobs curtos escoavam em 50s contra 10s do polling desordenado; com isso, 13s **e** ordem exata. Hook `heavy-guard` (PreToolUse Bash, `.claude/hooks/heavy-guard.sh`) **REESCREVE** test/build/typecheck sem `heavy` (updatedInput prefixa o semáforo — sem round-trip de negação nem classificador; fail-safe: não age sem `heavy` instalado nem em leitura; testes `scripts/test-heavy-guard.sh`). ⚠️ **"Menção" ≠ "execução":** o guard casa por PADRÃO DE TEXTO no comando, e casava também DENTRO de heredoc/aspas — texto que o comando **grava**, não executa. Em 2026-08-18 (#1770) uma sessão gravou o step do CI com `python3 - <<'PY' … run: bun run test:hooks … PY` e o `.github/workflows/ci.yml` saiu com `run: heavy bun run test:hooks`: no runner ubuntu o `heavy` não existe → 127 e `validate` VERMELHO, **e só no CI** (local passava — o hook nem roda lá). O remédio é o mesmo bloco perl que o `pr-collision-guard`/`pr-duplicata-guard` já usavam (problema de classe), mas aqui em **duas metades, ambas necessárias**: sanitizar antes de **detectar** *e* pular as regiões protegidas ao **reescrever** — num comando MISTO (grava o step *e* roda o teste de verdade) o gate manda reescrever, e um `s///` cego enfia o prefixo no texto gravado. Corolário para QUALQUER hook que reescreve: o teste tem de provar as duas coisas — que a menção não vira execução **e** que a execução real continua sendo pega (senão o "fix" vira desligar o guard quando há heredoc). ⚠️ **"Existe" ≠ "é invocável":** o guard prefixa com o nome que PROVADAMENTE invoca — `heavy` quando resolve no PATH, senão o **caminho absoluto**. O PATH do hook vem do processo do app, não do perfil de shell (mesma causa do fallback do `timeout` no `vigia-worktree.sh`), então o arquivo pode existir em `~/.local/bin` e o nome nu não resolver: a reescrita antiga (`arquivo existe` → prefixa `heavy` nu) entregava um comando que morria em **exit 127**, com a mensagem apontando pro lugar errado. Medido 2026-07-20: nesta máquina o PATH do app tem `~/.local/bin`, então a correção é proteção **latente** — o que ela fecha é o modo de falha, não um sintoma de hoje. O `--status` reporta "instalado mas fora do PATH" como **nota na mensagem, sem exit code próprio**: o PATH que ele lê é o do processo que o chamou (certo à mão no terminal, o do app pelo hook), e um 5º estado faria o bloco 4 avisar em toda sessão sobre um problema inexistente no shell onde o `heavy` roda — nag que queimaria o aviso de divergência, e que quebraria o contrato de silêncio do `test-hooks-sessionstart.sh`. Comando LONGO (codex, verify por bytes, build grande) → `timeout: 600000` no Bash tool — o default de 2min mata no meio (35 mortes por exit 143 no diagnóstico 2026-07).

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
- **`bunx vitest` também passa pelo `heavy`** (o hook reescreve): tirar o prefixo não tira da fila. Idem `./node_modules/.bin/vitest` — o hook nega com a mensagem do §2, então **não existe atalho local**: quando a fila trava, o oráculo é o **CI**, não um bypass.
- ⚠️ **O `heavy` ABORTA por timeout de fila (1800s) — e num comando composto a notificação de background reporta SUCESSO** (medido 2026-08-06, fila com 18 sessões vivas e swap em 6,5GB). O semáforo desiste com `heavy: timeout (1800s) esperando vaga — abortando. (posição 1 na fila)` e sai **1**; mas em `heavy … > log 2>&1; echo "exit=$?"` o exit do COMPOSTO é o do `echo` (**0**), e é esse que o harness anuncia como *"completed (exit code 0)"*. Quem lê só a notificação conclui que o teste **passou**, quando ele **nunca rodou** — a família do `| tail` que engole o exit, agora no anúncio do background. ⇒ **o denominador é o juiz**: log sem a linha `Tests N passed (N)` é ausência de dado, jamais aprovação (§"validação só conta com EVIDÊNCIA POSITIVA"). Note também que a posição na fila **anda para trás** (5º→6º) quando outras sessões entram — "está andando" não prevê conclusão. Com a fila saturada, arme o PR (draft) e deixe o **CI** validar: roda em nuvem, não disputa a RAM da M2, e cobre typecheck+lint+knip+manifesto de uma vez. Prove que o SEU teste rodou lá procurando a linha `✓ <caminho do arquivo> (N tests)` no log do job — `validate` verde sozinho **não** diz que o arquivo novo entrou na suíte.
- ⚠️ **`/tmp/<nome-genérico>.log` é COMPARTILHADO entre as sessões — e o log que você lê pode ser de OUTRA** (mordido 2026-08-07, 31 sessões vivas). Redirecionar para `/tmp/test.log` e depois lê-lo parece inocente; com dezenas de worktrees escrevendo no mesmo caminho, o `tail` traz o resultado alheio. O sintoma é **cruel porque é bonito**: li `Test Files 656 passed | Tests 6036 passed` e quase reportei a entrega como validada — o meu comando ainda estava **na fila do `heavy`**, sem ter aberto o arquivo. O que denunciou foi o **carimbo de hora** (`Start at 22:10:55`, anterior ao meu disparo), não o conteúdo. ⇒ **escreva log no diretório de scratchpad da SESSÃO** (o harness fornece um, isolado por sessão), nunca em `/tmp/<nome-óbvio>.log`; e desconfie de log cujo horário não bate com o seu disparo. Mesma família do `| tail` que engole o exit: a evidência existe, mas é de outro experimento.
- ⚠️ **Watcher com `grep` do próprio marcador casa o ECO do comando e declara conclusão falsa.** `grep -qE "TEST_EXIT"` sobre a saída de um job enfileirado casou com a **mensagem da fila do `heavy`**, que imprime o comando inteiro (`… echo "TEST_EXIT=$?"`) — o watcher anunciou "HEAVY TERMINOU" com o job em 9º lugar e o log inexistente. É o §"case string exclusiva do ramo certo" aplicado a si mesmo: o marcador que você inventa para detectar o fim **está dentro do comando** e portanto dentro de qualquer eco dele. ⇒ ancore em **início de linha** (`grep "^TEST_EXIT="`), ou espere pela **existência do arquivo de log**, ou consulte o estado real (`gh pr checks`) em vez de raspar texto.
- ⚠️ **`git checkout -b <nova> origin/main` seguido de `git checkout <antiga> -- <arquivo>` APAGA o edit uncommitted daquele arquivo** (mordido 2026-08-06, ao mover uma lição de doc para branch própria depois do merge). O `checkout -- <path>` restaura a versão **commitada** da branch citada; a edição que só existia no working tree não está em commit nenhum e **some sem aviso** — `git status` fica limpo e parece que nada havia. É o mesmo mecanismo do §9 do money-path ("restaurar sabotagem com `git checkout --` destrói fix uncommitted"), aqui no fluxo inocente de *"vou levar esta mudança para um PR separado"*. ⇒ **commite ANTES de trocar de branch** (ou `git stash` / `cp` do arquivo), nunca conte com o working tree para atravessar um checkout.
- ⚠️ **Log em `/private/tmp` não atravessa REBOOT — e o scratchpad da sessão mora lá dentro.** Mordido 2026-08-20: armei `pr-watch.sh 1811 > /tmp/prwatch-1811.log`, o PR mergeou 10min depois e, horas mais tarde, o log **não existia**. Apliquei a regra do CLAUDE.md ("saída VAZIA de job verde = não rodou"), concluí que o watcher nunca rodou e **reportei isso ao founder** — errado. A máquina havia reiniciado (`sysctl -n kern.boottime` = 21:54; o merge foi 12:53) e o boot limpa `/private/tmp` INTEIRO: sumiram os 8 logs da sessão **e** o `fn.mjs` do scratchpad, que é `/private/tmp/claude-501/<sessão>/scratchpad` — ou seja, a bullet acima ("escreva no scratchpad") resolve a COLISÃO entre sessões, não a DURABILIDADE. ⇒ dentro de uma janela contínua, log ausente é sinal de "não rodou"; **atravessando pausa longa ele não distingue "não rodou" de "foi limpo"** e vira ausência de dado — o que aconteceu de fato é **indecidível**, porque a evidência foi destruída. Evidência que precisa sobreviver a uma pausa vai para o **worktree** (commit), não para `/tmp`. E desfecho de PR se confirma com `gh pr view`/`gh pr checks`, NUNCA com a presença do log do watcher — é o que a regra do **exit 6** já manda.

## MCPs enxutas

`.claude/settings.json` (comitado, **project > user**) desabilita 11 plugins sem uso no dev TS (adobe/mercadopago/sentry/slack/telegram/airtable/zapier/github/posthog/chrome-devtools/serena) + `disableClaudeAiConnectors: true`. **Mantidos:** superpowers/claude-mem/claude-md-management/context7.

⚠️ **`ENABLE_CLAUDEAI_MCP_SERVERS=false` era INERTE** (chave inventada, não existe no schema) — ficou 
no arquivo parecendo que desligava os connectors da conta claude.ai enquanto Gmail/Calendar/Drive 
carregavam em toda sessão do app. O switch certo é a chave de topo `disableClaudeAiConnectors`. 
Falha SILENCIOSA e invisível ao CLI: `scripts/piso-contexto.sh` **não reproduz** isto — o CLI nunca 
carrega connector da conta, então a sonda dá delta zero com ou sem o fix. Evidência tem que vir de 
sessão NOVA do app (a lista de tools não pode mais ter servidor `mcp__<uuid>__*`) ou do 
`tokens-report.sh`. Uso medido dos 3 connectors em 48 dias: **zero chamadas**. Religar pontual em `.claude/settings.local.json` (gitignored, precedência maior) + `/reload-plugins`. ⚠️ Desabilitar o **plugin** mata MCP **+ skills + hooks** dele. Worktrees criados via `bun run wt` (de `origin/main`) já nascem enxutos.
