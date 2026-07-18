# Tintométrico — receita perdida + catálogo duplicado: programa de remediação

> **Plano-PROGRAMA (roteiro de fases-PR), não micro-TDD.** Cada fase abaixo é 1 PR money-path que, ao ser executado, vira seu próprio plano detalhado (prove-sql + Codex no diff). Ordenado por gravidade/dependência — a ordem foi validada adversarialmente pelo Codex (gpt-5.6-sol xhigh, 2026-07-17). NÃO executar em bloco: é escrita money-path, 1 fase = 1 entrega. Use `handoff-sessao` para abrir cada fase em sessão dedicada.

**Goal:** fechar a fronteira de escrita do import tintométrico (fail-open de receita parcial), eliminar a ambiguidade SL×SAYERLACK no catálogo, revalidar preço no submit e só então desativar a geração legada — sem apagar catálogo nem quebrar o balcão.

**Diagnóstico completo:** ver `docs/agent/tintometrico.md` (invariantes) e a seção "Achado" no fim deste doc. Parecer Codex cru preservado em `/private/tmp/…/scratchpad/codex-parecer-tint.txt` (efêmero — o essencial está transcrito no fim).

---

## Fatos medidos em prod (psql-ro, 2026-07-17) — base do dimensionamento

| Métrica | Valor |
|---|---|
| `tint_formulas` total | 975.228 |
| Ativas sem receita (fail-closed) | 28.609 (28.605 na célula SAYERLACK×`FL.6344`) |
| **Receita PARCIAL na SAYERLACK (fail-OPEN, P0)** | **240** (residuo de volume − Σqtd_ml > 1ml; gap máx 889,94 ml = corante inteiro) |
| Geração `1`/SAYERLACK ativa (congelada 03→04/2026) | 465.431 — CSV em 465.408, `importacao_id` NULL em ~28,6k |
| Geração `SL` ativa (viva 06/2026→hoje) | 493.297 — CSV em **0** (todas NULL) |
| Combinações vendáveis (sku_id,cor_id) SAYERLACK SEM gêmea SL c/ receita | **12** |
| Receita divergente entre gêmeas (amostra 3.000) | 495 (16,5%) |
| Itens tintométricos em `sales_orders` (toda a história) | 7 (últimos 04/2026; 6 apontam SAYERLACK) |

**Leitura:** o balcão de venda tintométrico é quase inexercido hoje → risco POTENCIAL, não corrente. Mas a superfície é grande (~465k linhas duplicadas) e o fail-open de preço é silencioso. Contenção antes de escala de uso.

## Global Constraints

- **Money-path:** precisão > recall; ausente ≠ zero; nunca fabricar número; gate humano na escrita (SQL Editor do Lovable). Ver `docs/agent/money-path.md`.
- **Prova obrigatória:** toda função/RPC/trigger/view money-path desta remediação passa por `prove-sql-money-path` (PG17 com falsificação) ANTES do handoff, e por `/codex` no diff.
- **Nada de apagar catálogo:** soft-deactivation (`desativada_em`) apenas, nunca DELETE. 465k linhas de catálogo são irreversíveis na prática.
- **Deploy Lovable = 3 camadas manuais** (Publish / edge pelo chat / migration no SQL Editor). Merge ≠ produção. Ver `docs/agent/deploy.md`.
- **Edge espelha helper de `src/` VERBATIM** (Deno não importa de src) — paridade textual no CI + canária comportamental.

---

## Fase 1 (P0) — Fronteira de escrita fail-closed por-linha (DOIS writers)

**Por quê primeiro:** é o único defeito ATIVO que corrompe dado novo. As 240 parciais calculam preço baixo *válido* (fail-open); o contador "N sem receita" que eu havia proposto é observabilidade, não defesa (achado Codex).

⚠️ **São DOIS writers com o MESMO padrão delete-incondicional + insert-filtrado, e o PRIORITÁRIO é o vivo:**

### 1a — `tint_promote_sync_run` (writer VIVO — prioridade)
O catálogo é alimentado automaticamente desde 18/06 pelo **sync SayerSystem**: `tint-sync-agent` (`index.ts:397,542`) chama a RPC `tint_promote_sync_run`. É ela que produz a geração `SL` viva. O import CSV manual foi **aposentado no frontend** (#1314, 12/07 — removeu `TintImport`/`ImportCard`/`useDirectTintImport`/`preflight-files`), mas o edge ainda responde (ver 1b).

Padrão em prod (confirmado via `psql-ro`, cadeia `20260609150000_tint_sync_promote.sql` + fixes):
```sql
DELETE FROM tint_formula_itens fi USING _promoted pr WHERE fi.formula_id = pr.formula_id;
INSERT INTO tint_formula_itens (...)
  SELECT DISTINCT ON (pr.formula_id, co.id) ...
  FROM _promoted pr JOIN tint_staging_formula_itens si ON ... JOIN tint_corantes co ON ...
  WHERE si.id_corante IS NOT NULL AND si.id_corante <> '' AND COALESCE(si.qtd_ml,0) > 0;
```
- **DELETE incondicional** dos itens das fórmulas em `_promoted`, INSERT filtrando `qtd_ml>0 AND id_corante<>''`. Se o staging traz um corante com qtd inválida, ele é filtrado → **receita PARCIAL** (fail-open); se TODOS caem no filtro → **receita ZERO** (a fórmula fica vazia com "sucesso").
- **Está INOCENTADO para as 28.609 de março** (elas vieram do CSV, `importacao_id` NULL, o promote nem existia) — mas carrega o MESMO defeito para o dado NOVO/vivo.
- **Files:** migration nova recriando `tint_promote_sync_run` (pré-flight `pg_get_functiondef` da prod — apply manual diverge do repo; a última a recriar VENCE). Helper: `src/lib/tint/sync-promote.ts`. Prova: `db/test-tint-promote.sh` (já existe — estender).
- **Fix:** o INSERT deve ser **all-or-nothing por fórmula** — se a fórmula do staging tem ≥1 corante com `id_corante` presente mas `qtd_ml<=0` (linha que DEVERIA ter receita mas está quebrada), NÃO promover essa fórmula (deixar a receita anterior intacta, marcar no `tint_sync_errors`), em vez de gravar parcial. Distinguir "fórmula legitimamente sem corante" de "corante presente com qtd inválida".

### 1b — `tint-import`/`processFormulas` (RESIDUAL — endpoint ainda responde)
Frontend aposentado (#1314), mas `supabase/functions/tint-import/index.ts` mantém `processFormulas` (`:235`), `handleFileMode` (`:336`), `handleChunkMode` (`:484`) e o `serve()` roteia (`:562,571`) → alcançável por chamada DIRETA ao edge. O `preflight-formulas.ts` (linhas) pode ter ficado órfão (o hook que o chamava, `useDirectTintImport`, foi removido). **Decidir na fase:** desativar o edge de vez (retornar 410) OU aplicar o mesmo fail-closed. Mudanças se mantiver:
1. **Rejeitar receita parcial:** slot de corante presente com `qtd` null/≤0 → rejeitar a LINHA (hoje `:282-294` pula o slot ruho → parcial gravada).
2. **Header+itens atômicos:** `delete` (`:325`)+`insert` (`:327`) não-transacional, erro só em `console.error` (`:328`) → RPC transacional ou rollback.
3. **Contar após commit:** `imported++` (`:319`) sobe antes dos itens → mover; guard `imported+updated+errors==total`.
4. **Lookup de subcoleção (`:304`):** `.is("subcolecao_id", subcolecaoId ? undefined : null)` → `.eq` quando não-nula; tratar erro (hoje ignorado). Mitigado pelo `upsert onConflict:'chave'`, mas UPDATE pode ir ao registro errado.

**Critério de aceite (ambos):** PG17 prova (a) fórmula com corante+qtd-inválida NÃO grava receita parcial (promove nada OU rejeita a linha), (b) receita anterior preservada quando o novo lote é inválido, (c) falsificação: reverter cada guard → vermelho no assert certo. Canária: sync run com 1 fórmula de corante-qtd-inválida → `tint_sync_errors` registra, receita íntegra.

**Risco:** `tint_promote_sync_run` é money-path de escrita VIVO — `prove-sql` + Codex xhigh no diff obrigatórios; recriar preservando os fixes já aplicados (`20260611190000`/`20260617*`/`20260622*` — a última a recriar vence, garanta a ordem). Edge reescrito pelo Lovable no deploy → verbatim + verificar por comportamento.

---

## Fase 1c (NOVA — resíduo da Fase 1) — protocolo de staging: ingestão como UNIDADE

**Por quê existe:** a Fase 1 fechou a fronteira de escrita *dentro* da RPC. Sobrou uma classe de defeito que **não se resolve na RPC** — duas rodadas do Codex mostraram que tentar (v2) introduz regressões piores que o defeito. O problema é de **protocolo de ingestão**, não de guard:

- `tint-sync-agent` insere os **headers** (chunks de 500) e só depois os **itens** (chunks de 1000). O `pg_advisory_xact_lock` serializa a **promoção**, não a ingestão → outro run pode promover lendo staging a meio caminho.
- Os itens de **uma** fórmula podem **atravessar a fronteira de chunk**: se o 2º chunk falha e o cleanup do edge falha junto (o `.delete()` tem o erro **ignorado**, `index.ts:523`), sobra um **subconjunto válido** — indistinguível de receita legítima. O guard da Fase 1 **não pega isso** (todos os itens presentes têm dose válida).
- A **transição legítima para base pura** (fórmula pigmentada que passa a não ter corante) é hoje ambígua e fica barrada pelo guard — precisa de sinal explícito.

⚠️ **O que NÃO fazer (medido, custou uma migration):** filtrar o staging por `tint_sync_runs.status='complete'`. Em prod, **129.079 dos 217.635** headers de staging de fórmula (**59%**) pertencem a runs marcados `error` — o E5 marca como `error` todo run órfão >30min, cujo staging está íntegro e é lido legitimamente. O filtro congelaria a maior parte do catálogo e ainda faria o purge apagar o último `complete` por tratar um `error` como sucessor. **Lição:** antes de gatear por coluna categórica, **conte a distribuição real em prod** (mesma lição do `empresa_omie`).

**Design a avaliar (o Codex indicou; escolher UM):**
- `expected_item_count` (ou hash dos itens) no header de staging → a promoção só aceita a fórmula quando o nº de itens ingeridos bate. Fecha subconjunto **e** zero-itens sem depender de status de run.
- Publicação **pai+filhos atômica** (header+itens na mesma transação) ou estado imutável `ready` no header, escrito só após todos os itens.
- `is_base_pura` explícito → vazio **declarado** limpa a receita; vazio **ambíguo** barra (é o comportamento atual da v3).

**Critério de aceite:** PG17 prova que (a) subconjunto por fronteira de chunk NÃO substitui receita íntegra; (b) base pura declarada limpa; (c) ambígua barra + loga. Sem regressão nos 129k headers de runs `error`.

---

## Fase 2 — Fórmula canônica: eliminar a duplicata SL×SAYERLACK no catálogo (sem apagar)

**Por quê antes de desativar:** a ambiguidade (duas gêmeas idênticas no picker, preço divergente por construção — CSV só na SAYERLACK) é o maior blast radius. Resolver por SELEÇÃO canônica é reversível e não destrói dado; desativar dado vem depois (Fase 5).

**Files:**
- Create: view/RPC `v_tint_formula_canonica` (migration) — 1 fórmula por `(account, sku_id, cor_id)`
- Modify: `src/components/tintColorSelect/useTintColorSelect.ts` — busca (`:97`), alternativas (`:257`), busca global (`:122`) passam a ler a canônica
- Prova: `db/test-tint-canonica.sh` (PG17)

**Regra canônica (validar com Codex):**
- Preferência **SL** (geração viva); fallback SAYERLACK **só** quando não há SL válida no mesmo `(sku_id, cor_id)`.
- "SL válida" = ativa + receita não-vazia + RPC não-nula (base+corantes) + sync recente.
- **`ORDER BY` determinístico** (a busca hoje é `LIMIT 20` SEM `ORDER BY` — resultado não-determinístico; achado Codex).
- A canônica NÃO desativa nada — só escolhe qual servir. As 12 combinações sem gêmea SL continuam servindo SAYERLACK.

**Medição desta fase (a fazer com a RPC real, canário staff-gated):** delta de `preço_cobrado = max(round(RPC), round(CSV))` entre gêmeas — p50/p95/máx, direção, nº acima de 1%/5%/R$1/R$10. Dimensiona quanto a ambiguidade custava.

**Critério de aceite:** a busca do balcão retorna 1 linha por cor (não 2). PG17 prova a preferência SL + fallback + determinismo. Canária: cor com gêmea nas duas gerações → picker mostra só a SL.

**Risco:** mudar a query do picker é money-path de LEITURA — não pode esconder cor que só existe na SAYERLACK (as 12 + as 4 cores exclusivas). Assert explícito de não-desaparecimento.

---

## Fase 3 — Revalidação no submit (a fronteira que TODA via cruza)

**Por quê:** `selectTintPrice` isolado cai no CSV quando `pricing=null`; a segurança depende de cada consumidor tratar loading/erro. O cache de preço dura 5min → janela fail-open se receita/base mudar (ou após desativar SAYERLACK). Conversão de orçamento / edição / repetição não estão provadas — se copiam `sales_orders.items.valor_unitario` direto, bypassam a RPC (achados Codex). Money-path.md §5: guardar na fronteira comum, não na UI.

**Files:**
- Modify: `src/services/orderSubmission/*` + edge `omie-vendas-sync` (fronteira final `criar_pedido`/`alterar_pedido`)
- Enumerar as vias: `submitOrder`/`submitQuote`, `SalesQuotes.convertToOrder`, `useSalesOrderEdit`, retry idempotente, `replicar-pedido.ts`

**Mudanças:**
- No submit/conversão/edição/repetição: revalidar que a fórmula é **ativa + canônica** e recomputar o preço pela **RPC atual** (não confiar no cache de 5min nem no `valor_unitario` do item velho).
- **Override comercial explícito e auditado** com validade — não o "último preço" inferido eternamente dos 50 pedidos mais recentes sem filtro de status/cancelamento (`useTintColorSelect.ts:220`). Hoje esse "último preço" VENCE cálculo/CSV mesmo sendo menor.

**Critério de aceite:** PG17/canária provam que uma fórmula desativada ou com preço mudado é barrada/recomputada no submit, por TODAS as vias. Falsificação: remover o guard de uma via → PV com preço velho passa.

**Risco:** é o guard mais crítico (dinheiro real ao Omie). Codex xhigh no diff obrigatório.

---

## Fase 4 — TintPricing (simulador admin): usar a RPC, não motor paralelo

**Por quê:** `TintPricing.tsx:246-256` tem motor de preço PARALELO sem guard (`precoFinal = precoBase + custoCorantes`; receita vazia → `custoCorantes=0` → número fabricado só com base). Pior: aplica imposto/margem só à base e soma corantes crus (`:241`), enquanto a RPC não usa esses campos — a tela inteira está semanticamente desconectada do preço cobrado (achado Codex). O alerta de divergência (`:274`, `divergence>5`) não dispara quando ambos são baixos → convergência falsa numa tela de DECISÃO de preço.

**Files:** Modify `src/pages/TintPricing.tsx` (~240-282)

**Mudança:** trocar o cálculo local por `useTintPrices`/`selectAltPrice` (a mesma fonte honesta do balcão). NÃO basta `if (itens.length===0)` — o simulador está errado para qualquer corante sem Omie, inativo, volume inválido OU receita parcial.

**Critério de aceite:** o simulador mostra o MESMO preço que o balcão cobraria; fórmula vazia/parcial → "sem preço" honesto. Não vende (aba admin), então não há prova de venda — é correção de desinformação.

**Nota:** esta é a única fase "barata" e de baixo risco. Pode ir primeiro se você quiser um win rápido isolado, mas NÃO substitui as fases 1-3.

---

## Fase 5 — Soft-deactivation da geração SAYERLACK (só depois de 1-4)

**Por quê por último:** só é seguro desativar a geração legada depois que (a) o writer não recria parciais, (b) o catálogo serve a canônica, (c) o submit revalida. Desativar antes deixa janelas fail-open.

**Files:**
- migration de soft-deactivation (`desativada_em = now()` nas SAYERLACK com gêmea SL válida)
- watchdog: nenhum writer reativa/recria a geração `1`/SAYERLACK
- Prova: `db/test-tint-deactivate-sayerlack.sh`

**Critério seguro (Codex):**
- Cobertura por **combinação vendável** (sku_id+cor_id), não por cor. Medido: **12** sem gêmea SL válida → PRESERVAR essas 12 (inclui as 4 cores exclusivas ACR MAX: DOURADO 082P/035Y, PEROLIZADO 23.2429.CK.JO20, EMPERADORE 128L).
- Gêmea SL: ativa + receita não-vazia + RPC não-nula + sync recente.
- **Manifest reproduzível** de IDs mantidos/desativados (arquivo versionado).
- **Canário por produto/SKU** antes do rollout total.
- NÃO precisa provar que nenhum histórico aponta SAYERLACK. PRECISA provar: (a) histórico continua renderizando fórmula inativa; (b) pedido/orçamento aberto é migrado/revalidado (Fase 3 cobre); (c) repetir pedido resolve para a canônica (Fase 2 cobre); (d) nenhum writer reativa/recria.

**Risco:** irreversível na prática (embora `desativada_em` seja tecnicamente reversível). Gate humano explícito. Fazer por lotes com canário.

---

## Medições ainda pendentes (arqueologia / dimensionamento fino — não bloqueiam Fase 1)

- Delta de `preço_cobrado` entre gêmeas (p50/p95/máx) — **Fase 2**, com RPC real.
- Reconciliar 29.548 importados × 28.592 linhas da célula + explicar `importacao_id=NULL` em 28.604 (contradiz o código versionado de 23/03 → houve deploy diferente ou mutação posterior; **linhagem não provada**, só associação temporal).
- SHA realmente implantado em 23/03 + logs de `Erro inserindo itens formula`.
- Duplicidade `omie_product_id → tint_skus` (o hook usa `.limit(1)` sem ordem — `useTintColorSelect.ts:57-63`).
- Receita parcial na geração SL (o teste de residuo de volume NÃO funciona na SL, onde `vol_final = vol_embalagem`; precisa de outro oráculo).

---

## Achado (resumo para quem pega o plano frio)

28.609 fórmulas ATIVAS sem receita descobertas em 2026-07-17. **Não é catálogo legítimo** (prova aritmética: o `volume_final_ml` da fórmula vazia = volume da embalagem + a soma EXATA dos corantes da gêmea que tem receita — a linha contabiliza o corante que não tem). 99,9% concentradas na célula subcoleção SAYERLACK × produto `FL.6344 PU FUNDO`, importadas em 2026-03-23 por um CSV que reportou 29.548/29.548 sucessos e 0 erros gravando 0 receita — porque o parser conta FÓRMULA, não receita. O balcão de venda está **fail-closed** para as vazias (RPC `get_tint_price` devolve `precoFinal=NULL` via `bool_and` sobre conjunto vazio; `select-price.ts` bloqueia todas as fontes). Descobertas maiores no caminho: (1) **240 fórmulas com receita PARCIAL** = fail-OPEN (preço baixo válido, subfaturamento silencioso); (2) **duas gerações do catálogo inteiro coexistem ativas** (SAYERLACK 465k congelada + SL 493k viva) porque `subcolecao_id` está na unique key `uq_tint_formulas_chave` — quando o sync passou a mandar subcoleção `SL`, virou INSERT em vez de UPDATE e o catálogo dobrou. Inocentado: `tint_promote_sync_run` (só 4 das 28.609 vieram dele; padrão delete+insert no mesmo conjunto de chaves está correto).
