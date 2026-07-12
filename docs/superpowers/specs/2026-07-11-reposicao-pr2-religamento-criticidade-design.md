# PR-2 — religamento da demanda de insumos (money-path)

> **Status:** design (brainstorming). **Money-path PLENO** — este PR muda comportamento de compra (o PR-1 era inerte). NÃO implementar sem: prova PG17 com falsificação + Codex challenge do SQL + pré-flight `pg_get_viewdef` da PROD + **prova de performance sob `authenticated`** + verificação read-only pós-apply.
> **Pré-requisito de APPLY:** o PR-1 (`db/reposicao-demanda-insumos-bom.sql`, PR #1291 mergeado) precisa estar **aplicado no banco** antes deste. PG17 aplica ambos localmente.
> **Decisão de rumo (2026-07-11):** o **V3 automático foi ABANDONADO** após o Codex challenge do design achar bloqueadores fundamentais (§7). A criticidade dos poucos insumos caros passa a ser **curadoria humana** via `minimo_forcado_manual` (já existente). Isso enxuga o PR-2 ao **religamento** e elimina 8 dos 14 furos do Codex por construção (a classificação não muda).

## 1. Problema

O PR-1 criou `v_sku_demanda_efetiva` (venda ⊕ consumo explodido) mas não religou nada. Este PR faz as 4 views estatísticas lerem a nova fonte → o insumo ganha demanda → o motor calcula `ponto_pedido`/`estoque_maximo` → **aparece no cockpit** quando o estoque cai.

## 2. Por que NÃO o V3 automático (registro da decisão)

O objetivo do V3 era dar ao insumo caro um estoque de segurança à altura (a classe ABC por venda joga insumo em C). O Codex challenge (§7) mostrou que a "curva de Pareto particionada" tem bloqueadores fundamentais (Pareto quebra em população de 9 itens; `valor_consumo` mistura venda+consumo; SKU-ambos insolúvel com uma classe; C é a MENOS protetiva, não a mais; joins duplicam o SKU 112×) **e** uma limitação de fundo: a venda-explodida **suaviza** o consumo real (produção em lote → série sintética 1/dia → segurança subdimensionada). Construir isso robusto é caro e o resultado seguiria frágil.

**Fato que decide:** os insumos caros são **pouquíssimos** — as 4 soluções XT.1803 (cmc R$200–392/L) + a BASE dominam. Curá-los à mão (`minimo_forcado_manual`) é trivial e robusto. Alinhado com a lição da auto-aprovação N3: *no money-path, a ferramenta sugere; a decisão fina é humana.*

## 3. Decisão

1. **Religar** as 4 views estatísticas: `FROM v_venda_items_history_efetivo` → `FROM v_sku_demanda_efetiva`.
2. **Corrigir o furo #10** (devolução distorce o consumo) na `v_sku_demanda_efetiva`: no ramo de consumo, só explodir **saída de venda** (`quantidade > 0 AND cfop LIKE '5%'/'6%'`) — entrada/devolução não consome insumo.
3. **`v_sku_classificacao_abc_xyz`, `v_sku_parametros_sugeridos`, a função de aplicação e o motor: INTOCADOS.** O insumo cai em classe C (aceito) — o `minimo_forcado_manual` protege os caros.
4. **Criticidade = curadoria** (operacional, **sem código novo**). O motor honra `minimo_forcado_manual` (piso de **quantidade** do pedido) — útil, mas note: ele **não** move o ponto de pedido (o *timing*), que segue classe C. O que realmente protege é a **visibilidade + decisão humana**: o religamento faz o insumo caro **aparecer** no cockpit, o founder o vê e compra antes se preciso (o que ele já faz hoje às cegas — agora com o item na tela). O `minimo_forcado_manual` é a ferramenta para garantir volume nos poucos caros.

## 4. Arquitetura

```
[PR-1] v_sku_demanda_efetiva  (venda ⊕ consumo explodido)  ← fix #10: consumo só de SAÍDA de venda (cfop 5/6, qtde>0)
   │
   ▼ RELIGAMENTO (mecânico — disciplina da consolidação)
4 views estatísticas trocam FROM → v_sku_demanda_efetiva
   │   (v_sku_demanda_estatisticas · _sigma_demanda · _demanda_rajada · _candidatos_primeira_compra)
   ▼ (herdam SEM tocar — nenhuma lógica nova)
v_sku_classificacao_abc_xyz → v_sku_parametros_sugeridos → função de aplicação → sku_parametros
   ▼
gerar_pedidos_sugeridos_ciclo [intocado] → 🎯 COCKPIT (insumo aparece com estoque ≤ ponto)
   +
[operacional] founder aplica minimo_forcado_manual nos ~5 insumos caros
```

### 4.1 Religamento (4 views)
`CREATE OR REPLACE VIEW` de cada uma, trocando **só** o `FROM` (alias remapeado; zero mudança de agregação/GROUP BY/colunas — padrão de `db/reposicao-consolidacao-demanda.sql`). Pré-flight `pg_get_viewdef` da PROD + **ordem exata de colunas** + **`security_invoker=true`** preservado (o PR-1/§4 do database.md exige — não regredir ao recriar).

### 4.2 Fix #10 — devolução (na `v_sku_demanda_efetiva`)
No ramo de consumo (2ª metade do UNION ALL), o guard é por **CFOP de saída de venda**: `AND v.quantidade > 0 AND (v.cfop LIKE '5%' OR v.cfop LIKE '6%')`.

**Motivo (provado contra a prod, 2026-07-11 — corrige a premissa do design original).** O dado real grava `quantidade` sempre ≥0 (é o `qCom` da NF-e; writer `omie-sync-vendas-items`); uma devolução **não** é quantidade negativa — é sinalizada pelo `cfop` (entrada `1xxx/2xxx`). Medido em OBEN: 0 quantidades negativas e 0 devoluções de venda na tabela. As devoluções de venda de mercadoria de terceiros já são filtradas no sync (`CFOPS_NAO_VENDA` exclui `1202/2202`), mas uma devolução de **produção própria** (CFOP `1201/2201`, fora do filtro do sync) entraria com quantidade **positiva** e, sem o guard de CFOP, o ramo de consumo a explodiria como consumo **adicional** → demanda do insumo inflada → compra em excesso. Semanticamente só a **saída de venda** (`5xxx/6xxx`) consome o insumo; qualquer entrada/devolução, não. `quantidade > 0` fica como complemento (zero/negativo latente). A venda direta (1ª metade) mantém as devoluções (demanda de venda legítima). 0 casos hoje; guard latente **e correto por construção**. Isto edita `db/reposicao-demanda-insumos-bom.sql` (já aplicado em prod no PR-1 → vira `CREATE OR REPLACE` no apply do PR-2).

## 5. Money-path — invariantes, correções e limitações declaradas

- **Não-regressão TRIVIAL:** `v_sku_classificacao_abc_xyz` e o cálculo **não mudam** → produto vendido mantém classe idêntica por construção (não há partição, não há mistura). Ainda assim, provar com `EXCEPT ALL` old×new da classificação (barato, fecha a dúvida).
- **Fix #10** (devolução) — provado com fixture de devolução (CFOP `1xxx`, quantidade **positiva**) que NÃO deve explodir consumo do insumo.
- **Furos do V3 ELIMINADOS** por não construí-lo: #1 (Pareto pequeno), #2 (NULL 3VL), #3 (mistura venda/consumo no valor), #5 (SKU-ambos), #6 (C invertido), #7 (cardinalidade do join de malha/cmc), #8 (cross-company), #12 (cmc instável). Nenhum existe sem a partição.
- **Limitações declaradas (não bloqueiam; o founder está no loop + curadoria):**
  - **#9 proxy temporal:** a demanda explodida suaviza o consumo real (produção em lote). Subdimensiona a variabilidade → estoque de segurança pode ficar abaixo do pico real. Mitigação: curadoria dos caros + PR-3 observa os primeiros ciclos. Fonte robusta (apontamento de consumo real) seria a Abordagem C, fora de escopo.
  - **#11 NF nula → não gradua:** herdado (num_ordens conta NF). 0 vendas de pais sem NF hoje. Query de vigilância (spec PR-1 §12).
  - **#13 unidade do SKU-ambos:** se um insumo também vende numa embalagem de unidade diferente, `demanda_total_90d` soma unidades distintas. Afeta só os 5 SKU-ambos; a curadoria os cobre. Provar a unidade dos 5 no plano; se divergir, tratar caso a caso.
- **Performance (#14):** as 4 views + `v_sku_parametros_sugeridos` (que lê 3 delas) + candidatos passam a expandir `v_sku_demanda_efetiva` (UNION ALL da história + JOIN da explosão) sobre 90/180d — potencialmente 4 scans numa requisição. **Prova obrigatória:** `EXPLAIN (ANALYZE, BUFFERS)` sob `SET ROLE authenticated` + GUC do JWT + `statement_timeout='8s'`, exigindo folga (p95 < 4s). Se estourar, **materializar antes do fan-out** (fato privado no grão `empresa×sku×data×NF`, com `qtde_direta`/`qtde_consumo`/`valor` separados) — decisão do plano guiada pelo EXPLAIN, não deste design.
- `security_invoker=true` em toda view recriada. Não tocar `supabase/migrations/`.

## 6. Provas (obrigatórias)

**PG17 (`prove-sql-money-path`), aplicando PR-1 + PR-2, com falsificação:**
- Religamento: insumo (BASE) ganha `demanda_total_90d`/`demanda_media_diaria` > 0; venda direta segue contando.
- **Graduação → cockpit (o teste-fim):** com estoque do BASE abaixo do ponto, `gerar_pedidos_sugeridos_ciclo('OBEN')` passa a incluí-lo; acima, não.
- **Fix #10 (falsificar):** devolução do pai (CFOP `1201`, quantidade **positiva**) NÃO gera consumo do insumo; remover o guard de CFOP → a devolução vaza como consumo → exigir vermelho.
- **Não-regressão:** `v_sku_classificacao_abc_xyz` retorna idêntica antes/depois (só o religamento muda a fonte; a lógica de classe não). `EXCEPT ALL` old×new sobre o baseline de todos os SKUs.
- `minimo_forcado_manual` num insumo caro força a quantidade-piso no pedido (o instrumento da curadoria funciona).
- Ordem de colunas + `security_invoker=true` preservados nas 4 views recriadas.

**Codex challenge (xhigh)** sobre o SQL. **Pré-flight** `pg_get_viewdef`. **Prova de performance** (§5). **Verificação pós-apply (psql-ro):** BASE com `ponto_pedido` preenchido; produtos com classe idêntica; TINGIMIX aparece quando estoque ≤ ponto; EXPLAIN dentro do timeout.

## 7. Codex challenge do design (xhigh, 2026-07-11) — 14 furos e status

Veredito original: *"não aplicar o V3 como está — bloqueadores lógicos independentes de performance."* Levou ao abandono do V3.

| # | Furo | Status |
|---|---|---|
| 1 | Pareto quebra em curva pequena (9 itens) | ✅ eliminado (sem curva de insumos) |
| 2 | cmc ausente → `eh_insumo=NULL` cria 3ª partição | ✅ eliminado |
| 3 | `valor_consumo` mistura venda + consumo | ✅ eliminado |
| 4 | não-regressão não é "por construção" | ✅ agora É trivial (classificação intocada) |
| 5 | SKU-ambos insolúvel com uma classe | ✅ eliminado (curadoria) |
| 6 | "C conservadora" invertido; gate não salva | ✅ eliminado (sem depender de classe do insumo) |
| 7 | cardinalidade: join de malha duplica SKU 112× | ✅ eliminado (sem join de malha na classificação) |
| 8 | malha sem `empresa` → cross-company | ✅ eliminado |
| 12 | eleição de cmc instável (empate/stale/NaN) | ✅ eliminado (sem cmc na classificação) |
| 10 | devolução distorce consumo | ✅ **corrigido** (guard CFOP de saída, §4.2; premissa "negativa" refutada em prod) |
| 9 | explosão suaviza demanda temporal | 🔍 **declarado** (limitação do proxy; curadoria + PR-3) |
| 11 | NF nula → não gradua | 🔍 **vigiado** (0 hoje) |
| 13 | unidade do SKU-ambos | 🔍 **provado no plano** p/ os 5; caso a caso |
| 14 | fan-out 4× → timeout | ⚠️ **prova obrigatória** de performance (§5); materializar se preciso |

## 8. Faseamento

- **PR-2 (este):** religamento + fix #10. Money-path pleno.
- **Curadoria (operacional, contínua):** founder aplica `minimo_forcado_manual` nos insumos caros conforme aparecem.
- **PR-3:** observar os primeiros ciclos; se o proxy temporal (#9) causar ruptura/excesso, avaliar apontamento de consumo real (Abordagem C) ou um dimensionamento dedicado. Decisão com dados reais.

## 9. Critério de sucesso

Aplicados PR-1 + PR-2, o `BASE PARA TINGIMIX` e os demais insumos elegíveis **aparecem no cockpit quando o estoque cai ao ponto de pedido**, sem pedido manual às cegas — e **nenhum produto vendido muda de classe**. Os insumos caros ficam protegidos por `minimo_forcado_manual` (curadoria), até termos dados para decidir se um dimensionamento automático se justifica.

## 10. Fora de escopo

V3 automático (abandonado); materialização (só se o EXPLAIN exigir); apontamento de consumo real (Abordagem C); conversão de unidade (quarentena do PR-1); auto-aprovação N3.
