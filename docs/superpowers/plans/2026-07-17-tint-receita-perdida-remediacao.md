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

## Fase 1 (P0) — Fronteira de escrita do import: fail-closed por-linha + transacional

**Por quê primeiro:** é o único defeito ATIVO que corrompe dado novo. As 240 parciais calculam preço baixo *válido* (fail-open); o contador "N sem receita" que eu havia proposto é observabilidade, não defesa (achado Codex). O preflight cliente (`preflight-formulas.ts`) NÃO cobre o endpoint de escrita quando o CSV entra por chunks — a fronteira única é o cliente, mas o writer server-side tem de ser defesa-em-profundidade fail-closed por-linha.

**Files:**
- Modify: `supabase/functions/tint-import/index.ts` — `processFormulas` (~235-333) e o lookup (~304)
- Possível: nova RPC SQL `tint_upsert_formula_com_itens(...)` para atomicidade header+itens (migration)
- Prova: `db/test-tint-import-fail-closed.sh` (PG17)

**Mudanças (cada uma é um assert do prove-sql):**
1. **Rejeitar receita parcial:** se QUALQUER slot de corante presente falhar a conversão (`qtd` null/≤0) → rejeitar a LINHA inteira (`errors++` + `errosDetalhe`), não gravar os corantes válidos. Hoje (`:282-294`) o slot ruim é pulado silenciosamente → receita parcial gravada.
2. **Header+itens atômicos:** hoje `delete` (`:325`) + `insert` (`:327`) não são transacionais e o erro do insert só vai a `console.error` (`:328`). Envolver numa RPC `SECURITY DEFINER` transacional (BEGIN/EXCEPTION) OU garantir rollback. O insert de itens que falha DEVE reverter o header e contar como erro.
3. **Contar sucesso só após commit dos itens:** `imported++`/`updated++` (`:319`/`:314`) sobem antes/independente dos itens. Mover para depois do commit. Guard de reconciliação: `imported + updated + errors == total` (senão status `parcial`, nunca `concluido`).
4. **Corrigir lookup de subcoleção (`:304`):** `.is("subcolecao_id", subcolecaoId ? undefined : null)` — para subcoleção não-nula, usar `.eq("subcolecao_id", subcolecaoId)`; tratar o erro da consulta (hoje ignorado). Mitigado pelo `upsert onConflict:'chave'` no else, mas o UPDATE pode ir ao registro errado.

**Critério de aceite:** PG17 prova que (a) linha com corante+qtd-inválida é REJEITADA (não grava parcial), (b) falha de insert de item reverte o header, (c) `imported+updated+errors==total`, (d) falsificação: reverter cada guard → vermelho no assert certo. Canária: reprocessar um CSV com 1 linha parcial → `registros_erro >= 1`, receita não gravada.

**Risco:** o edge é reescrito pelo Lovable no deploy ("melhora") → deploy VERBATIM do repo + verificar por comportamento. Atomicidade via RPC muda o contrato do edge — testar chunk mode + finalize.

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
