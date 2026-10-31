-- ============================================================================================================
-- 20261030233200_radar_amostra_vigente_leitura.sql — Radar de Clientes: a fila do vendedor passa a LER a amostra
-- de controle do sorteio vigente, para intercalá-la (1 a cada 10 posições, selo "amostra").
-- Diário: docs/historico/radar-amostra-na-fila.md. Antecedente: docs/historico/radar-score-backtest-e-placar.md.
--
-- Por quê: `radar_coorte_controle` (20261029150100) registrou topo (536) e amostra (50) da `coorte-2026-10`, mas
-- tem RLS sem policy e nenhum leitor para o front. Sem a tela mostrar a amostra, ninguém a contata e a comparação
-- topo × amostra nunca mede nada.
--
-- Desenho: UMA RPC de leitura, nova, SECURITY DEFINER, com o gate do Radar (`private.cap_radar_prospectar`, da
-- 20261029201200) — a tabela continua SEM policy (a RPC devolve só sorteio/grupo/cnpj/posicao da amostra, nunca a
-- nota do sorteio nem o topo). Só a amostra: o topo já aparece na fila pelo score, e 536+ linhas encostariam no
-- corte silencioso de 1.000 do PostgREST num sorteio futuro. "Vigente" = o sorteio registrado mais recente.
--
-- Caminho: `bun run db:aplicar` (a transação é do executor; o arquivo NÃO leva BEGIN/COMMIT). Objeto NOVO: nenhum
-- corpo vivo é reescrito, então não há TRAVA/PRE de anti-deriva; re-rodar recria o mesmo corpo e reemite a ACL.
-- Prova: db/test-radar-amostra-vigente.sh (núcleo do CI), com --falsificar.
-- ============================================================================================================

CREATE OR REPLACE FUNCTION public.radar_amostra_vigente()
 RETURNS TABLE (sorteio text, grupo text, cnpj text, posicao integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT k.sorteio, k.grupo, k.cnpj, k.posicao
    FROM public.radar_coorte_controle k
   WHERE k.grupo = 'amostra'
     AND k.sorteio = (SELECT v.sorteio FROM public.radar_coorte_controle v
                       ORDER BY v.sorteada_em DESC, v.sorteio DESC
                       LIMIT 1)
   ORDER BY k.posicao;
END
$function$;
COMMENT ON FUNCTION public.radar_amostra_vigente() IS
  'Radar: a amostra de controle do sorteio mais recente (sorteio, grupo, cnpj, posicao), para a fila intercalar. '
  'Gate: private.cap_radar_prospectar. Leitura pura. A tabela radar_coorte_controle segue sem policy.';

-- DROP+CREATE resetaria o ACL e o default do schema dá EXECUTE a anon/authenticated: as DUAS pontas, nomeadas.
REVOKE ALL ON FUNCTION public.radar_amostra_vigente() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_amostra_vigente() TO authenticated, service_role;
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT EXECUTE ON FUNCTION public.radar_amostra_vigente() TO claude_ro;
  END IF;
END
$acl$;

-- ── PÓS: a função existe no estado que a fila exige, e a tabela continua fechada ────────────────────────────
DO $post$
DECLARE
  v_fn regprocedure := to_regprocedure('public.radar_amostra_vigente()');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: public.radar_amostra_vigente() não existe — a fila não lê a amostra';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_amostra_vigente não é SECURITY DEFINER — sem policy, o vendedor leria 0 linhas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_fn AND p.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'P3 FALHOU: radar_amostra_vigente sem search_path fixo — SECURITY DEFINER sequestrável';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: ACL de radar_amostra_vigente errada — anon/PUBLIC executam ou authenticated não';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'public.radar_coorte_controle'::regclass)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.radar_coorte_controle'::regclass)
     OR has_table_privilege('anon', 'public.radar_coorte_controle', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.radar_coorte_controle', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'P5 FALHOU: radar_coorte_controle deixou de ser fechada — a leitura do front é só pela RPC';
  END IF;
  RAISE NOTICE 'radar_amostra_vigente: SECDEF, search_path fixo, ACL fechada; radar_coorte_controle segue sem policy';
END
$post$;
