# Consolidação de demanda de reposição via de-para de SKU (N→1)

> Money-path (reposição/compras). Design aprovado pelo founder em 2026-07-05 (abordagem ①).
> Contraparte: `docs/agent/reposicao.md` (motor), `docs/agent/money-path.md` (precisão>recall, ausente≠zero).
> Prova: PG17 (`prove-sql-money-path`) + Codex challenge. Handoff: `lovable-db-operator`.

## 1. Problema

O founder quer **descontinuar** `DFZ.8040LT` e `DFA.4128LT` e **substituí-los** por `DFA.4080LT`,
levando o **histórico de demanda** dos dois para o 4080 — para o motor de reposição dimensionar a
compra do 4080 pelo giro **somado dos três**, sem abrir buraco de ruptura na transição (LT OBEN ~39d).

A funcionalidade "Registrar substituição" existente **não faz isso** (verificado na prod, `registrar_substituicao_sku`):

- **Copia parâmetros 1→1, sobrescreve** (`SET estoque_minimo = antigo.estoque_minimo`). No N→1, o segundo
  registro apaga o primeiro — o 4080 nunca fica com a soma.
- **Copia parâmetros, não reatribui vendas.** O histórico de venda do 8040/4128 não vira demanda do 4080.
- **O vínculo é morto no cálculo.** `sku_substituicao` só é lida por `validar_sku_para_aplicacao` (bloqueio
  da fila de aplicação) — **nenhum** cálculo de demanda a consulta.
- **Exige item inativo no Omie** (o botão só existe na aba "Item inativo"), e o **recompute diário
  sobrescreve** os parâmetros copiados.

⚠️ **Risco de usar o fluxo atual:** falsa sensação de consolidação → o recompute redimensiona o 4080 só
pela demanda dele → **subdimensionado → ruptura** (exatamente o que o founder quer evitar).

## 2. Objetivo / critérios de sucesso

1. O recompute de demanda do **destino** (4080) agrega as vendas dos SKUs mapeados nele (8040, 4128) →
   `demanda_media_diaria`/σ → `ponto_pedido`/`estoque_maximo` refletem o giro somado.
2. O founder cadastra o mapa **sem inativar** os antigos no Omie (segue vendendo a última unidade).
3. **Durável e automático** — sobrevive ao recompute diário porque É o recompute (não um override que ele apaga).
4. **Consistente** em toda a superfície: painel "Ajuste manual", cockpit, gráfico do `SkuDetailSheet`, motor.
5. **Isolado** — não afeta `venda_items_history` nem BI/comissão/DRE.

## 3. Design (abordagem ① — de-para no recompute de demanda)

### Frente A — o mapa (dado)
Reusar `sku_substituicao` (`empresa`, `sku_codigo_antigo`, `sku_codigo_novo`, `status`). Registros:
`8040→4080` e `4128→4080`, `status='aplicada'`. A UNIQUE `(empresa, sku_codigo_antigo, status)` já
garante o **N→1** (cada antigo → um novo; vários antigos → o mesmo destino).

### Frente B — o cálculo lê o mapa (o coração)
No **recompute que popula `sku_parametros`** a partir de `venda_items_history`, a agregação da demanda do
**destino** passa a incluir as vendas dos antigos mapeados nele:

```
demanda(destino) := agregação de venda_items_history
  WHERE sku_codigo_omie IN ( destino
                             ∪ { antigo : sku_substituicao.novo = destino AND status='aplicada' } )
```

Propaga naturalmente para `ponto_pedido`/`estoque_maximo` → o motor (`gerar_pedidos_sugeridos_ciclo`, que
só **lê** esses pontos) compra pelo giro dos três.

**Pipeline confirmado na prod (`psql-ro`, 2026-07-05):**
`venda_items_history`
→ **views-fonte de demanda** que agregam por SKU: **`v_sku_demanda_estatisticas`** (central — média/σ), `v_sku_sigma_demanda`, `v_sku_demanda_rajada`, `v_sku_candidatos_primeira_compra`
→ `v_sku_parametros_sugeridos` (junta demanda + custo + LT nos sugeridos)
→ escritoras em `sku_parametros`: `atualizar_parametros_numericos_skus`, `calcular_gatilhos_reposicao`.

**Ponto de injeção:** o de-para entra na **agregação por SKU dentro das views-fonte** (onde `venda_items_history.sku_codigo_omie` é agrupado) — mapear antigo→novo ali propaga para toda a cadeia. Cobrir **todas** as views-fonte (não só a central), senão fica inconsistente. As 3 funções que também leem `venda_items_history` (`detectar_outliers_empresa`, `estimar_impacto_exclusao_outlier`, `simular_formula_estoque`) são outlier/simulação — avaliar caso a caso (um outlier do antigo não deve poluir o novo).

#### Detalhe técnico confirmado (`psql-ro`, 2026-07-05)

Agregação atual em `v_sku_demanda_estatisticas` (a central):
```sql
WITH vendas_por_ordem AS (
  SELECT empresa, sku_codigo_omie, ..., sum(quantidade) AS qtde_ordem, ...
  FROM venda_items_history
  WHERE data_emissao >= CURRENT_DATE - '90 days'
  GROUP BY empresa, sku_codigo_omie, nfe_chave_acesso, data_emissao
), stats AS (
  SELECT empresa, sku_codigo_omie,
         sum(qtde_ordem) AS demanda_total_90d,
         round(sum(qtde_ordem)/90.0, 4) AS demanda_media_diaria, stddev(...) ...
  FROM vendas_por_ordem GROUP BY empresa, sku_codigo_omie
) SELECT ... FROM stats;
```
`venda_items_history.sku_codigo_omie` é **`bigint`**; `sku_substituicao.sku_codigo_antigo/novo` são **`text`** → cast.

**Design DRY — view de indireção que REESCREVE `sku_codigo_omie` (recomendado):**
```sql
CREATE VIEW v_venda_items_history_efetivo AS
SELECT
  id, empresa, nfe_chave_acesso, nfe_numero, nfe_serie, data_emissao,
  cliente_codigo_omie, cliente_razao_social, cliente_cnpj_cpf, cliente_uf, cliente_cidade,
  COALESCE(s.sku_codigo_novo::bigint, v.sku_codigo_omie) AS sku_codigo_omie,  -- ← reescrito p/ o destino
  sku_codigo, sku_descricao, sku_ncm, sku_unidade,
  quantidade, valor_unitario, valor_total, cfop, raw_data, created_at
FROM venda_items_history v
LEFT JOIN sku_substituicao s
  ON s.empresa = v.empresa AND s.sku_codigo_antigo = v.sku_codigo_omie::text AND s.status = 'aplicada';
```
Como a coluna mantém o **mesmo nome** (`sku_codigo_omie`), cada view-fonte só troca `FROM venda_items_history` → `FROM v_venda_items_history_efetivo` — **zero mudança na lógica de agregação/GROUP BY**. Um ponto de de-para; todas herdam. Sem a indireção, o de-para seria copiado em 5 views (várias com 2+ CTEs) = divergência money-path garantida.

⚠️ **`CREATE OR REPLACE VIEW` só acrescenta coluna no fim** (`database.md` §5) → pré-flight `pg_get_viewdef` de CADA view e **preservar a ordem exata** de colunas ao recriar.

**Views-fonte a redirecionar (TODAS leem `venda_items_history` direto — confirmado `psql-ro` 2026-07-05):**
| View | Janela | Agrega por | CTE(s) a apontar p/ a efetiva |
|---|---|---|---|
| `v_sku_demanda_estatisticas` | 90d | sku | `vendas_por_ordem` |
| `v_sku_sigma_demanda` | 180d | sku::text | `vendas_diarias` |
| `v_sku_demanda_rajada` | 180d | sku | `skus_ativos` + `vendas_diarias` |
| `v_sku_candidatos_primeira_compra` | 180d | sku | `recorrencia_180d` |
| `v_sku_parametros_sugeridos` | — | sku | lê direto (`t`) — **localizar a(s) CTE(s)** e apontar |

**Isolamento confirmado:** a varredura de quem referencia `venda_items_history` retornou **só** essas 5 views + 3 funções (`detectar_outliers_empresa`/`estimar_impacto_exclusao_outlier`/`simular_formula_estoque`) — **todas de reposição**. Nada de BI/vendas/comissão/DRE. Reescrever via a efetiva não contamina fora de reposição. ✅

**Caveats a tratar na implementação:**
- `sku_descricao`/`sku_unidade` **não** são reescritas → `max(sku_descricao)` do destino pode exibir a descrição do antigo (cosmético; a **demanda** é correta). Opcional: reescrever a descrição via `omie_products`.
- O frontend `SkuDetailSheet` lê `venda_items_history` **direto** (gráfico 90d). Pra o gráfico do destino refletir os três, apontar o gráfico pra `v_venda_items_history_efetivo` (Frente C).
- Funções outlier/simulação: **avaliar caso a caso** — um pico do antigo não deve virar outlier do novo. Provável: NÃO redirecionar (outlier é sobre a série real do SKU), mas confirmar na prova.

**Colunas de `venda_items_history` (confirmadas):** `id`, `empresa`, `nfe_chave_acesso`, `nfe_numero/serie`, `data_emissao` (date), `cliente_*`, **`sku_codigo_omie` (bigint)**, `sku_codigo` (text), `sku_descricao`, `sku_unidade`, **`quantidade` (numeric)**, `valor_unitario`, `valor_total`, `cfop`, `raw_data`, `created_at`. Índice `idx_venda_sku_data (empresa, sku_codigo_omie, data_emissao)`.

### Frente C — cadastrar sem inativar (UX)
Destravar o registro de substituição/consolidação para aceitar SKU **ativo** (hoje só aparece na aba
"Item inativo" de `AdminReposicaoAplicacao`). **Local recomendado:** `SkuDetailSheet` da aba "Ajuste manual"
(`AdminReposicaoRevisao`), onde já se gerencia parâmetro por SKU e não há dependência de status Omie.

## 4. Decisões

| Decisão | Escolha | Nota |
|---|---|---|
| Unidade antigo↔novo | **1:1** (soma direta, sem fator) | confirmado pelo founder |
| Fonte do mapa | **Reusar `sku_substituicao`** | não criar tabela paralela |
| Consolida **estoque**? | **NÃO — só demanda** | diferente do grupo de embalagem (mesmo produto, tamanhos): aqui são produtos distintos; o estoque residual do antigo é **vendido** e some, não repõe o novo. Consolidar estoque **atrasaria** a compra do 4080. |
| Consolidar descontinua o antigo? | **SIM — decidido (founder 2026-07-05)**: mapear `aplicada` também seta `tipo_reposicao='descontinuado'` no antigo → sai da compra própria; segue **vendável no Omie** até zerar. |
| Onde o botão de cadastro | **`SkuDetailSheet` (Ajuste manual) — decidido (founder 2026-07-05)**; independe de inativação. |

## 5. Isolamento (garantia money-path)
O de-para entra **só** no cálculo de demanda de reposição. **Não** toca `venda_items_history`, nem
relatórios de venda/comissão/DRE. Zero contaminação; zero dupla contagem — a agregação **reescreve** o
SKU (lista `IN`), não soma em cima do próprio.

## 6. Guardas / edge cases (falsificar no PG17)
- **Auto-referência** (`antigo = novo`) → barrada no cadastro e no cálculo.
- **Cadeia transitiva** (destino é, por sua vez, antigo de outro mapa) → resolver **1 nível** com guard que
  detecta e barra/avisa. Resolução recursiva multi-nível é **fora de escopo** (YAGNI).
- **Dupla contagem** → agregação por lista `IN` (não soma duplicada); provar.
- **Reversível** → `status <> 'aplicada'` deixa de contar no **próximo** recompute.
- **Antigo ainda ativo vendendo** → suas vendas contam para o destino (de-para dinâmico); provar.
- **Empresa-aware** → o mapa e a agregação respeitam `empresa` (não vazar entre OBEN/COLACOR).

## 7. Plano de prova
1. **PG17 local** (`db/test-reposicao-consolidacao-demanda.sh`): semear `venda_items_history` dos três +
   `sku_substituicao` aplicada; rodar o recompute; asserir `demanda/ponto/máximo` do 4080 = função da soma.
   Asserts **positivos + negativos + falsificação** (remover o mapa → só 4080; auto-ref; cadeia; sabotar a
   migration → exigir **vermelho**). RLS/empresa sob `SET ROLE` quando aplicável.
2. **Codex** consult (design) + challenge (xhigh) antes do handoff — money-path.
3. **Handoff `lovable-db-operator`**: migration idempotente + bloco SQL Editor + query de validação pós-apply
   + nota de PR + audit. Pré-flight `pg_get_functiondef`/`pg_get_viewdef` da prod (o repo pode divergir).

## 8. Fora de escopo (YAGNI)
- Fator de conversão de unidade (1:1 confirmado).
- Cadeia de substituição multi-nível recursiva.
- Consolidação de **estoque** (só demanda).
- Migração retroativa de outros SKUs já substituídos no passado (esta entrega cobre o mecanismo; aplicar a
  casos históricos é operação de dados separada).

## 9. Estado (2026-07-05)
- ✅ Pipeline de demanda mapeado + isolamento confirmado + design DRY (view de indireção).
- ✅ **Plano** de implementação: `docs/superpowers/plans/2026-07-05-reposicao-consolidacao-demanda-substituicao.md` (self-review + house-style: harness via snapshot, ERRCODE anti-teatro, 42501 no handoff, `pg_indexes`).
- ✅ **Migração SQL COMPLETA**: `db/reposicao-consolidacao-demanda.sql` — efetiva + **4 redirects verbatim** (estatisticas/sigma/rajada/candidatos; via alias, delta = só o `FROM`) + `consolidar_demanda_sku`. `v_sku_parametros_sugeridos` NÃO recriada (herda a demanda via `v_sku_classificacao_abc_xyz`; leitura direta dela é PREÇO). Índice `(empresa,sku_codigo_antigo,status)` casa o `ON CONFLICT`; ordem de colunas da efetiva confere com a tabela.
- ✅ **Harness PG17** completo: `db/test-reposicao-consolidacao-demanda.sh` (cenários A–G + D end-to-end, falsificação com dente).
- ✅ Pré-flight capturado: `db/preflight-reposicao-consolidacao.sql` (verbatim das 5 views + 2 escritoras + colunas + índices).
- ✅ **Prova PG17 VERDE (com falsificação)**: `db/test-reposicao-consolidacao-demanda.sh` — A–H + D + B4, no schema REAL. Destino=315; antigos somem; propaga até `v_sku_parametros_sugeridos`; mapa legado 'transferir'/auto-ref/cadeia barrados (função + **trigger** no INSERT direto); leading-zeros canonicalizados; falsificação com dente (→90).
- ✅ **Codex challenge (xhigh) RODOU + incorporado (2026-07-05)**: 5 P1 — leading-zeros→canonicaliza (`::bigint`); `ON CONFLICT` reivindica mapa legado; **fusível `segurado`** da escritora (consolidação 3,5×>fusível 3×)→passo de aprovação no handoff; cadeia→**trigger estrutural**+advisory lock; destino não-validado→`ZR004`/`ZR005`. P2: overflow `≤18díg`, `public.`+`search_path`. Re-provado E/F/H. Auto-challenge (Caminho B) também incorporado (filtro `acao_parametros` estrutural, B4).
- ✅ **Códigos de prod** (pré-flight): destino `DFA.4080LT`=`12101724100`; antigos `DFZ.8040LT`=`11978465816`, `DFA.4128LT`=`11892839175`. **`sku_substituicao` vazia** (gate 1b limpo).
- ✅ **APLICADO EM PROD (2026-07-05)**: founder colou migração + cadastro; validado via `psql-ro` — demanda do 4080 = **97** (8+19+70) = soma; antigos descontinuados; objetos criados.
- ✅ **Destino 4080 destravado p/ compra** (descoberta pós-apply): estava só VENDIDO, nunca comprado → sem grupo/fornecedor/LT (`SEM_LEADTIME`). Fix aplicado: `sku_grupo_producao`(`sayerlack_normal`, LT 10) + `sku_parametros`(fornecedor RENNER SAYERLACK + habilitado + seed pp24/emax30). Sistema calculou pp23/emax28 → **seed certeiro** (recompute vai aplicar sem disparar o fusível `segurado`). status=**OK**.
- 🧭 **LIÇÃO:** consolidar demanda **NÃO basta** — o DESTINO precisa estar COMPRÁVEL (grupo/fornecedor/LT/habilitado). O `ZR004` da função só checava ativo/não-descontinuado; reforçar p/ exigir **habilitado + lead-time** (futura UX/Frente C).
- ✅ **Codex do setup 4080 (xhigh) RODOU**: veredito OK (seed 24/30 validado pelo sugerido 23/28; durabilidade do fornecedor OK via `COALESCE`; sem efeito em outros SKUs). 2 P1 verificados e **já OK**: de-para Sayerlack existe (`sku_fornecedor_externo`, `sku_portal=DFA.4080LT`, ativo) + CMC=329,46 (pedido não-zero). **P2 a monitorar** (não-bloqueante): fornecedor variante no 1º histórico de compra do 4080 (`fonte_fornecedor='historico_compras'` ≠ `RENNER SAYERLACK S/A` quebraria o match do grupo); LT teórico 10 vs histórico ~12 (seed 24/30 cobre; não pinar, deixar o recompute otimizar p/ 23/28).
- ⏳ Recompute refina 24/30→23/28 (auto, sem 'segurado'). · Frente C (UX) separada.
- ⏳ Frente C (UX) — plano separado. · Commit (quando o founder autorizar).
