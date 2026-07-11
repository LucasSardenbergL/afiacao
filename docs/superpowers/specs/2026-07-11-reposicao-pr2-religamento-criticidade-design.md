# PR-2 — religamento da demanda + criticidade V3 (money-path)

> **Status:** design (brainstorming). **Money-path PLENO** — este é o PR que muda comportamento de compra (o PR-1 era inerte). NÃO implementar sem: prova PG17 com falsificação + Codex challenge (xhigh) sobre o SQL + pré-flight `pg_get_viewdef`/`pg_get_functiondef` da PROD + verificação read-only pós-apply.
> **Pré-requisito de APPLY:** o PR-1 (`db/reposicao-demanda-insumos-bom.sql`, PR #1291 mergeado) precisa estar **aplicado no banco** antes deste — o religamento aponta para `v_sku_demanda_efetiva`, que o PR-1 cria. O PG17 aplica ambos localmente; só o apply em prod é ordenado.
> **Continuação de:** `docs/superpowers/specs/2026-07-09-reposicao-demanda-insumos-producao-bom-design.md` (§5.1 decidiu o V3; §8 previu este PR).

## 1. Problema

O PR-1 criou `v_sku_demanda_efetiva` (venda ⊕ consumo explodido) mas **não religou nada** — as 4 views estatísticas ainda leem `v_venda_items_history_efetivo`. Logo o insumo continua com demanda ≈ 0 e invisível. Este PR religa.

Mas religar sozinho **não basta**: a **classe ABC** (`v_sku_classificacao_abc_xyz`) é uma **curva de Pareto por valor de venda** (acumulado ≤80%→A, ≤95%→B, resto→C). Insumo não vende → `valor_total_90d ≈ 0` → **classe C** → `z_classe_c` baixo → estoque de segurança raso → **risco de ruptura de produção** num insumo caro (soluções XT.1803: R$200–392/L, componentes de ~110 tingidores). É o furo #4 do Codex, que o **V3** (decidido pelo founder no PR-1) resolve.

## 2. Achados em produção (2026-07-11, `psql-ro`)

- `v_sku_classificacao_abc_xyz`: Pareto por `valor_total_90d` de `v_sku_demanda_estatisticas`; corta 80%/95%. XYZ por `coef_variacao_ordem` (num_ordens<2 → Z).
- **`v_sku_parametros_sugeridos` NÃO recalcula a classe** — lê `c.classe_abc_proposta` e a usa no z-score (`CASE classe WHEN 'A' THEN cfg.z_classe_a …`). ⇒ **o V3 mexe só na classificação; a sugeridos herda.**
- `v_sku_demanda_estatisticas` expõe `demanda_total_90d` (quantidade consumida) → **valor de consumo = `demanda_total_90d × cmc`**.
- Curva ABC OBEN: 322 SKUs (68 A / 90 B / 164 C).
- Dos 23 insumos elegíveis: **18 sem venda** (classe C injusta hoje) + **5 com venda direta** (classe já justa).

## 3. Decisão

**Curva de Pareto PARTICIONADA** (escolha do founder), com **um único ponto de injeção** (`v_sku_classificacao_abc_xyz`):
- **produto vendido** → curva por `valor_total_90d` (**intocada** → não-regressão por construção);
- **insumo** (componente na malha, consome ≥ vende) → curva própria por `valor_consumo` (`demanda_total_90d × cmc`).

Rejeitadas: curva única (muda a classe dos produtos — viola não-regressão) e faixa fixa de R$ (cortes calibrados à mão em vez de auto-ajuste).

## 4. Arquitetura

```
[PR-1] v_sku_demanda_efetiva  (venda ⊕ consumo explodido)
   │
   ▼ PARTE 1 — RELIGAMENTO (mecânico, disciplina da consolidação)
4 views estatísticas trocam FROM v_venda_items_history_efetivo → v_sku_demanda_efetiva
   │   (v_sku_demanda_estatisticas · _sigma_demanda · _demanda_rajada · _candidatos_primeira_compra)
   │   → insumo passa a ter demanda_total_90d / demanda_media_diaria / sigma
   ▼ PARTE 2 — CRITICIDADE V3 (única lógica nova)
v_sku_classificacao_abc_xyz  — Pareto particionado por (empresa, eh_insumo):
   · eh_insumo=false → valor da curva = valor_total_90d  (INTOCADA)
   · eh_insumo=true  → valor da curva = demanda_total_90d × cmc  (nova)
   ▼ herda, SEM tocar
v_sku_parametros_sugeridos → z-score/ponto_pedido/estoque_maximo por classe
   ▼
função de aplicação [intocada] → sku_parametros → gerar_pedidos_sugeridos_ciclo [intocado] → 🎯 COCKPIT
```

### 4.1 Religamento (4 views)
`CREATE OR REPLACE VIEW` de cada uma trocando **só** o `FROM` (alias remapeado; zero mudança de agregação/GROUP BY/colunas — padrão de `db/reposicao-consolidacao-demanda.sql`). Pré-flight `pg_get_viewdef` da PROD + preservar **ordem exata de colunas**.

### 4.2 V3 em `v_sku_classificacao_abc_xyz` (a única lógica nova)
Recriar a view adicionando, antes do window de Pareto:
- **`eh_insumo`**: o SKU é componente em `v_pcp_malha_oben` (`comp_oben`) **e** `valor_consumo ≥ COALESCE(valor_total_90d,0)`.
- **`valor_consumo`** = `demanda_total_90d × cmc` (cmc de `inventory_position`, account-aware `['vendas','oben']`, `cmc>0`, mais recente).
- **`valor_curva`** = `CASE WHEN eh_insumo THEN valor_consumo ELSE COALESCE(valor_total_90d,0) END`.
- Window particionado: `sum(valor_curva) OVER (PARTITION BY empresa, eh_insumo ORDER BY valor_curva DESC)` / `sum(valor_curva) OVER (PARTITION BY empresa, eh_insumo)`. Cortes 80/95% **dentro de cada curva**.
- **Colunas:** preservar a ordem existente (empresa, sku_codigo_omie, sku_descricao, num_ordens, valor_total_90d, demanda_media_diaria, qtde_media_por_ordem, qtde_desvio_por_ordem, coef_variacao_ordem, classe_abc_proposta, classe_xyz_proposta, classe_consolidada_proposta) e **acrescentar** `eh_insumo`/`valor_curva` só **no fim** (senão `cannot change name of view column`).
- **`security_invoker=true` + `REVOKE anon,PUBLIC` + `GRANT authenticated`** — passa a ler `inventory_position` (custo, sensível) e `v_pcp_malha_oben`.

## 5. Decisões de design

1. **Critério de "insumo"** = componente na malha **E** `valor_consumo ≥ valor_venda`. Põe os 18 puros na curva de insumos e mantém os 5 que vendem mais do que consomem na curva de produtos — sem buraco para venda esporádica.
2. **cmc ausente (15 dos 23):** sem custo não há `valor_consumo` → o insumo **não entra na curva de insumos**; fica **classe C conservadora**, e o gate de disparo `SKU sem custo` (existente) impede pedido R$0. Ganhou cmc → migra. Nunca fabricar valor.
3. **Ligar como sugestão visível** (não auto-aprovação; N3 dormente). Founder revê os primeiros ciclos (PR-3).
4. **Só `v_sku_classificacao_abc_xyz` muda de lógica.** `v_sku_parametros_sugeridos`, a função de aplicação e o motor ficam **intocados** (herança).

## 6. Money-path — invariantes e riscos

- **Não-regressão (o invariante central):** produto vendido mantém `classe_abc` **idêntica** antes/depois. Fortemente favorecida pela construção (os 18 insumos-puros que saem da curva de produtos têm `valor_venda≈0` → não movem os cortes), **mas não estrita**: um SKU-ambos que migre por `valor_consumo ≥ valor_venda` tinha `valor_venda>0`, então removê-lo altera marginalmente o `total_geral` dos produtos. Por isso o **assert de catálogo old×new é a garantia real** (não a construção). Se ele pegar regressão de um produto, o fallback é endurecer o critério de insumo para `valor_venda = 0` (não-regressão estrita, aceitando que um SKU-ambos consumidor fique na curva de produtos) — decisão do plano guiada pelo assert.
- `ausente≠zero`: cmc ausente → fora da curva de insumos + classe C, nunca `valor_consumo=0` fabricado.
- `security_invoker` em TODA view recriada (o PR-1 fechou isso; não reabrir aqui ao recriar a classificação).
- **Performance (Codex #7 do design):** o religamento faz as 4 views + a classificação + `v_sku_parametros_sugeridos` lerem `v_sku_demanda_efetiva` (UNION ALL da história + JOIN da explosão) sobre 90/180d. **Risco de estourar `statement_timeout`.** `EXPLAIN (ANALYZE, BUFFERS)` obrigatório antes do apply; se estourar, materializar a explosão (padrão do badge, `database.md` §4) — decisão do plano, não deste design.
- `v_sku_demanda_efetiva` e o PR-1 **intocados**.

## 7. Provas (obrigatórias)

**PG17 (`prove-sql-money-path`), aplicando PR-1 + PR-2, com falsificação:**
- Religamento: insumo (BASE) ganha `demanda_total_90d`/`demanda_media_diaria` > 0; venda direta continua contando.
- **Graduação → cockpit:** com estoque do BASE abaixo do ponto, `gerar_pedidos_sugeridos_ciclo('OBEN')` passa a incluí-lo (o teste-fim que fecha o objetivo do founder).
- **Criticidade:** insumo caro (solução XT.1803) sobe de classe C para A/B na curva de insumos; z-score/estoque_seguranca sobe vs baseline sem-V3.
- **NÃO-REGRESSÃO (falsificar):** todo produto **não-insumo** mantém `classe_abc_proposta` idêntica ao baseline pré-V3 (sabotar: pôr um produto vendido na curva de insumos → exigir vermelho).
- cmc ausente → insumo fica classe C, não entra na curva de insumos, e o disparo o barra (`SKU sem custo`).
- Critério `valor_consumo ≥ valor_venda`: SKU-ambos com venda>consumo fica na curva de produtos.
- Ordem de colunas de todas as views recriadas preservada; `security_invoker=true` nas recriadas.

**Codex challenge (xhigh)** sobre o SQL. **Pré-flight** `pg_get_viewdef` das 5 views + `pg_get_functiondef`. **Verificação pós-apply (psql-ro):** BASE com ponto_pedido preenchido e classe por consumo; produtos com classe idêntica; `EXPLAIN` dentro do timeout; TINGIMIX aparece quando estoque ≤ ponto.

## 8. Faseamento

- **PR-2 (este):** religamento + V3. Money-path pleno.
- **PR-3:** verificação/calibração em prod — acompanhar os primeiros ciclos, ajustar z/cobertura se super/subdimensionar; documentar em `docs/agent/reposicao.md` + `docs/historico/`.

## 9. Critério de sucesso

Aplicados PR-1 + PR-2, o `BASE PARA TINGIMIX` e os demais insumos elegíveis **aparecem no cockpit quando o estoque cai ao ponto de pedido**, com estoque de segurança dimensionado pela **criticidade real** (consumo × custo) — insumo caro protegido, sem pedido manual — e **nenhum produto vendido muda de classe**.

## 10. Fora de escopo

Materialização (só se o `EXPLAIN` exigir); conversão de unidade (33 em quarentena); multinível; auto-aprovação N3; calibração fina (PR-3).
