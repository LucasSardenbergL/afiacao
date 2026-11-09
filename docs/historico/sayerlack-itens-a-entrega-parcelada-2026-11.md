# Sayerlack — itens A da Oben: lote/frequência atual e proposta de entrega parcelada (para o founder negociar)

2026-11-01 · leitura read-only em prod (psql-ro): `sku_parametros` (classe A, fornecedor Sayerlack, no motor automático) ×
`sku_leadtime_history` (recebimentos 12m) × `inventory_position` (saldo hoje). **Sem código.** Decisão registrada que
esta lista RESPEITA: negociar ENTREGA (lote menor, mais frequente), **nunca prazo de pagamento** — manter preço e os 2%
do prazo de 4 dias. Frente C da leva PME/PMR (`2026-10-31-oben-pme-pmr-plano-design.md` §4).

## O que os dados dizem antes de negociar

- 60 SKUs classe A da Sayerlack no motor; R$ 2,2 mi recebidos em 12 meses. Os **12 maiores** somam ~R$ 1,4 mi.
- A compra já é **frequente e em lote pequeno** na maioria: 40 dos 60 recebem a cada ≤12 dias, lote médio 2–7
  unidades. Aí não há o que parcelar — o ganho de PME nesses está no `segurar compra` e no teto, não na entrega.
- O capital preso em A está em **poucos itens de lote grande** (lote ≥ ~2 semanas de demanda) — é neles que a
  entrega parcelada reduz estoque médio sem tocar o nível de serviço. Regra de bolso: estoque médio ≈ lote/2 +
  segurança; cortar o lote pela metade tira ~25% do estoque médio do item.

## Lista para a conversa (lote atual → proposta)

| SKU | Descrição | R$ 12m | Lote médio / freq. atual | Demanda/mês | Saldo (cob.) | Proposta de entrega |
|---|---|---|---|---|---|---|
| 11979532838 | SELADORA NLO.9525.00LT | 135k | 18 un / 17 d | 20 | 6 (9 d) ⚠️ | Programar 20/mês em **2 entregas de 10** (quinzenal). Hoje o lote é quase 1 mês e o saldo está curto: parcelar também protege serviço |
| 12101724100 | DILUENTE PU DFA.4080LT | 88k | 31 un / 18 d | 40 | 29 (22 d) | 40/mês em **4 entregas semanais de 10** (ou 2 de 20) |
| 8689717792 | THINNER DR.4403LT | 150k | 16,5 un / 7 d | 26 | 17 (19 d) | Já semanal; propor **2×/semana de 8** só se a Sayerlack entregar com a mesma rota (não vale frete extra) |
| 8689733572 | SELADORA NL.9245.00LT | 44k | 10 un / 19 d | 7,7 | 10 (39 d) | 8/mês em **2 entregas de 4** |
| 8689723179 | BASE BRIL 20 FOSCO MET. BRANC WJ | 134k | 9,3 un / 6 d | 11 | 22 (60 d) | Já frequente; **lote 5** por entrega (saldo de 60 d mostra que o lote excede o giro) |
| 8689791322 | BASE BRIL 20 FOSCO MET. INTER WJ (gl) | 19k | 7,4 un / 10 d | 19 | 17 (26 d) | 20/mês em **4 de 5** |
| 12014781132 | F ACAB BASE AGUA YLO.5614.00GL | 10k | 12 un / 122 d | 3,7 | 6 (49 d) | Lote de 4 meses: pedir **3/mês** (1 entrega) — ou cadastrar lote mínimo 4 e desligar o "encher até o máximo" |
| 12074056920 | BASE BRIL 05 SUPER FOSCO MULT BRANC WJ | 11k | 6,7 un / 61 d | 5,3 | 15 (84 d) | **3/mês** em 1 entrega |
| 11928885445 | BASE BRIL 10 FOSCO INTER WFOI.6554QT | 4k | 5,1 un / 23 d | 10 | 27 (81 d) | lote 3, semanal — e conferir por que o saldo está em 81 d (candidato a segurar compra) |
| 12074056924 | BASE BRIL 05 SUPER FOSCO MULT INTER WJ | 5k | 3,6 un / 73 d | 2,7 | 19 (214 d) | **Não comprar** até girar (está na coorte do segurar compra); depois lote 2 |

Os demais 50 itens A já recebem em lote de 1,5–6 unidades a cada 4–19 dias: **não parcelar** (frete/ocorrência por
entrega sobe sem ganho de estoque). Catalisadores FC.6975LT (R$ 247k, lote 5,8 / 4 d) e DFA.4128LT (R$ 181k, lote
6,7 / 4 d) são o exemplo: já são "quase diários".

## Como pedir (mantendo preço e 2%)

1. **Pedido programado mensal com entregas parceladas** para os 6 primeiros da tabela: um pedido (volume do mês,
   mesmo preço, mesma condição de 4 dias com 2%) com datas de entrega semanais/quinzenais. O faturamento e o prazo
   contam **por entrega** (cada NF vence em 4 dias) — o que estamos pedindo é só o calendário de saída.
2. Argumento: volume igual ou maior no ano, previsibilidade para a Sayerlack programar produção/rota; para nós,
   menos estoque médio (lote/2) nos itens de maior R$.
3. **Não** aceitar troca por prazo de pagamento maior (decisão fechada: PMP fica), nem por preço — se a Sayerlack
   condicionar o parcelamento a lote mínimo maior, o item sai da lista.
4. Antes de reduzir estoque de segurança (ss) por causa da entrega mais frequente: medir o **lead-time P95** real
   dos recebimentos parcelados por 60 dias (`sku_leadtime_history`), como diz a Frente C — entrega parcelada reduz o
   LOTE agora; o ss só depois do P95.

## Depois do acordo (o que o sistema precisa saber)

- Lote programado por SKU não existe como parâmetro no motor hoje (`estoque_maximo` é o teto do min-max). Para o motor
  não "encher até o máximo" no 1º ciclo após a entrega parcelada, baixar `estoque_maximo` dos itens acordados para
  ~pp + lote da entrega (edição na Revisão de parâmetros) — ou o acordo vira só papel.
- Sensor: `sku_leadtime_history.quantidade_recebida`/`t4_data_recebimento` por SKU (lote médio e frequência) antes ×
  depois, nas mesmas colunas desta leitura (`/tmp` da sessão: `sayer.sql`, re-rodável no psql-ro).
