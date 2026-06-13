# KPIs de nível mundial do MASTER — Meu Dia (design)

**Data:** 2026-06-13
**Autor:** Claude + **Codex (gpt-5.5, consult)** — 2ª opinião conforme CLAUDE.md §12.
**Status:** aprovado pelo founder pra implementar (frente "expandir"; farmer #690, hunter #795, closer #797).

## Contexto / problema

Última persona da redefinição de KPIs por papel no `/meu-dia`. O **master** é o founder/CEO (também atua como vendedor de campo). Trabalho-norte = **gerir o time** (visão consolidada + gestão por exceção) + as próprias vendas.

O `MasterDashboard` **já tem os componentes certos** (validados em specs anteriores — `2026-06-04-master-visao-time-design.md`): `TeamKpiTiles` (receita do time MTD + trend MoM, ativos), `RankingVendedoresCard` (ranking MTD), `GestorExcecoes` (Buddy v2 — gestão por exceção), `ViewAsPicker` ("Ver como"). Mas a **ordem está errada**: lidera com `AtivarNotificacoesCard` (push opt-in) + `VisitSuggestionsCard` (sugestão de visita — trabalho de closer) + `ViewAsPicker`, e o **placar de time + exceções** (o trabalho diário do CEO) ficam no meio/fim. O comentário "Placeholder rico até PR-MULTIVENDOR-V2" está **stale** (o ranking já existe). E "Meus KPIs (como Closer)" usa `KpisToday`, que mede **ligações** (`farmer_calls`), não visitas.

## KPIs de nível mundial do master (sales management)

Framework do Codex: **"Estamos ganhando?" → "O que exige ação?" → "Quem/onde explica o resultado?" → "minha operação"**.

| Bloco | Papel | Tipo | Observação |
|---|---|---|---|
| **Receita do time MTD (+ trend MoM)** ⭐ | "estamos ganhando?" | output | `TeamKpiTiles` (já existe) — escopo do CompanySwitcher |
| **Exceções** (`GestorExcecoes`) | "o que exige ação?" | acionável | Buddy v2 — transforma diagnóstico em ação; lidera com Dados quebrados |
| **Ranking + ativos** | "quem/onde explica?" | diagnóstico | `RankingVendedoresCard` — decomposição do placar |
| **Ver como** (`ViewAsPicker`) | ferramenta de investigação | — | após exceções/ranking |
| **Minha operação** (`ClosersMtdHero`) | vendas próprias do master-como-closer | output (próprio) | visitas MTD; abaixo da gestão |
| Caça / Push | atalho / config | — | fim |

### Decisões do Codex (incorporadas)
1. **Ordem**: placar de receita (compacto) → exceções → ranking/ativos (decomposição) → Ver como → "Minha operação" → ferramentas/config. "Vendedores ativos" é **saúde**, não norte; **ranking é diagnóstico, não placar** → ambos abaixo do placar de receita.
2. **`VisitSuggestionsCard`: REMOVER** da visão master padrão (não só descer — descer mantém ruído + mistura papéis). Continua no `CloserDashboard`.
3. **"Minha operação" usa `ClosersMtdHero`** (visitas MTD), não `KpisToday`: o master-como-closer é VISITA, e o `KpisToday` mede ligações (rótulo "como Closer" era enganoso). **Não misturar** os dois (recriaria dashboard genérico de atividade). → remover `KpisToday` do master.
4. **Comentário stale** atualizado.
5. **Dados quebrados crítico**: o `GestorExcecoes` já lidera por dependência com "Dados quebrados" (Sentinela) — ao colocá-lo logo após o placar, o alerta de dado quebrado fica imediatamente abaixo dos números (sinaliza que o placar pode estar comprometido). O ideal do Codex (alerta ACIMA do placar) fica como refinamento v2 (exigiria extrair o grupo de dados do `GestorExcecoes`).

### Anti-gaming / honestidade (registrado, não-bloqueante)
- **`created_by` mede quem LANÇOU o pedido, não quem vendeu.** O `RankingVendedoresCard` já rotula "por quem lançou o pedido" (honesto). O `TeamKpiTiles` "Receita time" é agregado (não atribuído a vendedor) → menos crítico. **Não comissionável** até existir `sold_by`/`owner_id` (v2).
- **Ranking self-hide sem pedidos**: pro gestor, zero pedido no mês é INFO CRÍTICA, não ausência. Hoje o card some quando não há pedido. → registrado como refinamento v2 (mostrar "nenhum pedido no mês" em vez de sumir).

## Mudanças (100% frontend, sem migration/edge)

### `src/components/dashboard/MasterDashboard.tsx` (reordenar + trocar/remover)
Ordem nova: **header → `TeamKpiTiles` (placar) → `GestorExcecoes` (exceções) → `RankingVendedoresCard` (decomposição) → `ViewAsPicker` (+ `MinhasTarefasCard` da lente) → "Minha operação" (`ClosersMtdHero`) → link Caça → `AtivarNotificacoesCard` (push, fim)**. **REMOVER** `VisitSuggestionsCard`. **TROCAR** `KpisToday` ("Meus KPIs como Closer") por `ClosersMtdHero` ("Minha operação"). Atualizar o comentário stale do componente.

⚠️ **NÃO tocar** `TeamKpiTiles`/`RankingVendedoresCard`/`useTeamKpis` (validados no spec 2026-06-04; evita colisão com a frente MoM já mergeada). As notas anti-gaming/ranking-self-hide ficam como v2.

`ClosersMtdHero` é reusado do PR do closer (#797) — por isso o master mergeia DEPOIS do closer.

## Não-objetivos (v1)
- Meta do time / % de atingimento / forecast / pipeline coverage — "precisão teatral" sem meta/pipeline/snapshots (v2).
- `sold_by` separado de `created_by` — v2.
- Refatorar `TeamKpiTiles`/`RankingVendedoresCard` (anti-gaming labels, ranking self-hide) — v2.
- Extrair "Dados quebrados" pra um alerta acima do placar — v2.

## Gaps v2 (registrados)
1. **`sold_by` ≠ `created_by`** (atribuição de venda real, base de OTE).
2. **Metas por empresa/vendedor/período** → receita MTD vs meta + ritmo projetado (o placar de gestão de verdade).
3. **Regra explícita do founder dentro/fora da receita do "time".**
4. **Pipeline (estágio/valor/data) + snapshots** → forecast accuracy, coverage.
5. **Política de cancelamento/devolução** na receita; timezone/data de receita auditável.
6. **Definição auditável de "vendedor ativo"** (hoje qualquer atividade conta).
7. **Ranking não-some sem pedidos** (zero é info crítica pro gestor).

## Verificação
- `MasterDashboard` lidera com `TeamKpiTiles` + `GestorExcecoes`; não renderiza `VisitSuggestionsCard` nem `KpisToday`; renderiza `ClosersMtdHero` em "Minha operação".
- `bun run typecheck` + `bun lint` + `bun run test` (inclui o guardrail no-write-leak).
