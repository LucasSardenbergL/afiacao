-- ============================================================================================================
-- 20261031142000_radar_kpis_conversao.sql — Radar de Clientes: o card "Viraram cliente (mês)" conta conversões.
-- Diário: docs/historico/radar-kpis-conversao.md.
--
-- Por quê (follow-up da 20261031111000, docs/historico/radar-contato-integridade.md): `radar_kpis.virou_cliente_mes`
-- contava `prospeccao_status = 'virou_cliente'` pelo carimbo `prospeccao_atualizado_em`. Dois defeitos:
--   1. O carimbo se move. O gestor tira um cliente de virou_cliente (RD007 deixa) e devolve num mês novo: a mesma
--      conversão conta de novo.
--   2. O vendedor que liga e descobre que o lead JÁ era cliente do Omie só vincula o cadastro existente
--      (`origem = 'lookup'` no ledger). Isso não é conversão, e inflava o card.
--
-- Decisão do founder (2026-10-31): conta quem AINDA está em virou_cliente, foi cadastrado no mês (data imutável
-- `omie_cadastrado_em`: só `radar_registrar_cadastro_omie` a grava, uma vez, com o vínculo vazio, e nada a limpa)
-- e foi CRIADO pelo Radar no Omie (linha `origem = 'incluir'` no ledger, a mesma regra de `v_criado_por_nos` do
-- cadastro). O resto do retorno não muda.
--
-- TRAVA → PRE (md5 exato ∈ {predecessor vivo, este}) → CREATE OR REPLACE → PÓS (corpo + atributos + ACL). O gate
-- `private.cap_radar_prospectar` da frente 2 é PRESERVADO. Prova: db/test-radar-kpis-conversao.sh (núcleo do CI).
-- ============================================================================================================

SET LOCAL lock_timeout = '5s';

-- ── TRAVA: ALTER sem efeito (a volatilidade VIVA), ANTES de ler o corpo ──────────────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_kpis()') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: public.radar_kpis() não existe — o predecessor de prod é obrigatório';
  END IF;
  ALTER FUNCTION public.radar_kpis() VOLATILE;
END
$trava$;

-- ── PRE: o corpo vivo é o predecessor revisado (psql-ro, 2026-10-31) ou já é este ───────────────────────────
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p WHERE p.oid = 'public.radar_kpis()'::regprocedure;
  IF v_vivo IS DISTINCT FROM 'de4e4731507e4be5a085c90efdfc0687' AND v_vivo IS DISTINCT FROM 'bbbb1546418e1876e7c913facc83de77' THEN
    RAISE EXCEPTION 'PRE FALHOU: public.radar_kpis() vivo tem md5 % (esperado o predecessor de4e4731507e4be5a085c90efdfc0687 ou este bbbb1546418e1876e7c913facc83de77) — reler o corpo de prod antes de reaplicar',
      v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.radar_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_lote text;
  v_novos integer;
  v_a_contatar integer;
  v_em_conversa integer;
  v_virou_mes integer;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;

  SELECT mes_referencia, COALESCE(novos, 0) INTO v_lote, v_novos
    FROM public.radar_ingest_state
   WHERE status = 'complete'
   ORDER BY mes_referencia DESC LIMIT 1;

  SELECT count(*) INTO v_a_contatar FROM public.radar_empresas
   WHERE prospeccao_status = 'a_contatar' AND ja_cliente = false
     AND (v_lote IS NULL OR ultimo_lote = v_lote);
  SELECT count(*) INTO v_em_conversa FROM public.radar_empresas
   WHERE prospeccao_status = 'em_conversa';
  -- Conversão do mês: ainda cliente, cadastrada no mês (data que não se move) e CRIADA pelo Radar no Omie. Vincular
  -- um cliente que já existia (origem 'lookup') não é conversão.
  SELECT count(*) INTO v_virou_mes FROM public.radar_empresas e
   WHERE e.prospeccao_status = 'virou_cliente'
     AND e.omie_cadastrado_em >= date_trunc('month', now(), 'America/Sao_Paulo')
     AND EXISTS (SELECT 1 FROM public.omie_cliente_confirmacoes c
                  WHERE c.account = 'oben' AND c.documento = e.cnpj
                    AND c.codigo_cliente = e.omie_codigo_cliente AND c.origem = 'incluir');

  RETURN jsonb_build_object(
    'lote', v_lote, 'novos', COALESCE(v_novos, 0),
    'a_contatar', v_a_contatar, 'em_conversa', v_em_conversa,
    'virou_cliente_mes', v_virou_mes);
END $function$;

REVOKE EXECUTE ON FUNCTION public.radar_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_kpis() TO authenticated, service_role;

-- ── PÓS: corpo (md5 exato), atributos e ACL ────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v record;
BEGIN
  SELECT md5(p.prosrc) AS md5, p.prosecdef, p.provolatile, p.proconfig,
         (SELECT count(*) FROM pg_catalog.pg_proc o WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) AS sobrecargas
    INTO v FROM pg_catalog.pg_proc p WHERE p.oid = 'public.radar_kpis()'::regprocedure;
  IF v.md5 IS DISTINCT FROM 'bbbb1546418e1876e7c913facc83de77' THEN
    RAISE EXCEPTION 'PÓS FALHOU: public.radar_kpis() ficou com md5 % (esperado bbbb1546418e1876e7c913facc83de77)', v.md5;
  END IF;
  IF NOT v.prosecdef OR v.provolatile <> 'v' OR v.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'PÓS FALHOU: public.radar_kpis() perdeu atributos (secdef %, vol %, config %)', v.prosecdef, v.provolatile, v.proconfig;
  END IF;
  IF v.sobrecargas <> 1 THEN
    RAISE EXCEPTION 'PÓS FALHOU: public.radar_kpis tem % sobrecargas (esperado 1)', v.sobrecargas;
  END IF;
  IF has_function_privilege('anon', 'public.radar_kpis()', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = 'public.radar_kpis()'::regprocedure AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', 'public.radar_kpis()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PÓS FALHOU: ACL de public.radar_kpis() (anon/PUBLIC não executam; authenticated executa)';
  END IF;

  RAISE NOTICE 'VALIDADO 20261031142000: radar_kpis conta a conversão do mês pelo cadastro criado pelo Radar';
END
$post$;
