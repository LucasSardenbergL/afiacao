# Aba "Visitas" no Customer 360 — histórico de visitas com resultado

**Data:** 2026-06-01
**Autor:** Lucas (escolheu "surfaçar os resultados" + delegou o design) + Claude
**Status:** design cravado (founder delegou; PR pronto pra revisar)

---

## 1. Problema

A captura de resultado de visita **já existe e funciona** (route planner → check-out → `CheckoutDialog` grava `result`/`revenue_generated`/`order_created`/`notes` em `route_visits`). Mas os resultados **quase não são surfaçados** — só aparecem no card de hoje do route planner. **Não há onde rever** o histórico de visitas de um cliente nem o resultado delas. Os dados estão em `route_visits`, faltando o lugar de ver.

> Frente escolhida pelo founder ("surfaçar os resultados") após descobrir que a captura já existe. Decisão de ONDE (Customer 360) delegada a mim.

## 2. Escopo v1

Uma **aba "Visitas"** no `Customer360View` (ao lado de "Chamadas"), espelhando o `CustomerCallsTab`, mostrando o **histórico de visitas daquele cliente** com resultado/receita/notas + um **resumo** (total · taxa de conversão · receita gerada).

**NÃO faz (v1):** editar/excluir visita no histórico, filtros, gráficos, ações (re-check-out), paginação (limita às últimas N). Não toca a captura (já existe) nem o route planner.

## 3. Dados (read-only, sem backend)

`route_visits` (colunas já existentes): `id, customer_user_id, visited_by, visit_date, visit_type, check_in_at, check_out_at, result, notes, revenue_generated, order_created, created_at`.

**RLS já cobre** (endurecida no #340): SELECT de `route_visits` = gestor/master OR own (`visited_by`) OR carteira/cobertura (`carteira_visivel_para`). Logo a aba mostra **as visitas que o staff logado tem permissão de ver** desse cliente (próprias + carteira; gestor vê tudo) — degradação honesta automática, sem mudança de RLS. (O Customer 360 já é staff-only via gating.)

Taxonomia de `result` (do `CheckoutDialog` existente): `pedido_fechado`, `interesse`, `sem_interesse`, `ausente`, `reagendar` (+ `null` = sem resultado / visita sem check-out).

## 4. Arquitetura (3 peças + 1 aba; sem backend)

### 4.1 Helpers puros (TDD) — `src/lib/visitas/visit-result.ts`
```ts
export type VisitResultTone = 'success' | 'info' | 'error' | 'warning' | 'muted';
export interface VisitResultLabel { label: string; emoji: string; tone: VisitResultTone; }

/** Mapeia o código de result (route_visits) → rótulo + emoji + tom (tokens text-status-*). */
export function visitResultLabel(result: string | null): VisitResultLabel {
  switch (result) {
    case 'pedido_fechado': return { label: 'Pedido fechado', emoji: '✅', tone: 'success' };
    case 'interesse':      return { label: 'Interesse',      emoji: '🤔', tone: 'info' };
    case 'sem_interesse':  return { label: 'Sem interesse',  emoji: '❌', tone: 'error' };
    case 'ausente':        return { label: 'Ausente',        emoji: '🚫', tone: 'warning' };
    case 'reagendar':      return { label: 'Reagendar',      emoji: '📅', tone: 'warning' };
    default:               return { label: 'Sem resultado',  emoji: '—',  tone: 'muted' };
  }
}

export interface VisitResumoRow { result: string | null; revenue_generated: number | null; }
export interface VisitResumo { total: number; comResultado: number; fechados: number; taxaConversao: number | null; receitaTotal: number; }

/** Resumo do histórico: total, quantos tiveram resultado, fechados, taxa (fechados/comResultado) e receita somada. */
export function resumoVisitas(rows: VisitResumoRow[]): VisitResumo {
  const total = rows.length;
  const comResultado = rows.filter(r => r.result != null).length;
  const fechados = rows.filter(r => r.result === 'pedido_fechado').length;
  const taxaConversao = comResultado > 0 ? fechados / comResultado : null; // null = sem base
  const receitaTotal = rows.reduce((s, r) => s + (r.revenue_generated ?? 0), 0);
  return { total, comResultado, fechados, taxaConversao, receitaTotal };
}
```
> `taxaConversao` = fechados ÷ visitas COM resultado (não ÷ total) — honesto: visitas sem check-out não diluem. `null` quando não há base.

### 4.2 Hook `useCustomerVisits` — `src/hooks/useCustomerVisits.ts`
Espelha `useCustomerCalls`. Query `route_visits` por `customer_user_id` + enriquece `visited_by`→nome (`profiles`).
- `useQuery({ queryKey: ['customer-visits', customerId], enabled: !!customerId, staleTime: 60_000 })`.
- Query A: `route_visits.select('id, visited_by, visit_date, check_in_at, check_out_at, result, notes, revenue_generated, order_created').eq('customer_user_id', customerId).order('check_in_at', { ascending: false }).limit(50)`.
- Query B (enriquecimento): `profiles.select('user_id, name').in('user_id', <visited_by únicos>)` → `Map`. Só roda se houver linhas.
- Retorna `CustomerVisitRow[]` (cada row + `visitedByName: string`).
- Tipo `CustomerVisitRow` exportado pra UI.

### 4.3 Componente `CustomerVisitsTab` — `src/components/customer/CustomerVisitsTab.tsx`
Espelha `CustomerCallsTab`. `{ customerId }`.
- `const { data, isLoading } = useCustomerVisits(customerId)`.
- `isLoading` → spinner (mesmo padrão do CustomerCallsTab). `!data?.length` → empty state ("Nenhuma visita registrada. As visitas com check-out no planejador de rotas aparecem aqui.").
- **Resumo** (topo): `resumoVisitas(data)` → "N visitas · X% conversão · R$ Y" (taxaConversao null → "—"; formatar R$ com o helper de format existente). Card compacto.
- **Lista:** cada visita → linha com: data (`check_in_at` formatado), **badge de resultado** (`visitResultLabel` → emoji+label, classe `text-status-{tone}`), receita (se `pedido_fechado` e >0), `visitedByName`, notas (truncadas/expand). Tokens do design system, sem cor hardcoded.

### 4.4 Aba no `Customer360View`
`src/components/adminCustomers/Customer360View.tsx`:
- Import `CustomerVisitsTab` + um ícone lucide (`MapPin` ou `CalendarCheck`).
- `<TabsTrigger value="visits">` na `TabsList` (após "calls"/Chamadas).
- `<TabsContent value="visits"><CustomerVisitsTab customerId={customer.user_id} /></TabsContent>`.
- (Usar o mesmo `customerId`/prop que o `CustomerCallsTab` recebe — confirmar o nome da prop no plano.)

## 5. Testes
- **Unit (vitest, TDD):** `visitResultLabel` (cada código → label/emoji/tone; null/desconhecido → "Sem resultado"/muted); `resumoVisitas` (total, comResultado, fechados, taxaConversao = fechados/comResultado, null quando comResultado=0, receitaTotal soma ignorando null).
- A fiação hook/tab/aba → **QA manual** (mock de react-query rende pouco). Documentar no PR: abrir Customer 360 de cliente com visita registrada → aba "Visitas" mostra histórico + resumo.
- Suíte + typecheck + lint + build verdes.

## 6. Fora de escopo / limitações
- **Read-only:** não edita/exclui/re-faz check-out (a captura é no route planner).
- **RLS:** mostra só as visitas visíveis ao staff logado (own/carteira/gestor) — by design.
- **Limita às últimas 50** (sem paginação no v1).
- Não toca `route_visits` (schema), `useRoutePlanner`, `CheckoutDialog`, RLS, backend.
- **KPIs agregados de equipe** (dashboard de conversão de visitas por vendedor) = futuro; este v1 é por-cliente no 360.

## 7. Risco
Baixo. **Read-only** sobre `route_visits` (RLS já endurecida no #340). Aba nova e isolada, espelhando o `CustomerCallsTab` já existente. Zero escrita, zero money-path, zero backend. O Customer 360 é staff-only (gating). Se não houver visitas visíveis → empty state honesto.
