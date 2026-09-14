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

## A regra

**Instrumento de medição prova que rodou O QUE diz medir**: a invocação exata do CI, contra a árvore
que diz medir, com a execução registrada. Nome de gate na matriz não é execução; `naoMedido` não é
medição; linha que não rodou todo mundo não certifica ninguém; e um pós-passo que o autor escreve
não pode ser a alavanca da medição a favor dele. É `ausente ≠ zero` aplicado ao próprio medidor —
a mesma lição de [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (a baseline
do `test:hooks` era OUTRA invocação), um andar acima.
