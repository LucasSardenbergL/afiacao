-- ============================================================
-- cobranca_regua_hoje: nome do cliente pela MESMA fonte da fila
-- Objetivo: QA pós-Publish da Frente B (2026-11-01) — a régua mostrava "cliente 8689697854" em TODAS as
-- linhas: lia `fin_contas_receber.nome_cliente`, que está NULL nas 14.511 linhas da Oben. A fila não sofre
-- porque passa por `v_ciclo_cliente_resumo` (nomes = título → profiles.name via mapa → omie_clientes_nao_vinculados).
-- Esta migration faz a RPC coalescer pelas mesmas três fontes, nessa ordem. Medido na prod antes do apply:
-- régua Oben de hoje = 35 linhas → 0 pelo título, 30 por profiles, 5 por não-vinculados.
-- Molde "recriar objeto VIVO": TRAVA → PRE (anti-deriva) → CREATE OR REPLACE → ACL → PÓS.
-- Sem BEGIN/COMMIT: a transação é do executor (`bun run db:aplicar`). Idempotente (re-aplicar = mesmo estado).
-- Diário: docs/historico/oben-frente-b-pedido-cobranca-cet.md (seção "QA visual logado pós-Publish").
-- ============================================================

SELECT pg_advisory_xact_lock(hashtext('public.cobranca_regua_hoje'));

-- PRE: só substituo a versão que conheço (a do 20261031210000) ou a minha própria (re-apply). Outra = deriva → aborta.
DO $pre$
DECLARE
  v_def text := pg_get_functiondef('public.cobranca_regua_hoje(text)'::regprocedure);
BEGIN
  IF v_def NOT LIKE '%r.company, r.omie_codigo_cliente, r.nome_cliente, r.omie_codigo_lancamento,%'
     AND v_def NOT LIKE '%nome_resolvido%' THEN
    RAISE EXCEPTION 'PRE FALHOU: cobranca_regua_hoje na prod nao e a versao do 20261031210000 nem esta — outra sessao recriou; nao sobrescrever as cegas';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.cobranca_regua_hoje(p_company text)
RETURNS TABLE (
  marco text, company text, omie_codigo_cliente bigint, nome_cliente text,
  omie_codigo_lancamento bigint, numero_documento text, data_vencimento date, saldo numeric,
  telefone text, dona_user_id uuid, caso_id uuid, estado text, pode_agir boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_gestao boolean;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'cobranca_regua_hoje: exige staff' USING ERRCODE = '42501';
  END IF;
  IF p_company IS NULL OR p_company NOT IN ('oben', 'colacor', 'colacor_sc') THEN
    RAISE EXCEPTION 'cobranca_regua_hoje: empresa invalida' USING ERRCODE = '22023';
  END IF;
  v_gestao := coalesce(private.pode_ver_carteira_completa(v_uid), false);

  RETURN QUERY
  WITH tit AS (
    SELECT CASE WHEN r.data_vencimento = v_hoje + 2 THEN 'D-2'
                WHEN r.data_vencimento = v_hoje - 1 THEN 'D+1'
                WHEN r.data_vencimento = v_hoje - 7 THEN 'D+7' END AS marco,
           r.company, r.omie_codigo_cliente, r.nome_cliente, r.omie_codigo_lancamento,
           coalesce(nullif(btrim(r.numero_documento_fiscal), ''), nullif(btrim(r.numero_documento), '')) AS numero_documento,
           r.data_vencimento, r.saldo
      FROM public.fin_contas_receber r
     WHERE r.company = p_company
       AND r.saldo > 0
       AND ((r.data_vencimento = v_hoje + 2 AND r.status_titulo IN ('A VENCER', 'VENCE HOJE'))
            OR (r.data_vencimento < v_hoje AND r.status_titulo IN ('ATRASADO', 'A VENCER', 'VENCE HOJE')))
       AND r.data_vencimento IN (v_hoje + 2, v_hoje - 1, v_hoje - 7)
  ),
  com_dona AS (
    SELECT t.*, public.cobranca_dona(t.company, t.omie_codigo_cliente) AS dona,
           (SELECT nullif(btrim(pf.phone), '') FROM public.omie_customer_account_map m
              JOIN public.profiles pf ON pf.user_id = m.user_id
             WHERE m.account = t.company AND m.omie_codigo_cliente = t.omie_codigo_cliente
             ORDER BY pf.updated_at DESC NULLS LAST LIMIT 1) AS telefone,
           -- nome_resolvido: as MESMAS três fontes de `v_ciclo_cliente_resumo` (fila), na mesma ordem.
           coalesce(
             nullif(btrim(t.nome_cliente), ''),
             (SELECT max(nullif(btrim(p.name), '')) FROM public.omie_customer_account_map m
                JOIN public.profiles p ON p.user_id = m.user_id
               WHERE m.account = t.company AND m.omie_codigo_cliente = t.omie_codigo_cliente),
             (SELECT max(coalesce(nullif(btrim(u.nome_fantasia), ''), nullif(btrim(u.razao_social), '')))
                FROM public.omie_clientes_nao_vinculados u
               WHERE u.empresa = t.company AND u.omie_codigo_cliente = t.omie_codigo_cliente)
           ) AS nome_resolvido
      FROM tit t
  )
  SELECT d.marco, d.company, d.omie_codigo_cliente, d.nome_resolvido, d.omie_codigo_lancamento, d.numero_documento,
         d.data_vencimento, d.saldo, d.telefone, d.dona, c.id, c.estado, (v_gestao OR d.dona = v_uid)
    FROM com_dona d
    LEFT JOIN public.cobranca_caso c ON c.company = d.company AND c.omie_codigo_cliente = d.omie_codigo_cliente AND c.fechado_em IS NULL
   WHERE v_gestao OR d.dona = v_uid
   ORDER BY CASE d.marco WHEN 'D+7' THEN 0 WHEN 'D+1' THEN 1 ELSE 2 END, d.saldo DESC;
END;
$fn$;
-- REPLACE preserva o ACL, mas reemito nomeando as roles (regra da casa: REVOKE nas DUAS pontas).
REVOKE ALL ON FUNCTION public.cobranca_regua_hoje(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cobranca_regua_hoje(text) TO authenticated, service_role;

-- PÓS: a versão nova está no catálogo e o ACL ficou fechado.
DO $post$
DECLARE
  v_reg oid := to_regprocedure('public.cobranca_regua_hoje(text)');
  v_def text;
BEGIN
  IF v_reg IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: cobranca_regua_hoje sumiu';
  END IF;
  v_def := pg_get_functiondef(v_reg);
  IF v_def NOT LIKE '%nome_resolvido%' OR v_def NOT LIKE '%omie_clientes_nao_vinculados%' THEN
    RAISE EXCEPTION 'P2 FALHOU: a RPC nao e a versao com nome_resolvido — a regua seguiria sem nome';
  END IF;
  IF has_function_privilege('anon', v_reg, 'EXECUTE') OR has_function_privilege('public', v_reg, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_reg, 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: ACL de cobranca_regua_hoje (anon/public devem estar fechados; authenticated aberto)';
  END IF;
  RAISE NOTICE 'cobranca_regua_hoje recriada com nome_resolvido (titulo -> profiles.name -> omie_clientes_nao_vinculados); ACL conferido';
END
$post$;
