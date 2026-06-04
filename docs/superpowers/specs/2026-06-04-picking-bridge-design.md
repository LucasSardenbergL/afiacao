# Bridge de Picking da Oben — design

**Data:** 2026-06-04
**Frente:** ligar pedido de venda → task de separação (nasce idempotente, disparo manual) → confirmação fecha a task-pai.
**Escopo:** Oben (distribuidora). Colacor/colacor_sc ficam fora da v1.
**Revisões:** v2 incorpora 4 P1 + P2/P3 do Codex (adversarial no spec, 2026-06-04).

## Problema (gap verificado no código, não no CLAUDE.md)

O módulo de picking tem as duas pontas **mortas**:

1. **A task não nasce.** Nenhum código insere em `picking_tasks` (grep `insert/upsert` = zero no repo). As policies `authenticated_insert_picking_tasks` foram dropadas (migrations `20260510174508`/`20260511120918`); sobrou `staff_picking_tasks_all` (FOR ALL) — RLS **não** é o gap, é a ausência de um criador.
2. **A task não morre.** `src/services/picking-confirm.ts:33-57` insere o evento + faz UPDATE em `picking_task_items` mas **nunca toca a task-pai** — `picking_tasks.status/started_at/completed_at` ficam parados pra sempre. A task nunca vira `concluido`.

Resultado: as telas existem (desktop `AdminEstoquePicking` + mobile `TouchPickingView` offline-first) mas não há ciclo. O módulo aparenta estar **dormiente** (nenhuma task jamais criada em produção).

## Decisão-chave: nascimento MANUAL (não automático por status)

Durante a exploração descobri que o sinal que eu ia usar — `sales_orders.status='separacao'` — está **quebrado/contraditório na origem**:
- `omie-vendas-sync:1021` mapeia etapa `'50'` → `'separacao'` **só em pedido NOVO** (pula pedido existente por `hash_payload`, index.ts:995).
- `sync-reprocess:243` (cron ativo, `20260527230000_cron_baseline.sql`) atualiza pedido existente mapeando etapa `'50'` → **`'faturado'`** (mapa NÃO tem 'separacao').
- Nada mais seta 'separacao' (sem trigger além do `updated_at`; o `src/` nunca referencia esse status).

Logo, keyar o nascimento em `status='separacao'` acenderia raramente e errado, e consertar isso exigiria mexer no código quente dos syncs do Omie. **Decisão do founder (2026-06-04): a task nasce por DISPARO MANUAL** — o escritório/vendedor envia o pedido para separação pelo app. Confiável, operador no controle, **zero risco no money-path**.

## Arquitetura

Três peças, nenhuma toca os syncs do Omie. **Todas as RPCs `SECURITY DEFINER` + gate explícito staff** (employee/master) — lê `sales_orders` como owner (a RLS de `sales_orders` é `master|employee`, ≠ picking que ainda referencia `manager|master`; DEFINER evita o mismatch cross-tabela apontado pelo Codex P2), seta `account`/`status`/`user_id` **server-side** (anti-spoof), e blinda contra caller não-staff.

### 1. Helper puro (TDD) — `src/lib/picking/bridge-helpers.ts`

Lógica testável espelhada na SQL. **Importante:** a SQL é a executora; o helper é o **oráculo testado** que a SQL espelha verbatim (mesmo padrão dos engines de valor/regime).

- **`mapItemsToPickingRows(items: unknown): { rows: PickingItemRow[]; fractionalNotes: string[]; badCount: number }`**
  - `items` pode vir malformado (não-array, null). Se `!Array.isArray(items)` → `{ rows:[], fractionalNotes:[], badCount:0 }`.
  - `PickingItemRow` = `{ omie_codigo_produto: number|null; product_descricao: string; quantidade: number }`.
  - Para cada elemento:
    - `qtdRaw = elem.quantidade`. Valida numérico finito: se `null`/`undefined`/não-parseável (regex `^\s*[+-]?(\d+(\.\d+)?|\.\d+)\s*$` sobre a string, OU `Number.isFinite`) → `badCount++`, pula.
    - `qtd = Math.ceil(qtdNum)`. Se `qtd <= 0` → pula (não vira linha; não conta como bad).
    - Se `qtdNum` fracionário (`!Number.isInteger(qtdNum)`) → `fractionalNotes.push(\`SKU ${codigo ?? '—'}: ${qtdNum} → ${qtd} (arredondado p/ cima)\`)`.
    - `omie_codigo_produto`: se inteiro positivo → number; senão (textual/ausente) → `null` (separador usa a descrição; NÃO aborta).
    - `product_descricao = String(elem.descricao ?? '')`.
    - push `{ omie_codigo_produto, product_descricao, quantidade: qtd }`.
  - Retorna linhas + notas + badCount.

- **`deriveParentStatus(items: { quantidade: number; quantidade_separada: number }[]): { status: 'pendente'|'em_andamento'|'concluido' }`**
  - `total = Σ quantidade`, `done = Σ quantidade_separada`.
  - `done <= 0` → `pendente`; `total > 0 && done >= total` → `concluido`; senão → `em_andamento`. Lista vazia (`total=0`) → `pendente`.
  - Oráculo que a SQL `recalcular_picking_task` espelha.

### 2. Migration — `supabase/migrations/2026..._picking_bridge.sql` (apply manual no SQL Editor)

Entregue em blocos pro SQL Editor: **(BLOCO 0)** diagnóstico de dupes (rodar ANTES); **(BLOCO A)** índices + RPCs; **(validação)** SELECT confirmando objetos.

- **BLOCO 0 — diagnóstico (não cria nada):**
  ```sql
  SELECT sales_order_id, count(*) FROM public.picking_tasks
  WHERE sales_order_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
  ```
  Se voltar linhas, há dupes e o índice único falha → resolver antes. Esperado: 0 linhas (módulo dormiente).

- **Índice único parcial** (idempotência real): `CREATE UNIQUE INDEX IF NOT EXISTS uq_picking_tasks_sales_order ON public.picking_tasks (sales_order_id) WHERE sales_order_id IS NOT NULL;`
- **Índice de candidatos** (perf da lista "Pedidos a separar"): `CREATE INDEX IF NOT EXISTS idx_sales_orders_account_kpi ON public.sales_orders (account, order_date_kpi) WHERE deleted_at IS NULL;`

- **RPC `ensure_picking_task_for_sales_order(p_sales_order_id uuid) RETURNS jsonb`** — `SECURITY DEFINER SET search_path = public`:
  1. **Gate staff:** `IF NOT (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role)) THEN RAISE EXCEPTION 'forbidden: staff only'; END IF;`
  2. `pg_advisory_xact_lock(hashtextextended('picking_ensure:'||p_sales_order_id::text, 0))`.
  3. `SELECT id, account, status, deleted_at, items INTO v_so FROM sales_orders WHERE id = p_sales_order_id`. `NOT FOUND` → `RAISE 'pedido inexistente'`. `deleted_at IS NOT NULL OR status='cancelado'` → `RAISE 'pedido inelegível (cancelado/excluído)'`. **`IF lower(coalesce(v_so.account,'')) <> 'oben' THEN RAISE 'picking v1 somente Oben'; END IF;`** (P1.1 Codex).
  4. **Idempotência:** `SELECT id INTO v_task FROM picking_tasks WHERE sales_order_id = p_sales_order_id`. Achou → `RETURN jsonb_build_object('task_id', v_task, 'created', false)`.
  5. `INSERT INTO picking_tasks (sales_order_id, account, status) VALUES (p_sales_order_id, lower(v_so.account), 'pendente') ON CONFLICT (sales_order_id) WHERE sales_order_id IS NOT NULL DO NOTHING RETURNING id INTO v_task`. Se `v_task IS NULL` (corrida perdeu o conflito) → re-`SELECT` o existente, `RETURN created:false`.
  6. **Parsing blindado dos itens (P1.2 Codex):**
     ```sql
     v_items := CASE WHEN jsonb_typeof(v_so.items)='array' THEN v_so.items ELSE '[]'::jsonb END;
     FOR elem IN SELECT * FROM jsonb_array_elements(v_items) LOOP
       v_qraw := elem->>'quantidade';
       IF v_qraw IS NULL OR v_qraw !~ '^\s*[+-]?(\d+(\.\d+)?|\.\d+)\s*$' THEN
         v_bad := v_bad + 1; CONTINUE;
       END IF;
       v_qnum := v_qraw::numeric;
       v_qtd := ceil(v_qnum)::integer;
       IF v_qtd <= 0 THEN CONTINUE; END IF;
       -- código seguro: só inteiro vira bigint; textual → NULL
       v_cod := CASE WHEN (elem->>'omie_codigo_produto') ~ '^\d+$'
                     THEN (elem->>'omie_codigo_produto')::bigint ELSE NULL END;
       INSERT INTO picking_task_items (picking_task_id, omie_codigo_produto, product_descricao, quantidade, status)
       VALUES (v_task, v_cod, coalesce(elem->>'descricao',''), v_qtd, 'pendente');
       v_count := v_count + 1;
       IF v_qnum <> v_qtd THEN v_notes := v_notes || format('SKU %s: %s → %s; ', coalesce(elem->>'omie_codigo_produto','—'), v_qnum, v_qtd); END IF;
     END LOOP;
     ```
  7. **`IF v_count = 0 THEN RAISE EXCEPTION 'pedido sem itens válidos para separação'; END IF;`** (P2 Codex — não cria task vazia; o RAISE rollbacka a task inserida, transação atômica).
  8. Se `v_notes <> ''` → `UPDATE picking_tasks SET notes = 'Qtd fracionária arredondada: '||v_notes WHERE id = v_task`.
  9. `RETURN jsonb_build_object('task_id', v_task, 'created', true, 'item_count', v_count, 'bad_count', v_bad)`.

- **RPC `recalcular_picking_task(p_task_id uuid) RETURNS jsonb`** — `SECURITY DEFINER`:
  - Gate staff (idem).
  - `SELECT COALESCE(sum(quantidade),0) total, COALESCE(sum(quantidade_separada),0) done FROM picking_task_items WHERE picking_task_id = p_task_id`.
  - Deriva: `done<=0 → pendente`; `total>0 AND done>=total → concluido`; senão `em_andamento`.
  - `UPDATE picking_tasks SET status=v_status, started_at = COALESCE(started_at, CASE WHEN v_status<>'pendente' THEN now() END), completed_at = CASE WHEN v_status='concluido' THEN COALESCE(completed_at, now()) ELSE NULL END WHERE id=p_task_id`. (`updated_at` é mantido pelo trigger existente.)
  - `RETURN jsonb_build_object('status', v_status)`.

- **RPC `confirmar_item_picking(p_event_id uuid, p_task_id uuid, p_item_id uuid, p_quantidade_separada integer, p_lote_informado text, p_justificativa text, p_confirmed_at timestamptz) RETURNS jsonb`** — `SECURITY DEFINER` — **substitui as 2 chamadas soltas do `confirmPickItem` por uma transação atômica** (P1.3 Codex — evento + item + recalc juntos; sem janela de pai-stale; idempotente p/ replay offline):
  1. Gate staff.
  2. Lê o item server-side: `SELECT quantidade, lote_fefo INTO v_item FROM picking_task_items WHERE id = p_item_id AND picking_task_id = p_task_id`. `NOT FOUND` → `RAISE 'item inexistente'`.
  3. `v_divergente := (p_lote_informado IS NOT NULL AND v_item.lote_fefo IS NOT NULL AND p_lote_informado <> v_item.lote_fefo)`; `v_etype := CASE WHEN v_divergente THEN 'lote_divergente' ELSE 'item_confirmado' END`.
  4. `INSERT INTO picking_events (id, picking_task_id, picking_task_item_id, event_type, lote_esperado, lote_informado, justificativa, user_id) VALUES (p_event_id, p_task_id, p_item_id, v_etype, v_item.lote_fefo, p_lote_informado, p_justificativa, auth.uid()) ON CONFLICT (id) DO NOTHING;` (idempotência por PK = eventId; `user_id = auth.uid()` server-side, não confia no client).
  5. `v_status_item := CASE WHEN p_quantidade_separada >= v_item.quantidade THEN 'concluido' ELSE 'em_andamento' END`; `UPDATE picking_task_items SET quantidade_separada = p_quantidade_separada (ABSOLUTO), status = v_status_item, lote_separado = p_lote_informado, justificativa_substituicao = p_justificativa, separado_at = p_confirmed_at WHERE id = p_item_id`.
  6. Chama a lógica do recalc (inline ou `PERFORM recalcular_picking_task(p_task_id)`) → fecha a task-pai na MESMA transação.
  7. `RETURN jsonb_build_object('ok', true, 'parent_status', v_parent_status)`.
  - **Idempotência no replay:** evento no-op (ON CONFLICT), update absoluto (mesmos valores), recalc função pura do estado → seguro re-rodar.

- **Grants:** `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon; GRANT EXECUTE ... TO authenticated` nas 3 RPCs.

### 3. Frontend

- **`confirmPickItem` (`src/services/picking-confirm.ts`) reescrito p/ 1 chamada à RPC `confirmar_item_picking`** (era 2 supabase calls). Mantém a **mesma interface `ConfirmPickItemVars`** (pra não tocar o optimistic-merge nem a fila offline) — só o corpo muda: `await supabase.rpc('confirmar_item_picking', { p_event_id: vars.eventId, p_task_id: vars.pickingTaskId, p_item_id: vars.pickingTaskItemId, p_quantidade_separada: vars.quantidadeSeparada, p_lote_informado: vars.loteInformado, p_justificativa: vars.justificativa, p_confirmed_at: vars.confirmedAt })`. Trata erro como hoje (lança → `useOfflineMutation` enfileira se for rede, rollback otimista se for app). `userId`/`quantidade`/`loteEsperado` da interface viram ignorados pela RPC (derivados server-side) mas seguem no payload (compat com optimistic-merge que usa `quantidadeSeparada`/`loteInformado`).
- **"Pedidos a separar"** — nova aba/seção em `AdminEstoquePicking`. Query: `sales_orders` (`select id, customer_user_id, total, status, order_date_kpi, created_at`) LEFT JOIN anti-`picking_tasks` (sem task), `account = pickingAccount`, `deleted_at IS NULL`, `status NOT IN ('cancelado','rascunho')`, janela `COALESCE(order_date_kpi, created_at::date) >= (hoje - 60d)` (P1.4 Codex — NÃO usar `created_at` cru, que é data do pedido no Omie e pode ser futura), `ORDER BY order_date_kpi DESC`, `LIMIT 100`. Implementado via 2 queries (PostgREST não faz anti-join direto): (a) candidatos por account+deleted+status+janela; (b) `picking_tasks.sales_order_id` existentes desse account; filtra em memória os sem task. Mostra cliente/total/**status (com aviso de que o status do Omie é não-confiável)**/data + botão **"Enviar para separação"** → `useEnviarParaSeparacao` (RPC `ensure_...`) → toast + invalida `['pk-pedidos-a-separar']` e `['pk-picking-list']`. **Sem multi-select na v1** (YAGNI — Codex P3); 1 botão por pedido.
- **Casing (P1 Codex D8):** `const pickingAccount = account.toLowerCase()` aplicado **só** nas queries de `picking_tasks` do `AdminEstoquePicking` (`KpiCards`, `PickingTab`, `AuditoriaTab`, nova lista). **Não** mexer no `account` state global nem nas queries de `inventory_position`. `TouchPickingView` já usa lowercase 'oben'.
- **Fix KPI `useEstoqueZone.ts:65`:** conta só `status='pendente'`; ajustar p/ `in ('pendente','em_andamento')`.

## Fluxo de dados

```
[escritório/vendedor] Picking → aba "Pedidos a separar" → vê pedidos Oben elegíveis sem task
  → "Enviar para separação" → RPC ensure_picking_task_for_sales_order
     → cria picking_tasks (pendente, account=oben) + picking_task_items (do items jsonb, qtd=ceil)
  → task aparece em "Picking" (desktop) e TouchPickingView (mobile)

[separador] TouchPickingView → task → confirma item
  → confirmPickItem → RPC confirmar_item_picking (evento + item + recalc, atômico)
     → task-pai em_andamento (1º) … concluido (todos) + completed_at
  → task some das abertas (KPI fecha)
```

## Idempotência & corrida

- **Nascimento:** advisory lock + `IF NOT EXISTS` + índice único parcial + `ON CONFLICT DO NOTHING`. Duplo-clique / 2 telas → 1 task. Transação única: RAISE em qualquer ponto rollbacka task+itens (sem task órfã vazia — `item_count>0` garantido).
- **Morte:** RPC única atômica (evento+item+recalc); idempotente no replay offline (evento por PK, update absoluto, recalc puro). Sem janela de pai-stale (resolve a falha que o Codex P1.3 apontou no modelo de 3 chamadas).

## Reconciliação (pedido que sai da elegibilidade depois)

Modelo manual → sem flood. Casos de borda:
- Pedido ganha task e **depois** é cancelado/faturado/excluído no Omie → task aberta fica "stale". v1: `ensure` recusa criar pra cancelado/excluído (guard na origem); fechamento automático quando o pedido muda de estado = **v2** (dependeria do status não-confiável). A aba "Pedidos a separar" não re-lista (já tem task).
- Editar itens do pedido depois da task criada → a task **congela** os itens do momento (não re-sincroniza). v1 consciente.

## Segurança

- **3 RPCs `SECURITY DEFINER` + gate explícito staff (employee/master)** → lê `sales_orders` como owner (evita o mismatch RLS picking×sales_orders do Codex P2), seta `account`/`status`/`user_id` server-side (anti-spoof), Oben-guard no `ensure`. `service_role` não envolvido. Grants: `REVOKE FROM PUBLIC, anon` + `GRANT EXECUTE TO authenticated`.

## Não-objetivos (v1)

- Cron de materialização proativa (P2; o disparo manual cobre).
- Sugestão FEFO (`lote_fefo/validade_fefo/localizacao` ficam NULL — sem fonte confiável por SKU; o confirm captura `lote_informado`).
- Fechamento automático de task quando o pedido vira cancelado/faturado/excluído (v2 — depende do status não-confiável).
- Re-sync de itens da task quando o pedido é editado (v1 congela).
- Conserto dos mapas de etapa contraditórios dos syncs (money-path; o nascimento manual não depende disso).
- Picking de colacor/colacor_sc (v1 = oben).
- Mudar `picking_task_items.quantidade` p/ numeric (v1 usa ceil + nota).
- Multi-select no "Enviar para separação" (1 botão por pedido).

## Critério de pronto

- Helper `bridge-helpers.ts` com testes vitest: `mapItemsToPickingRows` (ceil; fracionário→nota; qtd≤0 ignorada; qtd inválida→badCount; código textual→null; items não-array→vazio) + `deriveParentStatus` (4 ramos + lista vazia).
- Migration aplicada via SQL Editor (BLOCO 0 = 0 dupes → BLOCO A índices+3 RPCs → validação confirma 3 RPCs + 2 índices).
- "Enviar para separação" cria task+itens (idempotente: 2º clique não duplica; pedido não-Oben/cancelado recusado; pedido sem itens válidos recusado).
- Confirmar todos os itens de uma task → task-pai `concluido` + `completed_at` (KPI "Tasks Abertas" decrementa); offline → enfileira e reconcilia no replay.
- CI verde (typecheck strict + test + lint + build).
