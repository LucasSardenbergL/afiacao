# O caixa real de 90 dias da skill CFO somava as duas óticas — e a tendência publicada em abril herdou a dobra

**2026-09-10** · `.claude/skills/cfo-colacor/assets/sql/01-caixa-13-semanas.sql` (bloco c) · money-path ·
consumidor 3 do [fin-movimentacoes-duas-oticas-do-mesmo-pagamento.md](fin-movimentacoes-duas-oticas-do-mesmo-pagamento.md)

## O defeito

O bloco (c) da skill CFO triangula o caixa com o movimento real de 90 dias. Ele somava `fin_movimentacoes`
**sem escolher a ótica**: o mesmo pagamento como lançamento do título (`CONTA_A_*`) **e** como lançamento
no banco (`CONTA_CORRENTE_*`), mais as previsões (`PREVISAO_*`) e as transferências/tarifas sem título.

## Antes e depois na PROD (90 dias até 2026-09-10, leitura operacional)

| empresa | entradas antes | entradas depois | saídas antes | saídas depois |
|---|--:|--:|--:|--:|
| colacor | 415.281,51 | 193.126,48 | 227.780,48 | 114.665,02 |
| colacor_sc | 58.042,66 | 20.321,82 | 158.489,39 | 74.525,92 |
| oben | 2.093.888,48 | 928.842,23 | 710.239,06 | 343.353,02 |
| **total** | **2.567.212,65** | **1.142.290,53** | **1.096.508,93** | **532.543,96** |

+124,7% nas entradas e +105,9% nas saídas — o mesmo par de números do fluxo de caixa do produto antes do
#2443 (+124,3%/+106,3%), porque é o mesmo defeito. O "depois" bate centavo a centavo com uma decomposição
independente (ótica × com/sem título × tipo) feita antes da correção. O que o bloco somava a mais, nos 90
dias: R$ 1,17 M de ótica do título (3.055 das 4.628 linhas de entrada eram títulos **abertos**, valor 0),
R$ 235 mil de previsão, R$ 23 mil de transferência/tarifa.

## Duas perguntas, duas leituras

"Dinheiro que passou pelo banco" é a ótica **bancária** — mas o bloco serve a duas perguntas, e o filtro
de título separa uma da outra (achado da revisão Codex):

- **Operacional** — recebimentos e pagamentos de títulos, o que se compara com o CR aberto. Critério igual
  ao do caixa realizado do produto (`getFluxoCaixa` + `agregarRealizadoPorDia`): allowlist positiva,
  só com título, valor absoluto. A skill é cross-check do produto; critérios diferentes para a mesma
  pergunta fariam o cross-check divergir por construção.
- **Liquidez por CNPJ** — coluna nova `fluxo_liquido_banco_total_90d`, o banco inteiro. Transferência
  intercompany e tarifa são caixa real **daquele** CNPJ (o caixa do grupo não é fungível); tirá-las
  responde a pergunta operacional e erra a de liquidez. As colunas `sem_titulo_*` mostram a diferença.

A revisão também derrubou uma inferência **anterior** a este defeito: "entradas ≫ CR aberto ⇒ a empresa
fatura à vista". Um prazo curto produz a mesma razão sem venda à vista nenhuma (90 dias de recebimento
contra poucos dias de carteira). O bloco e o `SKILL.md` agora mandam investigar prazo e recorrência.

## O artefato derivado — o fechamento de abril

`docs/cfo/2026-04-fechamento.md` (gerado pela skill em 2026-06-16) publicou a movimentação líquida de 90
dias e, no resumo, "grupo sustentado pela Oben (~+R$ 104 mil/mês)". Pela aritmética, a tendência é o
líquido ÷ 3 (311.873,09 ÷ 3 ≈ 104 mil, e os três casam depois de arredondar) — inferência, não registro.
A reestimativa separa dois efeitos, porque os dados mudaram desde junho:

| Oben, 90 dias | valor |
|---|--:|
| publicado (critério antigo, dados de junho) | +311.873,09 |
| critério antigo, dados de hoje | +212.710,80 |
| ótica bancária com título, dados de hoje | **+43.475,91** |

Só o segundo degrau é a correção — e ele sozinho corta 80%. Por CNPJ a direção se mantém; no total do
grupo o sinal inverte (+21,5 mil → −140,4 mil), mas o critério antigo com os dados de hoje já dá −145,8
mil, então essa inversão é dos dados, não do filtro. Errata no próprio relatório, sem reescrever o
original.

## A prova

`db/test-cfo-caixa-90d-otica.sh` — PG17 descartável, **30 asserts**, e o SQL executado é o do **arquivo da
skill**, extraído entre os cabeçalhos `-- (c) ` e `-- (d) ` (cada um exatamente uma vez e em ordem —
extração que não casa é falha, não pulo). Contra o arquivo de antes: vermelho. Entrou no núcleo de provas
SQL do CI (`db/nucleo-ci.txt`, eixo 6 — dupla contagem).

| sabotagem (sobre uma cópia do bloco real) | assert vai de → a |
|---|---|
| F1 sem a allowlist de ótica | entradas 3090 → **7250** |
| F2 allowlist por negação (`NOT LIKE 'CONTA_A_%'`) | 3090 → **4150** (previsão e ótica desconhecida entram) |
| F2b allowlist por prefixo (`LIKE 'CONTA_CORRENTE%'`) | 3090 → **3150** |
| F2c `(allowlist OR categoria IS NULL)` — o literal original sobrevive | 3090 → **3140** |
| F3 sem o filtro de título | 3090 → **3340** |
| F4 "dedup" por título | 3090 → **2690** (some uma baixa parcial) |
| F6 sem o `abs` | saídas 830 → **770** |
| F7 janela de 89 dias | 3090 → **3000** (a fronteira cai fora) |
| F8 a coluna de saída sem título soma entrada | 70 → **250** |
| F9 liquidez calculada só com título | 2440 → **2260** |
| F5 o SQL de antes, congelado | 3090 → **7500** |

Controle verde antes e depois das sabotagens, na mesma invocação. Os seeds foram endurecidos depois da
revisão Codex, que achou quatro regressões invisíveis aos seeds da 1ª versão: janela 90 → 45 dias (nenhum
movimento perto da fronteira), a coluna de saída sem título somando entrada (entrada e saída valiam 250),
remoção do `abs` (nenhum negativo) e `OR categoria IS NULL` (nenhuma categoria nula) — esta última com o
literal original **dentro** da expressão, então nem o "não casou = falha" a pegaria.

## Lições

1. **SQL de skill é código money-path sem rede nenhuma.** Não é migration (nenhum `CREATE` o valida), não é
   TS (nenhum typecheck o lê), e roda na mão — o defeito só aparece quando alguém publica o número. A única
   rede possível é uma prova que **executa o texto do arquivo**, não uma cópia dele.
2. **Corrigir a fonte não corrige o número que já saiu dela.** O relatório de abril continuaria afirmando
   "+R$ 104 mil/mês" depois do fix. Ao corrigir um gerador de número, procure os **artefatos publicados**
   que ele produziu e anote a errata — e, ao reestimar, separe o efeito do critério do efeito dos dados
   que mudaram desde então: atribuir a diferença inteira à correção é outra forma de número fabricado.
3. **Excluir para responder uma pergunta pode errar a vizinha.** O filtro de título é certo para comparar
   com o CR e errado para a liquidez de um CNPJ. Quando a mesma consulta serve às duas, dê a cada uma a
   sua coluna — em vez de escolher uma e deixar a outra ler o número errado.
4. **A guarda "a sabotagem não carregou = falha" se pagou na primeira execução.** Ao endurecer a prova, pus
   aspas no 3º termo de `${BLOCO//"$2"/"$3"}` — o bash 3.2 do macOS as preserva literalmente, e `true` virou
   `"true"`, um identificador. Nove sabotagens deixaram de carregar; sem a guarda, os asserts delas seriam
   pulados em silêncio e a prova sairia verde com menos asserts (quem pegaria é só o mínimo do núcleo). E a
   única que "passou" passou por acaso: `abs(valor)` → `"valor"` é SQL válido.
