# "Total Recebido R$ 0,00" sobre R$ 27,8M recebidos — a fabricação que a soma reveste de autoridade

**2026-09-09** · `src/pages/FinanceiroAnalytics.tsx` · `src/services/financeiroV2Service.ts` · money-path · irmão de [#2407](https://github.com/LucasSardenbergL/afiacao/pull/2407) e continuação de [`valor-pag não é valor pago`](valor-pag-nao-e-valor-pago-e-a-baixa-ja-chega-em-mf.md) (#2409) · issue #396

## O que a tela afirmava

`/financeiro/analytics` exibia uma coluna "Recebido"/"Pago", um card de resumo e um CSV alimentados
por `sum(valor_recebido)` / `sum(valor_pago)` das matviews `fin_analise_c{r,p}_dimensoes`.

Medido em prod (psql-ro, 2026-09-09):

| razão | títulos | com baixa ≠ 0 | documento dos liquidados |
|---|---|---|---|
| CR | 44.524 | **0** | R$ 27.855.279,84 (status `RECEBIDO`) |
| CP | 16.125 | **0** | R$ 28.926.255,51 (status `PAGO`) |

A tela portanto afirmava **R$ 0,00 recebido sobre R$ 27,8M de títulos cujo próprio status diz
RECEBIDO** — e R$ 0,00 pago sobre R$ 28,9M. O `saldo` carregava o mesmo defeito por herança: é
coluna **GERADA** (`valor_documento - COALESCE(valor_pago, 0)`), e com o subtraendo sempre 0 ele
devolve o valor cheio até para título liquidado.

## Por que é pior que um dado faltando

Não era ausência de dado na tela: era um **número fabricado com aparência de fato**. Um total tem
exatamente a mesma aparência quando é medido e quando é somado a partir de zeros nunca ingeridos —
nada na tela convidava a desconfiar, e o CSV levava o "0.00" para dentro de planilha e decisão.

É a família do `|| 0` do #2407, **um andar acima**: lá a fabricação era pontual, no parse de um
campo; aqui ela nasce no ingest (o LIST do Omie não devolve a baixa) e a agregação a reveste da
autoridade de um agregado. `ausente ≠ zero` vale para a soma tanto quanto para a parcela.

## O guard que existia não alcançava

`titulo-status.ts` (#396) protege quem soma `saldo` **filtrando por status** — é o que salva
`fin_aging_*` e `v_grupo_contas_receber`. Esta tela não filtra: ela **exibe a coluna crua**, e
nenhum filtro de status conserta um valor que nunca foi ingerido. Guard por status e guard por
procedência são irmãos, não substitutos.

## A regra que este PR deixa

**O gatilho da degradação é a PROCEDÊNCIA da coluna, nunca `valor === 0`.**

`src/lib/financeiro/procedencia-baixa.ts` declara de onde a coluna veio (`BAIXA_OMIE_LIST`:
`ingereBaixa: false`) e `baixaOuIndisponivel(soma, procedencia)` devolve `null` por causa da fonte,
sem consultar o valor. O service degrada na saída (`total_pago_recebido`/`total_saldo` viram
`number | null` + `motivo_baixa`), e o `tsc` obrigou os quatro caminhos a tratarem o `null`:
coluna, saldo, card de resumo e CSV.

Por que não `soma === 0`, que acertaria 100% do acervo de hoje: **ele mente no sentido oposto no
dia seguinte ao conserto do ingest.** Um mês em que nada foi recebido é um FATO, e escondê-lo atrás
de "—" é a mesma classe de erro, com o sinal trocado. A pergunta "de onde a coluna veio?" continua
correta nos dois mundos; "quanto ela vale?" só acerta neste. O teste que fixa isso é o **controle**
(`procedencia-baixa.test.ts`, `FinanceiroAnalytics.baixa-indisponivel.test.tsx`): fonte confiável +
soma 0 ⇒ `R$ 0,00`, e um `toBeNull()` ali é vermelho.

## O que NÃO se fez, e por quê

Trocar a fonte por `fin_movimentacoes` foi rejeitado (2ª opinião do Codex, 2026-09-08, e concordo):
cobertura de 11% na colacor, soma por título **duplicada** (o mesmo pagamento sob duas óticas de
`cGrupo`) e — decisivo — a análise agrupa por **vencimento** enquanto os movimentos são por
**pagamento**. Trocar não corrigiria a métrica: mudaria o significado dela em silêncio, que é a
fabricação de novo, agora com dado real.

Também não se removeu a coluna: quem abre a tela precisa saber que aquele eixo existe e está
indisponível. "—" + motivo diz isso; a coluna ausente não diz nada.

## Onde o conserto de verdade entra

Quando a baixa for ingerida — a rota `mf`/movimentações **já traz o dado e hoje o descarta**
(#2409) — o conserto é declarar a nova procedência. Nenhum consumidor muda: `null` volta a ser
número pelo mesmo caminho, e o aviso some sozinho.
