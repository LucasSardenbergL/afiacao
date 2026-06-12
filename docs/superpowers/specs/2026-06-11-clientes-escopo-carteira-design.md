# Clientes (`/admin/customers`) — escopo por carteira + contagem real

Data: 2026-06-11 · Frontend-only (sem migration, sem edge function) · Branch: `claude/hardcore-taussig-ffb01b`

## Problema

A tela de Clientes (`/admin/customers`, hook `useAdminCustomers` + `CustomerListView`) tem 3 defeitos quando uma vendedora a usa (ou quando o master a inspeciona pela lente "Ver como pessoa"):

1. **Lista = base inteira.** `customersQuery` busca `profiles` com `.eq('is_employee', false)`, paginado 100/página, **sem nenhum filtro de carteira**. A vendedora (e o master na lente dela) vê todos os clientes do banco, não a carteira dela.
2. **Scores não são lente-aware.** `loadScores` usa `farmer_client_scores.eq('farmer_id', user.id)` com o `user.id` do **master logado**. Na lente de uma vendedora, os scores mostrados são os da carteira do master (errado). Como a lista é a base inteira mas os scores são de uma carteira pequena, quase tudo cai no fallback ("Crítico/R$0/999d/-").
3. **Contagem enganosa.** `CustomerListView` mostra `{customers.length} clientes na carteira` = só a 1ª página carregada (100), cresce com o scroll, e o rótulo "na carteira" é falso.

Pedido do founder: (1) a vendedora vê só a carteira dela + cobertura quando cobre alguém de férias; (2) a contagem é o total real da carteira; (3) na lente, reflete a carteira da vendedora vista.

## Decisões (founder + revisão Codex)

- **Escopo por persona** (founder): vendedor escopa pela carteira; gestor comercial e master veem a base inteira; na lente, segue a persona do alvo.
- **Contagem exata pra todos** (founder): no modo carteira o `length` já é exato; no modo base, `count` no servidor.
- **Revisão adversária do Codex** (gpt-5.5, consult): 5 P1 + P2 incorporados — paginar a carteira, scores por `customer_user_id`, filtrar `eligible`, reset de detalhe ao trocar de lente, chunk seguro do `.in()`. Detalhe no §"Decisões da revisão".

## Design

### Decisão de modo (lente-aware)

Fonte: `useDisplayAccess()` (espelha o real fora da lente; deriva do perfil do alvo na lente).

```
podeVerCompleta = (displayIsMaster || displayIsGestorComercial) && !displayIsSalesOnly
modo = podeVerCompleta ? 'completa' : 'carteira'
```

Helper puro `resolveModoEscopo({ displayIsMaster, displayIsGestorComercial, displayIsSalesOnly })`.

- `sales-only` força `carteira` mesmo com role gerencial (a restrição mais forte ganha — um CPF de campo nunca vê a base inteira).
- Gate de execução: `queriesReady = isStaff && !displayLoading && !!user`. Na lente, espera o perfil do alvo resolver antes de decidir o modo (senão pisca o modo errado).

### Modo carteira (vendedor / lente de vendedor)

Fonte da lista = `carteira_assignments` (a posse formal; `UNIQUE(customer_user_id)`, coluna `eligible boolean DEFAULT true`).

`fetchCarteiraClientes(supabase, { isImpersonating, effectiveUserId, baseId })`:

1. **Pagina `carteira_assignments`** (`.select('customer_user_id, owner_user_id').eq('eligible', true).order('customer_user_id').range(from, from+999)` em laço até a página vir incompleta). Uma select pura capa em 1000 → carteira grande ficaria silenciosamente truncada.
   - **Fora da lente**: sem filtro de `owner_user_id` — a RLS `View carteira por visibilidade` (`USING carteira_visivel_para(customer_user_id, auth.uid())`) já escopa pra carteira da vendedora + cobertura ativa.
   - **Na lente** (sessão é o master → RLS devolve tudo): `.eq('owner_user_id', effectiveUserId)` pra escopar à carteira-base do alvo.
2. IDs únicos → **`profiles` em lotes de ~150** (`.in('user_id', chunk).eq('is_employee', false)`), checando erro de cada lote. Lotes pequenos: 1000 UUIDs estouram o limite de URL do proxy (≠ cap de linhas).
3. Marca `coberto_de = owner_user_id !== baseId ? owner_user_id : null` (`baseId` = `effectiveUserId` na lente, `user.id` fora). Ordena por nome (`localeCompare 'pt-BR'`).
4. Retorna `{ customers, ids }`. Sem scroll infinito — carrega a carteira inteira → `total = customers.length` (exato) e a busca passa a varrer a carteira toda (hoje a busca só filtra a página de 100 = bug latente).

### Modo completa (gestor/master sem lente, ou lente de gestor)

- `customersQuery` atual (`profiles` paginado 100, scroll infinito) — inalterado.
- `+ countQuery`: `profiles.select('user_id', { count: 'exact', head: true }).eq('is_employee', false)` → total exato. Rótulo "clientes na base" (não "na carteira").

### Scores (ambos os modos)

Sai do `farmer_id` e passa a buscar por **`customer_user_id` dos clientes visíveis**, em lotes:

```
farmer_client_scores.in('customer_user_id', chunk(visibleIds, 150))
```

- `UNIQUE(customer_user_id)` (migration `20260524170000`) → 1 linha por cliente, sem ambiguidade de dono.
- Conserta os 3 sintomas que o `farmer_id` causava: scores vazios pro gestor/master, scores stale após reatribuição (o rebuild atualiza `carteira_assignments` antes de reconciliar score), e divergência com a lista.
- Segurança: a RLS de `farmer_client_scores` (#329) é `pode_ver_carteira_completa(uid) OR carteira_visivel_para(customer_user_id, uid)` — **o mesmo predicado** da `carteira_assignments`. O vendedor lê só a carteira dele (a RLS reforça mesmo se a lista mandar id alheio); gestor/master/lente leem tudo. Carteira e scores ficam consistentes por construção.
- Migra de `useState`+`useEffect` para `useQuery` (sem estado mutável que vaza entre trocas de lente).

### Reset ao trocar de lente

`selectedCustomer`/`customerTools`/`orders` são estado local. Trocar a lente A→B enquanto vê o cliente de A deixa o detalhe de A na tela. `useEffect([effectiveUserId])` reseta o detalhe e volta pra lista. O deep-link `customerId` só abre se o cliente está na lista visível (já é o comportamento do efeito existente; o reset cobre a troca).

### Query keys

Todas incluem `modo` + `baseId` (= `effectiveUserId` na lente). Troca de lente A→B invalida e re-busca. Scores: `['admin-clientes-scores', modo, baseId, visibleIds.length]` (no modo completa cresce por página → re-busca incremental).

### UI (`CustomerListView`)

- Cabeçalho: `{total} clientes na carteira` (carteira) / `{total} clientes na base` (completa).
- Sem score → badge "N/A" / "—", não "Crítico" (não fabricar saúde inexistente).
- Modo carteira: sem sentinela de scroll infinito (tudo carregado); rodapé "N na carteira".
- Badge de cobertura nos clientes com `coberto_de` (reusa a noção de "coberto" dos hooks irmãos).

## Arquivos

- **NOVO** `src/lib/carteira/escopo-clientes.ts` — helpers puros (`resolveModoEscopo`, `chunk`, `marcarCobertura`, `ordenarPorNome`) + as funções de fetch testáveis (`fetchCarteiraClientes`, `fetchProfilesChunked`, `fetchScoresPorCustomer`).
- **NOVO** `src/lib/carteira/__tests__/escopo-clientes.test.ts` — vitest.
- **EDIT** `src/components/adminCustomers/useAdminCustomers.ts` — bifurcação de modo, fetch da carteira, scores por `customer_user_id`, count, reset de lente, query keys.
- **EDIT** `src/components/adminCustomers/CustomerListView.tsx` — label dinâmico, badge N/A, scroll só no modo completa, badge de cobertura.
- **EDIT** `src/components/adminCustomers/types.ts` — `coberto_de?: string | null` no `Customer`.

## Testes (helpers puros, TDD)

- `resolveModoEscopo`: master→completa, gestor→completa, vendedor→carteira, sales-only→carteira, **sales-only + gestor→carteira** (restrição ganha), displayLoading não decide.
- `chunk`: vazio, exato, com resto, tamanho 1.
- `marcarCobertura`: próprio (`coberto_de=null`), coberto (`coberto_de=owner`), na lente (`baseId=alvo`).
- `ordenarPorNome`: acentos pt-BR ("Á" antes de "B").

## Limitações v1 (registradas, consistentes com `useMyCarteiraScores`)

- Na lente mostro a carteira-**base** do alvo, sem a cobertura que *o alvo* faz. A cobertura da vendedora real logada funciona 100% (via RLS). (Follow-up: buscar `carteira_coverage WHERE covering_user_id=effectiveUserId` na lente.)
- `valid_from` da cobertura é ignorado pela RLS e por `useMyActiveCoverage` (pré-existente) → cobertura agendada pro futuro aparece já. Fora de escopo (não é meu código).
- Count do modo completa usa `is_employee=false`; pode divergir levemente do filtro defensivo de `user_roles` (employee com flag stale). Aproximação aceita.
- Cliente com assignment mas sem `profiles` (raro; a FK aponta `auth.users`, não `profiles`) não renderiza; `total` = clientes renderizados (alinha com a lista).

## Não-objetivos

- Toggle "Minha carteira / Todos" pro gestor (rejeitado pelo founder — gestor vê tudo).
- Mudar RLS / criar RPC `_for` (o escopo aqui é display-only, igual ao `useMyCarteiraScores`; a RLS existente já faz a fronteira real).
- Virtualização de tabela (carteira de uma vendedora cabe; se surgir vendedora com >~3000 clientes, reavaliar).

## Critério de pronto

- Vendedora real logada: vê só a carteira dela + cobertos (marcados), contagem = total real, busca varre tudo.
- Lente de vendedora: mesma coisa, escopada ao alvo.
- Gestor/master: base inteira, contagem exata, label "na base".
- `bun run typecheck` + `bun run test` + `bun lint` + `bun build` verdes.
