# O mesmo pagamento chegava duas vezes — e o hash do payload garantia que as duas ficassem

**2026-09-09** · `supabase/migrations/20260909074613_v_titulo_baixas_otica_canonica.sql` · money-path · fecha o achado (5) de [#2409](valor-pag-nao-e-valor-pago-e-a-baixa-ja-chega-em-mf.md)

## O defeito

`financas/mf/ListarMovimentos` devolve o **mesmo pagamento sob duas óticas**, distinguidas por `cGrupo`:
`CONTA_A_RECEBER`/`CONTA_A_PAGAR` (o lançamento do título) e `CONTA_CORRENTE_REC`/`CONTA_CORRENTE_PAG`
(o lançamento na conta corrente). O `omie_ncodmov` é um hash FNV do payload — as duas óticas geram
hashes diferentes, ambas persistem, e `v_titulo_baixas.valor_baixado = sum(valor)` **dobrava**.

Medido na PROD: soma da view **R$ 43,82 M** contra **R$ 23,74 M** de soma dos `valor_documento` dos
mesmos títulos (+84,6%). Só **14,7%** dos títulos tinham `valor_baixado == valor_documento`.

## Qual ótica é a baixa — a prova de calendário

Nos 13.693 títulos CR com as duas óticas, `lag = data_CONTA_CORRENTE − data_CONTA_A`:

| lag | títulos | % numa **sexta-feira** |
|---|---|---|
| 0 | 6.690 | 17,8% |
| 1 | 5.795 | **0,0%** (sexta+1 = sábado) |
| 2 | 100 | 0,0% |
| 3 | 1.004 | **98,5%** (sexta+3 = segunda) |
| 4 | 48 | 37,5% (feriado na segunda) |

Crédito em fim de semana: 6 em 13.637 (0,04%). `data_CC` é o **próximo dia útil** após `data_TÍTULO`
⇒ a ótica do título é a **baixa**; a de conta corrente é a **liquidação bancária**. No CP o lag é ~0
(3.827/3.851 datas iguais) — pagar é instantâneo.

Confirmam: (a) o payload cru (~200 linhas antigas ainda têm `metadata`, o zeramento do #2409 não fez
backfill) — a ótica CC tem `nCodBaixa`/`nCodMovCC`/`dDtCredito`/`dDtConcilia` e **não** tem
`dDtRegistro`/`nValorTitulo`/`cNumTitulo`; (b) o status — `CONTA_A_RECEBER` lista também
A VENCER/ATRASADO/CANCELADO (lista o título **aberto**), `CONTA_CORRENTE_REC` só existe se houve baixa.

## As três lições

### 1. Hash de payload não é identidade de evento — e tirar UM campo dele é inerte

A correção óbvia ("tira `cGrupo` do hash") **não deduplica nada**: nos 14.410 pares, só 34,5%
colidiriam mesmo sem ele — e isso é **limite superior**, porque só 3 dos ~20 campos do hash estão
persistidos para medir; o payload cru mostra que `dDtRegistro`, `nValorTitulo`, `cNumTitulo` e
`cOrigem` existem **em uma ótica só**. Reescreveria a identidade de 56.658 linhas para remover zero
duplicatas.

**Regra:** quando a API devolve o mesmo fato sob N óticas ou N estados, um hash do payload produz N
identidades para 1 fato — por construção. A dedup pertence à **leitura**, com a chave semântica; e
antes de mexer no hash, MEÇA quantas linhas realmente colidiriam.

### 2. Resumo cumulativo não se soma (achado da revisão Codex, verificado)

`nValPago` é o **total pago do título**, não um evento. Uma mudança de estado gera outra identidade
sem remover a anterior — então somar as versões conta o mesmo dinheiro de novo:

| ótica | linhas somadas | títulos | batem com o documento | **excedem** |
|---|---|---|---|---|
| título | 1 | 18.255 | 18.231 | 0 |
| título | 2 | 85 | 1 | **84** |
| título | 3 | 12 | 0 | **12** |

96 títulos, **R$ 85.828,86** de excesso. Na ótica do título fica só o resumo mais completo
(`DISTINCT ON`, maior valor); na de conta corrente a soma continua, porque lá cada linha tem
`nCodBaixa` próprio — é evento de verdade. **A regra de agregação é assimétrica entre as óticas.**

O sintoma que denuncia: **múltiplas linhas do mesmo agregado excedendo o valor do documento.**

### 3. Filtro cego por categoria destrói cobertura assimétrica

`WHERE cGrupo LIKE 'CONTA_A_%'` perderia **3.225 títulos, todos do colacor** — cuja ótica de título só
existe a partir de 2026-02-25 enquanto a de conta corrente vai até 2020-04-17. É perda de **janela**,
não semântica (≠ do teto estrutural de ~11% do colacor, que é outro problema). A escolha é **por
título**: usa a ótica do título quando existe, senão cai para a de conta corrente e **declara** em
`origem_baixa`.

| | hoje | só `CONTA_A_%` | **preferência + fallback** |
|---|---|---|---|
| títulos cobertos | 21.577 | 18.352 | **21.577** |
| batem exato com `valor_documento` | 14,7% | — | **97,1%** |
| soma | R$ 43,82 M | — | **R$ 23,73 M** (doc: R$ 23,74 M) |

E a allowlist é **positiva**: existem SEIS `cGrupo`, não quatro — `PREVISAO_PEDIDO_VENDA` (461) e
`PREVISAO_ORDEM_SERVICO` (112) são tipo `E` com valor>0. Hoje zero deles casa com título da view, mas
um filtro por negação (`NOT LIKE 'CONTA_CORRENTE%'`) os deixaria entrar como baixa.

## A prova

`db/test-v-titulo-baixas-otica-canonica.sh` — PG17 descartável, **21 asserts**, aplica a view ANTIGA e
o `REPLACE` por cima (é assim que chega na PROD; `CREATE OR REPLACE VIEW` recusa renomear coluna), e
compara o **conjunto inteiro** com `EXCEPT ALL` nos dois sentidos (pega linha extra, faltante **e**
duplicada — um `count` igual não pegaria uma linha trocada por outra). Esperados escritos à mão a
partir dos seeds, nunca copiados da seleção da view.

Falsificação, com controle verde na mesma invocação antes de sabotar:

| sabotagem | assert previsto vai a |
|---|---|
| F1 sem escolha de ótica | `1000` → **`2000`** (a dobra original, com a data errada) |
| F2 sem `DISTINCT ON` | `1000` → **`1400`** (o cumulativo somado) |
| F3 sem allowlist positiva | `(vazio)` → **`700`** (previsão virando baixa) |
| F4 filtro cego `CONTA_A_%` | `500\|conta_corrente` → **`(vazio)`** |
| F6 partição sem company/tipo | `0/0` → **`5/3`** |
| F5 replace sem o `WITH` | `security_invoker on` → **`OFF`** |

A postcondição embutida na migration também é falsificada (A9): rodada sobre a view furada por F5,
ela **aborta** — a sentinela casa a ausência do `RAISE NOTICE`, não o texto do próprio `RAISE`.

## O que isto NÃO resolve (levantado pelo Codex, medido)

1. **`origem_baixa` só vira honestidade se o consumidor a ler.** Hoje nenhum lê: `resolverDataCaixa`
   marca a data do proxy como `usou_fallback:false`, e o cockpit conta qualquer data preenchida como
   `v_real`. Os 3.225 títulos do colacor seguem entrando como baixa observada.
2. **Uma ótica canônica não serve a perguntas diferentes.** PMR/aging querem a **quitação**; projeção
   de caixa e DRE-caixa querem a **disponibilidade bancária**. Trocar globalmente antecipa caixa e
   pode esconder necessidade de financiamento.
3. **O fluxo de caixa REALIZADO tem a mesma dobra e não passa por esta view** — lê `fin_movimentacoes`
   direto e soma as duas óticas: medido, **R$ 22,39 M** de entradas contra **R$ 11,43 M** da ótica de
   banco sozinha. → **Fechado no #2443** (`getFluxoCaixa` passou a ler só a ótica bancária).

Correção de fato registrada: eu havia escrito que descartar a ótica de conta corrente na ingestão
"destruiria o fluxo de caixa" por causa dos R$ 6,0 M de extrato sem título. Falso —
`agregarRealizadoPorDia` descarta movimento sem título **de propósito**. O argumento que sustenta a
decisão é o da inércia do hash (lição 1), não esse.

## Os três consumidores que sobraram (2026-09-10)

Varredura do repo inteiro (`src/`, edges, migrations, todas as skills, `db/`, `scripts/`, `docs/cfo/`) mais
`pg_proc`/`pg_views` da PROD: fora desta view e do `getFluxoCaixa`, só três leitores somavam
`fin_movimentacoes` sem escolher a ótica. Antes de corrigir, a primeira pergunta foi se cada um **roda** —
e dois não rodam:

| consumidor | roda? (medido na PROD) | desfecho |
|---|---|---|
| bloco (c) da skill CFO | **sim** — consulta manual, e publicou a tendência de caixa do fechamento de abril | **fechado**: ótica bancária + prova no núcleo do CI + errata no relatório — [cfo-caixa-90d-somava-as-duas-oticas.md](cfo-caixa-90d-somava-as-duas-oticas.md) |
| `fin_calcular_confiabilidade` | **não** — `fin_confiabilidade` com `n_tup_ins = 0`; sem cron, sem chamador SQL/TS/edge; EXECUTE só para `postgres`/`service_role` | **código morto, só registrado** (abaixo) |
| `gerarConciliacao` (`FinanceiroConciliacao.tsx`) | **não** — `fin_conciliacao` com `n_tup_ins = 0`; `fin_permissoes` vazia e sem UI que a grave, então a policy `fin_conc_write` barra toda escrita do app | defesa da ótica, em PR separado (decisão do Lucas) |

**`fin_calcular_confiabilidade`, se um dia for religada:** `total_mov` conta as duas óticas mais as
previsões (dobrado); `pct_mov_conciliado` é uma razão sobre `fin_movimentacoes.conciliado`, flag que o sync
regrava `false` em toda carga — daria 0% por construção, não por medição (a dobra quase se cancela na
razão, mas a flag já a torna inútil); `mov_sem_titulo` só conta linha da ótica bancária (a do título sempre
tem lançamento), então não dobra. Os leitores (`useFinanceiroZone`, `TransparencyBadge`, cockpit) já
degradam para "—" com a tabela vazia, e nada é fabricado hoje. Religar exige antes a ótica bancária no
`total_mov` e um sinal de conciliação que exista de verdade.
