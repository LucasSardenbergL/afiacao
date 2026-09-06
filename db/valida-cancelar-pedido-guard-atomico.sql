-- Validação pós-apply de 20260905224959_cancelar_pedido_guard_atomico.sql — READ-ONLY.
-- Fonte ÚNICA: é este arquivo que vai no bloco de handoff do SQL Editor E o que o harness
-- db/test-cancelar-pedido-guard-atomico.sh roda nos dois sentidos (V1 verde com o corpo novo,
-- V2 vermelho com o corpo velho) — uma validação que nunca soube dizer "não aplicada" não
-- valida nada.
WITH f AS (
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'cancelar_pedido_sugerido'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_usuario text, p_justificativa text'
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM f)
    THEN 'FALTANDO - cancelar_pedido_sugerido(bigint,text,text) nao existe'
  WHEN (SELECT prosrc FROM f) !~ 'WHERE id = p_pedido_id[[:space:]]+AND status NOT IN'
    THEN 'NAO APLICADA - o guard de status NAO esta no WHERE do UPDATE (TOCTOU do #2204 segue aberto)'
  WHEN (SELECT prosecdef FROM f)
    THEN 'REGREDIU - a funcao virou SECURITY DEFINER (era INVOKER)'
  WHEN (SELECT proconfig::text FROM f) NOT LIKE '%search_path=public, pg_temp%'
    THEN 'REGREDIU - search_path nao esta preso em (public, pg_temp)'
  WHEN NOT has_function_privilege('authenticated', (SELECT oid FROM f), 'EXECUTE')
    THEN 'REGREDIU - authenticated perdeu EXECUTE (o botao Cancelar morreria)'
  ELSE 'OK - guard atomico no ar, INVOKER, search_path preso, authenticated executa'
END AS resultado;
