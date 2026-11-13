-- ============================================================
-- Radar — revisão 2026-11-11, O3b (itens 8 e 18)
--   item 8:  radar_meus_retornos — os retornos do vendedor (vencidos até hoje) paginados por vencimento. A agenda "Hoje"
--            mostra os 20 primeiros (radar_prospectar_hoje) e dizia "+N retornos além destes" sem lugar para lê-los.
--   item 18: intenção de contato pelo canal 'email' (o mailto da ficha não registrava nada): radar_registrar_intencao
--            e a constraint radar_eventos_intencao_forma aceitam 'email'.
-- Aplicação: bun run db:aplicar (o executor é a transação — sem BEGIN/COMMIT aqui). Idempotente.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito no objeto vivo que este arquivo recria (a volatilidade VIVA: VOLATILE).
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_registrar_intencao(text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_registrar_intencao(text, text) VOLATILE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo é o predecessor revisado (pacote M, md5 do prosrc medido em prod 2026-11-12) ou este. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.radar_registrar_intencao(text,text)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('108d88bad7b3dac38074748f76cede99', 'f30bef3d9fb3e7ff03630e6117bc48fa') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_intencao vivo (md5 %) não é o predecessor revisado nem este', v_vivo;
  END IF;
END
$pre$;

-- item 18: a constraint aceita 'email' (mesma forma: humano, com CNPJ).
ALTER TABLE public.radar_eventos DROP CONSTRAINT IF EXISTS radar_eventos_intencao_forma;
ALTER TABLE public.radar_eventos ADD CONSTRAINT radar_eventos_intencao_forma
  CHECK (evento <> 'intencao' OR (origem = 'humano' AND cnpj IS NOT NULL AND acao IN ('ligar', 'whatsapp', 'copiar', 'email')));

CREATE OR REPLACE FUNCTION public.radar_registrar_intencao(p_cnpj text, p_canal text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := (SELECT auth.uid());
  v_dia  date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_cnpj text := btrim(p_cnpj);
  v_n    integer;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  -- Revisão 2026-11-11 (item 18): 'email' — o mailto da ficha também é intenção de contato.
  IF p_canal IS NULL OR p_canal NOT IN ('ligar', 'whatsapp', 'copiar', 'email') THEN
    RAISE EXCEPTION 'canal invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF v_cnpj IS NULL OR v_cnpj = '' THEN
    RAISE EXCEPTION 'cnpj obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = v_cnpj) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'cnpj_desconhecido');
  END IF;

  -- 1 por vendedor, CNPJ, canal e dia: o painel conta leads com intenção, não toques repetidos no botão.
  INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, acao, fonte_id)
  VALUES ('intencao', 'humano', now(), v_uid, v_cnpj, p_canal,
          'intencao:' || v_uid || ':' || v_cnpj || ':' || p_canal || ':' || v_dia)
  ON CONFLICT (fonte_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'registrado', v_n = 1);
END
$fn$;

-- item 8: leitura paginada dos retornos.
CREATE OR REPLACE FUNCTION public.radar_meus_retornos(p_vendedor uuid DEFAULT NULL, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_alvo   uuid;
  v_hoje   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_limit  integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 100));
  v_offset integer := GREATEST(0, COALESCE(p_offset, 0));
  v_out    jsonb;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  v_alvo := COALESCE(p_vendedor, v_uid);
  IF v_alvo <> v_uid AND NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: retornos de outro vendedor exigem gestor' USING ERRCODE = '42501';
  END IF;

  -- A MESMA fonte e a MESMA ordem da agenda do card (radar_prospectar_hoje: vencimento, depois CNPJ), paginada:
  -- o "+N retornos além destes" da agenda passa a ter onde ser lido (revisão 2026-11-11, item 8).
  SELECT jsonb_build_object('total', count(*)::integer,
           'itens', COALESCE(jsonb_agg(jsonb_build_object('cnpj', r.cnpj, 'razao_social', r.razao_social,
                                         'nome_fantasia', r.nome_fantasia, 'municipio_nome', r.municipio_nome, 'uf', r.uf,
                                         'retorno_tipo', r.retorno_tipo, 'retorno_em', r.retorno_em, 'atrasado', r.atrasado,
                                         'nota', r.nota)
                                       ORDER BY r.retorno_em, r.cnpj)
                         FILTER (WHERE r.rn > v_offset AND r.rn <= v_offset + v_limit), '[]'::jsonb))
    INTO v_out
    FROM (SELECT x.*, row_number() OVER (ORDER BY x.retorno_em, x.cnpj) AS rn
            FROM private.radar_retornos_do_vendedor(v_alvo, v_hoje, now()) x) r;
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_meus_retornos(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_meus_retornos(uuid, integer, integer) TO authenticated;

-- PÓS: os dois corpos vivos são ESTES; a constraint aceita 'email' e está validada; a RPC nova fechada para anon.
DO $pos$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.radar_registrar_intencao(text,text)')) IS DISTINCT FROM 'f30bef3d9fb3e7ff03630e6117bc48fa' THEN
    RAISE EXCEPTION 'POS FALHOU: radar_registrar_intencao não é o corpo deste arquivo';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.radar_meus_retornos(uuid,integer,integer)')) IS DISTINCT FROM '74c02367257ddf05a8d35550980d8040' THEN
    RAISE EXCEPTION 'POS FALHOU: radar_meus_retornos ausente ou com outro corpo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                  WHERE c.conname = 'radar_eventos_intencao_forma' AND c.convalidated
                    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''email''%') THEN
    RAISE EXCEPTION 'POS FALHOU: radar_eventos_intencao_forma sem email ou não validada';
  END IF;
  IF has_function_privilege('anon', 'public.radar_meus_retornos(uuid,integer,integer)', 'execute')
     OR NOT has_function_privilege('authenticated', 'public.radar_meus_retornos(uuid,integer,integer)', 'execute') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL de radar_meus_retornos (anon não pode; authenticated pode)';
  END IF;
  RAISE NOTICE 'O3b ok: intencao com email, constraint validada, radar_meus_retornos fechado para anon';
END
$pos$;
