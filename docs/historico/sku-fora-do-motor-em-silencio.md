# SKU fora do motor em silêncio — FCA.7090QT e WP01.3900QT (2026-09-29)

> **A classe:** um flag com vários escritores e nenhum registro de quem o desligou nem por quê vira
> **estado sem dono**. Se o único leitor desse flag é o motor, e o motor simplesmente não enxerga quem
> está desligado, nada denuncia o SKU sumido — ele não falha, não alerta, só deixa de existir para a
> compra. O remédio não é adivinhar a intenção: é um **sensor do estado sem dono**, com a ação que o
> resolve ao lado.

Irmão do vão de #2022 (linha órfã com `pp`/`max` NULL, 206 SKUs invisíveis). Aqui os parâmetros
estavam certos; o que faltava era o flag.

## Sintoma

O founder perguntou se FCA.7090QT e WP01.3900QT deveriam aparecer no cockpit de compras
(`/admin/reposicao/sessao`) quando há demanda. Deveriam: pelas regras do motor os dois são
elegíveis (Sayerlack, ativos no Omie, com grupo de produção, de-para do portal, ponto e máximo). Mas
**nunca apareceriam, com ou sem demanda**:

| | FCA.7090QT (Omie 12034226322) | WP01.3900QT (Omie 8689775044) |
|---|---|---|
| `habilitado_reposicao_automatica` | `false` desde sempre | `false` desde 04/07 |
| saldo × ponto de pedido | 1 × 3 | 6,2 × 4 (o grupo, com o galão, bem acima) |
| pedido de venda em aberto | 6 un (#12888, #12976) | nenhum |
| última vez no cockpit | nunca | 26/06 |

O código do fornecedor (`FCA.7090QT`) mora na **descrição** de `omie_products`; o `codigo` é `PRDxxxxx`.

## Causa — dois caminhos, nenhum humano

O motor `gerar_pedidos_sugeridos_ciclo` (CTE `sku_base`) exige `habilitado_reposicao_automatica = TRUE`.
`tipo_reposicao='automatica'` + flag `false` é um estado que **nenhuma ação da UI produz**:
descontinuar grava `descontinuado`, baixo giro grava `sob_encomenda`/`descontinuado`. Ele nasce de:

1. **Inativação no Omie.** O trigger `sincronizar_ativo_omie_para_reposicao` desliga o flag e, na
   reativação, **não religa de propósito** — só abre `eventos_outlier` `sku_reativado_omie`
   (`info`, fora do badge, que conta só `critico`/`atencao`). O edge `omie-sync-status-produtos`
   ainda fecha sozinho o alerta de atenção da inativação (`resolvido_auto`). Sobra um `info`
   enterrado: eram 36 pendentes, no fim de uma fila de 125. Foi o WP01 (04/07 → 10/07).
2. **Nascimento.** A coluna tem default `false`; `atualizar_classificacao_skus` cria a linha só com a
   classe. O cold start, único caminho que cria **ligado**, só atua em SKU **sem** linha. Foi o FCA —
   o irmão FCA.7091QT, criado pelo cold start, nasceu ligado e já tinha ido 3× ao cockpit.

Agravante: a Revisão de Parâmetros mostrava os dois como `status_sugestao = OK`, fornecedor habilitado,
sem sinal do flag; o botão "Reativar" só existia para `descontinuado`. Não havia caminho na UI.

## O que foi feito

- **Dados** — `db/aplicar-religar-reposicao-15-skus.sql` (recibo #189): religou 15 SKUs — os 14 que
  vendiam com saldo no ponto de pedido ou abaixo nesse estado, mais o WP01 — e fechou os 16
  `sku_reativado_omie` pendentes deles como `aceito`. Um 405ML da lista ficou de fora: fracionado é
  desligado **de propósito** (20260515000202/20260530143818) — a postcondição P3 garante.
- **Sensor** — `v_reposicao_sku_fora_do_motor` (20260929003006, recibo #192): espelho do WHERE do motor
  com o flag **invertido**, sem o gatilho de estoque, restrito a quem vendeu em 90 dias. Espelho
  EXATO, inclusive os `COALESCE(…, true)`: num sensor o erro caro é o falso negativo.
- **UI** — aviso no cockpit (`ForaDoMotorBadge`, que diz "não consegui consultar" em vez de sumir) e
  filtro "Fora do motor" na Revisão, com **Religar** e **Descontinuar** — as duas saídas do estado sem
  dono; cada uma fecha o `sku_reativado_omie` pendente do SKU.

## Prova

- **Motor, por execução com controle** (`db/diagnostico/ensaio-motor-religados.sql`, `--ensaio`,
  rollback garantido): flag do FCA desligado → o motor incluiu 21 SKUs e o FCA ficou fora; ligado →
  FCA sugerido com 7 un; 12 dos 15 religados entram. Os 3 fora têm gate legítimo: WP01 tem estoque no
  galão do grupo; WP02.3900QT tem 4 un em entrada pendente; TE.3550 (classe C, 0,02/dia) bate no teto
  de cobertura de 60 dias.
- **View, PG17** (`db/test-v-sku-fora-do-motor.sh`): 33 ok — cada um dos 18 filtros sabotado sozinho
  fica vermelho, com controle verde na mesma invocação; `security_invoker` (não-staff vê 0), anon
  negado por SQLSTATE; postcondições A1–A3 abortam o apply sabotado. Verde em `C` e `pt_BR.UTF-8`.
- **Medição que decidiu o desenho:** só com `sku_parametros`, o sensor daria 23 SKUs — 18 deles
  **inativos no Omie** (`sku_parametros.ativo` não acompanha o Omie). Por isso a view espelha o motor
  em vez de a tela filtrar em TS.

## O que NÃO foi feito, e por quê

- **Religar sozinho na reativação do Omie** — o trigger diz "não reabilita automático" de propósito;
  reverter é decisão de produto. Sem coluna de proveniência do flag, não dá para distinguir "desligado
  pelo trigger" de "desligado por alguém".
- **Nascer ligado** — mudaria o universo do motor (money-path): decisão do founder + Codex.
- **Pedido de venda em aberto como demanda** — `sales_orders.status` não é confiável como "aberto":
  o próprio FCA tem o #11452 `importado` desde 12/06. O motor também não abate pedido aberto do
  estoque (`estoque_efetivo = físico + entrada pendente + trânsito`); a demanda entra só pela média de
  90 dias das NFs.

## Como diagnosticar "o SKU X não aparece no cockpit"

```sql
-- o motor lê este SKU? (flag, tipo, parâmetros)
SELECT empresa, sku_codigo_omie, tipo_reposicao, habilitado_reposicao_automatica, ponto_pedido, estoque_maximo
FROM sku_parametros WHERE sku_descricao ILIKE '%FCA.7090QT%';
-- está no sensor? (então só falta decidir: Religar ou Descontinuar, na Revisão)
SELECT * FROM v_reposicao_sku_fora_do_motor WHERE sku_descricao ILIKE '%FCA.7090QT%';
-- por que o flag caiu? (inativação/reativação no Omie)
SELECT tipo, status, data_evento FROM eventos_outlier WHERE sku_codigo_omie = '12034226322' ORDER BY data_evento;
```

Se o flag está ligado e ainda assim não aparece, o motor tem outros gates legítimos: estoque do grupo
(com o galão), entrada pendente, teto de cobertura, estoque não confirmado
(`reposicao_estoque_nao_confirmado_log`). O `db/diagnostico/ensaio-motor-religados.sql` é o molde
para provar por execução.
