# Queries SQL read-only de apoio

Todas são **read-only** e rodam no **🟣 Lovable → SQL Editor → cola → Run**. O Lucas cola o
resultado de volta no chat. **Nunca** rode SQL você mesmo — não há acesso a terminal/CLI ao banco.

## Lembretes de schema (pra não quebrar)
- Reposição usa empresa **`'OBEN'`** (maiúsculo); financeiro usa **`'oben'`** (minúsculo).
- `sku_codigo_omie`: **number** em `sku_parametros` e `v_sku_parametros_sugeridos`; **string** em
  `sku_estoque_atual` e `eventos_outlier`. Use `::text` no join.
- Nomes de coluna abaixo foram inferidos do schema gerado (`src/integrations/supabase/types.ts`)
  e dos relatórios de exploração. Se o editor reclamar de coluna inexistente, rode
  `SELECT * FROM <tabela> LIMIT 1;`, peça a lista de colunas ao usuário e ajuste. **Não invente.**

---

## Query 1 — Painel do SKU (situação completa)
Troque `12345` pelo código Omie do SKU.

```sql
-- 🟣 Lovable → SQL Editor → cola → Run
SELECT
  p.sku_codigo_omie,
  p.sku_descricao,
  p.classe_abc, p.classe_xyz, p.classe_consolidada, p.classe_forcada,
  e.estoque_fisico,
  e.estoque_disponivel,
  e.estoque_pendente_entrada,
  e.ultima_sincronizacao,
  p.demanda_media_diaria,
  p.demanda_coef_variacao,
  p.demanda_dias_com_movimento,
  p.ponto_pedido, p.estoque_minimo, p.estoque_maximo, p.estoque_seguranca,
  p.cobertura_alvo_dias,
  p.lt_medio_dias_uteis, p.lt_p95_dias, p.lt_desvio_padrao_dias, p.lt_n_observacoes, p.fonte_leadtime,
  p.fornecedor_codigo_omie, p.fornecedor_nome, p.lote_minimo_fornecedor,
  p.valor_vendido_90d,
  v.preco_compra_real,
  v.preco_venda_medio,
  v.custo_capital_efetivo_perc,
  v.custo_pedido_aplicado,
  v.qtde_compra_ciclo_sugerida,
  ROUND(
    COALESCE(e.estoque_disponivel, e.estoque_fisico) / NULLIF(p.demanda_media_diaria, 0), 1
  ) AS cobertura_dias_atual
FROM sku_parametros p
LEFT JOIN sku_estoque_atual e
  ON e.sku_codigo_omie = p.sku_codigo_omie::text
 AND e.empresa = p.empresa
LEFT JOIN v_sku_parametros_sugeridos v
  ON v.sku_codigo_omie = p.sku_codigo_omie
 AND v.empresa = p.empresa
WHERE p.empresa = 'OBEN'
  AND p.sku_codigo_omie = 12345;
```

Leia daqui: estoque vs ponto de pedido/mínimo (cobertura em dias), classe, custo de capital do
sistema, lead time + nº de observações (confiança), preço de compra/venda, EOQ sugerido,
frescor do estoque (`ultima_sincronizacao`).

---

## Query 2 — Folga de caixa nas 13 semanas (RPC)
A fonte mais direta de "tenho fôlego?". Passa o saldo inicial = soma das contas ativas.

```sql
-- 🟣 Lovable → SQL Editor → cola → Run
SELECT *
FROM fin_projecao_13_semanas(
  'oben',
  (SELECT COALESCE(SUM(saldo_atual), 0)
     FROM fin_contas_correntes
    WHERE company = 'oben' AND ativo)
);
```

Retorna 13 linhas (`semana_inicio`, `semana_fim`, `semana_label`, `entradas_previstas`,
`saidas_previstas`, `fluxo_liquido`, `saldo_projetado`). O **piso** = `MIN(saldo_projetado)`.
É só CR/CP em aberto (não inclui estoque/folha). A compra à vista entra como saída nova na
semana do pagamento — recalcule o piso subtraindo o valor da compra.

> **Esta RPC é gated a staff autenticado** — só roda no 🟣 Lovable (founder logado). Confirmado
> contra produção: o role de leitura/diagnóstico recebe `permission denied for function`. Logo a
> folga de caixa **depende do founder colar o resultado** — o assistente não consegue rodá-la por
> fora. (As demais queries deste arquivo são SELECTs em tabelas/views legíveis.)

---

## Query 3 — Oportunidades de hoje (aumentos + promoções unificados)
Quando o usuário pergunta "o que comprar hoje" ou está priorizando.

```sql
-- 🟣 Lovable → SQL Editor → cola → Run
SELECT
  sku_codigo_omie, sku_descricao, fornecedor_nome, cenario,
  desconto_total_perc, desconto_promo_perc, aumento_evitado_perc,
  custo_capital_efetivo_perc,
  qtde_base, qtde_oportunidade, preco_item_eoq,
  economia_bruta_estimada,
  data_limite_acao, dias_ate_limite, proxima_vigencia_aumento,
  campanha_nome, modo_promo, tem_negociacao_extra
FROM v_oportunidade_economica_hoje
WHERE empresa = 'OBEN'
ORDER BY economia_bruta_estimada DESC NULLS LAST;
```

`cenario` ∈ {`promo_flat`, `promo_volume`, `promo_e_aumento`, `aumento_apenas`}. Use pra montar
a fila e checar a **restrição de portfólio** (somar todas e ver se cabem no caixa).

---

## Query 4 — Aumento vigente afetando o SKU (Caso B)

```sql
-- 🟣 Lovable → SQL Editor → cola → Run
SELECT sku_codigo_omie, familia, categoria_fornecedor,
       data_vigencia_efetiva, aumento_perc
FROM v_sku_aumento_vigente
WHERE sku_codigo_omie = 12345;
```

`data_vigencia_efetiva` = quando o preço novo entra. O limite pra antecipar é comprar antes
dela. `aumento_perc` = X do break-even.

---

## Query 5 — Avaliação de promoção: quanto comprar a mais (Caso C)
A view já faz a conta "quanto comprar na promo" ponderando custo de capital.

```sql
-- 🟣 Lovable → SQL Editor → cola → Run
SELECT sku_codigo_omie, sku_descricao,
       qtde_base, qtde_com_desconto, qtde_extra, dias_extra_estoque,
       economia_liquida_valor, economia_liquida_perc, custo_capital_periodo_perc
FROM v_promocao_avaliacao_hoje
WHERE sku_codigo_omie = 12345;
```

`qtde_extra` e `dias_extra_estoque` = o quanto a mais e por quantos dias. `economia_liquida_*`
já desconta o custo de capital do período — confirme contra o seu cálculo (passo 3 do SKILL).
**Atenção**: a view costuma usar o desconto **bruto** da promo; se o fornecedor já te dá desconto
à vista no preço normal, o ganho real é **menor** (recalcule em custo líquido — regra de ouro #2).

---

## Query 6 — Caixa hoje (saldo bancário real)

```sql
-- 🟣 Lovable → SQL Editor → cola → Run
SELECT COALESCE(SUM(saldo_atual), 0) AS caixa_hoje
FROM fin_contas_correntes
WHERE company = 'oben' AND ativo;
```

---

## Query 7 — Outliers de demanda (sanidade dos dados)
Roda quando a recomendação depende muito da demanda (antecipação grande, classe Z).

```sql
-- 🟣 Lovable → SQL Editor → cola → Run
SELECT sku_codigo_omie, tipo, severidade, status, data_evento,
       valor_esperado, valor_observado, desvios_padrao
FROM eventos_outlier
WHERE empresa = 'OBEN'
  AND sku_codigo_omie = '12345'   -- string aqui!
  AND status <> 'descartado'
ORDER BY data_evento DESC
LIMIT 10;
```

Se houver pico/anomalia recente não tratada, a demanda média pode estar inflada/deflada →
**confiança baixa**, recomendação mais conservadora.

---

## Query 8 (opcional) — Condição de pagamento já usada com o fornecedor
Pra saber se parcelamento é uma alavanca real (alguns fornecedores aceitam prazo).

```sql
-- 🟣 Lovable → SQL Editor → cola → Run
SELECT fornecedor_nome, condicao_pagamento_descricao, num_parcelas, dias_parcelas,
       COUNT(*) AS qtd_pedidos, MAX(data_ciclo) AS ultimo
FROM pedido_compra_sugerido
WHERE empresa = 'OBEN'
  AND fornecedor_nome ILIKE '%PARTE_DO_NOME%'
  AND condicao_pagamento_descricao IS NOT NULL
GROUP BY 1,2,3,4
ORDER BY ultimo DESC;
```

Se o fornecedor já vendeu parcelado antes, "negociar prazo / parcelar" é uma recomendação
viável quando o caixa apertar — e não chute, mostre o histórico.
