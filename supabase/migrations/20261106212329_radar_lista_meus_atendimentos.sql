-- ============================================================
-- Radar, pacote B2 ("Meus atendimentos"): radar_lista ganha p_so_meus boolean DEFAULT false (22º argumento,
-- POR CIMA da assinatura de 21 do pacote C, 20261106175800). Com true, a lista devolve só os leads com
-- atendimento ABERTO e NÃO EXPIRADO cujo dono é auth.uid() — o mesmo conjunto que radar_atendimentos_ativos()
-- marca com eh_meu. O filtro é NO SERVIDOR, antes da paginação: filtrar os 50 carregados no front dá falso vazio.
--
-- O parâmetro novo vai NO FIM e com DEFAULT false: a chamada de antes devolve o mesmo. Assinatura nova = DROP da
-- antiga + CREATE (uma sobrecarga só, senão o PostgREST acusa ambiguidade); o DROP reseta o ACL, que é reemitido
-- nomeando as roles (o de prod: authenticated e service_role; anon e PUBLIC sem EXECUTE).
--
-- Molde TRAVA → PRE → DROP+CREATE → REVOKE/GRANT → PÓS. Predecessora = corpo de prod de 2026-11-06 (psql-ro, md5 do
-- prosrc 2cb7ad507c9079b27ff43176da438212 = o corpo do pacote C). Arquivo para `bun run db:aplicar` (sem
-- BEGIN/COMMIT; para colar no SQL Editor, envolva em BEGIN; … COMMIT;). Prova PG17: db/test-radar-meus-atendimentos.sh.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) nas duas assinaturas (a de antes e a deste arquivo).
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text) STABLE;
  END IF;
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean) STABLE;
  END IF;
END
$trava$;

-- PRE: OU a assinatura antiga com o corpo predecessor e a nova ausente (1º apply), OU a antiga ausente e a nova
-- com ESTE corpo (re-apply). E uma sobrecarga só.
DO $pre$
DECLARE
  v_md5_antiga text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text)'));
  v_md5_nova text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean)'));
  v_sobrecargas bigint := (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'radar_lista');
BEGIN
  IF v_sobrecargas <> 1
     OR NOT ((v_md5_antiga IS NOT DISTINCT FROM '2cb7ad507c9079b27ff43176da438212' AND v_md5_nova IS NULL)
             OR (v_md5_antiga IS NULL AND v_md5_nova IS NOT DISTINCT FROM 'c824ce104b6513307b6b027622c8fd50')) THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_lista vivo (antiga md5 %, nova md5 %, % sobrecargas) não é o predecessor revisado nem este',
      v_md5_antiga, v_md5_nova, v_sobrecargas;
  END IF;
  -- A leitura de que o filtro depende tem de existir (late-bound: sem ela, o CREATE passa e só a chamada falha).
  IF to_regprocedure('public.radar_atendimentos_ativos()') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.radar_atendimentos_ativos() ausente (migration 20261029201200 não aplicada)';
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text);
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
  p_limit integer DEFAULT 50,
  p_cnae_secundario text DEFAULT NULL,
  p_municipio_codigo text DEFAULT NULL,
  p_so_meus boolean DEFAULT false)
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
  IF p_cnae_secundario IS NOT NULL AND p_cnae_secundario !~ '^[0-9]{7}$' THEN
    RAISE EXCEPTION 'cnae_secundario inválido' USING ERRCODE = '22023';
  END IF;
  IF (p_ultimo_lote IS NOT NULL AND p_ultimo_lote !~ '^[0-9]{4}-[0-9]{2}$')
     OR (p_sugeridos_lote IS NOT NULL AND p_sugeridos_lote !~ '^[0-9]{4}-[0-9]{2}$') THEN
    RAISE EXCEPTION 'lote inválido' USING ERRCODE = '22023';
  END IF;
  IF p_sugeridos_lote IS NOT NULL AND p_sugeridos_score_min IS NULL THEN
    RAISE EXCEPTION 'sugeridos sem limiar de score' USING ERRCODE = '22023';
  END IF;
  -- Código de município da RFB: 4 dígitos. Mal formado contaria ZERO em silêncio: grita.
  IF p_municipio_codigo IS NOT NULL AND p_municipio_codigo !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'municipio_codigo inválido' USING ERRCODE = '22023';
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
  -- Cidade escolhida no ranking/mapa: o CÓDIGO, exato (o nome tem homônimos em outras UFs). Usa idx_radar_muni.
  IF p_municipio_codigo IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.municipio_codigo = $20$w$);
  END IF;
  -- "Meus atendimentos": só os leads que o vendedor assumiu e que seguem ATIVOS (não expirados, dono ainda na
  -- capability). NO SERVIDOR, antes do LIMIT/OFFSET: recortar os 50 carregados no front daria falso vazio. A
  -- expiração e o dono vêm de radar_atendimentos_ativos() (a mesma leitura da ficha e dos selos): a regra do
  -- prazo vive só em private.radar_atendimento_expira_em. Sem parâmetro ($n): o predicado é constante.
  IF COALESCE(p_so_meus, false) THEN
    v_w := array_append(v_w, $w$e.cnpj IN (SELECT a.cnpj FROM public.radar_atendimentos_ativos() a WHERE a.eh_meu)$w$);
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
  -- CNAE secundário combina com o principal (E): "@>" usa o GIN idx_radar_empresas_cnaes_sec.
  IF p_cnae_secundario IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.cnaes_secundarios @> ARRAY[$19]$w$);
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
        p_com_contato, p_data_abertura_min, p_data_abertura_max, p_limit, p_offset, p_cnae_secundario, p_municipio_codigo;
END
$function$;

REVOKE ALL ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean) TO authenticated, service_role;

-- PÓS ------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_lista oid := to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean)');
BEGIN
  -- P1: a função viva é ESTE arquivo (md5 exato do prosrc), SECURITY DEFINER STABLE, e uma sobrecarga só.
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_lista) IS DISTINCT FROM 'c824ce104b6513307b6b027622c8fd50' THEN
    RAISE EXCEPTION 'P1 FALHOU: a radar_lista viva não é o corpo deste arquivo';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'radar_lista') <> 1 THEN
    RAISE EXCEPTION 'P1 FALHOU: sobrou sobrecarga de radar_lista';
  END IF;
  IF NOT COALESCE((SELECT p.prosecdef AND p.provolatile = 's' FROM pg_catalog.pg_proc p WHERE p.oid = v_lista), false) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_lista não é SECURITY DEFINER STABLE';
  END IF;
  -- P2: ACL (as duas pontas: anon E PUBLIC sem EXECUTE; authenticated com).
  IF has_function_privilege('anon', v_lista, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = v_lista AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_lista, 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL errado (anon/PUBLIC executam radar_lista, ou authenticated não executa)';
  END IF;
  RAISE NOTICE 'radar pacote B2: radar_lista com p_so_meus, md5 ok, uma sobrecarga, ACL ok';
END
$post$;
