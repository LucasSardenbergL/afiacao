# Fix: injeção PostgREST via período do DRE (omie-financeiro) — Design Spec

> **Data:** 2026-05-25
> **Status:** achado de segurança + integridade financeira, validado em revisão adversária com o Codex. Helper puro com TDD espelhado verbatim no Deno (disciplina §FinanceiroProgram).

## Problema

`supabase/functions/omie-financeiro/index.ts`, actions `calcular_dre`/`calcular_dre_year`:

1. `ano`/`mes`/`meses` vêm do **body JSON** (linha ~1665) sem coerção numérica (`targetAno = ano || ...`, `targetMeses = meses ? meses : [mes]`). O tipo TS `ano: number` **não é enforced em runtime no Deno**.
2. Viram `inicioMes`/`fimMes` por interpolação crua e entram no **`.or()`** do `calcularDRE` (linhas 1235/1249):
   ```ts
   .or(`and(data_recebimento.gte.${inicioMes},data_recebimento.lt.${fimMes}),...`)
   ```
3. Body `{"action":"calcular_dre","mes":"01),or(id.gte.0"}` quebra o `and(...)` e injeta filtro PostgREST.

**Severidade: Média-Alta de integridade** (não crítica). Dimensionada com o Codex:
- Client é **service_role** (RLS bypassed), mas exige **caller autenticado** (`validateCaller`: staff/master/service_role/cron).
- `.eq("company", company)` ANDa por fora do `.or()` e o supabase-js encoda o valor → **isolamento de empresa se mantém**, sem cross-tenant nem escape pra outra tabela. Pior caso de leitura = alargar a janela de data dentro da própria empresa.
- **O peso real:** `calcularDRE` faz **`upsert` em `fin_dre_snapshots`** (linha ~1400) e engole erros de query (`data ?? []`) → um período malformado pode **persistir DRE incorreta/zerada silenciosamente** em money-path.
- Bônus: bug latente `ano + 1` (concat de string em dezembro se `ano` vier string).

Viola o padrão §9b do próprio projeto (nunca interpolar input cru no `.or()`), do lado servidor onde a regra ESLint não alcança.

## Solução

Helper puro **`src/lib/financeiro/dre-period.ts`** (TDD em vitest), **espelhado verbatim no Deno**:
- `validateAno`/`validateMes`: exigem **inteiro** (`Number.isInteger`, sem `Math.trunc` — `1.9` não vira janeiro silenciosamente) no intervalo (ano 2000-2100, mes 1-12).
- `resolveDrePeriod`: campo **ausente** → default contratado (ano/mês corrente); campo **presente e inválido** → `DrePeriodError`.
- `meses` (array) tem precedência sobre `mes`; vazio/não-array → throw.

Contrato de erro (decisão do Codex — **THROW, não fallback silencioso**, porque em money-path errar ruidosamente é melhor que gravar período errado): `DrePeriodError` → **HTTP 400** no catch do handler.

**Dois chokepoints** (também recomendação do Codex):
1. **Boundary** (`calcular_dre`/`calcular_dre_year`): `resolveDrePeriod`/`validateAno` → 400 em input inválido.
2. **`calcularDRE`** (entrada): re-assert `validateAno`/`validateMes` — ponto money-path reutilizável que compõe o `.or()` cru; protege qualquer caller futuro e fecha o bug de dezembro.

## Validação

- `src/lib/financeiro/__tests__/dre-period.test.ts` — 15 casos (válido, ausente→default, presente-inválido→throw incl. strings de injeção, float, fora de range, array com elemento ruim). Verde.
- `deno check` no edge function: **mesmo erro-set antes/depois** (10 erros pré-existentes de tipagem frouxa em código não-tocado; zero introduzidos).
- Lint do helper/test: exit 0.

## Deploy (manual, §5)

Edge function lê do repo na branch main → após o merge, **redeploy do `omie-financeiro` via chat do Lovable** (prompt no corpo do PR). Sem o redeploy, a validação não entra em produção.

## Follow-ups (sweep do Codex — fora do escopo deste PR, documentados)

- `company`/`companies` sem allow-list runtime contra `["oben","colacor","colacor_sc"]`.
- `validateCaller` é role-scoped, não **tenant-scoped** (se staff devesse ser limitado por empresa, é mais sério que o `.or()`).
- `maxPages`/`filtro_data_de`/`filtro_data_ate`/`requestedRegime` sem validação estrita.
- Tratar `error` em **todas** as queries do DRE (não transformar falha de DB em DRE vazia silenciosa).

## Out-of-scope

- Os follow-ups acima; reescrever a tipagem frouxa pré-existente do arquivo.
