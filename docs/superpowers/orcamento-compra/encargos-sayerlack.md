# Encargos por condição de pagamento — portal Sayerlack

**Fonte:** portal B2B (`http://portal.sayerlack.com.br:9092/order-creation`), campo **Taxa de Financiamento** ao lado
de **Condição de Pagamento**, lido em **2026-10-21** com o login da Oben (cliente 46269, estabelecimento CAJ, tipo
89, canal 30 – Distribuição). Nada foi gravado nem enviado no portal: a condição foi trocada no formulário em branco
e voltou para "70 - 7 DIAS" no fim.

**Como foi lido:** as 163 condições, uma a uma, disparando o mesmo evento do select2 que o clique dispara (validado
contra o clique real: 28 DD = 1,3100). As condições abaixo foram **relidas** com espera até o campo estabilizar, e as
duas leituras **bateram em todas**. Condições exóticas do fim da lista (1002, 9972, 9979…) ficaram instáveis
("Carregando…") e estão fora desta tabela.

## Prazo único (taxa % sobre o preço; negativo = desconto)

| Condição | Taxa |
|---|---|
| 2 – ANTECIPADO | **−2,00%** |
| 1 – À vista · 30 – 3 dias boleto · 50 – 5 dias · **70 – 7 dias** · 100 – 10 DD | **0,00%** |
| 140 – 14 DD | 0,53% |
| 210 – 21 DD | 0,85% |
| **280 – 28 DD** | **1,31%** |
| 350 – 35 DD | 1,75% |
| **420 – 42 DD** | **2,39%** |
| 450 – 45 DD | 2,56% |
| 490 – 49 DD | 2,79% |
| **560 – 56 DD** | **3,20%** |
| 630 – 63 DD | 4,03% |
| 700 – 70 DD | 4,49% |
| 750 – 75 DD | 4,82% |
| 800 – 80 DD | 5,15% |
| 900 – 90 DD | 5,81% |
| 1000 – 100 dias · 106 – 105 DD | 6,81% |
| 120 – 120 DD | 7,82% |

## Parcelado: a taxa segue o PRAZO MÉDIO das parcelas

Exemplos lidos: 14/28/42 DD = 1,31% (média 28) · 21/35 DD = 1,31% · 28/42 DD = 1,75% (média 35) · 14/28/42/56 = 1,75% ·
28/42/56 DD = 2,39% (média 42) · 28/56 DD = 2,39% · 42/56 DD = 2,79% (média 49) · 30/60 DD = 2,56% (média 45) ·
60/90 DD = 4,82% (média 75) · 30/60/90/120 DD = 4,82% · 60/120 = 5,81% (média 90).

Logo **parcelar não muda o custo** em relação ao prazo único de mesma média.

## Leitura para o orçamento de compra

- A taxa cresce ~0,45–0,6 ponto a cada 7 dias (~1,4–1,7% ao mês).
- ⚠️ **O desconto de 2% que aparece no portal é do ANTECIPADO (−2,00%), não do "7 dias" (0,00%).** A premissa da
  spec ("boleto 7 dias com 2% de desconto") precisa ser confirmada pelo founder: o desconto pode vir por outro canal
  (negociação, desconto por item) que este campo não mostra.
- Não sabemos se a taxa incide sobre o preço de tabela ou sobre o líquido, nem se varia por cliente/tipo de pedido:
  a leitura é da Oben, tipo 89.
