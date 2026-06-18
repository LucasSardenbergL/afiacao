# Atomicidade pai+filho do sync de pedidos Omie (`sales_orders`/`order_items`) — Design

> **Origem:** achado #5 do `/codex challenge` (2026-06-17) ao revisar o sub-projeto 1 do [cursor+lease de vendas](./2026-06-17-vendas-omie-cursor-lease-design.md). **Débito pré-existente** — não foi introduzido pelo cursor/lease; é independente e pode (deve) ser entregue antes dele.
>
> **Money-path crítico:** `order_items` alimenta positivação/OTE/comissão dos farmers (`fin-valor-cockpit` usa `order_items.created_at >= ttm_inicio`; views `v_caca_*`). `sales_price_history` alimenta o preço-cliente sugerido (`analyze-unified-order`, `useCustomerSelection`). Erro aqui = dinheiro errado. Segue `docs/agent/money-path.md` (precisão>recall, gate humano, prove-sql, Codex em cada etapa).
>
> **2ª opinião:** `/codex consult` (reasoning high, 2026-06-17) — validou a direção (RPC transacional) e adicionou 7 guards (ver §4). **Codex challenge adversarial do CÓDIGO** fica para o PR (pós-implementação).

## 1. Problema

Em `supabase/functions/omie-vendas-sync/index.ts`, `syncPedidos` (linhas 902-1320), o pai (`sales_orders`) e o filho (`order_items`) são escritos em **duas chamadas PostgREST `.insert()` separadas** — `index.ts:1217` (pai, com `.select('id, hash_payload')`) e `index.ts:1300` (itens em batch). Cada `.insert()` é **um POST HTTP = uma transação Postgres distinta**: pai e filho nunca compartilham transação. Se o pai entra e os itens falham, o pedido fica **órfão (sem itens)**. Três caminhos:

- **(A)** batch de itens falha → só `console.error` (`index.ts:1301`), **nunca re-tentado**;
- **(B)** fallback one-by-one: insere o pai single (`index.ts:1228`) e depois `order_items.insert` (`index.ts:1249`) **sem checar erro nenhum**;
- **(C)** 1 item inválido derruba um batch de 200 itens que é **cross-pedido** (`allItemRows` agrega itens de vários pedidos), orfanando **vários pais de uma vez**.

**Trinco (não é self-healing):** a próxima invocação pré-carrega todos os `hash_payload` de pai em memória (`existingHashes`, `index.ts:944-961`) e na `index.ts:1140` faz `if (existingHashes.has(hash)) { skippedExisting++; continue }` → **pula o pedido inteiro, nunca olha os itens** → os itens faltantes **nunca são reparados**.

## 2. Estado atual (empírico — `psql-ro` prod, 2026-06-17)

| Fato | Valor |
|---|---|
| Pais Omie sem itens (órfãos) | **405** de 6255 (**6,5%**) |
| Órfãos presos >90d (não reaparecem na janela do cron) | **~358 (88%)** — `oben` 400 / `colacor` 5; mais antigo 2020 |
| Status dos órfãos | **374 "faturado"** (92%) = comissão real faltando |
| Índice `uniq_sales_orders_omie_hash (account, hash_payload) WHERE hash_payload LIKE 'omie_%'` | **NÃO existe em prod** (migration 20260617133634 escrita mas não aplicada — falha silenciosa Lovable). 0 dups → **criável limpo** |
| `order_items.hash_payload` | **nullable, sem UNIQUE; 363 grupos duplicados LEGÍTIMOS** (hash = `omie_<acct>_<pedido>_<produto>`; mesmo produto em 2 linhas do pedido colide). Histórico já dropou `UNIQUE(sales_order_id, omie_codigo_produto)` (cc886ba2) |
| FK | `order_items.sales_order_id → sales_orders.id ON DELETE CASCADE` |
| `order_items.created_at` | sync atual **não seta** → `DEFAULT now()`. Consumido por `fin-valor-cockpit` (TTM) e `v_caca_*` → money-path |
| `ConsultarPedido` | **já usado** no edge (`index.ts:1615`, reconciliação de duplicado) → reusável no job de reparo |

**Leitura:** a não-atomicidade é a causa raiz. O hash do item **não é naturalmente único** → idempotência do reparo tem que ser por "este pedido já tem itens?" (NOT EXISTS), não por `ON CONFLICT` no item. 88% dos órfãos estão **presos fora da janela** → o reparo do histórico é um **job dedicado** (`ConsultarPedido`), não efeito colateral do skip-path.

## 3. Decisões (founder 2026-06-17 + Codex)

| Decisão | Escolha |
|---|---|
| Correção | **RPC transacional** (fronteira única no Postgres), não 2 inserts PostgREST. Descarta "Opção 2 pura" (mantém janela de corrupção + não fecha corrida). |
| Escopo | **Pacote completo numa entrega:** prevenção (RPC+índice+edge) **+** job de reparo dos ~358 presos (`ConsultarPedido` → mesma RPC). |
| `sales_price_history` | **Dentro da mesma transação da RPC** (é money-path; custo trivial). |
| Reconciliação de pedido **alterado** (total/status/cliente/data) | **PROIBIDA** (Fase 2). Reparo só preenche relação filha **ausente** de cabeçalho **compatível**. |
| Quem executa | Migration/edge deploy = **humano** (SQL Editor + chat Lovable, verbatim). Monitoramento/disparo de reparo = **eu via `psql-ro`** + o humano aciona o job. |

## 4. Guards money-path (os 7 do Codex + 3 derivados viram requisitos)

- **G1 — `SECURITY INVOKER`, não `DEFINER`.** O edge já usa `service_role`. `GRANT EXECUTE` só `service_role`; `REVOKE FROM PUBLIC, anon, authenticated`. `SET search_path = ''` + nomes qualificados (`public.…`). (DEFINER seria write-primitive que bypassa RLS à toa.)
- **G2 — `ON CONFLICT (account, hash_payload) WHERE hash_payload LIKE 'omie_%' DO NOTHING`.** Índice parcial exige alvo parcial; não é nomeável por `ON CONSTRAINT`.
- **G3 — `SELECT … FOR UPDATE` no pai** (após o `ON CONFLICT DO NOTHING`, quando conflitou) **antes** do `NOT EXISTS`. **Fecha a corrida sem depender do lease** (sub-projeto 1, não deployado): row lock ligado ao dado real, não advisory lock.
- **G4 — Idempotência por `NOT EXISTS` no nível do pedido.** Nunca UNIQUE no hash do item (363 dups legítimos).
- **G5 — Guard de divergência.** Repara **só** se o cabeçalho local for compatível com o payload (mesmo `total`/`status`/`customer_user_id`/`order_date_kpi`). Divergiu → **não repara**, marca `divergence[]` (relatório Fase 2). Senão é "reconciliação parcial disfarçada".
- **G6 — `order_items.created_at := sales_orders.created_at`** (nunca `now()`). Reparar pedido antigo com `now()` joga venda velha na janela TTM atual → infla positivação do período errado.
- **G7 — Não criar pai sem item válido** no payload (hoje é fábrica de órfãos "válidos"). *(Validar consumidores que contam pedidos-sem-item; default = não-criar + relatar.)*
- **G8 — Telemetria estruturada.** RPC retorna `{inserted, repaired, skipped_complete, skipped_no_items, divergence[], failed[]}` (cada `failed`/`divergence` com `codigo_pedido` + motivo). Nunca engolir erro por pedido como sucesso invisível.
- **G9 — Subtransação por pedido** (`BEGIN/EXCEPTION` no loop): 1 pedido ruim não derruba os outros.
- **G10 — `sales_price_history` na mesma transação** (replica a regra `valor_unitario > 0` + `product_id` mapeado).

### Limites declarados (monitorar, NÃO auto-corrigir)
- **L1** — `NOT EXISTS` só repara **zero-itens**. Pedido **parcialmente** preenchido (caminho C) não é reparado → **monitorar item-count mismatch**, não auto-corrigir.
- **L2** — Pai sem item no próprio Omie não é reparável → **relatório**.
- **L3** — Divergência de cabeçalho → **Fase 2** (não auto-reconcilia).

## 5. Desenho

### 5.1 Migration (SQL Editor, após `prove-sql-money-path`)
1. `CREATE UNIQUE INDEX uniq_sales_orders_omie_hash ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie_%';` (limpo, 0 dups).
2. RPC `public.criar_pedidos_com_itens(p_pedidos jsonb) RETURNS jsonb` — INVOKER + grants (G1). Contrato: `p_pedidos` = array de `{ <campos do pai>, itens: [<campos do item>], precos: [<campos de price_history>] }`. Loop por pedido em subtransação (G9), aplicando G2-G8, G10. Retorna o agregado (G8).

### 5.2 Edge — prevenção (`syncPedidos`)
- Trocar os 2 inserts (+ fallback one-by-one + batch de itens + batch de preços, `index.ts:1216-1310`) por **1 chamada à RPC por página** (array de pedidos válidos).
- **Skip: de "pai existe" para "pai existe COM itens".** Pré-carregar o set de `hash_payload` de pais **que já têm ≥1 item** (em vez de todos os pais); pedido com pai-sem-itens **não é pulado** → vai à RPC, que **auto-repara** (G3-G6). *(Alternativa do Codex: mandar todos os válidos e "deixar o banco decidir" — adotar a versão com pré-load de hashes-com-itens por eficiência no backfill; cair para "manda todos" se a lógica de pré-load ficar frágil.)*

### 5.3 Edge — reparo dos presos (novo `case "reparar_orfaos_itens"`)
- Query (eu calculo via `psql-ro`; o edge recebe a lista ou pagina por `account`): `sales_orders` órfãos (`hash_payload LIKE 'omie_%'` + `NOT EXISTS order_items`).
- Para cada (bulk + `waitUntil` + retry, **nunca N+1 ingênuo** — Omie pune; ver `reposicao.md`): `ConsultarPedido({ codigo_pedido: omie_pedido_id })` → monta payload → chama a **mesma RPC** (idempotente; G3-G6 protegem). Telemetria por lote.

### 5.4 Monitoramento (eu, `psql-ro`, read-only)
- **Órfãos novos**: contagem pós-deploy (deve tender a 0).
- **Item-count mismatch** (L1): pedidos com nº de itens ≠ esperado.
- **Recência** (G6): `order_items.created_at` dos reparados = `sales_orders.created_at` (amostra antes/depois).
- **Duplicação** (G3): nenhum item duplicado além dos 363 grupos legítimos pré-existentes.

## 6. Gates humanos — NUNCA automático
Aplicar migration (SQL Editor) · redeploy do edge (chat Lovable, verbatim) · disparar o job `reparar_orfaos_itens` · aprovar o relatório de divergência (L3) · declarar "histórico reparado". **Eu gero evidência (read-only) e empacoto a ação; o humano cola/aprova.**

## 7. Testes — `prove-sql-money-path` (PG17 local, falsificável)
Cada assert **positivo E negativo** (SQLSTATE + re-raise), cada um **falsificado** (sabotar a migration → exigir vermelho):
1. **Atomicidade**: item inválido no payload → pai **NÃO** entra (rollback da subtransação), e os **outros** pedidos do lote entram (G9).
2. **`ON CONFLICT` parcial** (G2): re-enviar o mesmo pedido → não duplica pai.
3. **Corrida `FOR UPDATE`** (G3): 2 sessões concorrentes reparando o mesmo órfão → **só 1** insere itens (sem duplicar). *(harness com 2 conexões.)*
4. **Reparo idempotente** (G4): pai já com itens → reparo é no-op.
5. **Divergência** (G5): pai local com `total`/`status` ≠ payload → **não repara**, marca `divergence`.
6. **`created_at` coerente** (G6): reparo de pedido antigo → `order_items.created_at = sales_orders.created_at`, **não** `now()`.
7. **Não-cria-pai-sem-item** (G7): payload sem item válido → pai não entra.
8. **Grants** (G1): `SET ROLE authenticated` → `EXECUTE` negado; `service_role` → ok.
9. **`sales_price_history`** (G10): entra na mesma transação; rollback do pedido também reverte os preços daquele pedido.

## 8. Riscos e limites
- **Deploy do edge é manual** (Lovable, verbatim) — coordenar com `lovable-deploy-verify`. Migration custom não auto-aplica (validar com `pg_get_functiondef` pós-apply via `psql-ro`).
- **Reescrita do write-path do edge** é a parte mais invasiva → `/codex challenge` adversarial do diff antes do merge; piloto com **1 janela pequena de 1 conta** antes de qualquer backfill grande.
- **G7 muda semântica** (deixa de criar pai sem item) — confirmar que nenhum consumidor conta pedidos-sem-item antes de cravar.
- **Job de reparo é N+1 controlado** no Omie (~358 `ConsultarPedido`) → batching + `waitUntil` + retry; rodar fora de pico; eu monitoro a cadência.

## 9. Plano de implementação (alto nível)
1. Migration: índice unique + RPC (INVOKER, FOR UPDATE, grants) → **`prove-sql-money-path`** (§7, falsificável).
2. Edge prevenção: `syncPedidos` chama a RPC + skip por "pai-com-itens" → `/codex challenge` → deploy manual → `lovable-deploy-verify`.
3. **Monitorar órfãos novos 24-48h** (`psql-ro`) — confirmar que a torneira fechou.
4. Edge reparo: `case "reparar_orfaos_itens"` (`ConsultarPedido` → RPC) → piloto (1 lote pequeno) → backfill dos 358 → eu valido cobertura/recência/duplicação (§5.4).
5. *(Independente: sub-projeto 1 cursor+lease segue seu próprio fluxo — não bloqueia isto.)*
