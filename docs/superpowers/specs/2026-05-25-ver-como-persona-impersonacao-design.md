# "Ver como pessoa" — impersonação read-only para QA (master)

> **Status:** design aprovado (founder + Codex), 2026-05-25. Próximo: writing-plans.
> **Programa:** Carteira-Omie (ferramenta de QA/operabilidade; não é superfície de vendas nova).
> **Pré-requisito:** PR #221 (controle de acesso por persona) mergeado.

## Problema

Hoje o master (Lucas) **não consegue ver a experiência de cada persona** — em especial a do vendedor/farmer (FarmerCalls com positivação, "a positivar" e cross-sell). As RPCs de carteira são `SECURITY DEFINER` cravadas em `auth.uid()`, então logar como master mostra a visão do master (que vê tudo), não a do farmer. Verificar cada superfície nova virou um gargalo: toda feature depende de o founder conferir manualmente, e ele não tem login dos vendedores.

O `MasterDashboard.tsx` já tem um placeholder registrando a intenção: *"Toggle 'ver como Farmer/Hunter/Closer' pra entrar na visão de cada um"*.

## Objetivo

Um controle **master-only** "Ver como [pessoa]" que mostra, para uma pessoa específica escolhida numa lista:
1. **O layout dela** — quais telas/menu aquela persona enxerga (via o resolver do #221).
2. **Os dados reais dela** — positivação, cross-sell, saúde da carteira, sugestões de visita, scores.

Tudo **somente leitura**. Resolve a verificação pro founder **e** pro agente de QA, sem ninguém trocar senha.

## Decisões cravadas

| Decisão | Escolha | Origem |
| --- | --- | --- |
| Escopo da visão | **Layout + dados reais** (não só layout) | founder Q1 |
| Granularidade do alvo | **Pessoa específica** (escolho numa lista; persona derivada dos papéis dela) | founder Q2 |
| Sequência vs #221 | **Mergear #221 primeiro**, depois view-as completo | founder Q3 |
| Superfície (v1) | **Cockpit do vendedor/carteira** (Abordagem 1 — focada) | founder |
| Quem impersona | **Só master** em v1 (gestor fica pra depois) | founder |
| Padrão do gate | **Pattern B** — RPCs irmãs `_for(target)` master-only, RPCs de vendedor intocadas | Codex |
| Read-only | Garantido por construção: **sessão continua a do master**; `effectiveUserId` só pra leitura | Codex |
| Audit | **Sim** — tabela `impersonation_audit`, loga o início | Codex (LGPD/governança) |

## Não-objetivos (YAGNI v1)

- Impersonar **cliente** (modelo de dados/RLS diferente; fica pra v2 se houver demanda).
- **Gestor** impersonar (só master em v1).
- **Agir como** o alvo (criar pedido, disparar ligação, editar). Impersonação é sempre read-only.
- Trocar a sessão Supabase / JWT do alvo (nunca — não temos senha e seria perigoso).

## Arquitetura

### 1. `ImpersonationContext` (client)

Provider montado no `AppShell` (acima das telas de carteira). Estado:

- `realUser` — sempre o master autenticado (de `useAuth`).
- `target` — `{ id, nome, grupo } | null` (pessoa escolhida).
- `effectiveUserId` — derivado: `target?.id ?? realUser.id`.
- `isImpersonating` — `!!target`.
- `startImpersonation(target, reason?)` / `stopImpersonation()`.

Persistência: `sessionStorage` (sobrevive navegação, limpa ao fechar a aba). Saída sempre explícita (botão no banner).

### 2. RPCs irmãs master-only (Pattern B — migration)

Para cada RPC de vendedor **do cockpit do farmer**, uma irmã explícita. As RPCs de vendedor **não são tocadas**. (`get_carteira_saude` fica **fora** — é superfície de admin em `/admin/analytics-sync`, não da visão do farmer; impersonar farmer nunca a renderiza.)

```
get_meu_mixgap()              -- existente: auth.uid(), employee/master
get_meu_mixgap_for(p_target)  -- NOVA: master-only, escopa a p_target

get_minha_positivacao()             -- existente
get_minha_positivacao_for(p_target) -- NOVA
```

Cada `_for`:
- `SECURITY DEFINER`, `SET search_path = public`, objetos schema-qualified.
- **1ª linha:** `IF NOT has_role(auth.uid(), 'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;` — **RAISE, não RETURN NULL** (null esconde abuso/bug).
- `IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;`
- Corpo = espelho do original, escopado a `p_target`. Onde a duplicação for relevante, extrair um internal compartilhado (`_carteira_<x>_for_owner(owner uuid)`) chamado tanto pela RPC de vendedor (passando `auth.uid()`) quanto pela `_for`. Nomes **distintos** (sem overload/default-arg — resolução PostgREST surpreende).
- `GRANT EXECUTE ... TO authenticated` é aceitável porque a 1ª linha nega não-master; mas o gate não depende do grant.

### 3. `get_user_access_profile_for(p_target)` (migration, master-only)

Devolve `{ role, commercial_role, department }` do alvo — insumos que o resolver do #221 usa pra decidir a persona. Mesmo gate (master-only, RAISE). Alimenta o override do `useAccess`.

### 4. `list_impersonation_targets()` (migration, master-only)

Lista os alvos impersonáveis = **donos de carteira** (`SELECT DISTINCT owner_user_id FROM carteira_assignments`), com `{ user_id, nome, grupo }`. Mesmo gate. Alimenta o picker. (Rótulo de grupo via a tag farmer/hunter/closer do #221.)

### 5. `useAccess` override (#221)

Quando `isImpersonating`, o `useAccess` resolve a persona a partir do perfil do **alvo** (via #3), não do master → menu lateral e route guards refletem o que o vendedor vê.

### 6. Hooks de leitura impersonation-aware

`useMyPositivacao`, `useMyMixGap`, `useMyVisitSuggestions`, `useMyCarteiraScores` (saúde fica de fora — admin-only):
- Quando `isImpersonating`: chamam a variante `_for(effectiveUserId)`.
- Senão: a RPC/consulta normal (comportamento atual, intocado).
- `queryKey` inclui `effectiveUserId` (cache não vaza entre alvos).
- **Nenhum write referencia `effectiveUserId`.**

### 7. Picker + banner (UI)

- **Picker:** card "Ver como…" no `MasterDashboard` (substitui o placeholder). Lista de #4, rótulo de grupo (farmer/hunter/closer).
- **Banner persistente** no topbar enquanto ativo: `👁 Vendo como **{target.nome}** (você é {realUser} · master) — somente leitura · [Sair]`. Impossível ignorar (o risco real é o master esquecer que está impersonando e decidir algo daquele contexto).

### 8. `impersonation_audit` (migration)

`actor_user_id, target_user_id, started_at, ended_at (nullable), reason (nullable), source`. RLS: insert/select master-only. Grava no `startImpersonation` (via RPC `log_impersonation_start`), atualiza `ended_at` no stop. **Loga o início, não cada query.**

## Fluxo de dados

```
Master abre MasterDashboard → card "Ver como…" → escolhe Regina
  → startImpersonation(Regina)
      → RPC log_impersonation_start(actor, target, reason, source) [audit]
      → ImpersonationContext.target = Regina; effectiveUserId = Regina.id
  → banner aparece no topbar
  → useAccess resolve persona de Regina (get_user_access_profile_for) → menu/guards de farmer
  → FarmerCalls: useMyPositivacao/useMyMixGap/... chamam *_for(Regina.id)
      → RPC valida master → escopa a Regina → devolve dados REAIS dela
  → master vê a tela exata da Regina, read-only
  → [Sair] → stopImpersonation() → ended_at no audit → volta ao master
```

## Segurança (o coração)

- **Fronteira = corpo da função.** RLS não protege dentro de `SECURITY DEFINER`. As `_for` validam master na 1ª linha e RAISE no forbidden.
- **Privilégio isolado** (Pattern B): editar uma RPC de vendedor no futuro não pode alargar acesso; toda função privilegiada é `grep _for(`.
- **Write-leak é o risco real, não bypass de auth.** A sessão continua a do master → todo write executa como master. Regra dura, defendida em profundidade:
  1. **Leitura** pode usar `effectiveUserId`; **escrita** SEMPRE usa `realUser.id` / default do banco (`created_by := auth.uid()`).
  2. UI de mutação **desabilitada** durante impersonação.
  3. **Teste/grep no CI** garantindo que nenhum payload de mutação referencia `effectiveUserId`.
- **Audit** explica depois quem viu os dados de quem (LGPD).
- **Codex review adversária** no gate antes do merge (como no #221).

## Pré-requisito: #221

A camada de layout/menu depende do resolver/matriz do #221. Passo 0 da implementação: trazer o #221 pra dia (conflitos prováveis em `App.tsx`/`AppShell.tsx`), CI verde, mergear **squash** (sem `--admin`). Mergear o #221 **liga as restrições de acesso por persona em prod** — mudança comportamental real; conferir a matriz antes.

## Testing

- **TDD nos puros:** derivação de `effectiveUserId`; override de persona no resolver quando impersonando.
- **Autorização nas RPCs `_for`:** não-master → exception; master → escopa ao alvo; target NULL → exception.
- **Anti-write-leak:** teste/grep que falha se um payload de mutação usa `effectiveUserId`.
- **Contrato preservado:** RPCs de vendedor seguem idênticas (sem regressão pro vendedor real).

## Rollout (Lovable)

Só migrations (SQL Editor) — **sem edge function**:
1. RPCs `_for` (mixgap + positivação) + internals compartilhados (se extrair).
2. `get_user_access_profile_for` + `list_impersonation_targets`.
3. Tabela `impersonation_audit` + RLS + `log_impersonation_start`.
Validação: cada bloco com `SELECT '... OK'`. Conferir que as RPCs de vendedor não mudaram.

## Riscos / decisões em aberto

- **#221 conflitos** — pode dar trabalho de rebase; é outra sessão (coordenar via `gh pr list`/`git worktree list` antes de tocar a branch dele).
- **`useMyVisitSuggestions`/`useMyCarteiraScores` usam `.in('farmer_id', [user.id, ...coveredIds])`** — o overlay troca `user.id` por `effectiveUserId`. Conferir no plano que a lógica de cobertura (férias) não conflita com a impersonação (impersonando a Regina, mostro a carteira dela + as coberturas dela, não as do master).
- **Audit em SPA** — `ended_at` depende de o master clicar "Sair". Se ele fechar a aba, `ended_at` fica null (aceitável; o `started_at` é o que importa pra governança).
