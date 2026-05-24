# Migrations Audit — Custom (não-UUID)

> Gerado por `scripts/audit-custom-migrations.ts`. Re-rodar quando custom migrations forem adicionadas: `bun scripts/audit-custom-migrations.ts`.

## Contexto

Per CLAUDE.md §5, **Lovable Cloud NÃO aplica automaticamente** migrations com nome custom (não-UUID) em `supabase/migrations/`. UUID-format (ex: `_868822bb-e38c-4fcf-8879-c64e48bd7630.sql`) são geradas pelo builder visual do Lovable e auto-rodam. Custom (ex: `_user_departments.sql`) ficam no repo mas precisam apply manual via Supabase SQL Editor.

Este audit valida **quais custom migrations estão de fato aplicadas no banco**.

## Como rodar

1. Abra **Supabase Dashboard** (via Lovable Cloud → Backend → Open Supabase, ou direto via `https://supabase.com/dashboard/project/fzvklzpomgnyikkfkzai`)
2. **SQL Editor** → **New query**
3. Cole TODO o conteúdo de `scripts/audit-custom-migrations.sql`
4. **Run** (read-only, não altera nada)
5. Você verá DUAS tabelas:
   - **Section 1** — timestamps em `supabase_migrations.schema_migrations` (source of truth do Supabase)
   - **Section 2** — existência objeto-a-objeto via `pg_catalog`/`information_schema`
6. Filtre linhas com `❌` → essas são as migrations que precisam apply manual

## Resumo

- **0** custom migrations totais
- **0** objetos esperados (criados por estas migrations)
- Quebra por tipo:

## Inventário por migration

Lista canônica do que cada migration *deveria* criar (extraído via regex de `CREATE TABLE`/`CREATE INDEX`/etc — não é parser SQL completo). Use junto com Section 2 do SQL pra cruzar com a realidade.

## Próximos passos quando algo der `❌`

1. Abra a migration correspondente em `supabase/migrations/<arquivo>.sql`
2. Copie o SQL inteiro
3. Supabase SQL Editor → cole → Run
4. Re-rode `scripts/audit-custom-migrations.sql` pra confirmar que virou `✅`
5. (Opcional) `INSERT INTO supabase_migrations.schema_migrations (version, statements) VALUES ('<timestamp>', ARRAY['<sql>']);` pra registrar como aplicada (evita re-apply futura)
