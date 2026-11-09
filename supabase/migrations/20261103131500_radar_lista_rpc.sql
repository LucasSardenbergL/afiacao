-- ============================================================
-- Radar — leitor 4 do Mini, parte 3: a lista do /radar (com ou sem busca) passa por uma RPC
-- SECURITY DEFINER, para a busca por texto usar o GIN trigrama em vez de seq scan de radar_empresas.
--
-- Medido em prod (2026-11-03 13:03 UTC, com a tela em uso depois do Publish do #3552): seq_scan de
-- radar_empresas 49 → 71 só com a busca, e 0 leituras de idx_radar_empresas_busca_trgm. A causa:
-- radar_empresas tem RLS (radar_empresas_select_gestor) e o operador do ILIKE (`texticlike`) não é
-- LEAKPROOF — sob RLS o planejador não aceita qual não-leakproof como condição de índice, então para
-- `authenticated` toda busca (razão/fantasia e município) vira Parallel Seq Scan dos 731 MB. A prova da
-- parte 2 (20261103100100) e a 2ª testemunha rodaram como papéis que ignoram RLS (dono / claude_ro com
-- rolbypassrls) e aprovaram um plano que o app nunca recebe. Reproduzido em PG17: dono → Bitmap Index
-- Scan no trgm; SET ROLE authenticated → Seq Scan.
--
-- A RPC roda como dono (bypassa RLS, o FORCE está desligado) e devolve as MESMAS linhas que o
-- `useRadarLista` pedia ao PostgREST: o gate é o predicado da policy (cap_radar_prospectar) e os
-- filtros são os do hook, um a um. SQL dinâmico com USING: cada chamada é planejada com os valores
-- (o padrão do LIKE vira constante), e só entram os predicados do recorte pedido — sem o
-- `(p IS NULL OR …)` que forçaria um plano único para todos os recortes.
--
-- Função NOVA no molde TRAVA → PRE → CREATE → PÓS (PRE: ausente ou este corpo). Arquivo para
-- `bun run db:aplicar` (sem BEGIN/COMMIT). Prova PG17 sob SET ROLE authenticated: db/test-radar-lista-rpc.sh.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade viva) se a função já existir.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer) STABLE;
  END IF;
END
$trava$;

-- PRE: ausente ou EXATAMENTE este corpo; e nenhuma outra sobrecarga com o nome (o PostgREST não
-- escolheria entre elas).
DO $pre$
DECLARE
  v_md5 text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                  WHERE p.oid = to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer)'));
BEGIN
  IF v_md5 IS NOT NULL AND v_md5 <> '3da72da3d39522f93c00caf2db270998' THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_lista viva (md5 %) não é este corpo', v_md5;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'radar_lista'
                AND p.oid IS DISTINCT FROM to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer)')) THEN
    RAISE EXCEPTION 'PRE FALHOU: existe outra sobrecarga de public.radar_lista';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.radar_lista(
  p_busca text DEFAULT NULL,
  p_municipio text DEFAULT NULL,
  p_uf text DEFAULT NULL,
  p_ufs text[] DEFAULT NULL,
  p_cnae_exato text DEFAULT NULL,
  p_cnae_prefixo text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_incluir_ja_clientes boolean DEFAULT false,
  p_ultimo_lote text DEFAULT NULL,
  p_primeira_vista_min timestamptz DEFAULT NULL,
  p_sugeridos_lote text DEFAULT NULL,
  p_sugeridos_score_min numeric DEFAULT NULL,
  p_com_telefone boolean DEFAULT false,
  p_com_contato boolean DEFAULT false,
  p_data_abertura_min date DEFAULT NULL,
  p_data_abertura_max date DEFAULT NULL,
  p_ordem text DEFAULT 'score',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 50)
 RETURNS SETOF public.radar_empresas
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_w text[] := ARRAY[]::text[];
BEGIN
  -- O mesmo gate da policy radar_empresas_select_gestor: quem não lê a tabela não lê a RPC.
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  -- Entrada mal formada contaria ZERO em silêncio (ou abriria a ordenação a SQL): grita.
  IF p_ordem IS NULL OR p_ordem NOT IN ('score', 'capital_social', 'data_abertura') THEN
    RAISE EXCEPTION 'ordem inválida' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'paginação inválida' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_exato IS NOT NULL AND p_cnae_exato !~ '^[0-9]{7}$' THEN
    RAISE EXCEPTION 'cnae_exato inválido' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_prefixo IS NOT NULL AND p_cnae_prefixo !~ '^[0-9]{1,6}$' THEN
    RAISE EXCEPTION 'cnae_prefixo inválido' USING ERRCODE = '22023';
  END IF;
  IF (p_ultimo_lote IS NOT NULL AND p_ultimo_lote !~ '^[0-9]{4}-[0-9]{2}$')
     OR (p_sugeridos_lote IS NOT NULL AND p_sugeridos_lote !~ '^[0-9]{4}-[0-9]{2}$') THEN
    RAISE EXCEPTION 'lote inválido' USING ERRCODE = '22023';
  END IF;
  IF p_sugeridos_lote IS NOT NULL AND p_sugeridos_score_min IS NULL THEN
    RAISE EXCEPTION 'sugeridos sem limiar de score' USING ERRCODE = '22023';
  END IF;
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido' USING ERRCODE = '22023';
  END IF;

  -- Busca (razão OU fantasia) e município: o termo já chega sanitizado pelo front
  -- (sanitizeForPostgrestOr). Termo sem conteúdo (só espaço) = sem filtro, como o front faz com o vazio.
  IF private.padrao_like_contem(p_busca) IS NOT NULL THEN
    v_w := array_append(v_w, $w$(e.razao_social ILIKE private.padrao_like_contem($1) ESCAPE '\' OR e.nome_fantasia ILIKE private.padrao_like_contem($1) ESCAPE '\')$w$);
  END IF;
  IF private.padrao_like_contem(p_municipio) IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.municipio_nome ILIKE private.padrao_like_contem($2) ESCAPE '\'$w$);
  END IF;
  -- UF escolhida vence a região.
  IF p_uf IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.uf = $3$w$);
  ELSIF p_ufs IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.uf = ANY ($4)$w$);
  END IF;
  IF p_cnae_exato IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.cnae_principal = $5$w$);
  ELSIF p_cnae_prefixo IS NOT NULL THEN
    v_w := array_append(v_w, $w$starts_with(e.cnae_principal, $6)$w$);
  END IF;
  -- "Só sugeridos" = o predicado do card (filtrarSugeridos): fixa lote/status/já-cliente, vence os de baixo.
  IF p_sugeridos_lote IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.ultimo_lote = $11 AND e.prospeccao_status = 'em_conversa' AND e.ja_cliente = false
      AND e.omie_codigo_cliente IS NULL AND (e.rfb_situacao IS NULL OR e.rfb_situacao = '02')
      AND e.cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$' AND e.score >= $12$w$);
  ELSE
    IF p_status IS NOT NULL THEN
      v_w := array_append(v_w, $w$e.prospeccao_status = $7$w$);
    ELSE
      v_w := array_append(v_w, $w$e.prospeccao_status <> 'descartado'$w$);
    END IF;
    IF NOT COALESCE(p_incluir_ja_clientes, false) THEN
      v_w := array_append(v_w, $w$e.ja_cliente = false$w$);
    END IF;
    IF p_ultimo_lote IS NOT NULL THEN
      v_w := array_append(v_w, $w$e.ultimo_lote = $9$w$);
    END IF;
  END IF;
  IF p_primeira_vista_min IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.primeira_vista_em >= $10$w$);
  END IF;
  IF COALESCE(p_com_telefone, false) THEN
    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL)$w$);
  END IF;
  IF COALESCE(p_com_contato, false) THEN
    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL OR e.email IS NOT NULL)$w$);
  END IF;
  IF p_data_abertura_min IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.data_abertura >= $15$w$);
  END IF;
  IF p_data_abertura_max IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.data_abertura <= $16$w$);
  END IF;

  RETURN QUERY EXECUTE format(
    $q$SELECT e.* FROM public.radar_empresas e WHERE %s ORDER BY e.%I DESC NULLS LAST, e.cnpj LIMIT $17 OFFSET $18$q$,
    array_to_string(v_w, ' AND '), p_ordem)
  USING p_busca, p_municipio, p_uf, p_ufs, p_cnae_exato, p_cnae_prefixo, p_status, p_incluir_ja_clientes,
        p_ultimo_lote, p_primeira_vista_min, p_sugeridos_lote, p_sugeridos_score_min, p_com_telefone,
        p_com_contato, p_data_abertura_min, p_data_abertura_max, p_limit, p_offset;
END
$function$;

REVOKE ALL ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer) TO authenticated;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer)');
BEGIN
  -- P1: a função viva é ESTE corpo (md5 exato do prosrc), SECURITY DEFINER e STABLE.
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) IS DISTINCT FROM '3da72da3d39522f93c00caf2db270998' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_lista viva não é o corpo deste arquivo';
  END IF;
  IF NOT (SELECT p.prosecdef AND p.provolatile = 's' FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_lista não é SECURITY DEFINER STABLE';
  END IF;
  -- P2: ACL — authenticated executa; PUBLIC e anon não (as duas pontas).
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL de radar_lista errado (anon/PUBLIC executam ou authenticated não)';
  END IF;
  -- P3: o dono da função ignora o RLS de radar_empresas (senão a busca volta ao seq scan e, pior,
  -- a RPC leria pela policy do DONO). FORCE desligado e dono = dono da tabela ou com BYPASSRLS.
  IF (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'public.radar_empresas'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
                     WHERE p.oid = v_oid
                       AND (r.rolbypassrls OR p.proowner = (SELECT c.relowner FROM pg_catalog.pg_class c
                                                             WHERE c.oid = 'public.radar_empresas'::regclass))) THEN
    RAISE EXCEPTION 'P3 FALHOU: o dono de radar_lista não ignora o RLS de radar_empresas';
  END IF;
  -- P4: o índice que a busca vai usar existe e é válido.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                  WHERE i.indexrelid = to_regclass('public.idx_radar_empresas_busca_trgm') AND i.indisvalid) THEN
    RAISE EXCEPTION 'P4 FALHOU: idx_radar_empresas_busca_trgm ausente ou inválido';
  END IF;
  RAISE NOTICE 'radar_lista: SECURITY DEFINER, ACL fechado a anon/PUBLIC, dono fora do RLS, trgm válido';
END
$post$;
