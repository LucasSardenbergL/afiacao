# Reposição — RLS `has_role` por-linha → InitPlan (mata o 500 de `v_oportunidade_economica_hoje`) — design

**Data:** 2026-06-27 · **Escopo:** 15 tabelas base do módulo reposição (money-path + **autorização/RLS**) · **Origem:** diagnóstico do founder (500 intermitente em `v_oportunidade_economica_hoje` p/ `authenticated`) + confirmação read-only minha via `~/.config/afiacao/psql-ro` + Codex (gpt-5.x high) consultado na metodologia (2026-06-27). · **Contraparte:** PR #1098 (`tint_formulas`, mesmo anti-pattern, caso determinístico 13,4s) e migration `20260613130000` (`radar_empresas`/`pode_ver_carteira_completa`).

> **STATUS 2026-06-27:** spec escrita, aguardando review do founder. Fase 1 (esta spec) = só a reescrita de RLS, como PR money-path próprio + bateria PG17 + handoff `lovable-db-operator`. Fase 2 (materializar a view) é **condicional**, decidida só após medir a Fase 1 em prod. Decisão de escopo do founder (2026-06-27): **faseado por evidência** + **materializar** se a latência residual justificar.

## 1. Diagnóstico (confirmado read-only)

`v_oportunidade_economica_hoje` é `security_invoker=on` e encadeia CTEs sobre ~20 tabelas/sub-views base (`sku_parametros` ⨝ `v_sku_parametros_sugeridos` ⨝ `v_sku_aumento_vigente` ⨝ `v_promocao_item_efetivo` …). A RLS dessas bases desce a cada request. **Dois custos somados, ambos reais:**

| Cenário | Tempo (quente) | Buffers | O que domina |
|---|---|---|---|
| **Estrutural puro** (medido como `claude_ro`, RLS fora) | **885 ms** | 11.256 (~87 MB) | `generate_series` de 180d em `v_sku_demanda_rajada` + `v_sku_sigma_demanda` explode ~537k linhas intermediárias (`Rows Removed by Join Filter: 534852`, 2×); `venda_items_history` varrido 3× |
| **Com RLS** sob `authenticated` (medição do founder) | 2.936 ms | **495.426 (~3,8 GB)** | `has_role` é `SQL STABLE SECURITY DEFINER` → planner **não inlina** → avaliado **por-linha** em ~20 scans, amplificado pelas 537k linhas do `generate_series` |
| **Cache frio + RLS** | **> 8 s → 500** | — | ler ~3,8 GB em cache frio estoura `statement_timeout=8s` do role `authenticated` → PostgREST 500 |

**Reconciliação:** as tabelas são pequenas (`venda_items_history` = 4.983 linhas; a view retorna **12 linhas** p/ OBEN; `sku_parametros` ativos = 468). O I/O do estrutural (87 MB) **nunca estouraria 8s sozinho**. Quem traz os ~3,8 GB que estouram em cache frio é a **amplificação `has_role` por-linha**. O retry do react-query mascara a maioria dos casos → 500 **intermitente**, não determinístico. Custo recorrente: um **badge** faz `count(*)` exact da view a cada 60s em dois pontos do frontend ([AppShell.tsx:443](../../../src/components/AppShell.tsx), [useReposicaoSessao.ts:103](../../../src/hooks/useReposicaoSessao.ts)).

**Os dois problemas se multiplicam, mas a alavanca é a RLS** (~98% dos buffers, ~70% do tempo quente). Logo: o fix de RLS é o que de fato derruba o 500; o estrutural sobra como **latência** (não erro). Isso separa risco de urgência → faseamento.

## 2. Objetivo + gate de aceitação

**Eliminar a amplificação `has_role` por-linha** nas 15 tabelas base, transformando-a em InitPlan (1 avaliação por statement), **sem alterar uma vírgula da semântica de autorização**. Semântica idêntica (mesma função, mesmo resultado: staff vê tudo, não-staff vê nada), só muda o plano de execução.

**Claim honesto (downgrade pós-Codex):** isto remove a amplificação RLS **provada** e *deve* eliminar a patologia de 3,8 GB que estoura em cache frio. **NÃO prova**, por si só, que o endpoint nunca mais dará timeout — a presença das policies pode alterar a forma do plano (pushdown/join-order) mesmo virando InitPlan, e o estrutural de 885ms permanece. Por isso a Fase 1 só é declarada **concluída** contra um gate objetivo, medido em prod (§6):

- buffers caem de ~495k para a **ordem estrutural** (não precisa ser exatamente 11k, mas ordem de 10³–10⁴, não 10⁵);
- **zero** chamadas de `has_role` por-linha (InitPlan no plano);
- tempo **confortavelmente** < 8s (não "raspando");
- o endpoint real para de retornar 500 sob polling concorrente do badge.

**Gatilho de Fase 2 (pré-declarado):** se, pós-fix, o warm autenticado ficar **> ~1s** ou o cold **> ~3s**, a Fase 2 (materializar) passa de condicional a **mandatória**.

## 3. Escopo exato

**36 policies RAW que chamam `has_role`**, em 15 tabelas, **todas `PERMISSIVE`**, RLS habilitada (não forçada). Li as 36 verbatim (via `psql-ro` → `pg_policies`): **todas são OR-puro de `has_role(auth.uid(), <role>)`** — **nenhuma** mistura `has_role` com um predicado de coluna por-linha. Isso torna o wrap **mecânico e seguro** (sem risco de subquery escalar quebrar por coluna não-correlacionada). Padrões:

| Padrão | Tabelas | Policies | Expressão (USING / WITH CHECK) |
|---|---|---|---|
| **A — staff CRUD split** (SELECT/INSERT/UPDATE/DELETE, `TO authenticated`) | `empresa_configuracao_custos`, `fornecedor_cadeia_logistica`, `fornecedor_grupo_producao`, `fornecedor_habilitado_reposicao`, `sku_grupo_producao` | 5×4 = 20 | `has_role(master) OR has_role(employee)` |
| **B — admin manage (ALL) + staff read (SELECT)**, `TO authenticated` | `categoria_aumento_familia_mapeamento`, `fornecedor_aumento_anunciado`, `fornecedor_aumento_item` | 3×2 = 6 | ALL: `has_role(master)` (redundante ×3); SELECT: `…×3 OR has_role(employee)` |
| **B' — idem, `TO public`** | `promocao_campanha`, `promocao_item` | 2×2 = 4 | idem B |
| **Singulares** | `inventory_position` (ALL public + SELECT auth), `omie_products` (ALL auth), `sku_leadtime_history` (ALL auth), `sku_parametros` (SELECT auth), `venda_items_history` (SELECT auth) | 6 | OR de `has_role` (com redundâncias `master` repetido) |

**Fora de escopo (não tocar):** `omie_products."Authenticated users can view products"` (`USING true`, sem `has_role`); `sku_leadtime_history.service_all_*` (`true`, `service_role`); **`sku_parametros."staff can update sku_parametros"`** — já é InitPlan (usa `EXISTS(SELECT 1 FROM user_roles …)` não-correlacionado, que o planner já avalia 1×). As redundâncias `has_role(master) OR has_role(master) OR has_role(master)` são **preservadas verbatim** (precisão > recall: o objetivo é InitPlan, não refatorar lógica; um cleanup é achado lateral não-bloqueante).

## 4. Fix

`ALTER POLICY` **atômico** (não `DROP`+`CREATE`) em cada uma das 36 policies — preserva `cmd`/`roles`/`permissive`, sem janela fail-closed, idempotente. Para cada policy, envolver a expressão num `(SELECT …)` escalar e cada `auth.uid()` em `(SELECT auth.uid())`. Ex. (padrão A, UPDATE — tem USING **e** WITH CHECK):

```sql
ALTER POLICY "staff_fornecedor_grupo_producao_update" ON public.fornecedor_grupo_producao
  USING      ((SELECT has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role)))
  WITH CHECK ((SELECT has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role)));
```

**Princípios de segurança (endurecidos pelo Codex):**

1. **Gerar cada `ALTER` a partir do `qual`/`with_check` REAL por-policy** (capturados de prod), **não** de uma regra-por-`cmd`. Emitir `USING(...)` **apenas se** `qual` existe; `WITH CHECK(...)` **apenas se** `with_check` existe. **Não inventar cláusula** (o atalho "UPDATE/ALL → ambos" é largo demais; no estado real, SELECT/DELETE só têm `qual`, INSERT só `with_check`, UPDATE/ALL têm os dois — mas a fonte da verdade é o estado, não o `cmd`).
2. **Preservar verbatim:** `roles` (`public` vs `authenticated` — **não normalizar**), `permissive` (todas PERMISSIVE), `cmd`, e os termos exatos (incl. redundâncias).
3. **Pré-flight obrigatório** (`database.md`): reler `pg_policies` de prod imediatamente antes de gerar os ALTERs — o apply manual no SQL Editor pode ter divergido do repo (drift). A última a recriar vence.

**Por que InitPlan:** `has_role` é `STABLE SECURITY DEFINER` e o planner não a inlina; chamada direta no `USING` é reavaliada por-linha. Envolta num sublink escalar `(SELECT …)`, vira InitPlan — avaliada 1× por statement. Precedente no repo: `20260613130000` (250k linhas: 420ms→12ms, 35×).

## 5. Prova (PG17 local, `prove-sql-money-path`, espelhando #1098)

Harness PG17 que aplica a **migration REAL** e prova, **para as 15 tabelas** (seed: master/employee/customer/sem-role + anon + NULL-uid; `has_role` VERBATIM de prod = `STABLE SECURITY DEFINER`):

1. **Equivalência old↔new** (a RLS admite exatamente os mesmos callers antes e depois do wrap), no **SELECT** (visibilidade) e no **WITH CHECK** (INSERT/UPDATE): master/employee passam, customer/sem-role/anon/NULL-uid barram — idêntico old×new.
2. **Autorização absoluta** (a RLS faz o que deve): staff vê tudo / não-staff vê 0; WITH CHECK barra `42501` p/ não-staff.
3. **Assert de preservação de catálogo (anti-drift — o furo mais forte do Codex):** `pg_policy` antes×depois **idêntico exceto pelo texto wrapped** — `polcmd`, `polroles` (resolvidos a nomes), `polpermissive`, e a **presença** de `polqual`/`polwithcheck`. Os testes de autz passam enquanto um drift silencioso alarga `TO public`, troca `FOR ALL`, ou adiciona um `WITH CHECK` inexistente — este assert pega isso.
4. **InitPlan via contador:** instrumentar `has_role` com `nextval()` de uma sequence; provar que um SELECT/INSERT de N linhas chama `has_role` **≤ k** (não O(N)) — no `USING` e no `WITH CHECK`. Reforço: `EXPLAIN` contém `InitPlan`.
5. **Falsificação (exigir vermelho):** sabotar um `ALTER` de propósito (ex.: `employee`→`master`, dropar um termo, **alargar `authenticated`→`public`**, ou omitir o wrap) → a bateria tem de **falhar**. Prova que os asserts têm dente.

## 6. Verificação em prod (gate objetivo — owner roda no SQL Editor)

⚠️ **Limitação de medição:** o `claude_ro` é `BYPASSRLS` e **não é membro de `authenticated`** → `SET ROLE authenticated` é negado; **não consigo reproduzir o plano-com-RLS read-only**. (Por isso o §1 mede o estrutural puro, que é um **limite inferior**.) A confirmação do ganho real é do founder, no mesmo SQL Editor onde aplica a migration:

```sql
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub":"414a9727-ad1d-4998-914e-9c6ccf26cf50","role":"authenticated"}';  -- uid master
set local statement_timeout='60s';
explain (analyze, buffers, settings, verbose)
  select count(*) from v_oportunidade_economica_hoje where empresa='OBEN';  -- a query EXATA do badge
rollback;
```

Rodar **antes e depois**, **warm e cold-ish** (1ª run pós-deploy, depois 2ª). Avaliar contra o gate do §2. **Decisão do founder (2026-06-27): via SQL Editor** — eu entrego o bloco pronto no handoff; sem mudar a postura de segurança do role read-only (`GRANT authenticated TO claude_ro` descartado).

## 7. Handoff (escrita)

Via `lovable-db-operator`: migration custom `supabase/migrations/2026MMDDHHMMSS_reposicao_rls_initplan.sql` (timestamp **depois** do `20260627150000` do #1098 — coordenação multi-sessão), bloco pronto p/ SQL Editor, query de validação pós-apply (confere `(SELECT` em cada `polqual`/`polwithcheck` + `polcmd`/`roles`/`permissive` preservados), nota de PR "⚠️ migration manual", `bun run audit:migrations` + commit dos artefatos. **Reconciliar `schema_migrations` + re-dump do snapshot** pós-apply (`database.md §3`).

## 8. Escopo adjacente — alívio de frontend (PR-irmão, mesmo release)

Independente do SQL, barato, baixo risco (recomendação do Codex: fazer no mesmo release train, antes da MV):

- **Degradação honesta:** o badge não pode surfacar 500. Hoje [useReposicaoSessao.ts:106](../../../src/hooks/useReposicaoSessao.ts) faz `throw oport.error` → quebra a derivação do step. Degradar p/ `null`/`0` + sinal de "indisponível" (money-path: ausente ≠ zero — o badge mostra "—", não fabrica). [AppShell.tsx:450](../../../src/components/AppShell.tsx) já faz `count ?? 0` (ok, mas idem: degradar honesto).
- **Dedupe dos 2 pollers:** [AppShell.tsx:443](../../../src/components/AppShell.tsx) (`['oportunidades-ativas-count']`) e [useReposicaoSessao.ts:99](../../../src/hooks/useReposicaoSessao.ts) (`['cockpit-current-step', …]`) fazem a MESMA `count(*) OBEN` a cada 60s, sem compartilhar cache → 2× a carga. Unificar numa fonte/queryKey compartilhada.
- (Adiado p/ Fase 2 se necessário) trocar `count:'exact'` por fonte mais barata — `estimated` numa view security-invoker é primitivo errado; a MV resolve de vez.

## 9. Fase 2 — condicional: materializar a view (decisão pós-medição)

Só se o gate do §2/§6 mostrar latência residual material. **Materialized View** `mv_oportunidade_economica_hoje` refreshed por cron (~2h, alinhado ao ciclo intra-day do motor; a view depende de `CURRENT_DATE`). **Não tocar** as fórmulas do `generate_series` (alimentam `sigma`/EOQ = money-path; mudá-las muda quantidade de compra). Riscos a tratar no design da Fase 2 (levantados pelo Codex):

- **Stale silencioso:** cron falho deixa dado velho **sem erro**. Coluna `refreshed_at` + monitor de idade (Sentinela/`data_health`) + UI degrada/rotula stale. Para um sinal money-path, 2h pode ser demais p/ algumas decisões — validar com o founder.
- **Acesso (MV não tem RLS):** expor via view wrapper `security_invoker` + RLS, ou função staff-gated; **nunca** GRANT amplo da MV crua.
- **`REFRESH … CONCURRENTLY`** exige índice UNIQUE cobrindo todas as linhas (senão refresh bloqueia leituras). Eleger a chave lógica (`empresa, sku_codigo_omie, …`).
- **Timezone:** `CURRENT_DATE` depende do TZ do banco × negócio — explicitar.

## 10. Riscos, armadilhas e coordenação

- **Multi-sessão (verificado 2026-06-27):** nenhuma worktree/PR reescreve a RLS dessas 15 tabelas (só #1098, em `tint_formulas`, tabela diferente). `frente/fix-aplicar-promocoes-hardening` mexe na **função** `aplicar_promocoes`, não na RLS de `promocao_*`. Confirmar de novo no pré-flight (§4.3) antes de gerar os ALTERs.
- **`CREATE OR REPLACE`/`ALTER` manual diverge do repo** → pré-flight `pg_policies` de prod é obrigatório.
- **`REVOKE FROM PUBLIC` não tira `anon`/`authenticated`** — não aplicável aqui (não estamos mexendo em grants), mas as policies `TO public` incluem `anon`; o assert de equivalência cobre `anon` barrado.
- **PL/pgSQL late-bound** — não aplicável (são policies, não funções), mas o harness PG17 executa de verdade mesmo assim.

## 11. Codex — challenge da metodologia (2026-06-27, consult high)

Convergente, sem travar (fatos no prompt, snapshot não aberto). Acatado: (1) downgrade do claim "Fase 1 mata o 500" → "remove a amplificação provada, não prova reliability" + gate objetivo; (2) **gerar ALTER do estado real, não inventar cláusula**; (3) **assert de catálogo** (cmd/roles/permissive/qual/with_check), não só outcomes — "os testes de autz passam enquanto você alarga `TO public`"; (4) medição precisa (EXPLAIN ANALYZE,BUFFERS,SETTINGS,VERBOSE sob `SET LOCAL ROLE authenticated` + GUCs, warm+cold, query do badge); (5) alívio de frontend no mesmo release (dedupe pollers + degradação honesta) antes da MV. Pendente p/ Fase 2: riscos da MV (§9). Saída integral apresentada ao founder na sessão.

## 12. Não-objetivos

- **Não** mexer nas fórmulas/sub-views do motor de demanda (`v_sku_demanda_rajada`/`v_sku_sigma_demanda`) — money-path puro, fora desta fase.
- **Não** refatorar as redundâncias `has_role(master)` (preservar verbatim).
- **Não** materializar nada na Fase 1 (decisão pós-medição).
- **Não** alterar grants, roles, ou a função `has_role`.
