-- ========================================================================
-- AUDIT — Custom Migrations
-- ========================================================================
--
-- Gerado por: scripts/audit-custom-migrations.ts
-- Total de custom migrations: 0
--
-- Como usar:
--   1. Abra o Supabase SQL Editor (via Lovable Cloud → Backend → SQL Editor)
--   2. Cole TODO este arquivo numa query
--   3. Run
--   4. Olhe as duas tabelas de resultado: (A) timestamps aplicados, (B) objetos existentes
--
-- Read-only — não altera nada no banco.
-- ========================================================================

-- =====================================================
-- SECTION 1: Timestamps aplicados (canonical check)
-- =====================================================
-- Source of truth do Supabase. Se a row existe aqui, a migration rodou.

WITH expected (version, slug, filename) AS (VALUES
)
SELECT
  e.version,
  e.slug,
  CASE WHEN sm.version IS NOT NULL THEN '✅ applied' ELSE '❌ MISSING — apply manually' END AS status,
  e.filename
FROM expected e
LEFT JOIN supabase_migrations.schema_migrations sm ON sm.version = e.version
ORDER BY e.version;


-- =====================================================
-- SECTION 2: Object existence (cross-check)
-- =====================================================
-- Caso schema_migrations diga ✅ mas o objeto não exista (rollback manual,
-- partial apply), esta query captura. Para cada objeto esperado, checa pg_catalog.

-- Nenhum objeto extraído. (Migrations só tiveram ALTER/UPDATE, não CREATE.)

-- ========================================================================
-- FIM
-- ========================================================================
