-- Corpos de PRODUÇÃO (pg_get_functiondef via psql-ro, 2026-11-09) que a 20261111160000_radar_agregado_visitar
-- substitui (recalcular, contagem) ou dos quais ela depende (validade do agregado e a regra "para visitar").
-- Lida por db/test-radar-agregado-visitar.sh: o A0 confere o md5 do prosrc contra o PRE da migration.
CREATE OR REPLACE FUNCTION public.radar_agregado_recalcular(p_forcar boolean DEFAULT false, p_agora timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '32MB'
AS $function$
DECLARE
  v_lote text;
  v_ini timestamptz;
  e public.radar_agregado_estado%ROWTYPE;
  v_tem_estado boolean;
  -- Marco diário: 06:35 UTC, depois de situação (06:05), recruzamento (06:15) e score (06:30).
  v_marco timestamptz := date_trunc('day', p_agora - interval '6 hours 35 minutes', 'UTC') + interval '6 hours 35 minutes';
  -- "Estabelecidas" = abertas há 5 anos ou mais na data de São Paulo (o hojeISO do front).
  v_corte date := ((p_agora AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date;
  v_empresas bigint;
  v_grupos integer;
  v_cobertos text[];
BEGIN
  -- Um cálculo por vez: o segundo espera o primeiro e relê o estado já novo.
  PERFORM pg_advisory_xact_lock(20261103, 1);
  -- Publicação em passos em andamento (20261111120000): os rótulos físicos misturam a foto velha e a nova
  -- — o agregado segue o da foto vigente até a virada (o tick seguinte recalcula).
  IF public.radar_lote_publicando() IS NOT NULL THEN
    RETURN jsonb_build_object('recalculou', false, 'adiado', 'publicacao_em_andamento',
                              'lote_em_publicacao', public.radar_lote_publicando());
  END IF;

  SELECT s.mes_referencia, s.iniciado_em INTO v_lote, v_ini
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC LIMIT 1;

  SELECT * INTO e FROM public.radar_agregado_estado WHERE id = 1;
  v_tem_estado := FOUND;

  IF NOT COALESCE(p_forcar, false) AND v_tem_estado
     AND e.base_lote IS NOT DISTINCT FROM v_lote
     AND e.base_iniciado_em IS NOT DISTINCT FROM v_ini
     AND e.calculado_em >= v_marco THEN
    RETURN jsonb_build_object('recalculou', false, 'lote', v_lote, 'calculado_em', e.calculado_em);
  END IF;

  -- CNAEs secundários cobertos pelo agregado = os CNAEs PRINCIPAIS da base (a carga só traz os CNAEs-alvo
  -- como principal). Varredura solta do índice de cnae_principal: uma descida por código, não a tabela.
  WITH RECURSIVE t(c) AS (
    SELECT min(cnae_principal) FROM public.radar_empresas
    UNION ALL
    SELECT (SELECT min(r.cnae_principal) FROM public.radar_empresas r WHERE r.cnae_principal > t.c)
      FROM t WHERE t.c IS NOT NULL
  )
  SELECT COALESCE(array_agg(t.c ORDER BY t.c), ARRAY[]::text[]) INTO v_cobertos FROM t WHERE t.c IS NOT NULL;

  -- DELETE (não TRUNCATE): quem lê durante o cálculo continua vendo o agregado anterior até o COMMIT.
  DELETE FROM public.radar_agregado_cnae;
  DELETE FROM public.radar_agregado_cnae_sec;
  DELETE FROM public.radar_agregado_municipio;
  -- 1 leitura de radar_empresas: cada empresa sai 1× com secundário NULL (→ fino) e 1× por CNAE
  -- secundário coberto, sem repetir (→ secundário; o array da RFB pode trazer o mesmo código 2 vezes).
  WITH src AS MATERIALIZED (
    SELECT re.ultimo_lote AS lote, re.municipio_codigo AS mc, re.uf AS u, re.municipio_nome AS mn,
           re.prospeccao_status AS st, re.ja_cliente AS jc,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL) AS tt,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL) AS tc,
           COALESCE(re.primeira_vista_em >= v_ini, false) AS ined,
           re.cnae_principal AS cp,
           s.cs,
           COALESCE(re.data_abertura <= v_corte, false) AS est,
           COALESCE(re.data_abertura <= v_corte + 1, false) AS est1,
           count(*) AS n
      FROM public.radar_empresas re
      CROSS JOIN LATERAL (
        SELECT NULL::text AS cs
        UNION ALL
        SELECT DISTINCT x.cs FROM unnest(re.cnaes_secundarios) AS x(cs) WHERE x.cs = ANY (v_cobertos)
      ) s
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
  ), fino AS (
    INSERT INTO public.radar_agregado_cnae
           (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
            tem_telefone, tem_contato, inedito, cnae_principal, estabelecida, estabelecida_d1, n)
    SELECT lote, mc, u, mn, st, jc, tt, tc, ined, cp, est, est1, n FROM src WHERE cs IS NULL
    RETURNING 1
  )
  INSERT INTO public.radar_agregado_cnae_sec
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, cnae_principal, cnae_secundario, estabelecida, estabelecida_d1, n)
  SELECT lote, mc, u, mn, st, jc, tt, tc, ined, cp, cs, est, est1, n FROM src WHERE cs IS NOT NULL;

  -- O agregado por município é a soma do fino: a tabela grande é lida uma vez só.
  INSERT INTO public.radar_agregado_municipio
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, n)
  SELECT c.lote, c.municipio_codigo, c.uf, c.municipio_nome, c.prospeccao_status, c.ja_cliente,
         c.tem_telefone, c.tem_contato, c.inedito, sum(c.n)::bigint
    FROM public.radar_agregado_cnae c
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

  SELECT COALESCE(sum(a.n), 0), count(*) INTO v_empresas, v_grupos FROM public.radar_agregado_municipio a;

  INSERT INTO public.radar_agregado_estado AS t (id, base_lote, base_iniciado_em, calculado_em, empresas, grupos, corte_estabelecida,
                                                  cnaes_secundarios_cobertos)
  VALUES (1, v_lote, v_ini, p_agora, v_empresas, v_grupos, v_corte, v_cobertos)
  ON CONFLICT (id) DO UPDATE
     SET base_lote = EXCLUDED.base_lote, base_iniciado_em = EXCLUDED.base_iniciado_em,
         calculado_em = EXCLUDED.calculado_em, empresas = EXCLUDED.empresas, grupos = EXCLUDED.grupos,
         corte_estabelecida = EXCLUDED.corte_estabelecida,
         cnaes_secundarios_cobertos = EXCLUDED.cnaes_secundarios_cobertos;

  RETURN jsonb_build_object('recalculou', true, 'lote', v_lote, 'empresas', v_empresas, 'grupos', v_grupos,
                            'corte_estabelecida', v_corte, 'cnaes_secundarios_cobertos', cardinality(v_cobertos),
                            'calculado_em', p_agora);
END
$function$

;

CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL::text, p_cnae_prefix text DEFAULT NULL::text, p_cnae_exato text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ufs text[] DEFAULT NULL::text[], p_com_contato boolean DEFAULT false, p_cnae_secundario text DEFAULT NULL::text, p_com_telefone boolean DEFAULT false)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, total bigint, com_telefone bigint, a_contatar bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inedito_ok boolean;
  v_pub text := public.radar_lote_publicando();  -- P: mesma foto que V até a virada (função STABLE = 1 snapshot)
  v_corte date;
  v_estab text;  -- NULL = sem corte de data; 'd0' = estabelecida; 'd1' = estabelecida_d1; 'vivo' = fora do fino
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;
  IF p_cnae_prefix IS NOT NULL AND p_cnae_prefix !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'cnae_prefix inválido'; END IF;
  IF p_cnae_exato  IS NOT NULL AND p_cnae_exato  !~ '^[0-9]{7}$'   THEN RAISE EXCEPTION 'cnae_exato inválido';  END IF;
  IF p_cnae_secundario IS NOT NULL AND p_cnae_secundario !~ '^[0-9]{7}$' THEN RAISE EXCEPTION 'cnae_secundario inválido'; END IF;
  -- Lote mal formado contaria ZERO em silêncio (nenhum ultimo_lote casa) — ausente ≠ zero: grita.
  IF p_lote IS NOT NULL AND p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'lote inválido'; END IF;
  -- Região vazia ou com UF mal formada também contaria zero em silêncio: grita.
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido';
  END IF;

  -- Inéditos cabem no agregado só quando são os DO LOTE VIGENTE (a identidade com que ele foi calculado).
  v_inedito_ok := p_primeira_vista_min IS NULL OR p_primeira_vista_min = (
    SELECT s.iniciado_em FROM public.radar_ingest_state s
     WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1);

  -- AGREGADO: tudo o que o recorte cabe em radar_agregado_municipio (UF, região, status, já-cliente, lote,
  -- contato e inéditos do lote vigente). É o default do /radar e o roteirizador.
  IF p_cnae_prefix IS NULL AND p_cnae_exato IS NULL AND p_cnae_secundario IS NULL
     AND p_data_abertura_min IS NULL AND p_data_abertura_max IS NULL
     AND v_inedito_ok THEN
    -- Agregado de outro lote contaria a foto velha (ou ZERO para o lote novo): indisponível, nunca 0.
    IF private.radar_agregado_valido() IS NULL THEN
      RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
    END IF;
    RETURN QUERY
    WITH agg AS MATERIALIZED (
      SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
             sum(a.n)::bigint AS t,
             COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
             COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
        FROM public.radar_agregado_municipio a
       WHERE (p_uf IS NULL OR a.uf = p_uf)
         AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
         AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
              OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
         AND (p_incluir_ja_clientes OR a.ja_cliente = false)
         AND (p_lote IS NULL OR a.lote = p_lote)
         AND (p_primeira_vista_min IS NULL OR a.inedito)
         AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
         AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
       GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
    )
    SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
           sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint
      FROM agg a
      LEFT JOIN public.radar_municipios m ON m.codigo = a.mc
     GROUP BY a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng
     ORDER BY sum(a.t) DESC, a.mc
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
    RETURN;
  END IF;

  -- FINO: CNAE e/ou o corte de "estabelecidas" (data máxima = corte do cálculo, ou corte + 1 dia na
  -- madrugada antes do recálculo diário). Data máxima de outro dia, data mínima ou inéditos de outro lote
  -- não cabem: caminho vivo. Com CNAE secundário, o mesmo recorte lê radar_agregado_cnae_sec — se o código
  -- está entre os cobertos pelo cálculo; senão o agregado contaria ZERO para ele: caminho vivo.
  IF p_data_abertura_min IS NULL AND v_inedito_ok THEN
    IF p_data_abertura_max IS NULL THEN
      v_estab := NULL;
    ELSE
      SELECT e.corte_estabelecida INTO v_corte FROM public.radar_agregado_estado e WHERE e.id = 1;
      v_estab := CASE WHEN p_data_abertura_max = v_corte THEN 'd0'
                      WHEN p_data_abertura_max = v_corte + 1 THEN 'd1'
                      ELSE 'vivo' END;
    END IF;
    IF v_estab IS DISTINCT FROM 'vivo' AND p_cnae_secundario IS NULL THEN
      IF private.radar_agregado_valido() IS NULL THEN
        RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
      END IF;
      RETURN QUERY
      WITH agg AS MATERIALIZED (
        SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
               sum(a.n)::bigint AS t,
               COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
               COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
          FROM public.radar_agregado_cnae a
         WHERE (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_cnae_exato  IS NULL OR a.cnae_principal = p_cnae_exato)
           AND (p_cnae_prefix IS NULL OR starts_with(a.cnae_principal, p_cnae_prefix))
           AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
                OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
           AND (p_incluir_ja_clientes OR a.ja_cliente = false)
           AND (v_estab IS NULL OR (v_estab = 'd0' AND a.estabelecida) OR (v_estab = 'd1' AND a.estabelecida_d1))
           AND (p_lote IS NULL OR a.lote = p_lote)
           AND (p_primeira_vista_min IS NULL OR a.inedito)
           AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
           AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
         GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
      )
      SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
             sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint
        FROM agg a
        LEFT JOIN public.radar_municipios m ON m.codigo = a.mc
       GROUP BY a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng
       ORDER BY sum(a.t) DESC, a.mc
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
      RETURN;
    END IF;
    IF v_estab IS DISTINCT FROM 'vivo' AND p_cnae_secundario IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.radar_agregado_estado e
                    WHERE e.id = 1 AND p_cnae_secundario = ANY (e.cnaes_secundarios_cobertos)) THEN
      IF private.radar_agregado_valido() IS NULL THEN
        RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
      END IF;
      RETURN QUERY
      WITH agg AS MATERIALIZED (
        SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
               sum(a.n)::bigint AS t,
               COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
               COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
          FROM public.radar_agregado_cnae_sec a
         WHERE a.cnae_secundario = p_cnae_secundario
           AND (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_cnae_exato  IS NULL OR a.cnae_principal = p_cnae_exato)
           AND (p_cnae_prefix IS NULL OR starts_with(a.cnae_principal, p_cnae_prefix))
           AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
                OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
           AND (p_incluir_ja_clientes OR a.ja_cliente = false)
           AND (v_estab IS NULL OR (v_estab = 'd0' AND a.estabelecida) OR (v_estab = 'd1' AND a.estabelecida_d1))
           AND (p_lote IS NULL OR a.lote = p_lote)
           AND (p_primeira_vista_min IS NULL OR a.inedito)
           AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
           AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
         GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
      )
      SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
             sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint
        FROM agg a
        LEFT JOIN public.radar_municipios m ON m.codigo = a.mc
       GROUP BY a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng
       ORDER BY sum(a.t) DESC, a.mc
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
      RETURN;
    END IF;
  END IF;

  -- VIVO: data de abertura fora do corte, data mínima ou inéditos de outro lote — o caminho de antes.
  -- p_uf vence p_ufs: com UF escolhida a região não entra (a UF já recorta mais fino). Prefixo de CNAE
  -- por starts_with: p_cnae_prefix só tem dígitos, então casa o mesmo que o LIKE de antes, sem curinga.
  RETURN QUERY
  SELECT re.municipio_codigo,
         COALESCE(m.nome, re.municipio_nome) AS municipio_nome,
         re.uf,
         m.lat, m.lng,
         count(*)::bigint AS total,
         count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS com_telefone,
         count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar')::bigint AS a_contatar
    FROM public.radar_empresas re
    LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
   WHERE (p_uf IS NULL OR re.uf = p_uf)
     AND (p_uf IS NOT NULL OR p_ufs IS NULL OR re.uf = ANY (p_ufs))
     AND (p_cnae_exato  IS NULL OR re.cnae_principal = p_cnae_exato)
     AND (p_cnae_prefix IS NULL OR starts_with(re.cnae_principal, p_cnae_prefix))
     AND (p_cnae_secundario IS NULL OR re.cnaes_secundarios @> ARRAY[p_cnae_secundario])
     AND ((p_status IS NOT NULL AND re.prospeccao_status = p_status)
          OR (p_status IS NULL AND re.prospeccao_status <> 'descartado'))
     AND (p_incluir_ja_clientes OR re.ja_cliente = false)
     AND (p_data_abertura_min IS NULL OR re.data_abertura >= p_data_abertura_min)
     AND (p_data_abertura_max IS NULL OR re.data_abertura <= p_data_abertura_max)
     AND (p_lote IS NULL OR (re.ultimo_lote = ANY (ARRAY[p_lote, v_pub])
                             AND (re.ultimo_lote = p_lote OR re.lote_anterior = p_lote)))
     AND (p_lote IS NOT NULL OR v_pub IS NULL OR NOT (re.ultimo_lote = v_pub AND re.lote_anterior IS NULL))
     AND (p_primeira_vista_min IS NULL OR re.primeira_vista_em >= p_primeira_vista_min)
     AND (NOT COALESCE(p_com_contato, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL)
     AND (NOT COALESCE(p_com_telefone, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC, re.municipio_codigo
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $function$

;

CREATE OR REPLACE FUNCTION private.radar_agregado_valido()
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT e.calculado_em
    FROM public.radar_agregado_estado e
    LEFT JOIN LATERAL (
          SELECT s.mes_referencia, s.iniciado_em FROM public.radar_ingest_state s
           WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1) v ON true
   WHERE e.id = 1
     AND e.base_lote IS NOT DISTINCT FROM v.mes_referencia
     AND e.base_iniciado_em IS NOT DISTINCT FROM v.iniciado_em
$function$

;

CREATE OR REPLACE FUNCTION private.radar_tel_valor(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  -- Só dígitos, sem 55 e sem zero à esquerda; 10 ou 11 dígitos; número de um dígito só (00000000, 99999999) é lixo.
  SELECT CASE WHEN length(d) IN (10, 11) AND right(d, 8) !~ '^(.)\1{7}$' THEN d END
    FROM (SELECT CASE WHEN length(x) IN (12, 13) AND left(x, 2) = '55' THEN substr(x, 3) ELSE x END AS d
            FROM (SELECT ltrim(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '0') AS x) a) b
$function$

;

CREATE OR REPLACE FUNCTION private.radar_email_valor(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE WHEN v ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN v END
    FROM (SELECT lower(btrim(p)) AS v) a
$function$

;

CREATE OR REPLACE FUNCTION private.radar_contato_contabil_avaliar(p_cnpj text, p_tel1 text, p_tel2 text, p_email text)
 RETURNS TABLE(campo text, tipo text, valor text, automatico boolean, motivos text[], grupos integer, corroborado boolean, correcao_id bigint, veredito boolean, efetivo boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH c AS (
    SELECT v.ordem, v.campo, v.tipo, v.valor
      FROM (VALUES (1, 'telefone1', 'telefone', private.radar_tel_valor(p_tel1)),
                   (2, 'telefone2', 'telefone', private.radar_tel_valor(p_tel2)),
                   (3, 'email', 'email', private.radar_email_valor(p_email))) AS v(ordem, campo, tipo, valor)
     WHERE v.valor IS NOT NULL
  ), est AS (
    -- Nunca calculado = "não sei" (NULL), nunca "não é" (false): ausente ≠ zero. K2: e o "não é" só vale para o
    -- contato que o cálculo LEU. Linha de radar_empresas escrita depois do cálculo (a publicação de um mês novo
    -- troca telefone/e-mail e grava updated_at) = "não sei" até o próximo recálculo (cron 06:50 UTC, depois de
    -- todo escritor diário). Sem linha da empresa, também "não sei".
    SELECT coalesce(s.calculado_em IS NOT NULL
                    AND (SELECT e.updated_at FROM public.radar_empresas e WHERE e.cnpj = p_cnpj) <= s.calculado_em,
                    false) AS calculado
      FROM (SELECT (SELECT s2.calculado_em FROM public.radar_contato_contabil_estado s2 WHERE s2.id) AS calculado_em) s
  )
  SELECT c.campo, c.tipo, c.valor,
         CASE WHEN a.cnpj IS NOT NULL THEN true WHEN est.calculado THEN false END,
         a.motivos, a.grupos, a.corroborado, r.id, r.veredito,
         CASE WHEN r.veredito IS NOT NULL THEN r.veredito
              WHEN a.cnpj IS NOT NULL THEN true
              WHEN est.calculado THEN false END
    FROM c
    CROSS JOIN est
    LEFT JOIN public.radar_contato_contabil a ON a.cnpj = p_cnpj AND a.tipo = c.tipo AND a.valor = c.valor
    LEFT JOIN LATERAL (SELECT k.id, k.veredito FROM public.radar_contato_contabil_correcoes k
                        WHERE k.cnpj = p_cnpj AND k.tipo = c.tipo AND k.valor = c.valor
                        ORDER BY k.id DESC LIMIT 1) r ON true
   ORDER BY c.ordem
$function$

;

CREATE OR REPLACE FUNCTION private.radar_contato_visitar(p_cnpj text, p_tel1 text, p_tel2 text, p_email text, p_logradouro text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- >= 1 contato utilizável, TODOS da contabilidade no efetivo (NULL = não sei → não afirma), e endereço para ir.
  SELECT NULLIF(btrim(coalesce(p_logradouro, '')), '') IS NOT NULL AND count(*) > 0 AND bool_and(a.efetivo IS TRUE)
    FROM private.radar_contato_contabil_avaliar(p_cnpj, p_tel1, p_tel2, p_email) a
$function$

;

