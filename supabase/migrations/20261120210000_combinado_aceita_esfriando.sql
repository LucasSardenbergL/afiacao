-- ============================================================
-- combinado_registrar aceita o tipo 'esfriando' (Leva 2 do Meu dia do CEO, 2026-11-20).
--
-- Por quê: o Combinado do dia passa a sugerir, além de cobrança e recompra, o cliente que comprou nos
-- últimos 12 meses e está há mais de 90 dias sem comprar. O ledger (combinado_dia) precisa registrar o
-- item com o tipo verdadeiro: gravar 'esfriando' como 'recompra' falsificaria o sensor.
--
-- Só muda a lista de tipos válidos e a mensagem de erro. Gate master, validação de vendedora, upsert por
-- (dia, vendedora) e ACL ficam iguais. CREATE OR REPLACE preserva o ACL; REVOKE/GRANT reemitidos por defesa.
--
-- Molde TRAVA → PRE → CREATE → PÓS. Sem BEGIN/COMMIT: aplica por `bun run db:aplicar` (a transação é do
-- executor). Prova: db/test-combinado-dia.sh (PG17, com falsificação).
-- ============================================================

-- TRAVA: ALTER sem efeito (volatilidade VIVA = VOLATILE) antes de ler o corpo, na mesma transação.
DO $trava$
BEGIN
  IF to_regprocedure('public.combinado_registrar(uuid,jsonb)') IS NOT NULL THEN
    ALTER FUNCTION public.combinado_registrar(uuid, jsonb) VOLATILE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo é o da migration 20261120200000 (md5 medido na PROD em 2026-11-20) ou já é este.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.combinado_registrar(uuid,jsonb)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('732af57ae769603b1df32c7d28afbb44', '26ec6d09f2fce9012611f21e413fef87') THEN
    RAISE EXCEPTION 'PRE FALHOU: combinado_registrar vivo (md5 %) nao e o predecessor revisado nem este', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.combinado_registrar(p_vendedora uuid, p_itens jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_it  jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'forbidden: combinado_registrar exige master' USING ERRCODE = '42501';
  END IF;
  IF p_vendedora IS NULL OR NOT (public.has_role(p_vendedora, 'employee'::public.app_role)
                                 OR public.has_role(p_vendedora, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'vendedora invalida (nao e staff)' USING ERRCODE = '22023';
  END IF;
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'itens: array de 1 a 3' USING ERRCODE = '22023';
  END IF;
  FOR v_it IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    IF jsonb_typeof(v_it) <> 'object' OR COALESCE(v_it ->> 'tipo', '') NOT IN ('cobranca', 'recompra', 'esfriando')
       OR COALESCE(v_it ->> 'cliente_ref', '') = '' THEN
      RAISE EXCEPTION 'item invalido: exige tipo (cobranca|recompra|esfriando) e cliente_ref' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.combinado_dia (dia, master_id, vendedora_id, itens)
  VALUES ((now() AT TIME ZONE 'America/Sao_Paulo')::date, v_uid, p_vendedora, p_itens)
  ON CONFLICT (dia, vendedora_id) DO UPDATE
    SET itens = EXCLUDED.itens,
        master_id = EXCLUDED.master_id,
        n_copias = public.combinado_dia.n_copias + 1,
        atualizado_em = now();
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.combinado_registrar(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.combinado_registrar(uuid, jsonb) TO authenticated;

-- PÓS: o corpo vivo é ESTE, e o ACL segue fechado ao anon e aberto ao authenticated.
DO $pos$
DECLARE
  f text := 'public.combinado_registrar(uuid,jsonb)';
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(f))
       IS DISTINCT FROM '26ec6d09f2fce9012611f21e413fef87' THEN
    RAISE EXCEPTION 'POS FALHOU: corpo de % nao e o desta migration', f;
  END IF;
  IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL de % errado', f;
  END IF;
END
$pos$;
