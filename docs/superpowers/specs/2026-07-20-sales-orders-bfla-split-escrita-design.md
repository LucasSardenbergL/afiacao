# Split do `FOR ALL` de escrita em `sales_orders` + filhas (BFLA) — design

> Fecha a pendência registrada em `docs/agent/database.md` §4: *"`sales_orders` é `FOR ALL`, não SELECT — os employees inserem, alteram e apagam pedido de venda (é o BFLA do bullet da §4 ainda aberto nessa tabela)"*.
> Medido em prod (`psql-ro`, ref `fzvklzpomgnyikkfkzai`) em **2026-07-20**.

## 1. Estado medido (não deduzido)

### Policies hoje

| Tabela | Policy | cmd | qual |
|---|---|---|---|
| `sales_orders` | `Staff can manage sales orders` | **ALL** | `has_role(master) OR has_role(employee)` |
| `sales_orders` | `Customers can view their own sales orders` | SELECT | `auth.uid() = customer_user_id` |
| `order_items` | `Staff can manage order items` | **ALL** | idem broad-staff |
| `order_items` | `Customers can view their own order items` | SELECT | `auth.uid() = customer_user_id` |
| `sales_price_history` | `Staff can manage sales price history` | **ALL** | idem broad-staff |
| `sales_price_history` | `Customers can view their own price history` | SELECT | `auth.uid() = customer_user_id` |

As 3 policies `ALL` são `TO authenticated`, `PERMISSIVE`, com `USING` = `WITH CHECK`, e **sem wrap InitPlan** (`has_role(auth.uid(),…)` cru — o anti-pattern de §4).

### Quem escreve de fato

| Caminho | Volume | Passa por RLS? |
|---|---|---|
| `omie-vendas-sync` (edge) + RPC `criar_pedidos_com_itens` | 29.969 de 29.970 pedidos | ❌ `service_role` (`rolbypassrls`) |
| App / balcão (`origem='web_staff'`) | **1 pedido**, jun/2026 | ✅ JWT do staff |
| Orçamento (`submitQuote`) | 1 `orcamento` + 1 `rascunho` | ✅ |
| Soft-delete de pedido (`deleted_at`) | **0 linhas**, jamais | ✅ |
| `order_items` / `sales_price_history` pelo front | **nenhum escritor no código** | — |

Os 28.087 pedidos com `created_by = tatyanamartins2002@icloud.com` **não são escritas humanas**: 28.086 têm `origem IS NULL` + `omie_pedido_id` preenchido + `checkout_id IS NULL` — importações do Omie que carimbam um uid fixo. A escrita via RLS é ~1 pedido/6 meses.

### Grants relevantes

- `criar_pedidos_com_itens`: `prosecdef=false`, `has_function_privilege(authenticated,…)=false`, só `service_role` executa → **não é vetor** e **não é afetada** pelo estreitamento.
- `sales_orders.relacl`: `authenticated=awdDxtm` (sem `r` — REVOKE column-level do PR0.0-bis; SELECT vem por coluna).
- `order_items` / `sales_price_history`: `authenticated=arwdDxtm` (SELECT table-level + DML completo).
- `relforcerowsecurity = false`, owner `postgres` nas 3 → funções SECDEF owned por `postgres` seguem bypassando (premissa do #1416 confirmada).

### Raio de um DELETE em `sales_orders`

```
order_items            ON DELETE CASCADE    ← 68.459 linhas, money-path (reposição/CMC)
venda_excecao_credito  ON DELETE CASCADE
sales_price_history    ON DELETE SET NULL   ← 69.171 linhas, histórico de preço praticado
production_orders      ON DELETE SET NULL
farmer_calls           NO ACTION            ← barra o DELETE se houver referência
recommendation_log     NO ACTION
picking_tasks          NO ACTION
```

Sem trigger de auditoria, sem tombstone. Um DELETE via PostgREST é irreversível e mudo.

### O caminho legítimo de exclusão já existe e não usa a policy

`softDeleteOrder` ([src/components/salesOrders/soft-delete.ts](../../../src/components/salesOrders/soft-delete.ts)) marca `deleted_at`, invoca a edge `omie-vendas-sync` com `action:'excluir_pedido'`, e a edge cancela no Omie e apaga localmente com `supabaseAdmin` (`service_role`) — [omie-vendas-sync/index.ts:3009](../../../supabase/functions/omie-vendas-sync/index.ts). Rollback de `deleted_at` se o Omie falhar.

⇒ **O DELETE direto por `authenticated` não serve a nenhum fluxo de pedido.** O único uso real é [SalesQuotes.tsx:85](../../../src/pages/SalesQuotes.tsx), que apaga **orçamento** (`status='orcamento'`, sem `omie_pedido_id`).

## 2. Decisão: apertar o VERBO e o ESTADO, não o ator

O eixo do **ator** já foi decidido no #1477, com a mesma população: 4 grants staff / **3 pessoas**, todas do núcleo (founder-master + 2 employees do atendimento), zero externos. A conclusão lá — cadastro-base é broad-staff de propósito — vale igual aqui. Estreitar `sales_orders` por ator é refazer aquela análise e chegar no mesmo lugar, com o custo extra de desarmar o balcão das employees (`UnifiedOrder`, `checkout_id`, `atendimento_id` são infra viva, só pouco usada).

O que o #1477 não examinou é o eixo do **verbo**. É lá que o poder é desproporcional: um JWT de employee (a anon-key é pública, vai no bundle) apaga 29.970 pedidos + 68.459 itens via PostgREST, irreversivelmente. Nenhum fluxo legítimo faz isso.

**Alternativas descartadas:**

- **Master-only na escrita** (simetria com `cap_compras/credito/preco_escrever`): aquelas gateiam *decisões de gestão*; lançar pedido é a *função-fim* do atendimento. Hoje não quebraria nada mensurável, mas a negação viria silenciosa via PostgREST quando o balcão voltasse a ser usado.
- **Carteira-scoped**: o atendimento atende quem liga, sem carteira nesse fluxo. E §4 alerta que RLS viva sobre tabela de histórico faz métrica variar retroativamente conforme quem calcula.

## 3. Desenho

### 3.1 Capability nova — `private.cap_pedido_escrever`

Padrão FU4 verbatim (medido em `cap_compras_escrever` na prod), **mas com o predicado de staff**, não master-only:

```sql
CREATE OR REPLACE FUNCTION private.cap_pedido_escrever(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    _uid IS NOT NULL AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR public.has_role(_uid, 'employee'::public.app_role)
    ), false);
$$;
```

`COMMENT` obrigatório registrando **por que não é master-only** — senão a próxima sessão "corrige" por simetria e desarma o balcão.

`REVOKE ALL … FROM PUBLIC, anon` + `GRANT EXECUTE … TO authenticated, service_role` (a policy exige `EXECUTE` do caller — §7).

### 3.2 `sales_orders` — 4 policies, uma por comando

`FOR ALL` **não** vira `USING`+`WITH CHECK`: `DELETE` consulta só o `USING` (§4, achado Codex #1434/E2-FU4).

| cmd | cláusula | expressão |
|---|---|---|
| SELECT | USING | broad-staff wrapped (mantém a decisão #1477) |
| INSERT | WITH CHECK | `(SELECT private.cap_pedido_escrever((SELECT auth.uid())))` |
| UPDATE | USING + WITH CHECK | idem |
| DELETE | USING | idem **AND** `omie_pedido_id IS NULL` **AND** `status IN ('orcamento','rascunho')` |

A policy `Customers can view their own sales orders` fica **intacta**.

O predicado do DELETE torna **30.112 pedidos já materializados no Omie indeletáveis via PostgREST por qualquer JWT** — inclusive o do master, que também é um vetor — deixando exatamente **2 linhas** deletáveis (o orçamento e o rascunho). A exclusão legítima segue pela edge (`service_role`, bypassa RLS).

### 3.2-bis ⚠️ O predicado sozinho é contornável — allowlist de UPDATE por coluna

**Achado ao redigir o challenge do Codex, antes de qualquer implementação; confirmado por ele como furo crítico.** O predicado protege pelo *estado*, e o mesmo ator controla o estado via UPDATE. Bypass em dois requests:

```http
PATCH  /rest/v1/sales_orders?id=eq.<uuid>   {"omie_pedido_id": null, "status": "rascunho"}
DELETE /rest/v1/sales_orders?id=eq.<uuid>
```

RLS **não fecha isso**: `WITH CHECK` só enxerga a linha NOVA (não compara com a antiga), e RLS filtra linha, não coluna.

A barreira escolhida é o **grant de coluna**, não um trigger — ela é mais forte (nega antes de qualquer avaliação de policy), mais simples de provar, e o repo já a usou nesta mesma tabela para SELECT (PR0.0-bis). Payloads medidos nos 5 call sites de UPDATE do front — o conjunto é de **11 das 28 colunas**:

```sql
REVOKE UPDATE ON public.sales_orders FROM authenticated;
-- ⚠️ UPDATE, NUNCA "ALL": REVOKE table-level revoga também os privilégios
--    de COLUNA correspondentes → um REVOKE ALL destruiria os grants de
--    SELECT por coluna do PR0.0-bis e quebraria a leitura do front inteiro.
GRANT UPDATE (
  items, subtotal, total, notes, customer_document, customer_address,
  customer_phone, ready_by_date, omie_payload, deleted_at, status
) ON public.sales_orders TO authenticated;
```

| call site | colunas |
|---|---|
| `idempotency.ts:62` (reuse) | `items, subtotal, total, notes, customer_document, customer_address, customer_phone, ready_by_date` |
| `useSalesOrderEdit.ts:359` | `items, subtotal, total, notes, omie_payload` |
| `soft-delete.ts:17` e `:25` | `deleted_at` |
| `useSalesOrders.ts:235` e `:268` | `deleted_at` |
| `SalesQuotes.tsx:171` | `status` |

**As 17 colunas fechadas** incluem os vetores que o Codex levantou no ponto B: `customer_user_id` (um PATCH reatribuiria o pedido e a policy `auth.uid() = customer_user_id` o exporia a **outro cliente**), `created_by` (forjar autoria), `account`, `hash_payload`, `checkout_id`, `origem`, `order_date_kpi`, `omie_response`, `whatsapp_conversation_id`, `omie_numero_pedido` — e **`omie_pedido_id`**, o que **mata o bypass do DELETE na origem**, sem trigger.

**Custo medido: zero** nos fluxos atuais.

⚠️ **Dívida assumida** (§4, consequência 2 do padrão column-grant): coluna NOVA nasce **sem** grant de UPDATE e some do PostgREST em silêncio. Mitigação: a validação pós-apply lista colunas sem grant, e a dívida vai registrada em `docs/agent/database.md` §4.

**Trigger como 2ª camada: considerado e adiado.** O grant de coluna cobre o vetor real (PostgREST/JWT); um trigger cobriria um raio diferente — função `SECURITY DEFINER` futura rodando como `postgres`, que ignora o grant. Não há tal função hoje (varredura: só `criar_pedidos_com_itens`, INVOKER, sem `EXECUTE` para `authenticated`). Fica como follow-up, com a nota do #1422 de que as camadas se provam **separadamente**.

### 3.3 `order_items` e `sales_price_history` — sem policy de escrita

Nenhum escritor no front; os writers são `service_role`. Logo:

| cmd | policy |
|---|---|
| SELECT | broad-staff wrapped + customer own (ambas mantidas) |
| INSERT / UPDATE / DELETE | **nenhuma** → RLS nega `authenticated`/`anon` |

**2ª barreira** (§4: "ausência de policy fecha `authenticated`, não `service_role`"; e o grant DML vem do default privilege do Supabase). O Codex apontou que `arwdDxtm` inclui **`D` = TRUNCATE**, ao qual **RLS não se aplica** — revogar só `a/w/d` deixaria de pé uma operação capaz de esvaziar a tabela. Nas filhas não há grant de coluna a preservar (SELECT é table-level), então `REVOKE ALL` é seguro aqui:

```sql
REVOKE ALL PRIVILEGES ON public.order_items, public.sales_price_history
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_items, public.sales_price_history TO authenticated;
```

Em `sales_orders`, `REVOKE ALL` é **proibido** (levaria os grants de SELECT por coluna do PR0.0-bis). Lá a limpeza é cirúrgica, preservando `SELECT`/`INSERT`/`DELETE` e o `UPDATE` já regrantado por coluna:

```sql
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.sales_orders
  FROM PUBLIC, anon, authenticated;
```

⚠️ **O `REVOKE` nas filhas não impede o `CASCADE`** (Codex, ponto D): ações referenciais rodam pelo mecanismo da FK e ignoram RLS e grants. Deletar o pai continua apagando `order_items` e desvinculando `sales_price_history`. ⇒ A proteção real dos filhos vem de **fechar o DELETE do pai** (§3.2 + §3.2-bis); o `REVOKE` aqui cobre apenas o DELETE **direto** na filha. As duas coisas são necessárias e não se substituem.

**`service_role` não é afetado — medido, não suposto:** `relacl` mostra `service_role=arwdDxtm/postgres` (grant próprio e explícito) e `has_table_privilege('service_role', …, 'INSERT'/'UPDATE'/'DELETE') = true` nas 3 tabelas. Como o privilégio não chega por `PUBLIC`, o `REVOKE` acima não quebra a RPC `criar_pedidos_com_itens` (INVOKER, chamada como `service_role`) nem `sync-reprocess`.

### 3.4 InitPlan (de graça, mesmo replace)

Todas as policies novas nascem `(SELECT private.cap_…((SELECT auth.uid())))` / `(SELECT public.has_role((SELECT auth.uid()), …))`, corrigindo o anti-pattern de §4 nas 3 tabelas (`sales_orders` tem 29.970 linhas, `order_items` 68.459, `sales_price_history` 69.171).

## 4. Prova (`prove-sql-money-path`, PG17 local)

Harness reproduzindo a prod, **não o design**: `relforcerowsecurity=false`, owner `postgres`, default privileges do Supabase (`ALTER DEFAULT PRIVILEGES … GRANT … TO anon, authenticated, service_role`) **antes** de criar os objetos — senão o teste nasce fechado por acidente (§4, 3 armadilhas de harness).

**Asserts positivos** (`SET ROLE authenticated` + GUC do JWT — psql é superuser e bypassaria):

1. employee INSERT pedido → **permitido** (balcão preservado)
2. employee UPDATE pedido → **permitido** (edição/soft-delete preservados)
3. employee DELETE orçamento (`status='orcamento'`, `omie_pedido_id IS NULL`) → **permitido**
4. employee DELETE pedido faturado (`omie_pedido_id` preenchido) → **0 linhas** ✱
5. master DELETE pedido faturado → **0 linhas** (o predicado não tem exceção de ator)
6. `service_role` DELETE pedido faturado → **permitido** (edge preservada)
7. customer SELECT próprio pedido → **1 linha**; pedido alheio → **0**
8. employee INSERT/UPDATE/DELETE em `order_items` → **negado**
9. `service_role` escreve em `order_items` → **permitido**
10. `has_table_privilege('authenticated','order_items','DELETE')` → **false** (2ª barreira)

✱ Assert em **estados mutuamente distinguíveis** (`<valor>` / `<sem-linha>` / `DENIED`), nunca em vazio — §4, o `grep -vE` que pintou 2 asserts de verde.

**Asserts de catálogo** old×new (`cmd` / `roles` / `permissive` / presença de cláusula) — a matriz de visibilidade idêntica não pega um drift que alargue `TO public` ou preserve um `FOR ALL` (§4, achado Codex xhigh).

**Falsificações** (exigir vermelho):

- **F1** — remover o predicado de estado do DELETE → o assert 4 tem de ficar **vermelho** (prova que o predicado é a barreira, não um acaso).
- **F2** — trocar as 4 policies por `FOR ALL USING(cap) WITH CHECK(cap)` → o assert 4 fica **vermelho** (reproduz o bug do #1434: `WITH CHECK` não se aplica a DELETE).
- **F3** — camadas separadas em `order_items` (§4/#1422): (a) recriar só a policy de escrita → o `REVOKE` ainda barra; (b) recriar policy **e** regrantar → o furo reabre. Sem (a) não se sabe se a 2ª camada existe; sem (b) não se sabe se o assert mede algo.
- **F4** — `cap_pedido_escrever` sabotada para master-only → o assert 1 fica **vermelho** (trava a decisão de produto: employee escreve).
- **F5 (a mais importante)** — **o bypass de dois passos, exercitado de verdade**: como employee, `UPDATE … SET omie_pedido_id = NULL, status='rascunho'` e em seguida `DELETE`. Com a allowlist: o UPDATE tem de levantar **42501** e o pedido continuar lá. Sabotando (regrantando `UPDATE` table-wide): o DELETE tem de **passar** — provando que o grant de coluna é a barreira, e não o predicado sozinho. Assert 11 do bloco positivo.
- **F6** — **a allowlist não pode ser larga demais**: sabotar acrescentando `omie_pedido_id` ao `GRANT UPDATE (…)` → F5 tem de ficar **vermelho**. Sem isso, uma allowlist que por engano inclua a coluna passaria despercebida (o teste "o front continua funcionando" não a pega).
- **F7** — **a allowlist não pode ser estreita demais**: para cada uma das 11 colunas, um UPDATE do employee tem de **passar**. Um `GRANT` que esqueça `deleted_at` quebraria o soft-delete em silêncio, e nenhum assert de segurança pegaria (todos os de segurança ficam mais verdes quanto mais estreito o grant).

**Assert de preservação (o risco que quase passou):** `has_column_privilege('authenticated','public.sales_orders', <col>, 'SELECT')` tem de continuar `true` nas 25 colunas legíveis e `false` em `omie_payload`/`omie_response`/`whatsapp_conversation_id` — **exatamente como antes**. É o que prova que o `REVOKE UPDATE` não levou junto os grants de SELECT por coluna do PR0.0-bis. Falsificação: trocar o `REVOKE UPDATE` por `REVOKE ALL` → este assert fica **vermelho**.

## 5. Validação pós-apply

Lê **catálogo**, nunca invoca a função (§4/FU4-E: `NULL` sem cast dá `unknown`, e invocar exige `EXECUTE` que o `claude_ro` não tem — o sucesso da migration se apresentando como falha). Mesmo comando para `psql-ro` e para o SQL Editor:

- `pg_policies` das 3 tabelas: 0 linhas com `cmd='ALL'`; `sales_orders` com 4 + a de customer; filhas com 2 cada.
- `qual` do DELETE de `sales_orders` casa `omie_pedido_id` **e** `orcamento` (pelos **valores**, não pela sintaxe — `pg_get_expr` re-serializa).
- `pg_get_functiondef('private.cap_pedido_escrever')` casa `employee` **e** `master` (positivo) e `!~ 'gerencial|estrategico|carteira'` (negativo).
- `has_table_privilege('authenticated', 'public.order_items', 'DELETE')` = **false**; `'SELECT'` = **true**.
- Todas as policies wrapped: `qual ILIKE '%select%'` (com espaço — `%(select%` dá falso-0, §4).
- O regex é testado contra a prod **antes** de entregar.

## 6. Escopo e ordem de deploy

Migration única, atômica, idempotente. **Nenhuma mudança de frontend é necessária** — os fluxos preservados (INSERT de pedido/orçamento, UPDATE, DELETE de orçamento) continuam funcionando com o mesmo código. Logo não há acoplamento de ordem entre Publish e SQL Editor (≠ PR0.0-bis, que exigiu 3 passos).

## 7. Ritual `/codex` — parecer e o que foi feito dele

Rodado em `challenge` xhigh (2026-07-20), com os fatos de schema **no próprio prompt** via `psql-ro` (nunca apontar o Codex ao snapshot — §money-path). Veredito: **reprovou o desenho**. Cinco objeções; três aceitas, duas recusadas com razão medida.

| # | Objeção | Desfecho |
|---|---|---|
| A | DELETE contornável por UPDATE em `omie_pedido_id` | ✅ **Aceita** — já achada por mim ao redigir o prompt; fechada pela allowlist (§3.2-bis) |
| B | UPDATE é a maior superfície; "o sync reconcilia" é autoengano | ✅ **Aceita** — eu havia medido só `UPDATE items`, não `total`/`status`/`customer_user_id`. A allowlist fecha 6 dos 8 vetores |
| D | `arwdDxtm` inclui TRUNCATE (RLS não se aplica); `REVOKE` não impede CASCADE | ✅ **Aceitas as duas** — §3.3 |
| C/E | Inventário incompleto (service_role, views, triggers externos, cron) | ✅ **Medido** — ver abaixo; nenhuma objeção sobreviveu |
| B′ | Mover `total`/`subtotal`/`items` para RPCs | ❌ **Recusada** — são o que a edição de pedido escreve ([useSalesOrderEdit.ts:359](../../../src/components/salesOrderEdit/useSalesOrderEdit.ts)); é a função-fim, não vetor acessório. Épico próprio, não este PR |
| F | Break-glass master-only auditado | ⏸️ **Follow-up** — o próprio parecer registra que não há fato medido de necessidade |

**Inventário que ele cobrou, medido em prod:**

| Superfície | Resultado |
|---|---|
| `has_table_privilege('service_role', …)` nas 3 | `true` por grant **próprio** (`service_role=arwdDxtm/postgres`) → `REVOKE` não quebra a RPC nem o sync |
| Views/MVs que dependem das 3 | 6 (`order_feed`, `selfservice_meus_pedidos`, `v_caca_candidatos`, `v_caca_compradores`, `v_grupo_comercial`, `customer_metrics_mv`) |
| Views **atualizáveis** sobre as 3 | **zero** — nenhuma das 6 está entre as 10 atualizáveis do schema ⇒ sem DML indireto |
| Triggers de outras tabelas escrevendo nas 3 | **zero** |
| `cron.job` tocando as 3 | **zero** |

⚠️ **Ponto cego declarado:** não há como auditar tráfego HTTP do PostgREST pelo `psql-ro`. Um consumidor externo (Zapier/n8n/planilha) com JWT de employee escrevendo em `order_items` **não apareceria em nenhuma varredura deste spec** e passaria a falhar após o `REVOKE`. Assumido conscientemente: as duas filhas não têm escritor no front nem RPC executável por `authenticated`, então tal consumidor teria sido construído fora de qualquer caminho do produto.

## 8. Follow-ups registrados (não neste PR)

1. **INSERT segue table-wide.** A policy de INSERT gateia o *ator*, mas o grant permite ao employee inserir qualquer combinação das 28 colunas — inclusive forjar `status='faturado'` + `total`. Menos grave que o UPDATE (cria linha nova em vez de corromper linha real, e sem `omie_pedido_id` ela não corresponde a nada no Omie), mas contamina KPI. Fecha-se com allowlist de INSERT, medindo os payloads de `idempotency.ts:72` e `submitQuote.ts`.
2. **Sem auditoria em `sales_orders`.** `updated_at` registra *quando*, não *quem* nem o valor anterior. Sem isso não há detecção nem atribuição de um UPDATE malicioso dentro da allowlist (`total`/`subtotal`/`items` seguem graváveis).
3. **Break-glass master-only auditado** para hard delete de pedido materializado (hoje a saída é SQL Editor, que roda como owner e ignora RLS porque `relforcerowsecurity=false`).
4. **Trigger como 2ª camada** em `omie_pedido_id`, cobrindo SECDEF futura que rode como `postgres` (§3.2-bis).
5. ~~**`deleted_at` nunca usado em prod**~~ → **INVESTIGADO em 2026-07-20: não é dívida, é design.** `deleted_at` **não é soft-delete persistente — é um marcador transitório de intenção**: o front marca (`soft-delete.ts` / `useSalesOrders.deleteSelected`), invoca a edge `omie-vendas-sync`/`excluir_pedido`, e a edge cancela no Omie e **apaga a linha fisicamente** com `service_role`. No caminho de sucesso a linha some — daí as 0 linhas em 30.114. O `UPDATE deleted_at = null` só roda no rollback de falha do Omie. Os **5 filtros `.is('deleted_at', null)`** (`useMunicaoLigacao`, `useVendasZone`, `useTeamKpis`, `useHistoricoCompras`, `fetch-pedidos-mtd`) são no-ops na prática, mas **corretos como defesa**: se a edge falhar entre marcar e apagar, a linha fica marcada e eles a escondem. ⇒ Nenhum código a escrever; o entregável foi a medição (mesma lição do #1422: *meça se a invariante já vale antes de escrever código*). ⚠️ **Consequência para quem for mexer:** "há soft-delete nesta tabela" é falso — não existe pedido oculto recuperável; a exclusão é destrutiva e cascateia para `order_items`. E a allowlist de UPDATE (§3.2-bis) **tem de manter `deleted_at`**, senão este fluxo quebra em silêncio.

**Fora de escopo, registrado:** 1 pedido `cancelado` com `total = R$ 615.100.434,63` (Omie 9647, oben, fev/2026) — dado sujo vindo do sync, contamina qualquer agregação que não filtre `status`. Chip aberto para o founder.
