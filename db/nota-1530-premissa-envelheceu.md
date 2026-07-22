# Correção de premissa da `20260726160000_margem_reconciliacao_universo_unico.sql`

> A migration é imutável depois de committada (`supabase/migrations/` é fonte de DR e o apply é
> manual). Esta nota corrige uma afirmação do cabeçalho dela que **envelheceu entre escrever e
> mergear** — o padrão do repo para isso é arquivo em `db/`, mesmo sendo só texto.

## O que o cabeçalho afirma, e por que deixou de ser verdade

> "Nenhuma das duas chegou a rodar em prod (conferido: 0 em `pg_proc` para ambas antes deste PR;
> `farmer_client_scores.gross_margin_pct` seguia 0 em 6.632/6.632). Esta migration reconcilia
> ANTES que qualquer número divergente exista — **não há flip-flop de valor exibido**."

Verdadeiro quando escrito (2026-07-21, início da tarde). **Falso a partir de 2026-07-21 ~22:04**,
quando o founder aplicou a migration do #1495 e o cron rodou:

| medição | antes (quando a migration foi escrita) | depois (2026-07-21 22:04) |
|---|---|---|
| `public.get_customer_margin_summary` em `pg_proc` | 0 | **1** |
| `private.margem_cliente_agregada` em `pg_proc` | 0 | 0 (o #1519 não foi aplicado) |
| `gross_margin_pct` ≠ 0 | 0 de 6.632 | **1.058** |
| `gross_margin_pct` NULL | 0 | 5.574 |

⇒ **A margem está viva em produção**, calculada pelo caminho do #1495: JOIN por `product_id`
(perde os R$ 247.482,10) com o universo denylist (correto). Logo esta migration **não** é mais
"reconciliar antes que exista número" — ela **altera número já exibido**.

## O impacto real de aplicar, medido contra o estado VIVO

Comparando o que está em produção hoje (JOIN `product_id` + denylist) com o que esta migration
produz (JOIN `omie_codigo_produto` + denylist), sobre 1.225 clientes:

| efeito | clientes |
|---|---|
| **ganham** margem (eram NULL, passam a ter valor) | **6** |
| **perdem** margem (tinham valor, virariam NULL) | **0** |
| número muda (ambos com valor) | 187 |
| delta máximo | 35,19 pp |
| delta médio | **0,20 pp** |

**A mudança é estritamente melhoradora: ninguém regride.** Nenhum cliente perde o sinal, 6 passam
a tê-lo, e os 187 ajustes vêm de custo que o JOIN antigo não alcançava — o número novo é mais
completo, não diferente por acaso.

O eixo do UNIVERSO (denylist) **já está vivo** e veio do próprio #1495, então esta migration não o
altera em produção — ela alinha o helper a ele. O que ela muda de fato em prod é o **eixo do
JOIN** e os **guards de qualidade**.

## O que continua válido no cabeçalho

Tudo o mais: os três eixos e quem venceu cada um, os números do JOIN (1.837 itens com `product_id`
nulo, 783 com custo alcançável por código, R$ 247.482,10), o universo de status
(R$ 6.985.425,66 que a allowlist descartava) e a limitação medida do double-count (24 pares,
3 clientes, 0,61 pp, zero mudanças de faixa).

## Lição

A premissa de uma migration money-path pode envelhecer **entre escrevê-la e mergeá-la** quando o
founder aplica coisas em paralelo. "Conferido: 0 em `pg_proc`" é um fato **datado**, não uma
propriedade — e um cabeçalho que promete "não há flip-flop" é exatamente o tipo de afirmação que
se torna perigosa ao envelhecer, porque quem for aplicar vai lê-la como garantia. **Ao mergear
migration money-path que ficou aberta por horas, remeça o estado de prod antes** — a mesma
disciplina do baseline, aplicada ao momento do merge e não só ao da escrita.
