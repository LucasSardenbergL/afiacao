# Check de CI anti-regressão de gate em RPCs SECURITY DEFINER sensíveis

**Data:** 2026-07-09 · **Autor:** Claude + Codex (consult high) · **Origem:** chip `task_fc0cc5bd`, follow-up do PR #1264.

## Problema

Padrão de bug recorrente (3×): uma migration faz `CREATE OR REPLACE` de uma função `SECURITY DEFINER` financeira e **omite o gate de autorização** que uma migration anterior tinha posto — "a última a recriar vence" → vazamento silencioso (customer lê custo/preço/estoque). Ocorrências: 5 views (#1246), `get_tint_prices`, `fin_estimar_estoque_omie` (#1264, o feed 28/mai derrubou o gate da P1).

## Abordagem (decisão eu + Codex consult)

**C — estático no CI (bloqueante) + PG17 local opcional.** Não sobe Postgres no CI (o bug é "texto SQL recriado sem gate"; o detector barato é ler o texto que entra no repo). Segue o padrão dos scripts `bun` que parseiam migrations (`audit-custom-migrations.ts`, `wt-preflight-migration.ts`) e reusa `scripts/lib/migration-objects.ts`.

## Componentes

1. **`scripts/authz-manifest.ts`** — manifest **explícito por função** (não "qualquer gate global"):
   ```ts
   { 'function:public.fin_estimar_estoque_omie(text)': {
       sensitive: true,
       requiredGate: { anyOf: [{ call: 'pode_ver_carteira_completa' }] } },
     'function:public.get_preco_cockpit(jsonb)': {
       sensitive: true,
       requiredGate: { allOf: [{ call: 'has_role', roles: ['employee','master'] }, { call: 'pode_ver_carteira_completa' }] } },
     ... as 8 seed ... }
   ```
2. **`scripts/lib/authz-contract.ts`** — parser (heurístico, como o `migration-objects.ts`): extrai cada `CREATE [OR REPLACE] FUNCTION` com o **corpo dollar-quoted**, remove comentários (`--`, `/* */`) e mascara string-literais, detecta `SECURITY DEFINER` e o toque em **tabela sensível**. Expõe `extractFunctionDefs(sql)` e `hasGate(body, requiredGate)`.
3. **`scripts/authz-gate-check.ts`** — orquestra:
   - **Parte A (regressão):** para **toda** recriação (em qualquer migration) de função no manifest, o corpo deve satisfazer o `requiredGate`. Ausência do gate → falha nomeando a migration. (O feed teria falhado.)
   - **Parte B (cobertura):** computa o **estado final** (`last-writer-wins` por chave) das funções em `supabase/migrations/`. Toda `SECURITY DEFINER` cujo corpo final toca tabela sensível e **não está no manifest** → falha pedindo classificação.
4. **`ci.yml`** — step `bun run authz:check` no job `validate` (bloqueante); `package.json` script.
5. **Testes vitest** (`scripts/lib/authz-contract.test.ts`, `scripts/authz-gate-check.test.ts`) — estilo `mutcheck`: o check **falha** quando o bug é plantado.

## Guard-shape (rigor do Codex)

O gate conta como presente quando a chamada da função-gate aparece no **corpo executável** (fora de comentário/string) **em forma de bloqueio** — heurística `deny-if-false`: um `IF … NOT … <gate>( … ) … THEN … RAISE`. Não casa a **mensagem** de erro (elas variam: `Acesso negado`/`Apenas staff`/`42501`/`P0001`), nem chamada solta (`PERFORM`) sem decidir acesso. Chave por `schema + nome + assinatura` (pega overload).

**Prioridade de calibração:** minimizar **falso-negativo** (bloquear PR legítimo). Se a chamada do gate está presente no corpo executável mas a forma-de-bloqueio exata não casa, o check ainda bloqueia só na **ausência** da chamada (o bug real = remoção); forma estranha vira sinal, não bloqueio. Isso é validado pelos testes plantados.

## Tabelas sensíveis (seed)

`inventory_position`, `product_costs`, `sku_estoque_atual`, `cost_price`, e colunas `cmc`/`custo`/`preco`/`unit_price` no corpo. Lista extensível no manifest.

## Fora do escopo da v1 (→ v2 / audit-prod) — documentado no cabeçalho dos scripts

- `SET search_path` seguro em SECDEF sensível (risco de hijack).
- `GRANT/REVOKE`/PUBLIC-default (SECDEF sem grant pode ser executável por PUBLIC).
- Tabela sensível via **view/helper/SQL dinâmico** (não aparece como toque direto).
- `ALTER FUNCTION` / `DROP FUNCTION` no cômputo do estado final.
- Enfraquecimento das **próprias funções-gate** (`pode_ver_carteira_completa` etc.).
- **Audit read-only periódico em PROD** — o CI prova o repo, não o PROD (hotfix manual / drift do Lovable / snapshot stale ficam fora). Complemento, não substituto.

## Endurecimentos (2 rodadas de challenge Codex)

O challenge adversarial do diff achou **10 falsos-negativos** (cada um vira falsa sensação de segurança), todos fechados com teste que planta o furo:

- **Guard-shape real, não presença:** o gate só conta se estiver NEGADO levando a `RAISE EXCEPTION` — `NOT [schema.]gate(` direto ou dentro do grupo balanceado de um `NOT ( … )` (via `balancedParens`, não janela fixa). Rejeita gate decorativo (`v := gate()`), guard invertido (`NOT v_disabled AND gate()`, `NOT (x IS NULL) AND gate()`) e `RAISE NOTICE`. Sem falso-positivo em gate verboso.
- **Comentários removidos antes de parsear:** `-- AS $x$…$x$` e `CREATE FUNCTION` comentado não enganam mais o matcher.
- **Parser cobre:** quoted identifiers, corpo single-quoted, `SECURITY DEFINER` depois do `AS`.
- **Fail-closed:** `CREATE FUNCTION` não-extraível (ex.: `BEGIN ATOMIC`) carrega o texto bruto; se for SECDEF sensível → erro, não passa em silêncio.
- **Parte B por assinatura:** overload sensível não some.

**Limitação assumida (v1):** é heurística de TEXTO. O alvo é a **regressão acidental** (um dev recria a função e esquece o gate), não evasão deliberada — uma migration maliciosa passa por review humano, e nenhum matcher estático de texto vence um atacante determinado. O complemento é o audit read-only periódico em PROD (fora do CI).

## Prova

`bun run test` (vitest) com casos plantados: (a) função do manifest recriada **sem** o gate → check falha nomeando a migration; (b) gate só em comentário → não conta; (c) função nova SECDEF tocando `inventory_position` fora do manifest → falha; (d) as 8 reais gateadas → passa. Rodar o check contra o repo real deve sair **verde** (estado atual). Depois: Codex challenge do diff.
