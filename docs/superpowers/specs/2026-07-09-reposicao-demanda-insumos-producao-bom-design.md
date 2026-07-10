# Reposição — demanda de insumos de produção via explosão de BOM (money-path)

> **Status:** design (brainstorming). **Money-path** (dirige compra). NÃO implementar sem: prova PG17 com falsificação (`prove-sql-money-path`) + Codex challenge (xhigh) + pré-flight `pg_get_viewdef`/`pg_get_functiondef` da PROD + verificação read-only pós-apply via `psql-ro`.
> **Origem:** sessão 2026-07-09 — o founder reportou que o `BASE PARA TINGIMIX TEH.3505.00BB` nunca aparece no cockpit quando precisa ser reposto, e pediu resolver para **todos** os insumos análogos (base, soluções XT.1803, etc.).
> **Ref. de padrão:** `db/reposicao-consolidacao-demanda.sql` + `docs/superpowers/specs/2026-07-05-reposicao-consolidacao-demanda-substituicao-design.md` (mesma técnica de indireção na view de histórico, N→1; aqui é o espelho 1→N).

## 1. Problema

O motor de reposição (`gerar_pedidos_sugeridos_ciclo`) exige `sku_parametros.ponto_pedido IS NOT NULL AND estoque_maximo IS NOT NULL` (linhas 269-270 de `db/embalagem-motor-rpc.sql`). Esses parâmetros são derivados da **demanda**, e a demanda é medida **exclusivamente por saída em nota fiscal** (as 4 views-fonte partem de `venda_items_history`).

**Insumo de produção não sai em NF** — ele é consumido internamente para fabricar outro produto (o `BASE PARA TINGIMIX` vira dezenas de tingidores; as `SOLUCAO XT.1803` idem). Logo:

- demanda medida ≈ 0 → `v_sku_parametros_sugeridos.status_sugestao = AGUARDANDO_SEGUNDA_ORDEM` → `ponto_pedido`/`estoque_maximo` nunca calculados → **NULL** → o motor exclui o item → **invisível no cockpit**.
- O founder já compensava com **pedido manual**, que não escala e é o sintoma que originou este design.

## 2. Achados em produção (evidência read-only, 2026-07-09)

- O item money-path: `BASE PARA TINGIMIX TEH.3505.00BB` — OBEN `codigo=PRD00057` / omie `8689961993`; ativo, habilitado, com de-para Sayerlack (`TEH.3505.00BB`), grupo, LT (9,7d), CMC (R$23,60), estoque confirmado. **Passa em todos os gates do motor menos `ponto_pedido`/`estoque_maximo` (NULL).**
- Causa dos NULL: `num_ordens=1` (só 1 saída em NF em ~180d) → `AGUARDANDO_SEGUNDA_ORDEM`.
- **A ficha técnica já está no banco:** a `omie-malha-sync` (PCP Fase 1A) espelha a malha do Omie. `vw_pcp_malha_componentes` mostra o `BASE` como componente de **112 tingidores** (~0,9 L/unidade); as soluções `XT.1803` são componentes de ~110 tingidores cada.
- Os tingidores-pai **são vendidos** (têm demanda real de venda na OBEN).
- **Demanda explodida do BASE = 0,58 L/dia** (Σ demanda_venda dos 112 pais × qtde na ficha) vs **0,15 L/dia** medido por venda direta — **~4×** (o consumo real que a venda direta não enxerga).
- **Unidade fecha:** base estocada/medida em **L**; ficha em **L de componente por unidade de pai**; tingidor vendido em **UN** (qtde 1). `consumo_base(L) = qtde_tingidor(UN) × qtde_ficha(L/UN)`. Sem conversão extra.
- **Mapeamento de conta:** a ficha usa código **Colacor**; a reposição é **OBEN**. O `omie_products.codigo` (PRD*) é **compartilhado entre contas** → mapeia Colacor↔OBEN 1:1.
- **Universo:** **58 insumos de produção ativos na OBEN** são componentes na malha; **48 estão invisíveis hoje** (`ponto_pedido` NULL) — o alvo. Componentes de **lixa** mapeiam para OBEN mas estão inativos lá (produção Colacor) → saem naturalmente do escopo.
- **Confiabilidade da ficha:** confirmada pelo founder ("é confiável") — habilita usar a malha como fonte de demanda para dirigir compra.
- **BASE e soluções XT.1803 são "folhas"** (sem componentes próprios) → explosão de **1 nível** cobre o caso.

## 3. Decisão

**Abordagem A — explodir a ficha técnica na demanda**, reusando o pipeline existente. Escolhida pelo founder sobre (B) parâmetro manual e (C) sincronizar consumo real do Omie. Motivo: usa dados que já existem (ficha + demanda dos pais), é automática, auto-atualiza com o giro, e não toca o motor — só adiciona uma fonte de demanda. Override manual (`minimo_forcado_manual`, já existente) permanece como rede.

## 4. Arquitetura

Fluxo (⊕ = nova fonte somada; nada no motor muda de forma):

```
venda_items_history (vendas reais OBEN)
   ├─ [INALTERADA] v_venda_items_history_efetivo   ← preço/receita real vive AQUI
   ▼
[NOVA] v_pcp_malha_oben          ficha Colacor→OBEN (via codigo), 1 linha/(pai,insumo), qtde consolidada
   ▼
[NOVA] v_sku_demanda_efetiva  =  vendas diretas ⊕ consumo explodido (qtde_pai×qtde_ficha, valor NULL)
   ▼
4 views estatísticas (só trocam FROM → v_sku_demanda_efetiva)
   ▼
v_sku_parametros_sugeridos → estoque_seguranca / ponto_pedido / estoque_maximo / estoque_minimo
   ▼
função de aplicação de parâmetros → grava sku_parametros
   ▼
gerar_pedidos_sugeridos_ciclo (vê ponto_pedido/estoque_maximo) → 🎯 COCKPIT
```

### 4.1 `v_pcp_malha_oben` (nova) — tradução de conta isolada
Único ponto que traduz a ficha (código Colacor) para o mundo da reposição (OBEN), pelo `codigo` PRD. Responsabilidades:
- pai Colacor → pai OBEN e componente Colacor → componente OBEN (via `omie_products.codigo`, `account`-explícito nas duas pontas).
- **consolidar** múltiplas linhas do mesmo par (pai, componente) em uma qtde canônica (dedup — a malha pode ter >1 linha por par).
- filtrar componente **ativo na OBEN**.
- ⚠️ **armadilha:** JOIN account-blind duplica silenciosamente (sem UNIQUE no item — `docs/agent/database.md`). O mapeamento fica trancado nesta view, com `account` explícito e teste de cardinalidade 1:1.

### 4.2 `v_sku_demanda_efetiva` (nova) — demanda = venda ⊕ consumo
Mesmo **shape de colunas** de `v_venda_items_history_efetivo` (as 4 views estatísticas esperam esse formato). Corpo:
- `SELECT * FROM v_venda_items_history_efetivo` (vendas diretas — preço real preservado);
- `UNION ALL` consumo explodido: para cada linha de venda cujo SKU é pai em `v_pcp_malha_oben`, emitir linha com `sku_codigo_omie = insumo`, `quantidade = qtde_venda × qtde_ficha`, `data_emissao = data da venda`, **`valor_unitario = NULL`, `valor_total = NULL`**.
- **Invariante de preço (money-path `ausente≠zero`):** `SUM(valor_total)` e `AVG(valor_unitario)` ignoram NULL → o insumo não fabrica receita nem contamina preço médio; seu custo de pedido vem do **CMC real** (via o próprio motor, que já lê `inventory_position.cmc`).

### 4.3 Religamento das 4 views estatísticas
`v_sku_demanda_estatisticas`, `v_sku_sigma_demanda`, `v_sku_demanda_rajada`, `v_sku_candidatos_primeira_compra`: trocam **somente** o `FROM v_venda_items_history_efetivo` → `FROM v_sku_demanda_efetiva` (alias remapeado; zero mudança de agregação/GROUP BY/colunas — mesma disciplina do `db/reposicao-consolidacao-demanda.sql`). Cada `CREATE OR REPLACE VIEW` preserva a **ordem exata de colunas da PROD** (senão `cannot change name of view column`) — pré-flight `pg_get_viewdef` obrigatório.

### 4.4 Cálculo/aplicação de parâmetros (existente, sem mudança de forma)
Com demanda > 0, `v_sku_parametros_sugeridos` sai de `AGUARDANDO_SEGUNDA_ORDEM` e calcula os parâmetros; a função de aplicação diária (`aplicar_parametros_automatico_diario` / `preencher_parametros_faltantes_skus` — a confirmar no pré-flight) grava em `sku_parametros`. **A confirmar no plano:** se a graduação exige `status_sugestao='OK'` e quantos pais com demanda bastam para sair do `AGUARDANDO_SEGUNDA_ORDEM` (a demanda somada de 112 pais é muito mais contínua que a de 1 SKU — deve resolver, mas provar).

## 5. Decisões de design (defaults — confirmar na review)

1. **Valor das linhas de consumo = NULL** (não 0). Preserva preço/receita honestos; empurra o insumo para **classe C** (valor de venda ~0) → dimensionamento conservador (alinhado à aversão do founder a superdimensionar). *Alternativa se subdimensionar: valorar o consumo ao custo (`qtde×cmc`) numa coluna dedicada `valor_consumo` para a classificação de importância — fica para Fase 2 se a calibração provar necessário. Codex challenge decide.*
2. **Explosão de 1 nível** (base/soluções são folhas — cobre o caso). Multinível (tingidor que é componente de outro; existem ~7) fica para Fase 2 se necessário; documentar o corte, não silenciar.
3. **Calibração conservadora + revisão humana.** Ligar como **sugestão visível** (não auto-aprovação — o piloto N3 segue dormente por decisão anterior). Founder revê os primeiros ciclos antes de confiar. O motor tem histórico de superdimensionar 2–5×.
4. **Insumo sem ficha na malha** = fora do escopo automático; usa override manual existente. Não é este design.
5. **Escopo = OBEN tintométrico/moveleiro** (componentes ativos na OBEN). Produção de lixa (Colacor) fora — tem seu próprio track de PCP.

## 6. Money-path — invariantes e riscos

- `ausente≠zero`: linhas de consumo com valor NULL; custo do pedido do CMC real; nunca fabricar R$0.
- Mapeamento de conta 1:1 (Colacor↔OBEN via codigo) provado por cardinalidade — duplicação = compra dobrada.
- Dedup da malha (par pai-componente) antes de somar — linha repetida = demanda inflada.
- Sem dupla contagem: insumo que também venda avulso soma venda + consumo (correto).
- Não tocar `supabase/migrations/` (snapshot é DR); tudo `CREATE OR REPLACE` idempotente colado no SQL Editor.
- `v_venda_items_history_efetivo` **inalterada** → não regride a consolidação N→1 nem o preço.

## 7. Provas (obrigatórias antes do apply)

- **PG17 (`prove-sql-money-path`)** com falsificação: (a) explosão gera a demanda esperada para o BASE; (b) valor NULL não contamina `valor_total_90d`/preço médio; (c) mapeamento de conta 1:1 (sabotar → duplicar → exigir vermelho); (d) dedup da malha; (e) o parâmetro calculado destrava o motor (item passa a ser sugerido quando estoque ≤ ponto); (f) SKU sem ficha permanece inalterado.
- **Codex challenge (xhigh)** sobre o spec e depois sobre o SQL — money-path (`scripts/codex-async.sh` em background, conduzido pelo Claude).
- **Pré-flight** `pg_get_viewdef` das 5 views + `pg_get_functiondef` da função de aplicação (prod pode divergir do repo).
- **Verificação pós-apply (psql-ro):** o BASE ganha `ponto_pedido`/`estoque_maximo`; demanda ~0,58/dia; nenhum SKU fora do escopo mudou; contagem de insumos destravados ≈ 48.

## 8. Faseamento

- **PR-1 — fonte de demanda (sem efeito no motor):** `v_pcp_malha_oben` + `v_sku_demanda_efetiva` + provas PG17. Aplicável isolado (as 4 views ainda leem a fonte antiga → zero efeito). Verificar a demanda explodida via psql-ro.
- **PR-2 — religamento:** trocar o FROM das 4 views → `v_sku_demanda_efetiva`; confirmar que `v_sku_parametros_sugeridos` passa a calcular; medir o universo destravado. É o PR que **muda comportamento** (money-path pleno).
- **PR-3 — verificação/calibração em prod:** acompanhar os primeiros ciclos, ajustar cobertura/classe se super/subdimensionar; documentar em `docs/agent/reposicao.md` + `docs/historico/`.

## 9. Critério de sucesso

O `BASE PARA TINGIMIX` (e os ~48 insumos análogos) **aparecem no cockpit quando o estoque do grupo cai ao ponto de pedido**, dimensionados pelo consumo real (explodido), sem pedido manual — e sem superdimensionar a ponto de o founder rejeitar sistematicamente.

## 10. Fora de escopo

Multinível de BOM; insumo sem ficha; produção de lixa (Colacor); auto-aprovação N3 (segue dormente); sincronização de consumo real do Omie (Abordagem C).
