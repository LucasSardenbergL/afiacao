# Custo de produto FABRICADO (estrutura) para a Caça — design

> Follow-up do PR #985. Origem: a proposta era "fazer `syncInventoryFull` gravar `product_costs.cmc` (catálogo inteiro) + remover a escrita de cmc do `computeCosts`" para (1) matar a race de writers e (2) fechar a cobertura de cmc dos produtos vendidos-mas-zerados na Caça (`v_caca_compradores` filtra `cmc>0`).
>
> **O diagnóstico empírico invalidou a premissa.** Este doc registra a investigação, a causa-raiz real e o desenho do caminho escolhido.

## 1. Diagnóstico (provado via `psql-ro`, 2026-06-22)

| Fato | Valor | Fonte |
|---|---|---|
| Cron `sync-inventory-full` no banco | **não existe** (migration `20260606240000` nunca aplicada) | `cron.job` (26 jobs, nenhum `*full*`) |
| `sync_state` `inventory_full` | nenhuma linha | `syncInventoryFull` é **código morto** em prod |
| Produtos vendidos sem `cmc>0` em `product_costs` (Caça) | **582** (Colacor 290, Oben 292) | `order_items ⋈ omie_products ⋈ product_costs` |
| Desses, que têm linha em `inventory_position` | **5** (4 com cmc) | **577 não vêm da rota de estoque `ListarPosEstoque`** |
| `tipo_produto` dos 290 Colacor sem cmc | **04 = 260** (Produto Acabado), 00 = 23, 03 = 6 | fabricados internamente |
| Família dominante | "Cintas Estreitas" = 204/290 (universo: 1396 produtos, só 63 com cmc) | conversão sob medida |
| Família "Jumbo/Rolo de Lixa" (o **insumo**) | 140 produtos, **96 com cmc** | insumo comprado **tem** CMC |
| % receita da Caça **sem cmc** | **Colacor 41,9%** · Oben 0,3% | o buraco é quase só da Colacor |
| Códigos compartilhados Oben/Colacor | 0 | (account-aware seria defensivo, não urgente) |

**3 writers de `product_costs.cmc`** hoje (não 2): `computeCosts` (global), `syncInventory` (vendas/colacor_vendas/servicos, saldo>0), `sync-reprocess` (oben, saldo>0). **Todos via `ListarPosEstoque`** — nenhum cobre os fabricados. A "race" entre eles é real mas de baixo impacto (mesma fonte Omie → no máximo staleness transitória), e fica como higiene **separada e opcional**.

## 2. Causa-raiz

A Colacor é **indústria**: converte rolos jumbo de lixa em **cintas/discos sob medida** (`CINTA XZ677 120X6800MM P80`...). São **produtos acabados (tipo 04)** — o Omie **não tem CMC de compra** para eles (o custo é o jumbo consumido + conversão). O insumo (jumbo) tem CMC; o produto convertido não. **Nenhuma rota de estoque traz esse custo porque ele não existe como CMC.** Logo, mexer em *quem escreve* `product_costs.cmc` é estruturalmente incapaz de resolver — o que faltava era a **fonte** do custo de fabricado.

## 3. Decisão inicial (founder, 2026-06-22) — premissa técnica DERRUBADA em 23/06

Decisão registrada: o custo do fabricado está na **Estrutura de Produto (ficha técnica / malha)** do Omie (componentes + MOD + GGF), e o caminho seria **sincronizar um custo pronto** (1 número por produto), não recompor. Projeto pequeno.

⚠️ **A premissa "1 número pronto" foi invalidada pela doc da API em 2026-06-23** (ver §5.1 e §9). `geral/malha/ConsultarEstrutura` entrega os **ingredientes** (itens componentes + `vMOD` + `vGGF` no objeto `custoProducao`), **não** um custo total calculado. Obter o custo do fabricado **exige recompor** (somar). Isso reabre a decisão — ver §9.

## 4. Design proposto

- **C1 — Sincronizar o custo de estrutura do Omie** → nova coluna dedicada `product_costs.custo_producao` (NUM, nullable, default NULL — **ausente ≠ zero**), alimentada por **1 writer** (a nova ação/edge), com `cost_source`/marcador de proveniência distinto. Por que coluna dedicada e **não** reusar `cmc`: `cmc` é lido pelo `computeCosts`/escada para derivar `cost_final` de TODOS os consumidores (recommend, fin-valor-cockpit, reposição); injetar custo de produção em `cmc` muda o comportamento deles (efeito colateral money-path). Coluna dedicada isola o risco no objetivo (Caça) e mantém 1 writer (sem race).
- **C2 — Consumir na `v_caca_compradores`** → trocar `pc.cmc` por `COALESCE(pc.cmc, pc.custo_producao)` no CTE `itens`/`luc` (mantendo o filtro `>0` e a semântica de `lucro_cobertura`). Fecha os 42% da Colacor com custo **real** (não proxy). ⚠️ `CREATE OR REPLACE VIEW` só acrescenta coluna no fim — preservar a ordem exata das colunas existentes (database.md §5).
- **(Opcional, fase 2)** integrar `custo_producao` à escada (`cost-ladder`/`computeCosts`) como fonte de custo real, para reposição/financeiro também ganharem o custo dos fabricados — amplia o escopo e o blast radius; decidir depois.

## 5. Incógnitas a resolver ANTES de implementar

1. **Endpoint + campo do Omie** ✅ RESOLVIDO (doc, 2026-06-23). Serviço **`geral/malha/`**, métodos `ConsultarEstrutura`/`ListarEstruturas`. A resposta traz a **lista de itens** (componente + quantidade) + o objeto **`custoProducao { vMOD, vGGF }`** — MOD e GGF **separados**, **sem campo de custo total**. O cadastro (`geral/produtos/`) **não** persiste custo de produção; o total é **calculado dinamicamente** (relatório/impressão). 3 fontes convergem (doc do método, art. 1426253, art. 6843431). ⇒ **não há "número pronto"; o custo precisa ser recomposto** (ver §9). Falta a **confirmação empírica** (incógnita #2).
2. **Cobertura real:** quantos dos 260 fabricados Colacor têm estrutura/custo de fato preenchido no Omie? (se a malha não estiver preenchida, não há de onde puxar — risco existencial). Validar com amostra após a 1ª sincronização.
3. **Como sincronizar:** por produto (consulta N≈260, aceitável com bulk/`waitUntil`) vs lote. Nova ação na `omie-analytics-sync` ou edge dedicada + **cron versionado + aplicado** (não repetir o erro do `sync-inventory-full`, que nunca foi aplicado).
4. **Frescor/Sentinela:** `product_costs.updated_at` é vigiado (30h). Definir cadência do cron.

## 6. Money-path / como provar

- **PG17 (`prove-sql-money-path`):** a alteração da `v_caca` (COALESCE) + a coluna nova — semear fabricado com `custo_producao>0` e `cmc=0` e provar que entra no lucro; semear sem custo e provar que degrada honesto (lucro null, cobertura<1, **nunca zero**); falsificar.
- **Codex challenge** (consult na metodologia/spec; adversarial no diff) — money-path.
- **Deploy Lovable:** migration (coluna + view) no SQL Editor; edge (nova ação) via chat; cron aplicado no SQL Editor. Verificar por efeito (contagem de fabricados com `custo_producao` + receita coberta da Caça subindo de 58%→~100% na Colacor).

## 7. Coordenação (multi-sessão)

- Base já integrada com `origin/main` (#985 `computeCosts`→helper `montarUpsertsDeCusto`; #988 `CMC_MARGEM_ATIPICA` na escada).
- **NÃO tocar `sync-reprocess`** — reescrito em `feat/b-edge-fix-sync-reprocess` (+284/-124).
- `omie-analytics-sync/index.ts` é o alvo provável (nova ação) — sem PR aberto colidindo.

## 8. Achado lateral (fora de escopo, money-path)

`computeCosts` lê `inventory_position` **sem paginar** (index.ts ~L1005); com ~2.959 linhas o PostgREST capa em 1.000 silencioso → `invMap` incompleto. Abrir tarefa separada.

## 9. Virada de premissa e opções (2026-06-23)

**Fato (doc API):** `ConsultarEstrutura` retorna `itens[] (nCodProduto, quantidade)` + `custoProducao { vMOD, vGGF }`. **Não** há custo total pronto. Para o custo do fabricado é preciso recompor:

```
custo_producao(P) = Σ_i [ quantidade_i × custo_unitário(componente_i) ] + vMOD + vGGF
```

onde `custo_unitário(componente_i)` é o **CMC do insumo** — que **já temos** em `product_costs` para os jumbos (§1: 96/140 jumbos com cmc). Recomposição factível com os dados existentes.

### Opções
- **A — Recompor na sincronização (recomendado).** Nova ação edge: por fabricado (tipo 04, N≈260), `ConsultarEstrutura` → `Σ(qtd × cmc_insumo) + vMOD + vGGF` → grava `product_costs.custo_producao`. **Degradação honesta:** insumo sem cmc / estrutura vazia ⇒ `custo_producao = NULL` (ausente ≠ zero); a Caça mostra "sem custo", nunca lucro fabricado. Custo real, usa dados que já temos. Contradiz "não recompor" — mas a API não oferece número pronto.
- **B — Mapa de Custo da OP (`produtos/op/`).** Custo realizado da última OP por produto. Mais fiel ao realizado, porém: custo por OP (evento) não por produto; nem todo fabricado tem OP recente; mapear OP→produto e eleger "a OP representativa" é heurística frágil. Maior blast radius.
- **D — Degradar honesto sem custo real.** Não puxar custo; a Caça marca fabricados como "sem custo/baixa confiança". Honesto (não fabrica margem), mas deixa ~42% da receita Colacor sem lucro na Caça — não resolve o problema de produto.

### Recomendação
**A**, com fallback **D** por produto (quando a recomposição não fecha). Não **B** (fragilidade OP→produto). Pendências antes de implementar:
1. **Validação empírica (founder):** rodar `ConsultarEstrutura` em 1–2 fabricados reais (ex.: uma `CINTA XZ677`) e confirmar (a) que vêm `itens` + `vMOD` + `vGGF`; (b) que os `nCodProduto` dos itens batem com jumbos que têm cmc em `product_costs`; (c) cobertura: a estrutura está preenchida nos ~260? (incógnita #2).
2. **Profundidade:** confirmar componentes = insumos comprados (1 nível), sem recursão para outros fabricados.
3. **Decisão do founder:** recompor (A) vs alternativas. → **Founder escolheu A (recompor) em 2026-06-23.**

## 10. Codex challenge (2026-06-23) — design revisado

`/codex` consult (high, 35k tok). Veredito: **v1 gerencial aceitável, DESDE QUE** remover o COALESCE cego e tratar staleness como dado de 1ª classe. Para money-path contábil/histórico, insuficiente sem snapshot temporal + BOM vigente na venda (= fase 2).

### Achados que MUDAM o design (incorporar)
1. **`COALESCE(cmc, custo_producao)` está ERRADO** [bug real que eu não tinha visto]. `product_costs.cmc` é **default 0** → um fabricado com `cmc=0` faz o COALESCE devolver `0` (não-null), o filtro `>0` da view corta, e `custo_producao` **nunca é usado** — mascara exatamente o alvo. Correção: decidir por **semântica do produto**, não por null: `CASE WHEN op.tipo_produto='04' THEN pc.custo_producao ELSE NULLIF(pc.cmc,0) END` (forma exata se prova no PG17; princípio: `cmc=0`≡ausente, fabricado→custo_producao).
2. **Cron em 2 fases (ordem importa)**: recompor fabricado **só depois** do CMC dos comprados estar fresco. (1) sync CMC comprados → (2) validar freshness → (3) recompor fabricados → (4) publicar execução consistente (staging + `run_id`). Recompor com componente velho = margem híbrida silenciosa.
3. **Metadados de proveniência** (degradar honesto COM razão auditável, não só `NULL`): `custo_producao_status` + `custo_producao_error_reason` (`missing_component_cost`/`empty_structure`/`cycle`/`missing_conversion`/`stale_component_cost`) + `computed_at` + `source_costs_max_updated_at` + `estrutura_hash`.
4. **Recursão = grafo**: multiplicar quantidades por nível, detectar ciclo (ciclo→NULL+razão), nunca custo parcial.
5. **Account-aware**: chave `account_id + product_id` em estrutura/CMC/join (database.md §5). Hoje seguro (0 códigos compartilhados Oben/Colacor) mas é vazamento latente.

### Limitações aceitas (consistentes com o `cmc` de hoje — NÃO regridem)
- **Custo atual em venda histórica** + **BOM atual ≠ BOM da venda**: a view já usa `cmc` atual; custo_producao atual é coerente com isso. Rotular "margem estimada com custo atual". Snapshot temporal = fase 2.
- **Base fiscal**: `cmc` (compra, c/ impostos/frete) vs `vMOD/vGGF` (gerencial) → margem **gerencial**, não contábil.

### Para validação empírica (founder — incógnita #2)
- **Perda/rendimento**: a `quantidade` da estrutura é consumo **líquido** (rendimento 100%) ou **bruto** (já com corte/emenda/sucata)? Se líquido, a margem infla.
- **Unidade** do consumo do jumbo vs unidade do CMC (rolo/m²/m/kg).
- **vMOD/vGGF**: por unidade produzida, por lote, ou por OP?
- **Profundidade**: componentes são insumos comprados (1 nível) ou há fabricado aninhado?

## 11. Schema confirmado (psql-ro, 2026-06-23)

- **`product_costs` (9 cols):** id, product_id (UNIQUE), cost_price, updated_at, **cmc (default 0)**, cost_source (default 'UNKNOWN'), cost_confidence (default 0), family_category, cost_final (default 0). **Sem coluna `account`** → é por `product_id`, que já é account-specific (→ omie_products.id, que carrega account). ⇒ `custo_producao` entra aqui por product_id; o account-aware vive na **resolução dos componentes** (nCodProduto da estrutura → omie_products.id da MESMA empresa Colacor → cmc).
- **Infra de proveniência já existe** (`cost_source`/`cost_confidence`) — seguir o padrão com campos dedicados ao novo writer (`custo_producao_source`/`_status`/`_computed_at`), isolados da escada do `cmc` (1 writer).
- **`v_caca_compradores` (viewdef prod == repo, sem drift):** CTE `itens` traz `op.familia` + `pc.cmc` (LEFT JOIN product_costs ON product_id=op.id), **não traz `tipo_produto`**. CTE `luc`: `lucro_com_custo`/`receita_com_custo` com `FILTER (WHERE cmc>0)`; `lucro_cobertura = receita_com_custo/receita`.
- **Custo efetivo (✅ PROVADO no PG17):** `COALESCE(pc.custo_producao, NULLIF(pc.cmc,0))` — corrige o bug do `0`, prioriza o custo recomposto e **não exige** trazer `tipo_produto`. Alternativa mais conservadora (fase 2 se necessário): `CASE WHEN op.tipo_produto='04' THEN pc.custo_producao ELSE NULLIF(pc.cmc,0) END`. Substitui `cmc` pelo custo efetivo nos 3 pontos do CTE `luc` (filtro + lucro + receita_com_custo).

## 12. Status de implementação (2026-06-23)

- ✅ **Parte 1 (migration coluna + view) PROVADA no PG17** — `db/test-caca-custo-producao.sh`, **6 asserts + falsificação, VERDE**:
  - **P1+P2**: fabricado (via `custo_producao`) + comprado (via `cmc`) entram no lucro (=55).
  - **N1+N2+N3**: sem custo → degrada honesto (cobertura 0.35, **nunca** lucro de custo 0).
  - **P3 (sem regressão)**: com `custo_producao` todo NULL = comportamento de HOJE (lucro 15, cob 0.09) → **a migration é deployável isolada sem mexer no resultado atual**.
  - **F1 (falsificação)**: o bug `COALESCE(cmc, custo_producao)` (Codex) derruba o assert (lucro 15) → dente confirmado; **F1b** restaura → 55.
  - Migration: `supabase/migrations/20260623120000_caca_custo_producao.sql` (aditiva, idempotente).
- ✅ **Parte 2 (helper recomposição) PROVADO no vitest** — `src/lib/custo/recomporCustoProducao.ts` (12 testes) + espelho `_shared/recompor-custo-producao.ts` + parity. Σ(qtd×(1+perda%)×cmc)+vMOD+vGGF; perda via `percPerdaProdMalha` (a doc desbloqueou a incógnita da perda). Degradação honesta por status.
- ✅ **Parte 2 (edge) escrita** — ação `syncCustoProducao` + case `sync_custo_producao` (background) em `omie-analytics-sync/index.ts` (typecheck/lint limpos). Endpoint `geral/malha/ConsultarEstrutura` (req `idProduto`; resp `itens[]{idProdMalha,quantProdMalha,percPerdaProdMalha}`+`custoProducao{vMOD,vGGF}`). Auto-validante: loga a 1ª resposta crua + sanity + tally de status.
- ✅ **Codex challenge no código** (63k tok) — **2 P1 corrigidos e re-provados**: (a) `erro_api` deixava `custo_producao` stale → agora persiste `status='erro_api'`+zera; (b) view caía pra `cmc` espúrio em fabricado degradado → agora **tipo/status-aware** (fabricado '04' usa custo_producao só se `status='ok'`). P2 mitigados: sem filtro `ativo`, fabricados fora do mapa de cmc (anti-recursão). Fase 2: recursão de BOM aninhada, sanity por mediana de unit_price real, staging vs writer de CMC.
- ✅ **Cron 3 fases** criado — `20260623130000_caca_custo_producao_cron.sql` (`30 11 * * *` Colacor; idempotente; `timeout_milliseconds=150000`; `x-cron-secret`; account `colacor_vendas`). Audit regenerado (280 migrations).
- ✅ **Verde:** typecheck 0 · lint 0 erro · knip 0 deadcode · vitest 12/12 · PG17 7/7 + falsificação.
- ⏳ **Deploy (founder)** + **validação empírica REAL** na 1ª execução — ver §13.

## 13. Handoff de deploy (3 camadas manuais Lovable — a ORDEM importa)

1. **Migration coluna+view** (SQL Editor): cola `supabase/migrations/20260623120000_caca_custo_producao.sql` → Run. Validação: `\d product_costs` tem `custo_producao*`; o `pg_get_viewdef('v_caca_compradores')` tem o `CASE tipo_produto`. **Deployável já** (inócua até a edge popular — sem regressão, provado P3).
2. **Edge** (chat Lovable, APÓS merge na main): "leia `supabase/functions/omie-analytics-sync/index.ts` do repo e faça deploy **VERBATIM**" (não deixar o Lovable "melhorar"). Carrega a ação `syncCustoProducao` + `_shared/recompor-custo-producao.ts` + case `sync_custo_producao`.
3. **Cron** (SQL Editor, SÓ depois da edge no ar): cola `20260623130000_caca_custo_producao_cron.sql` → Run. Validação: `SELECT jobname,schedule,active FROM cron.job WHERE jobname='caca-custo-producao-colacor-daily'`.
4. **Frontend:** NÃO precisa Publish — a Caça lê a view (campos de saída inalterados); nenhum `.tsx` mudou.
5. **1ª execução = validação empírica real:** dispara `{"action":"sync_custo_producao","account":"colacor_vendas"}` (ou espera o cron). Nos logs: a **amostra crua** da 1ª `ConsultarEstrutura` (confirma os nomes de campo) + o `tally` de status. Depois: `SELECT custo_producao_status,count(*) FROM product_costs WHERE custo_producao_status IS NOT NULL GROUP BY 1` e a cobertura da Caça Colacor subindo de ~0,58.
