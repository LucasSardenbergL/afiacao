# Farmer — a margem NULL em 84% da base NÃO é lacuna de custo (análise 2026-07-22)

> Análise de priorização (100% leitura via `psql-ro`, zero escrita) motivada pela leitura de que
> "41,6% dos itens sem `product_costs` → só 16% dos clientes têm margem". A premissa era: cadastrar
> o custo dos produtos de maior alavanca destravaria a maioria dos 84% sem margem. **A premissa não
> se sustenta.** Registrado aqui para não remontar a investigação nem disparar um mutirão de cadastro
> que rende 2,8% da base.

## O número que todo mundo lê errado

`farmer_client_scores`: 6.632 clientes · 1.058 (16%) com margem · 5.574 (84%) NULL. A leitura
natural — "custo faltante trava 84%" — é **falsa**. Decompondo os 5.574 pela causa REAL (universo
replicado 1:1 de `private.margem_cliente_agregada()`):

| Causa da margem NULL | Clientes | % dos s/ margem | Cadastrar custo resolve? |
|---|---:|---:|:---:|
| **Não tem NENHUM item de pedido elegível** | **5.407** | **97,0%** | ❌ não |
| Tem itens, nenhum com custo conhecido | **156** | 2,8% | ✅ sim |
| Computável mas receita 0 (preço 0 no item) | 11 | 0,2% | ❌ não |

**Teto de destrave por cadastro de custo = 156 clientes** (16% → 18,3%), não 5.574. O gargalo dos
84% é **ausência de venda**, não ausência de custo.

### Hipótese de fonte divergente — testada e REFUTADA

Se os 5.407 "sem pedido" tivessem faturamento fiscal (NF-e) que a função de margem não lê, o custo
ainda não os destravaria, mas o diagnóstico mudaria. Cruzei via `omie_customer_account_map`
(a `omie_clientes` foi posta em quarentena em 2026-07-22 — `_quarantine_omie_clientes_20260722`):
os 5.407 somam **R$ 0,00 de NF-e em `venda_items_history`, zero títulos**. Realmente não têm venda
(consistente com os aliases fiscais `@placeholder.local` sem `profiles` do CLAUDE.md §5).

## Padrão sistêmico: existe, e é "produto inativo", não "import quebrado"

A falta de custo NÃO está espalhada por safra de cadastro nem por rota de import. Ela é quase
inteiramente **catálogo descontinuado** (`omie_products.ativo = false`):

| Recorte (produtos que aparecem em pedidos) | Produtos | Cobertura de custo |
|---|---:|---:|
| `ativo = true` | 2.007 | **98,5%** |
| `ativo = false` | 1.364 | **3,2%** |

Produto **ativo** tem 98–100% de cobertura em TODA safra (02→07/2026) — descarta "carga inicial não
trouxe custo". O buraco é inteiro em `ativo=false`. E o flag não mente: os 1.321 inativos sem custo
movimentaram **R$ 1.583 nos últimos 90 dias** contra R$ 11,4M históricos — receita morta.

**A prova que fecha o caso:** cobertura de custo sobre a receita dos **últimos 90 dias = 99,59%**.
O "41,6% sem custo" é artefato de somar o acumulado de todos os tempos, dominado por SKU aposentado.

## Top produtos por clientes-destravados (para referência)

Os únicos 156 destraváveis se concentram nestes SKUs (todos `ativo=false` — histórico). "Destrava"
NÃO é aditivo: a soma do top-20 dá 114, mas o conjunto distinto é **74 clientes** (47% dos 156);
muito cliente travado compra vários — cadastrar um só já o solta.

| Código | Produto | Destrava | Compram | Receita fora da conta |
|---|---|---:|---:|---:|
| 394036193 | THINNER DR.4403LT | 17 | 217 | R$ 578.493 |
| 394036175 | SELADORA CONCENTRADA NL.9245.00LT | 13 | 157 | R$ 742.399 |
| 394036467 | ALMASUPER PENETRANTE 100G | 10 | 60 | R$ 238.934 |
| 3702003754 | COLA BRANCA PVA EXTRA 50KG | 9 | 71 | R$ 191.822 |
| 394035988 | CATALISADOR FC.6975L5 | 8 | 110 | R$ 158.657 |

**Alvo de cadastro que valeria a pena (produto ATIVO sem custo): 30 SKUs, ~R$ 4,7k em 90d,
destravam 2 clientes.** Não justifica mutirão.

## Achado colateral mais caro que a lacuna de cadastro

A `private.margem_cliente_agregada()` **não tinha janela temporal** (até a decisão de 2026-10-09, abaixo) — agregava lifetime, misturando
preço de 2022 com 2026. Dos 1.069 clientes com margem, a conta cobre só **58% da receita deles**;
**415 (39%) têm mais da metade da receita fora da conta**. A margem de 53,49% não está errada, mas
descreve um mix parcial e envelhecido.

Aplicar janela tem trade-off medido (NÃO há conserto grátis — precisão sobe, cobertura de cliente
despenca; escolher é decisão de produto, não técnica):

| Janela | Clientes com margem | Cobertura da receita |
|---|---:|---:|
| lifetime (hoje) | 1.069 | 58,0% |
| 24 meses | 671 | 88,2% |
| 12 meses | 530 | 94,9% |
| 6 meses | 414 | 98,6% |

### ✅ Decisão (2026-10-09): janela de 12 meses móveis

O founder delegou e a decisão foi tomada: **a margem por cliente considera SÓ itens de pedidos dos
últimos 12 meses móveis** (`AND so.created_at >= now() - interval '12 months'` no CTE `itens` de
`private.margem_cliente_agregada()`; migration `20261009220000_margem_cliente_janela_12m.sql`, prova
`db/test-margem-cliente-janela-12m.sh` no núcleo de CI). Nenhuma outra regra mudou (denylist de status,
`deleted_at`, `excluir_da_carteira`, as 3 pernas computáveis, custo `cost_final`→`cost_price` só se > 0
e finito).

Medido em prod (psql-ro, 2026-10-09), mesmo universo da função:

| Janela | Clientes c/ margem | Receita computada | Margem ponderada |
|---|---:|---:|---:|
| sem janela (até 2026-10-09) | 1.082 | R$ 17,35M | 40,49% |
| 24 meses | 653 | R$ 10,98M | 43,34% |
| **12 meses (escolhida)** | **502** | **R$ 5,94M** | **45,47%** |
| 6 meses | 385 | R$ 3,14M | 48,67% |

**Por quê.** `product_costs` é um retrato do custo ATUAL; aplicá-lo a preço de venda de 2020–2024
(`sales_orders` vai de 2020-04-08 a hoje) deprime a margem — ~5 p.p. de viés para baixo no agregado.
12m equilibra precisão e cobertura; 6m é volátil e cobre pouco.

**`created_at` é a data do pedido**, não do import: 0 de 31.783 pedidos divergem > 3 dias de
`order_date_kpi` (psql-ro, 2026-10-09).

**Os ~580 que perdem margem** (578 em `farmer_client_scores` com margem e > 365 dias sem compra) não
compraram item com custo nos últimos 12 meses. Ficam **NULL** (ausente ≠ zero), e a tela diz o
motivo: o Customer 360 mostra "margem: sem compra nos últimos 12 meses" (lido de
`days_since_last_purchase`, medido), e toda legenda de margem cita a janela — `legendaCobertura`
("… clientes c/ margem (últimos 12 meses)"), `legendaCoberturaItens` e a dica
`DICA_COBERTURA_LINHAS` (`src/lib/format.ts` · `src/lib/scoring/margin.ts`).

**Aplicada em prod em 2026-10-09 pela sessão, dentro do ENVELOPE** (MCP `query_database`): ensaio com
`RAISE EXCEPTION 'ENSAIO_OK'` (rollback conferido por psql-ro: corpo antigo intacto) → apply real com a
postcondição da migration + `md5(prosrc)` = `8335b945…` (calculado dos bytes do arquivo). 2ª testemunha
(psql-ro): md5 idêntico, `db/valida-margem-cliente-janela-12m.sql` 3 × ✅, e a função real devolve
**502 clientes · R$ 5,94M · 45,47%**.


**Revisão Codex retroativa (2026-10-09, sem P0/P1):** dois ajustes de borda, no PR de acompanhamento.
(1) A legenda "sem compra nos últimos 12 meses" usava `days_since_last_purchase > 365`, mas o SQL corta
por INSTANTE e os dias são DATA CIVIL: com 365 dias o pedido já pode ter saído da janela → agora `>= 365`
(com ≤ 364 nunca saiu, porque 12 meses ≥ 365 dias). (2) O harness não tinha pedido no instante exato do
corte — `>=`→`>` sobrevivia; agora J5 (seed + consulta na MESMA transação, `now()` fixo) e a 6ª
sabotagem "corte exclusivo" a derruba (`PASS=21`, C e pt_BR). Ausente→zero nos consumidores: nenhum achado.
**Quando aparece na tela.** A margem persistida em `farmer_client_scores` só se ajusta no próximo
cron do `calculate-scores` (06:00/06:25 UTC) depois do apply — sem deploy de edge. As RPCs ao vivo
(`get_carteira_margem_faixa`, `get_customer_margin_summary`) mudam no instante do apply.

### A saída barata (conserto de código de maior alavanca, aditivo)

`get_customer_margin_summary()` **já retorna** `itens_com_custo` e `itens_sem_custo` por cliente, mas
o writer os DESCARTA: `calculate-scores/index.ts:572` extrai só `gross_margin_pct` do map, e o upsert
(`:688`) grava só isso — `farmer_client_scores` só tem `customer_user_id` + `gross_margin_pct`.
Persistir as duas contagens (2 colunas, dado já computado) dá qualidade por cliente sem sacrificar
cobertura: a tela passa a dizer "margem apurada sobre 3 de 40 itens" e permite ordenar/filtrar por
confiança — em vez de trocar cobertura por precisão via janela.

## Query canônica (reproduz a decomposição causal)

```sql
-- Decompõe os clientes de farmer_client_scores pela CAUSA da margem NULL.
-- Universo idêntico ao de private.margem_cliente_agregada() (denylist de status + excluir_da_carteira).
with itens as (
  select oi.customer_user_id as cid, oi.quantity::numeric as qtd, oi.unit_price::numeric as preco,
         coalesce(
           case when pc.cost_final > 0 and pc.cost_final < 'Infinity'::numeric then pc.cost_final end,
           case when pc.cost_price > 0 and pc.cost_price < 'Infinity'::numeric then pc.cost_price end
         ) as custo_unit
    from order_items oi
    join sales_orders so on so.id = oi.sales_order_id
    left join omie_products op on op.omie_codigo_produto = oi.omie_codigo_produto
                              and op.omie_codigo_produto is not null
    left join product_costs pc on pc.product_id = op.id
   where so.status not in ('cancelado','rascunho','pendente','orcamento')  -- prod: faturado/importado/separacao/enviado/cancelado
     and so.deleted_at is null and oi.customer_user_id is not null
     and not exists (select 1 from cliente_classificacao cc
                      where cc.user_id = oi.customer_user_id and cc.excluir_da_carteira is true)
),
por_cliente as (
  select cid,
         count(*) filter (where custo_unit is not null and qtd > 0 and preco >= 0) as computaveis,
         coalesce(sum(qtd*preco) filter (where custo_unit is not null and qtd > 0 and preco >= 0),0) as receita_comp
    from itens group by cid
)
select case
    when pc.cid is null                              then 'A_SEM_ITEM_DE_PEDIDO (custo nao resolve)'
    when pc.computaveis > 0 and pc.receita_comp > 0  then 'B_TEM_MARGEM'
    when pc.computaveis > 0                          then 'C_RECEITA_ZERO (preco 0)'
    else                                                  'D_ITENS_SEM_CUSTO (custo DESTRAVA)'
  end as situacao, count(*) as clientes
from farmer_client_scores f
left join por_cliente pc on pc.cid = f.customer_user_id
group by 1 order by clientes desc;
```

## Veredito e recomendação

1. **NÃO fazer mutirão de cadastro de custo.** Ganho máximo = 156 clientes (2,8%), concentrado em
   SKU descontinuado. Se quiser mesmo assim, os 5 primeiros da tabela destravam ~40 clientes.
2. **Persistir `itens_com_custo`/`itens_sem_custo`** em `farmer_client_scores` — maior alavanca de
   código, aditivo, dado já computado e hoje jogado fora no writer.
3. **Janela temporal na margem é decisão de produto** (trade-off cobertura×precisão medido acima),
   não conserto técnico — não aplicar às cegas: pioraria justamente os 84%.

**Confiabilidade:** alta nas contagens de cliente e na decomposição causal (contadas linha a linha,
replicando o universo da função em prod). Média na receita histórica (`unit_price` de pedido
importado do Omie não passa por conferência fiscal). A ausência já é honesta no app (`NULL`, nunca 0;
cobertura via `legendaCobertura` em `src/lib/scoring/margin.ts`) — o cálculo está correto; o que
faltava era saber que o buraco não é de custo.

Nota de reconciliação com o PR #1495 (68.433 itens / 41,6% sem custo): medi 69.080 elegíveis /
40,05% sem custo — a diferença vem do filtro `excluir_da_carteira` e da data. Não altera nenhuma
conclusão.
