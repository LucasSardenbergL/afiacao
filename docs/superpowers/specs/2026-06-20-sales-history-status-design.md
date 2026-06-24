# `sales_history_status`: degradação honesta do health para UI/agenda/plano — design (v2)

> Frente **money-path** (scoring que alimenta agenda e planos do farmer). Follow-up dedicado do **cap de recência** (`claude/agitated-panini-9870dd`, spec `2026-06-20-recencia-cap-design.md` §Follow-ups), que delegou: _"`score_confidence`/`sales_history_status` → follow-up dedicado, minimiza colisão com a recência-viva"_.
>
> **Decisões do founder (2026-06-20/21):** forma = `sales_history_status` categórico; profundidade = verdade visual + reclassificar agenda; limiar = config próprio; churn fabricado = medir antes de decidir; **escopo = fatia única coerente** (core + UI + agenda + plano + dashboards, depois do /codex challenge).
>
> **v2** incorpora o `/codex challenge` (gpt-5, high, 2026-06-21) — rastreabilidade na última seção.

## Problema

Sob o cap de recência (T=180) + recência-viva, `health_score`/`health_class` colapsa quase toda a base em `critico`. Degradação honesta para quem esfriou — mas **mente** sobre quem **nunca registrou compra**: o farmer vê uma parede de "críticos" idênticos e não distingue quem esfriou (recuperação) de quem nunca comprou (prospecção). Money-path: _ausente ≠ zero_ no **output**.

### Medição em prod (psql-ro, 2026-06-20; RPC `get_customer_sales_summary` replicada inline — `claude_ro` sem EXECUTE)

`fcs`=6400, `calculated_at` fresco, `apply_score_updates(jsonb)` já em prod.

| status | n | % | churn_méd | prio_méd (base) | health_méd | top-10/farmer (por prio **base**) |
|---|---|---|---|---|---|---|
| **sem_historico** | 5606 | 87,6% | 86,0 | 26,0 | 14,0 | **0** |
| stale | 421 | 6,6% | 78,5 | 23,9 | 21,5 | 4 |
| ativo | 373 | 5,8% | 67,3 | 25,4 | 32,7 | 26 |

794 com venda válida all-time (373+421); 6400−794=5606. `ativo` confiável: todos por `order_date_kpi` real ≤180d (sem ruído de `created_at` de importação). _Divergência com o "~4" do spec do cap = método: aquele mediu `days` persistido/congelado; a fonte fresca dá 373._

### Por que NÃO mexer no churn/priority persistidos (e por que a prova precisa de um guard)

Hipótese inicial: `churn_risk=100−health` daria churn alto a `sem_historico` → topo da agenda. A medição mostra **0 sem_historico no top-10 por farmer** — `priority_score` pondera churn em só 30%, e `margin_potential`/`repurchase`/`goal_proximity` (70%) são ~0 para quem nunca comprou.

**Mas essa prova é de snapshot e de prioridade _base_ (Codex P1.1).** A agenda real ordena por prioridade **efetiva** = base + nudge de `signal_modifiers` (read-time, `agenda.ts:60-63,114`). Um prospect com sinal de call recente pode furar o top; e a distribuição muda com carteira prospect-pesada, farmer novo, poucos farmers, importação de carteira ou mudança de pesos. **Não tratamos "0 no top-10" como invariante.** A robustez vem de uma **defesa estrutural read-time**, não do snapshot:

> **Guard (§5):** `sem_historico` **nunca ocupa slot de risco/recuperação** na agenda — independentemente da prioridade efetiva. Assim, mesmo que o nudge o empurre, ele não desloca um `stale`/`ativo` real. Isso resolve P1.1 sem tocar a fórmula persistida.

Validação (psql-ro, 2026-06-21): **nenhum** cliente em `fcs` tem `signal_modifiers ≠ '{}'` (com_sinais=0 nos 3 status) → nudge **0 universal** hoje → prioridade **efetiva = base** → o "0 no top-10" vale também para a efetiva no estado atual. O guard cobre o futuro (quando `signal_modifiers` voltar a popular via calls do `scoring-recalc-client`).

## Decisão / desenho

### 1. Dado — coluna nova
`farmer_client_scores.sales_history_status text NULL` + `CHECK (sales_history_status IS NULL OR sales_history_status IN ('sem_historico','stale','ativo'))`. Espelha `health_class` (`text NULL`, sem enum). **`NULL` = "ainda não computado" → a UI se comporta como hoje** (mostra `health_class` normal; NÃO esconde o health nem assume `sem_historico`). Sem default fabricado. Alarme pós-deploy: `count(*) FILTER (WHERE sales_history_status IS NULL)` deve cair a ~0 (Codex P1.3/P3.3).

### 2. Derivação — helper puro espelhado no edge
`src/lib/scoring/salesHistoryStatus.ts` (vitest + falsificação), espelhado **verbatim** no edge (padrão `deriveSalesBase`/`recency.ts`):

```
deriveSalesHistoryStatus(sales, activeThresholdDays):
  cap = clampActiveDays(activeThresholdDays)    // clamp LOCAL deste helper: Number.isFinite? [30,999] round; senão 180
  se !sales OU !(total_revenue > 0)             → 'sem_historico'
  se days_since_last_purchase == null           → 'stale'   // ANÓMALO (revenue>0 sem data): explícito, contável — Codex P2.2
  se days_since_last_purchase ≤ cap             → 'ativo'
  senão                                         → 'stale'
```

`clampActiveDays` é **próprio deste helper** — não importa de `recency.ts` (branch do cap, ainda fora da `main`; importar acoplaria as frentes). Fonte: `salesMap` (RPC `get_customer_sales_summary`) tem `total_revenue` (all-time) + `days_since_last_purchase`. Limiar `config['sales_active_threshold_days'] ?? 180` — **config próprio** em `farmer_algorithm_config`, desacoplado de `hs_recency_cap_days`.

**Semântica honesta (Codex P2.1):** `sem_historico` = _"sem venda válida monetizada no resumo"_, NÃO "nunca comprou". A RPC agrega por `order_items` com `customer_user_id IS NOT NULL` + blocklist de status (`NOT IN cancelado/rascunho/pendente/orcamento`) + `deleted_at IS NULL`. Pedido sem item, item com receita ≤0, devolução, ou status novo não-contemplado caem em `sem_historico`. Label da UI: **"Sem histórico"** (não "Nunca comprou"). Documentar a definição exata no helper.

### 3. Persistência — RPC `apply_score_updates` estendida com COALESCE (deploy bidirecional-seguro)
+1 campo no recordset (`sales_history_status text`) e no `SET` — **mas com COALESCE** (Codex P1.2):

```sql
sales_history_status = COALESCE(u.sales_history_status, f.sales_history_status)
```

Isso torna o deploy **seguro nos dois sentidos**, eliminando a dependência de ordem manual perfeita:
- edge **antigo** (não envia o campo → NULL no recordset) + RPC **nova** → COALESCE **preserva** o valor atual (não apaga em massa).
- edge **novo** + RPC **antiga** → campo ignorado (sem erro); status fica NULL até a RPC subir (não-destrutivo).
- edge **novo** + RPC **nova** → atualiza.

Os 9 campos core mantêm o contrato full-update (recompute inteiro); **só `sales_history_status` é COALESCE** (preserva-se-ausente). Documentar essa exceção no SQL. Mantém `SECURITY INVOKER` + `REVOKE PUBLIC/anon/authenticated` + `GRANT service_role`. **Pré-flight `pg_get_functiondef` da prod** antes do apply (a última recriação vence; o cap não toca a RPC → sem colisão). `prove-sql-money-path` com falsificação (omitir o campo → preserva, NÃO NULL; sabotar COALESCE → vermelho; grant a authenticated → vermelho).

No edge: `FarmerClientScoreRow`/`FarmerClientScoreSeed`/`ScoreUpdate` ganham `sales_history_status`; o `updates.push` envia o status derivado. **Seed** deriva do `salesMap`. **Degradação RPC-falha** (`salesRefreshFatal`): o edge envia **NULL** (não tem dado fresco) → o COALESCE da RPC **preserva** o valor atual. Simplifica o edge (não precisa reler/reenviar o status atual) e nunca fabrica status por RPC ausente.

### 4. UI — verdade visual coerente (lista + perfil + semáforo + dashboards)
- **Semáforo** (`src/components/customer360/format.ts healthTone`; `src/components/adminCustomers/config.ts HEALTH_CLASSES`): `sales_history_status==='sem_historico'` → estado **neutro** ("Sem histórico", cinza), nunca o vermelho de `critico`. `NULL` → comportamento atual.
- **Corrigir o drift `atencao`↔`alerta` (Codex P3.2):** ao tocar `config.ts`/`CustomerListView` para o badge, alinhar o vocabulário ao que o engine grava (`saudavel`/`estavel`/`atencao`/`critico`) — não deixar `alerta` órfão ao lado do código novo.
- **Lista** (`CustomerListView.tsx`): `sales_history_status` como **coluna/badge** e **filtro** (`useUrlState`) — segmentar 5.606 prospecção vs 421 recuperação vs 373 ativo.
- **Perfil** (`CustomerHero.tsx`/`Customer360View.tsx`): badge de status.
- **Dashboards de Inteligência (Codex P3.1):** `IntelligenceOperationalTab.tsx:~89` e `IntelligenceManagerialTab.tsx:~90` contam "em risco" por `health_class ∈ {critico,atencao}` — passar a **excluir `sem_historico`** da contagem de risco. Sem isso, os KPIs gerenciais seguem dizendo "~6.400 em risco" enquanto a lista diz a verdade.

### 5. Agenda + plano (guard read-time, não só rótulo)
- **`src/lib/scoring/agenda.ts buildAgendaItems`** (Codex P2.3): `CarteiraRow` ganha `sales_history_status`. Dois efeitos: (a) `sem_historico` **deixa de ser `agenda_type='risco'`**; (b) **guard de slot** — `sem_historico` não compete pelo slot de risco/recuperação (filtro/quota; forma exata decidida no plano, com medição). `AgendaItem` expõe o status. **`priority_score`/`churn` persistidos intocados** — o guard é read-time, reversível.
- **Plano** (`useTacticalPlan.ts`): `ClientScoreFull` ganha `sales_history_status` (o `select('*')` já o traz pós-migration); `selectObjective` (linha ~190) → `sem_historico` vira objetivo de **ativação/1ª compra**; **e o contexto enviado à LLM** (Codex P2.4) passa a incluir `salesHistoryStatus` com instrução de tratar `sem_historico` como ativação — senão a IA gera "recupere" sobre `churnRisk`/`healthScore` fabricados.
- **Demais hooks**: `useFarmerScoring`/`useMyCarteiraScores` propagam o campo no shape.

### 6. O que esta fatia NÃO faz (registrado)
- **Não** altera `churn_risk`/`priority_score`/fórmula de `health_score` **persistidos**. O guard da agenda é read-time. (Se o mix de carteiras mudar e a prioridade efetiva passar a empurrar `sem_historico`, o guard já protege; re-medir antes de qualquer mudança de fórmula.)
- **Não** adiciona `score_confidence` numérico nem coluna `*_calculated_at` dedicada (o `calculated_at` geral + alarme `count(null)` cobrem) — YAGNI.
- **Não** reabre o limite-90 do `selectObjective` (follow-up do cap).

## Prova & medição (money-path)
1. **vitest + falsificação** em `salesHistoryStatus.ts`: tabela (sem sales / revenue≤0 / ≤cap / >cap / **days-null+revenue>0** / NaN); clamp do limiar; falsificação (sabotar a fronteira → vermelho). Paridade helper↔edge (`deno check`).
2. **vitest** em `agenda.test.ts`: `sem_historico` não vira `risco` E não ocupa slot de risco/recuperação mesmo com prioridade efetiva alta (sinais).
3. **`prove-sql-money-path`** na RPC: PG17 local, aplica a migration real; assert COALESCE (campo ausente → **preserva**, não NULL); falsificação (sabotar COALESCE → apaga; grant a authenticated → vermelho).
4. **typecheck strict + lint + knip**.
5. **psql-ro before/after**: distribuição + sinais medidos (2026-06-21: `signal_modifiers` vazio em 100% da base → nudge=0 → efetiva=base); pós-deploy, `count(null)≈0` e top-10 inalterado.
6. **`/codex`**: challenge no design (incorporado, v2) e no diff.

## Coordenação & deploy
- Base na `main`; edição do edge **localizada** (longe da linha 453 do `recencyScore`, que o cap toca) → rebase trivial quando o cap (`fccc7a96`, sem PR) mergear. RPC e coluna são exclusivas desta frente.
- **Deploy (Lovable, manual):** (a) migration coluna + config + RPC-COALESCE no SQL Editor; (b) redeploy do edge `n` (=`calculate-scores`) verbatim; (c) **gate de cobertura** — validar via psql-ro `count(null)≈0` após o 1º run do edge; (d) só então **Publish** do frontend. O COALESCE tira o risco de ordem, mas o gate (c) evita publicar UI sobre base indeterminada (Codex P1.3). Merge ≠ produção.

## Riscos & follow-ups
- **R1 (resolvido por design):** deploy fora de ordem — COALESCE preserva; gate de cobertura antes do Publish.
- **R2:** `ativo`/`sem_historico` dependem da régua de pedido válido (blocklist v4) da RPC. Se a régua mudar, o status muda junto (acoplado por design).
- **Follow-up:** se o mix de carteiras evoluir (prospect-pesado), revisitar prioridade efetiva — re-medir antes de agir.
- **Follow-up:** `score_confidence` numérico, se a UI pedir gradação.

## Revisão Codex (challenge, gpt-5 high, 2026-06-21) — rastreabilidade
| # | Achado | Tratamento |
|---|---|---|
| **P1.1** | prova "não tocar churn" frágil (prio base ≠ efetiva; snapshot) | **guard read-time** (§5) como defesa estrutural; linguagem rebaixada; validação efetiva **confirmada** (signal_modifiers vazio em 100% da base → efetiva=base, 2026-06-21) |
| **P1.2** | deploy não bidirecional (NULL em massa / ignora silencioso) | **COALESCE na RPC** (§3) — preserva-se-ausente |
| **P1.3** | 1º run pós-migration NULL-total se RPC vendas falhar | **gate de cobertura** antes do Publish + alarme `count(null)` (§Deploy, §1) |
| **P2.1** | `sem_historico` ≠ "nunca comprou" | semântica "sem venda válida"; label "Sem histórico" (§2) |
| **P2.2** | `revenue>0 + days null` → stale por comparação falsa | branch explícito + contável no helper (§2) |
| **P2.3** | reclassificar resolve só o rótulo, não o ranqueamento | **guard de slot** read-time (§5) |
| **P2.4** | plano incoerente (LLM context fabricado) | propagar status ao tipo + **contexto LLM** (§5) |
| **P3.1** | dashboards gerenciais contam risco por `health_class` | **excluir `sem_historico`** da contagem (§4) |
| **P3.2** | drift `atencao`↔`alerta` na área tocada | **corrigir o drift** junto (§4) |
| **P3.3** | `NULL` ambíguo | alarme `count(null)`; sem coluna extra (YAGNI) (§1, §6) |
