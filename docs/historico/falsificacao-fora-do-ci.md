# A falsificação que nunca rodou no CI — e o custo que era fixture, não falsificação

**2026-08-23.** Várias suítes de hook têm modo `--falsificar`: sabotam o alvo com `sed`, uma regra
por vez, e **exigem que a suíte fique vermelha** em cada sabotagem. É o que impede a suíte verde de
ser verde por asserção frouxa. Esse modo **nunca rodou no CI** — `grep -o 'falsificar' package.json
.github/workflows/*.yml` não devolvia nada. Rodava só quando alguém digitava à mão.

Que é exatamente o que a baseline `scripts/hooks-suites-baseline.ts` já proíbe em outra forma:
*"teste que existe e não roda é AUSÊNCIA DE DADO, não aprovação"*. Uma edição futura podia afrouxar
as asserções — ou o alvo mudar e um padrão de `sed` deixar de casar, virando **falsificação vazia** —
sem nada ficar vermelho.

## O escopo real era 2, não 5

A lista de partida citava 5 suítes. Medindo, só **duas** têm o modo atrás da flag:
`test-orfaos-custosos.sh` e `test-read-contexto-nudge.sh`. As outras três
(`test-bash-contexto-nudge.sh`, `test-edge-guardrail-guard.sh`, `test-claude-md-budget.sh`)
falsificam **inline**, como parte do fluxo normal — ou seja, **já rodavam no CI** dentro do
`test:hooks`. `grep -l falsificar` não distingue as duas coisas: casa quem tem o modo, quem
falsifica inline e quem só menciona a palavra num comentário. O detector honesto é a **guarda de
flag** (`[ "${1:-}" = "--falsificar" ]`), não a palavra.

Corolário para a próxima varredura: procurar a palavra mede vocabulário, não comportamento.

## O custo era fixture, não falsificação

Medido na M2, em série. ⚠️ **A medição de parede desta máquina não é reprodutível**: o *mesmo*
`read --falsificar` deu **484s, 302s e 143s** em três momentos, e o `orfaos` deu **59s, 72s e 27s** —
variação de ~3× conduzida pela carga (swap alto, ~30 worktrees, outras sessões no semáforo `heavy`),
não pelo código. Quem comparar "antes" e "depois" por duas execuções em momentos diferentes vai ler
ruído como ganho. O número honesto do custo no CI é **o do próprio CI**, no primeiro run do job.

O que é sólido porque foi medido **isolado e controlado** é a origem do custo: o laço de fixture,
cronometrado sozinho, custava **17,7s** contra **80ms** do idioma equivalente — razão de ~200×, com
saída byte-a-byte idêntica (`cmp -s`). Esse é o achado; a diferença no total de parede é consistente
com ele, mas não o prova sozinha.

O que segurava o `read` **não era a falsificação** — era um laço de fixture com `>>` por iteração,
que abria e fechava o arquivo 12.000 vezes: **17,7s medidos isolados**, mais que a suíte inteira. E
a falsificação re-executa a suíte por sabotagem × locale, então esse custo entrava 12 vezes. O
idioma rápido já existia **duas linhas acima no mesmo arquivo** (`printf 'FMT%.0s' $(seq …)`):
**17,7s → 80ms**, saída byte-a-byte idêntica (`cmp -s`).

Lição: antes de declarar um gate "caro demais para o CI", **meça de onde vem o custo**. Aqui o
veredito "não cabe" teria sido tirado de um laço de fixture mal escrito, não da checagem que o gate
faz — e a otimização devolve tempo também ao `test:hooks`, que já roda em todo PR.

⚠️ **Medição local não projeta o runner.** O `test:hooks` inteiro levou **1453s (24min)** nesta M2,
com swap alto e ~30 worktrees vivas, contra ~1–2min no CI. A ordem de grandeza local serve para
comparar A com B na mesma máquina; para dimensionar o CI, o único número honesto é o do próprio CI.

## Três coisas que precisavam vir ANTES de ligar

**1. A 4ª trava não transfere.** O `orfaos` tem 4 travas contra falsificação vazia (sed inválido ·
padrão que não casou · sintaxe de shell quebrada · programa AWK quebrado); o `read` tinha 3. A
quarta existe porque `bash -n` não entra em programa embutido em string. Copiá-la literalmente **não
funciona**: no `orfaos` o awk escapa para o stderr sozinho, mas o alvo do `read` **silencia o jq**
(`| jq -r '…' 2>/dev/null`). Um jq quebrado ali não faz ruído — devolve campo vazio, o teste de
`tool` falha e o hook vira **no-op cego**, que cala toda asserção de fala e é indistinguível, *por
comportamento*, da sabotagem legítima "sempre silencia". A trava entrou **estrutural**: destampa o
stderr numa 2ª cópia (`sed 's%2>/dev/null%%g'`) e deixa o jq falar.

Falsificada nos dois sentidos: jq quebrado → dispara; sabotagem legítima → silêncio. O controle
negativo importou — o alvo usa `stat -c` (GNU) e o macOS cospe `illegal option` em toda execução, de
modo que uma alternância com `stat` reprovaria as 6 sabotagens legítimas na máquina do founder.

**2. O locale colapsava no ubuntu.** O laço era `for loc in C pt_BR.UTF-8`. No runner `pt_BR.UTF-8`
não existe: o bash avisa no stderr e cai para C — os "2 locales" viram **(C, C)**, metade da
cobertura fingindo ser inteira, que é a falsificação-em-UM-ambiente do #1483. Virou **sonda
positiva** (`locale charmap` = `UTF-8`), o padrão que `test-claude-md-budget.sh` já usava:
`pt_BR.UTF-8` na M2, `C.UTF-8` no CI — UTF-8 de verdade nos dois.

No `orfaos` o nome fica **literal de propósito**, e isso está comentado no script para ninguém
"corrigir": quem decide lá é o stub do `ps`, que casa a **string** (`case "${LC_ALL:-C}" in pt_BR*`)
e emite a vírgula decimal sem consultar o sistema — a asserção vale no ubuntu mesmo com o locale
ausente. Trocar por `C.UTF-8` faria o stub cair no ramo neutro, emitir ponto nos dois locales e
**esvaziar** a asserção. Mesma família de bug, correções opostas.

**3. Onde ligar — e a estimativa que a medição derrubou.** O `validate` leva **6–8min** com
`timeout-minutes: 15`, e a falsificação re-executa a suíte ~30 vezes. Extrapolando da M2, isso
comeria a margem do timeout, então o #1947 a pôs em **job separado**, paralelo, com a ressalva de
que o número honesto viria do CI.

Veio, e **refutou a justificativa**: o job levou **0,9min** (contra `validate` em 8,15min). A
estimativa estava inflada porque nasceu de uma máquina onde o mesmo comando varia ~3× e o
`test:hooks` leva 24min. Com o número real a escolha se inverte, e o #1948 moveu a falsificação
para **dentro do `validate`**.

Por que a inversão importa: `validate` é o **único check required**, e o auto-merge só espera os
required. Em job separado o merge acontecia **antes de o job terminar** — vermelho depois do merge,
que é a mesma classe do gate de dead-code medida no #1212 (*"medição de gate FORA do CI expira"*).
Como sinal, ele não barraria um PR que afrouxasse as asserções; como step, barra. Custo: ~11% no
wall-clock do job, com ~6min de folga ainda no timeout.

A lição de método é essa: **estimativa tirada de máquina ruidosa é hipótese, não medida**. O certo
foi entregar com a ressalva explícita, medir no ambiente real e **voltar para corrigir a decisão** —
não deixar a decisão de pé porque já estava escrita e comentada.

## Resíduo

`scripts/falsificacao-cobertura.test.ts`, irmão de `hooks-guard-cobertura.test.ts`: cobra que toda
suíte com o modo esteja no laço `test:falsificacao` — e, a metade mais traiçoeira, que **o laço
passe `--falsificar` de verdade**. Sem a flag, o laço roda o modo normal, o job fica verde e o CI
*parece* cobrir a falsificação enquanto só repete o `test:hooks`. Cobre ainda alvo fantasma (`bash`
de caminho inexistente sai 127) e alvo sem a guarda (ignora a flag e roda o modo normal), mais um
teste que falha se o próprio detector parar de casar — gate que não casa nada é verde por cegueira.
