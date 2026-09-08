# Evidência POSITIVA — e as armadilhas de shell que fabricam VEREDITO

> **A regra que sobrou no CLAUDE.md:** validação só conta com **evidência positiva** — rode o
> comando autoritativo, confirme que **terminou**, capture `exit 0`. Este doc guarda o *porquê*
> e o catálogo de armadilhas, que não cabia mais lá.

> **Por que o CLAUDE.md não numera as armadilhas:** ele numerava, e a contagem lá já mentiu uma
> vez (`b1a7773a0` — o parêntese anunciava "7" e listava 6). Ao chegar a 9ª (2026-08-23) o teto da
> seção estourou em 8 palavras, e a política é não pagar encolhendo outra lição — então o número
> saiu de lá: o parêntese do CLAUDE.md é **amostra**, este doc é o **inventário**. Dois números
> para o mesmo fato divergem; um número não tem com quem divergir.

**Quando:** consolidado em 2026-08-22, ao compactar o CLAUDE.md (o bullet tinha crescido para
1.346 chars / 224 palavras — a maior linha do arquivo, ~9% do orçamento inteiro).

## A doutrina

**Ausência de sinal NÃO é aprovação.** São *ausência de dado*, não veredito:

- processo **enfileirado** (o `heavy` pode estar esperando o semáforo, não rodando — §7);
- log **sem a linha de conclusão** (começou ≠ terminou);
- `grep` **sem ocorrência** — ⚠️ confira **caixa e acento** antes de concluir "não existe";
- **linter que não tem a regra** (verde porque não olhou, não porque está limpo).

O erro de classe: tratar "não vi nada errado" como "está certo". Um comando que **falhou ao
rodar** (glob não expandido, arquivo inexistente, flag inválida) devolve zero linhas — idêntico,
na tela, a uma busca que rodou e não achou nada. Só o **exit code** e o **formato da saída**
distinguem os dois.

## As armadilhas

### 1. `cmd | tail` ENGOLE o exit code
O pipeline devolve o status do **último** componente. `bun run test | tail -5` é sempre verde.
⇒ `cmd > log 2>&1; e=$?` e só então inspecione o log.

### 2. `$?` mede o ÚLTIMO comando — um `echo`/`cat` no meio já sobrescreve
```bash
minha_suite > log 2>&1
echo "terminou"      # <-- $? agora é do echo (0), SEMPRE
if [ $? -eq 0 ]; then ...   # mede o echo, não a suíte
```
⇒ capture **colado** ao comando medido. Corolário: **saída VAZIA de um job "verde" = não rodou**.

### 3. No zsh, `echo "$json" | jq` CORROMPE o JSON
O `echo` do zsh interpreta escapes (`\n`, `\t`) dentro da string. ⇒ **sempre**
`printf '%s' "$x" | jq`. (Vivo em `scripts/test-read-contexto-nudge.sh` e
`scripts/test-stop-contexto-caro.sh`.)

### 4. O `grep` daqui é shim para `ugrep` — dobra acento em TODO locale
`grep` é uma **função de shell** (snapshot do zsh), não o binário. O `ugrep` faz *accent folding*
em qualquer locale, então `grep "sessao"` casa "sessão" — ótimo para achar, **péssimo para provar
ausência** ou para reproduzir o comportamento do CI. ⇒ use **`command grep`** ao reproduzir ou ao
afirmar "não existe". Tratamento mais fundo: `docs/agent/money-path.md`.

### 5. Log em `/tmp` não atravessa PAUSA
`/private/tmp` — **e o scratchpad da sessão mora lá dentro** — morre no reboot. Log ausente depois
de uma pausa longa **não distingue** "não rodou" de "foi limpo". ⇒ desfecho de PR se apura com
`gh pr view <nº>`, **nunca** pelo log do watcher. Mais em `docs/agent/worktrees.md`
(§`git stash` / fila do `heavy`).

### 6. Flag homônima entre BSD e GNU não FALHA — faz OUTRA coisa
`stat -f` é **formato** no macOS e **`--file-system`** no Linux. O GNU ainda cospe ~5 linhas no
**stdout ANTES** de sair `!= 0`, então o idioma `a || b` **concatena lixo** em vez de cair no
fallback. ⇒ valide o **FORMATO esperado** da saída, não o exit do 1º ramo, e teste os **DOIS**
contratos por stub. Caso medido e o idioma correto: `docs/agent/worktrees.md`
(§Portabilidade BSD × GNU).

**Segundo caso, 2026-09-07 — `mktemp -t`, e o custo de só rodar num SO.** No BSD/macOS,
`mktemp -t ocupacao-contexto` trata o argumento como **prefixo** e funciona. No GNU (o CI) ele é
um **template**, que exige ≥3 `X` consecutivos: `mktemp: too few X's in template`, exit 1, e sob
`set -e` o script inteiro morre — sem chegar em nenhuma das suas próprias mensagens de erro.

O que torna este caso instrutivo não é a flag, é o **arnês**: a suíte tinha 12 casos, 10
sabotagens e falsificação nos dois locales, e mesmo assim saiu **verde no macOS e vermelha no
Linux pelo mesmo commit**. Falsificar em dois *locales* não diz nada sobre dois *sistemas
operacionais* — são eixos independentes, e cobrir um com capricho não compra o outro. O aviso do
CLAUDE.md (*"falsificar em UM ambiente não prova a asserção"*) vale para **qualquer** eixo de
ambiente, não só o locale em que ele foi aprendido.

A forma portável é template explícito, nunca `-t`:

```bash
BRUTO=$(mktemp "${TMPDIR:-/tmp}/ocupacao-contexto.XXXXXX")   # idêntico nos dois
```

E a contramedida que esta seção já prescrevia — **testar o outro contrato por stub** — é barata o
bastante para caber no teste: um `mktemp` falso no `PATH` que reproduz a exigência dos X's, com
**controle positivo do próprio stub** (ele tem de reprovar a forma BSD; um stub inerte aprovaria
tudo). Implementado em
[`scripts/test-ocupacao-por-arquivo.sh`](../../scripts/test-ocupacao-por-arquivo.sh), caso 10.

### 7. O WRAPPER devolve exit≠0 por conta PRÓPRIA — igualzinho ao comando embrulhado
```
heavy: timeout (1800s) esperando vaga — abortando. (posição 1 na fila)
exit=1
```
Medido em 2026-08-22 (sessão do #1893): o `heavy` (semáforo de RAM) abortou **na fila** e devolveu
`exit=1` — o mesmo código de um teste vermelho. O vitest **nunca rodou**. É a mais traiçoeira da
lista porque não produz ausência, produz um **veredito**: entrega um número plausível para reportar
como "falhou". Vale para todo wrapper (`heavy`, `timeout`, retry, `xargs`, `sudo`, `docker run`) —
o exit dele ocupa a mesma faixa do exit do comando de dentro, e código nenhum separa sozinho
"rodou e falhou" de "nem começou".

⇒ exija **sinal do comando INTERNO**: a linha `Test Files N passed` do vitest, ou um marcador que o
lado de DENTRO escreveu.
```bash
# roda-tudo.sh — tudo isto corre DENTRO do wrapper
bun run typecheck > tc.log 2>&1; echo "TYPECHECK_EXIT=$?" >> exits.txt   # colado (§2)
bun run test      > vt.log 2>&1; echo "VITEST_EXIT=$?"    >> exits.txt
echo FIM >> exits.txt

heavy bash roda-tudo.sh    # o wrapper embrulha o script INTEIRO
```
O consumidor **não lê código nenhum antes de achar a linha `FIM`**: sem ela o veredito é "não
rodou", nunca "falhou" — e isso independe do que o `heavy` devolveu. O caso concreto tinha sido
anotado só de passagem em `docs/historico/medicao-trabalho-nao-entregue.md`; a classe é geral.

**Irmã, na mesma sessão — a conclusão impressa por `echo`:**
```bash
command grep -rn 'padrao' src --include=*.tsx   # sem aspas o zsh expande o glob: o grep NEM RODA
echo "(vazio = nenhum consumidor)"              # imprime a conclusão do mesmo jeito
```
A frase-veredito não depende do comando: sai idêntica se ele rodou limpo, se falhou ou se nem
existiu. ⇒ aspe o glob (`--include='*.tsx'`) e **derive a conclusão do resultado** em vez de
escrevê-la ao lado dele. (É o §2 por outro ângulo: lá o `echo` sobrescreve o `$?`; aqui ele fabrica
o veredito.)

### 8. O `; echo "exit=$?"` no fim mente para o HARNESS — mesmo imprimindo a verdade

Irmã do §2, e mais traiçoeira, porque o número **impresso está certo**:

```bash
bash scripts/pr-watch.sh 1888; echo "PR-WATCH exit=$?"
#            \_ devolve 5 (sem desfecho)   \_ imprime "PR-WATCH exit=5"  <- VERDADE
# ...mas o exit status do COMPOUND e o do `echo` = 0                       <- o que sobra
```

O `$?` foi capturado colado e a linha diz o certo. A mentira mora num **segundo canal**: o status
do comando composto, que é o do último elemento — o `echo`. Quem lê o *exit code* (o harness que
reporta a task, um `&&` encadeado, um step de CI) vê **0** e nunca lê a linha impressa.

Medido **duas vezes na mesma sessão** (2026-08-22, PR #1888), por quem já conhecia o §2:

| Comando | Harness reportou | Verdade, na saída |
|---|---|---|
| `heavy bun run typecheck; echo …` | `completed (exit code 0)` | `heavy: timeout (1800s) — abortando` — **nunca rodou** |
| `bash scripts/pr-watch.sh 1888; echo …` | `completed (exit code 0)` | `PR-WATCH exit=5` — consultei, **sem desfecho** |

O segundo caso é o pior possível: no contrato do `pr-watch`, **exit 0 significa MERGEADO**. A máscara
não produziu "desconhecido", produziu uma **afirmação falsa e específica** — um merge que não tinha
acontecido, pronto para ser reportado ao founder. O que salvou foi a regra do CLAUDE.md de confirmar
desfecho com `gh pr view <nº>` antes de avisar: ela existe justamente porque o canal do watcher não é
confiável sozinho.

⇒ **não termine em `echo` um comando cujo exit code alguém vai ler.** Rode pelado, ou preserve:
```bash
cmd > log 2>&1; rc=$?; echo "exit=$rc"; exit $rc     # o compound volta a valer o que mede
exec bash scripts/pr-watch.sh 1888                   # ou: nada depois dele
```
Combina com o §7: lá o wrapper **fabrica** um veredito; aqui o `echo` **apaga** o veredito — inclusive
o do wrapper. No caso do typecheck as duas agiram juntas, e o `abortando` do `heavy` só apareceu porque
alguém foi ler o log em vez do código de saída.

### 9. `${PIPESTATUS[0]}` no zsh é VAZIO — e vazio, ali, vale ZERO

A contramedida da §1 é ela própria uma armadilha fora do bash. `PIPESTATUS` é **bash**; o zsh tem
`pipestatus` — **minúsculo e 1-indexed**. O nome errado não dá erro: expande para vazio.

E vazio, no `[` do zsh, **não é "sem dado" — é `0`**, que por acaso é o exit code de SUCESSO:

```bash
false | true                                                    # o pipeline FALHOU
if [ "${PIPESTATUS[0]}" -eq 0 ]; then echo "PIPELINE OK"; fi    # imprime OK
```

Medido nos DOIS shells (2026-08-23; o Bash tool desta sessão roda em `/bin/zsh`, e o teste usou
`zsh -f`/`bash` para provar que é o shell, não a config do usuário):

| | `${PIPESTATUS[0]}` | `${pipestatus[1]}` | `[ "" -eq 0 ]` |
|---|---|---|---|
| **bash** (controle) | `1` ✓ | vazio | **erro alto**: `integer expression expected` |
| **zsh** (o nosso) | **vazio** | `1` ✓ | **verdadeiro, e calado** |

É a §6 pelo AVESSO: lá a divergência BSD×GNU fazia "outra coisa" em silêncio; aqui quem falha alto é
o **bash** — a proteção mora no shell que não estamos usando, e nada avisa na travessia. E é o
`?? 0` do money-path na camada de evidência: exit code **ausente** vira **aprovação**
(`docs/agent/money-path.md` §2, ausente ≠ zero). Sem `set -u` o silêncio é total — o `[` nem
reclama, devolve 1, e o `if` cai no ramo do "passou".

⇒ **não porte o idioma do bash.** Capture pelado, sem pipe (`cmd > log 2>&1; rc=$?` — §1), ou use
`${pipestatus[1]}` assumindo zsh-only. E **`set -u` converte esta classe inteira em aborto**
(`zsh: PIPESTATUS[0]: parameter not set`, exit 1): é a única linha que transforma o silêncio em
vermelho, e vale para todo bash-ism que só se manifesta como string vazia.

Achado no próprio trabalho, não em laboratório: nesta sessão um `git push … | tail` seguido de
`echo "EXIT_PUSH=${PIPESTATUS[0]}"` imprimiu `EXIT_PUSH=` — uma linha com **cara** de captura de
exit code e nenhum dado dentro. O push tinha funcionado, mas quem provou isso foi
`git rev-parse HEAD origin/<branch> | uniq -c` (duas refs, uma linha), não a linha do exit.

**Gate estrutural (contramedida textual reincide).** O hook PreToolUse
`.claude/hooks/pipestatus-zsh-guard.sh` AVISA quando o comando lê esse exit code — inclusive na
forma sem cifrão, porque a aritmética do zsh (`(( ))`, `[[ ]]`, `let`) avalia o identificador NU e
trata ausente como 0. Menção não dispara: aspas simples, heredoc quoted, comentário e `$'...'` saem
por um scanner de quoting, então `git commit -m` e `grep` pelo nome seguem calados.

Ele nasceu BLOQUEANTE e foi rebaixado a aviso pela revisão adversária (`/codex`, enquadramento
defensivo de COBERTURA): o Codex mostrou que a aposta "se o zsh expande, é bug; se não expande, é
legítimo" tem furo nos DOIS sentidos — deixava passar `(( PIPESTATUS[0] == 0 ))` e barrava
`echo x # ${PIPESTATUS[0]}` (comentário não expande nada), que é o precedente de 2026-06-24 se
repetindo no guard que jurava tê-lo fechado por construção. **A moral é a 10ª armadilha em
miniatura: um detector de padrão de shell não herda a semântica do shell.** Um guard com falso
negativo E falso positivo comprovados não tem a precisão que justifica bloquear — e como aviso o
falso positivo custa uma linha de contexto, o que permitiu ampliar a detecção em vez de encolhê-la.


**O sensor, e o invariante que eu tinha "provado" no caso típico.** Aviso sem registro é promessa
inalcançável — "endurecer quando houver dado" precisa do dado. O hook grava JSONL em
`~/.claude/afiacao-pipestatus-guard.jsonl` e `scripts/pipestatus-guard-sinal.sh` é a query (log sem
query não é sensor, é lixo). Segunda rodada de `/codex` defensivo, três achados, todos reais:

- **Truncar o campo não limita a linha.** Eu cortava o trecho em 160 e media 176 bytes — com dado
  típico. O escape do JSON infla DEPOIS do corte: cada `"` vira `\"`, cada byte de controle vira
  `\u00XX` (6 bytes). Medido no pior caso: **1010 bytes** — o dobro do `PIPE_BUF` do macOS, que é
  **512** e não os 4096 do Linux. Acima dele o append entre as ~30 worktrees pode picotar. O teto
  passou a ser conferido na LINHA PRONTA, num laço que encolhe o trecho até caber; `jq -a` força
  saída ASCII para que `${#linha}` conte bytes em qualquer locale, sem fork.
- **Parse OK não é schema OK.** Um JSONL de linhas válidas sem os campos do sensor produzia
  relatório de `null` com exit 0 — ausência de dado servida como medição, o vício que o sensor
  existe para não cometer. Agora é `SCHEMA-ESTRANHO` (exit 65), e log misto declara o que ignorou.
- **Log de fragmento de comando nascia 0644.** Herdado do umask, nunca medido. Nasce 0600.

E a lição de método, que veio da falsificação e não do Codex: **o caso de teste pode não exercitar
o invariante que o teste afirma provar.** Sabotei o teto e o teste seguiu VERDE — porque eu enchia
o comando de acentos, que param em 414 bytes sozinhos. O vetor real era match GRANDE, não comando
grande: `\$\{[^}]*PIPESTATUS` não tem limite, então a janela de contexto cresce junto com ele.
Sem a falsificação eu teria entregue um teste que passa com e sem o código que ele testa.

**O 3º ramo: `; echo "EXIT=$?"` no fim.** Mesma família, gatilho diferente. O número impresso está
certo — é o do comando anterior — mas o exit code do **compound** passa a ser o do `echo`, que é 0
sempre. Quem lê o código em vez do texto (o harness, a notificação de tarefa em background, um
`&&` adiante) recebe SUCESSO com o trabalho quebrado. Numa única sessão isto produziu **três**
notificações de "exit code 0" enganosas: um `test:hooks` com 4 falhas, um `codex exec` que falhou
por DNS nas 3 tentativas, e um watcher. O ramo se validou sozinho: disparou duas vezes nos meus
próprios comandos durante a implementação dele.

O `/codex` defensivo (rodada de cobertura, nunca "como burlar") derrubou a primeira versão em três
pontos, todos reproduzidos em `zsh -f` antes de virar código. **O falso positivo era o mais caro:**
`false && echo "EXIT=$?"` disparava, mas ali o `echo` nem executa quando o trabalho falha — o
compound devolve 1, fiel. Depois de `&&`/`||` o relator nunca fabrica sucesso, então avisar é puro
ruído, e ruído custa a credibilidade dos **três** ramos de uma vez. Os dois falsos negativos eram
cotidianos: `cmd; echo "EXIT=$?";` com **ponto-e-vírgula terminal** (o último segmento ficava vazio)
e `echo "EXIT=$?" >&2`, onde o `&` da redireção era lido como separador de comando.

Precisão acima de recall, porque `echo $?` é comum e quase sempre legítimo — guard que vira ruído
ensina a ignorar os outros dois ramos. Exige TRÊS condições, e cada negativo depende de uma
diferente: existe trabalho antes (`echo $?` sozinho não mente sobre nada) · o último segmento
começa com `echo`/`printf` (`rc=$?` usado adiante é o idioma CORRETO) · contém `$?`.

**O sensor media a própria suíte.** A suíte do guard invocava o hook sem isolar
`PIPESTATUS_GUARD_LOG`, então cada `bun run test:hooks` injetava ~39 disparos sintéticos no log de
campo — a query passaria a contar teste como uso real. Não foi o Codex nem o teste que revelou:
foi olhar o log e ver que os "disparos" eram `false | true; [[ pipestatus[0] -eq 0 ]]`, ou seja, os
próprios casos P1-P10. **Sensor cujo ruído vem do seu próprio teste não mede nada** — e a suíte é
o ruído mais fácil de esquecer, porque roda em CI, sem ninguém olhando.

**A falsificação errou o alvo — de novo, na mesma sessão.** Para falsificar a regra do "último
comando", sabotei a extração do segmento e testei com E6 (`rc=$?` usado no fim) e E7 (echo no
meio). E6 seguiu calado — e seguiria de qualquer jeito, porque E6 nem tem `echo`: ele é protegido
pela exigência de `echo|printf`, não pela regra sabotada. A falsificação atacava uma regra e media
casos defendidos por outra, e teria dado verde a uma sabotagem que não sabotou nada.
**Quando o código tem N regras independentes, cada caso de falsificação precisa depender da regra
que você está desligando** — senão o vermelho (ou o verde) vem por motivo alheio.


**A revisão retroativa do sensor: cinco defeitos, e a maioria era "mede errado", não "quebra".**
A primeira revisão do sensor ficou pela metade (o Codex morreu por infra). Refeita com calma, as
medições próprias acharam:

- **A redação de segredo cobria pouco.** Só `Bearer`, JWT e `chave=valor`. Escapavam para o disco em
  texto plano: `Authorization: token ghp_…`, `curl -u user:senha`, `postgres://u:senha@host` e
  `--password senha` (com **espaço**, não `=`). Log é disco, e o CLAUDE.md proíbe segredo em texto
  plano em disco.
- **Uma única linha picotada matava o relatório inteiro.** `jq -s` aborta na primeira linha
  inválida, então `exit 65` e 100% do sinal perdido — num log que ~30 worktrees escrevem em append,
  onde picote é acidente esperado. Agora é `jq -R 'fromjson? // empty'`: a linha ruim vira `empty`,
  as boas contam, e o relatório **declara** quantas ignorou.
- **`wt` gravava o basename do CWD, não da worktree.** Rodando de `<worktree>/src/lib` o log dizia
  `lib`. O agrupamento "por worktree" era ficção, e duas worktrees em `src/lib` colidiriam.
- **"Padrões distintos" contava INSTÂNCIAS.** Três disparos do mesmo erro, diferindo só no nome do
  arquivo de log, viravam três "padrões" — e o veredito manda o humano classificar um por um, o que
  torna "zero falso positivo" inatingível por construção. Agora a query normaliza caminhos e números
  antes de agrupar, e exibe um exemplo real.
- **Corte silencioso.** Top-15 de padrões e top-8 de worktrees sem dizer quantos ficaram de fora —
  enquanto o veredito mandava "classificar os N padrões **acima**". O CLAUDE.md já proíbe isso
  (`no silent caps`); o sensor o cometia no próprio relatório.

O `/codex` retroativo então achou o que eu não tinha achado, e era o pior de todos: **o critério de
veredito contava linhas BRUTAS.** Dois eventos reais mais dezoito linhas de outro schema imprimiam,
na mesma tela, `Disparos: 2`, `18 ignoradas` e `[x] >= 20 disparos` → "Volume e janela OK". O sensor
construído para não fabricar veredito fabricava o próprio. **Passou pela suíte porque o ramo
POSITIVO do veredito nunca teve teste** — toda fixture existente ficava abaixo do limiar, então o
caminho que continha o bug nunca era executado. Junto vieram: "14 dias de observação" que era só a
distância entre o primeiro e o último evento (um disparo em 01/08 e dezenove retries em 20/08
satisfaziam janela e volume), e agrupamento por `trecho` sem o `ramo`, que juntava ramos diferentes
numa classe só quando o trecho colidia.

Ele também derrubou uma premissa que eu tinha escrito como garantia: **`PIPE_BUF` não é o limite
normativo para arquivo regular** — vale para pipe/FIFO. O que protege o append é o `O_APPEND` e a
linha curta tornar provável um único `write`; em NFS o append é simulado pelo cliente e pode
corromper de todo jeito. A defesa real não é o teto, é a query tolerar linha picotada.

E três asserções não provavam o que diziam: `all(.trecho != "")` passa com o campo AUSENTE
(`null != ""` é true em jq); a que "agrupava padrões" procurava só `2x`, string que também aparece
na seção de worktrees; e a de permissão media DEPOIS do `chmod`, então não distinguia "nasceu 0600"
de "nasceu 0644 e foi corrigido".

Duas armadilhas de manutenção apareceram no caminho, e valem mais que os fixes: **renomear a
mensagem quebrou o teste que casava por ela** — e o nome novo tinha acento, que é justamente o que
o #1483 proíbe em marcador de teste (ASCII, caixa fixa, sem `-i`). E **a falsificação existente
virou inócua sem ninguém notar**: ela sabotava a redação de `Bearer` e exigia que `sk-segredo-123`
vazasse, mas o regex novo de tokens conhecidos passou a cobrir `sk-` — a proteção ficou redundante
e a sabotagem deixou de ser observável. **Endurecer o código pode aposentar a falsificação que o
vigiava**, e nada avisa: o teste segue verde, só que agora por motivo errado.

**A mesma armadilha, três vezes na mesma sessão.** A falsificação do critério de volume ficou verde
porque a fixture era barrada por OUTRA regra (dias ativos), e não pela que eu havia desligado.
Antes disso, a do teto de bytes passou por escolher um vetor que parava sozinho, e a do "último
comando" mediu um caso defendido pela exigência de `echo`. A regra final: **a fixture de uma
falsificação precisa passar em todas as outras regras, para que só a sabotada decida o resultado.**
Caso contrário o verde vem por motivo alheio — e verde por motivo alheio é indistinguível de prova.


### 10. `git show "$ref:path"` no zsh — o `:` vira MODIFIER e o path SOME

O idioma canônico para ler um arquivo numa revisão é `git show <ref>:<path>`. Entre aspas dobradas e
com a ref numa variável — que é como todo laço a escreve — o zsh **não** vê `ref` seguido de `:path`:
ele vê o parâmetro `$ref` seguido de um **modifier de history-expansion** (`:s` substitute, `:a`
absolute path, `:h`, `:t`, `:r`…). O path é consumido como argumento do modifier e **desaparece**:

```bash
ref=origin/main
printf '[%s]\n' "$ref:supabase/functions/x.ts"    # -> [origin/main]                    <- path SUMIU
printf '[%s]\n' "${ref}:supabase/functions/x.ts"  # -> [origin/main:supabase/...]       <- correto
```

Sobra `git show origin/main` — que é um comando **válido**: imprime o **commit inteiro em diff**, com
**exit 0**. Nada falha, nada avisa.

**Por que é da família que fabrica veredito, e não um simples typo:** o diff contém as linhas
procuradas, prefixadas por `+`. Então um `grep -c` devolve um número **plausível e não-zero**
justamente no commit que **introduziu** a string, e zero em todos os outros — que é *exatamente* o
formato de uma descoberta. Medido em 2026-08-28, ao conferir se o campo `versao` hardcoded da
`omie-nfe-reconcile` discriminava a fatia (`grep -cF 'v3.3-paginacao-janelas'`):

| ref | git recebeu | linhas | `v3.3` | controle `omie-nfe-reconcile` |
|---|---|---|---|---|
| `origin/main` | `git show origin/main` (diff) | 391 | **0** | **0** ← impossível |
| `dfa6e99e1` | idem | 283 | **10** | 17 |
| `dfa6e99e1^` | idem | 1146 | **0** | 0 |
| `7e076f1f7^` | idem | 153 | **0** | 0 |

A leitura natural — "o `v3.3` só existe em `dfa6e99e1`, logo o campo **discrimina** aquela fatia" — é
a conclusão errada, e ela decidiria se um deploy de edge money-path seria pedido ao founder. Com
`${ref}:$P` a mesma medição devolve `v3.3` presente em **todas** as revisões (3, 3, 2, 2): o campo
**não** discrimina nada, que é o oposto.

**O que pegou foi o CONTROLE POSITIVO, e só ele:** `grep -cF 'omie-nfe-reconcile'` no arquivo
`omie-nfe-reconcile/index.ts` voltou **0**. Um arquivo não pode não conter o próprio nome — o zero
impossível denuncia que a leitura não é do arquivo. Sem esse controle, os quatro zeros restantes
passariam por medição.

**O gatilho é a PRIMEIRA LETRA do path**, e o repo é feito dos dois piores casos:

| path | 1ª letra | comportamento |
|---|---|---|
| `supabase/functions/…` | `s` (substitute) | **SILENCIOSO** — vira `origin/main` |
| `src/lib/…` | `s` (delimitador sem par) | ruidoso: `bad substitution` |
| `a/b/c` | `a` (absolute) | **SILENCIOSO e pior** — vira `/Users/…/worktree/origin/main/b/c` |
| `docs/…`, `package.json` | `d`, `p` | intacto (não são modifiers) |

`src/` e `supabase/` são os dois diretórios mais tocados deste repo, e caem em ramos **diferentes**:
um falha alto, o outro mente. Quem tropeça no `src/`, corrige aquele caso e segue, deixa o
`supabase/` mentindo — é a §6 (BSD×GNU) com o agravante de que aqui os dois ramos convivem no
**mesmo** shell, na **mesma** sessão.

**Contramedida:** `git show "${ref}:$path"` — chaves **sempre**, mesmo quando "está funcionando"
(pode estar funcionando porque a inicial calhou de ser inócua). E, como nas outras nove, uma
afirmação conhecida junto: um `grep` de controle cuja resposta você já sabe, para que a leitura
prove que leu o que diz ter lido.
### 11. O PREÂMBULO do wrapper vira "dado" — e `-n "$X"` o aceita

O `~/.config/afiacao/psql-ro` emite duas linhas `SET` no **stdout** antes de qualquer resultado
(ele ajusta a sessão antes de rodar a query). Com `-Atc`, um script que guarda a saída numa
variável e pergunta só *"veio alguma coisa?"* recebe `SET\nSET` e responde **sim**:

```bash
LINHA=$("$PSQL" -Atc "SELECT ... LIMIT 1;")     # sem tick nenhum ainda -> LINHA="SET\nSET"
if [ -n "$LINHA" ]; then                        # <- VERDADEIRO. E nao ha dado nenhum.
  case "$LINHA" in
    *"|SEM_VERSAO|"*) echo BUNDLE_VELHO; exit 1 ;;
    *)                echo MARCADOR_PRESENTE; exit 0 ;;   # <- o default OTIMISTA fecha a armadilha
  esac
fi
```

Medido em 2026-08-29, verificando o deploy da `analytics-outbox-drain`: o script anunciou
`VEREDITO=MARCADOR_PRESENTE` num instante em que `net._http_response` **não tinha uma única linha**
posterior ao corte. Repassado, teria virado "deploy confirmado" sobre zero observações.

São **dois** defeitos, e os dois são necessários: `-n` como teste de presença (o preâmbulo passa) e
o `*)` do `case` no lado otimista (o não-reconhecido vira aprovação). A correção é exigir a FORMA,
não a presença, e mandar todo o resto para o vermelho:

```bash
LINHA=$(printf '%s\n' "$BRUTO" | awk -F'|' 'NF==6 {print; exit}')   # SO a linha com 6 campos
[ -n "$LINHA" ] || { echo "SEM DADO — nao concluo"; exit 2; }
```

Generaliza para qualquer wrapper que fale antes de responder (`SET`, banner, aviso de versão): a
pergunta nunca é *"veio texto?"*, é *"veio texto com a FORMA que eu pedi?"*.

### 12. No Postgres, `||` liga mais FORTE que `->>` — a query aborta e o vazio parece veredito

```sql
SELECT (content::jsonb)->>'versao' || '~' || (content::jsonb)->>'edge' FROM ...;
-- ERROR:  operator does not exist: text ->> unknown
```

O parser agrupa `'versao' || '~' || (content::jsonb)` **primeiro** e só então tenta aplicar `->>`
sobre o `text` resultante. Não é erro de digitação: a expressão está escrita como se lê, e o
Postgres a lê de outro jeito. O conserto é parentizar cada extração —
`((content::jsonb)->>'versao') || '~' || ((content::jsonb)->>'edge')`. (Dentro de `coalesce(...)`
o problema não aparece, porque a função já isola o operando — foi por isso que o mesmo `->>`
funcionou num script e quebrou no outro, na mesma sessão.)

O que a torna da família deste doc é o que acontece **depois**. Na mesma verificação de
2026-08-29, essa query estava dentro de um `$( ... 2>/dev/null )`: o `ERROR` foi para o ralo, a
variável veio vazia, e a tabela de comparação imprimiu três `❌` — que se leem como *"os campos
não batem"* quando o que houve foi *"não consultei"*. Falso NEGATIVO num money-path, e o desfecho
seria redeployar uma edge que está correta.

Duas regras saem daí, e a segunda é a que generaliza: **parentize a extração de JSON sempre que ela
encostar em `||`**; e **nunca deixe `2>/dev/null` numa consulta cujo vazio vira veredito** — se o
silêncio do erro e a resposta negativa produzem a mesma saída, o script não tem como distinguir os
dois, e vai escolher o errado. (Irmã da #7: lá o wrapper devolve exit≠0 *sem rodar nada*; aqui o
comando roda, falha, e a falha é apagada no caminho.)

### 13. `pgrep -f` como sonda de "meu trabalho acabou" — o padrão identifica um COMANDO, não uma EXECUÇÃO

```bash
until ! pgrep -f 'mutcheck.sh scripts/sonda-versao-sql' > /dev/null; do sleep 20; done
echo "mutcheck local terminou"; grep -E 'sumário|baseline' .mut1.txt | tail -3
```

O `pgrep -f` casa a **linha de comando**, e a tabela de processos é da MÁQUINA, não da worktree.
Medido em 2026-09-06, com ~27 sessões vivas: o padrão acima casou **cinco** PIDs e **nenhum** era um
`mutcheck.sh` em execução — eram shells de outras worktrees, incluindo o **próprio watcher**, cuja
linha de comando contém justamente o texto que ele procura. O único `mutcheck` real da máquina era o
da worktree `vibrant-dubinsky-8c6471` (PID 20507), de outra sessão.

Os dois desfechos possíveis são o MESMO defeito de identidade:

| quem casa | o watcher | consequência |
|---|---|---|
| só o mutcheck ALHEIO | declara fim quando o trabalho do VIZINHO acaba | lê `.mut1.txt` vazio, velho ou de outra rodada |
| outro watcher — ou ele mesmo | **nunca** sai do `until` | PID 19432 preso `06:26:10`, sem nenhum mutcheck vivo na máquina |

E o segundo passo fecha a armadilha: `grep` num arquivo que ninguém escreveu devolve **zero linhas**,
e zero linha lê-se como "sem problema" — é o `ausente ≠ zero` do money-path aplicado à espera.
Veredito ("terminou, **e o resultado é este**") derivado de dado que nunca foi consultado.

**Por que esta máquina é terreno fértil:** ~30 worktrees rodando os MESMOS comandos
(`bunx vitest run <arquivo>`, `mutcheck.sh <mesmo alvo>`). O padrão que identifica um *comando* não
identifica uma *execução* — e quanto mais parecidas as sessões, pior. Controle negativo na mesma
sessão: uma string montada em runtime, que nenhuma cmdline carrega, devolve `rc=1` e zero linhas — o
`pgrep` não está quebrado, a **pergunta** é que está errada. (Reproduzir o auto-casamento num
`zsh -c` isolado deu `rc=1`: a mecânica exata ficou por medir; o que está medido é o campo.)

⇒ Espere pelo **seu** processo, ou por um marcador que ele mesmo escreveu:
```bash
bash scripts/mutcheck.sh alvo > .mut1.txt 2>&1 & pid=$!   # o PID é MEU, não um padrão de texto
wait "$pid"; rc=$?                                        # (de outro shell: while kill -0 "$pid")
{ bash scripts/mutcheck.sh alvo; echo "RC=$?"; } >> .mut1.txt 2>&1   # marcador POSITIVO de fim…
command grep -q '^RC=' .mut1.txt                                     # …e espere por ELE (§7)
```

**A regra em uma linha: ausência de processo alheio não é presença do meu resultado.**

⇒ **vigiado por `.claude/hooks/sonda-processo-guard.sh`** (AVISO, nunca bloqueio): dispara na
CONJUNÇÃO laço `while`/`until` + sonda de processo por texto na CONDIÇÃO + `sleep` no CORPO —
`pgrep` sozinho, como o do `vigia-worktree.sh`, fica calado. A decisão, o que a revisão adversária
mudou e a lição sobre falsificação estão em [guard-de-sonda-de-processo.md](guard-de-sonda-de-processo.md).

Mesma classe de [teste-que-afirma-o-checkout.md](teste-que-afirma-o-checkout.md) — e, por acaso,
sobre o mesmo alvo — uma camada acima: lá a asserção media o **CHECKOUT** do CI em vez do código;
aqui a sonda mede a **tabela de processos** da máquina em vez do trabalho da própria worktree. O
eixo comum: a asserção pegou carona num estado GLOBAL compartilhado, e fica verde ou vermelha por
motivo alheio ao objeto.

### 14. `-t` do vitest é REGEX — filtro que casa NADA sai com exit **0**

**Medido 2026-08-23, dentro do próprio script de falsificação.** Uma das cinco sabotagens rodou
`bunx vitest run <arquivo> -t "cache quente + OFFLINE"` e voltou VERDE. Li isso como "o teste não
pega o defeito" e quase registrei uma correção como não-provada.

O `-t` é tratado como **expressão regular**. O `+` é quantificador, então o padrão pedia
`quente` + um-ou-mais espaços + ` OFFLINE` — que não existe no nome do teste (lá o `+` é literal).
Zero teste casou, o vitest imprimiu `Tests  8 skipped (8)` e saiu com **exit 0**. Ausência de dado
lida como aprovação, dentro do script cujo trabalho é justamente negar isso.

O agravante é o CONTEXTO: um filtro que não casa é indistinguível, pelo exit code, de uma suíte
que passou. Num script de falsificação isso inverte o veredito — "a sabotagem não foi detectada"
quando a verdade é "a sabotagem não foi TESTADA".

**A regra:** filtro de teste é entrada de regex, não substring. Escolha um padrão sem
metacaractere (`+ ? * ( ) [ ] . | ^ $ \`) **e** exija execução POSITIVA:

    bunx vitest run "$arquivo" -t "$nome" > "$out" 2>&1
    code=$?
    grep -qE "Tests +[0-9]+ (passed|failed)" "$out" || { echo "HARNESS QUEBRADO: nada executou"; exit 1; }
    [ "$code" -ne 0 ]   # só AQUI o vermelho vale como prova

Irmã da nº 13 (sonda que mede o alvo errado) e da família toda: **contar o que rodou é parte da
asserção.** `Tests N skipped` é ausência de dado; `Tests N passed|failed` é o dado.

### 15. `heavy` esgota o timeout de fila e ABORTA sem rodar — e o `echo $?` esconde isso

**Medido 2026-08-23, minutos depois da nº 14.** `heavy bash -c '…; echo "EXIT=$?"' > log; echo
"WRAPPER_EXIT=$?" >> log` voltou como **"Background command completed (exit code 0)"** na
notificação do harness. O log dizia outra coisa:

    heavy: timeout (1800s) esperando vaga — abortando. (posição 2 na fila)
    WRAPPER_EXIT=1

Nenhuma das nove sabotagens rodou; nenhum `FALSIF_EXIT`, nenhum `SUITE_EXIT`. A notificação era
verde porque o `echo` final zera o exit do compound (a armadilha já catalogada aqui), e o `heavy`
é um **wrapper que pode abortar sem executar o trabalho** — o caso já previsto no CLAUDE.md,
visto agora ao vivo, com fila de ~40 sessões disputando 1 slot.

**A regra:** com wrapper de fila, "terminou" e "rodou" são perguntas DIFERENTES. O veredito é o
marcador POSITIVO do trabalho no log (`FALSIF_EXIT=`, `SUITE_EXIT=`, `Tests N passed`), nunca o
exit do conjunto nem a notificação de background. E vale a recíproca: um log **sem** o marcador é
ausência de dado, não aprovação — pare e re-enfileire.

### 16. `printf | grep -q` sob `pipefail` — o leitor ACHOU e mesmo assim o pipeline REPROVA

```bash
set -o pipefail
if ! printf '%s' "$ORIG" | command grep -qF "$de"; then
  echo "alvo sumiu do gerador"; return        # ← e o alvo ESTÁ lá
fi
```

`grep -q` sai no **primeiro** match sem drenar o stdin — é o comportamento documentado do GNU grep,
não um acidente. O `printf`, que ainda tinha bytes a escrever, morre de **SIGPIPE**; o `pipefail`
promove o 141 dele a status do pipeline e o `if !` lê isso como "não achei":

```
$ printf '%s' "$BIG" | leitor-que-acha-e-sai; echo "$? / ${PIPESTATUS[*]}"
141 / 141 0        # ← o leitor respondeu 0/ACHOU; o pipeline reprovou
```

É **corrida**, não erro determinístico: só dispara quando o escritor não termina antes de o leitor
fechar. Por isso a assinatura é flake — e flake em gate de FALSIFICAÇÃO é caro, porque ensina a
re-rodar o CI, e re-rodar apaga sinal.

Medido em 2026-09-07 no eval `sonda-veredito-401` (run **34116946335**, main): **2 das 11**
sabotagens acusaram "alvo sumiu" e as outras 9 passaram — com o texto **byte-idêntico**, no mesmo
commit que passou em 34116947563. O que denunciou foi o **relógio**, não a mensagem:

| | controle → sabotagem 1 | sabotagem 1 → 2 |
|---|---|---|
| run que passou | 783 ms (rodou os 12 cenários) | 799 ms |
| run que falhou | **1,7 ms** (voltou no guard) | **1,7 ms** |

O tamanho explica a raridade: `$ORIG` tinha 59.252 B contra os 64 KiB de buffer de pipe do Linux —
90% da capacidade, margem de 6 KB. Quase sempre o `printf` despeja tudo antes de o `grep` fechar;
sob escalonamento adverso (runner de 2 vCPUs, logo depois de um `bun` + Postgres), não.

**No macOS a corrida não aparece — mas o motivo NÃO é o grep.** Medido em 2026-09-07: com o payload
passando da capacidade do pipe, tanto o `/usr/bin/grep` (BSD grep 2.6.0-FreeBSD) quanto o `ugrep`
que embrulha o `grep` desta máquina (§4) saem no primeiro casamento e matam o escritor —
`writer=141 grep=0`, idêntico ao Linux. O que blinda o macOS é o mesmo que torna o Linux raro: os
59 KB cabem no buffer, e o `printf` termina antes. Por isso 400 tentativas sob 8 hogs de CPU deram
zero fabricações — e por isso a atribuição "o BSD grep drena o stdin" está errada.

A consequência é prática, e é o contrário de "não tente": **o macOS reproduz, de forma
determinística, se você tirar a corrida do caminho** — basta empurrar o payload para além do buffer,
e aí o escritor tem bytes pendentes por CAPACIDADE em vez de por escalonamento:

```bash
bash -c 'set -o pipefail
  ORIG="$(cat scripts/sonda-versao-sql.ts)$(head -c 120000 </dev/zero | tr "\0" x)"
  printf "%s" "$ORIG" | command grep -qF "l.status_code = 401"
  ps=("${PIPESTATUS[@]}"); echo "writer=${ps[0]} grep=${ps[1]}"'   # → writer=141 grep=0
```

Isso é diagnóstico por MECANISMO, não por reprodução do gatilho: o que fica provado é que
`pipefail` troca o veredito do consumidor pelo do produtor morto; o escalonamento adverso do runner
continua sem reprodução local, e é honesto dizer isso. O guard
[`scripts/test-guard-noop-sabotagem.sh`](../../scripts/test-guard-noop-sabotagem.sh) chega no mesmo
lugar por outro caminho — um shim com a semântica do GNU `grep -q` — e vale nos dois sistemas.

A contramedida é não usar pipeline para decidir presença — busca no próprio shell, sem fork:

```bash
case "$ORIG" in
  *"$de"*) ;;                                  # `"$de"` entre aspas casa LITERAL: ?/* não viram curinga
  *) echo "alvo sumiu"; return ;;
esac
```

O antídoto geral vale igual: o `if !` acima **não** distinguia "não achei" de "a busca não pôde ser
feita" — três estados espremidos em dois, com o terceiro caindo no lado que acusa.

### 17. Flag que NÃO EXISTE no BSD + `2>/dev/null` — o erro morre no cano posto por higiene

A #6 é a flag homônima que faz **outra coisa**. Esta é a irmã mais silenciosa: a flag **não existe**,
o comando falha alto — e o `2>/dev/null` que estava ali por higiene apaga exatamente o grito.

Medido em 2026-09-07, levantando a linha de base da ocupação por arquivo. O comando era, em
essência:

```bash
# xargs -a é GNU. No BSD/macOS: "xargs: illegal option -- a" -> stderr -> /dev/null
xargs -a lista-de-transcricoes.txt grep -l 'docs/agent' 2>/dev/null | wc -l
#                                                       ^^^^^^^^^^^ posto para calar
#                                        "arquivo sem match", calou o "flag inexistente"
```

Saída: vazia. `wc -l`: **0**. O veredito a um passo de ser escrito no doc era **"`docs/agent` nunca
é lido — não vale destilar"**. A verdade, medida depois pelo caminho certo, eram **200 leituras em
17 dias**, com `money-path.md` sozinho em 64.

O que torna esta armadilha diferente da #12 (que também usa `2>/dev/null`) é **por que o
silenciador estava ali**: não foi descuido. Ele foi posto para calar um ruído **esperado e
inofensivo** — arquivos sem ocorrência, permissão negada num diretório ou outro. Só que ruído
esperado e erro estrutural descem pelo **mesmo cano**, e o cano não sabe distinguir os dois. A
higiene legítima de ontem é o apagador de evidência de hoje, sem que uma linha de código mude.

E note o agravante que fecha a armadilha: o resultado **0** era plausível. Um número absurdo
convidaria a conferir; um zero que confirma a suspeita de quem mede ("esses docs devem ser lidos
pouco") passa direto. **Silêncio que concorda com a hipótese é o mais caro de todos.**

Contramedidas, nesta ordem:

1. **Controle positivo antes da medição.** Rode a mesma sonda contra um caso cuja resposta você
   já sabe. Aqui: um arquivo que você acabou de ler nesta sessão *tem* de aparecer. Se o controle
   der 0, é a sonda que está quebrada — não o mundo.
2. **Nunca `2>/dev/null` num comando cujo silêncio é o dado.** Se o ruído incomoda, filtre o ruído
   **nomeado** (`2> >(grep -v 'Permission denied' >&2)`), não o canal inteiro.
3. **Zero é resposta que se PROVA**, como qualquer outra. `find`/`grep` que devolvem nada e
   `find`/`grep` que não puderam rodar são o mesmo byte de saída — só o exit code capturado
   colado, ou um marcador positivo, os separa.

A régua que nasceu deste episódio ([`scripts/ocupacao-contexto.sh`](../../scripts/ocupacao-contexto.sh))
sai **vermelha** quando lê sessões e não extrai nenhum evento, em vez de imprimir uma tabela
vazia — e [`scripts/test-ocupacao-por-arquivo.sh`](../../scripts/test-ocupacao-por-arquivo.sh)
tem o caso que dá nome à suíte justamente por isso.

### 18. `awk -f prog.awk '{programa}' dado` — o PROGRAMA vira NOME DE ARQUIVO, e o exit é 0

Com `-f`, o `awk` já sabe onde está o programa: **todo argumento posicional restante é ARQUIVO
DE ENTRADA**. Um programa inline ao lado do `-f` não é programa — é o nome de um arquivo que não
existe.

```bash
awk -f classif.awk '{k=classifica($5); n[k]++} END{print "classes:", length(n)}' dados.tsv
#    ^ programa                ^ isto aqui e' um NOME DE ARQUIVO, nao codigo
```

O `classif.awk` só tinha `function`s e nenhuma regra, então o awk processou a entrada, não casou
nada, **não imprimiu uma linha sequer e saiu 0**. Nem "arquivo não encontrado" apareceu: o nome
inexistente foi consumido antes de qualquer leitura falhar.

O sintoma é o mais perigoso do catálogo — **saída vazia com exit 0**, indistinguível de "a
consulta rodou e não achou nada". No levantamento de 2026-09-08 a leitura ia ser *"nenhuma
chamada Bash se classifica"*, sobre 69.737 chamadas que se classificam em 99,7%.

**Contramedida:** dois `-f` (`awk -f funcoes.awk -f principal.awk dado`), e um marcador POSITIVO
no `END` — se a linha de fim não sai, não houve resultado. Foi o que separou o defeito da
resposta: `head -c 600 saida.txt` devolveu **nada**, e `echo "exit=$?"` devolveu **0**. Nenhum
dos dois sozinho denuncia; a contradição entre eles, sim.

## O padrão por trás das dezoito

Seis produzem **verde por construção**, não por mérito; a sétima mostra que o mesmo defeito
fabrica **vermelho** com a mesma facilidade; a oitava, que o veredito certo pode existir e ainda
assim não ser o que o consumidor lê; e a nona volta ao verde por construção pelo pior
caminho — é a CONTRAMEDIDA de outra que trai ao mudar de shell, lendo ausência de dado como
sucesso: o sinal que você lê não é o sinal que você acha que está lendo. E a décima fecha o ciclo
pelo lado do INSUMO: as nove anteriores leem mal um resultado real, enquanto ela entrega ao `grep`
um insumo que nunca foi o pedido — o comando roda, devolve 0, e mede outra coisa. A décima primeira e a décima segunda fecham pelo lado do CANAL:
uma lê o PREÂMBULO do wrapper como resposta, a outra apaga o ERRO da consulta com `2>/dev/null`
— nas duas o script conclui sobre um dado que nunca chegou, e nas duas o caminho
não-reconhecido estava desenhado para o lado otimista. E a décima terceira fecha pelo lado do
SUJEITO: ela não lê mal um resultado nem um canal — mede o OBJETO errado, um estado global (a
tabela de processos da máquina) que qualquer worktree vizinha move, e por isso termina, ou deixa
de terminar, por motivo alheio ao trabalho que dizia vigiar. Verde e vermelho
por construção precisam do mesmo antídoto: uma leitura cuja resposta já se conhece. A contramedida é sempre a mesma — **exigir uma afirmação POSITIVA e com formato
conhecido** (exit code capturado colado, saída não-vazia, marcador de conclusão, formato conferido),
em vez de ler qualquer coisa na ausência dela.

E a décima sexta fecha pelo lado do TRANSPORTE: o resultado está certo, o canal está certo e o
sujeito está certo — o que trai é o **encanamento** entre eles, que promove o acidente do escritor a
veredito do leitor. Ela também é a única das dezesseis que erra para os DOIS lados conforme o
agendamento, e é por isso que aparece como flake em vez de defeito.

A décima sétima fecha pelo lado do TEMPO: a linha que apaga a evidência é a mesma que ontem só
apagava ruído, e ela envelheceu sem mudar. Nenhuma revisão de diff a pegaria — não há diff. É
também a única em que o **resultado errado concorda com a hipótese de quem mede**, e por isso a
única cuja contramedida tem de ser rodada ANTES da medição, não depois: um controle cuja resposta
já se conhece. Depois já é tarde, porque o número plausível não pede conferência.

É a mesma família de `WHEN OTHERS THEN 'OK'` (SQL) e `toThrow()` pelado (TS): o teste passa sem
provar nada. Ver `docs/historico/tothrow-pelado.md`.
