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
- **Mapeamento de conta:** a ficha usa código **Colacor**; a reposição é **OBEN**. O `omie_products.codigo` (PRD*) é **compartilhado entre contas** → permite ligar Colacor↔OBEN. ⚠️ **Mas o schema NÃO garante unicidade de `(codigo, account)`** (só de `(omie_codigo_produto, account)`): hoje há 0 duplicatas nos componentes da malha, o que é **dado, não invariante** → exige guard fail-closed (§4.1).
- **Confiabilidade da ficha:** confirmada pelo founder ("é confiável") — habilita usar a malha como fonte de demanda para dirigir compra.
- **BASE e soluções XT.1803 são "folhas"** (sem componentes próprios) → explosão de **1 nível** cobre o caso.
- **Malha limpa:** 6.732 linhas = 6.732 pares `(pai, componente)` distintos → **0 duplicatas, 0 divergências** hoje. `perc_perda ≠ 0` existe em 3 linhas, **nenhuma no escopo OBEN ativo**. Dedup/perda são guards fail-closed, não transformações.

### 2.1 Universo real (⚠️ **unidade** recorta o escopo)

| Recorte | Nº |
|---|---|
| Insumos de produção **ativos na OBEN** que são componentes na malha | **58** |
| …com **unidade da ficha = unidade de estoque** | 25 |
| …**e** hoje invisíveis (`ponto_pedido` NULL) → **ELEGÍVEIS** | **23** |
| Em **quarentena por unidade divergente** | **33** |

⚠️ **A unidade da ficha nem sempre bate com a unidade de estoque do insumo** (`UN|M2` ×127 pares, `UN|L`, `L|UN`, `UN|KG`, `PAR|M2`). Multiplicar através dessa divergência produz **ponto de pedido em unidade errada = compra errada**. Sem tabela de conversão validada, o par vai para **quarentena** (precisão > recall) — os 33 são discos de lixa, concentrados LC e algumas bases MixMachine.

**Os itens que originaram o pedido estão todos no grupo elegível:** `BASE PARA TINGIMIX` (L|L), as 4 `SOLUCAO XT.1803` (L|L), `TINGIMIX` (UN|UN).

**CMC:** 8 dos 23 elegíveis têm `cmc > 0` — incluindo **todos** os do founder. As soluções XT.1803 custam **R$200–392/L** e entram em ~110 tingidores cada: são exatamente o caso que o **V3** (§5.1) protege de ruptura. Os 15 sem CMC (bases MixMachine, cola, galão) **ainda ganham `ponto_pedido`** (a demanda é real); só a *criticidade* fica em fallback, e o gate de disparo existente (`SKU sem custo`) já impede pedido R$0.

- Componentes de **lixa** mapeiam para OBEN mas em geral estão inativos lá (produção Colacor) → saem naturalmente do escopo.

## 3. Decisão

**Abordagem A — explodir a ficha técnica na demanda**, reusando o pipeline existente. Escolhida pelo founder sobre (B) parâmetro manual e (C) sincronizar consumo real do Omie. Motivo: usa dados que já existem (ficha + demanda dos pais), é automática, auto-atualiza com o giro, e **não toca o motor** (`gerar_pedidos_sugeridos_ciclo` fica intacto) — adiciona uma fonte de demanda e, pelo V3, ensina a criticidade do insumo. Override manual (`minimo_forcado_manual`, já existente) permanece como rede.

## 4. Arquitetura

Fluxo (⊕ = nova fonte somada; o **motor não muda**):

```
venda_items_history (vendas reais OBEN)
   ├─ [INALTERADA] v_venda_items_history_efetivo   ← preço/receita real vive AQUI
   ▼
[NOVA] v_pcp_malha_oben          ficha Colacor→OBEN (via codigo + guard fail-closed),
   │                             1 linha/(pai,insumo), qtde consolidada
   ▼
[NOVA] v_sku_demanda_efetiva  =  vendas diretas ⊕ consumo explodido
   │                             (qtde_pai×qtde_ficha · NF do pai · valor NULL)
   ▼
4 views estatísticas (só trocam FROM → v_sku_demanda_efetiva)
   ▼
[ALTERADA p/ V3] v_sku_parametros_sugeridos → estoque_seguranca / ponto_pedido / estoque_maximo
   │              insumo classifica por criticidade de reposição (qtde × cmc), não por venda
   ▼
função de aplicação de parâmetros [INALTERADA] → grava sku_parametros
   ▼
gerar_pedidos_sugeridos_ciclo [INALTERADO] (vê ponto_pedido/estoque_maximo) → 🎯 COCKPIT
```

### 4.1 `v_pcp_malha_oben` (nova) — tradução de conta isolada
Único ponto que traduz a ficha (código Colacor) para o mundo da reposição (OBEN), pelo `codigo` PRD. Responsabilidades:
- pai Colacor → pai OBEN e componente Colacor → componente OBEN (via `omie_products.codigo`, `account`-explícito nas duas pontas).
- **consolidar** múltiplas linhas do mesmo par (pai, componente) numa qtde canônica.
- filtrar componente **ativo na OBEN**.
- ⚠️ **armadilha:** JOIN account-blind duplica silenciosamente (sem UNIQUE no item — `docs/agent/database.md`).

**Guards obrigatórios (Codex challenge, money-path — sem eles = compra dobrada/faltante):**
- **Cardinalidade `codigo`→conta NÃO é garantida pelo schema** (`omie_products` só tem unique em `(omie_codigo_produto, account)`, não em `(codigo, account)`). Hoje há 0 duplicatas nos componentes da malha (verificado psql-ro 2026-07-09), mas isso é dado, não invariante. A tradução deve **falhar fechado com diagnóstico** quando um `codigo` tiver `≠1` linha ativa na conta destino (0 = insumo sumiu; >1 = ambíguo) — **NUNCA `LIMIT 1`** (esconderia a ambiguidade e escolheria arbitrário). O item ambíguo sai para uma **fila de exceção** (não some calado).
- **Dedup da malha falsificável:** par `(pai, componente)` com linhas **exatamente iguais** → deduplica (duplicata de sync); linhas com **qtde divergente** → **quarentena** (pode ser duplicata OU duas etapas reais somáveis — não decidir por soma/média/DISTINCT cego, cada um erra num cenário). Regra explícita + prova.
- ⚠️ **Guard de UNIDADE (o mais material — 33 de 58 insumos):** só explodir quando `unidade_da_ficha = unidade_de_estoque_do_insumo`. Divergente (`UN|M2`, `UN|L`, `L|UN`, …) → **quarentena com diagnóstico**, nunca conversão inventada (unidade errada = ponto de pedido errado = compra errada). Uma tabela de conversão validada pode habilitá-los depois; não é este design.
- **`perc_perda ≠ 0` → quarentena** (0 casos no escopo hoje). Não aplicar fator de perda silenciosamente.
- **Barrar auto-referência:** `pai_oben = componente_oben` é excluído (0 casos hoje, mas venda direta + linha sintética do mesmo SKU = compra dobrada). Guard que blinda o futuro.
- **Interação com o de-para de consolidação de demanda:** a explosão precisa casar com o SKU **efetivo** (destino do de-para N→1 que a `v_venda_items_history_efetivo` já aplica). Se a malha estiver no código antigo do pai e a venda foi consolidada para o destino, a explosão não casa (ou duplica). O mapeamento deve operar no mesmo espaço de SKU do histórico efetivo — provar os dois de-paras juntos.

### 4.2 `v_sku_demanda_efetiva` (nova) — demanda = venda ⊕ consumo
Mesmo **shape de colunas** de `v_venda_items_history_efetivo` (as 4 views estatísticas esperam esse formato). Corpo:
- `SELECT * FROM v_venda_items_history_efetivo` (vendas diretas — preço real preservado);
- `UNION ALL` consumo explodido: para cada linha de venda cujo SKU é pai em `v_pcp_malha_oben`, emitir uma linha de consumo.

**Shape da linha sintética (Codex #5/#6 — herdar cegamente do pai quebra):**

| Campo | Valor | Porquê |
|---|---|---|
| `sku_codigo_omie`, `sku_codigo`, `sku_descricao`, `sku_ncm`, `sku_unidade` | **do INSUMO** | herdar `sku_unidade='UN'` do pai mostraria o BASE em UN, não em L → estatística semanticamente errada |
| `quantidade` | `qtde_venda × qtde_ficha` | a demanda física derivada |
| `data_emissao` | do pai | a data em que o consumo ocorreu |
| **`nfe_chave_acesso`** | **do pai** | ⚠️ **crítico:** `num_ordens = count(DISTINCT nfe_chave_acesso)`. Com NULL o insumo conta **0 ordens** e fica preso em `AGUARDANDO_SEGUNDA_ORDEM` — a feature não entregaria. Herdando a NF do pai, o BASE ganha ~138 ordens distintas (verificado) e gradua. |
| `nfe_numero`, `nfe_serie`, `cliente_*` | do pai | coerência do evento; ver ressalva de semântica abaixo |
| `empresa` | da venda (OBEN) | guard: só explodir venda OBEN → insumo OBEN. Nunca cruzar empresa (venda Colacor não pode comprar na OBEN) |
| `valor_unitario`, `valor_total` | **NULL** (V3, §5.1) | receita honesta — insumo não vende. A criticidade/ABC vem do **valor de reposição derivado** (`qtde × cmc`), não deste campo |

**Ressalvas de semântica (aceitas explicitamente, não silenciadas):**
- Duas vendas de pais diferentes **na mesma NF** somam quantidade mas contam **1 ordem** (`num_ordens` é por NF distinta). Comportamento aceito.
- `v_sku_candidatos_primeira_compra` é *sidecar* (lê recorrência de NF/cliente). Religada, `clientes_180d` do insumo passa a significar **clientes dos pais**, não do insumo. Aceitável para consumo interno — mas documentado como tal, sem fingir que mede venda do insumo.

### 4.3 Religamento das 4 views estatísticas
`v_sku_demanda_estatisticas`, `v_sku_sigma_demanda`, `v_sku_demanda_rajada`, `v_sku_candidatos_primeira_compra`: trocam **somente** o `FROM v_venda_items_history_efetivo` → `FROM v_sku_demanda_efetiva` (alias remapeado; zero mudança de agregação/GROUP BY/colunas — mesma disciplina do `db/reposicao-consolidacao-demanda.sql`). Cada `CREATE OR REPLACE VIEW` preserva a **ordem exata de colunas da PROD** (senão `cannot change name of view column`) — pré-flight `pg_get_viewdef` obrigatório.

### 4.4 Cálculo/aplicação de parâmetros
Com demanda > 0, `v_sku_parametros_sugeridos` sai de `AGUARDANDO_SEGUNDA_ORDEM` e calcula os parâmetros; a função de aplicação diária (`aplicar_parametros_automatico_diario` / `preencher_parametros_faltantes_skus` — a confirmar no pré-flight) grava em `sku_parametros`.

⚠️ **`v_sku_parametros_sugeridos` MUDA** (não é passthrough): pelo **V3** (§5.1) ela passa a classificar insumo pela **criticidade de reposição** (`qtde × cmc`) em vez do valor de venda. A função de aplicação e o motor seguem **inalterados**.

**A confirmar no plano:** se a graduação exige `status_sugestao='OK'`; e que a demanda somada dos 112 pais (com a NF herdada → `num_ordens` alto) de fato tira o insumo do `AGUARDANDO_SEGUNDA_ORDEM` — deve resolver, mas **provar**.

## 5. Decisões de design

### 5.1 O valor das linhas de consumo — **DECIDIDO: V3** (founder, 2026-07-09)

O insumo não gera receita, mas a **classe ABC é calculada por `valor_total_90d`**, e a classe governa o `z_score`/estoque de segurança. Três caminhos, com o trade-off exposto pelo Codex:

| | O que faz | Prós | Contras |
|---|---|---|---|
| **V1** | `valor = NULL` | Não fabrica receita. Simples: não toca `v_sku_parametros_sugeridos`. Dimensionamento conservador (pouco capital). | `v_sku_demanda_rajada` faz `COALESCE(valor,0)` → `valor_total_180d = 0`. Insumo cai em **classe C** → menor estoque de segurança → **risco de ruptura de produção** em insumo caro com LT alto ("sugestão aparece tarde demais" — Codex #4). |
| **V2** | `valor = qtde × cmc` no próprio `valor_total` | ABC reflete a criticidade real. | **Contamina a semântica** de `valor_total_90d`, que downstream lê como *faturamento*. Codex: "não reaproveitar `valor_total_90d` se esse campo significa venda". |
| **V3** ⭐ | `valor = NULL` (receita honesta) **+** valor de reposição dedicado (`qtde × cmc`) usado **só** para criticidade/ABC de insumo | Semanticamente limpo: receita não é fabricada e a criticidade não é subestimada. | Toca `v_sku_parametros_sugeridos` (mais superfície money-path). |

**Decisão: V3** (escolhida pelo founder). O custo de ruptura de um insumo é assimétrico — para a fabricação de tingidores inteira — e estamos com PG17 + Codex no loop agora; mais barato acertar aqui do que descobrir a ruptura em produção.

**Consequências de escopo do V3 (não subestimar):**
- `v_sku_parametros_sugeridos` **entra no escopo do PR-2** (é onde a classe ABC é calculada). É view money-path grande → pré-flight `pg_get_viewdef` + preservar ordem exata de colunas.
- O valor de reposição (`qtde × cmc`) é **derivado**, nunca gravado como receita. `valor_total`/`valor_unitario` das linhas sintéticas seguem **NULL** (receita honesta; `ausente≠zero`).
- A ABC do insumo passa a usar o valor de reposição; a ABC de **produto vendido não muda** (segue `valor_total_90d` de venda). O discriminador "é insumo" = ser componente em `v_pcp_malha_oben`. Provar que produto de venda mantém a classe **idêntica** (assert de não-regressão).
- `cmc` ausente (15 dos 23 elegíveis) ⇒ **não fabricar** valor. O insumo **ainda ganha `ponto_pedido`/`estoque_maximo`** (a demanda explodida é real); apenas a *criticidade* fica em **fallback conservador** e ele entra na fila "insumo sem custo". Nunca `valor = 0` (que o empurraria para C — o bug que o V3 evita). Rede existente: o gate de disparo já barra `SKU sem custo`, então não há pedido R$0.

### 5.2 Demais decisões
1. **Explosão de 1 nível** (base/soluções são folhas — cobre o caso). Multinível (tingidor que é componente de outro; existem ~7) fica para Fase 2; corte **documentado, não silenciado**.
2. **Calibração conservadora + revisão humana.** Ligar como **sugestão visível** (não auto-aprovação — o piloto N3 segue dormente por decisão anterior). Founder revê os primeiros ciclos. O motor tem histórico de superdimensionar 2–5×.
3. **Insumo sem ficha na malha** = fora do escopo automático; usa override manual existente.
4. **Escopo = OBEN tintométrico/moveleiro** (componentes ativos na OBEN). Produção de lixa (Colacor) fora — tem seu próprio track de PCP.
5. **Ambiguidade nunca é silenciada:** `codigo` duplicado/ausente e par de malha divergente vão para **fila de exceção** com diagnóstico, não são resolvidos por escolha arbitrária.

## 6. Money-path — invariantes e riscos

- `ausente≠zero`: linhas de consumo com valor NULL; custo do pedido do CMC real; nunca fabricar R$0. Vale também para o V3: **`cmc` ausente ⇒ exceção, não valor 0**.
- Mapeamento de conta Colacor↔OBEN **não é 1:1 por schema** → guard de cardinalidade **fail-closed** + fila de exceção. Duplicação silenciosa = **compra dobrada**.
- Dedup da malha (par pai-componente) antes de somar — linha repetida = demanda inflada; par divergente = **quarentena**, nunca soma cega.
- Auto-referência (`pai = componente`) barrada — senão venda direta + linha sintética dobram a demanda.
- `nfe_chave_acesso` herdada do pai — sem isso `num_ordens = 0` e o insumo **nunca gradua** (a feature não entregaria).
- Sem dupla contagem: insumo que também venda avulso soma venda + consumo (correto).
- Não tocar `supabase/migrations/` (snapshot é DR); tudo `CREATE OR REPLACE` idempotente colado no SQL Editor.
- `v_venda_items_history_efetivo` **inalterada** → não regride a consolidação N→1 nem o preço.
- Motor (`gerar_pedidos_sugeridos_ciclo`) e função de aplicação **inalterados** — a mudança de comportamento vem só da demanda + criticidade.
- **RLS / `security_invoker` (achado do review, `database.md` §4):** TODA view nova (`v_pcp_malha_oben*`, `v_sku_demanda_efetiva`) sai `WITH (security_invoker = true)` + `REVOKE ALL FROM anon, PUBLIC` + `GRANT SELECT TO authenticated`. Sem isso a view roda como owner (BYPASSRLS) e projeta ficha técnica / venda / custo à **anon-key pública** — exatamente o P0 #1246 fechado em 2026-07-08. As views-base do PCP já são `invoker=on`; a cadeia inteira tem de permanecer assim.

## 7. Provas (obrigatórias antes do apply)

**PG17 (`prove-sql-money-path`) — asserts positivos E negativos, com falsificação** (lista endurecida pelo Codex challenge):

*Cardinalidade e mapeamento*
- Para todo `codigo` usado na malha: exatamente 1 linha `account='colacor'` e 1 linha ativa `account='oben'`. Casos `0` e `>1` **têm de falhar** (falsificar: injetar `codigo` duplicado → exigir vermelho, jamais compra dobrada).
- Nenhum par com `pai_oben = componente_oben` (auto-referência).
- Par de malha divergente sem decisão explícita → quarentena, não soma silenciosa. Duplicata exata → dedup.
- Componente OBEN inativo não gera demanda **mas aparece no relatório de exclusão**.
- Quantidade `> 0`.
- **Unidade:** par com `unidade_ficha <> unidade_estoque` **não explode** e cai em quarentena (falsificar: forçar a explosão de um par `UN|M2` → exigir vermelho). Par com unidade igual explode.
- **`perc_perda <> 0` → quarentena** (falsificar: injetar perda num par do escopo → exigir vermelho, jamais aplicar fator silencioso).

*Demanda e fan-out*
- BASE explode para ~0,58 L/dia no fixture; venda direta (0,15) soma **separadamente**; pai fora da malha não gera linha.
- **Sem fan-out:** 1 venda de 1 pai com ficha 0,9 gera exatamente **0,9 L**, nunca 1,8.
- De-para: venda de pai antigo consolidado para o destino explode **exatamente uma vez**.

*Valor / preço / criticidade (V3)*
- Linhas sintéticas têm `valor_unitario` e `valor_total` **NULL**; `preco_venda_medio` do insumo permanece nulo; `fonte_preco` vem de `cmc` ou compra real.
- `precos_venda` em `v_sku_parametros_sugeridos` continua lendo **venda real**, não sintético.
- **Não-regressão:** produto de venda (não-insumo) mantém `classe_abc` **idêntica** antes/depois do V3 (falsificar: aplicar valor de reposição a um produto vendido → exigir vermelho).
- Insumo caro/muito consumido sobe de classe vs. o baseline V1 (prova de que o V3 faz o que promete).
- **`cmc` ausente ⇒ baixa-confiança/exceção, nunca `valor = 0`** (fabricar 0 o empurraria para C — o bug que o V3 existe para evitar).

*Graduação*
- 1 NF → permanece `AGUARDANDO_SEGUNDA_ORDEM`; 2 NFs distintas → `OK` **somente se** LT, fornecedor, CMC e grupo estiverem válidos.
- Mesma NF com dois pais: quantidade soma, `num_ordens = 1` (comportamento **aceito explicitamente**).

*Motor e deploy*
- Com estoque do BASE abaixo do ponto, `gerar_pedidos_sugeridos_ciclo('OBEN', data)` inclui o BASE **uma única vez**; acima do ponto, não inclui; com `codigo` duplicado injetado, o teste **falha**.
- **PR-1 inerte:** `EXCEPT ALL` prova que as 4 views antigas e a RPC retornam **idêntico** antes/depois; `pg_depend` prova que nada existente depende de `v_sku_demanda_efetiva`.
- **PR-2:** nomes, tipos e **ordem** das colunas das views não mudam.

**Demais gates:** Codex challenge (xhigh) sobre o spec (✅ feito — §11) e depois sobre o SQL. Pré-flight `pg_get_viewdef` das 5 views + `pg_get_functiondef` da função de aplicação (prod diverge do repo). Verificação pós-apply (psql-ro): o BASE ganha `ponto_pedido`/`estoque_maximo`; demanda ~0,58 L/dia; nenhum SKU fora do escopo mudou; **insumos destravados = 23**; **33 em quarentena de unidade, listados** (não sumidos).

## 8. Faseamento

- **PR-1 — fonte de demanda (inerte por construção):** `v_pcp_malha_oben` + `v_sku_demanda_efetiva` + guards (cardinalidade, auto-ref, dedup) + provas PG17. Aplicável isolado: as 4 views ainda leem a fonte antiga → **zero efeito** (provar com `EXCEPT ALL` + `pg_depend`). Verificar a demanda explodida via psql-ro **antes** de religar.
- **PR-2 — religamento + criticidade (V3):** trocar o FROM das 4 views → `v_sku_demanda_efetiva` **e** ensinar `v_sku_parametros_sugeridos` a classificar insumo pelo valor de reposição (`qtde × cmc`). É o PR que **muda comportamento** (money-path pleno) → Codex challenge sobre o SQL + PG17 com falsificação + assert de **não-regressão** (produto de venda mantém classe idêntica).
- **PR-3 — verificação/calibração em prod:** acompanhar os primeiros ciclos, ajustar se super/subdimensionar; documentar em `docs/agent/reposicao.md` + `docs/historico/`.

## 9. Critério de sucesso

O `BASE PARA TINGIMIX`, as 4 `SOLUCAO XT.1803` e os demais **23 insumos elegíveis** aparecem no cockpit **quando o estoque do grupo cai ao ponto de pedido**, dimensionados pelo consumo real (explodido), sem pedido manual — e sem superdimensionar a ponto de o founder rejeitar sistematicamente. Os **33 em quarentena de unidade** ficam **listados e diagnosticados**, nunca silenciosamente ausentes.

## 10. Fora de escopo

Multinível de BOM; insumo sem ficha; **conversão de unidade** (os 33 em quarentena — exige tabela validada); produção de lixa (Colacor); auto-aprovação N3 (segue dormente); sincronização de consumo real do Omie (Abordagem C).

## 11. Codex challenge (xhigh, gpt-5.5, 2026-07-09) — furos e resolução

**Veredito original:** *"a Abordagem A ainda não está segura para money-path. Resolve invisibilidade, mas como está pode gerar compra dobrada, compra faltante e 'valor zero' fabricado."* Nenhum furo invalida a abordagem; todos foram incorporados acima. Incidência verificada em prod via `psql-ro`.

| # | Furo | Incidência hoje | Resolução |
|---|---|---|---|
| 1 | `codigo`→conta **não é 1:1** por schema (unique só em `(omie_codigo_produto, account)`) | **0** duplicatas nos componentes da malha (1 no universo OBEN amplo) | Guard **fail-closed** + fila de exceção. **Nunca `LIMIT 1`** (§4.1) |
| 2 | "qtde canônica" indefinida (soma/DISTINCT/média erram em cenários distintos) | — | Regra falsificável: duplicata exata → dedup; divergente → quarentena (§4.1) |
| 3 | `v_sku_demanda_rajada` faz `COALESCE(valor_dia, 0)` → NULL vira **0** | confirmado na viewdef | Neutralizado pelo **V3**: criticidade não depende mais de `valor_total_*` (§5.1) |
| 4 | Classe C por valor 0/NULL **subdimensiona insumo crítico** → ruptura de produção | risco real | **V3 adotado** (founder): valor de reposição dedicado (`qtde × cmc`) (§5.1) |
| 5 | **`num_ordens = count(DISTINCT nfe_chave_acesso)`** → linha sintética com NF nula conta **0 ordens** → insumo fica preso em `AGUARDANDO_SEGUNDA_ORDEM` | **mataria a feature** | Linha sintética **herda `nfe_chave_acesso` do pai** → BASE ganha ~138 ordens (§4.2) |
| 6 | Shape sintético incompleto (herdar `sku_unidade='UN'` do pai; herdar `empresa` errada) | — | Tabela de shape explícita: campos do **insumo** vs herdados do pai (§4.2) |
| 7 | De-para de consolidação × BOM podem **desencontrar** (malha no código antigo do pai) | — | Explosão opera no espaço de SKU **efetivo**; provar os dois de-paras juntos (§4.1) |
| 8 | Auto-referência `pai = componente` dobra demanda (não faz loop, pois é 1 nível) | **0** pares | Guard que exclui o par (§4.1) |
| 9 | `v_sku_candidatos_primeira_compra` é *sidecar*: `clientes_180d` passaria a significar clientes **dos pais** | — | Aceito e **documentado** como tal (§4.2) |

## 12. Codex challenge do SQL FINAL (xhigh, gpt-5.5, 2026-07-11) — furos e status

Challenge sobre o SQL concreto (não o design). **Todos os 8 furos têm 0 incidência em produção hoje** (verificado `psql-ro`) — são fragilidades de lógica latentes contra dado legado/edge. 3 corrigidos com prova PG17; 5 são fail-closed conservadores ou upstream, **vigiados**.

| # | Furo | Incidência | Status |
|---|---|---|---|
| 1 | Colapso N→1: 2 componentes distintos → mesmo `comp_oben` (via de-para) **somariam**, mas `min()` subcompraria | **0** | ✅ **Fix:** `HAVING count(DISTINCT componente_codigo)=1` → quarentena `multiplos_componentes_mesmo_insumo` (fail-closed, não subcompra). Assert COL1/COL2 |
| 6 | `::bigint` estoura em código >18 díg. no de-para → **derruba a view inteira** (runtime) | **0** | ✅ **Fix:** regex `^\d{1,18}$` (o trigger de cadastro já barra novos; fix cobre legado). Assert OVF1 |
| 7 | Unidade/código sem normalização (`'L'` vs `'l '`) → **falso-quarentena** (compra faltante) | **0** | ✅ **Fix:** `btrim(upper(...))` nos dois lados. Assert NORM1 |
| 2 | De-para × pai **inativo** em OBEN: `oben_ativo` filtra antes → mapa não aplica | **0** | 🔍 **Vigiado.** Já **fail-closed** (par vai à quarentena `pai_sem_par_oben_ativo`, não compra errado). Corrigir exigiria não filtrar ativo no pai (mais arriscado) |
| 3 | Cadeia `A→B→C` one-hop (dado legado) | **0** | 🔍 **Vigiado.** Trigger `sku_substituicao_consolidacao_guard` barra novos |
| 4 | `perc_perda` não-parseável → `fn_pcp_num` NULL → `COALESCE 0` → passa | **0** | 🔍 **Vigiado (upstream).** Não detectável na minha camada (a view já entrega `perc_perda` numérico) |
| 5 | NF nula no pai → `num_ordens=0` → insumo não gradua | **0** | 🔍 **Vigiado (herdado).** `num_ordens` usa NF em todo o motor |
| 8 | Ambiguidade `bycod` na `vw_pcp_malha_componentes` (`ORDER BY … LIMIT 1`) | — | 🔍 **Upstream (PCP).** Fora do escopo; candidato a chip |

**Queries de vigilância** (rodar periodicamente / candidatas a um vigia — todas retornam 0 hoje):

```sql
-- #2 pai da malha inativo em OBEN com de-para
SELECT count(DISTINCT opb.omie_codigo_produto)
FROM vw_pcp_malha_componentes m
JOIN omie_products opc ON opc.omie_codigo_produto=m.pai_codigo AND opc.account='colacor'
JOIN omie_products opb ON opb.codigo=opc.codigo AND opb.account='oben' AND NOT opb.ativo
JOIN sku_substituicao s ON s.sku_codigo_antigo=opb.omie_codigo_produto::text
 AND s.empresa='OBEN' AND s.status='aplicada' AND s.acao_parametros='consolidar_demanda';
-- #3 cadeia no de-para
SELECT count(*) FROM sku_substituicao a JOIN sku_substituicao b ON a.sku_codigo_novo=b.sku_codigo_antigo
WHERE a.empresa='OBEN' AND a.status='aplicada' AND a.acao_parametros='consolidar_demanda'
  AND b.empresa='OBEN' AND b.status='aplicada' AND b.acao_parametros='consolidar_demanda';
-- fan-out do de-para (review final): um 'antigo' mapeando p/ 2 'novo' distintos inflaria demanda
-- (paridade com v_venda_items_history_efetivo, que faz o mesmo LEFT JOIN; 0 casos hoje)
SELECT count(*) FROM (
  SELECT sku_codigo_antigo FROM sku_substituicao
  WHERE empresa='OBEN' AND status='aplicada' AND acao_parametros='consolidar_demanda'
  GROUP BY sku_codigo_antigo HAVING count(DISTINCT sku_codigo_novo) > 1) d;
-- #5 vendas de pais da malha sem NF (90d) — mede quanto consumo não gradua
SELECT count(*) FROM venda_items_history v
WHERE v.empresa='OBEN' AND v.nfe_chave_acesso IS NULL AND v.data_emissao >= CURRENT_DATE-90
  AND v.sku_codigo_omie IN (
    SELECT opb.omie_codigo_produto FROM vw_pcp_malha_componentes m
    JOIN omie_products opc ON opc.omie_codigo_produto=m.pai_codigo AND opc.account='colacor'
    JOIN omie_products opb ON opb.codigo=opc.codigo AND opb.account='oben' AND opb.ativo);
```
