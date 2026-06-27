# Reposição Fase 2 — materializar o COUNT do badge de oportunidade (MV em `private` + view-gate) — design

**Data:** 2026-06-27 · **Escopo:** badge de oportunidade econômica (OBEN, money-path + **autorização**) · **Origem:** Fase 2 de `2026-06-27-reposicao-rls-initplan-oportunidade-economica-design.md` — a Fase 1 (RLS→InitPlan) matou o 500, sobrou **880ms estrutural** no `count(*)` do badge. Founder decidiu (2026-06-27) fazer a Fase 2: **cachear só o badge, tela tempo-real, refresh 2h**. Codex (gpt-5.x high) consultado na metodologia.

> **STATUS 2026-06-27:** spec escrita. Decisões do founder: **Opção B** (cachear só o badge; a tela de Oportunidades segue tempo-real) + **refresh 2h**. Codex endureceu o design (count em vez de rowset, schema private, gate hardened, watchdog timestamp).

## 1. Por que (o que sobrou da Fase 1)

A Fase 1 derrubou os buffers de 495.426 → 11.419 e eliminou o 500. Resta **880ms quente** (estrutural: `generate_series` de 180d explode ~537k linhas intermediárias pra devolver **12 linhas**). O badge faz `count(*)` exact dessa view a cada 60s (agora dedupado em 1 request/60s, #1108) → paga 880ms de CPU por poll. **Não é erro, é latência** — Fase 2 ataca isso só no caminho do badge.

**Quem consome a view (verificado read-only):**
- **Badge** (`useOportunidadesAtivasCount`, [useReposicaoSessao.ts](../../../src/hooks/useReposicaoSessao.ts)) — lê a view DIRETO. ← alvo da Fase 2.
- **Tela de Oportunidades** ([AdminReposicaoOportunidades.tsx](../../../src/pages/AdminReposicaoOportunidades.tsx)) via `v_otimizador_compras_insumos` (que depende da view) — **fica tempo-real** (decisão de compra; staleness é ruim).

## 2. Design (Opção B, endurecido pós-Codex)

Materializar **só o COUNT por empresa** (não as 25 colunas sensíveis — superfície de vazamento mínima), em schema **`private`** (não exposto ao PostgREST), atrás de uma **view-gate** em `public`.

| Objeto | Definição |
|---|---|
| `private.mv_oportunidade_badge` (MV) | `SELECT empresa, count(*)::int AS oportunidade_count, now() AS refreshed_at, CURRENT_DATE AS calculado_em FROM public.v_oportunidade_economica_hoje GROUP BY empresa` · `WITH DATA` · **UNIQUE INDEX (empresa)** (provado único) · `REVOKE ALL FROM PUBLIC, anon, authenticated` |
| `public.v_oportunidade_economica_hoje_badge_cached` (view-gate) | `WITH (security_invoker=off, security_barrier=true)` · `SELECT empresa, oportunidade_count, refreshed_at FROM private.mv_oportunidade_badge WHERE (gate)` · `GRANT SELECT TO authenticated` |
| `public.refresh_oportunidade_badge()` | `SECURITY DEFINER`, `search_path public,private` · advisory-lock + `REFRESH MATERIALIZED VIEW CONCURRENTLY private.mv_oportunidade_badge` · **sem gate `auth.uid()` interno** · `REVOKE EXECUTE FROM anon,authenticated,PUBLIC` + `GRANT service_role` |
| cron | `cron.schedule('afiacao_oportunidade_badge_refresh_2h','20 */2 * * *','SELECT public.refresh_oportunidade_badge()')` |
| frontend | `useOportunidadesAtivasCount` lê a `_badge_cached` (count pré-computado), degradação honesta preservada |
| watchdog | alerta se `now() - max(refreshed_at) > interval '150 min'` (cron travado = número stale silencioso) |

O padrão **MV em `private` + view-gate em `public` + função de refresh** já existe no repo (`private.mv_sku_ranking_negociacao_paralela`).

## 3. Gate de acesso (o ponto crítico — MV não tem RLS)

O **gate** (null-hardened, InitPlan) replica EXATAMENTE a semântica da RLS original (todas as 15 bases eram "staff vê tudo"; `service_role` bypassa):

```sql
WHERE (
      (SELECT auth.role()) = 'service_role'
   OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::app_role)),   false)
   OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'employee'::app_role)), false)
)
```

- **não-staff / anon** (`auth.uid()` NULL) → `has_role(NULL)=false`, `auth.role()≠'service_role'` → **0 linhas**.
- **staff** (master/employee) / **service_role** → todas as linhas.
- `security_invoker=off` → a view lê a MV como **owner** (a MV é `REVOKE`ada de `authenticated`, então o caller NÃO lê a MV crua — só via a view-gate). `security_barrier=true` impede vazamento por ordem de avaliação de predicado (não dependemos do PostgREST como modelo de segurança — Codex).
- **Defense-in-depth:** MV em `private` (PostgREST não expõe) **+** `REVOKE ALL FROM PUBLIC` **+** grant só do que precisa.

## 4. Refresh (sem matar o cron; sem bloquear o badge)

- **Sem gate `auth.uid()` interno** na função — lição `reposicao.md`: o cron roda como `postgres` (sem JWT), um gate `auth.uid() IS NULL → RAISE` mataria o cron silenciosamente. (É o bug que pegamos AGORA no `refresh_sku_ranking_negociacao` — cron morto desde 2026-06-22, registrado em tarefa separada.) Proteção = `REVOKE EXECUTE` de anon/authenticated + `GRANT service_role`; o `postgres` do cron passa por cima dos grants.
- **`CONCURRENTLY`** (não bloqueia o badge; readers veem a versão antiga até o swap) — exige o índice único. MV criada `WITH DATA` (nasce populada → o 1º `CONCURRENTLY` funciona).
- **Advisory lock** (`pg_try_advisory_lock`): runs sobrepostas dão skip em vez de enfileirar.
- **Sem fallback non-concurrent cego** (Codex): bloquearia o badge. Se o `CONCURRENTLY` falhar (ex.: índice violado), **mantém o estado antigo** (stale-served) e o **watchdog** alerta — recovery manual, não mascarar.

## 5. Frescor / watchdog

- **Timestamp-based**, não `CURRENT_DATE` (Codex): `now() - max(refreshed_at) > 150min` pega cron travado no MESMO dia (o `MAX(calculado_em) < CURRENT_DATE` só pegaria a virada). Plugar no `_data_health_compute`/Sentinela (sync.md).
- **TZ:** o banco é **UTC**; `CURRENT_DATE`/`calculado_em` viram o dia às 21h BR — já é o comportamento da view atual (não muda). O refresh 2h cobre a virada UTC.

## 6. Frontend

`useOportunidadesAtivasCount` passa a ler a view-gate (count pré-computado), **preservando a degradação honesta** (#1108): erro → `null`, sem-linha → `0`, com-linha → count. Distinção: `if (error) return null; return data?.oportunidade_count ?? 0` (sem-linha = empresa sem oportunidade = 0 legítimo; erro = indisponível = null/"—").

```ts
const { data, error } = await supabase
  .from("v_oportunidade_economica_hoje_badge_cached")
  .select("oportunidade_count").eq("empresa", REPOSICAO_EMPRESA).maybeSingle();
if (error) return null;            // indeterminado (≠ 0)
return data?.oportunidade_count ?? 0;  // sem linha = 0 oportunidades
```

## 7. Prova (PG17, `prove-sql-money-path`)

A migração REAL, com asserts positivos/negativos + falsificação:
1. **Gate / autz:** staff (master/employee) vê N; customer/sem-role/**anon (uid NULL)** vê **0**; `service_role` vê N. Equivalência com a semântica da view original.
2. **Vazamento:** `authenticated` **não** lê `private.mv_oportunidade_badge` direto (REVOKE) — só via a view-gate. (Provar `permission denied` no acesso cru.)
3. **Paridade:** `oportunidade_count` da MV == `count(*)` da view original por empresa.
4. **Cron-context (o anti-bug):** a função `refresh_oportunidade_badge()` roda com `auth.uid()=NULL` (stubar NULL, **não** 'service_role' — senão mascara) e **refresca** (não dá 42501).
5. **REFRESH CONCURRENTLY** funciona com o índice único; advisory lock serializa.
6. **Falsificação:** (a) gate `USING(true)` → não-staff vaza → assert morde; (b) gate sem `service_role` → service_role/cron perde acesso → morde; (c) função COM gate `auth.uid()` → falha sob NULL (prova que o anti-bug seria pego); (d) índice não-único → `CONCURRENTLY` falha.

## 8. Handoff

Via `lovable-db-operator`: migration custom (MV + índice + view-gate + função + cron + grants) + bloco SQL Editor + validação pós-apply (MV existe + populada, view-gate retorna sob staff, cron agendado) + audit. **Frontend** = PR-irmão (muda 1 hook). Pós-apply: forçar 1 refresh + conferir via psql-ro.

## 9. Codex — challenge da metodologia (2026-06-27, high)

Convergente. Acatado: (1) **count-por-empresa em vez do rowset de 25 colunas** (superfície de vazamento mínima); (2) schema `private` + `REVOKE ALL FROM PUBLIC` + grants explícitos; (3) gate null-hardened + `security_barrier`; (4) watchdog **timestamp-based** (não `CURRENT_DATE`); (5) advisory lock + sem fallback bloqueante. Pendente p/ adversarial do código: provar o gate não vaza + cron-context.

## 10. Não-objetivos / achados laterais

- **Não** materializar a tela de Oportunidades (fica tempo-real — decisão de compra).
- **Não** recriar `v_oportunidade_economica_hoje` nem tocar `v_otimizador_compras_insumos`.
- **Achado lateral (tarefa separada):** `refresh_sku_ranking_negociacao` tem o gate `auth.uid()` que matou o cron `afiacao_ranking_refresh_semanal` desde 2026-06-22 (MV de ranking stale). Registrado.

## 11. Riscos

- **Vazamento** (MV sem RLS) — mitigado por private + REVOKE ALL + view-gate + security_barrier; **provado** no §7.2.
- **Cron morto silencioso** — mitigado por watchdog timestamp (§5) + sem gate `auth.uid()` (§4).
- **Stale do badge** (até 2h) — aceito (badge é navegacional; a tela decisória é tempo-real).
- **Drift de colunas da view** — a MV é `SELECT count(*)` (não depende das 25 colunas), imune.
