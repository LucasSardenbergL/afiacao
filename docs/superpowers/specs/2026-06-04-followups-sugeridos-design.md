# "Follow-ups sugeridos" — card read-only pós-visita (dashboard Closer)

**Data:** 2026-06-04 · **Tipo:** front puro, read-only, sem migration/edge/deploy · **Branch:** `claude/next-best-action-visita`

## Problema

O check-out de visita (`CheckoutDialog`) grava `result`/`revenue`/`notes` e **acaba ali** — não há nenhum prompt de "e agora?". Resultados **mornos** (`reagendar`/`interesse`/`ausente`) decaem sem follow-up: o vendedor esquece de voltar/ligar. Não há superfície que diga "essas visitas pedem retorno".

## Solução (v1)

Card **"Follow-ups sugeridos"** no dashboard Closer. Lista as visitas do vendedor logado cujo **estado atual** pede uma próxima ação, com deep-link pro fluxo existente (agendar/abrir cliente). **Read-only**: clicar NÃO grava nada — abre o fluxo já existente. Quando o vendedor age (agenda retorno / liga), a regra de de-dup tira o item no próximo refetch.

> **Nome deliberado** (codex P1): "Follow-ups sugeridos", NÃO "Next Best Action" / "Próxima melhor ação" — não prometer ranking inteligente sobre uma heurística client-side. É sugestão, não verdade.

### Por que é baixo-risco (vs. um KPI)

As sugestões são **hints não-vinculantes** — errar "aproximadamente" é barato (≠ um win-rate oficial, que vira número que o gestor age em cima). O único dano possível é o vendedor confiar e contatar um cliente já resolvido por outro canal → mitigado pelo **de-dup contra agenda pendente + contato recente** (abaixo) e pela moldura honesta ("sugestão").

## Dado (tudo já existe; RLS own-scoped; 3 queries leves)

1. **`route_visits`** (`visited_by = eu`, `check_in_at >= hoje−45d`): `customer_user_id, result, notes, check_in_at, visit_date, revenue_generated`. (45d = a janela mais larga; o helper aplica a janela por-resultado.)
2. **`visitas_agendadas`** (`scheduled_by = eu`, `status = pendente`, `scheduled_date >= hoje`): `customer_user_id` → Set "já agendei retorno".
3. **`farmer_calls`** (`farmer_id = eu`, `started_at >= hoje−45d`): `customer_user_id, started_at` → Map "último contato meu por cliente". (Sem filtro de transcript — qualquer contato conta.)

Enriquecimento de nome: `profiles.select('user_id, name')` pelos `customer_user_id` dos itens finais.

## Regra de geração (helper PURO testável — `src/lib/visitas/followups.ts`)

`montarFollowups({ visitas, agendadasPendentes, ultimoContatoPorCliente, hojeISO }) → FollowupItem[]`

1. Agrupa `visitas` por `customer_user_id`; fica com a **mais recente** (por `check_in_at ?? visit_date`).
2. Inclui só se `result ∈ {reagendar, interesse, ausente}` (mornos que decaem). Dropa `pedido_fechado` (ganho, sem ação pendente — pós-venda é outro produto), `sem_interesse` e `null`.
3. **De-dup agenda:** dropa se `customer_user_id ∈ agendadasPendentes`.
4. **De-dup contato** (codex P1): dropa se `ultimoContatoPorCliente.get(cid) > lastVisitAt` (já liguei/contatei DEPOIS da visita). Sem isso, o card "nunca limpa" pra quem resolve por telefone.
5. **Janela por-resultado** (codex P1; `diasDesde(lastVisitAt, hojeISO)`): `reagendar ≤ 45d`, `interesse ≤ 30d`, `ausente ≤ 21d`. Fora da janela → dropa (lead frio vira ruído; não mostrar "60d esfriando" na v1 — isso seria CRM de recuperação, outro produto).
6. **Ordena** (codex P2): `reagendar (0) > interesse (1) > ausente (2)` — interesse é oportunidade, ausente é logística; dentro de cada, **mais recente primeiro** (`diasDesde` asc).

`FollowupItem = { customerUserId, result: 'reagendar'|'interesse'|'ausente', lastVisitAt: string, diasDesde: number, notes: string | null }`.

Helper retorna **todos** os itens ordenados (count honesto); o componente renderiza os primeiros 5.

## UI (`FollowupsSugeridosCard` + hook `useFollowupsVisita`)

- **Self-hide** quando 0 itens.
- Header: "Follow-ups sugeridos" + subtítulo "Visitas que pedem retorno" + count total. Se total > 5, "+N mais" mudo (sem destino dedicado na v1 — codex).
- Cada linha (até 5):
  - **Nome do cliente** = `<Link to="/customer/:id">` (Customer360 → ligar/WhatsApp/pedido/histórico; afordância universal).
  - Badge do resultado (`visitResultLabel`) + "há N dias" (`recenciaLabel`).
  - **Snippet de `notes`** truncado em 1 linha, se houver (codex P3 — contexto reduz ação errada).
  - **Ação primária por resultado** (deep-link, não muta):
    - `reagendar`, `interesse` → "Agendar retorno" → `AgendarVisitaDialog` (cliente preselecionado).
    - `ausente` → "Tentar de novo" → `AgendarVisitaDialog` (agendar nova tentativa). Pra ligar antes, o nome-link leva ao Customer360.
- **Placement:** dashboard **Closer** (outbound presencial), após `VisitSuggestionsCard` e antes do `MinhasVisitasResultadoCard` (agenda → sugestões do motor → follow-ups concretos → estatística de conversão). **NÃO** estender a Farmer/Hunter na v1 (semânticas diferentes — codex P3).

## Não-objetivos (v1) / v2

- Deep-link inline de **Ligar/WhatsApp** e **Pedido** por-resultado (precisa do telefone do cliente / mais botões) → v2; hoje o nome-link cobre via Customer360.
- Microfrase de **histórico morno anterior** ("interesse anterior há 10d") — codex P2, cheap mas adia (o snippet de notes já dá contexto).
- Mostrar `revenue_generated > 0` sem pedido como "potencial".
- Janela única "esfriando" (60d+) / CRM de recuperação.
- `pedido_fechado` → follow-up de pós-venda (retenção/CS) — outro produto.

## Tarefas

1. Helper `src/lib/visitas/followups.ts` + testes (`__tests__/followups.test.ts`) — TDD. Reusa `diasDesde` de `recencia.ts`.
2. Hook `src/hooks/useFollowupsVisita.ts` — 3 queries own-scoped + enrich nome + `montarFollowups`.
3. Componente `src/components/dashboard/FollowupsSugeridosCard.tsx`.
4. Placement no `CloserDashboard.tsx`.
5. Validação: typecheck (strict) + lint + test + build (todos verdes).

## Codex

Consult adversarial (2026-06-04, `model_reasoning_effort=medium`): validou baixo-risco vs KPI; P1 = nome honesto + de-dup contato + janelas por-resultado; P2 = ordem reagendar>interesse>ausente + última-visita-como-estado; P3 = snippet de notes + limite 5 + Closer-only. Todos incorporados acima.
