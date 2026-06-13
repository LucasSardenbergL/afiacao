# KPIs de nível mundial do HUNTER — Meu Dia (design)

**Data:** 2026-06-13
**Autor:** Claude + **Codex (gpt-5.5, consult, reasoning high)** — 2ª opinião conforme CLAUDE.md §12.
**Status:** aprovado pelo founder pra implementar (frente "começar pela farmer e expandir" — farmer feita em #690; hunter→closer→master em PRs separados).

## ⚠️ Coerência com o OTE (atualização 2026-06-13, eu+Codex)

Estes KPIs são **placar de visibilidade (gestão)**, NÃO a engine de comissão. A elegibilidade pra remuneração é definida **exclusivamente** pelo spec vigente de OTE (`2026-06-13-ote-remuneracao-variavel-farmer-design.md`) — os rótulos abaixo são design de dashboard, não pagamento. O OTE está em DESIGN. Divergências a reconciliar:
- **Dados parciais:** receita/novos vêm de `sales_orders`, hoje parcial (backfill pendente) → `DadosVendaParciaisBanner` avisa; **não usar pra comissão**.
- **Janela:** MTD (operacional) × quota trimestral cumulativa do OTE.
- **Específico hunter:** o KPI-norte (novos na carteira) já é **proxy não-comissionável** — coerente com o OTE. O OTE trata aquisição como **bounty por cliente** (50/25/25, V2/V3), não % perpétuo — alinha com o `acquired_by_user_id` imutável já registrado nos gaps v2.

## Contexto / problema

Continuação da redefinição de KPIs por persona (a farmer foi a 1ª — `docs/superpowers/specs/2026-06-06-kpis-farmer-meu-dia-design.md`). O `/meu-dia` roteia por `commercial_role` (lente-aware) e cada papel tem seu dashboard. Os dashboards foram montados **ad-hoc** e **vazam cards entre personas**.

O **HunterDashboard** hoje tem: `MinhasTarefasCard`, `ChamadasPendentesNudge`, **`VisitasHojeCard`** (← visita é trabalho do CLOSER, não do hunter) e `CacaConteudo` (a fila de caça). **Não tem placar nenhum** — o KPI de aquisição do hunter não aparece em lugar algum do dashboard.

O hunter = **aquisição / new business**: caça clientes NOVOS via a fila de caça (look-alike dos melhores do grupo que ainda não compram na empresa-alvo). Decisão do founder: os KPIs devem ser base de **remuneração variável (OTE) futura** — mensuráveis, auditáveis, por-vendedor, anti-gaming.

## KPIs de nível mundial do hunter (acquisition / new business)

Framework de aquisição B2B: **pipeline → conversão → velocidade → qualidade**. ⚠️ **A 2ª opinião do Codex foi decisiva e mudou a proposta inicial**: o app HOJE quase não instrumenta aquisição por-hunter, então o placar honesto é **enxuto** — e a maior parte do "nível mundial" vira **gap v2 explícito**, não card fabricado.

| KPI | Mede | Tipo | OTE | Dado |
|---|---|---|---|---|
| **Novos na sua carteira MTD** ⭐ proxy-norte | clientes da carteira cuja 1ª compra (de toda a história) caiu no mês | output (proxy) | **ainda NÃO comissionável** (atribuição frágil — ver risco) | `novos_clientes_positivados` ✅ |
| **Receita da carteira MTD** | faturamento total da carteira do hunter no mês | output | candidato (mistura aquisição+retenção; v2 separa "receita dos novos") | `receita_mtd` ✅ |
| **Participação de novos** | % de novos entre os compradores do mês | diagnóstico | **não** comissionável (sobe artificialmente quando antigos caem) | `novos / positivados` (derivado) ✅ |
| **Fila de caça** (contexto, não card) | estoque de oportunidade fornecido pelo sistema | acionável | **não** (é input do motor, não esforço/performance do hunter) | `useCaca` ✅ |
| **Chamadas hoje** | pulso de atividade | leading | higiene | `useMyKpis.calls_today` ✅ |

### Por que enxuto (decisão do Codex — furos da proposta inicial)
A proposta inicial reusava o ramo `isHunter` atual do `PositivacaoHero`, que mostra **5 cards** (`novos_positivados` / `a_positivar` / `recência crítica` / `ticket médio` / `cobertura`). O Codex apontou que **4 dos 5 vazam de farmer/retenção**:
- **Recência crítica** = risco de churn → **retenção** (trabalho de farmer). REMOVER do hunter.
- **Clientes a positivar** = pool da carteira que não comprou no mês → pode incluir **clientes antigos** → farmer. REMOVER.
- **Cobertura de contato** = % da carteira elegível contatada → não é sobre **alvos de caça**. REMOVER.
- **Ticket médio MTD** = mistura compradores novos e antigos → não é KPI de aquisição. REMOVER.

Só **"Novos positivados"** sobrevive — e mesmo assim como **proxy**, não como métrica comissionável (ver risco de atribuição). Adicionamos **"Participação de novos"** (derivável hoje, diagnóstico) e mantemos **"Receita da carteira"** (output, com label honesto de que é a carteira toda, não só os novos).

### Risco de atribuição (o furo crítico — registrado, tratado honestamente)
`novos_clientes_positivados` vem de `get_minha_positivacao()`, escopado por `carteira_assignments.owner_user_id = auth.uid()`. Logo, **só credita o hunter se o cliente conquistado permanecer atribuído a ele**. Se o handoff ao farmer reatribuir a carteira, o número **desaparece retroativamente** do hunter. Por isso:
- exibido como **proxy** (label "1ª compra neste mês"), com **tooltip honesto** explicando que conta clientes **atualmente atribuídos** a ele;
- **nunca** rotulado como "pronto pra OTE";
- v2 (abaixo) resolve com `acquired_by_user_id` imutável.

### Anti-gaming
- "Novos" em **contagem** incentiva caçar muitos clientes pequenos (pedido de R$1 conta). Mitigação real (**piso de pedido qualificado**) depende de dado que não temos ainda → **v2**. Por ora, o placar **não é comissionável** (o disclaimer evita o incentivo perverso prematuro).
- "Participação de novos" é **diagnóstico**, explicitamente não-comissionável (sobe quando antigos caem).
- Fila de caça **não** é KPI (é estoque do sistema) → não premiar.

## Mudanças (100% frontend, sem migration/edge)

### 1. `src/lib/positivacao/format.ts`
Adicionar `pctNovos` (alias semântico de `pct`, igual a `pctPositivacao`/`pctCobertura`) — `% de novos entre compradores`, 0 quando den ≤ 0. **TDD** (helper puro).

### 2. `src/components/farmer/PositivacaoHero.tsx` — corrigir o ramo `isHunter`
Trocar os 5 cards atuais pelo conjunto honesto (3 cards), **só no ramo `isHunter`** (o ramo farmer `isHunter={false}` fica **intacto**):
- ⭐ **Novos na carteira (MTD)** = `novosPositivados` · sub "1ª compra neste mês" · **tooltip** de atribuição (proxy).
- **Receita da carteira (MTD)** = `receitaMtd` · sub "faturamento total da sua carteira no mês".
- **Participação de novos** = `pctNovos(novosPositivados, positivados)`% · sub "dos seus compradores do mês".

Adicionar prop opcional `info?: string` ao `KpiCard` interno → ícone `Info` + `Tooltip` (TooltipProvider já é global no `App.tsx`). Telemetria `carteira.positivacao_vista` (com `is_hunter`) **mantida**.

### 3. `src/components/dashboard/HunterDashboard.tsx`
- **Trazer** `useMyPositivacao` + `PositivacaoHero isHunter={true}` pro **topo** (após o header) — o placar de aquisição que faltava.
- **REMOVER** `VisitasHojeCard` (vaza closer).
- **Manter** `MinhasTarefasCard`, `ChamadasPendentesNudge` e `CacaConteudo` (a fila de caça = a ação do dia, o protagonista).

O `PositivacaoHero isHunter` é compartilhado com `FarmerCalls` (quando role=hunter) → a correção do hero melhora os dois (consistência desejada, espelha o #690).

## Não-objetivos (v1)
- OTE/remuneração variável (sessão dedicada do founder).
- Re-arquitetar o `FarmerCalls` inteiro: ele ainda renderiza `ClientesAPositivarCard` + `MixGapCard` (cards de farmer) abaixo do hero mesmo pro hunter. **Follow-up** (fora do escopo "dashboards"); o hero em si já fica honesto.
- Closer/Master (próximos PRs da frente).
- Qualquer migration/edge.

## Gaps v2 (registrados — o "nível mundial" de verdade do hunter precisa destes dados)
1. **`acquired_by_user_id` imutável** na 1ª compra (atribuição de aquisição que sobrevive ao handoff → destrava o KPI-norte comissionável de verdade).
2. **Log de caça com outcome** (análogo ao `route_contact_log`/Radar): alvo trabalhado, 1ª tentativa, 1º contato, status `novo→contatado→qualificado→descartado→convertido`.
3. **Funil de conversão**: taxa contato→qualificação→1ª compra.
4. **Velocidade**: tempo até 1º contato e até 1ª compra.
5. **Qualidade da aquisição**: receita/margem **dos novos** (separada da carteira); 2ª compra / retenção 60–90d.
6. **Piso de pedido qualificado** (anti-gaming): 1ª compra abaixo de X não conta como "novo cliente".

## Verificação
- `pctNovos` tem teste (div-zero, arredondamento, casos).
- `PositivacaoHero isHunter` renderiza 3 cards honestos (sem recência/a-positivar/cobertura/ticket); ramo farmer inalterado.
- `HunterDashboard` renderiza o hero no topo, **não** renderiza `VisitasHojeCard`, mantém `CacaConteudo`.
- Lente "Ver como": positivação já é lente-aware (`useMyPositivacao` via `effectiveUserId`).
- `bun run typecheck` + `bun lint` + `bun run test`.
