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

A `private.margem_cliente_agregada()` **não tem janela temporal** — agrega lifetime, misturando
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
