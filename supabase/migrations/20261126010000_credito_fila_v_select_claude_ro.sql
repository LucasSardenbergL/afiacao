-- ============================================================
-- Crédito-IA PR 6a (follow-up): o papel de diagnóstico read-only `claude_ro` volta a LER a view
-- credito_fila_v. A 20261125230000 fechou o ACL da view por allowlist e revogou também o SELECT
-- dele, enquanto as 4 tabelas-base o mantêm (medido na 2ª testemunha, 2026-11-26: f na view, t nas
-- tabelas). Sem efeito no produto (o gestor lê pela RLS); só o psql-ro precisava ler as bases.
--
-- Só GRANT SELECT (nada de escrita). Idempotente. Sem o papel (PG local/CI) → no-op declarado.
-- Prova PG17: db/test-credito-fila.sh (E10, com o papel criado no prelúdio).
-- Reversão: REVOKE SELECT ON public.credito_fila_v FROM claude_ro.
-- ============================================================

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT SELECT ON public.credito_fila_v TO claude_ro;
  ELSE
    RAISE NOTICE 'claude_ro ausente: GRANT não se aplica neste banco';
  END IF;
END
$grant$;

-- Postcondição: com o papel, lê a view e não escreve nela; marcador positivo de fim.
DO $pos$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    IF NOT has_table_privilege('claude_ro', 'public.credito_fila_v', 'SELECT') THEN
      RAISE EXCEPTION 'POS FALHOU: claude_ro sem SELECT em credito_fila_v';
    END IF;
    IF has_table_privilege('claude_ro', 'public.credito_fila_v', 'INSERT')
       OR has_table_privilege('claude_ro', 'public.credito_fila_v', 'UPDATE')
       OR has_table_privilege('claude_ro', 'public.credito_fila_v', 'DELETE') THEN
      RAISE EXCEPTION 'POS FALHOU: claude_ro escreve em credito_fila_v';
    END IF;
  END IF;
  IF has_table_privilege('anon', 'public.credito_fila_v', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: anon lê credito_fila_v';
  END IF;
  RAISE NOTICE 'POS OK: credito_fila_v legível pelo claude_ro (diagnóstico), sem escrita';
END
$pos$;
