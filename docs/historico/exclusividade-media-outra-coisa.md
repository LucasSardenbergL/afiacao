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
(passo 13 de `test-claude-md-budget.sh`) foi fechada dois dias depois — seção abaixo; a do
`bunpin:check` (`bun-pin-gate-check.test.ts`) segue aberta.

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

Das três segundas portas medidas, resta aberta uma: `bunpin:check` em
`scripts/bun-pin-gate-check.test.ts`
(*"os workflows REAIS do repo passam no gate"*, `auditBunPins(readWorkflows())`).

## A regra

**Instrumento de medição prova que rodou O QUE diz medir**: a invocação exata do CI, contra a árvore
que diz medir, com a execução registrada. Nome de gate na matriz não é execução; `naoMedido` não é
medição; linha que não rodou todo mundo não certifica ninguém; e um pós-passo que o autor escreve
não pode ser a alavanca da medição a favor dele. É `ausente ≠ zero` aplicado ao próprio medidor —
a mesma lição de [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (a baseline
do `test:hooks` era OUTRA invocação), um andar acima.
