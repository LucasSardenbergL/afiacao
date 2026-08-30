# O congelamento por DIRETÓRIO engolia a âncora — promessa vale onde está escrita

**PR:** (esta entrega) · **Origem:** levantado ao verificar o deploy do `#2086` (`a8c3e0c47`)
· **Gate:** `scripts/docs-citacoes-gate-check.ts` (`bun run docs:citacoes`)

## O sintoma

Ao escrever `docs/historico/escrita-de-aplicacao-como-sensor-de-deploy.md`, a falsificação de rotina
plantou `<!--cita: SABOTAGEM_QUE_NAO_EXISTE_NA_LINHA-->` numa âncora e exigiu vermelho. Veio
**exit 0**, e o contador não se mexeu: `21 citação(ões) verificada(s) ✓ · 605 fora do escopo`. As
quatro âncoras daquele doc tiveram de ser conferidas à mão.

Não era bug silencioso — o corte é anunciado, e a interface `ForaDoEscopo` diz "congelado por
diretório ou nominal". Era **dívida declarada**. Mas dívida declarada ainda é ponto cego: o gate
não sabia dizer "não" onde o doc morava.

## O que a medição mudou na resposta

O caminho óbvio era ligar `docs/historico/` no `ALVOS_VIVOS`. Medido antes de decidir, nas 133
citações do diretório:

| classe | nº | é apodrecimento? |
|---|---|---|
| âncora que NÃO bate | **0** | — a podridão semântica era nula |
| sem âncora nenhuma | 109 | não: inverificável ≠ errado |
| "não existe no repo" | 14 | **13 são caminho abreviado** (`sync-reprocess/index.ts` pela edge inteira); 1 sumiu de fato |
| basename nu / multi-linha | 8 | forma, não conteúdo |

Ligar a pasta custaria **131 vermelhos** e obrigaria a escrever âncora em documento datado — o
churn sobre história que o congelamento existe para evitar — para pegar **um** alvo de fato sumido.
A baseline por contagem, a outra saída, é o registro-longe-do-fato que o cabeçalho do próprio gate
recusa.

**A pergunta certa não era "que diretório varrer", era "o que o autor prometeu".** `<!--cita: ...-->`
não se digita por acidente: é afirmação escrita à mão sobre o que está na linha HOJE. O corte por
diretório protege o doc datado de ser *obrigado* a acompanhar a `main`; ele nunca teve razão para
proteger quem se ofereceu. Regra nova: **toda citação ANCORADA é verificada, varrida a pasta ou
não** — `scripts/docs-citacoes-gate-check.ts:236`<!--cita: export function apenasAncoradas-->,
aplicada em `scripts/docs-citacoes-gate-check.ts:459`<!--cita: const ancoradas = apenasAncoradas-->.
Citação sem âncora em doc não varrido continua fora, e continua contada.

Custo medido de ligar: **4 citações, todas já verdes. Zero conserto.** `docs/superpowers/` (453
citações, 0 ancoradas) e `docs/ux-audit/` (7, 0 ancoradas) seguem congelados pela mesma conta — e a
regra os cobre no dia em que alguém escrever uma âncora lá, sem tocar no gate de novo.

## O segundo bug, que só apareceu ao medir

Duas citações de `docs/historico/fase-sem-sinal.md` tinham âncora **correta** e liam como `null`: a
âncora havia **quebrado de linha**. A varredura é linha a linha, então o `\s*` que o regex põe entre
citação e âncora nunca via um `\n`. Em doc vivo isso vira o achado barulhento "não tem âncora"; em
doc não varrido sumiria calado — e teria sumido calado **também sob a regra nova**, porque o filtro
é `ancora !== null`. Consertar era pré-condição, não escopo extra:
`scripts/docs-citacoes-gate-check.ts:199`<!--cita: const RE_ANCORA_SOLTA-->. A âncora só é adotada
pela ÚLTIMA citação da linha e só se nada mais sobrar depois dela, senão seria atribuída a quem não
é dona.

## A falsificação (com CONTROLE)

Vermelho sozinho não prova nada: prova que o vermelho veio do patch.

| rodada | gate | sabotagem no disco | exit |
|---|---|---|---|
| controle | `HEAD~1` | ambas | **0** — reproduz o bug relatado, `21 verificadas ✓` |
| F1 | novo | âncora colada, em `docs/historico/` | **1** |
| F2 | novo | âncora quebrada de linha | **1** |

`25 verificadas · 601 fora do escopo` — e 25 é o total de `<!--cita:` do repo: **não sobrou âncora
sem dono.**

## A regra

> Corte de escopo por LOCAL (diretório, pasta, camada) não deve engolir o opt-in EXPLÍCITO que um
> humano escreveu dentro dele. Congelar "o que eu não obrigo você a manter" é legítimo; congelar "o
> que você se ofereceu para manter" é ponto cego. Antes de ampliar o corte, meça a classe do que
> está fora — aqui, 0 de 133 estavam semanticamente podres, e a extensão óbvia teria custado 131
> vermelhos para pegar 1.
