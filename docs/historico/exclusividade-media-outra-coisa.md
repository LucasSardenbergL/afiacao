# A máquina que mede gate media outra coisa — a invocação, a execução e o autor

**2026-09-10.** Três defeitos no ferramental de exclusividade de gate (`bun run exclusividade:medir`,
`scripts/lib/exclusividade.ts`, o corpus `scripts/exclusividade.d/`), medidos durante o #2445. Os
três são o mesmo defeito visto de três lados: **o instrumento afirmava ter medido o gate, e tinha
medido outra coisa**. A 2ª opinião (Codex) achou mais dois da mesma família, e um deles estava
vivo na matriz commitada.

## (1) A baseline sujava a si mesma — o motor não rodava o que o CI roda

`exclusividade:medir` exige árvore limpa para começar, mas no baseline o `sonda:cron-prova`
regravava `supabase/functions/_shared/sonda-cron-prova.json`, e todo gate seguinte media árvore
suja (`test` vermelho, motor abortado). A causa não era o gate escrever — era o motor rodar **outra
invocação**: `bun run <nome>` cru, para todo gate. Reproduzido lado a lado:

| invocação | rc | tempo (M2) | manifesto depois |
|---|---|---|---|
| `bun run sonda:cron-prova` (o que o motor rodava) | 0 | 305s | **sujo** (+411/−264) |
| `bun run sonda:cron-prova -- --gate` (o que o CI roda) | 0 | 1143s | limpo |

Sem `--gate`, `sonda-cron-prova.ts` é o modo **backfill**, que termina em `gravarManifesto` (os
closures novos desde o último commit do manifesto). A mesma classe tinha uma forma pior, calada:

- **`tsc`**: o CI roda `bunx tsc --noEmit -p tsconfig.app.json`; sem script `tsc` no `package.json`,
  `bun run tsc` roda o binário contra o `tsconfig.json` raiz (`files: []`) — **no-op, rc=0 em 640ms**.
  O gate estava na matriz como "medido" sem nunca poder reprovar.
- **`build`**: o CI passa `NODE_ENV: production`; o motor não passava.

**Conserto.** `invocacaoDoCI` extrai argv + `env:` literal do step bloqueante e o motor roda
exatamente isso — e só aceita um `run:` que **é** um comando simples: recortar `bun run g` de dentro
de `cd sub; bun run g` ou de `bun run g || true` perderia o que compõe o status do step (parecer
Codex). Composto, env com `${{ }}`, `working-directory` ou o mesmo gate invocado de dois jeitos:
**aborta antes do baseline**, nomeando o gate. Cada execução grava a assinatura da invocação, e a
derivação descarta execução cuja assinatura difere da do CI de hoje (a execução antiga sem o campo
é, por construção, `bun run <gate>` — o `tsc` no-op sai da conta sozinho).

E a classe inteira ganhou guarda, porque "qualquer gate que escreva em arquivo versionado quebra a
medição do mesmo jeito": **write-guard** — snapshot da árvore versionada (porcelain `-uall` +
conteúdo, entradas do índice via `ls-files --stage`, HEAD) antes e depois de **cada** execução.
Escreveu: o motor restaura o conteúdo (do snapshot ou do blob no HEAD **capturado** — nunca `git
checkout`, que lê do índice), não apaga arquivo criado, não mexe em índice/HEAD, e **aborta sem
gravar a matriz**. Abortar e não invalidar só a linha, porque invalidar pressupõe restauração
provada — e a escrita inesperada é justamente a quebra dessa premissa. Mais um **controle de saída**
por defeito: restaurado, o snapshot tem de ser igual ao inicial.

Limite declarado: arquivo **ignorado** (`node_modules/`, `dist/`) fica fora do snapshot — vigiá-lo
custaria hashear `node_modules` a cada execução e acusaria o `build`, que escreve `dist/` por ofício.

## (2) A poda aprovava o suspeito sem executá-lo — "não rodou" contava como medição

A poda por custo parou no 2º vermelho (`sonda:bump` e `sonda:fingerprint`, que pegam por bytes) e
`sonda:autentica` nunca rodou. Mesmo assim o `GATE_NOVO_SEM_EXCLUSIVIDADE` sumiu. O critério era:

```ts
const medido = e.pegou.length + e.naoMedido.length > 0;
```

e `naoMedido` é **a lista de defeitos em que o gate não rodou**. Na matriz commitada, dois gates
estavam nesse estado — `sonda:autentica` **e `gate:ambiente`**, com 0 execuções em linha válida e
11 `naoMedido` cada — e saíam sem REPROVA e sem RELATA: silêncio total.

**Conserto.** `medido` = executado em ≥1 linha **válida** com a invocação do CI (`rodou`). E o motor
executa o `@suspeito` depois do laço podado quando a poda o deixou de fora. Isso não favorece
ninguém: só acontece com `parouCedo` (≥2 vermelhos), linha que já não certifica exclusivo; a
execução extra só dá ao suspeito o `rodou/pegou` que a poda lhe negou. `@suspeito` com typo aborta
o motor (e reprova no vitest): miraria o vazio e o gate de verdade seguiria sem mira.

## (3) O formato não expressava o autor diligente — `@dever-de-casa`

O `.def` aceitava um alvo por defeito, e o autor que ele descrevia era sempre o **descuidado**. Para
gate semântico sobre edge instrumentada, qualquer mudança no `index.ts` aciona os gates de bytes, e
a exclusividade medida era sempre zero — zero que media o formato do corpus, não o gate. (Uma
medição à parte, com o dever de casa, anotou que só `sonda:autentica` reprovava; a rodada real
refutou — ver "A medição", abaixo.)

**Por que não um "pós-passo" de comando livre** (a primeira ideia, derrubada pelo Codex): ele
**fabrica** exclusividade. Um pós-passo pode apagar o script de um concorrente, deixar o alvo
intacto, sair 0 e mexer só em arquivo versionado — o estado passa por qualquer guarda de efeito,
porque já existe antes de o primeiro gate rodar.

**Conserto.** Vocabulário **fechado** de receitas, com efeito exato conferido por snapshot, e um
critério de admissão verificável: **a receita é o conserto que o próprio gate concorrente prescreve
na mensagem de falha dele** (`sonda:bump`: "Bumpe `VERSAO`"; `sonda:fingerprint`: "`bun run
sonda:fingerprint -- --write`"). A neutralização é exatamente a que o gate desenhou para aceitar —
e a suíte exige a citação literal na fonte do gate: se ele parar de prescrever, a receita cai.
`@dever-de-casa` vale **só para a próxima linha** (herdado por engano, calaria os gates de bytes num
defeito que não o pediu); só as saídas declaradas mudam; o alvo inteiro segue byte-idêntico (a
sabotagem poderia virar código morto sem sair do arquivo); receita que não muda nada ou falha =
linha inválida.

## Os dois que o Codex achou

- **`fundirLinhas` misturava proveniências.** Fundia por gate ignorando `defeitoFingerprint` e
  `invalido`: execuções da sabotagem velha grudavam na nova, e as de uma rodada invalidada
  ressuscitavam. Agora só funde a mesma sabotagem, válida dos dois lados.
- **Linha incompleta certificava `[SO ELE]`** — vivo na matriz: `bun-despinado` rodou 7 de 31 gates,
  teve 1 vermelho, `parouCedo=false` e saía exclusivo; os 24 ausentes lidos como verdes. Certificar
  agora exige, por nome, cada gate bloqueante executado com a invocação do CI; o único vermelho de
  linha incompleta vira **INCONCLUSIVO** (`EXCLUSIVIDADE_INCONCLUSIVA`, RELATA) — nem exclusivo, nem
  "outro gate também pegou". Os certificados antigos perderam o selo sem perder a medição; re-medi-los
  com todos os gates é trabalho separado (~20 min por defeito numa M2).

## Como foi provado — e o que a prova achou

Cada conserto foi sabotado **sozinho** (19 camadas: 13 na lib, 6 no motor), com o **controle** — a
mesma invocação, sem sabotagem — verde antes, restauração por cópia provada por `cmp` + `git diff
--quiet`, nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`). Uma sabotagem só contava se o vermelho
viesse do **título do teste que deveria pegá-la**: rc≠0 sozinho não é prova.

A primeira rodada reprovou uma camada — e o defeito estava no **teste**. O `describe('o corpus de
verdade')` parseava o corpus real na COLETA do vitest. Enquanto o parser era leniente, isso nunca
lançava; com `@dever-de-casa` estrito, a sabotagem "o dever de casa vira pegajoso" fez o parser
lançar `DEVER-DE-CASA-PENDURADO` na coleta, e o arquivo morreu com **rc=1 e zero testes executados**
— os ~100 testes sumiram junto com o sinal. O script recusou esse vermelho (nenhum título casou).
Corolário que fica: **parser que LANÇA não roda na coleta** — no `describe`, um lançamento não
reprova um teste, apaga todos.

Efeito da regra estrita de invocação sobre o que já estava medido, dito em voz alta: o `knip`
perdeu a única execução que tinha (gravada como `bun run knip`; o CI roda `bunx knip` — quase
certamente equivalente, mas não medido), e `tsc`, `lint` e `build` também foram a zero execução
válida. Todos dispensados: nada reprova por isso; volta com a próxima rodada completa.

## A medição (2026-09-14)

A primeira rodada real **abortou no baseline, e pelo motivo certo**: `test` vermelho (99s), com o
gate `erro-object-object` acusando uma reintrodução de `e instanceof Error ? e.message : String(e)`
— escrita nesta mesma entrega, no `catch` do parse do corpus do motor. As rodadas anteriores só
tinham executado as duas suítes da exclusividade, nunca a suíte inteira; o baseline do motor roda o
`test` que o CI roda, e barrou. Trocado por `mensagemDeErro(e) ?? '<fallback explícito>'`, a
convenção do repo (sem mensagem utilizável, o chamador nomeia o fallback — nunca `[object Object]`).
É a guarda 1b ("baseline vermelho aprova qualquer coisa") trabalhando contra o próprio autor dela.

A segunda rodada — 4 defeitos × 27 gates: todos os bloqueantes menos `sonda:cron-prova` (~19 min na
M2 com a invocação do CI), `test:falsificacao`, `test:hooks` e o próprio `exclusividade` — terminou
com `rc=0`:

- **Baseline 27/27 verde, nenhum `GATE-ESCREVEU`.** `tsc` passou a levar 47s (era o no-op de
  640ms) e `build` rodou com `NODE_ENV=production`: a paridade valeu na árvore real, não só no
  fixture.
- **(2) na árvore real.** Em `sonda-responde-antes-do-gate`, `sonda:bump` e `sonda:fingerprint`
  reprovaram e a poda deixou 21 gates sem rodar — e `sonda:autentica`, **rodado fora da poda**,
  reprovou em 65ms. Na matriz anterior essa linha tinha 7 execuções, nenhuma dele.
- **(3) na árvore real — e a medição refutou o `@suspeito`.** Na linha diligente o dever de casa
  tocou só as duas saídas declaradas, `sonda:bump` e `sonda:fingerprint` ficaram verdes, e
  reprovaram **dois**: `sonda:autentica` e `test:edges`. O segundo podia ser artefato do dever de
  casa (o bump grava `-corpus-diligente` no `VERSAO`), então foi atribuído por fora, com `heavy bun
  run test:edges` na mesma invocação e restauração por cópia provada a cada fase: árvore limpa
  verde (1106 testes), só o dever de casa verde, e o defeito — com ou sem dever de casa — vermelho
  no MESMO teste, o contrato Deno *"gate próprio: onde o gate da edge não aceita cron-secret, a
  sonda NÃO fica sem auth"* (`supabase/functions/_shared/sonda-versao-contrato_test.ts`). A
  anotação do `.def` ("medido à parte, só `sonda:autentica` reprovou") não tinha `test:edges` na
  conta. `sonda:autentica` sai `EXCLUSIVIDADE_ZERO` — agora contra os dois autores, e não mais por
  causa do formato do corpus.
- **O que era hipótese virou medição.** `diretiva-em-dobro` rodou os 27 gates com um único
  vermelho (`gate:ambiente`): o `test` que em 2026-09-09 reprovou com a máquina saturada (834s de
  baseline) passou com baseline de 151s. `diretiva-alias-jest` reproduziu a sobreposição com `knip`,
  agora com `bunx knip`. As duas linhas nem existiam na matriz: as medições de 09-08 e 09-09 viviam
  só em comentário do `.def`.
- **`bun run exclusividade`: `rc=0`, nenhum REPROVA.** `EXCLUSIVIDADE_ZERO` para `sonda:autentica`,
  `knip` e `gate:senha-bootstrap`; `EXCLUSIVIDADE_INCONCLUSIVA` para `gate:ambiente` (27 de 31
  gates) e para os seis selos antigos medidos com `--gates` (6 a 10 de 31).

Corolário: **o formato novo não fabricou exclusividade nem para o gate que o motivou.** A primeira
medição dele contra o autor diligente derrubou o selo que a anotação à mão lhe dava — pela razão
certa, um contrato que já cobria o eixo. E a anotação errou do mesmo jeito que a linha incompleta:
medida com um subconjunto de gates, leu os ausentes como verdes — só que num comentário, fora do
alcance da regra de certificação.

## O alcance comparado (2026-09-14, 2ª rodada) — o zero media UM alvo, e o `test` era o MESMO gate

O `EXCLUSIVIDADE_ZERO` acima é verdadeiro e dizia menos do que parecia: o único alvo do corpus,
`fin-funding`, está na lista que o contrato Deno varre — o corolário ("um contrato que já cobria o
eixo") vale para o ALVO. A pergunta que faltava era o que cada um **alcança**.

| Eixo | `sonda:autentica` | contrato Deno *"gate próprio"* (`sonda-versao-contrato_test.ts`) |
|---|---|---|
| Universo | toda pasta com `versao.ts` + `index.ts`, lida da ÁRVORE (60) | `GATE_PROPRIO`, lista OPT-IN (12) — nenhum gate força a entrada |
| Trecho | arquivo inteiro, sem comentário, sem `import`, sem a linha do `atenderSondaOptions(` | só depois do 1º `Deno.serve(`, sem comentário |
| Credencial | `authorizeCron\w*\s*\(` — qualquer variante e argumento | o literal `authorizeCronOrStaff(req)` |
| Emissão | 1ª `respostaSonda\w*(` ou `criarRespostaSonda(` | 1ª `respostaSonda(` literal, depois de `classificarSonda(` |
| Predicado | o 1º gate vem antes da 1ª emissão | o literal aparece ENTRE a classificação e a resposta |
| Edge nova | entra sozinha | entra em `EDGES` por obrigação (teste de completude); em `GATE_PROPRIO`, só se o autor lembrar |

Dentro das 12, o contrato é o mais estrito — exige o gate no trecho exato, não em qualquer ponto
anterior do arquivo. Fora delas, não olha. Triagem (o `auditarFonte` real do gate e uma réplica do
predicado Deno, subindo a emissão para antes do gate em cada edge): nas 12 o contrato reprova 12/12;
nas outras 48 só o predicado do `sonda:autentica` reage. Dessas 48, **46** respondem à sonda depois do
gate NORMAL (que já aceita `x-cron-secret`), e ali o mesmo defeito move 3+ linhas — acima do teto de 2
do motor, o corpus não o expressa. As outras **2** têm a forma do `fin-funding` (gate PRÓPRIO dentro
do `if` da classificação) e atendem ao critério declarado de `GATE_PROPRIO` — "o gate da edge não
aceita `x-cron-secret`" — sem estar nela: `omie-nfe-recebimento` (`Bearer` + `getClaims` +
`user_roles`) e `generate-bundle-argument` (`Bearer` + `getUser()`). É o "universo opt-in perde
membro em SILÊNCIO" que o próprio contrato documenta, um nível abaixo: a completude cobre `EDGES`,
não as sublistas.

**Medição** — o defeito de uma linha, nos dois autores, em `omie-nfe-recebimento`
(`sonda-responde-antes-do-gate-fora-da-lista` e `…-diligente`):

- *pré-voo*, na mesma invocação, em cópias de `supabase/functions`, `LC_ALL=C` e `pt_BR.UTF-8`: árvore
  limpa verde (1130 testes Deno; o gate aprova as 60); só o bump verde; o defeito, com e sem bump,
  deixa `test:edges` **verde** e só o gate vermelho. O contrato não vê.
- *motor* (51 min, 31 gates, baseline 31/31 verde — agora com `sonda:cron-prova`, `test:falsificacao`
  e `test` dentro): a descuidada reprova em `sonda:autentica` + `sonda:bump`; a diligente (o dever de
  casa tocou só as 2 saídas) em `sonda:autentica` + **`test`**. `bun run exclusividade`: ainda
  `EXCLUSIVIDADE_ZERO`, e aparece `RELATA test CORPUS_NAO_MIROU`.

**Quem é o `test` que pegou** — atribuído na mesma invocação, na árvore real, com restauração por
cópia provada a cada fase: a suíte inteira na árvore limpa, verde (8968 testes); com defeito + dever,
**uma** falha — `scripts/gate-sonda-autentica.test.ts`, *"o repo INTEIRO passa hoje"*; esse arquivo
nas 4 fases e nos 2 locales: limpa verde, só o dever verde, o defeito com e sem dever vermelho, no
mesmo teste. O teste chama o `auditar()` **deste gate** contra o repo real.

**Leitura.** Não existe segundo detector: o vitest é uma **segunda porta do mesmo código**. O eixo é
exclusivo do *código* `scripts/gate-sonda-autentica.ts`; o *step* `sonda:autentica` sai zero porque o
próprio teste dele o co-pega. É a duplicação que o #2378 tirou do vitest para o `docs:indice` — que,
depois do #2391, saiu de `[redund] 0/8` para `[SO ELE] 1/8`.

**Para a decisão** (do Lucas; nenhum dos dois checadores mudou de semântica nesta medição):

- *manter como está* — custo zero; a matriz segue dizendo zero para o único dono do eixo;
- *tirar só o step do CI* — nada se perde (o vitest segue rodando o gate) e economiza 60–143 ms;
- *tirar do vitest a auditoria do repo real* (o caminho do #2378) — o step vira o dono único, e a linha
  diligente deve certificar `[SO ELE]` na re-medição;
- *aposentar o gate* — perde as 48 edges, inclusive as 2 que atendem ao critério de `GATE_PROPRIO`, a
  menos que o contrato Deno ganhe universo derivado da árvore.

## A re-medição completa (2026-09-15) — três selos certificados, duas segundas portas e um censo duplicado

Os sete `EXCLUSIVIDADE_INCONCLUSIVA` de 2026-09-14 eram linhas medidas com parte dos gates
(`diretiva-em-dobro` com 27 de 31; os seis selos antigos com `--gates`, 6 a 10 de 31). Seis foram
re-medidas com os **31** bloqueantes numa rodada única (sourceHead `99282961d`, 22:03 → 01:03 com a fila
do `heavy`, baseline 31/31 verde):

| defeito | executados | vermelhos | veredito |
|---|---|---|---|
| `diretiva-em-dobro` | 31/31 | `gate:ambiente` | **`[SO ELE]`** |
| `indice-orfao` | 31/31 | `docs:indice` | **`[SO ELE]`** |
| `link-solto-quebrado` | 31/31 | `docs:links` | **`[SO ELE]`** |
| `bun-despinado` | 29 (poda) | `bunpin:check` + `test` | `EXCLUSIVIDADE_ZERO` |
| `claude-md-linha-gigante` | 28 (poda) | `claude:size` + `test:hooks` | `EXCLUSIVIDADE_ZERO` |
| `censo-sem-o-gate` | 31/31 | **nenhum** | `gates:frescura` fica com `pegou 0` — e sem veredito |

Cada linha foi lida por dois eixos que concordam: o `--resumo` da lib e um verificador por fora (`jq`
sobre a matriz, `awk` sobre o `ci.yml`) que recalcula completude, assinatura e vermelhos sem `derivar()`
— falsificado antes do uso, 4 sabotagens × 2 locales, cada uma vermelha pelo controle que a mira. A
matriz conflitou com a do #2505 (dois defeitos novos, disjuntos) e foi fundida pela regra do próprio
motor — por defeito, com o baseline da rodada mais recente vencendo —, conferida por fora: as 6 linhas
daqui idênticas às da rodada, as outras 10 idênticas às da main.

- **As duas redundâncias são segundas portas do mesmo código**, como o `test` do `sonda:autentica` acima
  (atribuição por leitura, não executada): `scripts/bun-pin-gate-check.test.ts` tem *"os workflows REAIS
  do repo passam no gate"* — `auditBunPins(readWorkflows())`, o código do `bunpin:check`; e o passo 13
  de `scripts/test-claude-md-budget.sh` roda o mesmo `scripts/check-claude-md-budget.sh` do
  `claude:size` contra o `CLAUDE.md` real. As opções de decisão são as da seção anterior.
- **`censo-sem-o-gate` deixou de medir o gate.** A linha do censo delimitado de `docs/agent/deploy.md`
  tem 61 nomes entre crases e 31 distintos — a lista inteira repetida, menos `gate:ambiente` — desde o
  #2420 (2026-09-09), depois da medição antiga que dava o `gates:frescura` como pegador. A sabotagem
  remove uma cópia de `docs:citacoes`; `lerCenso` devolve um `Set`, e a outra cópia basta. Reproduzido
  fora do motor: a saída sabotada do `gates:frescura` é idêntica à do controle ("38 nomes no censo"). O
  furo que isso expõe é do GATE: "bate exato" é igualdade de conjunto, e nome repetido passa calado — a
  classe que o #2391 tirou do `docs:indice`. A linha fica na matriz, porque é a verdade do repo hoje; o
  conserto (censo deduplicado, gate que recusa repetição, re-medição) virou chip.
- **`matriz-gate-renomeado` ficou de fora — é inválido contra toda matriz commitada.** A expressão casa
  toda linha `"gate": "knip"` (3 na matriz do #2366, 7 na do #2479), e o teto de 2 linhas perturbadas é
  de nascença: a linha só valeu contra a matriz em disco antes de ser gravada. Medi-la agora seria pior
  que inútil — `fundirLinhas` troca a linha antiga inteira pela nova inválida e apagaria o único vermelho
  do `exclusividade`, cujo `[inconcl]` sumiria calado. Redesenho em chip.

Três tropeços da sessão, nenhum virou dado:

- a 1ª rodada abortou no baseline pelo motivo certo: com o swap em 8,2 GB o `build` não terminou em
  40 min (16 s sem carga), e o motor tratou o estouro como ausência de dado — nada gravado;
- duas armadilhas do [catálogo de shell](evidencia-positiva-shell.md) reincidiram antes de a saída virar
  texto: `git show "$c:scripts/…"` num laço zsh (§10) mostrou o diff do commit e "provou" uma história
  falsa da matriz, desmentida pelo blob idêntico; `locale -a | grep -q` sob `pipefail` (§16) deu como
  ausente um locale presente, e o script abortou do lado seguro;
- a verificação da fusão comparava `iguais == total` e teria aprovado o vácuo `0 == 0` (um `.` fora de
  contexto no `jq`); o que reprovou foi exigir o total esperado, `10`, escrito antes de olhar.

## A segunda porta fechada (2026-09-18) — o step vira dono único, e a certificação esbarra no motor

Das três segundas portas medidas, a do `sonda:autentica` foi fechada: saiu o
`it('o repo INTEIRO passa hoje')` de `scripts/gate-sonda-autentica.test.ts`, que rodava o **mesmo**
`auditar()` do step, na mesma árvore e no mesmo CI. Era ele que carimbava `EXCLUSIVIDADE_ZERO` —
"redundância medida" — no único dono de uma premissa money-path.

**Tirar detector para fabricar exclusividade é o anti-padrão que este motor existe para barrar**, e a
diferença aqui é que o "concorrente" era o próprio código. Por isso a saída foi PROVADA, não
argumentada — mesma invocação, dois locales, na árvore real, restauração por cópia provada:

| fase | `sonda:autentica` | suíte vitest inteira |
|---|---|---|
| árvore limpa | verde, com marcador positivo | 9248 testes, 0 falhas |
| defeito na edge real | **reprova**, citando a edge | 9248 testes, **0 falhas** |

A linha de baixo é a prova: a duplicata saiu (nada mais no `test` acusa) e a detecção ficou.

**A certificação `[SO ELE]` ficou PENDENTE — e pelo instrumento, não pelo repo.** Duas rodadas do
motor abortaram no baseline com `test` vermelho; a guarda 1b fez o certo e não gravou nada. O vermelho
não era teste falhando: discriminado na mesma máquina e no mesmo commit, com a invocação do CI
(`bun run test`), stdout para ARQUIVO sai 0 com 842 arquivos e 9248 testes passando, e a MESMA
invocação capturada por `spawnSync` — o que o motor faz — sai **1** com os mesmos 9248 passando e um
`Error: [vitest-worker]: Timeout calling "onTaskUpdate"`. Sob carga, os ~360 KB de saída travam a
thread principal do vitest no pipe e o worker estoura o RPC. É vermelho **fabricado pela captura**:
fail-closed (aborta, não grava), então nunca virou medição falsa — mas, enquanto durar, nenhuma linha
nova certifica nada nesta máquina. Conserto do motor (capturar em arquivo, não em pipe) virou chip.

**A regra que fica.** Auditoria de repo real mora no **step** — ele tem nome no inventário do CI e
mensagem de falha que ensina o que está em jogo; um `expect(motivos).toEqual([])` não. O arquivo de
teste fica com o que o step não dá: as formas sintéticas (calibração e falsificação) e o eixo por fora
que prova o denominador. Duas portas para o mesmo código não somam detecção — só fazem a contabilidade
chamar de redundância quem é dono único. Das outras duas instâncias medidas, a do `claude:size`
(passo 13 de `test-claude-md-budget.sh`) e a do `bunpin:check` (`bun-pin-gate-check.test.ts`) foram
fechadas dois dias depois — seções abaixo.

## A segunda porta do `claude:size` (2026-09-20) — e o limb que a duplicata cobria por ACIDENTE

Fechada a segunda das três: saiu o passo 13 de `scripts/test-claude-md-budget.sh`, um
`esperar 0 ... "$raiz/CLAUDE.md" "$raiz/scripts/claude-md-secoes-baseline.txt"` que rodava o **mesmo**
`scripts/check-claude-md-budget.sh` do step `claude:size`, contra os **mesmos** dois arquivos reais, na
mesma árvore e no mesmo CI. O carimbo está na matriz do #2509 (`linhas[2]`, sourceHead `99282961d`):
28 gates executados com poda, vermelhos `claude:size` **e** `test:hooks` ⇒ `EXCLUSIVIDADE_ZERO` —
"redundância medida" no dono único do orçamento do manual.

**Tirar detector para fabricar exclusividade é o anti-padrão que este motor existe para barrar**, então
a saída foi PROVADA com o mesmo contrato do #2519: mesma invocação do CI (`bun run claude:size`,
`bun run test:hooks`), 2 locales (`LC_ALL=C` e `pt_BR.UTF-8`), CONTROLE verde na mesma invocação e
antes do 1º defeito (o laço aborta sem ele), restauração por cópia provada (`cmp` + sha256), e o
defeito `claude-md-linha-gigante` **lido do corpus**, não redigitado.

| fase | `claude:size` | `test:hooks` (47 suítes) |
|---|---|---|
| árvore limpa | verde, com marcador positivo | verde, 42 asserções do budget |
| defeito na `CLAUDE.md` real | **reprova** (rc=1): *"linha 69 tem 2109 chars > teto 2000"* | **verde** (rc=0, zero falhas) |

18 asserções verdes ao todo (9 por locale), e o `sha256` da `CLAUDE.md` volta ao original nas
duas voltas.

A linha de baixo é a prova: a duplicata saiu e a detecção ficou.

**E a asserção tem DENTE**, falsificada em forma PAREADA — com o mesmo defeito, na mesma árvore e na
mesma invocação, rodam as duas versões da suíte (a antiga vem do commit pai, inteira):

| com `claude-md-linha-gigante` aplicado | veredito |
|---|---|
| suíte NOVA (sem o passo 13) | verde, 42 asserções |
| suíte ANTIGA (com o passo 13) | **vermelha nos 2 locales**, citando `CLAUDE.md real x baseline commitada` |

Sem esse par, "ficou verde" poderia ser sempre-verde — e sempre-verde aprova tudo. O par também é mais
barato que sabotar o laço inteiro, o que importou aqui: as três primeiras tentativas da forma original
abortaram no CONTROLE, e o culpado era a MÁQUINA, não a mudança — `fork: Resource temporarily
unavailable`, load average de 15 min em ~40 numa M2 de 8 núcleos com ~10 sessões vivas, suíte diferente
caindo a cada tentativa (`test-pr-watch`, `test-pr-duplicata-guard`, `test-pr-collision-guard`, todas
verdes isoladas). O laço é fail-closed e abortou antes de sabotar, que é o desenho certo: sabotar sobre
controle vermelho teria produzido um vermelho que não prova nada.

**A falsificação quase ficou vermelha pelo motivo ERRADO.** Na primeira montagem, a versão antiga rodava
a partir do scratchpad — e ela resolve `raiz` por `dirname($0)/..`, então o passo 13 lia um `CLAUDE.md`
inexistente e reprovava por entrada inválida (exit 2), sem nunca chegar ao defeito. O controle pegou
(a antiga já reprovava em árvore LIMPA) e o conserto foi rodá-la de dentro de `scripts/`. É a mesma
regra do teste negativo: **case a marca do ramo, não "reprovou"** — vermelho pelo motivo errado é verde
disfarçado.

**O que a duplicata cobria por ACIDENTE — a lição nova.** O passo 13 não existia para medir teto de
LINHA; ele afirmava "o par commitado está verde". Só que era a **única** coisa na suíte capaz de deixar
o limb `MAX_LINE` (2000 chars) vermelho alguma vez: as 12 formas sintéticas só mexiam em palavras por
seção, e o defeito do corpus mira justamente a linha. Fechar a porta sem olhar teria levado junto, em
silêncio, a única cobertura de um limb do gate — e a suíte seguiria verde dizendo o contrário.

Por isso no lugar entra a FORMA, não o veredito: fixture própria com linha de 1999 chars (verde) e de
2100 (vermelho citando a linha), com a baseline **re-gerada com a linha dentro** — o `--gerar-baseline`
sai antes do teto de linha, então palavras e seções batem e sobra UM motivo possível. Sem esse cuidado
o caso ficaria vermelho por seção estourada e fingiria ter medido o teto de linha. A variável `raiz`
saiu junto: sem ela a suíte não tem como alcançar o repo, e a hermeticidade que o cabeçalho promete
vira ESTRUTURAL em vez de promessa. A suíte foi de 38 para 42 asserções.

**Regra que sai daqui: ao fechar uma segunda porta, pergunte o que ela pegava por ACIDENTE.** Auditoria
de repo real passa por limbs que as formas sintéticas nunca visitam — o inventário é o diff entre o que
o gate PODE reprovar e o que a fixture faz ele reprovar. Fechar sem esse inventário troca uma
contabilidade errada por um buraco de cobertura, e o buraco não aparece: a suíte fica verde porque
ninguém mais aperta aquele limb.

**A re-medição continua bloqueada — pelo mesmo instrumento do #2519.** O `[SO ELE]` desta linha exige o
motor com os 31 gates, e o Guard 1b aborta no baseline com `test` vermelho FABRICADO pela captura:
`scripts/exclusividade-medir.ts` ainda roda os gates com `stdio: ['ignore', 'pipe', 'pipe']` (linhas 339
e 419), que é a condição do `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` discriminado acima.
O conserto (capturar em ARQUIVO, não em pipe) segue em chip, sem PR nem branch. Fail-closed: o motor não
grava nada, então a matriz não ganha medição falsa — ela apenas continua carimbando `EXCLUSIVIDADE_ZERO`
numa linha cuja causa já saiu do repo. **A matriz está DEFASADA, não errada**, e o desempate é o chip.

A terceira e última — `bunpin:check` em `scripts/bun-pin-gate-check.test.ts` — foi fechada no mesmo
dia; seção abaixo. Ela também trouxe a correção do diagnóstico que estas duas seções repetem.

## A segunda porta do `bunpin:check` (2026-09-20) — e o vermelho do motor NÃO era a captura

Fechada a terceira e última das três: saiu o `it('os workflows REAIS do repo passam no gate')` de
`scripts/bun-pin-gate-check.test.ts`, que rodava `auditBunPins(readWorkflows())` — o **mesmo** código
do step `bunpin:check`, na mesma árvore e no mesmo CI. Era ele que fazia o `test` co-pegar
`bun-despinado` e carimbar `EXCLUSIVIDADE_ZERO` no único dono de um eixo que já derrubou todo PR do
repo em ~6s (incidente REST API do GitHub, 2026-07-16). Fica no arquivo o que o step não dá: as 25
formas sintéticas (calibração e falsificação) e a guarda ANTI-VÁCUO do denominador.

**A saída foi PROVADA**, porque apagar detector para fabricar exclusividade é o anti-padrão que este
motor existe para barrar. Mesma invocação, 2 locales, alvo REAL, controle verde antes da 1ª
sabotagem, restauração por cópia provada (sha256 + `git status` limpo):

| locale | fase | `bunpin:check` | suíte vitest inteira |
|---|---|---|---|
| `C` | árvore limpa | rc=0, marcador positivo | **rc=0 limpo** — 842 arq / 9256 testes |
| `C` | `bun-despinado` no `ci.yml` | **reprova**, citando `ci.yml:167` | **0 teste falhando** — 842 / 9256 |
| `pt_BR.UTF-8` | árvore limpa | rc=0, marcador positivo | **0 teste falhando** — 842 / 9256 |
| `pt_BR.UTF-8` | `bun-despinado` no `ci.yml` | **reprova**, citando `ci.yml:167` | **0 teste falhando** — 842 / 9256 |

As contagens do defeito são IDÊNTICAS às do controle — nenhum arquivo sumiu da conta —, e o próprio
`bun-pin-gate-check.test.ts` rodou os 25 testes e passou: ele executou e não viu. O CONTROLE DA
SABOTAGEM fecha o argumento: a porta VELHA (de `HEAD~1`), reinstalada sob o mesmo defeito, **reprova**
nos dois locales, e exatamente no `it` removido. Ou seja, o verde da suíte é ausência de OLHO, não
ausência de defeito — que é a distinção que uma remoção mal feita destruiria.

### O diagnóstico do #2519 estava confundido: a captura não é a causa

As duas seções acima responsabilizam o **pipe** (`stdio: ['ignore','pipe','pipe']`) pelo
`Error: [vitest-worker]: Timeout calling "onTaskUpdate"` que trava o Guard 1b, e o chip aberto é
"capturar em ARQUIVO, não em pipe". **Medido aqui, o chip não resolveria.** Oito rodadas de
`bun run test`, TODAS com stdout em ARQUIVO (redirecionamento do shell, nunca pipe):

| rodada | duração | rc | `onTaskUpdate`? |
|---|---|---|---|
| ensaio | 137s | **0** | não |
| controle (C) ×3 | 266s / 279s / 311s | **1** | sim |
| controle (C), máquina saturada | 2188s | **0** | não |
| defeito (C) · controle e defeito (pt_BR) | 357s / 333s / 166s | **1** | sim |

A mesma captura produz 0 e 1. O discriminador do #2519 trocou captura **e** condição de máquina ao
mesmo tempo; segurando a captura fixa, o vermelho reaparece. Não testei a variante pipe, então o que
fica provado é o lado que interessa: **arquivo não basta**. O RPC estoura por inanição da thread
principal sob contenção, e o conserto certo é o motor não confundir `[vitest-worker]` com
`onTaskUpdate` e ZERO teste falhando com uma reprovação — é a mesma família do `estourou` que ele já
trata como *ausência de dado*, não como vermelho. **Re-escopar o chip antes de executá-lo.**

### O que a saturação fabrica além do RPC

Uma rodada do controle sob `pt_BR.UTF-8` veio com **22 testes falhando** em
`scripts/exclusividade-medir.test.ts` e `scripts/ordem-entre-edges-declaracao.test.ts` — a leitura
óbvia ("locale", a lição do #1483) estava ERRADA. Rodados isolados, os dois arquivos passam 52/52
nos DOIS locales, e a única falha da discriminação caiu sob `C`. São testes que sobem subprocessos
reais com timeout: sob contenção eles estouram e assertam `expected 2 to be 0`. Depois, com a
máquina livre, o `pt_BR` veio 0 falhas. A forma pior: um `fork: Resource temporarily unavailable`
com 1307/1333 processos do uid fez o vitest morrer **sem rodar teste nenhum** — e um harness que
lesse só o rc leria vermelho de teste. Por isso o laço exige linha de resumo com denominador; sem
ela é *ausência de dado*, não reprovação.

**A certificação `[SO ELE]` segue PENDENTE, pelo instrumento.** O `EXCLUSIVIDADE_ZERO` de
`bun-despinado` na matriz está **DEFASADO, não errado**: a causa dele saiu do repo hoje. Fail-closed
— o motor não grava nada —, então nada de falso entrou; mas as três linhas só se resolvem depois do
chip re-escopado.

## O censo que cegava o gate (2026-09-20) — a igualdade de conjunto, de novo

O `censo-sem-o-gate` era a única das seis linhas da re-medição acima sem um vermelho para mostrar. A
causa não estava no motor: estava no gate medido, e o motor só a tornou visível.

A linha 34 de `docs/agent/deploy.md` — o censo que o `gates:frescura` cruza com o inventário do
`ci.yml` — tinha **61 nomes entre crases e 31 distintos**: a lista inteira colada duas vezes, exceto
`gate:ambiente`, que ficou de fora da segunda cópia. Entrou no #2420 (2026-09-09,
`git log -S'docs:citacoes' -- docs/agent/deploy.md`) e ninguém viu por onze dias, porque `lerCenso`
devolvia `[...new Set(nomes)]` e os dois sentidos do gate são cruzamentos de **conjunto**. O
cabeçalho anunciava `(31)` na frente de uma lista de 61, e esse número também não era conferido.

O preço não é cosmético, e é a razão de a medição ter ficado muda: **com a lista em dobro, tirar um
gate do censo deixa de reprovar** — a outra cópia sustenta o conjunto sozinha. É o sentido 2
desligado, com o gate assinando que confere. A sabotagem do corpus (`s/ · \`docs:citacoes\`//`)
remove a primeira cópia e a segunda basta; reproduzido fora do motor, a saída sabotada era idêntica
à do controle.

**O conserto lê a lista como LISTA, por dois eixos que não dependem um do outro:**

| achado | o que pega | por que existe separado |
|---|---|---|
| `CENSO-REPETIDO` | nome com 2+ ocorrências no bloco | é a multiplicidade que o `Set` comia |
| `CENSO-CONTAGEM` | `(N)` do cabeçalho ≠ nomes que a linha lista, CRUS | é o número que o leitor humano confere primeiro |
| `CENSO-SEM-CONTAGEM` | linha que lista nomes sem declarar `(N)` | sem número não há conferência, e conferência que só existe quando a regex casa morre calada |

Uma duplicação acende os dois primeiros; sabotar um deixa o outro de pé. Contra a main de 2026-09-20
a guarda acusou **30 repetidos + 1 contagem errada** (rc=1), e com a linha deduplicada o gate volta a
`FRESCURA-OK` com **38 nomes em 38 ocorrências**.

**A falsificação ganhou o laço que a prosa já prometia.** O docblock de `test-gates-frescura.sh`
afirmava *"a suíte roda nos DOIS locales"* desde que nasceu — e o despacho rodava **um**, o do
ambiente. Era uma asserção sobre execução que não havia, a forma exata do #1483. Agora o laço está no
código, com o UTF-8 achado por sonda POSITIVA (`locale charmap`, nunca `locale -a | grep -q` sob
`pipefail` — §16 do [catálogo de shell](evidencia-positiva-shell.md)), e são 12 sabotagens × 2
locales, cada uma com o controle remontado e exigido verde na MESMA invocação.

Cada sabotagem mira **uma** marca, e por isso o `(N)` do cabeçalho anda junto com a lista em
S3/S4/S10: sabotagem que acende duas lâmpadas não distingue qual delas está ligada.

**O eixo que a suíte não dá: sabotar a GUARDA, não o dado.** As 12 sabotagens provam que o gate
detecta; não provam que a suíte notaria se a guarda saísse. Com o alvo commitado antes (a restauração
é `git checkout --`), cada camada nova foi removida sozinha e a suíte inteira exigida vermelha pela
linha que a mira — controle verde na mesma invocação, alvo reconferido por conteúdo no fim:

| camada sabotada | a suíte disse |
|---|---|
| `vezes.set(n, 1)` — a multiplicidade perdida, o `Set` de antes | `FALHA — S10 … esperava rc=1, veio rc=0` (2x, um por locale) |
| `l.declarado !== l.contados` → `false` | `FALHA — S11 …` (2x) |
| `l.declarado === null` → `false` | `FALHA — S12 …` (2x) |
| as três parcelas fora do `total` (imprime a marca e sai 0) | `RESULTADO: 6 falha(s)` |

A última é a mais instrutiva: o gate **imprime** os três achados e sai `0`. Marca no log não é
veredito — a mesma distinção que este arquivo cobra do motor.

### Três tropeços do instrumento, todos fail-closed

- **O motor atribuiu a MINHA escrita ao gate que rodava.** A 1ª tentativa abortou com
  `GATE-ESCREVEU: bun run evals:deploy-verify alterou a arvore versionada` — e o gate não escreveu
  nada: fui eu, editando este arquivo enquanto o baseline corria. O motor fez o certo (abortou, não
  gravou) e **restaurou** o conteúdo por snapshot, desfazendo a edição. A guarda mede a árvore, não
  a autoria; quem edita durante uma medição perde o trabalho e ganha uma acusação no gate errado.
  A ordem certa é commitar antes e não tocar em nada.
- **`lint:shell` verde me deu a sensação de ter conferido o lint.** São gates diferentes, e o
  baseline do motor foi quem pegou: 32 `no-useless-escape` no teste novo, crase escapada dentro de
  string de aspas simples (necessária só no template literal do helper). Vermelho REAL, meu, e o
  único dos três que não era carga: terminou em 12s. O motor como detector de dívida do próprio
  autor é um uso que não estava no desenho.
- **Os outros dois vermelhos eram a saturação**, a classe que a seção do `bunpin:check` acima acabou
  de falsificar como "captura": `test` morto por SIGTERM em 744.165 ms (112 s na máquina calma) e
  `test:falsificacao` em 3.144.139 ms contra 907.829 ms da baseline commitada — 3,5×. `tsc` levou
  929.631 ms contra 30.598 ms, 30×. `test:hooks` passou VERDE em 1.933.352 ms, e é o que interessa:
  ele roda `test-gates-frescura.sh`, então as 12 sabotagens × 2 locales foram exercitadas na árvore
  real pelo gate do CI, não só à mão.

### A re-medição (2026-09-21, sourceHead `5a866d509`) — o zero é a QUARTA segunda porta

Baseline **31/31 verde** — o que as duas tentativas anteriores não conseguiram, e a diferença foi só
a máquina esvaziar: `tsc` 26.387 ms (eram 929.631), `test` 102.431 ms e rc=0 (eram 744.165 e SIGTERM).
Nada no repo mudou entre elas.

| defeito | rodados | vermelhos | veredito |
|---|---|---|---|
| `censo-sem-o-gate` | 29 de 31 (poda) | `gates:frescura` 136 ms · `test:hooks` 112.600 ms | `EXCLUSIVIDADE_ZERO` |

**O antes e o depois é o ponto:** a mesma sabotagem, no mesmo alvo, com o mesmo corpus, passou de
**nenhum vermelho entre 31 gates** (`pegou 0`, sem veredito nenhum) para dois. O `gates:frescura` sai
de `pegou 0 de 31` para `pegou 1 de 12` na matriz. O que mudou foi o gate deixar de comparar conjuntos.

**Os 2 não rodados são os 2 mais caros, e isso é desenho:** o motor ordena do mais barato ao mais
caro e para no 2º vermelho (`test:falsificacao` 1.002.966 ms e `sonda:cron-prova` 311.934 ms ficaram
de fora). Cuidado ao ler a matriz: a linha tem **31** execuções, não 29 — as dos podados vêm
preservadas da rodada anterior, com `ms` e `fingerprint` idênticos bit a bit. "31 execuções
registradas" não é "31 rodados nesta rodada", e nenhum campo da execução distingue os dois.

**O zero é a quarta segunda porta da família** — e, como as três que a main fechou hoje, é o MESMO
código por outra porta, não um segundo detector. O modo normal de `scripts/test-gates-frescura.sh`
termina com o passo *"repo de verdade passa"*, que roda `bun "$GATE"` contra a raiz real: a mesma
invocação, a mesma árvore, o mesmo CI que o step `gates:frescura`. Foi ele que reprovou dentro do
`test:hooks`.

**A decisão aqui NÃO é óbvia como nas outras três, e por isso fica registrada em vez de executada.**
Nas outras, o concorrente era um `expect(...).toEqual([])` num vitest — mensagem que não ensina nada
a quem a vê vermelha. Aqui o concorrente é uma suíte bash que existe como **eixo POR FORA** declarado:
o gate lê o `ci.yml` e mora no `ci.yml`, então herda o defeito da máquina que vigia. As opções:

- *tirar só o passo "repo de verdade passa"* — a suíte guarda as 12 sabotagens sobre a raiz SINTÉTICA,
  que é o que ela tem de único, e o step vira dono do repo real. É a mesma escolha das outras três, e
  o que se perde é a rede para o dia em que o step sair do `ci.yml`;
- *manter como está* — custo 0 e a matriz segue carimbando `EXCLUSIVIDADE_ZERO` no dono único de um
  eixo que acabou de passar onze dias desligado. O zero medido vira argumento para cortar o gate
  errado;
- *manter e DISPENSAR a linha* — honesto se a redundância é desejada, mas a dispensa precisa dizer
  qual das duas portas é a que se pretende manter.

Tirar detector para fabricar exclusividade é o anti-padrão que este motor existe para barrar, e nesta
instância o detector a tirar seria o de um gate cuja cegueira acabou de ser medida. Fica como chip,
com a medição na mão — que é a diferença entre decidir e adivinhar. **Decidido em 2026-09-21: ver
"A quarta segunda porta fechada", abaixo.**

**O preço de mexer num gate: as outras 15 linhas ficam podres para ele.** `bun run exclusividade`
passa a AVISAR `LINHA_PODRE: gates:frescura — a fonte mudou desde a medicao
(7677bffbe8ca936b -> ad1c03879cda2543)`, porque só a linha re-medida carrega o fingerprint novo: 1 de
12. É aviso, não reprovação (rc=0), e a matriz já convivia com três fingerprints diferentes deste
mesmo gate antes deste PR. Junto com as três que os PRs de hoje deixaram (`bunpin:check`,
`test:hooks`, `test:falsificacao`), são 4 linhas podres esperando re-medição — e re-medir as 16 com os
31 gates é uma rodada de horas que depende da M2 estar vazia, como esta seção mostrou.

## A quarta segunda porta fechada (2026-09-21) — o limb que só a suíte alcança

A decisão que a seção acima deixou como chip foi tomada: **sai o passo, fica o limb.** O que
inclinou não foi o precedente das outras três — foi a medição do único argumento que sustentava
"manter", feita antes de tocar em código:

| experimento | pergunta | resultado |
|---|---|---|
| A | com o step FORA do `ci.yml`, o `exclusividade` acusa? | **MUDO** — rc=0, zero menções a `gates:frescura`, zero `REPROVA`. Ele cobra linha de matriz para gate PRESENTE no `ci.yml`; a direção inversa não tem veredito |
| B | e o próprio gate? | acusa **`CENSO-OBSOLETO`** sobre si mesmo, rc=1, contra um espelho da raiz real cujo controle estava VERDE (`FRESCURA-OK`) |

Juntos, os dois dizem o que a leitura de código sozinha não diria: **a rede contra "o step sumiu do
`ci.yml`" era real e era única** — e existia por ACIDENTE, dentro de uma execução que no resto era
duplicata pura. É o ponto cego estrutural de todo auto-vigia: *não reprova quando não roda*. O step
jamais o cobre sobre si mesmo, por mais que rode.

Então a execução duplicada saiu e o limb ficou NOMEADO, na forma mais estreita que o cobre —
`step_no_ci`, que casa a invocação numa linha **não-comentada** do `ci.yml`. O texto cru não serve:
o `ci.yml` cita esta suíte em comentário logo acima do step, e um `grep` ingênuo leria a própria
prosa como se fosse a invocação — o mesmo erro que o gate evita parseando blocos `run:` em vez do
YAML inteiro. É a escolha do #2528 (a fixture assumiu o limb `MAX_LINE` que o repo real cobria por
acidente), com o eixo invertido: aqui a suíte assume EXPLICITAMENTE o pedaço que só ela alcança e
larga o resto.

A sonda nasce falsificável: **S13** sabota uma CÓPIA do `ci.yml` — escrever no real é o que o motor
acusa como `GATE-ESCREVEU`, e é a razão de `exclusividade-gate.ts` aceitar `--ci <arq>` — com o
controle exigido antes e na MESMA invocação, porque sonda sempre-ausente aprovaria a sabotagem sem
provar nada. 13 sabotagens × 2 locales: 26 ok, 0 falhas.

### A prova da saída

Mesma invocação do CI, alvo REAL (`docs/agent/deploy.md`), controle exigido verde antes da 1ª
sabotagem e restauração conferida por CONTEÚDO (sha256 de volta ao original) a cada locale:

| `LC_ALL` | fase | `gates:frescura` (o step) | `test:hooks` (a suíte) | porta VELHA reinstalada |
|---|---|---|---|---|
| `C` | controle | rc=0 · `FRESCURA-OK` | rc=0 (136 s) | — |
| `C` | **sabotado** | **rc=1 · `NAO-CITADO`** (1 s) | **rc=0** (130 s) | **rc=1** |
| `pt_BR.UTF-8` | controle | rc=0 · `FRESCURA-OK` | rc=0 (135 s) | — |
| `pt_BR.UTF-8` | **sabotado** | **rc=1 · `NAO-CITADO`** (0 s) | **rc=0** (142 s) | **rc=1** |

Lida por coluna: **a detecção ficou** (o step reprova com `NAO-CITADO` sob o defeito) e **a duplicata
saiu** (a suíte de hooks fica verde). A terceira medida é a que separa isto de fabricar exclusividade:
**a porta VELHA, reinstalada sob o MESMO defeito, reprova** — logo a sabotagem continua visível a quem
olha, e o verde do `test:hooks` é ausência de OLHO, não ausência de defeito. Sem essa terceira coluna,
"tirei o detector" e "tirei a duplicata" produzem a mesma tabela.

### Dois tropeços do instrumento, ambos fail-closed

- **BSD `sed` não expande `\n` no replacement.** A primeira montagem da porta velha saiu silenciosamente
  sem o passo reinstalado. Rodar assim teria produzido "a porta velha não reprova" sobre um arquivo onde
  ela nem existia — o veredito EXATAMENTE invertido, e a favor deste PR. Pegou porque a montagem exige
  resposta POSITIVA (`grep -q` do passo reinstalado + `bash -n`) antes de rodar qualquer coisa.
- **`$` em `grep` é âncora de fim de linha.** O padrão de conferência era `cd "$RAIZ_REPO" && bun "$GATE"`,
  e sem `-F` ele nunca casaria: a mesma guarda acima daria ABORTA para sempre. Presente-porém-quebrada
  esvazia o guard igual à ausente — por isso a conferência é `grep -qF`.

Os dois são a mesma família do catálogo de [evidência positiva em shell](evidencia-positiva-shell.md):
o shell fabrica veredito, e quem mede tem de exigir o sinal POSITIVO de que a sabotagem existe antes de
cobrar o vermelho dela.

### O que fica DEFASADO

O `EXCLUSIVIDADE_ZERO` de `censo-sem-o-gate` na matriz: a causa dele (o `test:hooks` co-pegando) saiu do
repo, mas a linha só muda com re-medição — a rodada de horas que depende da M2 vazia. O `manifesto.def`
carrega o aviso, como já carrega o do `bun-despinado`. E `scripts/test-gates-frescura.sh` é fonte do
`test:hooks`: as linhas da matriz que o medem ficam PODRES (aviso, rc=0), somando-se às que o #2528/#2530
já deixaram.

## O vermelho que não era reprova (2026-09-25) — a causa era o motor, não a captura

O chip aberto pelo #2519 ("capturar em ARQUIVO, não em pipe") foi **re-escopado e executado aqui**.
O #2530 já tinha falsificado a hipótese do pipe; o que faltava era o conserto que ela atrasou.

**A causa.** `rodarGate` fazia `reprovou = r.status !== 0`. Isso não distingue "teste falhou" de
"RPC de infra estourou" — e o motor **já tinha o conceito certo ao lado**, o `estourou`
(timeout/sinal), que marca ausência de dado e invalida a linha em vez de contá-la como vermelho.
A guarda 12 põe o caso do RPC na mesma família.

**A classificação** (`scripts/lib/vitest-rpc.ts`) é fail-closed por construção: só é ausência de
dado quando TODAS batem — resumo do vitest presente, ZERO teste e ZERO arquivo falhando,
denominador acima do piso anti-truncamento, e os erros DECLARADOS pelo vitest (`Errors  N error`)
serem TODOS a família `[vitest-worker|pool]: Timeout calling "…"`, com N ≥ 1. Qualquer outra coisa
— saída ilegível, suíte morta antes do resumo (`fork: Resource temporarily unavailable`), um
segundo erro real — continua REPROVA. A leitura usa os canais **inteiros**, nunca a `cauda` de 600
bytes: um erro real enterrado fora dos últimos bytes viraria "só o RPC".

As duas formas foram tiradas do `vitest run` 3.2.6 **real** deste repo, num fixture descartável,
não do bundle minificado:

```
 Test Files  842 passed (842)        Test Files  1 failed | 841 passed (842)
      Tests  9256 passed (9256)            Tests  1 failed | 9255 passed (9256)
     Errors  1 error                      Errors  1 error
```

### A lição que este conserto quase atropela

[a-forma-que-some-e-a-forma-que-mente.md](a-forma-que-some-e-a-forma-que-mente.md) registrou, sobre
a **mesma string de erro**: *"o veredito é o exit code, não o texto bonito acima dele — e um
vermelho que aparece como verde ensina a ignorar vermelho"*. A reconciliação honesta, e ela não é
uma isenção: **o texto nunca vira veredito** — `classificarVermelho` não devolve "verde", no máximo
devolve ausência de dado —, **mas ele decide QUAL OBSERVAÇÃO VALE**. Isso é política de repetição, e
por isso ela é declarada, com orçamento 1, dono único (`rodarComReproducao`) e término explícito.

### O que o Codex derrubou — e o que sobrou

O parecer (challenge, gpt-6-astra) achou um buraco concreto no desenho original, que previa repetir
em qualquer vermelho suspeito:

> *Classificador largo demais: defeito real intermitente vira suspeito → segunda execução passa →
> **verde falso**, apagando uma detecção.*

O caso não é hipotético — é o incidente dos 79s do doc acima: um laço CPU-bound **do próprio
defeito** segura o event loop e produz assinatura IDÊNTICA à da máquina saturada. A assinatura não
separa as duas, e cache quente na 2ª execução ainda enviesa a favor do verde. Daí a regra final:

- **No baseline repete-se UMA vez.** Ali não há defeito, então "o defeito causou a lentidão" é
  hipótese vazia, e um `rc=0` limpo prova exatamente o que o baseline afirma.
- **Sob defeito não se repete.** Suspeito vira linha INVÁLIDA na hora — ausência de dado, jamais
  "ninguém pegou". Custa re-medição; nunca fabrica um verde.

Errei também a direção do perigo: eu argumentei que classificar largo demais só produziria
aborto/linha-inválida (seguro). Não é simétrico — largo demais apaga detecção pelo caminho do
verde falso, e é por isso que a repetição sob defeito saiu.

### A falsificação

Uma camada por vez, nos DOIS locales, com CONTROLE verde na MESMA invocação (o laço aborta antes do
1º `sed` se o controle não estiver verde) e restauração por cópia conferida por `git status`:

| camada sabotada | o que ela sustenta | `C` | `pt_BR.UTF-8` |
|---|---|---|---|
| L1 `falharam > 0` | teste falhando manda, o RPC não absolve | vermelho | vermelho |
| L2 `rpc === 0` | gate composto sem linha `Errors` não casa por vacuidade (`0 === 0`) | vermelho | vermelho |
| L3 `declarados !== rpc` | um 2º erro real sobra e reprova | vermelho | vermelho |
| L4 `!resumo` | suíte morta antes do resumo não vira verde | vermelho | vermelho |
| L5 piso do denominador | suíte truncada não é suíte verde | vermelho | vermelho |
| L6 âncora na coluna 0 | a string dentro de um code-frame não conta | vermelho | vermelho |
| L7 não repetir sob defeito | a repetição é exclusiva do baseline | vermelho | vermelho |
| L8 repetir no baseline | sem ela o baseline volta a abortar | vermelho | vermelho |

**Dois tropeços do instrumento, ambos fail-closed — e o segundo achou teatro de verdade.**

1. O laço reportou `SABOTAGEM-NAO-APLICOU` em três camadas na 1ª tentativa: o `|` do `s|…|…|`
   colidia com o `||` dentro dos próprios padrões. Ele **não** contou isso como camada medida —
   se contasse, três camadas sairiam "provadas" sem uma única execução.
2. A L6 **SOBREVIVEU** à sabotagem. O teste da âncora era TEATRO: a fixture usava
   `new Error('[vitest-worker]…`, que **não contém** `Error: [vitest-`, então a âncora nunca era
   exercida. Trocada pelo caso real — um code-frame citando a linha da própria fixture —, ela passa
   a morder. É a lição de [gates-textuais-cegos.md](gates-textuais-cegos.md) aplicada ao teste:
   verde por CEGUEIRA, e só a sabotagem separa "não achou" de "não olhou".

E o BSD `sed` trata `^` como âncora **no meio do padrão**: `s#/^Error#…#` sai 0 sem casar e sem
erro. Sem o marcador literal pós-`sed`, a camada sairia "medida".

### A tentativa de re-medição (2026-09-25) — o teto do motor NÃO vincula, e a M2 não estava medível

Disparada com os 4 defeitos cuja causa saiu do repo (`bun-despinado`, `claude-md-linha-gigante`,
`censo-sem-o-gate`, `sonda-responde-antes-do-gate-fora-da-lista-diligente`) e
`EXCL_TIMEOUT_MS=2400000`. **O baseline passou 21 de 31 gates VERDE** — inclusive o `test`, que era
o que abortava as duas tentativas anteriores — e então parou em:

```
VERMELHO  sonda:cron-prova   4774853ms (ESTOUROU 2400000ms)
```

**Dois achados, e o primeiro é um defeito do motor.** O teto é `timeout` de `spawnSync`, que manda
SIGTERM no prazo mas **espera o filho sair de verdade**: o decorrido foi 4.774.853 ms contra um teto
de 2.400.000: **quase o dobro**. Um teto que não vincula é a família de
[espera-sem-desistencia.md](espera-sem-desistencia.md) — o `estourou` marcou certo (ausência de
dado, fail-closed), mas o custo não foi contido. Fica como pendência separada: o teto precisa de
`SIGKILL` depois de uma carência, ou de `spawn` assíncrono com o próprio relógio.

**O segundo é que a máquina não estava medível**, e isso não se lê pelo relógio de parede: `load
average 216,63` com swap em 5.554 de 6.144 MB e **seis `vitest` de outras sessões** moendo a CPU.
O `sonda:cron-prova --gate`, que o doc de 2026-09-21 cronometrou em 1.143 s, levou 4.775 s — 4,2×.
Nada no gate mudou; mudou a máquina.

**Nada foi gravado.** O motor é fail-closed: a matriz só é escrita no fim, e a rodada morreu no
baseline, antes de qualquer sabotagem — árvore limpa conferida por `git status --untracked-files=all`,
`scripts/exclusividade-matriz.json` byte-idêntico. As 4 linhas seguem **DEFASADAS**, pelo instrumento
e pela máquina, não pelo repo.

### A guarda 12 caiu no baseline real — o vitest colore sob o ambiente do motor (2026-09-25)

Com o #2543 na `main` e a máquina calma, a re-medição foi disparada de novo. O baseline passou o
`sonda:bump` em 10 minutos (a tentativa sob load 216 levou 1h06 até ali) — e então:

```
VERMELHO  test   78978ms
```

**Sem a repetição disparar.** O classificador viu REPROVA onde deveria ver ausência de dado. A cauda
mostrou por quê — a linha do erro chegou assim:

```
ESC[31mESC[1mError ESC[22m: [vitest-worker]: Timeout calling "onTaskUpdate"ESC[39m
```

Com a cor, o `Error:` não fica na coluna 0 e as linhas de resumo não casam: a guarda caía no seu
primeiro teste ("sem linha de resumo") e devolvia REPROVA, fail-closed. Nada falso foi gravado — o
baseline abortaria —, mas a guarda simplesmente não funcionava na única saída que importa.

**Medido em ambiente limpo (`env -i`), variável por variável:**

| ambiente | ESC no stdout | ESC no stderr |
|---|---|---|
| nada | 0 | 0 |
| só `CI=1` | 8 | 23 |
| só `FORCE_COLOR=0` | 8 | 23 |
| `CI=1 FORCE_COLOR=0` (o do motor) | 8 | 23 |

As DUAS variáveis que o motor impõe ligam a cor, mesmo com a saída num arquivo. O `FORCE_COLOR=0`
provavelmente foi escrito para DESLIGAR a cor; na biblioteca do vitest a mera presença da variável a
força. E o CI de verdade (`CI=true`) também colore — então saída colorida não é caso de borda, é a
norma.

**O erro foi meu, e é a lição deste doc um andar abaixo.** As formas que eu "tirei do vitest real"
na seção acima foram capturadas num shell **sem** essas variáveis. Validei o classificador contra a
saída de outro ambiente — paridade de invocação, a regra que abre este documento, violada pelo
instrumento que o protege. A suíte passou 16/16, a falsificação passou 8/8, e as duas estavam certas
sobre a entrada errada.

**O conserto:** `semAnsi` antes de qualquer leitura (o stripper que já existia no gate do
`edges:typecheck`; dos 208 ESC da captura, 208 são SGR, que ele cobre), e `ENV_DO_MOTOR` num lugar só,
usado pelo motor nos dois pontos. O que teria pegado o erro — e agora pega — é o **teste de
paridade**: o vitest real, sob `ENV_DO_MOTOR`, num fixture descartável, **exigindo que a saída venha
colorida**. Sem essa pré-condição ele seria o teatro da L6 de novo: passaria sem exercitar o caminho.
A falsificação ganhou três camadas (ANSI no stderr, no stdout e no `lerResumoVitest`), cada uma
protegendo um eixo diferente.

## A regra

**Instrumento de medição prova que rodou O QUE diz medir**: a invocação exata do CI, contra a árvore
que diz medir, com a execução registrada. Nome de gate na matriz não é execução; `naoMedido` não é
medição; linha que não rodou todo mundo não certifica ninguém; e um pós-passo que o autor escreve
não pode ser a alavanca da medição a favor dele. É `ausente ≠ zero` aplicado ao próprio medidor —
a mesma lição de [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (a baseline
do `test:hooks` era OUTRA invocação), um andar acima.
