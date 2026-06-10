# Listagem de pedidos via view unificada `order_feed` (PR2 do #3)

**Data:** 2026-06-06
**Tipo:** refatoração de arquitetura da tela `/sales`. **Requer migration** (view).
**Antecede:** PR1 (#697, pronto-socorro: keepPreviousData + observador robusto).
**Revisado por:** 2 rodadas de 2ª opinião (ChatGPT). Veredito: "arquitetura correta,
aprovado com alterações". As alterações estão incorporadas abaixo.
**⚠️ Adversarial da IMPLEMENTAÇÃO (caminho B):** o Codex bateu o usage limit do Plus
(reset 2026-06-11 09:24) ao revisar o diff → self-review adversarial próprio +
validação PG17 no lugar; **Codex faz o adversarial retroativo quando voltar**
(precedente: fix do aplicar_promocoes). Achado do self-review registrado: o
`window.open` do cupom agora roda após `await` (fetch do detalhe) — popup-blocker
pode barrar a 1ª impressão em browsers rígidos (Safari); fluxo comum (detalhe em
cache) não afeta. Follow-up se reportado: pré-abrir a janela no gesto síncrono.

## Problema (recap)
A listagem hoje: 2 `useInfiniteQuery` (sales_orders + orders/afiação) mescladas e
reordenadas no cliente → paginação cronológica global incorreta; busca/filtro
client-side só sobre o carregado → não acha o resto; 3ª query de profiles cuja key
muda ao paginar → nomes piscam. Decisão: **read model único (view) + uma query**.

**⚠️ Volume REAL (medido na view em prod, 2026-06-09): 2.660 pedidos** — a estimativa
de ~550 (contagem via DOM drenado) estava errada ~5×. Consequência: a query do feed
**drena em páginas de 1000** (`.range` em loop dentro da queryFn — padrão fetchAll
canônico do repo, ~3 requests) com **dedupe por (origin,id)** (defesa contra shift
de offset com escrita concorrente) e **teto de sanidade de 5.000** (FEED_MAX_PAGES=5);
acima disso `truncated` avisa na UI. **Gatilho da fase server-side: ~5.000 pedidos**
(no ritmo atual ~12/dia, ~6+ meses).

## Fatos do schema (verificados, não presumidos)
- **`profiles.user_id` é UNIQUE** (`profiles_user_id_key`) → 1 profile por usuário →
  **LEFT JOIN normal** não duplica (não precisa de `lateral`/`LIMIT 1`).
- `profiles` **não** tem `account`/`is_primary`/`deleted_at` → **não** é multi-tenant
  por conta (app single-org) → join só por `user_id`.
- `sales_orders` **não** tem timestamp de ingestão (`inserted_at`); só `created_at`
  (data do pedido no Omie, **pode ser futura**) + `order_date_kpi`.
- `orders` (afiação) **não** tem `deleted_at` → sem soft delete a filtrar.
- Nomes reais: `sales_orders.customer_user_id`, `orders.user_id`, `profiles.user_id`
  (a 2ª opinião havia chutado `profiles.id`/`customer_id`).

## View `order_feed` (enxuta, security_invoker)
CTE `feed` faz o UNION ALL com **casts explícitos**; o join de `profiles` acontece
**uma vez** sobre o CTE. **Sem `customer_document`** (PII; só o detalhe usa).
Cast numérico **com guarda regex** (um item malformado não derruba a view inteira).
`array_agg` com `WITH ORDINALITY` (ordem estável) + contrato explícito (`'{}'` vazio).

```sql
create or replace view public.order_feed
with (security_invoker = true)
as
with feed as (
  select
    'sales'::text               as origin,
    so.id::uuid                 as id,
    so.created_at::timestamptz  as created_at,
    so.account::text            as account,
    so.omie_numero_pedido::text as order_number,
    so.customer_user_id::uuid   as customer_user_id,
    case when jsonb_typeof(so.items) = 'array' then coalesce((
      select array_agg(nullif(it->>'descricao','') order by ord)
             filter (where nullif(it->>'descricao','') is not null)
      from jsonb_array_elements(so.items) with ordinality as x(it, ord)
    ), '{}'::text[]) else '{}'::text[] end as item_names,
    case when jsonb_typeof(so.items) = 'array' then coalesce((
      select sum(case when it->>'quantidade' ~ '^-?[0-9]+(\.[0-9]+)?$'
                      then (it->>'quantidade')::numeric else 0 end)
      from jsonb_array_elements(so.items) as it
    ), 0) else 0 end::numeric    as item_quantity,
    so.status::text             as status,
    so.subtotal::numeric        as subtotal,
    so.total::numeric           as total
  from public.sales_orders so
  where so.deleted_at is null

  union all

  select
    'afiacao'::text,
    o.id::uuid,
    o.created_at::timestamptz,
    'colacor_sc'::text,
    null::text,
    o.user_id::uuid,
    case when jsonb_typeof(o.items) = 'array' then coalesce((
      select array_agg(coalesce(nullif(it->>'category',''), nullif(it->>'name',''), 'Afiação') order by ord)
      from jsonb_array_elements(o.items) with ordinality as x(it, ord)
    ), '{}'::text[]) else '{}'::text[] end,
    case when jsonb_typeof(o.items) = 'array' then coalesce((
      select sum(case when it->>'quantity' ~ '^-?[0-9]+(\.[0-9]+)?$'
                      then (it->>'quantity')::numeric else 1 end)
      from jsonb_array_elements(o.items) as it
    ), 0) else 0 end::numeric,
    o.status::text,
    o.subtotal::numeric,
    o.total::numeric
  from public.orders o
)
select
  f.origin, f.id, f.created_at, f.account, f.order_number, f.customer_user_id,
  p.name::text as customer_name,
  f.item_names, f.item_quantity, f.status, f.subtotal, f.total
from feed f
left join public.profiles p on p.user_id = f.customer_user_id;
```

## Frontend
- **`useSalesOrders`**: 1 `useQuery` em `order_feed`. Busca/accountFilter client-side
  sobre o conjunto **completo**. Some: 2 infinite queries, merge, profilesQuery,
  scroll infinito desta tela. `logosQuery`/`printOrder` permanecem.
  - **Query key com escopo de auth**: `['order-feed', userId]` (evita servir cache do
    usuário anterior após troca de sessão; busca/filtro NÃO entram na key — não mudam
    a request).
  - **Guarda de truncamento (honesta, não silenciar):** `select(..., { count: 'exact' })`
    + `.range(0, 999)`; se `count > data.length`, marcar `truncado` e exibir aviso
    ("mostrando 1000 de N — refine a busca") + telemetria. Sinal pra migrar à fase
    server-side antes de virar bug silencioso.
- **`SalesOrders.tsx`**: remove sentinel/"Carregar mais"; skeleton + estado de erro.
- **Detalhe por id** (impacta #672/#676): `useSalesOrderDetail(origin, id)` busca o
  pedido cheio (sales_orders|orders) + profile, normalizado pro shape `SalesOrder`.
  - key `['order-detail', userId, origin, id]`; **sem** `keepPreviousData` entre ids
    (não mostrar dados do pedido errado ao trocar de seleção).
  - `SalesOrderDetailSheet` recebe o `summary` (da listagem) + busca o detalhe ao
    abrir (skeleton); um container `OrderDetailContainer` faz o merge summary+detalhe
    pra minimizar a mudança no painel existente.
  - **Impressão espera o detalhe carregar** antes de montar o cupom e chamar print().
  - Prefetch opcional no hover/seleção (otimização, não requisito).

## RLS / segurança
- `security_invoker = true` → herda RLS das bases (staff já lê sales_orders/orders/
  profiles). `customer_document` fora da view reduz superfície de PII.
- **Homologação obrigatória com papéis reais** (a view é exposta pelo PostgREST e o
  cliente pode consultar qualquer coluna que tenha privilégio): staff, master, e
  **anon deve receber permission denied**. Caso pedido visível mas profile não →
  `customer_name` null (resultado correto das policies independentes, não bug).

## created_at futuro — ponderado, NÃO adotar feed_at agora
A 2ª opinião sugeriu separar `source_created_at` de `feed_at` (ingestão). **Não há
coluna de ingestão imutável** no schema, e ordenar por `created_at desc` (futuros no
topo) **é o comportamento atual** — mudar não foi pedido e seria regressão de
comportamento. **Decisão:** manter `created_at desc, origin, id` (ordem total estável,
`(origin,id)` é único). Limitação (pedido com data futura no topo) registrada como
follow-up; criar `feed_at` é trabalho de domínio separado.

## Migração / rollout (ordem importa)
1. Aplicar a view no **SQL Editor** (ritual Lovable) — a view existe **antes** do front.
2. **Validar em PostgreSQL 17 local** (técnica `db/verify-snapshot-replay.sh`):
   criar a view sobre o snapshot + semear itens com `quantidade` malformada (`''`,
   texto) e confirmar que a view NÃO quebra; conferir item_names/quantity; rodar com
   GUC de `auth.uid()`/role (staff/anon) pra checar RLS.
3. Mergear o PR do frontend → **Publish** → validar "delta" no app (acha todos, sem reset).

## Não-objetivos (fase futura, só se passar de ~1000)
Busca/keyset server-side (RPC com `p_search`/`p_account`/cursor); virtualização;
materialized view.

## Riscos
- Refatoração ampla do `useSalesOrders` → preservar a interface de retorno + testes.
- Detalhe-por-id muda painel/impressão recém-entregues (#672/#676) → re-testar cor da
  tinta + valor do item + impressão no app pós-Publish.

## Decisões pós-2ª opinião (resumo)
| Ponto levantado | Decisão |
| --- | --- |
| `LIMIT 1` arbitrário no profiles | **Resolvido**: `user_id` é UNIQUE → LEFT JOIN normal |
| Multi-tenant (join por account) | **Não se aplica**: profiles sem `account` (single-org) |
| Cast numérico derruba a view | **Adotado**: guarda regex antes do cast |
| Truncamento silencioso em 1000 | **Adotado**: count exact + aviso honesto |
| Cache não isolado por usuário | **Adotado**: userId na query key |
| `customer_document` (PII) na view | **Adotado**: removido da view; só no detalhe |
| Contrato de tipos do UNION | **Adotado**: casts explícitos nas 2 branches |
| array_agg ordem instável | **Adotado**: WITH ORDINALITY + order by |
| created_at futuro / feed_at | **Ponderado/não-adotado**: sem coluna de ingestão; mantém comportamento atual + follow-up |
| Detalhe lazy sem placeholder | **Adotado**: sem keepPreviousData entre ids; impressão espera carregar |
| soft delete em orders | **Confirmado**: orders não tem deleted_at → não filtrar |
