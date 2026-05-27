-- Corrige o 403 "permission denied for materialized view" que quebrava a view
-- security_invoker `v_sugestao_negociacao_ativa` (badge da sidebar + páginas de
-- negociação paralela) para TODO usuário autenticado (inclusive master).
--
-- Causa-raiz: a matview `mv_sku_ranking_negociacao_paralela` foi DELIBERADAMENTE
-- revogada de anon/authenticated em 2026-05-10 (migrations 20260510223800 /
-- 20260510235956) para não expor o ranking de compras na API. Mas a view
-- `v_sugestao_negociacao_ativa` é `security_invoker=on` e faz LEFT JOIN com a
-- matview só para puxar `categoria` → o invoker (qualquer staff) tenta ler a
-- matview com os próprios privilégios e leva 403.
--
-- Fix (recomendação Codex): mover a matview para um schema `private` NÃO exposto
-- pelo PostgREST. Assim o invoker pode receber GRANT SELECT (a view volta a
-- funcionar e a RLS das tabelas-base segue valendo), mas a matview continua
-- inacessível via /rest/v1 direto (schema não roteado) — preservando a decisão
-- de segurança original. Nenhuma config do Supabase precisa mudar (PostgREST só
-- expõe `public`/`graphql_public` por padrão).

-- 1. Schema privado.
CREATE SCHEMA IF NOT EXISTS private;

-- 2. Move a matview (idempotente). Os índices (incl. o UNIQUE exigido pelo
--    REFRESH ... CONCURRENTLY) seguem junto automaticamente.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'mv_sku_ranking_negociacao_paralela'
      AND n.nspname = 'public'
      AND c.relkind = 'm'
  ) THEN
    ALTER MATERIALIZED VIEW public.mv_sku_ranking_negociacao_paralela SET SCHEMA private;
  END IF;
END $$;

-- 3. A view `v_sugestao_negociacao_ativa` (security_invoker) referencia a matview
--    por OID, então SEGUE o move automaticamente — não precisa recriar. O invoker
--    (authenticated) só precisa de USAGE no schema + SELECT na matview privada.
--    Como `private` não é exposto pelo PostgREST, isso NÃO permite GET direto em
--    /rest/v1/mv_sku_ranking_negociacao_paralela.
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT SELECT ON private.mv_sku_ranking_negociacao_paralela TO authenticated;

-- 4. Função de REFRESH (SECURITY DEFINER) referenciava `public.mv_...` qualificado
--    → recria apontando para `private.mv_...` (corpo verbatim, só o schema muda).
CREATE OR REPLACE FUNCTION public.refresh_sku_ranking_negociacao()
RETURNS TABLE(skus_ranqueados integer, atualizado_em timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private'
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY private.mv_sku_ranking_negociacao_paralela;
  RETURN QUERY SELECT COUNT(*)::int, now() FROM private.mv_sku_ranking_negociacao_paralela;
END;
$$;

-- 5. Geradora `sugerir_negociacao_paralela_hoje` referencia `mv_...` NÃO-qualificado
--    no corpo → adiciona `private` ao search_path (sem recriar o corpo longo).
--    `public` permanece primeiro: todas as outras tabelas continuam resolvendo de
--    public; só a matview (que agora só existe em private) resolve de private.
ALTER FUNCTION public.sugerir_negociacao_paralela_hoje(text, integer)
  SET search_path TO 'public', 'private';

-- 6. Read-RPC staff-guard para o ranking. O front-end lia a matview DIRETO
--    (também 403 desde o revoke); como a matview agora é privada, a leitura passa
--    por este RPC SECURITY DEFINER (mesmo gate das funções irmãs). Definer lê a
--    matview privada; authenticated só recebe EXECUTE.
CREATE OR REPLACE FUNCTION public.get_sku_ranking_negociacao_paralela(p_empresa text DEFAULT 'OBEN')
RETURNS SETOF private.mv_sku_ranking_negociacao_paralela
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'private'
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT *
    FROM private.mv_sku_ranking_negociacao_paralela
    WHERE empresa = p_empresa
    ORDER BY score_final DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_sku_ranking_negociacao_paralela(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sku_ranking_negociacao_paralela(text) TO authenticated;
