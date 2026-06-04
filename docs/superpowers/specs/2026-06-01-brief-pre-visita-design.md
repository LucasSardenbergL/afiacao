# Brief Pré-Visita — contexto consolidado do cliente

**Data:** 2026-06-01
**Autor:** Lucas (escolheu no brainstorm) + Claude + codex (ideia #3 do brainstorm)
**Status:** design cravado (founder escolheu a frente + delegou o design)

---

## 1. Problema / oportunidade

O vendedor chega no cliente (ou agenda uma visita) **sem contexto consolidado** — os dados existem (compras, visitas, ligações) mas espalhados em abas/telas. Codex (brainstorm): *"chegar no cliente com contexto, não de mãos vazias"* — um bloco read-only que mostra o **estado atual** do cliente num glance, no momento de engajar.

> Frente escolhida pelo founder após brainstorm eu+codex. Read-only, sem backend, área fria (sem colisão), alto valor-sentido.

## 2. Escopo v1

Um card compacto **`CustomerBrief`** com **3 facts de recência** consolidadas, mostrado no Customer 360 (acima das abas) e dentro do `AgendarVisitaDialog` (contexto na hora de agendar):

1. **Última compra** — "há X dias · R$ Y" (de `sales_orders`).
2. **Última visita** — "há X dias · {resultado}" (de `route_visits` via `useCustomerVisits`).
3. **Última ligação** — "há X dias · {resultado}" (de `farmer_calls` via `useCustomerCalls`).

Cada fact degrada honesto pra "nunca" / "—" quando não há dado (ou RLS não deixa ver).

**NÃO faz (v1, cortado no brainstorm):** score/saúde (já no hero do 360), missão (visit_score é grande), gráficos, IA, pre-call brief com KB, ações no brief, "pedidos recentes" como lista (só o último).

## 3. Dados (read-only, sem backend)

- **Última compra:** `sales_orders` (colunas existentes: `customer_user_id`, `order_date_kpi`, `created_at`, `total`). Query por `customer_user_id`, ordena por `order_date_kpi` desc (fallback `created_at`), limit 1. RLS de sales_orders já permite staff (a página `/sales` lê) — degradação honesta se fora da carteira.
- **Última visita:** `useCustomerVisits(customerId)[0]` (já entregue no #555). `check_in_at` + `result`.
- **Última ligação:** `useCustomerCalls(customerId)[0]` (já existente). `started_at` + `call_result`.

⚠️ **"Última compra" = `sales_orders` (venda de produto), NÃO a tabela `orders` (afiação/serviço)** que o `useCustomerOrders` consulta — pro contexto comercial do vendedor, a compra relevante é a venda.

## 4. Arquitetura (helper TDD + hook + componente + 2 placements)

### 4.1 Helper puro `recencia.ts` (TDD) — `src/lib/visitas/recencia.ts`
```ts
/** Dias de calendário entre a data de `iso` e `hojeISO` (ambos 'YYYY-MM-DD' ou ISO). null se iso vazio. */
export function diasDesde(iso: string | null | undefined, hojeISO: string): number | null {
  if (!iso) return null;
  const d = iso.slice(0, 10);
  const h = hojeISO.slice(0, 10);
  const ms = Date.parse(`${h}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86_400_000);
}

/** Rótulo de recência: nunca / hoje / ontem / há N dias. Negativo (futuro) → "hoje". */
export function recenciaLabel(iso: string | null | undefined, hojeISO: string): string {
  const n = diasDesde(iso, hojeISO);
  if (n === null) return 'nunca';
  if (n <= 0) return 'hoje';
  if (n === 1) return 'ontem';
  return `há ${n} dias`;
}
```
> Usa a parte de DATA do ISO (UTC, consistente com a convenção do codebase — `hojeISO`). Pra "há X dias" o off-by-one noturno é irrelevante.

### 4.2 Hook `useCustomerLastSalesOrder` — `src/hooks/useCustomerLastSalesOrder.ts`
```ts
// useQuery: sales_orders por customer_user_id, ordena order_date_kpi desc (fallback created_at), limit 1.
// Retorna { date: string | null, total: number | null } | null (null = sem compra / RLS).
export interface CustomerLastOrder { date: string | null; total: number | null; }
export function useCustomerLastSalesOrder(customerId: string | null) { /* useQuery enabled:!!customerId, staleTime 60s */ }
```
- `.select('order_date_kpi, created_at, total').eq('customer_user_id', customerId).order('order_date_kpi', { ascending: false, nullsFirst: false }).limit(1)`.
- `date = row.order_date_kpi ?? row.created_at` (a `order_date_kpi` é a data do pedido pra KPI; fallback `created_at`).

### 4.3 Componente `CustomerBrief` — `src/components/customer/CustomerBrief.tsx`
`{ customerId }`. Self-contained: usa os 3 hooks (`useCustomerLastSalesOrder`, `useCustomerVisits`, `useCustomerCalls`) + os helpers.
- `hoje = new Date().toISOString().slice(0,10)`.
- Card compacto (1 linha por fact, ícone + label + valor):
  - 🛒 **Última compra:** `recenciaLabel(lastOrder?.date)` + (se houver total) `· {formatBRL(total)}`. Sem compra → "nunca comprou".
  - 📍 **Última visita:** `recenciaLabel(lastVisit?.check_in_at)` + badge `visitResultLabel(lastVisit.result)` (emoji+label, `text-status-{tone}`). Sem visita → "nenhuma".
  - 📞 **Última ligação:** `recenciaLabel(lastCall?.started_at)` + `call_result` (texto cru/curto). Sem ligação → "nenhuma".
- Loading (qualquer hook carregando) → skeleton compacto. Tokens do design system, sem cor hardcoded.
- Título do card: "Resumo pré-visita" (ou só um header discreto).

### 4.4 Placements
- **Customer360View** (`src/components/adminCustomers/Customer360View.tsx`): `<CustomerBrief customerId={customer.user_id} />` num card proeminente **após os KPI cards de score, antes das abas** (o "estado atual" antes de drillar).
- **AgendarVisitaDialog** (`src/components/visitas/AgendarVisitaDialog.tsx`): `<CustomerBrief customerId={customerUserId} />` no topo do conteúdo do dialog (contexto na hora de agendar). O dialog já recebe `customerUserId`.

## 5. Testes
- **Unit (vitest, TDD):** `diasDesde` (null vazio; 0 mesmo dia; 1 ontem; N dias; NaN→null) + `recenciaLabel` (nunca/hoje/ontem/há N dias).
- Hook/componente/placements → **QA manual** (mock de 3 react-query rende pouco). Documentar no PR: abrir Customer 360 → card "Resumo pré-visita" com as 3 recências; abrir "Agendar visita" → mesmo brief no topo.
- Suíte + typecheck + lint + build verdes.

## 6. Fora de escopo / limitações
- **Read-only.** Não toca schema/sales_orders/route_visits/farmer_calls/RLS/backend.
- **RLS:** mostra só o que o staff logado pode ver (carteira/gestor) — "—"/"nunca" honesto fora disso.
- **3 facts apenas** (compra/visita/ligação). Score/missão/KB/pedidos-como-lista = fora do v1.
- O `call_result` tem taxonomia própria (≠ visita) — mostrado como texto cru no v1 (sem mapa de label dedicado; v2 se valer).

## 7. Risco
Baixo. **Read-only**, reusa 2 hooks já entregues + 1 hook novo trivial (sales_orders por cliente). 1 helper puro testado. 2 placements de um componente isolado e auto-suficiente. Zero escrita, zero backend, zero money-path. RLS já cobre (degradação honesta). O Customer 360 e o dialog são staff-only.
