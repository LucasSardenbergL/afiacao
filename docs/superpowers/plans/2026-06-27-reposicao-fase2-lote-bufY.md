# Reposição Fase 2 — Lote enxuto + buffer Y (recalibração do motor) · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans para implementar task-a-task. Steps usam checkbox (`- [ ]`).

**Goal:** Recalibrar a view `v_sku_parametros_sugeridos` para que, **só nos SKUs Sayerlack**, o lote de compra seja dimensionado pela demanda do lead time (não pelo EOQ inflado) e as classes intermitentes (Y) ganhem buffer — encolhendo o `estoque_maximo` de giro lento, liberando ~14% de capital e destravando o piloto de auto-aprovação, sem aumentar ruptura.

**Architecture:** A fórmula vive na view (não na RPC `gerar_pedidos_sugeridos_ciclo`, que só LÊ `sku_parametros`). Mudança via `CREATE OR REPLACE VIEW` (preserva nomes/ordem de colunas), condicionada por `fornecedor_nome ILIKE '%SAYERLACK%'`. Aplicação via esteira `param_auto` existente (OBEN-only, fusível/pin/log). Prova local PG17 com falsificação → Codex challenge → apply manual no SQL Editor (Lovable).

**Tech Stack:** PostgreSQL 17 (Supabase), psql-ro (diagnóstico read-only), harness `db/test-*.sh` (PG17 efêmero), Codex (challenge xhigh), Lovable SQL Editor (apply manual).

**Decisão validada (spec):** política **bufY** — lote = `GREATEST(1, round(d·LT))`; buffer = `z + 0,8` nas classes terminadas em Y. Backtest: serviço ponderado por R$ 98,1% (vs 96,3% atual), capital −14% (conservador). Lote=1 fixo é RUIM (91,9%) — o lote PRECISA cobrir a demanda do lead.

---

## File Structure

- **Create:** `supabase/migrations/<NOVO_TS>_reposicao_fase2_lote_bufY.sql` — `CREATE OR REPLACE VIEW v_sku_parametros_sugeridos` (capturada da prod + 2 expressões alteradas). ⚠️ Migration NOVA (timestamp novo) — nunca editar a `20260606150000` existente (snapshot DR).
- **Create:** `db/test-fase2-lote-bufY.sh` — harness PG17 da fórmula nova (modelado em `db/test-param-auto.sh`).
- **Reference (não modificar):** `supabase/migrations/20260606150000_a2_cmc_base_custo_view.sql` (view atual, linhas 249-317), `db/test-param-auto.sh` (padrão de harness), `20260605150000_param_auto_fusivel_calibracao.sql` (apply).

---

## Task 1: Capturar a view vigente da prod + escrever a migration candidata

**Files:**
- Create: `supabase/migrations/<NOVO_TS>_reposicao_fase2_lote_bufY.sql`

- [ ] **Step 1: Pré-flight — capturar a definição EXATA da view na prod**

A view aplicada pode divergir do repo (apply manual). A captura da PROD é a fonte verdadeira pro `CREATE OR REPLACE`.

Run:
```bash
~/.config/afiacao/psql-ro -At -c "SELECT pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true);" > /tmp/view_atual.sql
wc -l /tmp/view_atual.sql   # esperado ~330 linhas
```
Expected: arquivo com a definição vigente (WITH ... SELECT ...).

- [ ] **Step 2: Confirmar que `fornecedor_nome`, `d` e `lt` fluem até o SELECT final**

O condicionamento por fornecedor precisa de `fornecedor_nome` no mesmo escopo onde `estoque_maximo_sugerido` é montado. `d` (demanda_media_diaria) e o lead time também.

Run:
```bash
grep -nE "fornecedor_nome|AS d,|d," /tmp/view_atual.sql | head
grep -nE "lead_time_medio|lt_total_teorico|GREATEST\(lts" /tmp/view_atual.sql | head
```
Expected: identificar o nome exato da coluna de lead a usar no lote (`lead_time_medio` derivado, ou `lt`). Se `fornecedor_nome` NÃO estiver no CTE final, propagá-lo pelos CTEs (adicionar à lista de SELECT de cada CTE intermediário — alteração mecânica, preserva ordem das colunas de SAÍDA).

- [ ] **Step 3: Escrever a migration candidata com as 2 mudanças**

Copiar `/tmp/view_atual.sql` para o arquivo da migration, prefixar com `CREATE OR REPLACE VIEW public.v_sku_parametros_sugeridos AS`, e alterar SOMENTE estas duas expressões:

**Mudança A — lote enxuto (no `qtde_compra_ciclo_sugerida` e no `estoque_maximo_sugerido`):** substituir as 2 ocorrências de `GREATEST(qc_eoq, (1)::numeric)` por um lote condicionado a Sayerlack:
```sql
-- lote: Sayerlack usa demanda-do-lead (custo de pedido ~0 no portal); demais mantêm EOQ
CASE WHEN fornecedor_nome ILIKE '%SAYERLACK%'
     THEN GREATEST((1)::numeric, round(d * lead_time_medio))
     ELSE GREATEST(qc_eoq, (1)::numeric)
END
```
(usar o nome de coluna de lead confirmado no Step 2 no lugar de `lead_time_medio`).

**Mudança B — buffer Y (no `z_aplicado`, ~linha 129-132):** somar 0,8 ao z das classes Y:
```sql
-- ANTES:
CASE classe_abc WHEN 'A' THEN cfg.z_classe_a WHEN 'B' THEN cfg.z_classe_b ELSE cfg.z_classe_c END AS z_aplicado
-- DEPOIS:
(CASE classe_abc WHEN 'A' THEN cfg.z_classe_a WHEN 'B' THEN cfg.z_classe_b ELSE cfg.z_classe_c END
 + CASE WHEN classe_xyz_proposta = 'Y' AND fornecedor_nome ILIKE '%SAYERLACK%' THEN 0.8 ELSE 0 END) AS z_aplicado
```
(se `fornecedor_nome` não estiver nesse CTE, propagá-lo — Step 2).

- [ ] **Step 4: Verificar que SÓ as expressões mudaram (colunas preservadas)**

`CREATE OR REPLACE VIEW` falha se a lista/ordem/tipo de colunas de saída mudar.

Run:
```bash
# extrair só os nomes das colunas de saída de cada versão e diffar
diff <(grep -oE "AS [a-z_]+," /tmp/view_atual.sql) <(grep -oE "AS [a-z_]+," supabase/migrations/<NOVO_TS>_reposicao_fase2_lote_bufY.sql)
```
Expected: **diff vazio** (zero mudança na lista de colunas de saída). Se houver diff, a estrutura foi alterada — corrigir.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/<NOVO_TS>_reposicao_fase2_lote_bufY.sql
git commit -m "feat(reposicao-fase2): view v_sku_parametros_sugeridos — lote demanda-do-lead + buffer Y (Sayerlack)"
```

---

## Task 2: Harness PG17 da fórmula nova (prova + falsificação)

**Files:**
- Create: `db/test-fase2-lote-bufY.sh`

- [ ] **Step 1: Escrever o harness (modelado em `db/test-param-auto.sh`)**

Estrutura: sobe PG17 efêmero (PGVER=17, porta livre, `mktemp` data, `initdb`+`pg_ctl`), carrega o prelude de extensões + a migration da view nova, semeia as tabelas-fonte com SKUs de cada classe e fornecedor, e roda asserts num bloco `DO $$`. Seeds (mínimo viável): 1 SKU `AX` Sayerlack (d alto), 1 `CZ` Sayerlack (d ínfimo, giro lento), 1 `BY` Sayerlack (intermitente), 1 SKU não-Sayerlack qualquer classe. Valores de d, lead, σ, preço conhecidos para prever o resultado.

- [ ] **Step 2: Asserts da fórmula**

```sql
DO $$
DECLARE r record;
BEGIN
  -- A) Sayerlack giro lento (CZ): lote = max(1, round(d·LT)), NÃO o qc_eoq inflado
  SELECT estoque_maximo_sugerido AS mx, ponto_pedido_sugerido AS pp, qtde_compra_ciclo_sugerida AS lote
    INTO r FROM v_sku_parametros_sugeridos WHERE sku_codigo_omie='CZ_SAY';
  ASSERT r.lote = GREATEST(1, round(0.014 * 10)), format('lote CZ_SAY=% (esperado max(1,round(d·LT))=1)', r.lote);
  ASSERT r.mx = r.pp + r.lote, format('máximo CZ_SAY=% != ponto+lote', r.mx);

  -- B) não-Sayerlack: lote inalterado (= qc_eoq) — escopo cirúrgico não vazou
  SELECT qtde_compra_ciclo_sugerida AS lote INTO r FROM v_sku_parametros_sugeridos WHERE sku_codigo_omie='AX_OUTRO';
  ASSERT r.lote > round(0.5 * 10), 'lote de fornecedor não-Sayerlack NÃO deveria virar demanda-do-lead (vazamento de escopo)';

  -- C) buffer Y: classe BY Sayerlack tem ss MAIOR que o teórico sem buffer
  SELECT estoque_seguranca_sugerido AS ss INTO r FROM v_sku_parametros_sugeridos WHERE sku_codigo_omie='BY_SAY';
  ASSERT r.ss >= ceil((1.28 + 0.8) * 0.0 + 1), 'buffer Y não aplicado (ss da classe Y deveria refletir z+0,8)';  -- ajustar limiar ao seed real

  -- D) ponto preservado (proteção intacta): pp = ceil(d·LT + z_efetivo·σ_lt_d) — não zerou
  SELECT ponto_pedido_sugerido AS pp INTO r FROM v_sku_parametros_sugeridos WHERE sku_codigo_omie='AX_SAY';
  ASSERT r.pp >= 1, 'ponto AX_SAY não pode ser nulo/zero (proteção sumiu)';
  RAISE NOTICE 'OK — fórmula fase 2 validada';
END $$;
```

- [ ] **Step 3: Rodar o harness — esperar verde**

Run: `heavy bash db/test-fase2-lote-bufY.sh > /tmp/t2.log 2>&1; echo $?`
Expected: exit `0`, log com `OK — fórmula fase 2 validada`.

- [ ] **Step 4: Falsificação (sabotar → exigir vermelho)**

Temporariamente trocar `0.8` por `0.0` (remover o buffer Y) na migration e re-rodar:
Run: `heavy bash db/test-fase2-lote-bufY.sh > /tmp/t2sab.log 2>&1; echo $?`
Expected: exit `≠0`, assert C falha. **Reverter a sabotagem** (voltar 0,8) e confirmar verde de novo. (Sem vermelho na sabotagem = o teste é teatro.)

- [ ] **Step 5: Commit**

```bash
git add db/test-fase2-lote-bufY.sh
git commit -m "test(reposicao-fase2): harness PG17 da view nova — lote/buffer/escopo + falsificação"
```

---

## Task 3: Query de impacto pré-apply (prova de destravamento)

**Files:** nenhum (query read-only de diagnóstico).

- [ ] **Step 1: Comparar estoque_maximo ANTES (aplicado) vs DEPOIS (view nova) nos Sayerlack**

A view nova já calcula o novo `estoque_maximo_sugerido`. Comparar com o `estoque_maximo` aplicado hoje para projetar o encolhimento do pedido.

Run (após o apply da view em Task 5, ou contra uma cópia local):
```sql
SELECT COALESCE(p.classe_consolidada,p.classe_abc) classe, count(*) n,
  round(avg(p.estoque_maximo)) max_hoje,
  round(avg(v.estoque_maximo_sugerido)) max_novo,
  round(100*(1 - avg(v.estoque_maximo_sugerido)/NULLIF(avg(p.estoque_maximo),0))) reducao_pct
FROM sku_parametros p
JOIN v_sku_parametros_sugeridos v ON v.empresa=p.empresa AND v.sku_codigo_omie::text=p.sku_codigo_omie::text
WHERE p.empresa='OBEN' AND p.fornecedor_nome ILIKE '%SAYERLACK%' AND p.ativo AND p.demanda_media_diaria>0
GROUP BY 1 ORDER BY 1;
```
Expected: `max_novo < max_hoje` nas classes de giro lento (B/C); classe A ~estável. Documentar a redução média projetada.

---

## Task 4: Codex challenge (money-path, antes do apply)

- [ ] **Step 1: Submeter migration + harness + resultado do backtest ao Codex (xhigh, read-only)**

Foco do challenge: (a) a condição `fornecedor_nome ILIKE '%SAYERLACK%'` não vaza pra outros fornecedores nem quebra com NULL; (b) `round(d·LT)` não zera o lote de SKUs de giro rápido (classe A); (c) `CREATE OR REPLACE` realmente preserva a ordem/tipo das colunas (senão o apply falha); (d) interação com `param_auto`: cold-start (max_antes NULL → bloqueado_validacao), fusível upward-only (redução nunca segura — OK), pin; (e) o buffer Y no `z_aplicado` não estoura nenhum CHECK/tipo.

Run:
```bash
codex exec "$(cat <prompt com a migration + db/test-fase2 + tabela do backtest>)" -C "$(pwd)" -s read-only
```

- [ ] **Step 2: Incorporar P1 do Codex** (se houver) na migration/harness e re-rodar Task 2.

---

## Task 5: Apply manual (founder) + recompute via param_auto

**Files:** nenhum (operação em prod via SQL Editor do Lovable).

- [ ] **Step 1: Pré-flight final — re-capturar a view da prod (a última a recriar vence)**

Run: `~/.config/afiacao/psql-ro -At -c "SELECT pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true);" > /tmp/view_preapply.sql; diff /tmp/view_atual.sql /tmp/view_preapply.sql`
Expected: diff vazio (ninguém recriou a view no meio). Se divergiu, rebasear a migration sobre a nova captura.

- [ ] **Step 2: Founder cola a migration no SQL Editor do Lovable e roda.** Entregar o SQL e instruir o passo (🟣 Lovable → SQL Editor → cola → Run).

- [ ] **Step 3: Verificar a view recriada**

Run: `~/.config/afiacao/psql-ro -At -c "SELECT pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true);" | grep -c "SAYERLACK"`
Expected: `≥2` (as 2 condições de fornecedor presentes) → a view nova está aplicada.

- [ ] **Step 4: Rodar o recompute/param_auto pra OBEN** (founder cola, ou cron diário já faz). A função de apply (`atualizar_parametros_numericos_skus('OBEN')` via wrapper diário) lê a view nova e atualiza `sku_parametros` com fusível/pin/log.

- [ ] **Step 5: Verificar o apply**

Run:
```sql
SELECT status, count(*) FROM reposicao_param_auto_log
WHERE run_id=(SELECT id FROM reposicao_param_auto_run WHERE empresa='OBEN' ORDER BY criado_em DESC LIMIT 1)
GROUP BY 1;
-- + reconciliar: ponto/máximo aplicado nos Sayerlack bate com a view nova; não-Sayerlack inalterado
```
Expected: maioria `aplicado` nos Sayerlack; `bloqueado_validacao`/`segurado` justificáveis; não-Sayerlack `sem_mudanca`.

---

## Task 6: Monitor de ruptura + destravamento do piloto (2-3 semanas)

- [ ] **Step 1: Query de monitor (rodar semanal)** — ruptura real (estoque chegou a zero em SKU Sayerlack que vendeu) + tamanho médio dos pedidos sugeridos (deve cair pro patamar que o founder aprova).

- [ ] **Step 2: Acompanhar o piloto destravar** — o check-in seg/qui (`revisar-piloto-auto-aprovacao-sayerlack`) deve passar a registrar auto-aprovações (pedidos menores ≤ mediana×1,30). Se a ruptura real exceder o projetado do backtest, reverter via fusível `param_auto` (BLOCO B reverso) e recalibrar o buffer.

- [ ] **Step 3: Registrar o resultado** em `docs/historico/` (ou `docs/agent/reposicao.md`) — antes/depois de capital e do tamanho dos pedidos, e o destravamento do piloto. Decidir sobre espalhar pros demais fornecedores/empresas.

---

## Self-Review (preencher ao concluir a escrita)

- **Spec coverage:** §3.1 (lote+buffer Y) → Task 1; §3.3 backtest → já executado (spec); §3.3.1 guardrails Codex → Task 4; §3.4 rollout param_auto → Task 5; §5 riscos (ruptura/LT/rajada/cauda) → backtest+Task 6 monitor. ✓
- **Escopo cirúrgico:** condição de fornecedor (Task 1) + param_auto OBEN-only + Task 2 assert B (não-vazamento). ✓
- **Reversibilidade:** fusível `param_auto` + pin (Task 6 Step 2). ✓
- **Pendência conhecida:** o nome exato da coluna de lead pro lote e se `fornecedor_nome`/`classe_xyz_proposta` fluem até os CTEs certos — resolvido no Step 2 da Task 1 ao ler a estrutura completa.
