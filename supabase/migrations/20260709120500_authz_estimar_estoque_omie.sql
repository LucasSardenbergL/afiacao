-- ============================================================
-- P2 authz — restaura o gate de autorização em fin_estimar_estoque_omie (SECURITY DEFINER)
-- ------------------------------------------------------------
-- REGRESSÃO (achado 2026-07-08, "authz contract" do PR0.3 self-service):
--   A P1 (20260525020001_fin_rpc_gate_auth_p1) adicionou gate no corpo desta RPC
--   SECURITY DEFINER. O feed (20260528150000_fin_estoque_omie_feed) recriou a
--   função — nova fonte inventory_position(saldo×cmc) — SEM replicar o gate.
--   CREATE OR REPLACE "a última a recriar vence" → o gate sumiu e o vazamento
--   reabriu: `anon EXECUTE=false` (negado por grant) mas `authenticated EXECUTE=true`
--   e o corpo SEM gate → qualquer customer autenticado chama
--   fin_estimar_estoque_omie('oben'|'colacor'|'colacor_sc') e lê o CAPITAL
--   IMOBILIZADO em estoque (Σ saldo×cmc a custo) das 3 empresas — dado sensível.
--   Confirmado em PROD via psql-ro em 2026-07-09 (prosecdef=t, sem gate no corpo).
--
-- FIX: reintroduz o gate como PRIMEIRA instrução do corpo (ANTES da validação de
--   empresa — não vaza a distinção válida/inválida a não-autorizado). Corpo
--   (inventory_position saldo×cmc) PRESERVADO verbatim do estado atual de PROD.
--   Gate: service_role OR pode_ver_carteira_completa(auth.uid())
--     * pode_ver_carteira_completa = master OU employee gerencial/estrategico/
--       super_admin. Barra customer E employee não-gerencial (vendedor/separador).
--       Menor privilégio p/ dado a custo; consistente com a RPC-irmã do mesmo
--       cockpit financeiro (medir_abaixo_piso_tier usa o mesmo gate).
--     * service_role preservado: backend trust; nenhuma automação usa a RPC hoje
--       (a edge fin-cashflow-engine lê a TABELA fin_estoque_valor, não a RPC), mas
--       o grant service_role existe e o gate o honra p/ não regredir automação futura.
--     * COALESCE(...,false): auth.role()/uid() podem ser NULL → sem COALESCE o
--       `IF NOT (NULL)` não entra no THEN = fail-OPEN. (Defesa em profundidade:
--       mesmo se o grant a anon vazasse, o gate barra — auth.uid() NULL →
--       has_role(NULL,...) = false → pode_ver_carteira_completa = false.)
--     * DECISÃO (revisão Codex xhigh 2026-07-09): apertado de fin_user_can_access
--       (P1, granular por-empresa) p/ pode_ver_carteira_completa. Além do menor
--       privilégio, ELIMINA um bug de canonicalização do gate P1: fin_user_can_access
--       recebia p_company CRU enquanto a query normaliza com lower(trim) → dado sujo
--       em fin_permissoes.empresas (' OBEN ') divergiria autorização×leitura. O gate
--       por auth.uid() não recebe p_company → superfície some. Consumidor legítimo
--       (ConfigCashflowDialog é isMaster-only) não quebra.
--
-- Idempotente: CREATE OR REPLACE preservando assinatura, RETURNS TABLE e GRANTs
--   (NÃO mexe em GRANT — Supabase concede em runtime; re-grant reabriria superfície).
-- Prova: db/test-authz-estimar-estoque-omie.sh (PG17 — positivo master/service_role/
--   employee-gerencial · negativo customer/employee-comum/anon · defesa-em-profundidade ·
--   falsificação: remover o gate → customer vaza; afrouxar p/ employee → comum vaza).
-- ============================================================

CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p_company text)
 RETURNS TABLE(valor_estimado numeric, cobertura_pct numeric, skus_total integer, skus_com_custo integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_account text;
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(public.pode_ver_carteira_completa(auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil financeiro' USING ERRCODE = '42501';
  END IF;

  v_account := CASE lower(trim(p_company))
                 WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos'
               END;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'fin_estimar_estoque_omie: empresa invalida %', p_company USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    WITH canon AS (
      SELECT ip.saldo, ip.cmc FROM public.inventory_position ip
       WHERE ip.account = v_account AND ip.saldo > 0
    )
    SELECT
      COALESCE(SUM(CASE WHEN cmc > 0 THEN saldo * cmc ELSE 0 END), 0)::numeric,
      CASE WHEN COUNT(*) = 0 THEN 0::numeric
           ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE cmc > 0) / COUNT(*), 2) END,
      COUNT(*)::int, COUNT(*) FILTER (WHERE cmc > 0)::int
    FROM canon;
END;
$function$;
