# Furo de visibilidade: `carteira_visivel_para`/`minha_carteira` ignoram `eligible` — design

> money-path (autorização RLS de carteira + visibilidade de artefatos de cliente). Fecha o furo que a
> **invariante #3 da Fatia 2** ([2026-07-16-fatia2-identity-state-quarantine-design.md](2026-07-16-fatia2-identity-state-quarantine-design.md))
> declarou fechado e não está. Estado **medido em PROD via psql-ro (role `claude_ro`) em 2026-07-17**;
> revisão adversária **Codex `gpt-5.6-sol` xhigh** na metodologia (parecer `DONE_WITH_CONCERNS`).
> **2 funções, zero DDL de tabela.**

## 1. Ponto de partida (verificado, não presumido)

| fato | evidência (2026-07-17, psql-ro) |
|---|---|
| `carteira_visivel_para` ignora `eligible` | `pg_get_functiondef`: `EXISTS(... WHERE customer_user_id=… AND owner_user_id=_uid)` **sem** `AND a.eligible`, em ambos os braços (direto + cobertura) |
| ela gateia **8 policies RLS** | `carteira_assignments` (SELECT), `farmer_client_scores`, `customer_visit_scores`, `farmer_recommendations`, `farmer_bundle_recommendations`, `farmer_calls`, `route_visits` (SELECT), `visitas_agendadas` (**INSERT** WITH CHECK) |
| `minha_carteira` ignora `eligible` | idem, nos 2 ramos do UNION; `EXECUTE` p/ `authenticated`; **sem caller no app** (só types gerados) mas exposta como RPC PostgREST |
| `eligible` | `boolean NOT NULL DEFAULT true`, **0 NULLs**; `carteira_assignments` tem `UNIQUE(customer_user_id)` → 1 linha/cliente |
| linhas `eligible=false` | **2112** (2093 `hunter_orphan` = fornecedores excluídos + master-parked; 19 `omie` = clones B-lite escondidos) |
| `carteira_coverage` | **0 linhas** → o braço de cobertura é inerte hoje |
| repo == prod | `20260524120000_carteira_omie_fase1.sql` define ambas idênticas ao `pg_get_functiondef` de prod — **sem deriva** |

### 1.1 O que a invariante #3 da Fatia 2 errou

A Fatia 2 declara: *"Quarantinado → eligible=false → zero comissão E invisível (todos os leitores usam
`WHERE eligible`)."* A **1ª metade é verdadeira** (comissão/positivação filtra eligible em
`_carteira_positivacao_for_owner`; a tela filtra em [escopo-clientes.ts:130](../../../src/lib/carteira/escopo-clientes.ts)).
A **2ª metade é FALSA**: 8 de 14 consumidores SQL de `carteira_assignments` ignoram `eligible`. O furo é de
**VISIBILIDADE (autorização RLS)**, não de dinheiro.

## 2. Auditoria caso-a-caso dos 8 que ignoram `eligible`

Precisão > recall: filtrar `eligible` **não é** correto em bloco — `eligible` colapsa dois sentidos
("aparece na carteira operacional" **e** "autoriza acesso RLS"). Veredito por função (corpo lido de PROD):

| # | função | veredito | porquê |
|---|---|---|---|
| 1 | **`carteira_visivel_para`** | 🔴 **FILTRAR** | gate de autz das 8 policies. `farmer_client_scores`/`customer_visit_scores` **não têm** braço de autoria → o fix **fecha 100%** delas. |
| 2 | **`minha_carteira`** | 🔴 **FILTRAR** | RPC SECURITY DEFINER exposta a `authenticated`; devolve mascarados se chamada direto. Sem caller no app → baixo risco. |
| 3 | `list_impersonation_targets` | 🟢 não tocar | enumera **reps** (`DISTINCT owner_user_id`), não artefatos de cliente; `eligible` é da relação com o cliente. Inerte: 0 owners são 100%-inelegíveis. Lente "Ver como". |
| 4 | `criar_plano_tatico` | 🟢 não tocar | já chama `carteira_visivel_para` p/ auth (herda o fix); o `SELECT … FOR UPDATE` é lock/atribuição — precisa achar o owner. Ver §3.1 (fail-open **descartado**). |
| 5 | `cleanup_orphan_score_on_carteira_delete` | 🟢 não tocar | **razão (corrigida pelo Codex):** com `UNIQUE(customer_user_id)` + `AFTER DELETE`, não sobra outra assignment → `NOT EXISTS` é true com ou sem eligible; mudar eligible→false **não dispara** DELETE. GC testa **existência física**, não visibilidade. |
| 6–8 | `enqueue_score_recalc_from_{call,sinais}` / `enqueue_visit_score_recalc_from_visit` | 🟢 não tocar | recompute é derivação backend, não leak nem comissão; filtrar = score stale sem ganho. **Condicional (Codex):** vale enquanto fila/sinks forem privados e a elegibilidade for reaplicada **no momento da exposição/comissão** — ver §7-FU3. |

## 3. A mudança (this PR)

### 3.1 `carteira_visivel_para` — filtrar + tornar TOTAL (nunca-NULL)

O Codex apontou fail-open teórico no caller `IF NOT carteira_visivel_para(...)` de `criar_plano_tatico`
(PL/pgSQL só roda `THEN` em TRUE; se a função retornasse NULL, pula). **Verificado e descartado como bug
vivo:** `has_role` é `SELECT EXISTS(...)` → nunca NULL; os 2 `EXISTS` nunca são NULL; logo a função nunca
retorna NULL, e `criar_plano_tatico` ainda guarda `_uid IS NULL` antes. Mesmo assim tornamos o gate
**provavelmente total** na fonte (custo ~0), o que torna o caller seguro **por construção** — por isso
`criar_plano_tatico` **não é reescrita** aqui (evita transcrever 60 linhas money-path; o `IS NOT TRUE` do
caller fica como micro-follow-up FU5).

```sql
CREATE OR REPLACE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT _uid IS NOT NULL
    AND (
      COALESCE(public.has_role(_uid, 'master'::app_role), false)
      OR EXISTS (
        SELECT 1 FROM public.carteira_assignments a
        WHERE a.customer_user_id = _customer_user_id
          AND a.owner_user_id = _uid
          AND a.eligible IS TRUE
      )
      OR EXISTS (
        SELECT 1 FROM public.carteira_assignments a
        JOIN public.carteira_coverage c ON c.covered_user_id = a.owner_user_id
        WHERE a.customer_user_id = _customer_user_id
          AND a.eligible IS TRUE
          AND c.covering_user_id = _uid
          AND c.active
          AND (c.valid_until IS NULL OR c.valid_until > now())
      )
    );
$function$;
```

Mudanças vs prod: (a) `AND a.eligible IS TRUE` nos 2 `EXISTS`; (b) wrapper `_uid IS NOT NULL AND (…)` +
`COALESCE(has_role,…,false)` → totalidade explícita; (c) refs qualificadas (`public.`) — neutraliza
shadowing de `search_path` para estas funções (Codex §4.5; o `pg_temp`-last repo-wide é FU7).
**Equivalência provada:** para `_uid` NULL, prod já retornava false (has_role(NULL)=false via EXISTS;
EXISTS(owner=NULL)=false) → o wrapper não muda comportamento além da máscara `eligible`.

### 3.2 `minha_carteira` — filtrar os 2 ramos

```sql
CREATE OR REPLACE FUNCTION public.minha_carteira()
 RETURNS TABLE(customer_user_id uuid, owner_user_id uuid, coberto_de uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.customer_user_id, a.owner_user_id, NULL::uuid AS coberto_de
  FROM public.carteira_assignments a
  WHERE a.owner_user_id = auth.uid()
    AND a.eligible IS TRUE
  UNION
  SELECT a.customer_user_id, a.owner_user_id, a.owner_user_id AS coberto_de
  FROM public.carteira_assignments a
  JOIN public.carteira_coverage c ON c.covered_user_id = a.owner_user_id
  WHERE c.covering_user_id = auth.uid()
    AND c.active
    AND (c.valid_until IS NULL OR c.valid_until > now())
    AND a.eligible IS TRUE;
$function$;
```

### 3.3 Aplicação (Codex §6)

Uma transação; reafirmar `STABLE`/`SECURITY DEFINER`/`SET search_path` (CREATE OR REPLACE preserva owner
e grants — **verificado: sem `EXECUTE` para PUBLIC**, nada a revogar). Assertion pós-apply por
`pg_get_functiondef` (a última a recriar vence; serializar deploy).

## 4. Impacto medido (PROD)

Restrição **monotônica**: linhas só somem, **0 ganham** visibilidade.

| owner afetado | papel | `pode_ver_carteira_completa` | `eligible=false` | efeito do fix |
|---|---|---|---|---|
| lucascoelhosardenberg | **master** | ✅ | 2093 | **ZERO** (lê tudo pelo braço `master`, intacto, + policy `Master manage`) |
| REGINA CELIA | farmer/employee | ❌ | 14 | perde visibilidade de 14 clientes mascarados |
| tatyanamartins2002 | farmer/employee | ❌ | 5 | perde visibilidade de 5 clientes mascarados |

**Dos 2112 pares teóricos, 2093 são do master (imune).** O efeito material vivo é **19 pares / 2
vendedoras não-gestoras**. Dado real fechado pelo fix: `farmer_client_scores` 1459 + `customer_visit_scores`
1459 (100%, sem braço de autoria) + 91 de 730 `farmer_recommendations`. Nenhum leitor frontend direto
quebra: o único ([escopo-clientes.ts:128](../../../src/lib/carteira/escopo-clientes.ts)) já filtra
`eligible=true`.

**Valor primário** não é o volume de hoje — é (a) fechar a **RPC direta `minha_carteira`** e a SELECT de
`carteira_assignments` para não-master, e (b) **armar o fail-closed** para quando o quarantine de
identidade ambígua ficar vivo (hoje 0 ambíguos).

## 5. Invariantes (o mapa HONESTO — substitui a #3 da Fatia 2)

1. O gate `carteira_visivel_para` e a RPC `minha_carteira` passam a **filtrar `eligible IS TRUE`** →
   fecham `farmer_client_scores`/`customer_visit_scores` (100%), a SELECT de `carteira_assignments`
   (não-master) e o INSERT de `visitas_agendadas`.
2. O gate é **total** (`_uid IS NOT NULL AND …`, nunca NULL) → callers `IF NOT gate()` são fail-closed.
3. **NÃO é verdade** que "todos os leitores usam `WHERE eligible`". Continuam eligible-**blind**, por design:
   os braços de **autoria** (`farmer_id`/`visited_by = auth.uid()`) em recommendations/calls/visits/bundle;
   **`pode_ver_carteira_completa`** (gestor/master); e **edge functions com `service_role`** (bypassam RLS).
4. Para **fornecedor-excluído / clone-escondido**, o resíduo de autoria é aceitável (o vendedor já conhece
   esses clientes; não é caso de esconder identidade). Para **identidade-ambígua** (futuro) o braço de
   autoria é um **gap de reidentificação aberto** (Codex §5) → FU1.
5. Aditivo: com os 3 owners de hoje, master é intocado; o efeito é 19 pares em 2 vendedoras.

## 6. Testing — `prove-sql-money-path` (PG17, falsificável)

RLS de alto risco → PG17 local com `SET ROLE authenticated` + GUC `request.jwt.claims`, e **falsificação**.

| cenário | prova |
|---|---|
| owner vê cliente `eligible=true` (direto) | policy retorna a linha |
| owner **não** vê cliente `eligible=false` (direto) | **fechado** pós-fix (regride pré-fix) |
| master vê `eligible=false` | braço `master` intacto |
| gestor (`pode_ver_carteira_completa`) vê scores de `eligible=false` | **inalterado** (bypass documentado, §5.3) — asserção de que o fix NÃO mexe nisso |
| anon / `_uid` NULL | false (totalidade) |
| cobertura (`carteira_coverage`) com `eligible=false` | fechado (semear 1 linha, já que prod tem 0) |
| `minha_carteira()` sob `SET ROLE` do owner | não retorna mascarados |
| **falsificação** | remover `AND a.eligible IS TRUE` de um braço → o assert negativo **tem** que ficar vermelho; baseline VERDE + contagem/nomes dos vermelhos conferidos (lição #1358) |

Baseline pré-apply (psql-ro): `carteira_visivel_para` retorna true hoje para os 19 pares (Regina/Tatyana);
pós-apply: false. Master: true nos dois. `farmer_client_scores` legíveis por Regina caem de N→N−(seus mascarados).

## 7. Deploy

**🟣 SQL Editor do Lovable** (founder cola — via `lovable-db-operator`). Sem Publish (nenhuma mudança de
frontend). Sem edge. Verificação pós-apply por `pg_get_functiondef` (psql-ro) + a distribuição de impacto.

## 8. Follow-ups arquivados (decisão Lucas 2026-07-17: fix estreito + arquivar)

Fechar a invariante por completo exige um **split de motivo/estado** que uma flag booleana não expressa
(Codex: `eligible=false` colapsa fornecedor-excluído / clone / identidade-ambígua). Arquivados, não
construídos aqui:

- **FU1 — autoria vs quarantine de identidade:** RESTRICTIVE policy central por-cliente **ou** coluna de
  motivo, p/ autoria sobreviver no fornecedor-excluído mas **não** na identidade-ambígua. Vale p/ futuras
  `farmer_calls`/`route_visits`/`farmer_bundle_recommendations` (0 hoje). (Codex §5.)
- **FU2 — audit edge service_role:** 14 edges leem scores/recs/`carteira_assignments` via `service_role`
  (bypassa RLS); provar que nenhum devolve dado de cliente mascarado a vendedor (`recommend` já usa
  client-JWT + admin separados — padrão bom). (Codex §3.)
- **FU3 — policy broad-staff das filas:** `score_recalc_queue`/`visit_score_recalc_queue` SELECT =
  `master OR employee` → qualquer funcionário lê pares `(cliente,owner)` mascarados (ids-only, transiente).
  Estreitar p/ master/service ou carteira-scoped. Reaplicar `eligible` no consumo/comissão, não só no
  enqueue (Codex §1.4-6).
- **FU4 — modelo de auditoria do gestor:** decidir se `pode_ver_carteira_completa` deve respeitar a máscara
  ou se o quarantine precisa de superfície de auditoria dedicada. Default hoje: **master-as-auditor**
  (vê tudo via `Master manage`). (Codex §2.)
- **FU5 — `criar_plano_tatico` caller `IS NOT TRUE`:** micro-hardening (redundante dado o gate total; belt
  contra refactor futuro do gate). (Codex §1.2/§4.2.)
- **FU6 — `eligible DEFAULT true` é fail-open** p/ um writer futuro de identidade não-resolvida (estado
  inicial seguro = pending/false). (Codex §4.1.)
- **FU7 — hardening repo-wide de SECURITY DEFINER:** `search_path` com `pg_temp` por último + mover helpers
  sensíveis de RLS (`carteira_visivel_para` é oráculo "cliente X é do owner Y?") p/ schema não-exposto.
  (Codex §3/§4.5.)
- **FU8 — comentário stale: ✅ FEITO (2026-07-18).** [useMyCarteiraScores.ts](../../../src/hooks/useMyCarteiraScores.ts)
  dizia "a RLS é ampla (qualquer staff lê tudo)" — **falso**. Reescrito contra `pg_policies` medida em prod:
  `fcs_select_carteira` = `pode_ver_carteira_completa OR carteira_visivel_para` (carteira-scoped, **sem** braço
  de autoria no SELECT — `farmer_id` só aparece em INSERT/UPDATE/DELETE). Nuance registrada no comentário:
  p/ gestor o filtro segue display-only; p/ vendedor comum a RLS é a fronteira e recorta por CLIENTE.

## 9. Correção da invariante #3 da Fatia 2

Editar [2026-07-16-fatia2-identity-state-quarantine-design.md](2026-07-16-fatia2-identity-state-quarantine-design.md)
§5 invariante 3: trocar *"todos os leitores usam `WHERE eligible`"* pelo mapa honesto (§5 deste doc) e
apontar para este design + FU1.
