-- ============================================================================================
-- 20261010204708 · omie_cota_metodo — trava compartilhada por (conta, método) do Omie
-- Prova: db/test-omie-cota-metodo.sh (PG17: funções reais, concorrência, REVOKE, falsificação)
-- Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md §3.6.1 (Fase 0.2)
--
-- O QUE: o Omie trava o MÉTODO por app_key. Duas chamadas simultâneas do mesmo método na mesma
-- conta → "Já existe uma requisição desse método"; repetir cedo demais → "Consumo redundante
-- detectado. Aguarde N segundos (REDUNDANT)"; insistir → "API bloqueada por consumo indevido"
-- (~30 min, incidente do recebimento de 2026-07-16). Hoje cada edge que chama `ListarPedidos`
-- (vendas-sync, sync-reprocess, desconto-backfill, picking) decide sozinha, e o picking vai somar
-- mais um consumidor. Esta tabela é o ponto de encontro: antes de chamar, a edge pede a vez
-- (`omie_cota_tentar`, lease curto com token); ao terminar, devolve (`omie_cota_liberar`); se o
-- Omie mandar esperar, registra o prazo (`omie_cota_registrar_fault`) e TODOS respeitam.
--
-- O QUE NÃO É: limite de taxa. Só serializa e propaga o "aguarde" do próprio Omie. A edge que
-- não consegue falar com a trava NÃO chama o Omie (fail-closed, revisão Codex): adia, como já
-- adia um rate-limit. Só `ListarPedidos` (leitura) é coordenado — nenhum método de escrita.
--
-- SEGURANÇA: tabela com RLS e sem policy; tabela e funções fechadas para PUBLIC, anon e
-- authenticated. Só o service_role (as edges) usa. SECURITY INVOKER: quem chama precisa do grant.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação.
-- Idempotente. ORDEM DO DEPLOY: esta migration ANTES das edges — edge nova sem a RPC NÃO lista
-- pedidos (fail-closed).
-- ============================================================================================

CREATE TABLE IF NOT EXISTS public.omie_cota_metodo (
  conta            text        NOT NULL CHECK (conta IN ('oben', 'colacor')),
  metodo           text        NOT NULL CHECK (metodo ~ '^[A-Za-z]{1,80}$'),
  ocupado_ate      timestamptz,
  ocupado_por      text,
  bloqueado_ate    timestamptz,
  ultimo_fault     text,
  ultimo_fault_em  timestamptz,
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conta, metodo),
  CONSTRAINT omie_cota_metodo_lease_coerente CHECK ((ocupado_ate IS NULL) = (ocupado_por IS NULL))
);

ALTER TABLE public.omie_cota_metodo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.omie_cota_metodo FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.omie_cota_metodo TO service_role;

COMMENT ON TABLE public.omie_cota_metodo IS
  'Trava compartilhada por (conta, método) do Omie: lease de quem está chamando e o "aguarde" que o Omie mandou. Só service_role. Ver migration 20261010204708.';

-- --------------------------------------------------------------------------------------------
-- omie_cota_tentar: pede a vez. Devolve UMA linha:
--   ok=true,  motivo='livre'     → pode chamar; `ate` = fim do lease (renovável pelo mesmo token)
--   ok=false, motivo='bloqueado' → o Omie mandou esperar até `ate`; não chame antes
--   ok=false, motivo='ocupado'   → outra edge está chamando até `ate` (no máximo)
-- Bloqueio vence lease: nem o dono do lease chama durante um "aguarde".
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.omie_cota_tentar(
  p_conta text,
  p_metodo text,
  p_token text,
  p_lease_segundos integer
)
 RETURNS TABLE (ok boolean, motivo text, ate timestamptz)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
DECLARE
  v_agora timestamptz;
  v_linha public.omie_cota_metodo%ROWTYPE;
BEGIN
  IF p_conta IS NULL OR p_conta NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'omie_cota_tentar: conta inválida (%)', p_conta USING ERRCODE = '22023';
  END IF;
  IF p_metodo IS NULL OR p_metodo !~ '^[A-Za-z]{1,80}$' THEN
    RAISE EXCEPTION 'omie_cota_tentar: método inválido (%)', p_metodo USING ERRCODE = '22023';
  END IF;
  IF p_token IS NULL OR length(p_token) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'omie_cota_tentar: token inválido' USING ERRCODE = '22023';
  END IF;
  IF p_lease_segundos IS NULL OR p_lease_segundos NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'omie_cota_tentar: lease fora de 1..300 s (%)', p_lease_segundos USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.omie_cota_metodo (conta, metodo)
  VALUES (p_conta, p_metodo)
  ON CONFLICT (conta, metodo) DO NOTHING;

  SELECT * INTO v_linha
    FROM public.omie_cota_metodo c
   WHERE c.conta = p_conta AND c.metodo = p_metodo
   FOR UPDATE;

  -- relógio DEPOIS do lock: quem esperou a trava compara com o agora real, não com o início da
  -- transação (now() congelado faria um lease recém-vencido parecer vivo, ou o contrário).
  v_agora := clock_timestamp();

  IF v_linha.bloqueado_ate IS NOT NULL AND v_linha.bloqueado_ate > v_agora THEN
    RETURN QUERY SELECT false, 'bloqueado'::text, v_linha.bloqueado_ate;
    RETURN;
  END IF;

  IF v_linha.ocupado_ate IS NOT NULL AND v_linha.ocupado_ate > v_agora
     AND v_linha.ocupado_por IS DISTINCT FROM p_token THEN
    RETURN QUERY SELECT false, 'ocupado'::text, v_linha.ocupado_ate;
    RETURN;
  END IF;

  UPDATE public.omie_cota_metodo c
     SET ocupado_ate   = v_agora + make_interval(secs => p_lease_segundos),
         ocupado_por   = p_token,
         atualizado_em = v_agora
   WHERE c.conta = p_conta AND c.metodo = p_metodo;

  RETURN QUERY SELECT true, 'livre'::text, v_agora + make_interval(secs => p_lease_segundos);
END;
$function$;

-- --------------------------------------------------------------------------------------------
-- omie_cota_liberar: devolve a vez. Só o dono do token libera; devolve se liberou.
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.omie_cota_liberar(
  p_conta text,
  p_metodo text,
  p_token text
)
 RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.omie_cota_metodo c
     SET ocupado_ate   = NULL,
         ocupado_por   = NULL,
         atualizado_em = clock_timestamp()
   WHERE c.conta = p_conta AND c.metodo = p_metodo
     AND c.ocupado_por IS NOT DISTINCT FROM p_token
     AND p_token IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$function$;

-- --------------------------------------------------------------------------------------------
-- omie_cota_registrar_fault: o Omie mandou esperar. O prazo só AUMENTA (GREATEST) — um "aguarde
-- 5 s" que chega depois não encurta um bloqueio de 30 min já registrado.
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.omie_cota_registrar_fault(
  p_conta text,
  p_metodo text,
  p_bloqueio_segundos integer,
  p_fault text
)
 RETURNS timestamptz
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
DECLARE
  v_agora timestamptz := clock_timestamp();
  v_ate   timestamptz;
BEGIN
  IF p_conta IS NULL OR p_conta NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'omie_cota_registrar_fault: conta inválida (%)', p_conta USING ERRCODE = '22023';
  END IF;
  IF p_metodo IS NULL OR p_metodo !~ '^[A-Za-z]{1,80}$' THEN
    RAISE EXCEPTION 'omie_cota_registrar_fault: método inválido (%)', p_metodo USING ERRCODE = '22023';
  END IF;
  IF p_bloqueio_segundos IS NULL OR p_bloqueio_segundos NOT BETWEEN 1 AND 7200 THEN
    RAISE EXCEPTION 'omie_cota_registrar_fault: bloqueio fora de 1..7200 s (%)', p_bloqueio_segundos
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.omie_cota_metodo AS c (conta, metodo, bloqueado_ate, ultimo_fault, ultimo_fault_em, atualizado_em)
  VALUES (p_conta, p_metodo, v_agora + make_interval(secs => p_bloqueio_segundos),
          left(p_fault, 300), v_agora, v_agora)
  ON CONFLICT (conta, metodo) DO UPDATE
     SET bloqueado_ate   = GREATEST(c.bloqueado_ate, EXCLUDED.bloqueado_ate),
         ultimo_fault    = EXCLUDED.ultimo_fault,
         ultimo_fault_em = EXCLUDED.ultimo_fault_em,
         atualizado_em   = EXCLUDED.atualizado_em
  RETURNING c.bloqueado_ate INTO v_ate;

  RETURN v_ate;
END;
$function$;

REVOKE ALL ON FUNCTION public.omie_cota_tentar(text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_cota_liberar(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_cota_registrar_fault(text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omie_cota_tentar(text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_cota_liberar(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_cota_registrar_fault(text, text, integer, text) TO service_role;

-- --------------------------------------------------------------------------------------------
-- Postcondição: o estado final é o desenhado, ou a transação inteira aborta.
-- --------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_fn text;
BEGIN
  -- As funções são INVOKER sobre tabela com RLS e SEM policy: só funcionam porque o service_role
  -- tem BYPASSRLS (medido em prod 2026-10-10). Sem isso, toda chamada da trava falharia e as edges
  -- (fail-closed) parariam de listar pedidos — melhor abortar aqui.
  IF NOT coalesce((SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role'), false) THEN
    RAISE EXCEPTION 'POSTCONDICAO: service_role sem BYPASSRLS — a trava não funcionaria';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'omie_cota_metodo') THEN
    RAISE EXCEPTION 'POSTCONDICAO: omie_cota_metodo ganhou policy — o desenho é RLS sem policy (só service_role)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.omie_cota_metodo'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDICAO: omie_cota_metodo sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.omie_cota_metodo', 'SELECT')
     OR has_table_privilege('authenticated', 'public.omie_cota_metodo', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICAO: omie_cota_metodo legível por anon/authenticated';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.omie_cota_tentar(text, text, text, integer)',
    'public.omie_cota_liberar(text, text, text)',
    'public.omie_cota_registrar_fault(text, text, integer, text)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: % executável por anon/authenticated', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: % sem EXECUTE para service_role', v_fn;
    END IF;
  END LOOP;
END
$post$;
