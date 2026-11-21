# Crédito definido por IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** limite de crédito do grupo e prazo máximo definidos por IA, aplicados na liberação do pedido (venda + OS), com o duvidoso indo para aprovação do Lucas.

**Architecture:** IA assíncrona (edge Anthropic) propõe limite/prazo sob travas determinísticas; Lucas aprova; gate SQL síncrono e transacional na edge `omie-vendas-sync` reserva limite e decide 🟢/🔴/🟡. Programa de 8 PRs; **este documento detalha o PR 1** e mantém o roteiro dos PRs 2–8 — cada um ganha o seu plano detalhado quando começar (o PR 5 mede o que calibra o 6).

**Tech Stack:** Supabase Postgres (PL/pgSQL, prova PG17 `db/test-*.sh`), edges Deno (`supabase/functions/`), React 18 + TS strict + react-query, vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-credito-ia-design.md` (ler §9 e §10 — substituem o que conflitar em §5/§6).

## Global Constraints

- Ausente ≠ zero: insumo de crédito faltando vira `null`/🟡, nunca `0` (`docs/agent/money-path.md` §2).
- Piso inegociável: vencido > 60 dias (data civil `America/Sao_Paulo`) bloqueia sem exceção humana.
- Aprovador de crédito: **só o Lucas** (allowlist de 1 linha + `cap_credito_escrever`) — a partir do PR 2.
- Apetite: K = 3× compra média mensal 180 d; cliente comprovadamente novo R$ 5.000 e prazo ≤ 28 d.
- IA recebe só números, enums e flags — nunca razão social, observações ou texto livre.
- RPC de gate: `SECURITY DEFINER`, `SET search_path = public`, `REVOKE … FROM anon, authenticated, PUBLIC`, `GRANT … TO service_role`.
- Migration nova nunca edita migration antiga; `CREATE OR REPLACE` só após pré-voo `pg_get_functiondef` da PROD.
- Vocabulário de status de título aberto: `('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL')` (paridade com `src/lib/financeiro/titulo-status.ts`).
- Arquivo novo em `src/` precisa de dono em `src/lib/modulos/manifesto.ts`.
- Edge alterada: bump de `VERSAO` + `sonda:fingerprint -- --write`; os 6 gates de edge no CI.
- Cada PR: review Codex no diff (`scripts/codex-async.sh` em background) antes de sair de draft.

## Review Focus

1. **Cliente com vencido em OUTRA empresa do grupo** compra na Oben/Colacor → deve bloquear (o furo medido: 93 pedidos/26 clientes/R$ 143 mil em 90 d). Teste: Task 1 A3, Task 2 T3.
2. **Cliente que é alias fiscal** (`@placeholder.local`, sem profile) ou canônico com aliases → a dívida de todos soma. Teste: Task 1 A4/A5.
3. **Alias em `conflict`/`inactive`** → não expande (não fabrica vínculo), mas o par do próprio pedido continua avaliado. Teste: Task 1 A6.
4. **Banco instável no envio** (RPC do gate falha) → pedido NÃO sai; vendedora vê "verificação de crédito indisponível, tente de novo" e a retentativa funciona. Teste: Task 3 T2, Task 5 V2.
5. **Edição que só troca o prazo** (28→90 d, mesmo total) → passa pelo gate. Teste: Task 4 T1.

---

## Roteiro do programa (PRs 2–8 — plano detalhado de cada um quando começar)

| PR | Entrega | Critério de pronto | Deploy |
|---|---|---|---|
| **1** | Correções do piso atual (este plano) | furo do grupo fechado, fail-closed, prazo na edição, sem zero na ingestão | migration · edges `omie-vendas-sync` + `omie-financeiro` · Publish |
| 2 | Banco: grupo versionado, `credito_limite`, `credito_limite_proposta`, `credito_reserva`, `credito_decisao_pedido`, solicitação ≠ autorização, allowlist de aprovador | prova PG17 incl. **2 sessões concorrentes** (2×R$7k com R$10k → 1 🟢 + 1 🟡) | migration |
| 3 | Prazo em dias no SQL (`credito_prazo_dias(codigo_parcela, account)` + override) + revisão imutável da operação (o avaliado = o enviado; conversão de orçamento resolve parcela efetiva) | parcela ilegível → `null`; conversão sem parcela não vira `999` sem avaliação | migration · edge · Publish |
| 4 | Edge `credito-ia-avaliar` (ficha → Claude tool-use → travas → proposta) + `/credito/limites` com aprovação em lote da 1ª leva | 1ª leva gerada para a carteira ativa; nada vigente sem aprovação | migration · edge · Publish |
| 5 | Gate v2 em **modo sombra** (decisão + reserva simuladas) + sensores (concordância, faixa por motivo, tempo até decisão) + backtest IA × regra em safras vencidas | 2+ semanas de distribuição de faixas; backtest documentado | migration · edge · Publish |
| 6 | Fila `/credito/fila` + recomendação assíncrona + alerta push ao Lucas (> 2 h) + enforcement da venda ligado | condições do spec §9.10 cumpridas e 1ª leva aprovada | migration · edge · Publish |
| 7 | OS da Afiação no gate v2 (reserva no ponto de concessão, `submitOrder.ts:615`) | OS com prazo passa pelas 3 faixas | migration · edge · Publish |
| 8 | Painel de crédito (exposição, bloqueios, concordância, liberados que atrasaram) | leitura gestor/master | Publish |

---

# PR 1 — Correções do piso atual

**Por que primeiro:** fecha furos que existem hoje e não depende de nada do programa. Medido em prod (psql-ro, 2026-11-20): 125 clientes mapeados têm vencido > 60 d; em 90 dias, 93 pedidos (26 clientes, R$ 143.507) foram enviados/faturados em **outra** conta do grupo, que o gate por par não viu. `fin_contas_receber.valor_documento = 0`: 0 linhas hoje (furo latente). Aliases `active`: 1.633. `omie_customer_account_map`: 1 código por (user, account), contas `oben|colacor|colacor_sc`.

**Antes de começar:** `git fetch && gh pr list --state open --search "omie-vendas-sync OR credito"`; se houver PR aberto tocando `omie-vendas-sync/index.ts` perto de `gateCredito`, coordene (arquivo quente). Pré-voo: `md5(pg_get_functiondef('public.venda_gate_credito(text,bigint,uuid)'))` na PROD = `8cb5137de6999edcb6af72ad31022564` (2026-11-20) — se mudou, releia a PROD antes.

### Task 1: SQL — pares do grupo + gate de piso sobre o grupo

**Files:**
- Create: `supabase/migrations/20261121120000_trava_credito_piso_grupo.sql`
- Create: `db/test-trava-credito-piso-grupo.sh` (copie o arranque PG17 de `db/test-trava-credito-fase2.sh`)

**Interfaces:**
- Produces:
  - `public.credito_grupo_pares(p_user_id uuid) RETURNS TABLE(company text, omie_codigo_cliente bigint, user_id uuid, origem text)` — `STABLE SECURITY DEFINER`, só `service_role`. Resolve o canônico (`p_user_id` se não for alias `active`; senão o `canonical_user_id`), expande todos os aliases `active` desse canônico, e junta `omie_customer_account_map` (`account`→`company`). `origem ∈ ('canonico','alias')`. Aliases `inactive`/`conflict` não expandem.
  - `public.venda_gate_credito_grupo(p_sales_order_id uuid, p_company text, p_codigo bigint, p_customer_user_id uuid) RETURNS jsonb` — mesmo contrato de `venda_gate_credito` (`bloqueado, vencido, titulos, vencimento_mais_antigo, excecao_id, motivo`) **mais** `pares jsonb` (array `{company, codigo, vencido, titulos}` só dos pares com vencido > 0) e `grupo_resolvido boolean`. Escopo = união de `(p_company, p_codigo)` com `credito_grupo_pares(p_customer_user_id)`, deduplicado. Exceção: mesma regra de hoje (pedido + par do pedido + `valido_ate > now()`). `motivo ∈ ('sem_codigo','sem_vencido_60d','vencido_60d_sem_excecao','excecao_valida')`; `sem_codigo` só quando o par do pedido é nulo **e** o grupo não tem pares.
  - `venda_gate_credito(text,bigint,uuid)` **fica intacta** (rollback = edge volta a chamá-la).

- [ ] **Step 1: Escreva os asserts no harness** (sementes: 1 canônico C com par oben=101; alias A1 `active` com par colacor_sc=202; alias A2 `conflict` com par colacor=303; títulos vencidos 75 d em cada par conforme o assert):
  - A1 sem vencido em nenhum par → `bloqueado=false, motivo='sem_vencido_60d'`.
  - A2 vencido só no par do pedido (oben 101) → `bloqueado=true`, `pares` com 1 item.
  - A3 **vencido só em colacor_sc 202 (alias active), pedido em oben 101** → `bloqueado=true`, `pares[0].company='colacor_sc'`. *(o furo)*
  - A4 chamando com `p_customer_user_id = A1` (o alias) → mesmo resultado de A3 (resolve o canônico).
  - A5 vencido de 59 d → não bloqueia; 61 d → bloqueia (corte em SP).
  - A6 vencido só no par 303 do alias `conflict` → `bloqueado=false` (não expande).
  - A7 exceção válida para (pedido, oben 101) com vencido em colacor_sc → `bloqueado=false, motivo='excecao_valida'`; exceção de outro pedido → `bloqueado=true`.
  - A8 `has_function_privilege('anon'|'authenticated', …,'EXECUTE')` = false para as duas funções; `service_role` = true.
  - A9 `p_codigo NULL` e `p_customer_user_id` sem pares → `motivo='sem_codigo'`; `p_codigo NULL` com grupo vencido → `bloqueado=true`.
  - Marcador final `FIM-OK` e `-v ON_ERROR_STOP=1`.
- [ ] **Step 2:** `bash db/test-trava-credito-piso-grupo.sh > /tmp/pg.log 2>&1; rc=$?; tail -c 1500 /tmp/pg.log; [ "$rc" -ne 0 ]` → esperado: falha (funções não existem).
- [ ] **Step 3:** escreva a migration (funções + REVOKE/GRANT nomeando `anon, authenticated, PUBLIC`).
- [ ] **Step 4:** rode o harness → `exit 0` e `FIM-OK` colados.
- [ ] **Step 5: Commit** (antes de falsificar).
- [ ] **Step 6: Falsifique com controle verde na mesma invocação** — modo `--falsificar` no harness: roda a suíte limpa (deve passar), depois sabota uma camada por vez e exige vermelho: (F1) remover a expansão de alias → A3 vermelho; (F2) expandir também `conflict` → A6 vermelho; (F3) corte em UTC/`-59` → A5 vermelho; (F4) exceção sem filtro de par → A7 vermelho. Rode em `LC_ALL=C` e `pt_BR.UTF-8`.
- [ ] **Step 7: Commit.**

### Task 2: Edge — `gateCredito` chama o gate do grupo

**Files:**
- Modify: `supabase/functions/omie-vendas-sync/index.ts:2487-2560` (`gateCredito`), `:3146` (criação), `:3621` (edição)
- Create: `supabase/functions/omie-vendas-sync/gate-credito.ts` + `gate-credito_test.ts`

**Interfaces:**
- Consumes: `venda_gate_credito_grupo` (Task 1).
- Produces: `export async function gateCredito(supabase, args: { company: Account; codigo: number | null; customerUserId: string | null; salesOrderId: string; userId: string | null; contexto: "criacao" | "edicao" }): Promise<{ permitido: true } | { permitido: false; motivo: "credito"; gate: GateCreditoResultado } | { permitido: false; motivo: "credito_indisponivel"; detalhe: string }>` — movida para `gate-credito.ts` (testável); `GateCreditoResultado` ganha `pares` e `grupo_resolvido`.
- `customerUserId` = `soRow.customer_user_id` na criação; na edição, lido de `sales_orders` pelo `editSoId` (nunca do payload).

- [ ] **Step 1: Testes Deno** (supabase fake que devolve `rpc` configurável):
  - T1 rpc devolve `bloqueado:true` → `{permitido:false, motivo:'credito'}` e insert em `venda_bloqueio_credito_log` com `acao='bloqueado'`.
  - T3 rpc chamado com `p_customer_user_id` = o argumento (assert no nome e valor do parâmetro).
  - T4 log de bloqueio falha → lança `Error` cuja mensagem contém `sem log durável`.
- [ ] **Step 2:** rode `bun run test:edges` filtrado → falha.
- [ ] **Step 3:** extraia `gateCredito` para `gate-credito.ts`, troque a RPC, propague `customerUserId` nos dois call sites.
- [ ] **Step 4:** testes passam; `bun run edges:typecheck` e `bun run edges:sintaxe` com exit 0.
- [ ] **Step 5: Commit.**

### Task 3: Edge — fail-closed quando o gate não responde

**Files:** `supabase/functions/omie-vendas-sync/gate-credito.ts`, `gate-credito_test.ts`, e os 2 call sites em `index.ts`.

**Interfaces:**
- Produces: resposta HTTP do edge `{ success:false, blocked:"credito_indisponivel", detalhe }` (criação e edição). Log `acao='gate_indisponivel'` continua sendo gravado (best-effort agora — falhar o log não muda o desfecho, que já é segurar).
- Substitui também o ramo de edição "aumento provado sem `codigo_cliente`" (`index.ts:~3604`): em vez de liberar com log, chama o gate com `codigo=null` + `customerUserId` (o grupo pode resolver); se o grupo não tiver pares → `credito_indisponivel`.

- [ ] **Step 1: Testes:** T2 rpc lança → `{permitido:false, motivo:'credito_indisponivel'}` (nunca `permitido:true`) e houve tentativa de insert `gate_indisponivel`; T5 rpc lança **e** log falha → ainda `credito_indisponivel` (não lança, não libera).
- [ ] **Step 2:** falham. **Step 3:** implemente. **Step 4:** passam + typecheck/sintaxe exit 0. **Step 5: Commit.**

### Task 4: Edge — edição que troca o prazo passa pelo gate

**Files:** `supabase/functions/omie-vendas-sync/index.ts` (bloco de `alterar_pedido`, condição `updatedSubtotal > totalAtualOmie` ~`:3602`); extraia a decisão para `gate-credito.ts`.

**Interfaces:**
- Produces: `export function edicaoExigeGate(args: { subtotalNovo: number; subtotalOmie: number; parcelaNova: string | null | undefined; parcelaOmie: string | null | undefined }): boolean` — `true` se o subtotal sobe **ou** se a parcela muda (normalizada: `null`/`""`/`"999"` contam como `"999"`). Qualquer troca de parcela basta no PR 1 (o gate só cobra o piso, então é inofensivo para quem está em dia); "só se o prazo sobe" chega no PR 3 com `credito_prazo_dias`.
- `parcelaOmie` = `omieCurrent.cabecalho.codigo_parcela` do `ConsultarPedido` já feito no fluxo.

- [ ] **Step 1: Testes:** T1 mesmo total, `"028"`→`"090"` → `true`; T6 mesmo total e mesma parcela → `false`; T7 total sobe, mesma parcela → `true`; T8 `undefined` vs `"999"` → `false`.
- [ ] **Step 2–4:** falha → implemente e use no `alterar_pedido` → passa.
- [ ] **Step 5: Commit.**

### Task 5: Front — novo desfecho e dívida do grupo na tela

**Files:**
- Modify: `src/services/orderSubmission/submitOrder.ts:304,458-461` (tratamento de `blocked`)
- Modify: `src/components/unified-order/ExcecaoCreditoDialog.tsx`, `src/components/unified-order/AlertaCreditoCliente.tsx` (mostrar `pares`)
- Test: o teste vitest existente de `submitOrder` (co-localizado no mesmo módulo; se não houver, `src/services/orderSubmission/submitOrder.credito.test.ts` com dono no manifesto)

**Interfaces:**
- Consumes: `blocked: "credito" | "credito_indisponivel"`, `gate.pares[]` (Tasks 2–3).

- [ ] **Step 1: Testes vitest:** V1 `blocked:'credito'` com `pares` de 2 empresas → o resultado de submit expõe os 2 pares (empresa + valor) para o diálogo; V2 `blocked:'credito_indisponivel'` → resultado `status:'erro_retentavel'` com mensagem `Verificação de crédito indisponível — tente de novo em instantes.` e o pedido local **não** é marcado `enviado`; V3 checkout misto (oben ok, colacor `credito_indisponivel`) → oben segue o fluxo atual e colacor fica pendente.
- [ ] **Step 2–4:** falha → implemente (toast `sonner`; no diálogo, lista "Vencido por empresa: Colacor SC R$ X (desde dd/mm)") → `heavy bun run test` e `bun run typecheck` exit 0.
- [ ] **Step 5: Commit.**

### Task 6: Ingestão — título sem valor não vira zero

**Files:**
- Create: `supabase/functions/omie-financeiro/mapear-titulo.ts` + `mapear-titulo_test.ts`
- Modify: `supabase/functions/omie-financeiro/index.ts:~948` (mapper de CR), `versao.ts`

**Interfaces:**
- Produces: `export function valorDocumentoTitulo(t: { valor_documento?: unknown; nValorTitulo?: unknown }): number | null` — número finito ≥ 0 ou `null` (string vazia, ausente, `NaN` → `null`; **`0` explícito do Omie continua `0`**).
- No mapper: `null` → o título **não** é gravado e entra num contador `cr_titulos_sem_valor` devolvido no resultado do sync e gravado no log da execução (coluna é `NOT NULL`; gravar 0 esconderia dívida do gate). Hoje há 0 casos em prod, então o efeito esperado é nenhum.

- [ ] **Step 1: Testes:** `valorDocumentoTitulo({})` → `null`; `({valor_documento:""})` → `null`; `({valor_documento:0})` → `0`; `({nValorTitulo:"1234.5"})` → `1234.5`; `({valor_documento:"abc"})` → `null`.
- [ ] **Step 2–4:** falha → implemente e use → passa.
- [ ] **Step 5: Commit.**

### Task 7: Fecho do PR 1

- [ ] Bump `VERSAO` de `omie-vendas-sync` e `omie-financeiro`; `bun run sonda:fingerprint -- --write`; `bun run sonda:bump` exit 0.
- [ ] Suíte: `heavy bun run typecheck`, `bun lint`, `heavy bun run test`, `bun run test:edges`, `bun run edges:typecheck`, `bun run edges:sintaxe`, `bash db/test-trava-credito-piso-grupo.sh`, `bash db/test-trava-credito-fase2.sh` (regressão da v1) — todos com exit 0 colado.
- [ ] Review Codex do diff em background (`scripts/codex-async.sh`, modo review); acatar P1.
- [ ] Registro: `docs/historico/credito-piso-grupo-2026-11.md` (o furo medido, a decisão fail-closed, como reverter: edge volta a chamar `venda_gate_credito`).
- [ ] PR (não-draft só após o verde + Codex) com título `fix(credito): trava vê o grupo inteiro + fail-closed + prazo na edição [migration 20261121120000 PENDENTE · edges omie-vendas-sync + omie-financeiro · Publish]`; Auto-fix ligado.
- [ ] Deploy na ordem: **migration** → **edges** → **Publish**; depois `bun run pendencias:deploy` e verificação em prod: `venda_gate_credito_grupo` existe com ACL certo, e em 24 h `venda_bloqueio_credito_log` mostra bloqueios com `pares` de outra empresa.

---

# PR 2 — Banco do limite, da reserva e da decisão (plano detalhado, 2026-11-21)

**Entrega:** 1 migration (`supabase/migrations/20261121160000_credito_limite_reserva_decisao.sql`) + prova PG17 (`db/test-credito-limite-reserva.sh`). **Sem edge, sem Publish, sem efeito em pedido:** nada chama as RPCs novas até o PR 5 (sombra). Deploy = migration via `bun run db:aplicar` (envelope).

**Fatos de prod (psql-ro, 2026-11-21):** único master = Lucas (`user_id 414a9727-ad1d-4998-914e-9c6ccf26cf50`, `profiles.name='Lucas Sardenberg'`); `private.cap_credito_escrever(uuid)` = master-only (`md5(functiondef)=4389a0b7d6a996a42a57fd3d36626f53`); nenhuma tabela `credito_*` além de `credito_virada_grupo`; `fin_contas_receber.saldo` é nullable (0 nulos hoje); 0 pares do mapa com >1 dono; 0 aliases `conflict`.

## Desenho

**Raiz do grupo** — `credito_grupo_raiz(p_company, p_codigo) RETURNS jsonb {raiz, motivo}`: dono ÚNICO do par em `omie_customer_account_map` (0 ou >1 dono → `sem_grupo`); dono alias `active` → canônico; dono alias `conflict`, ou qualquer alias `conflict` do canônico → `grupo_conflito`. Mesmo eixo do PR 1 (raiz = dono do PAR comprovado, nunca o UUID do pedido).

**Grupo versionado por assinatura** — `credito_grupo_assinatura(raiz) = md5` dos pares ordenados de `credito_grupo_pares(raiz)`. O limite guarda a assinatura da aprovação; assinatura atual ≠ a do limite → 🟡 `grupo_mudou` (mudança de composição reavalia).

**Tabelas** (todas RLS ligada; SELECT só `pode_ver_carteira_completa`; sem policy de escrita; `REVOKE INSERT,UPDATE,DELETE,TRUNCATE` de `anon, authenticated, service_role, PUBLIC`; trigger `BEFORE INSERT/UPDATE/DELETE` exige o portão GUC `credito.portao` = id da linha, que só as RPCs setam — PostgREST cru, edge com service_role e SQL na mão não escrevem):
- `credito_aprovador` — allowlist (`user_id` PK). 1 linha: o Lucas. Sem RLS de leitura (só as RPCs leem).
- `credito_limite_proposta` — imutável no conteúdo; só `status pendente → aprovada|recusada|expirada` pela RPC de decisão. Guarda `limite_versao_base` (versão do vigente quando foi proposta) e `grupo_assinatura`.
- `credito_limite` — vigente por `grupo_user_id` (PK): `limite_brl`, `prazo_max_dias`, `risco`, `versao`, `grupo_assinatura`, `ficha_calculada_em`, `origem_proposta_id`, `aprovado_por`. **1 writer**: `credito_aprovar_proposta` (o 2º writer — redução automática — é de PR futuro e será declarado).
- `credito_decisao_pedido` — append-only (UPDATE/DELETE sempre recusados): pedido, company, código, raiz, **revisão**, valor, prazo, faixa, motivo, exposição (títulos, reservas), limite/versão usados, resultado do piso, reserva/solicitação/autorização.
- `credito_reserva` — `ativa → substituida|transferida|liberada`; 1 ativa por (pedido, company) (índice único parcial).
- `credito_solicitacao` — criada pelo gate no 🟡 (1 aberta por pedido+company+revisão). **Não autoriza nada.**
- `credito_autorizacao` — registro SEPARADO, 1 por solicitação, amarrado a revisão, valor máx, prazo máx, motivo e validade.

**RPCs**
- `credito_propor_limite(...)` — service_role (edge do PR 4). Calcula assinatura e versão-base no servidor.
- `credito_aprovar_proposta(id, motivo)` / `credito_recusar_proposta(id, motivo)` — authenticated, gate `IF NOT (private.cap_credito_escrever(uid) AND <allowlist>)` → `42501`. Recusa proposta com versão-base ≠ vigente (`P0001 proposta_desatualizada`) ou assinatura ≠ atual (`grupo_mudou`).
- `credito_autorizar_solicitacao(id, autorizar, motivo, validade_horas)` — authenticated, mesmo gate. Solicitar ≠ autorizar: a solicitação nasce no gate; a autorização só por aqui.
- `private.credito_avaliar_reservar(pedido, company, código, revisão, valor, prazo_dias, modo, solicitante)` — **núcleo sem grant a ninguém** (Codex desenho P1-3): o PR 5 expõe a RPC service_role que lê os valores DA REVISÃO (PR 3) e chama o núcleo. **Transação com `pg_advisory_xact_lock` por raiz** (também tomado pela aprovação de proposta), relê títulos + reservas ativas e decide:
  1. piso (`venda_gate_credito_grupo`) bloqueado → 🔴 `piso_vencido_60d` (autorização de limite **não** cobre o piso);
  2. raiz nula → 🟡 `sem_grupo|grupo_conflito`;
  3. reserva ativa da MESMA revisão → 🟢 `reserva_existente` (retry reusa);
  4. autorização válida p/ (pedido, company, revisão) com valor ≤ máx e prazo ≤ máx → 🟢 `autorizado` (reserva);
  5. sem limite → 🟡 `sem_limite`; assinatura mudou → 🟡 `grupo_mudou`; ficha > 14 d → 🟡 `limite_desatualizado`; risco `alto|sem_evidencia` → 🟡 `risco_*`;
  6. prazo `NULL` → 🟡 `prazo_ilegivel`; prazo > máx → 🟡 `prazo_acima`;
  7. título aberto com saldo `NULL` → 🟡 `exposicao_indeterminada` (ausente ≠ zero);
  8. títulos + reservas ativas de OUTROS pedidos + valor > limite → 🟡 `estoura_limite`;
  9. senão 🟢 `dentro_limite` + reserva. Nova revisão do mesmo pedido: a reserva antiga vira `substituida` e a nova reserva `greatest(antiga, nova)` (redução só libera após confirmação do Omie — PR 5/6); 🟡 numa edição mantém a reserva antiga intacta.
- ~~`credito_reserva_encerrar`~~ **removida** (Codex desenho P0-2): encerrar sem contrapartida apaga exposição. A transferência comprovada reserva→título, com residual de faturamento parcial, nasce no PR 5.
- **Revisão pós-Codex (diff, 2026-11-21):** fecho de escrita/EXECUTE por **allowlist** (`aclexplode`; o default ACL de `public` dá INSERT/EXECUTE a `sandbox_exec_<ref>`, BYPASSRLS); piso e títulos lidos **depois** do lock; reservas somadas por par **ou** raiz; lastro da reserva só do limite vigente ou da autorização da mesma revisão; teto finito contra NaN/Infinity.
- **Condições herdadas pelo PR 5 (ativação):** (a) o escritor de `omie_customer_account_map` toma o advisory lock das raízes afetadas (Codex diff P1-3: trocar a titularidade com reserva não commitada permite 2 reservas); (b) ordem entre revisões vem da revisão imutável do PR 3 (uma `r1` antiga autorizada tarde não pode substituir uma `r2` ativa); (c) frescor do sync, transferência reserva→título e carga dos PVs abertos.

**Fora do PR 2 (declarado):** frescor/cobertura do sync por empresa no gate (§9.5) e transferência comprovada reserva→título (§9.2) → PR 5; parser de prazo e revisão imutável → PR 3; redução automática → PR 4/5; aprovação em lote → PR 4.

## Prova (`db/test-credito-limite-reserva.sh`, PG17 porta 5462, `LC_ALL=C` e `pt_BR.UTF-8`)
- **C1 concorrência real:** limite R$ 10k; sessão A (psql via FIFO) abre transação e reserva R$ 7k sem commitar; sessão B pede R$ 7k e o orquestrador **observa** B bloqueada (`pg_blocking_pids`); A commita → B = 🟡 `estoura_limite`. Resultado 1 🟢 + 1 🟡.
- **Allowlist:** master fora da allowlist aprova → SQLSTATE `42501`; employee gerencial → `42501`; uid nulo (service_role) → `42501`; Lucas → ok.
- **Solicitar ≠ autorizar:** 🟡 cria solicitação; repetir o gate segue 🟡; só após `credito_autorizar_solicitacao` vira 🟢; autorização não cobre revisão nova, valor maior, nem o piso.
- **RLS** sob `SET ROLE authenticated` + `request.jwt.claims`: gestor lê; vendedor (employee operacional) e customer leem 0; ninguém escreve direto (nem service_role) — `42501`/trigger.
- Ausente ≠ zero, assinatura, desatualizado, risco, prazo, retry, edição (substituição e 🟡 preserva a antiga).
- **Falsificação** (controle verde na MESMA invocação; uma camada por vez): F1 sem advisory lock → C1 dá 2 🟢; F2 gate sem allowlist → master estranho aprova; F3 `COALESCE(saldo,0)` → indeterminado vira 🟢; F4 exposição sem reservas → estoura vira 🟢; F5 trigger sem portão → service_role escreve direto; F6 postcondição: REVOKE esquecido aborta a migration.

---

# PR 3 — Prazo em dias no SQL + revisão imutável da operação (plano detalhado, 2026-11-21)

**Entrega:** 1 migration (`supabase/migrations/20261121180000_credito_prazo_revisao.sql`) + prova PG17 (`db/test-credito-prazo-revisao.sh`) + edge `omie-vendas-sync` (revisão antes do gate, envio a partir da revisão, parcela efetiva na edição, `edicaoExigeGate` por prazo). **Sem Publish** — nenhum front muda (a conversão de orçamento passa a gravar a parcela implícita na revisão, no servidor). Nada consome a revisão para DECIDIR até o PR 5; o efeito em venda hoje é só (a) a edição sem parcela não regrava `999` por cima da parcela real e (b) a edição que só troca a parcela sem subir o prazo não chama o piso.

**Fatos de prod (psql-ro, 2026-11-21):**
- `sales_orders` **não tem coluna de parcela**; a parcela só vive no payload do chamador (`criar_pedido`/`alterar_pedido`), e `omie_payload` está nulo nos pedidos desde 2026-08.
- `omie_condicao_pagamento_catalogo` (PK `empresa, codigo`, `empresa` em MAIÚSCULA): **só `OBEN`, 145 linhas ativas**; `dias_parcelas` vazio em todas; **Colacor = 0 linhas**; nenhum writer no repo.
- `OBEN/999` = **"Informar o número de parcelas"** (`num_parcelas = 999`), não à vista (o fallback de `listarFormasPagamento` o rotula "A Vista" — errado, follow-up). `OBEN/000` = "A Vista".
- Gramática (145): `Para N dias` 39 · `N/N…` 81 · `A Vista/N…` 11 · `A Vista` 1 · ilegíveis por desenho: `N Parcela(s)` 7, `(C)` 5, `Informar…` 1.

## Desenho

**Parser em SQL** — `credito_parse_calendario(descricao text) RETURNS integer[]` (IMMUTABLE, porte FIEL de `parseCalendarioParcela`, `src/lib/unified-order/prazo-sugestao.ts`): `[0]` = à vista; `NULL` = ilegível, nunca default. Paridade travada por **fixture compartilhada** (`db/fixtures/credito-prazo-paridade.json`: as 145 descrições reais + casos de borda, com o esperado gerado pelo parser TS): o vitest prova TS = fixture; o PG17 prova SQL = fixture.

**Override** — `credito_prazo_override` **append-only** (`id, company, codigo_parcela, prazo_dias NULL|0..365, motivo NOT NULL, criado_por, criado_em`); vigente = última linha por `(company, codigo_parcela)`; `prazo_dias NULL` = revoga (volta ao catálogo). Escrita só por `credito_definir_prazo_override(company, codigo, prazo_dias, motivo)` — authenticated, gate `credito_sou_aprovador()` (o Lucas) → `42501`. Mesma guarda do PR 2 (`credito_guarda_escrita` + portão GUC, fecho de ACL por allowlist).

**Prazo** — `credito_prazo_resolver(codigo, account) RETURNS jsonb {prazo_dias, fonte}` e `credito_prazo_dias(codigo, account) RETURNS integer` (wrapper): account normalizado `oben|colacor|colacor_sc` (outro → `NULL`); 1º override vigente (`fonte='override'`); senão catálogo ativo da empresa (`OBEN|COLACOR|COLACOR_SC`) → `max(calendário)` **só se** `cardinality(calendário) = num_parcelas` quando este existe (`fonte='catalogo'`); senão `NULL` (`fonte=null`). Código vazio/`NULL` → `NULL`. **Nunca 0 nem 999 por falta.**

**Revisão imutável** — `credito_operacao_revisao` (append-only): `id uuid` (é o `revisao` text do PR 2), `sales_order_id`, `company`, `seq` (1, 2, … por pedido+company — a ORDEM entre revisões que o PR 5 exige, condição (b) do PR 2), `contexto criacao|edicao`, `codigo_parcela NOT NULL` (o que VAI ao Omie), `parcela_informada boolean` (false = chamador não mandou → implícita), `prazo_dias NULL` + `prazo_fonte`, `itens jsonb` (projeção money-path do que vai ao Omie: `[{codigo_produto, quantidade, valor_unitario}]` na ordem do envio), `valor_brl` (calculado NO SERVIDOR = Σ q×v, 2 casas), `conteudo_md5`, `criada_por`, `criada_em`. UNIQUE `(sales_order_id, company, seq)`.
- `credito_registrar_revisao(p_sales_order_id, p_company, p_contexto, p_codigo_parcela, p_itens, p_user_id)` — **service_role**. `pg_advisory_xact_lock` por (pedido, company); valida itens (array não vazio; código inteiro > 0; quantidade e valor finitos e > 0 — senão `22023`, nada gravado); parcela vazia/`NULL` → `'999'` com `parcela_informada=false` (a conversão sem parcela **não vira 999 em silêncio**: fica gravada como implícita e com `prazo_dias NULL` → o gate v2 do PR 5 dá 🟡 `prazo_ilegivel`); conteúdo igual ao da ÚLTIMA revisão → devolve a mesma (`reusada=true`, retry não cria revisão); senão `seq+1`. Devolve `{revisao, seq, codigo_parcela, parcela_informada, prazo_dias, prazo_fonte, itens, valor_brl, reusada}`.

**Edge `omie-vendas-sync`**
- `criar_pedido`: registra a revisão **antes** do gate (o avaliado nasce antes da decisão); revisão que falha → **segura** o envio (mesmo erro retentável do gate indisponível — fail-closed); o envio usa `codigo_parcela` e `quantidade/valor_unitario/codigo` **da revisão devolvida** (por construção, o enviado = o avaliado; demais campos cosméticos do item seguem do payload, por índice, com tamanho conferido).
- `alterar_pedido`: parcela efetiva = a informada, senão **a atual do Omie** (`omieParcelaEdit`), senão `999` — acaba o regravar `999` por cima da parcela real. Revisão `edicao` registrada antes do gate; o envio usa a revisão.
- `edicaoExigeGate({subtotalNovo, subtotalOmie, parcelaNova, parcelaOmie, prazoNovo, prazoOmie})`: subtotal sobe → sim; mesma parcela → não; **os dois prazos legíveis e `prazoNovo ≤ prazoOmie` → não**; senão sim (prazo ilegível nunca prova que não subiu).
- Bump `VERSAO` + `sonda:fingerprint -- --write`.

**Fora do PR 3 (declarado):** popular o catálogo da Colacor (sem ele todo prazo Colacor é `NULL` → 🟡 até override — o PR 5 mede a fração); rótulo "A Vista" do fallback `999` em `listarFormasPagamento`; escolher a parcela na conversão do orçamento (UX — PR 6, "aprovar com outro prazo"); `pedido-programado-enviar` herda o mesmo caminho (revisão implícita quando sem `cfg.codigo_parcela`).

## Prova (`db/test-credito-prazo-revisao.sh`, PG17, `LC_ALL=C` e `pt_BR.UTF-8`)
- **P1 paridade:** as 145 descrições reais + bordas → SQL = fixture TS (inclui `(C)`, `N Parcelas`, `Informar…`, `A Vista/1/1`, `30` nu, `A Vista (30 dias)`, `0`, `366`).
- **P2 prazo:** override vence catálogo; override revogado volta ao catálogo; `999`/vazio/`NULL`/empresa desconhecida/Colacor sem catálogo → `NULL`; `num_parcelas` divergente → `NULL`; inativo ignorado.
- **P3 override ACL:** Lucas grava; master fora da allowlist, employee e service_role → `42501`; ninguém escreve direto (trigger/ACL).
- **P4 revisão:** seq 1/2; retry idêntico reusa; sem parcela → `999` implícita com prazo `NULL`; item inválido (NaN, 0, negativo, código não inteiro, array vazio) → `22023` sem linha; UPDATE/DELETE recusados; `valor_brl` do servidor; concorrência de 2 registros do mesmo conteúdo → 1 linha (advisory lock).
- **Falsificação** (controle verde na MESMA invocação; uma camada por vez): F1 parser devolve `0` para ilegível → P1/P2 vermelhos; F2 override sem gate de aprovador → P3 vermelho; F3 sem advisory lock → P4 concorrência vermelho; F4 sem checagem de `num_parcelas` → P2 vermelho; F5 parcela vazia vira `'000'` → P4 vermelho.
- **Edge (Deno):** `edicaoExigeGate` (28→90 mesmo total → sim; 90→28 → não; ilegível → sim; mesma parcela → não); `itensDaRevisao` (envio = revisão; tamanho divergente lança).

## Revisão pós-Codex (desenho, 2026-11-21, gpt-6.2-astra high — 2 P0 + 6 P1 + 1 P2)

**Acatados no PR 3 (substituem o que conflitar acima):**
- **Devedor na revisão (P1):** grava `omie_codigo_cliente` comprovado pela edge (nullable = não comprovado) e ele entra na igualdade de deduplicação — retry com outro cliente gera revisão nova.
- **Sem fail-closed novo (P1):** revisão que falha **não** segura o envio no PR 3 (contrariaria o §10 — a trava nova só liga após a 1ª leva). A edge loga, devolve `revisao: null` e segue o caminho do PR 1 (piso continua fail-closed). No enforcement (PR 6) revisão válida passa a ser exigida antes de mutar.
- **Origem da parcela (P1):** `parcela_origem` = `informada | herdada_omie | default_999` (substitui `parcela_informada`); códigos textuais preservados (`000` ≠ `0`). Edição sem parcela herda a do PV confirmado; sem nenhuma das duas, segue `999` como hoje (`default_999`, prazo `NULL`).
- **Edição por DOMINÂNCIA, não por máximo (P1):** pular o piso só se a parcela é a mesma, ou se os DOIS calendários vêm do catálogo e o novo **domina-ou-iguala** o antigo (em todo vencimento, fração recebida ≥). `30/60/90 → 75 dias` reavalia. Override escalar, ilegível ou `999` nunca provam → reavalia.
- **Resolvedor sem certeza fabricada (P1):** `fonte=catalogo` exige linha ativa, calendário válido e `num_parcelas` **presente** e igual à cardinalidade (inclui a entrada à vista). Override de `999` **vetado** (o código significa "informar parcelas" — prazo individual precisa de evidência do PV).
- **Override versionado (P1):** definição/revogação serializada por advisory lock em `(company, codigo)`, `versao` monotônica; vigente = última linha incluindo revogações. A revisão grava `prazo_override_id` (a evidência); prazo/fonte/override entram na igualdade — mudança de evidência gera revisão nova.
- **Correspondência por item (P1):** o envio usa `codigo/quantidade/valor_unitario` da revisão por índice e confere o código item a item (não só o tamanho).
- **Centavos (P2):** `valor_brl = Σ round(q × v, 2)` por linha (como o Omie totaliza o item); caso fracionário (2 × R$ 1,005) na prova.
- Ator de sistema: `p_user_id` nullable (pedido programado chama como service_role).

**Condições herdadas pelo PR 5 (antes de a revisão RESERVAR crédito):**
- (d) **retomada vincula o PV à revisão despachada** (P0): a chave Omie `PV_<sales_order_id>` é a mesma em todas as revisões — duplicata no retry precisa conferir cliente, itens, preços, total e parcela do PV contra a revisão; divergência ou leitura incompleta deixa a exposição pendente de reconciliação.
- (e) **despacho serializado por revisão** (P0): claim atômico da revisão vigente por pedido/conta (uma tentativa em voo), resultado registrado por revisão; na edição, conferir o PV de origem antes do 1º delete e parcela+total após `TotalizarPedido`; resultado ambíguo bloqueia novo despacho e redução de reserva.
- (f) gates tint/ATP antes da reserva, ou encerrar a tentativa recusada antes do envio; retomada por perna no checkout misto; congelar tint/PC/NF para reenvio pós-aprovação (PR 6); contrato explícito de "troca de parcela" com a condição original esperada no editor (PR 6).
