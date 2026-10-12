-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  VALIDAÇÃO PÓS-APPLY — 20260718160000_fu7_wa_owner_efetivo_gate_staff.sql     ║
-- ║  🟣 Lovable → SQL Editor → cola → Run (READ-ONLY: não escreve nada)           ║
-- ║                                                                              ║
-- ║  Prova por EFEITO, não pelo texto do catálogo. Validar `pg_get_functiondef`   ║
-- ║  com ILIKE é frágil — o Postgres RE-SERIALIZA o corpo e a busca textual dá    ║
-- ║  falso-negativo (mordeu 2× no PR-2/#1308). Aqui a gente CHAMA a função sob    ║
-- ║  as 3 identidades que importam e compara o VALOR retornado.                   ║
-- ║                                                                              ║
-- ║  Este arquivo é exercitado pelo próprio harness PG17                          ║
-- ║  (db/test-fu7-wa-owner-efetivo-gate.sh, assert V1) → o que você cola é        ║
-- ║  exatamente o que foi testado.                                               ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

DROP TABLE IF EXISTS _val_fu7;
CREATE TEMP TABLE _val_fu7 (ordem int, veredito text, o_que_prova text);

DO $$
DECLARE
  v_alvo uuid; v_dono uuid; v_cust uuid; v_staff uuid;
  r_customer uuid; r_staff uuid; r_service uuid;
BEGIN
  -- alvo: qualquer par (cliente, dono) elegível de verdade
  SELECT customer_user_id, owner_user_id INTO v_alvo, v_dono
    FROM public.carteira_assignments WHERE eligible LIMIT 1;
  SELECT user_id INTO v_cust  FROM public.user_roles WHERE role = 'customer' LIMIT 1;
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'master'   LIMIT 1;

  -- ⚠️ pg_catalog.set_config QUALIFICADO de propósito: existe um wrapper
  -- public.set_config que só aceita 'fin.%' e daria RAISE aqui.
  PERFORM pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  r_customer := public.wa_owner_efetivo(v_alvo);

  PERFORM pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  r_staff := public.wa_owner_efetivo(v_alvo);

  PERFORM pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r_service := public.wa_owner_efetivo(v_alvo);

  PERFORM pg_catalog.set_config('request.jwt.claims', '', true);  -- limpa

  INSERT INTO _val_fu7 VALUES
    (1, CASE WHEN r_customer IS NULL           THEN '✅ OK' ELSE '❌ FALHOU' END,
        'customer NAO extrai mais o UUID do vendedor (era o furo)'),
    (2, CASE WHEN r_staff   IS NOT DISTINCT FROM v_dono THEN '✅ OK' ELSE '❌ FALHOU' END,
        'staff AINDA le → ring-all da telefonia (IncomingCallModal) intacto'),
    (3, CASE WHEN r_service IS NOT DISTINCT FROM v_dono THEN '✅ OK' ELSE '❌ FALHOU' END,
        'service_role AINDA le → push de WhatsApp da vendedora intacto');
END $$;

SELECT veredito, o_que_prova FROM _val_fu7 ORDER BY ordem;
