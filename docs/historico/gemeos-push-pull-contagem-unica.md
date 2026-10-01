# Gêmeos push/pull de `sales_orders` — contagem única na fonte (2026-09-30 → 10-01)

> Chip 1 de [positivacao-universo-canonico.md](positivacao-universo-canonico.md). Money-path.
> Spec: [2026-10-01-gemeos-push-pull-contagem-unica-design.md](../superpowers/specs/2026-10-01-gemeos-push-pull-contagem-unica-design.md) ·
> Plano: [2026-10-01-gemeos-push-pull-contagem-unica.md](../superpowers/plans/2026-10-01-gemeos-push-pull-contagem-unica.md) ·
> Migration: `supabase/migrations/20261001100001_sales_orders_gemeo_importado_contagem_unica.sql` ·
> Prova: `db/test-gemeos-push-pull-contagem-unica.sh` (núcleo do CI).
>
> **Estado: NÃO aplicada.** Ensaio na prod verde em 2026-10-01 (`db:aplicar --ensaio`, sha256
> `4b2f9014…`, ROLLBACK). O apply vem depois do Codex adversarial no diff (cota em `SALDO_ALTO` até
> 03/10 19:11); o PR fica em DRAFT até lá.

## O que se mediu (prod, `psql-ro`, 2026-09-30)

O pedido que o app empurra ao Omie é uma linha de `sales_orders` (`hash_payload` nulo,
`omie_payload`). O importador traz o MESMO pedido como OUTRA linha (`hash_payload =
'omie_<account>_<omie_pedido_id>'`, `order_date_kpi` = dInc do Omie) e casa só por hash — nunca
enxerga a linha do app. Foi desenho deliberado (`20260613120000`, "re-unificar push×pull … fase
futura").

| | valor |
|---|---|
| pares `(account, omie_pedido_id)` | **25** (máx 2 por chave) |
| empurradas pelo app | 26 — 1 sem gêmeo (`4c19af2a`, abr, R$ 314,40) |
| pares com kpi nas 2 linhas | **22** (06–22/abr; kpi do app veio do backfill de 25/05) |
| importadas sem kpi / sem pid | 0 / 0 (de 31.646) |
| linhas com hash nulo com `order_items` | 0 (de 28) |

Duplicata no universo canônico (só kpi): **R$ 12.840,46 em abril**, 14 cliente-mês. Tirar a linha do
app que tem gêmeo muda só abril: **0** clientes perdem positivação, **0** de 1.229 mudam a 1ª compra.

## Quatro premissas do retrato de 27/09 que eram falsas

1. **3 dos 25 pares não são a mesma venda.** A ART MÓVEIS faturou R$ 527,20 como #10518; o app reenviou
   2× e os pedidos #10520/#10521 foram **reaproveitados no Omie** para outros clientes. A ART contava a
   venda 3× em abril. Depois do push, a linha do app não é confiável nem no cliente.
2. **O congelado de abril não estava duplicado — estava incompleto.** Gravado em 25/05, tem só as 23
   linhas do app de abril (15 clientes, R$ 13.154,86); as importadas vieram depois. Maio idem (104 × 186).
3. **Margem, apriori e régua de preço não duplicavam:** passam por `order_items`, que a linha do app
   nunca tem. A duplicata morava nos 16 consumidores que leem `sales_orders` direto — 4 só-kpi (hero,
   congelado, MTD, vendas do dia) e 12 por `created_at`/`COALESCE`.
4. **O custo não era só receita:** feed com as 2 linhas, separação aceitando qualquer uma, edição pela
   linha do app deixando a importada velha (fora do escopo — fase 2).

## A decisão (founder)

D1 contagem única agora (uma linha por venda = fase 2) · D2 congelados de abr/mai **mantidos** como
registro (recongelar usaria a carteira de hoje; nenhum leitor vivo) · D3 Codex em `SALDO_ALTO` →
Caminho B no desenho + PR DRAFT até o adversarial no diff · D4 a sessão aplica via `db:aplicar`.

## O conserto

- `sales_orders.gemeo_importado_id` (FK `ON DELETE SET NULL`), **derivada**: só a linha do app, aponta
  para a importada do mesmo pedido; quando aponta, a linha não tem `order_date_kpi`.
- 3 triggers `SECURITY DEFINER`: `trg_sales_orders_gemeo_app` (linha do app: deriva ponteiro e kpi) ·
  `_importada_antes` (BEFORE INSERT da importada: tira o kpi do app — tem de ser antes, o índice é
  imediato) · `_importada_depois` (AFTER: grava o ponteiro). Advisory lock por `(account, pid)` nos
  dois lados serializa write-back × importador. O corpo do importador NÃO mudou.
- `uniq_sales_orders_kpi_por_pedido_omie` (no máximo 1 linha com kpi por pedido Omie) e o CHECK
  `sales_orders_gemeo_e_recibo` como trava de fundo; backfill dos 25 pares + postcondição.
- **A prova pegou um 55006 que a prod também daria:** o `trg_pedido_venda_coerencia_cab` é
  `DEFERRABLE INITIALLY DEFERRED`, então o UPDATE do backfill deixa eventos pendentes e o
  `CREATE UNIQUE INDEX` na mesma transação é recusado ("pending trigger events"). Conserto:
  `SET CONSTRAINTS ALL IMMEDIATE` entre os dois. O `CREATE` da migration nunca teria mostrado isso.
- A coluna nova fica **sem GRANT** para `authenticated`: em prod o SELECT de `sales_orders` é por
  coluna (27/30 desde o #2bdd5ac74), 3 colunas já negadas — nenhum `select('*')` do app é possível hoje.

## A prova

29 asserts sobre a migration real e a RPC real `criar_pedidos_com_itens`, com o trigger de coerência
da prod: backlog (par idêntico, reaproveitado, recente, 2 linhas do app no mesmo pedido, sem gêmeo,
orçamento/rascunho, mesmo pid em contas diferentes), regime (import depois do push COM kpi no app,
push depois do import, app que nasce com pid, reimport, delete + reimport, kpi direto, papel sem
EXECUTE), corrida determinística nos dois sentidos (bandeira + `pg_stat_activity`), o lote do
importador sob o índice (o pedido que bate vai para `failed` com 23505, o vizinho entra), índice,
CHECK, dente da postcondição e reaplicar = no-op. **Falsificação: 8 sabotagens, uma camada por vez,
cada uma vermelha no assert que declara**, em `LC_ALL=C` e com o servidor em `pt_BR.UTF-8`.

Antes da prova, um spike descartável (S1–S9) testou a semântica do PG que o desenho assume. O S9 forçou
o único deadlock possível: kpi gravado num UPDATE **posterior** de linha do app que já tem pid,
concorrendo com a importação do mesmo pedido (tupla → advisory × advisory → tupla). O PG aborta um com
40P01; no spike a vítima foi o importador — rollback, nenhuma duplicata, cura na rodada seguinte.

## Reversão

O "antes" está em [anexos/gemeos-antes.csv](anexos/gemeos-antes.csv): série `kpi_antes_app` (id do
pedido, data, total — os 22 kpi que o backfill zera), mais os agregados por mês (`canonico_mes`,
`congelado`) que a validação externa compara. O retrato **por cliente** ficou fora do git
(minimização). Desfazer = founder, no SQL Editor:

```sql
DROP TRIGGER IF EXISTS trg_sales_orders_gemeo_app ON public.sales_orders;
DROP TRIGGER IF EXISTS trg_sales_orders_gemeo_importada_antes ON public.sales_orders;
DROP TRIGGER IF EXISTS trg_sales_orders_gemeo_importada_depois ON public.sales_orders;
DROP INDEX IF EXISTS public.uniq_sales_orders_kpi_por_pedido_omie;
DROP INDEX IF EXISTS public.idx_sales_orders_app_pedido_omie;
ALTER TABLE public.sales_orders DROP CONSTRAINT IF EXISTS sales_orders_gemeo_e_recibo;
ALTER TABLE public.sales_orders DROP COLUMN IF EXISTS gemeo_importado_id;
-- e, para cada linha kpi_antes_app do anexo: UPDATE public.sales_orders SET order_date_kpi = '<data>' WHERE id = '<id>';
```

## Limites conhecidos

- Os 12 consumidores por `created_at`/`COALESCE` seguem contando a linha do app (o estado de antes;
  chip de erradicação). Depois do PR do kpi, toda linha viva terá kpi e "só kpi" deixa de perder venda.
- Os triggers da importada são só de INSERT: um one-off que mude hash/pid de uma importada EXISTENTE
  não re-marca (o CHECK canônico já amarra hash a pid).
- A ordem de listas por kpi muda para as 22 linhas de abril; 25 `updated_at` avançam no apply.

## O que o PR do kpi do app precisa

1. Gravar o kpi no INSERT ou no MESMO UPDATE do write-back que seta o pid — nunca num UPDATE depois
   (o deadlock do S9) — com a data de SP do instante (`AT TIME ZONE 'America/Sao_Paulo'`), não UTC.
2. Atribuição do ranking (`useTeamRanking` credita por `created_by`; as importadas têm o `created_by`
   de uma farmer em 29.783 linhas): com kpi no app a venda "migraria" quando a importada chegasse.
3. `SalesQuotes.tsx:198-201` regrava `'rascunho'` por cima do `'enviado'` depois do push.
4. Alternativa: o próprio trigger derivar o kpi da linha do app sem gêmeo, tirando os escritores TS.

## Codex

`desenho=sem-codex (SALDO_ALTO 86%, Caminho B — auto-revisão com spike executado, spec §7)` ·
`código=pendente (após 03/10 19:11)` · `extra=nenhum`. **REVISÃO INDEPENDENTE PENDENTE.**

## Lições

1. **"Duplicado" no congelado pode ser "incompleto".** Antes de corrigir um snapshot por duplicata,
   compare-o com as linhas que o originaram: o de abril batia 15/15 com as linhas do app — a
   importação do histórico veio depois do congelamento.
2. **A mesma chave não prova a mesma venda.** Pedido reaproveitado no Omie mantém o
   `omie_pedido_id` e troca o cliente: a dedup por chave acerta porque a autoridade é o Omie, não
   porque as duas linhas descrevam a mesma coisa.
3. **Backfill + DDL numa tabela com CONSTRAINT TRIGGER DEFERRED dá 55006 na mesma transação.**
   Plpgsql é late-bound e DDL também: só a migration EXECUTADA em PG17 com o trigger da prod mostra.
