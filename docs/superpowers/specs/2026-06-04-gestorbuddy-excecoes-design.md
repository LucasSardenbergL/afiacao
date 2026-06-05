# GestorBuddy — Console de Exceções (v1 determinístico) — design

> Data: 2026-06-04 · Status: spec aprovada em brainstorm, aguardando review do founder antes do plano
> Programa: **"Buddy" (UPOPS/Itaú)** — 2ª entrega. A 1ª (Crítica da Fila, rep-facing) está em produção (PR #585).
> Consult codex (2 rodadas) salvo em `.context/codex-session-id`.

## 1. Contexto

Continuação do programa Buddy. A 1ª peça (rep-facing "Crítica da Fila") shippou. Esta é a **visão agregada do founder** que o codex recomendou: *"founder view second, from the same engine; exception brief, not newsletter."*

**Sequência (decidida eu+founder+codex):** GestorBuddy determinístico AGORA (reusa engines, não depende do piloto, founder usa amanhã); a **camada de LLM fica para depois do piloto** da Crítica da Fila (kill-gate: não investir em LLM antes da qualidade da ação ser provada).

**Princípio central (codex, rodada 2):** isto é um **console de exceções com recibos**, não um "AI strategy brief". O maior risco é **decaimento de confiança** por item velho ou acusatório. Toda linha carrega **fonte + frescor**; engine desatualizado **degrada para meta-exceção**; zero LLM; zero push novo; zero backend novo até o card provar que muda ações.

## 2. Objetivo

Um card **"Exceções — o que está fora do lugar"** no **MasterDashboard** (substitui o placeholder "Em construção — Alertas estratégicos") que mostra **só o que está OFF**, agrupado por fonte, com frescor explícito. Founder bate o olho de manhã e vê o que precisa de ação — sem dashboard, sem chat, sem IA.

## 3. Não-objetivos (v1)

- Camada de LLM (linha de abordagem, resumo, chat) — depois do piloto.
- **Push / digest diário** do founder — o Sentinela já empurra saúde de dados; pull-only no v1.
- **Concentração de caixa/cliente** — v2 (toca os engines financeiros; mais pesado).
- Recalcular contradições team-wide ao vivo no card — reusa o engine persistido (`ai_decisions`), com frescor honesto.
- Qualquer tabela/edge/cron novos.

## 4. Arquitetura — card no MasterDashboard, near-zero backend

```
MasterDashboard
  └── <GestorExcecoes />                         [novo card, substitui o placeholder]
        ├── useExcecoesGestor()                  [novo hook: 3 fontes]
        │     ├── ai_decisions (freshness-first) ← query NOVA (não useAiOps as-is)
        │     ├── useDataHealth()                ← existente (Sentinela)
        │     └── v_tarefas_estado (team-wide)   ← query NOVA (master RLS, sem filtro de rep)
        │
        └── montarExcecoes(...)  → ConsoleExcecoes [helper PURO, TDD]
                                    (escada de frescor + predicados + caps + grupos + merge visual)
```

- **Helper puro TDD** `src/lib/gestor/excecoes/montar.ts` — recebe as 3 fontes normalizadas + "agora" (SP) e produz o `ConsoleExcecoes` (grupos com caps, freshness ladder, merge visual). Toda a regra vive aqui, testada isolada.
- **Hook** `useExcecoesGestor()` — 3 queries (ai_decisions freshness-first; useDataHealth existente; v_tarefas_estado team-wide) + chama o helper. **Master-only** (o card só monta no MasterDashboard).
- **UI** `src/components/dashboard/GestorExcecoes.tsx` — grupos, recibos (fonte+frescor por linha), botão "Atualizar análise da carteira" (reusa o run-agent), empty-state honesto.
- **Medição** PostHog (`gestor.excecoes_*`). **Sem tabela/edge/cron novos.**
- ⚠️ **A confirmar no plano:** (a) RLS — o master lê `ai_decisions` e `v_tarefas_estado` team-wide (a página AIops é gestor/master; a RLS de tarefas reusa `pode_ver_carteira_completa`); (b) existe cron populando `ai_decisions`? Se não, a escada de frescor + o botão "Atualizar" cobrem honestamente.

## 5. As 3 fontes (regras do codex)

### 5.1 Clientes em risco (team-wide) — fonte `ai_decisions`
**NÃO reusar `useAiOps` como está** (ele pega top-200 por `score_final` e filtra `pending` em memória → pode mostrar linha velha). Query nova **freshness-first**: `ai_decisions` `status='pending'`, e avaliar a idade do `max(created_at)`.

**Escada de frescor (data de negócio SP, `spBusinessDate`):**
- `created_at` mais recente **< 24h** → mostra os clientes em risco normalmente.
- **24-48h** → mostra **com selo "Carteira calculada há Xh"** (stale badge).
- **> 48h** → **NÃO** mostra linhas de cliente-risco; mostra **UMA meta-exceção**: *"Análise de carteira desatualizada"* + botão **"Atualizar análise da carteira"** (reusa a mutation `useRunAgent` existente; label honesto, sem "magia").

**Predicado de risco (aperta o `useAiOps`):** `status='pending'` **E** `confidence != 'baixa'` **E** (`customer_metrics.atraso_relativo >= 2` **OU** queda de faturamento >50% [`faturamento_90d < faturamento_prev_90d * 0.5`]). Cap **5**. Cada linha: cliente + **vendedor dono** (`farmer_id` → nome) + `primary_reason` + a evidência crítica.

### 5.2 Dados quebrados — fonte `useDataHealth` (Sentinela)
Os checks com `status != 'ok'`. Cada linha: `message` + `domain` + severidade + frescor (`age_seconds`). Cap: **todos os `critical`** + máx **3** `warning`. (O Sentinela já empurra por e-mail na transição — aqui é só a superfície pull; **sem novo e-mail**.)

### 5.3 Confirmações pendentes (team-wide) — fonte `v_tarefas_estado`
**Reframe obrigatório (codex): NÃO é "o time se enganando".** `atrasada && tem_sugestao_pendente` só significa "tarefa atrasada + o matcher viu um indício não confirmado". Copy: **"Confirmações pendentes"** / *"tarefa atrasada com indício não resolvido — vale confirmar ou rejeitar"*. Nunca "mentira/enganando".

Filtro: `status='aberta'` **E** `atrasada=true` **E** `tem_sugestao_pendente=true` **E** atrasada por **≥1 dia útil**. Cap **3** (mais antiga primeiro). Cada linha: tarefa + **vendedor dono** + ações **Confirmar / Rejeitar / Abrir** (reusa `resolverSugestao` do `useTarefaMutations`).

## 6. Layout, ordenação e caps (codex)

**Seções agrupadas (NÃO lista única — as fontes não são comparáveis).** Ordem por **dependência operacional**:
1. **Dados quebrados** (saúde degradada) — primeiro, porque dado ruim invalida as outras conclusões.
2. **Clientes em risco** — money-path.
3. **Confirmações pendentes** — higiene de gestão.

**Teto total do card: 8-10 linhas.** Mais que isso não é exception brief. **Enforcement quando as fontes estouram o teto:** os **`critical` de saúde de dados SEMPRE entram** (invalidam o resto); o orçamento restante (até ~10) é preenchido na ordem de dependência — Clientes em risco (até 5), depois Confirmações pendentes (até 3); o excedente vira um rodapé compacto *"+N exceções"* (nunca esconde um `critical`).

**Merge visual (sem hard-dedupe):** cliente que aparece em **risco E** em tarefa = mais importante → linha primária em "Clientes em risco" + **selo "também há tarefa pendente"**; a duplicata na seção de tarefas é suprimida ou vira cross-link compacto.

## 7. Recibos + degradação honesta (a regra anti-armadilha)

- **Toda linha mostra fonte + frescor/timestamp.** (A armadilha-mor do codex: frescor+severidade misturados → o founder para de confiar no card inteiro.)
- **Engine velho degrada para meta-exceção** (a escada de §5.1), nunca mostra dado velho como atual.
- **Empty-state honesto:** nada off → *"Tudo no lugar hoje 🎯"*. Nunca item fabricado.
- **Sem LLM, sem push novo, sem backend novo.**

## 8. Medição (PostHog, leve)

- `gestor.excecoes_shown` (props: contagem por grupo, se há meta-exceção de stale).
- `gestor.excecoes_acted` (clicou numa ação: abrir cliente / confirmar tarefa / rodar análise).
- `gestor.excecoes_run_agent` (clicou "Atualizar análise da carteira").

**Smell-test, não prova (codex):** o founder achar as exceções reais/úteis é sinal qualitativo rápido sobre o motor — **não** valida a tese rep-facing (founder gostar ≠ vendedora abrir/agir). Usar como cheiro, não como prova do piloto.

## 9. Testes

- **TDD no helper puro** `montarExcecoes` (`src/lib/gestor/excecoes/__tests__/`): escada de frescor (fresh / 24-48h badge / >48h meta-exceção), predicado de risco (dispara/não no limiar), filtro de tarefa (≥1 dia útil), caps por grupo + teto total, ordenação dos grupos, merge visual (cliente em 2 fontes), empty-state.
- Sem teste de rede (helper puro). `bun run test` + `bun run typecheck` (strict) + `bun lint` verdes.

## 10. Riscos / a fixar no plano

- **Frescor do `ai_decisions`:** confirmar se há cron; medir a idade típica. Se for sempre stale, a escada vira a feature principal (e o botão "Atualizar" é o caminho).
- **RLS team-wide:** confirmar que o master lê `ai_decisions` + `v_tarefas_estado` sem filtro de rep (esperado: AIops é gestor/master; tarefas reusa `pode_ver_carteira_completa`).
- **"≥1 dia útil" de atraso:** usar a lógica de dia útil SP já existente (`sp-day`), não subtração ingênua.
- **Custo das queries team-wide:** `ai_decisions` (pending, bounded) + tarefas (aberta+atrasada+indício, bounded) são pequenas; não escanear os ~6900 clientes.
- **Cores/copy:** `text-status-*` (sem `text-emerald` etc.); copy de tarefa NUNCA acusatória.
