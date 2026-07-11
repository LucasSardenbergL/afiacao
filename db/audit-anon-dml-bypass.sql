-- Detecção de DML-bypass via views ATUALIZÁVEIS acessíveis a anon/authenticated.
-- Fonte ÚNICA compartilhada por:
--   • db/audit-anon-dml-bypass.sh      (prod, via psql-ro — auditoria on-demand)
--   • db/test-audit-anon-dml-bypass.sh (PG17 local — prova o DENTE desta query)
-- Cada linha ofensora sai prefixada com 'HIT|' → o .sh filtra por isso e ignora as tags
-- 'SET' que o psqlrc-ro (SESSION READ ONLY) ecoa no stdout. Ver docs/agent/database.md.
WITH upd_views AS (
  SELECT c.oid, c.relname, COALESCE(array_to_string(c.reloptions,','),'') AS opts
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
  JOIN information_schema.views iv ON iv.table_schema='public' AND iv.table_name=c.relname
  WHERE c.relkind='v' AND (iv.is_updatable='YES' OR iv.is_insertable_into='YES')
),
roles(rolname) AS (VALUES ('anon'),('authenticated')),
vetor1 AS (  -- invoker OFF: DML roda como owner=postgres → bypassa a RLS da base
  SELECT v.relname AS view, r.rolname AS role, 'INVOKER_OFF (bypassa RLS como owner)' AS motivo
  FROM upd_views v CROSS JOIN roles r
  WHERE v.opts !~* 'security_invoker=(on|true)'
    AND (has_table_privilege(r.rolname, v.oid,'INSERT')
      OR has_table_privilege(r.rolname, v.oid,'UPDATE')
      OR has_table_privilege(r.rolname, v.oid,'DELETE'))
),
vetor2 AS (  -- invoker ON mas a tabela-base NÃO tem RLS → nada barra o DML do role
  SELECT DISTINCT v.relname AS view, r.rolname AS role, 'BASE_SEM_RLS: '||t.relname AS motivo
  FROM upd_views v
  JOIN pg_rewrite rw ON rw.ev_class=v.oid
  JOIN pg_depend d   ON d.objid=rw.oid AND d.classid='pg_rewrite'::regclass
  JOIN pg_class t    ON t.oid=d.refobjid AND t.relkind IN ('r','p') AND t.oid<>v.oid
  CROSS JOIN roles r
  WHERE v.opts ~* 'security_invoker=(on|true)'
    AND NOT t.relrowsecurity
    AND (has_table_privilege(r.rolname, v.oid,'INSERT')
      OR has_table_privilege(r.rolname, v.oid,'UPDATE')
      OR has_table_privilege(r.rolname, v.oid,'DELETE'))
)
SELECT 'HIT|'||view||' | '||role||' | '||motivo AS line
FROM ( SELECT * FROM vetor1 UNION ALL SELECT * FROM vetor2 ) x
ORDER BY line;
