# Lembrete de "Visitas de hoje" no dashboard do vendedor

**Data:** 2026-05-31
**Autor:** Lucas (delegou "decida você + codex") + Claude
**Status:** decisão cravada (codex confirmou a frente + o escopo v1)

---

## 1. Problema

A "Agendar visita" entregou a fila de visitas + o painel "Próximas visitas" **dentro do route planner** (`/admin/route-planner`). Mas não há **nudge proativo**: o vendedor só vê o que agendou se navegar até lá. Resultado: visita agendada pode ser esquecida. Falta fechar o loop **agendou → lembra → age**.

> Frente escolhida via "decida você + codex". Codex confirmou: maior valor×menor-risco agora (transforma a feature recém-entregue em comportamento operacional diário; PR pequeno; baixa colisão com financeiro/reposição que têm sessões paralelas; sem backend novo).

## 2. Escopo v1 (mínimo, codex-afiado)

**Faz:** um card "Visitas de hoje" no home do vendedor mostrando as visitas **pendentes agendadas por mim para hoje** — count + até 3 nomes de cliente + 1 CTA "Ver rota".

**NÃO faz (cortado do v1):** push/notificação, sino global, captura de resultado/notas, editar/reagendar no card, endereços, horários (o schema `visitas_agendadas` é **date-only** — não há hora). Cobertura de carteira de outro vendedor (`scheduled_by = eu` only — ver §6).

## 3. Decisão não-óbvia: timezone ("hoje")

Codex flagou timezone como o maior risco. **Decisão: usar `hojeISO()` (UTC, o helper existente em `src/lib/visitas/today.ts`), NÃO um "hoje Brasil" novo.**

Razão — **consistência > correção isolada**:
- A `AgendarVisitaDialog` **armazena** `scheduled_date` via `<input type="date">` com default/`min` = `hojeISO()` (UTC).
- O **`loadScheduledVisits` (Fase 2) do route planner já filtra `visitas_agendadas` por `scheduled_date = new Date().toISOString().split('T')[0]` (UTC)** e mostra como parada.
- O card de lembrete deve mostrar **exatamente o mesmo conjunto** que o route planner. Se o card usasse "hoje Brasil" e a rota usa UTC, eles **divergiriam** na janela noturna (21h–24h BRT): card mostraria visita que a rota não mostra, ou vice-versa. Pior UX que o bug teórico.

O bug UTC×Brasil **existe** mas é **sistêmico** (afeta dialog + route planner + card juntos) e de **baixo impacto prático** (vendedor checa de manhã, quando UTC = data Brasil; a divergência é só 21h–24h, quando o vendedor já encerrou o dia). **Follow-up registrado:** um PR dedicado que troca `hojeISO` + as cópias inline de `new Date().toISOString()` no `useRoutePlanner` para `America/Sao_Paulo` **juntas** (consertar pela metade quebraria a consistência). Fora do escopo deste v1.

`hojeISO()` e o `new Date().toISOString().split('T')[0]` inline do `loadScheduledVisits` computam **o mesmo valor** (data UTC) → o card reusando `hojeISO()` bate 1:1 com a rota.

## 4. Arquitetura (3 peças + 1 inserção; sem backend)

### 4.1 Helper puro `montarVisitasHoje` (TDD)
`src/lib/visitas/visitas-hoje.ts`. Junta as linhas de `visitas_agendadas` (já filtradas por hoje) com um mapa de nomes (`customer_user_id → name`), e produz o resumo do card.
```ts
export interface VisitaHojeRow { id: string; customer_user_id: string; }
export interface VisitaHojePreview { id: string; customer_user_id: string; nome: string; }
export interface VisitasHojeResumo { total: number; preview: VisitaHojePreview[]; }

export function montarVisitasHoje(
  rows: VisitaHojeRow[],
  nomePorUsuario: Map<string, string>,
  limit = 3,
): VisitasHojeResumo {
  const preview = rows.slice(0, limit).map(r => ({
    id: r.id,
    customer_user_id: r.customer_user_id,
    nome: nomePorUsuario.get(r.customer_user_id) || 'Cliente',
  }));
  return { total: rows.length, preview };
}
```
> Puro, testável: total = todas as de hoje; preview = até `limit`; nome com fallback 'Cliente' (espelha o `loadTodayVisits` do route planner, que usa o mesmo fallback).

### 4.2 Hook `useVisitasHoje`
`src/hooks/useVisitasHoje.ts`. Faz o I/O e chama o helper.
- Query A: `visitas_agendadas` `.select('id, customer_user_id').eq('scheduled_by', uid).eq('status','pendente').eq('scheduled_date', hojeISO()).order('scheduled_date')`.
- Query B (enriquecimento): `profiles` `.select('user_id, name').in('user_id', <customer_user_ids>)` → monta o `Map`. Só roda se houver linhas (senão `Map` vazio).
- Retorna `montarVisitasHoje(rows, nameMap)` + `isLoading`. `enabled: !!uid`.
- Usa `useQuery` (react-query), `queryKey: ['visitas-hoje', uid]`. Reaproveita o `supabase` client + `useAuth` + `hojeISO`.

### 4.3 Card `VisitasHojeCard`
`src/components/dashboard/VisitasHojeCard.tsx`.
- Chama `useVisitasHoje()`. **Self-hide:** se `isLoading` → null (ou skeleton mínimo); se `total === 0` → **return null** (não polui o dashboard).
- Renderiza: título "Visitas de hoje" + badge com `total`; lista os `preview` (nomes); se `total > preview.length`, "+N" ; CTA `<Link to="/admin/route-planner">Ver rota</Link>` (Button). Usa tokens do design system (Card shadcn, sem cores hardcoded).
- Evento de analytics opcional `track('visitas_hoje.ver_rota')` no CTA (convenção `<area>.<action>`). **Cortável** se rende pouco — manter simples.

### 4.4 Inserção
`src/components/dashboard/FarmerDashboardV2.tsx`: inserir `<VisitasHojeCard />` como **primeiro card** dentro do `<div className="container mx-auto p-4 space-y-4 max-w-5xl">`. (Hunter/Closer = fast-follow, mesma 1 linha.)

## 5. Testes
- **Unit (vitest, TDD)** de `montarVisitasHoje`: total reflete todas as linhas; preview limitado a `limit` (3); nome resolvido pelo Map; fallback 'Cliente' quando ausente; lista vazia → `{total:0, preview:[]}`.
- A fiação do card/hook (query + render + self-hide) → **QA manual** (mock de react-query+router rende pouco). Documentar no PR: logar como vendedor com visita agendada pra hoje → card aparece com count+nomes; sem visita → card some; "Ver rota" navega pro route planner.
- Suíte + typecheck + lint + build verdes.

## 6. Fora de escopo / limitações conscientes
- **`scheduled_by = eu` only:** um vendedor que cobre a carteira de outro (férias) NÃO vê as visitas agendadas pelo titular. Codex: **não resolver no v1** sem sinal de produto (exigiria decidir o modelo de cobertura, espelhando `carteira_visivel_para`). Limitação registrada.
- **Timezone UTC** (ver §3): follow-up sistêmico.
- **Só FarmerDashboardV2** no v1: Hunter/Closer/Master são fast-follow (card é self-contained, self-hide → adicionar é 1 import + 1 linha).
- **Sem endereços/horários** (schema date-only; endereço exigiria lookup extra).
- Não toca `useVisitasAgendadas`, `AgendarVisitaDialog`, `useRoutePlanner`, RLS, nem o backend.

## 7. Risco
Baixo. Feature **aditiva e read-only** sobre dados **já validados em produção** (a migration `visitas_agendadas` passou 8/8 checks). O card self-hide → zero impacto quando não há visita. Nenhuma escrita, nenhum money-path. O único ponto de atenção (timezone) é uma escolha consciente de consistência, documentada, com follow-up.
