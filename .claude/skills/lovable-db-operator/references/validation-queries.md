# Queries de validação por tipo de objeto

Toda mudança de banco sai com uma destas, pra provar — *depois* do Run no Lovable — que o objeto passou a existir. São read-only (só `SELECT`/`EXISTS`), seguras pra rodar quantas vezes quiser. O padrão é sempre retornar `✅` (existe) ou `❌ FALTANDO` (migration não pegou).

Todas usam `pg_catalog`/`information_schema`, que refletem o estado **real** do banco — não o que o repo *acha* que existe.

## Índice

- [Tabela](#tabela)
- [Coluna](#coluna)
- [Índice](#índice)
- [Função / RPC](#função--rpc)
- [Trigger](#trigger)
- [RLS policy](#rls-policy)
- [RLS habilitada na tabela](#rls-habilitada-na-tabela)
- [Enum value](#enum-value)
- [Constraint](#constraint)
- [View / materialized view](#view--materialized-view)
- [Cron job](#cron-job)
- [Extensão](#extensão)
- [Backfill / seed de dados](#backfill--seed-de-dados)
- [Validar vários objetos numa query só](#validar-vários-objetos-numa-query-só)

---

## Tabela

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = '<tabela>'
) THEN '✅ <tabela> existe' ELSE '❌ FALTANDO' END AS status;
```

## Coluna

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = '<tabela>' AND column_name = '<coluna>'
) THEN '✅ <tabela>.<coluna> existe' ELSE '❌ FALTANDO' END AS status;
```

Para confirmar também o tipo / nullability:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = '<tabela>' AND column_name = '<coluna>';
```

## Índice

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = '<idx_nome>'
) THEN '✅ <idx_nome> existe' ELSE '❌ FALTANDO' END AS status;
```

## Função / RPC

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '<funcao>'
) THEN '✅ <funcao>() existe' ELSE '❌ FALTANDO' END AS status;
```

Funções expostas como RPC pro PostgREST precisam de `GRANT EXECUTE` pro role certo — confirme:

```sql
SELECT grantee, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_schema = 'public' AND routine_name = '<funcao>';
```

### `CREATE OR REPLACE` de função: "existe" não é validação

Com `CREATE OR REPLACE`, a função **já existia** — o `EXISTS` acima passa mesmo que nada tenha sido aplicado. Valide o **corpo**, e ancore na **presença do código NOVO**, nunca na **ausência do texto antigo**:

```sql
-- ✅ ancora no que o fix INTRODUZIU
SELECT CASE WHEN (
  SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '<funcao>'
) ILIKE '%<identificador que só o corpo novo tem>%'
THEN '✅ corpo novo aplicado' ELSE '❌ ainda o corpo antigo' END AS status;
```

⚠️ **A armadilha (mordeu no #1357):** validar por `... NOT ILIKE '%<coluna_do_bug_antigo>%'` **mente**. `pg_get_functiondef` devolve o corpo **com os comentários**, e um fix bem documentado quase sempre explica o bug antigo citando o nome errado — então o grep casa a **própria explicação** e acusa `❌` numa função correta. É a regra anti-teatro da skill `prove-sql-money-path` aplicada à validação: *a sentinela nunca pode conter o texto que o próprio código emite*. Cuidado extra com substring: `t1_data_pedido` **contém** `data_pedido`, então mesmo sem comentário o `NOT ILIKE` daria falso-negativo.

Lá o erro caiu pro lado seguro (`❌` falso). No sentido inverso — grep que casa por acidente e diz `✅` — você declara aplicado algo que nunca rodou, que é exatamente a falha silenciosa que esta skill existe pra prevenir.

**A validação forte de função é por EXECUÇÃO, não por grep.** Rode via `psql-ro` a query que o corpo novo executa (ou a própria função, se o gate permitir) contra dado REAL e confira que (a) não estoura e (b) o número faz sentido:

```sql
-- prova que o caminho corrigido roda limpo e devolve valor plausível
SELECT <a expressão/agregação exata do corpo novo> FROM <fonte nova> WHERE <filtro do corpo novo>;
```

Se a função tem gate de staff (`SECURITY DEFINER` + `has_role`), o `claude_ro` não a executa — sem JWT, `auth.uid()` é NULL e ela levanta `42501` antes de chegar na lógica. Nesse caso execute **a query interna**, que é onde mora o `42703`/`42P01` que você quer descartar.

## Trigger

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_trigger tr
  JOIN pg_class c ON c.oid = tr.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND tr.tgname = '<trigger>' AND c.relname = '<tabela>'
) THEN '✅ <trigger> em <tabela>' ELSE '❌ FALTANDO' END AS status;
```

## RLS policy

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname = 'public' AND tablename = '<tabela>' AND policyname = '<policy>'
) THEN '✅ policy <policy>' ELSE '❌ FALTANDO' END AS status;
```

Listar todas as policies de uma tabela (útil pra conferir cobertura SELECT/INSERT/UPDATE/DELETE):

```sql
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = '<tabela>'
ORDER BY policyname;
```

## RLS habilitada na tabela

Criar policies não adianta se o RLS não está ligado. Confirme o flag:

```sql
SELECT CASE WHEN relrowsecurity THEN '✅ RLS ligada' ELSE '❌ RLS DESLIGADA — dados expostos' END AS status
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = '<tabela>';
```

## Enum value

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_enum en
  JOIN pg_type ty ON ty.oid = en.enumtypid
  JOIN pg_namespace n ON n.oid = ty.typnamespace
  WHERE n.nspname = 'public' AND ty.typname = '<enum_type>' AND en.enumlabel = '<valor>'
) THEN '✅ valor <valor> no enum <enum_type>' ELSE '❌ FALTANDO' END AS status;
```

Listar todos os valores atuais do enum:

```sql
SELECT enumlabel FROM pg_enum en
JOIN pg_type ty ON ty.oid = en.enumtypid
WHERE ty.typname = '<enum_type>' ORDER BY en.enumsortorder;
```

## Constraint

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.table_constraints
  WHERE table_schema = 'public' AND table_name = '<tabela>' AND constraint_name = '<constraint>'
) THEN '✅ <constraint> existe' ELSE '❌ FALTANDO' END AS status;
```

## View / materialized view

```sql
-- view comum
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.views
  WHERE table_schema = 'public' AND table_name = '<view>'
) THEN '✅ view existe' ELSE '❌ FALTANDO' END AS status;

-- materialized view
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = '<view>'
) THEN '✅ matview existe' ELSE '❌ FALTANDO' END AS status;
```

## Cron job

Requer extensão `pg_cron` (já usada no projeto — ver migrations `*_cron.sql`):

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = '<jobname>'
) THEN '✅ cron <jobname> agendado' ELSE '❌ FALTANDO' END AS status;
```

Ver detalhe do agendamento:

```sql
SELECT jobname, schedule, command, active FROM cron.job WHERE jobname = '<jobname>';
```

## Extensão

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_extension WHERE extname = '<extensao>'  -- ex.: 'vector', 'pg_cron', 'pg_net'
) THEN '✅ extensão ativa' ELSE '❌ FALTANDO' END AS status;
```

## Backfill / seed de dados

Mudança de **dados** (não de schema) não se valida com `EXISTS` — a linha pode já existir. Valide por **contagem** (bate com o esperado?) ou **amostra** (os dados certos apareceram?). O SQL do backfill em si deve ser idempotente (`INSERT … ON CONFLICT DO NOTHING`, `UPDATE … WHERE <col> IS NULL`).

```sql
-- contagem: quantas linhas o backfill deveria ter tocado/criado
SELECT count(*) AS total FROM public.<tabela> WHERE <condição do backfill>;
-- ex.: SELECT count(*) FROM public.tint_formulas WHERE fornecedor = 'Sayerlack';  -- esperado: 200

-- amostra: confere que os dados certos entraram
SELECT * FROM public.<tabela> WHERE <condição> ORDER BY created_at DESC LIMIT 5;

-- backfill de coluna: nenhuma linha viva pode ter ficado com o valor antigo/nulo
SELECT count(*) AS ainda_pendentes FROM public.<tabela> WHERE <coluna> IS NULL;
-- esperado: 0
```

---

## Validar vários objetos numa query só

Quando a migration cria um conjunto (tabela + índices + policies), valide tudo de uma vez com um `VALUES` + `LEFT JOIN`/`EXISTS` por linha. Espelha o padrão da **Section 2** de `scripts/audit-custom-migrations.sql` — qualquer linha com `❌` é o que faltou aplicar:

```sql
WITH esperado(kind, schema_name, object_name, parent_name) AS (VALUES
  ('table',     'public', '<tabela>',              ''),
  ('index',     'public', 'idx_<tabela>_<col>',    '<tabela>'),
  ('rls_policy','public', '<tabela>_select_staff', '<tabela>'),
  ('rls_policy','public', '<tabela>_master_all',   '<tabela>')
)
SELECT
  e.kind,
  e.schema_name || '.' || e.object_name AS objeto,
  CASE
    WHEN e.kind = 'table' AND EXISTS (
      SELECT 1 FROM information_schema.tables t
      WHERE t.table_schema = e.schema_name AND t.table_name = e.object_name) THEN '✅'
    WHEN e.kind = 'index' AND EXISTS (
      SELECT 1 FROM pg_indexes i
      WHERE i.schemaname = e.schema_name AND i.indexname = e.object_name) THEN '✅'
    WHEN e.kind = 'rls_policy' AND EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = e.schema_name AND p.tablename = e.parent_name
        AND p.policyname = e.object_name) THEN '✅'
    ELSE '❌'
  END AS status
FROM esperado e
ORDER BY status DESC, e.kind, e.object_name;
```

> Para o cross-check de **todas** as custom migrations do repo (não só a sua), o usuário pode colar `scripts/audit-custom-migrations.sql` inteiro — ele já tem Section 1 (timestamps em `schema_migrations`) + Section 2 (existência objeto-a-objeto). A query acima é a versão focada e rápida pro Run imediato.
