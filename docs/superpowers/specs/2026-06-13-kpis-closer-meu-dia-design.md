# KPIs de nível mundial do CLOSER — Meu Dia (design)

**Data:** 2026-06-13
**Autor:** Claude + **Codex (gpt-5.5, consult, web search — citou IFRS 15)** — 2ª opinião conforme CLAUDE.md §12.
**Status:** aprovado pelo founder pra implementar (frente "expandir"; farmer #690, hunter #795).

## Contexto / problema

3ª persona da redefinição de KPIs por papel no `/meu-dia`. O **closer** = visita presencial / outbound / fechamento (≠ hunter inbound, ≠ farmer account-management por ligação).

O `CloserDashboard` **já tem KPIs reais de visita** (`VisitasKpiTiles`: conversão/ticket 30d, helper puro `montarKpisVisita` validado com Codex) — mas eles estão **no FIM**, depois de um **card "Em construção — PR-VISIT-INTELLIGENCE"** (placeholder com lista de features futuras). O dashboard **não lidera com placar nenhum** e tem o trabalho dirigido (tarefas) + higiene (nudge de chamadas) no topo.

## KPIs de nível mundial do closer (field sales / outbound)

Framework: **atividade de visita → conversão → valor gerado → ação**. ⚠️ A 2ª opinião do Codex foi decisiva em **honestidade do dado** e **janela**.

| KPI | Mede | Janela | Tipo | OTE | Dado |
|---|---|---|---|---|---|
| **Valor informado em pedidos fechados** ⭐ | Σ `revenue_generated` dos fechados no mês | **MTD** | output | **NÃO comissionável** (auto-reportado, não-ERP) | `montarKpisVisita.receitaTotal` ✅ |
| **Fechamentos** | nº de visitas `result='pedido_fechado'` | **MTD** | output | secundário (isolado incentiva deal pequeno) | `.fechados` ✅ |
| **Visitas registradas** | atividade do mês | **MTD** | leading | higiene | `.totalVisitas` ✅ |
| **Conversão de visita** | fechados ÷ visitas com resultado | **30d rolling** | eficiência | — (gameável; ver nota) | `.taxaConversao` ✅ |
| **Ticket médio de visita** | receita ÷ fechados com valor | **30d rolling** | eficiência | — | `.ticketMedio` ✅ |
| **Visitas pendentes / Próxima** | compromissos firmes | — | acionável | — | `useVisitasAgendadas` ✅ |

### Decisões do Codex (incorporadas)
1. **`revenue_generated` NÃO é "receita"** — é **valor de pedido autodeclarado pelo vendedor** (não conciliado, não vem do ERP; ≠ receita reconhecida IFRS 15). → label honesto **"informado pelo vendedor · não conciliado"** + **nunca** rotular "comissionável". OTE real exige vínculo imutável visita→pedido, valor líquido do ERP, cancelamentos/devoluções, atribuição — tudo **v2**.
2. **Janela**: outputs (valor/fechamentos/visitas) = **MTD** (alinha ao ciclo mensal de quota/OTE); eficiência (conversão/ticket) = **30d rolling** (estável — no início do mês o MTD oscila demais). **Não duplicar** a mesma métrica nas duas janelas.
3. **Sem meta por vendedor, isto é relatório, não placar** — o placar de verdade (% da meta, ritmo, projeção) é **v2** (depende de meta cadastrada). Por isso o hero MTD é honesto: mostra o realizado, não atingimento.
4. **Qualidade do dado visível**: ao lado do valor, expor **fechamentos sem valor** e **visitas sem resultado** (`montarKpisVisita` já os calcula) — anti-mascaramento.
5. **Conversão é gameável** (`÷ com resultado` → não registrar visita ruim some do denominador). Melhoria (`÷ visitas realizadas` via `check_in_at` + janela de maturação, porque um deal pode fechar dias depois da visita) é **v2** — não regredir o helper validado sem o cuidado da maturação.

### Anti-gaming
- Valor/fechamentos **não-comissionáveis** por ora (o disclaimer "auto-reportado" evita o incentivo a inflar antes de haver conciliação com ERP).
- "Fechamentos" é secundário a "valor" (isolado premia deal pequeno).
- Conversão expõe `semResultado` (não registrar visita ruim fica visível).

## Mudanças (100% frontend, sem migration/edge)

### 1. `src/hooks/useKpisVisitaMtd.ts` (novo)
Reusa `montarKpisVisita` numa janela **MTD** (`visit_date >= inicioMes(hojeSP())`, helpers já existentes e testados em `src/lib/dashboard/sp-date.ts`). Lente-aware (`effectiveUserId`, igual a `useKpisVisita`). Não toca o `useKpisVisita` (30d) existente.

### 2. `src/components/dashboard/ClosersMtdHero.tsx` (novo)
Placar do mês (output): **Valor informado** (MTD, label honesto + tooltip "auto-reportado, não conciliado") · **Fechamentos** (MTD) · **Visitas registradas** (MTD). Linha de **qualidade do dado**: `N fechamentos sem valor` / `M visitas sem resultado` quando > 0 (self-explain, como o `VisitasKpiTiles`). Self-hide se não há visita no mês.

### 3. `src/components/dashboard/CloserDashboard.tsx` (reordenar + remover placeholder)
Ordem nova (Codex): **header → `ClosersMtdHero` (placar do mês) → `VisitasKpiTiles` (atividade + eficiência 30d) → `VisitasHojeCard` → `VisitSuggestionsCard` → `FollowupsSugeridosCard` → `MinhasVisitasResultadoCard` (histórico 90d) → `MinhasTarefasCard` → `ChamadasPendentesNudge`**. **REMOVER** o card "Em construção — PR-VISIT-INTELLIGENCE". Tarefas/nudge descem do topo pro fim (trabalho dirigido + higiene, não placar).

## Não-objetivos (v1)
- Meta por vendedor / % de atingimento / projeção (placar OTE real) — v2.
- Conciliação `revenue_generated` × ERP (`sales_orders`), valor líquido, margem, cancelamentos — v2.
- Mexer no helper `montarKpisVisita` (conversão `÷ realizadas` + maturação) — v2.
- Master (próximo PR).

## Gaps v2 (registrados — o "nível mundial" real do closer precisa destes dados)
1. **Meta por vendedor/período** → KPI-norte vira `% da meta` + ritmo + projeção (= placar de verdade).
2. **Vínculo imutável visita→pedido** + valor líquido do ERP + margem + cancelamentos/devoluções + regra de atribuição/split + auditoria (destrava valor comissionável real).
3. **Conversão honesta**: `fechados ÷ visitas realizadas` (check_in) + janela de **maturação** (deal fecha dias depois) + completude de resultado.
4. **Ciclo de fechamento** (visit-to-close), **estágios de oportunidade**, **cobertura de carteira por visita** — não deriváveis hoje (visita futura ≠ pipeline).
5. **Mediana do ticket** (menos sensível a outlier que a média).

## Verificação
- `useKpisVisitaMtd` filtra `visit_date >= inicioMes(hojeSP())` e segue o ALVO na lente (teste seguindo o padrão `lens-atividade-vendedor`).
- `CloserDashboard` lidera com `ClosersMtdHero`, não renderiza o card "Em construção", mantém os demais cards de visita.
- `bun run typecheck` + `bun lint` + `bun run test`.
