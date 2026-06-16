# Convenções de schema — leia antes de adaptar ou criar query

Fonte de verdade: `src/integrations/supabase/types.ts` (ache as seções com `grep -n '    Tables: {'`
e `'    Views: {'` — o arquivo cresce a cada migration; não confie em nº de linha fixo).
Os tipos do Supabase tipam **todas** as datas como `string` — em SQL elas são `date`/`timestamptz`
reais, então comparações com `current_date` / `date_trunc` funcionam normalmente. Quando uma
coluna for `text` de fato (ex.: status), trate como texto.

## 1. Empresa — 4 grafias (resumo na SKILL.md; aqui o detalhe operacional)

- Minúsculo (`colacor`/`oben`/`colacor_sc`) em `account` (comercial), `empresa` (operacional),
  `company` (financeiro). Mesmos 3 valores, colunas diferentes.
- MAIÚSCULO enum `empresa_reposicao` = `OBEN`/`COLACOR` (só 2, **sem Colacor SC**) em
  `abc_xyz_classification`, `sku_leadtime_history`, `purchase_orders_tracking`,
  `reposition_parameters`, `v_pedidos_em_aberto`.
- `omie_clientes.empresa_omie` e `v_sku_aumento_vigente.empresa_lower` são casos isolados.
- Sem coluna de empresa: `orders` (afiação = Colacor SC por natureza), `profiles`,
  `product_costs` (custo global por produto), `customer_metrics_mv`.
- **Regra de ouro ao cruzar domínios:** `lower(a.empresa) = lower(b.account)` etc. E lembre que
  o domínio de reposição não tem Colacor SC — não espere linhas de `colacor_sc` lá.

## 2. Cliente — dois espaços de chave, ponte por omie_clientes

- `profiles.user_id` (uuid) = chave canônica. Usada por `sales_orders.customer_user_id`,
  `orders.user_id`, `customer_contacts/visit_scores/metrics_mv.customer_user_id`,
  `farmer_client_scores.customer_user_id`.
- `omie_codigo_cliente` (number) = chave do mundo Omie. Usada por `customer_segments`,
  `customer_preferred_items`, e como `cliente_codigo_omie` em `venda_items_history`,
  `fin_contas_receber`.
- **Ponte:** `omie_clientes` (`user_id` ↔ `omie_codigo_cliente`). Para cruzar faturamento
  fiscal (Omie) com scores/pedidos (user_id), passe por ela. `omie_clientes` não tem nome —
  o nome legível (`razao_social`) está em `profiles`. Fallback de match: `profiles.cnpj` /
  `profiles.document` ↔ `venda_items_history.cliente_cnpj_cpf` / `fin_contas_receber.cnpj_cpf`.

Enriquecer um resultado com nome do cliente (padrão LEFT JOIN, não derruba linhas):
```sql
left join omie_clientes oc on oc.omie_codigo_cliente = <tabela>.cliente_codigo_omie
left join profiles p on p.user_id = oc.user_id
-- ...select p.razao_social
```

## 3. SKU/produto — `sku_codigo_omie` com tipo inconsistente

- Chave de negócio = `sku_codigo_omie`. **Atenção:** é `number` em `sku_parametros`,
  `abc_xyz_classification`, `purchase_orders_tracking`, `reposition_parameters` e na maioria
  das views; mas `string` em `sku_estoque_atual`, `sku_status_omie`, `pedido_compra_item`,
  `fornecedor_promocao`, `v_sugestao_negociacao_ativa`. **Todo JOIN de SKU precisa de cast:**
  `a.sku_codigo_omie::text = b.sku_codigo_omie::text`.
- O outro espaço é o uuid `omie_products.id` (usado por `inventory_position.product_id` e
  `product_costs.product_id`). Ponte: `omie_products.omie_codigo_produto (number) = sku_codigo_omie`.
- Descrição do produto: `omie_products.descricao` (ou colunas `sku_descricao` quando existirem
  nas views).

## 4. Fontes canônicas por conceito

| Conceito | Fonte | Por quê |
|---|---|---|
| Receita faturada (verdade fiscal) | `venda_items_history` (`empresa`, `data_emissao`, `valor_total`) | granularidade NF-e/item |
| Pedido comercial (momentum) | `sales_orders` (`account`, `created_at`, `total`) | pipeline; filtrar status + soft-delete |
| Afiação / serviço (Colacor SC) | `orders` | sem coluna de empresa; é o módulo de serviço |
| Métricas de cliente pré-agregadas | `customer_metrics_mv` | faturamento_90d vs prev_90d já calculado |
| Estoque disponível por SKU | `sku_estoque_atual.estoque_disponivel` | fonte dedicada (`estoque_fisico` = total) |
| Parâmetros de reposição | `sku_parametros` (`ponto_pedido`, `estoque_minimo`, `demanda_media_diaria`) | calculados |
| Aging de recebíveis/pagar | views `fin_aging_receber` / `fin_aging_pagar` | já bucketizadas por empresa |
| Margem bruta consolidada | `fin_dre_snapshots` (`receita_liquida`, `cmv`, `lucro_bruto`) | contábil top-down |
| Custo por produto | `product_costs` (`cost_final`, `cost_confidence`) | esparso, global, sem empresa |

## 5. Soft-delete e filtros de validade

- `sales_orders.deleted_at` existe → sempre `deleted_at is null`. (A nota antiga do CLAUDE.md
  §10 sobre "sem soft-delete" está desatualizada para esta tabela.)
- Status de `sales_orders`: vocabulário inferido `rascunho`/`pendente`/`confirmado`/`enviado`/
  `entregue`/`cancelado`. As views de vendas excluem `('cancelado','rascunho')`. **Se em dúvida
  sobre o vocabulário real, rode o diagnóstico antes:**
  `select status, count(*) from sales_orders group by status order by 2 desc;`
- `sku_parametros.ativo`, `omie_products.ativo`, `fornecedor_aumento_item.ativo` etc. →
  filtre `coalesce(ativo, true)`.
- `fornecedor_promocao` e aumentos: vigência por `valido_desde`/`valido_ate` ou
  `data_vigencia`, não por flag.

## 6. Inadimplência — vocabulário Omie real (não use o legado)

`fin_contas_receber.status_titulo` usa strings do Omie: **`'ATRASADO'`** (= vencido),
`'A VENCER'`, `'VENCE HOJE'`. **NÃO** use `'ABERTO'`/`'VENCIDO'`/`'PARCIAL'` — esses só vivem
em testes/helpers desatualizados e divergem da produção. Saldo em aberto =
`valor_documento - coalesce(valor_recebido, 0)` (a coluna `saldo` é nullable; o serviço
canônico calcula por subtração). Fallback puro-data robusto: `data_recebimento is null and
data_vencimento::date < current_date`. Em contas a pagar, a baixa é `data_pagamento` (não
`data_recebimento`) e o valor pago é `valor_pago`.

## 7. Margem — confiabilidade é rastreável e parcial

`product_costs` tem `cost_confidence` (numérico) e `cost_source` (origem) por linha — então o
dado diz o quanto confiar nele. É **esparso**: nem todo produto tem custo real (há `cmc` e
`haircut_fallback_preco` em config sugerindo fallback estimado). **Sempre** que estimar margem
por produto, rode junto a query de **cobertura de custo** (% da receita com custo conhecido) e
exponha esse percentual. Para visão executiva, prefira `fin_dre_snapshots` (margem bruta
consolidada, confiável). `margin_audit_log` é margem por **cliente** (farmer), não por pedido/SKU.

## 8. Confiabilidade — gating opcional

`fin_confiabilidade` (`pct_valor_mapeado`, `pct_mov_conciliado`, `fechamento_status`, por
`company`/`ano`/`mes`) permite checar se o mês financeiro está confiável antes de afirmar
números de DRE/fluxo. Útil como nota de rodapé do brief quando o mês ainda não fechou.
