# O abort do `mutcheck` não dizia POR QUÊ — e a prova do conserto pegou três medições erradas antes de pegar código

**2026-09-14.** Classe: **veredito sem motivo** — o abort descartava a evidência da própria execução
que o fez recusar. O `scripts/mutcheck.sh` faz certo ao recusar medir sobre baseline vermelho (suíte
sempre-vermelha "pega" todo mutante e aprovaria qualquer coisa), mas a `run_tests` mandava a saída da
suíte para `/dev/null`: o job `mutation-check` mostrava só
`baseline: ✗ VERMELHO — a suíte já falha sem mutação`, e cada ocorrência custou uma investigação do
zero — 09-06 (`sonda-versao-sql.mut`, clone raso sem `origin/main`) e 09-11 a 14
(`sonda-versao-bump-gate.mut`, 24 runs vermelhos). Era o item 2 do "ficou em aberto" de
[teste-que-afirma-o-checkout.md](teste-que-afirma-o-checkout.md).

## O conserto

- **A MESMA execução, nunca uma re-rodada.** A saída dos dois baselines (compilador e suíte) vai para
  `<pendentes>/<chave>.saida-baseline`, ao lado do backup — diretório que a rodada já provou gravável,
  sem modo de falha novo — e é apagada no `finalizar`, depois do restore. Re-rodar para obter o log
  mediria outra execução, e o motivo (clone raso, OOM, rede) pode não se repetir.
- **O recorte.** No abort sai o exit da execução e os últimos 4096 bytes: sem CSI, sem bytes de controle
  (NUL incluso), em UTF-8 válido — decodificado DEPOIS do corte, então o caractere partido vira U+FFFD —
  e com `│ ` na coluna 0 de cada linha. A linha do abort, o exit 1 e o ponto de parada não mudaram, e o
  `|| true` depois de `mostrar_saida_baseline` impede que um recorte que falhe troque o exit.
- **Texto de terceiro não classifica.** O `registrar()` do `mutcheck-all.sh` exclui `^│ ` antes de contar
  `⚠ INVÁLIDO`, `← DIVERGE`, `baseline: ✗` e `sumário:` — senão a saída da suíte fabricaria veredito no
  JSON que o alerta do CI lê.
- **`>|` na escrita da suíte.** É a segunda escrita no arquivo que o compilador acabou de criar; sob
  noclobber (`set -C`, ou `SHELLOPTS` herdado do ambiente — medido) o `>` a barraria e a suíte nem
  rodaria.

```
  baseline: ✗ VERMELHO — a suíte já falha sem mutação. Resultados seriam lixo. Abortando.
┌─ saída desta MESMA execução do baseline (exit 1; 288 bytes, sem ANSI):
│  ✓ sonda-versao-bump-gate.test.ts > gate > aceita bump
│  × sonda-versao-bump-gate.test.ts > historia > onda 2
│ Error: fatal: bad object 5f87e103d^
│     at coletarEstado (scripts/sonda-versao-bump-gate.ts)
│  Test Files 1 failed (1)
└─
```

## Onde isto é exercitado

O `mutation-check` segue fora do caminho obrigatório, mas o `scripts/test-mutcheck-sensor.sh` roda no
`test:hooks`, step do job `gates-e-falsificacao`, que é `needs` do `validate` required: as asserções
novas barram PR. Local ficou só a falsificação (abaixo), porque o CI roda o sensor sem sabotar.

## O que a prova pegou ANTES de pegar código

Falsificação transitória (scratchpad): controle verde na MESMA invocação do laço, nos dois locales,
antes da 1ª sabotagem; uma camada por vez; conjunto EXATO de marcas ASCII e exit por sabotagem;
restauração por cópia conferida com `cmp` e `git diff --quiet`, e controle de saída.

1. **Regra sem vermelho é enfeite — cortada antes de falsificar.** OSC, `\r`, janela de leitura e um
   `echo` de fallback não mudavam asserção nenhuma e saíram. O `compila` ficou com `>`: é a primeira
   escrita, e um `>|` ali não teria vermelho próprio.
2. **O `iconv` do macOS reprova UTF-8 VÁLIDO** quando um caractere multibyte começa no byte 1022 ou 1023
   (`iconv(): Inappropriate ioctl for device`, rc=1; nas outras posições medidas, rc=0). A 1ª rodada viu
   `UTF8-INVALIDO` a mais na sabotagem "sem recorte", sobre um log de 63.361 bytes que o python dá como
   válido — e, como o caminho do tmp desloca os offsets, o sensor poderia piscar em outra máquina. O
   validador passou a ser ida e volta no bun; o candidato `TextDecoder({fatal:true})` do `bun -e` saiu
   rc=0 num `\377` real e foi reprovado pelo controle negativo antes de entrar.
3. **O `grep` do zsh interativo era o `ugrep` 7.8.4** (alias). As medições de "binário" feitas no
   terminal valiam para a ferramenta errada, e o comentário do código chegou a afirmar que um `\377`
   derrubava o classificador. Com o `/usr/bin/grep` que o `bash` dos scripts usa (BSD 2.6.0), nos dois
   locales: **NUL** faz o `grep -v` responder "Binary file … matches" no lugar das linhas (em pt_BR até o
   `-q` erra) e derruba o `registrar()`; **`\377`** é lido como texto e não derruba. O decode UTF-8 ficou
   pela validade do texto depois do corte, com vermelho próprio.
4. **O próprio sensor mentia com NUL em locale UTF-8:** o BSD grep deixa de casar padrão multibyte mesmo
   com `-a`, e a sabotagem "sem a regra de controle" trouxe dois vermelhos falsos em pt_BR. Os greps do
   sensor passaram a `LC_ALL=C`.

## A 2ª opinião (Codex, `gpt-6-astra`, `max`, 642 s)

Duas regressões condicionais e cinco buracos de prova na 1ª versão, nenhum P0/P1, todos procedentes:

| # | achado | resolução | vermelho que prova |
|---|---|---|---|
| 1 | noclobber: a escrita da suíte falha antes do runner e o abort mostra o log do compilador | `>\|` na `run_tests` | `NOCLOBBER` |
| 2 | um `EXPECT` igual a `│` forjava o prefixo indentado (`invalidas` 1→0, reproduzido) | prefixo na coluna 0 | `EXPECT-COM-CARA-DE-RECORTE` |
| 3 | "MESMA execução" do compilador não provada | o fixture do compilador se conta | `COMPILACOES=` |
| 4 | o isolamento do `sumario` passava por ausência | o fixture emite `sumário: FALSO` | `SUMARIO-CONTAMINADO` |
| 5 | `abortou=true` em todo estado passava | o DIVERGE exige `abortou=false` | `ABORTOU-SEM-ABORT` |
| 6 | 4096 não era exigido (512 e 8192 passavam) | cenário de corte exato | `CORTE-EXATO` |
| 7 | decodificar ANTES do corte passava | um `€` partido pelo corte | `CORTE-EXATO` |

Cabeçalho do parecer, copiado: `=== PARECER CODEX (modelo gpt-6-astra · reasoning max · tentativa 1 · 642s · 107.670 tokens) ===`.

**A re-revisão da v2 não rodou: `COTA_ESGOTADA`** — a janela reabre em 2026-09-19 13:21, e o plano
declarado no token (`prolite`) é o assinado, então o limite é real. Caminho B (`docs/agent/money-path.md`):
a auto-revisão adversária, com as mesmas perguntas feitas ao Codex, achou mais três buracos de prova. O
stderr da suíte e o do compilador não tinham vermelho — tirar o `2>&1` da captura ficava verde, e é em
stderr que o vitest põe erro de carga —, nem a limpeza do log no `finalizar`. Viraram `SEM-MOTIVO` e
`SEM-MOTIVO-DO-COMPILADOR` exigindo a linha exata DENTRO do recorte, e `RESTO-EM-PENDENTES`.
**REVISÃO INDEPENDENTE PENDENTE** para o que mudou depois da 1ª versão do PR #2497: rodar o Codex retroativo quando a
cota voltar — auto-revisão cobre o intervalo, não substitui.

## A falsificação final

Script transitório no scratchpad, contra a versão final dos três scripts do PR #2497: **66 rodadas do sensor em 262 s** (≈4 s cada,
compatível com a suíte rodando inteira), controle verde antes e depois, **0 divergências**, e os dois
locales (`LC_ALL=C` e `pt_BR.UTF-8`) com o MESMO conjunto de vermelhos em todo caso. A restauração foi
conferida por conteúdo contra o `HEAD` e por `git diff --quiet`.

Base forjada (perl que falha só no recorte): `SEM-MOTIVO`, `SEM-EXIT-3`, `CAUDA-SEM-CONTROLES`,
`LINHA-DE-COR-SUJA`, `CORTE-EXATO`, `SEM-MOTIVO-DO-COMPILADOR`, `SEM-EXIT-127`, `NOCLOBBER`.

| caso | camada sabotada | vermelhos exigidos — e medidos |
|---|---|---|
| C0 | nenhuma (controle) | nenhum, exit 0 |
| C1 | nenhuma, com o perl forjado | a base forjada |
| S1 | captura da suíte → `/dev/null` | `SEM-MOTIVO` `CAUDA-SEM-CONTROLES` `LINHA-DE-COR-SUJA` `CORTE-EXATO` `NOCLOBBER` |
| S2 | re-roda a suíte para obter o log | `RODADAS` `SEM-MOTIVO` `NOCLOBBER` |
| S3 | sem recorte | `CABECA-DA-SAIDA` `BYTES` `CORTE-EXATO` |
| S4 | recorte pelas últimas 40 LINHAS | `BYTES` `CORTE-EXATO` |
| S5 | sem a regra CSI | `LINHA-DE-COR-SUJA` |
| S6 | sem a regra de controle (NUL fica) | `abortou` não marcado |
| S7 | sem o decode UTF-8 | `UTF8-INVALIDO` `CORTE-EXATO` |
| S8 | recorte sem o prefixo | `CONTAMINOU` `SUMARIO-CONTAMINADO` `SEM-MOTIVO` `CORTE-EXATO` `SEM-MOTIVO-DO-COMPILADOR` |
| S9 | `registrar()` sem excluir o recorte | `CONTAMINOU` `SUMARIO-CONTAMINADO` |
| S10 | abort da suíte sai 2 | `EXIT-DO-ABORT` |
| S11 | abort da suíte segue para as mutações | `EXIT-DO-ABORT` `RODADAS` `NOCLOBBER` |
| S12 | captura do compilador → `/dev/null` | `SEM-MOTIVO-DO-COMPILADOR` `SEM-EXIT-127` |
| S13 | exit do compilador mostrado como 0 | `SEM-EXIT-127` |
| S14 | exit da suíte mostrado como 0 | `SEM-EXIT-3` |
| S15 | abort do compilador roda a suíte | `COMPILADOR-RODADAS` |
| S16 | abort do compilador sai 2 | `COMPILADOR-EXIT` |
| S17 | texto do abort da suíte | `abortou` não marcado |
| S18 | texto do abort do compilador | `COMPILADOR-ABORTOU` |
| S19 | [forjado] sem o `\|\| true` no abort da suíte | a base forjada + `EXIT-DO-ABORT` |
| S20 | [forjado] sem o `\|\| true` no abort do compilador | a base forjada + `COMPILADOR-EXIT` |
| S21 | predicado de abort casa só `baseline:` | `ABORTOU-SEM-ABORT` |
| S22 | `sumario` lido do log bruto | `SUMARIO-CONTAMINADO` |
| S23 | abort do compilador re-roda o compilador | `COMPILACOES` |
| S24 | orçamento de 512 bytes | `CORTE-EXATO` |
| S25 | orçamento de 8192 bytes | `CORTE-EXATO` |
| S26 | decode ANTES do corte | `CORTE-EXATO` |
| S27 | a suíte grava com `>` em vez de `>\|` | `NOCLOBBER` |
| S28 | captura da suíte sem o stderr | `SEM-MOTIVO` |
| S29 | captura do compilador sem o stderr | `SEM-MOTIVO-DO-COMPILADOR` |
| S30 | `finalizar` sem apagar o log | `RESTO-EM-PENDENTES` |
| C9 | nenhuma (controle de saída) | nenhum, exit 0 |

`ESCAPE-ANSI` é a única asserção nova sem vermelho exclusivo: o ESC que a regra CSI deixasse cai na
regra de controle, e o resto visível do escape já derruba `LINHA-DE-COR-SUJA`. Fica pelo que afirma —
nenhum ESC no log inteiro —, com a prova compartilhada declarada aqui.

Antes desta, a rodada da 1ª versão (46 execuções) terminou com 5 divergências — as três medições erradas
acima —, e a da v2 foi interrompida com 30 linhas, todas batendo, quando o Caminho B mudou o sensor.

## A regra

- **Abort que recusa medir mostra a evidência da MESMA execução que o fez recusar.** Re-rodar é outra
  medição, e o motivo pode não se repetir.
- **Texto de terceiro num stream classificado por texto exige marca que a saída própria não consegue
  forjar** — e o teste da marca é a entrada mais hostil: o próprio prefixo como conteúdo.
- **Meça com a ferramenta que o script usa.** O `grep` do shell interativo pode ser alias; o do `bash`
  dos scripts é outro binário, com outra regra de binário.
- **Validador só vira sensor depois de controle negativo E positivo** — aqui um reprovou UTF-8 válido
  (`iconv`) e outro aprovou byte inválido (`TextDecoder` do `bun -e`).
