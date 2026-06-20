# `sales_history_status`: degradação honesta do health para UI/agenda/plano — design

> Frente **money-path** (scoring que alimenta a agenda e os planos do farmer). Follow-up dedicado do **cap de recência** (`claude/agitated-panini-9870dd`, spec `2026-06-20-recencia-cap-design.md` §Follow-ups), que delegou explicitamente: _"`score_confidence`/`sales_history_status` (o 'mínimo honesto' do codex para a UI distinguir 'esfriou' de 'nunca comprou') → follow-up dedicado (migration + UI + prove-sql próprios; minimiza colisão com a recência-viva)"_. Decisões do founder (2026-06-20): **forma = `sales_history_status` categórico**; **profundidade = verdade visual + reclassificar agenda**; **limiar = config próprio**; **churn fabricado = medir antes de decidir**.

## Problema

Sob o cap de recência (T=180) + recência-viva, o `health_score`/`health_class` de `farmer_client_scores` colapsa quase toda a base em `critico`. Isso é **degradação honesta** para quem esfriou — mas **mente** sobre quem **nunca comprou**: o farmer vê uma parede de "críticos" idênticos e não distingue "cliente que esfriou" (recuperação) de "cliente que nunca comprou" (prospecção/ativação). Money-path: _ausente ≠ zero_ aplicado ao **output** — health baixo de quem nunca foi cliente não é "saúde ruim", é "ausência de histórico".

### Medição em prod (psql-ro, 2026-06-20; RPC `get_customer_sales_summary` replicada inline — `claude_ro` não tem EXECUTE)

`fcs` = 6400 linhas, `calculated_at` fresco (13:34Z), `apply_score_updates(jsonb)` já em prod.

| status | n | % | churn_méd | prio_méd | health_méd | no top-10/farmer |
|---|---|---|---|---|---|---|
| **sem_historico** | 5606 | 87,6% | 86,0 | 26,0 | 14,0 | **0** |
| **stale** | 421 | 6,6% | 78,5 | 23,9 | 21,5 | 4 |
| **ativo** | 373 | 5,8% | 67,3 | 25,4 | 32,7 | 26 |

Soma fecha: 373 + 421 = 794 com venda válida all-time; 6400 − 794 = 5606 sem histórico. **`ativo` é confiável**: todos os 373 têm `order_date_kpi` real ≤180d (`ativo_so_por_created_at = 0`; nenhum cliente com venda sem `order_date_kpi`) — sem ruído do `created_at` de importação (bug oben #936). _Nota: a divergência com o "~4 com venda ≤180d" do spec do cap é de método — aquele mediu `days` persistido/congelado em `fcs`; a fonte fresca (RPC) dá 373._

### Achado que define o escopo: o churn fabricado **não** polui o ranking

Hipótese inicial: `churn_risk = 100 − health_score` daria churn alto ao `sem_historico` → `priority_score` alto → topo da agenda. **Refutada pela medição**: apesar de churn médio 86, **0 dos 5606 `sem_historico` chegam ao top-10 de qualquer farmer**. Razão: `priority_score` pondera churn em só 30%; `margin_potential`/`repurchase`/`goal_proximity` (70%) são ~0 para quem nunca comprou → afundam a linha. O top-10 já é `ativo`+`stale`.

**Consequência:** esta fatia **NÃO** toca `churn_risk`/`priority_score`/fórmula de health. O ranking não está poluído; mexer nele seria risco money-path sem retorno. O valor está na **segmentação da base** (telas de lista/perfil) e no **plano** — não no top-10 da agenda diária.

## Decisão / desenho

### 1. Dado — coluna nova
`farmer_client_scores.sales_history_status text NULL` + `CHECK (sales_history_status IS NULL OR sales_history_status IN ('sem_historico','stale','ativo'))`. Espelha `health_class` (também `text NULL`, sem enum nativo). `NULL` = "ainda não computado" (transitório entre a migration e o 1º recompute); a UI o trata como neutro/indeterminado. **Sem default fabricado** (não assumir 'sem_historico' antes de derivar).

### 2. Derivação — helper puro espelhado no edge
`src/lib/scoring/salesHistoryStatus.ts` (vitest + falsificação), espelhado **verbatim** no edge `calculate-scores/index.ts` (padrão `deriveSalesBase`/`recency.ts` — Deno não importa de `src/`):

```
deriveSalesHistoryStatus(sales, activeThresholdDays):
  cap = clampActiveDays(activeThresholdDays)    // clamp LOCAL: Number.isFinite? [30,999] round; senão 180
  sem sales OU total_revenue ≤ 0     → 'sem_historico'   // sem venda VÁLIDA all-time
  days_since_last_purchase ≤ cap     → 'ativo'
  senão                              → 'stale'           // tem histórico, esfriou
```

O `clampActiveDays` é **próprio deste helper** — não importa de `src/lib/scoring/recency.ts` (que vive na branch do cap `agitated-panini`, ainda **não** na `main`; depender dele acoplaria as duas frentes). Lógica idêntica em espírito, código independente.

Fonte já carregada todo run: `salesMap` (RPC `get_customer_sales_summary`) tem `total_revenue` (all-time válido) + `days_since_last_purchase`. **Ausência no `salesMap` = `sem_historico`** (limpo). Limiar `activeThresholdDays = config['sales_active_threshold_days'] ?? 180` — **config próprio** em `farmer_algorithm_config`, desacoplado de `hs_recency_cap_days` (forma da curva de health) — "quando o cliente deixa de ser ativo" é definição de negócio, não de curva.

### 3. Persistência — estende `apply_score_updates` (money-path)
A RPC #971 é UPDATE-only, recordset fixo, **contrato full-update** (campo ausente vira NULL). Adicionar `sales_history_status text` ao recordset e ao `SET`. Mantém `SECURITY INVOKER` + `REVOKE PUBLIC/anon/authenticated` + `GRANT service_role`. **Pré-flight `pg_get_functiondef` da prod** (psql-ro) antes do apply — a última recriação vence; o cap **não** toca a RPC → sem colisão. `prove-sql-money-path` com falsificação (sabotar paridade → vermelho).

No edge: `FarmerClientScoreRow`, `FarmerClientScoreSeed`, `ScoreUpdate` ganham `sales_history_status`; o `updates.push` envia o status derivado (full-update). **Seed** deriva o status do `salesMap` (recém-semeado no `salesMap` → ativo/stale; senão sem_historico).

**Degradação RPC-falha** (`salesRefreshFatal`): **não** recomputa o status — reenvia o valor **atual** da linha (vem no `SELECT *` inicial), espelhando o "congela days" da recência-viva e respeitando o contrato full-update. Nunca fabrica 'sem_historico' por RPC ausente.

### 4. Propagação — UI (verdade visual)
- **Semáforo** (`src/components/customer360/format.ts` `healthTone`; `src/components/adminCustomers/config.ts` `HEALTH_CLASSES`): quando `sales_history_status === 'sem_historico'`, render **neutro** ("Sem histórico", cinza) — nunca o vermelho de `critico`. (Nota de drift pré-existente, **fora de escopo**: `atencao`↔`alerta` divergem entre `format.ts` e `config.ts`; `estavel`/`novo` não mapeados — registrar, não corrigir aqui.)
- **Lista** (`src/components/adminCustomers/CustomerListView.tsx`): expor `sales_history_status` como **coluna/badge** e **filtro** (`useUrlState`) — é onde o ROI está (segmentar 5606 prospecção vs 421 recuperação vs 373 ativo, hoje indistintos).
- **Perfil** (`CustomerHero.tsx` / `Customer360View.tsx`): badge de status ao lado do health.

### 5. Propagação — agenda + plano (hooks)
- **`src/lib/scoring/agenda.ts` `buildAgendaItems`**: `CarteiraRow` ganha `sales_history_status`; `sem_historico` **deixa de ser `'risco'`** (não há churn de quem nunca foi cliente). `AgendaItem` expõe o status. _Impacto prático hoje: baixo (medição: 0 sem_historico no top-10), mas correção semântica e à-prova-de-futuro (carteira de prospecção não vira agenda de "risco" falso)._ **`priority_score`/`churn` intocados.**
- **`useMyCarteiraScores`/`useFarmerScoring`/`useTacticalPlan`**: propagar `sales_history_status` no shape (SELECT já é `*`/colunas; adicionar ao tipo + ao map).
- **`useTacticalPlan.selectObjective`** (linha 190): `sem_historico` → objetivo de **ativação/1ª compra**, não "recuperação"/"reativação". (Não reabrir a inconsistência limite-90 do `selectObjective` — é follow-up do cap.)

## O que esta fatia NÃO faz (registrado de propósito)
- **Não** altera `churn_risk`, `priority_score`, nem a fórmula de `health_score` (medição refutou a necessidade; é o maior risco money-path).
- **Não** adiciona `score_confidence` numérico (YAGNI; o categórico cobre a necessidade da UI).
- **Não** corrige o drift `atencao`↔`alerta` nem o limite-90 do `selectObjective` (follow-ups próprios).

## Prova & medição (money-path)
1. **vitest + falsificação** em `salesHistoryStatus.ts`: tabela (sem sales / total_revenue 0 / ≤180d / >180d / NaN); clamp do limiar; falsificação (sabotar a fronteira → vermelho exato). Paridade helper↔edge (espelho verbatim; `deno check`).
2. **`prove-sql-money-path`** na `apply_score_updates` estendida: PG17 local, aplica a migration real, assert da paridade do novo campo, falsificação (omitir o campo → NULL detectado; grant a `authenticated` → vermelho).
3. **typecheck strict** + **lint** + **knip**.
4. **Medição psql-ro before/after**: a distribuição (5606/421/373) já está medida; pós-deploy, confirmar que `fcs.sales_history_status` bate com a derivação fresca e que o top-10 por farmer **não** mudou (prova de que churn/priority ficaram intactos).
5. **`/codex`**: challenge no design (este doc) e no diff (money-path).

## Coordenação & deploy
- **Base na `main`**; edição do edge **localizada** (longe da linha 453 do `recencyScore`, que o cap toca) → rebase trivial quando o cap (`fccc7a96`, sem PR aberto ainda) mergear. Colisão real só no edge e em regiões distintas; a RPC e a coluna são exclusivas desta frente.
- **3 deploys MANUAIS** (Lovable, CLAUDE.md): (a) migration da coluna + RPC no SQL Editor; (b) redeploy do edge `n` (=`calculate-scores`) verbatim da main; (c) Publish do frontend. Ordem: migration **antes** do edge (o edge envia o novo campo full-update → a RPC precisa aceitá-lo). Merge ≠ produção.

## Riscos & follow-ups
- **R1 — contrato full-update**: se o edge enviar o campo mas a RPC em prod ainda for a antiga (deploy fora de ordem), o campo é ignorado (sem erro) e o status nunca persiste. Mitiga: ordem de deploy + validação psql-ro pós-apply.
- **R2 — `ativo` por `order_date_kpi`**: confiável hoje (medido), mas depende da régua de status válido da RPC (blocklist v4). Se a régua mudar, o status muda junto — esperado/acoplado por design.
- **Follow-up**: revisitar `churn_risk` fabricado **se** o mix de carteiras mudar (um farmer com carteira majoritária de prospecção poderia ver o churn fabricado subir no ranking — hoje não ocorre). Re-medir antes de agir.
- **Follow-up**: `score_confidence` numérico, se a UI pedir gradação além do categórico.
