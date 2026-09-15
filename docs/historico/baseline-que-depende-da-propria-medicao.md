# O baseline que depende da própria medição — o gate que lê a matriz travava a rodada que a escreveria

**2026-09-14.** Continuação de [exclusividade-media-outra-coisa.md](exclusividade-media-outra-coisa.md) (#2479).

## O impasse

`scripts/exclusividade-medir.ts` (o motor) só mede se **todo** gate bloqueante estiver verde no repo
limpo. É a guarda 1b, herdada de [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md):
um gate já vermelho antes da sabotagem fica vermelho em todo defeito e vira um detector universal
fabricado.

Só que um desses gates é o `exclusividade` (`scripts/exclusividade-gate.ts`), e ele lê a matriz que
o motor **escreve**. Acrescente um gate bloqueante G ao `ci.yml` e:

1. `bun run exclusividade` reprova `GATE_NOVO_SEM_EXCLUSIVIDADE`, porque G não tem execução em linha válida;
2. no baseline do motor, o `exclusividade` fica vermelho e a guarda 1b aborta;
3. a execução de G, a única coisa que o poria verde, nunca é gravada.

Havia dois contornos, os dois ruins. `--gates <os outros 30>` é feito à mão, e esquecer um nome muda
a medição sem aviso. `--ignorar-baseline` ignora **qualquer** vermelho, inclusive o de um gate
quebrado de verdade.

## A saída: tirar da rodada SÓ ele, e só pelo motivo certo

Depois do baseline, se o `exclusividade` ficou vermelho, o motor roda a **sonda**: a mesma invocação
do CI + `-- --json`, com o mesmo env e sob o write-guard. A decisão é uma função pura
(`exclusividadeVermelhaSoPorGateNovo`, em `scripts/lib/exclusividade.ts`), e cada critério falha
**fechado**: na dúvida, vale o aborto de sempre.

| critério | recusa (marca ASCII no motivo) | por quê |
|---|---|---|
| o baseline saiu exatamente 1 | `RC-BASELINE` | 2 é erro do próprio gate; `null` é sinal ou estouro, ausência de dado |
| a sonda saiu exatamente 1 | `RC-SONDA` | baseline 1 com sonda 0 é a mesma leitura discordando de si |
| o stdout é JSON | `SONDA-ILEGIVEL` | o `bun run` de um script ausente também sai 1 |
| o JSON segue o contrato, com severidade conhecida | `SONDA-FORA-DO-CONTRATO` | protocolo desconhecido nunca vira "não é REPROVA, então passa" |
| a âncora da raiz está intacta | `ANCORA-QUEBRADA` | a âncora quebrada também sai 1, e não é gate novo |
| há ≥1 REPROVA | `SEM-REPROVA` | exit 1 sem motivo legível |
| toda REPROVA é `GATE_NOVO_SEM_EXCLUSIVIDADE` | `REPROVA-ALHEIA` | `MATRIZ_AUSENTE` é um vermelho que a rodada não resolve |
| o gate novo não é o próprio `exclusividade` | `GATE-NOVO-E-O-PROPRIO` | tirá-lo da rodada nunca gravaria a execução que o livraria |
| todo gate novo é executado por esta rodada | `GATE-NOVO-FORA-DA-RODADA` | se o `--gates` deixou G de fora, excluir só esconderia o porquê |

Se todos passam, o `exclusividade` não roda em defeito nenhum e **só ele** sai da conta do baseline;
qualquer outro vermelho continua abortando. O motor avisa alto: imprime `EXCLUSIVIDADE-FORA-DA-RODADA`
logo depois do baseline e de novo no fim, com `GATE-NOVO-RESOLVIDO <g>` ou `GATE-NOVO-SEM-EXECUCAO <g>`
para cada gate novo. A resposta do fim se limita ao critério do `GATE_NOVO` (`rodou` na matriz
fundida). Afirmar que o gate inteiro ficou verde exigiria rodá-lo de novo.

**Alternativas descartadas:**
- Env ou flag no gate para ignorar `GATE_NOVO` durante a medição: quebra a paridade de invocação, e
  o motor mediria outro comando com o nome do gate.
- Pôr G em `dispensados` e tirar depois: a dispensa é dívida de nascença, não andaime.
- Duas fases, medindo o `exclusividade` contra a matriz pré-gravada: a árvore fica suja durante a
  medição e a matriz passa a depender de si mesma.
- Calcular o veredito dentro do motor com `avaliar`: seria prever o gate em vez de perguntar ao
  binário que ficou vermelho.

## O furo que a 2ª opinião achou: a célula herdada certificava o gate novo

O Codex (`gpt-6-astra`, max) concordou com o recorte e achou o buraco que o desenho não via.
`fundirLinhas` funde por `(defeito, gate)` e **preserva** a célula de todo gate que a rodada não
executou. Numa rodada que excluiu o `exclusividade`, a linha re-medida herdava a célula antiga dele.
Com todo o universo "executado" por nome, dois certificados falsos ficavam possíveis:

- verde antigo do `exclusividade` + vermelho único e novo de G ⇒ **`[SO ELE]` para G**, com a célula
  de um regime em que G nem existia;
- vermelho antigo dele + verdes novos ⇒ `[SO ELE]` para ele mesmo.

O contorno `--gates <todos menos ele>` já fazia o mesmo: "a linha fica `[inconcl]`" só valia para
defeito novo.

A correção óbvia, descartar a célula, cria um **impasse pior**. Numa rodada do corpus inteiro, o
`exclusividade` fica sem nenhuma execução válida e passa a reprovar `GATE_NOVO` **contra si mesmo**;
a partir daí nenhuma rodada o exclui (`GATE-NOVO-E-O-PROPRIO`).

Por isso a célula fica, marcada em **`defasados`** (campo opcional da linha). Ela conta como execução
(`rodou`), então o `GATE_NOVO` dele não volta. Mas **nunca fecha a completude**: a linha não certifica
ninguém. Uma rodada que re-execute o gate limpa a marca, e é essa a receita que o aviso prescreve:
`bun run exclusividade:medir -- --gates exclusividade`.

Outros ajustes do parecer, todos aceitos:
- aceitar só as severidades `REPROVA|AVISA|RELATA`;
- guardar o exit **bruto** e o stdout **inteiro**, separado do stderr (a `cauda` de 600 caracteres
  mistura os dois e corta);
- **não combinar** com `--ignorar-baseline`: com a flag, "só ele saiu da conta" deixaria de ser
  verdade, então o motor imprime `IGNORAR-BASELINE-SEM-EXCLUSAO` e mede como sempre mediu;
- excluir **antes** de montar `ordenados`, para que o `@suspeito` podado não o traga de volta.

## Como foi provado

**RED antes do código.** Os testes foram para um commit próprio, com a função pura como STUB, e
rodaram contra um snapshot congelado desse commit (`git archive`). Assim a implementação pôde seguir
no worktree enquanto a fila do `heavy` andava (1 vaga para 10 jobs), sem contaminar o vermelho.
Resultado: `23 failed | 4 passed`. Toda falha é a funcionalidade ausente: `'STUB'` no lugar da marca
do ramo, `defasados` indefinido, o motor abortando no baseline sem `EXCLUSIVIDADE-FORA-DA-RODADA`. Os
4 verdes descrevem o comportamento correto de hoje e são o controle de alcance: o CONTROLE do fixture
com o gate real (verde na base), o `--dry`, a fusão sem célula antiga e a célula defasada contando
como execução.

A primeira tentativa desse RED "passou" sem rodar. O job foi morto ainda na fila do `heavy`, e o
veredito `[ "$rc" -ne 0 ]` virou exit 0 com `vitest rc=143` e nenhum `red.json`. É o eco de
[evidencia-positiva-shell.md](evidencia-positiva-shell.md) com o sinal trocado: esperar vermelho
também fabrica veredito. Por isso o RED só contou com o JSON existindo e trazendo falhas **e**
aprovações.

**GREEN.** Rodaram, todos com rc 0:
- as duas suítes inteiras (`scripts/exclusividade-gate.test.ts` e `scripts/exclusividade-medir.test.ts`), 139 testes e 0 falha;
- `scripts:typecheck`;
- o eslint dos 4 arquivos, depois do rebase e já com a regra de `process.env` do #2490;
- o `knip`.

O `bun run exclusividade` real, contra a matriz commitada, segue rc 0 e sem REPROVA: nenhuma linha
tem `defasados`, então o veredito do CI não muda.

**Falsificação: 27 camadas × 2 locales (`LC_ALL=C` e `pt_BR.UTF-8`), 54 de 54 pegas.** Uma camada
por vez, sempre na mesma sequência:
1. **Controle:** a mesma invocação (`vitest run <suíte> --testNamePattern=<títulos>`), sem
   sabotagem, exigida verde e com os títulos esperados PASSANDO.
2. **Sabotagem:** só contou se o JSON do vitest mostrasse os títulos esperados FALHANDO.
3. **Restauração:** por cópia, provada por bytes e por `git diff --quiet HEAD` antes de julgar.

| camadas | onde | pegas por |
|---|---|---|
| C1 C2 C3 C6 C7 C8 C9 C10 C11: cada critério da função pura | lib | o teste unitário do ramo (a marca ASCII, nunca "recusou algo") |
| D1 D2 D3: marcar, manter e limpar `defasados` na fusão | lib | os unitários de `fundirLinhas` |
| D4: `defasados` não fecha a completude · D5: mas conta como execução | lib | os unitários de `derivar`/`avaliar` (D5 é o impasse do descarte) |
| Ma–Mk: a fiação no motor (detalhe abaixo) | motor | os cenários do fixture com o gate real |
| FD4, FC11: dois critérios da lib, de ponta a ponta | lib | o fixture |

As camadas Ma–Mk cobrem, cada uma, um elo da fiação: decidir; respeitar a decisão; só ele sai da
conta; ele não roda em defeito; a sonda roda sob o write-guard; a sonda leva `--json`; o exit bruto
do baseline; o exit bruto da sonda; `--ignorar-baseline` não combina; a fusão recebe o excluído; a
linha final não fabrica "resolvido".

Dois casos unitários foram reescritos ANTES da falsificação, ao desenhar as camadas. Com a guarda
sabotada, a exclusão continuava recusada por OUTRO ramo: a severidade desconhecida sozinha caía em
`SEM-REPROVA`, e `MATRIZ_AUSENTE` caía em `GATE-NOVO-FORA-DA-RODADA`. O teste "pegava" pelo rótulo,
não pela segurança. Agora cada um põe um `GATE_NOVO` válido ao lado, e só a guarda certa segura a
exclusão. Pelo mesmo critério, sabotagens que só trocariam a marca ou derrubariam o processo (que já
falha fechado) não viraram camada, e a checagem de `codigo` não-string saiu, porque não protegia nada.

## A regra

**Uma guarda de "baseline verde" sobre um gate que lê a SAÍDA da própria medição trava por
construção.** A saída não é afrouxar o baseline. É tirar da rodada exatamente esse gate, e só quando
o único motivo do vermelho é o que a rodada vai gravar, perguntando ao binário em vez de presumir.

E **excluir não apaga o passado dele**: a célula antiga continua sendo execução, mas é de outro
regime e não fecha linha nenhuma. É `ausente ≠ zero` com uma variante: **antigo ≠ em dia**.
