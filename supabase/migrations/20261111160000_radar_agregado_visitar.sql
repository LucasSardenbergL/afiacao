-- =============================================================================
-- Radar: dimensão "para visitar" no agregado por município (mapa, ranking e número do chip)
-- =============================================================================
-- Lacuna do pacote N (docs/historico/radar-desempenho-acabamento-pacote-n-2026-11-09.md): o chip "Para visitar"
-- filtra a FILA (radar_lista p_so_visitar, regra por lead private.radar_contato_visitar), mas o mapa e o ranking
-- leem radar_agregado_municipio, que não conhecia a regra — eles mostravam um aviso de que não a aplicavam, e o
-- chip desligado ficou sem número (o recorte vivo custa ~5,5 s de seq scan, medido em prod 2026-11-08).
--
-- Esta migration põe a regra no agregado como DIMENSÃO pré-calculada:
--   1. radar_agregado_municipio / _cnae / _cnae_sec ganham `visitar boolean`, calculado pelo ÚNICO escritor
--      (radar_agregado_recalcular) com a MESMA função da fila: private.radar_contato_visitar, chamada só nos
--      candidatos (CNPJs com sinal em radar_contato_contabil ∪ correção positiva — o mesmo pré-corte da
--      radar_lista). Medido em prod (psql-ro, 2026-11-09, corpo da regra copiado): 67.043 candidatos →
--      15.383 para visitar em 16,5 s; o recálculo leva 3 min 30 s, dentro do cron de 15 min.
--   2. radar_agregado_estado ganha `visitar_calculado_em` (= calculado_em quando a dimensão foi escrita por este
--      código) e `visitar_base_contabil` (o calculado_em de radar_contato_contabil_estado que ela leu). A dimensão
--      só é servida com visitar_calculado_em = calculado_em: um recálculo de código antigo (DR) deixaria `visitar`
--      NULL e o filtro contaria ZERO — ausente ≠ zero, então ela fica indisponível.
--   3. O recálculo também roda quando a contabilidade foi recalculada depois dele (cron 06:50 UTC, DEPOIS do
--      marco das 06:35 do agregado): sem isto a dimensão ficaria até 24 h atrás da regra. Na prática: 06:35 e 07:35
--      UTC. A correção do vendedor (radar_contato_contabil_corrigir) NÃO recalcula na hora — entra no próximo
--      recálculo; a tela diz de quando é a contagem (visitar_contado_em).
--   4. radar_contagem_por_municipio (DROP + CREATE: assinatura nova) ganha
--        p_so_visitar      — só os "para visitar" (agregado e fino); fora deles a dimensão não existe e a RPC
--                            devolve a contagem SEM o recorte, com visitar_contado_em NULL (a tela avisa);
--        p_municipio_codigo— a cidade da fila (código RFB), para o número do chip bater com o recorte dela;
--        p_so_agregado     — recorte que cairia no caminho VIVO devolve 0 linhas em vez de ler radar_empresas
--                            (o número do chip nunca dispara o seq scan);
--      e devolve para_visitar (por município), para_visitar_total (do recorte INTEIRO, janela antes do LIMIT) e
--      visitar_contado_em (NULL = dimensão indisponível neste recorte — nunca 0).
--
-- Ordem: não colar durante o recálculo (minutos :35–:40): o ALTER TABLE espera o DELETE dele e o lock_timeout de
-- 5 s aborta tudo (re-colar depois é seguro). A dimensão nasce no tick :35 seguinte, sozinha.
-- Prova PG17: db/test-radar-agregado-visitar.sh (os dois locales; --falsificar).
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- TRAVA: ALTER sem efeito em cada objeto VIVO que a PRE guarda e este arquivo recria (segura outra sessão).
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_agregado_recalcular(boolean,timestamp with time zone)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_agregado_recalcular(boolean, timestamp with time zone) VOLATILE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean) STABLE;
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean,boolean,text,boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean,boolean,text,boolean) STABLE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo é o predecessor revisado (pg_get_functiondef de prod, 2026-11-09) ou este arquivo.
DO $pre$
DECLARE
  v_rec   text := (SELECT md5(p.prosrc) FROM pg_proc p
                    WHERE p.oid = to_regprocedure('public.radar_agregado_recalcular(boolean,timestamp with time zone)'));
  v_velha text := (SELECT md5(p.prosrc) FROM pg_proc p
                    WHERE p.oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean)'));
  v_nova  text := (SELECT md5(p.prosrc) FROM pg_proc p
                    WHERE p.oid = to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean,boolean,text,boolean)'));
BEGIN
  IF v_rec IS NULL OR v_rec NOT IN ('689efa9f14564f1c8643ebb04b158241', '2f226c740ad151ecfd0a2e4d0472c80d') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_agregado_recalcular vivo (md5 %) não é o predecessor revisado nem este', v_rec;
  END IF;
  -- 1º apply: só a assinatura velha, com o corpo revisado. Re-apply: só a nova, com o corpo deste arquivo.
  IF NOT ((v_velha = 'f79e5a814b622248b8d2845ef27edb65' AND v_nova IS NULL)
          OR (v_velha IS NULL AND v_nova = '45e4f7424f2eb6d47e2544dcb58cd2c6')) THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_contagem_por_municipio vivo (velha md5 %, nova md5 %) não é o predecessor revisado nem este',
      v_velha, v_nova;
  END IF;
  IF to_regprocedure('private.radar_contato_visitar(text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_contato_visitar ausente — a dimensão não tem regra para copiar';
  END IF;
END
$pre$;

-- 1) A dimensão nas 3 tabelas (NULL = não calculada; o recálculo deste código sempre a escreve) --------------
ALTER TABLE public.radar_agregado_municipio ADD COLUMN IF NOT EXISTS visitar boolean;
ALTER TABLE public.radar_agregado_cnae      ADD COLUMN IF NOT EXISTS visitar boolean;
ALTER TABLE public.radar_agregado_cnae_sec  ADD COLUMN IF NOT EXISTS visitar boolean;
ALTER TABLE public.radar_agregado_estado    ADD COLUMN IF NOT EXISTS visitar_calculado_em timestamptz;
ALTER TABLE public.radar_agregado_estado    ADD COLUMN IF NOT EXISTS visitar_base_contabil timestamptz;
COMMENT ON COLUMN public.radar_agregado_municipio.visitar IS
  'Lead "para visitar" (private.radar_contato_visitar no momento do recálculo). Só vale com radar_agregado_estado.visitar_calculado_em = calculado_em (private.radar_agregado_visitar_em). Escritor único: radar_agregado_recalcular.';
COMMENT ON COLUMN public.radar_agregado_estado.visitar_calculado_em IS
  'Quando a dimensão visitar foi escrita. Igual a calculado_em = o agregado vigente a tem; diferente/NULL = indisponível (nunca 0).';
COMMENT ON COLUMN public.radar_agregado_estado.visitar_base_contabil IS
  'radar_contato_contabil_estado.calculado_em lido pelo recálculo. Mais novo na contabilidade → o cron recalcula.';

-- 2) Validade da dimensão -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_agregado_visitar_em()
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT e.visitar_calculado_em
    FROM public.radar_agregado_estado e
   WHERE e.id = 1
     AND e.visitar_calculado_em = e.calculado_em
     AND private.radar_agregado_valido() IS NOT NULL
$$;
REVOKE ALL ON FUNCTION private.radar_agregado_visitar_em() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION private.radar_agregado_visitar_em() IS
  'Quando a dimensão visitar do agregado VIGENTE foi calculada; NULL = indisponível (lote trocado, ou agregado escrito por código sem a dimensão).';

-- 3) O escritor ------------------------------------------------------------------------------------------
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
  v_visitar bigint;
  v_cobertos text[];
  -- A regra "para visitar" lê a contabilidade calculada às 06:50 UTC (DEPOIS do marco): recalculada depois da
  -- dimensão, ela pede um recálculo no tick seguinte (07:35) — senão o mapa ficaria até 24 h atrás da fila.
  v_contabil timestamptz := (SELECT s.calculado_em FROM public.radar_contato_contabil_estado s WHERE s.id);
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
     AND e.calculado_em >= v_marco
     -- A dimensão visitar é deste agregado (o 1º tick depois da migration a calcula) e leu a contabilidade atual.
     AND e.visitar_calculado_em IS NOT DISTINCT FROM e.calculado_em
     AND e.visitar_base_contabil IS NOT DISTINCT FROM v_contabil THEN
    RETURN jsonb_build_object('recalculou', false, 'lote', v_lote, 'calculado_em', e.calculado_em);
  END IF;

  -- CNAEs secundários cobertos pelo agregado _sec = os códigos que existem em radar_empresas (como principal).
  -- Varredura solta do índice de cnae_principal: uma descida por código, não a tabela.
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
  -- "Para visitar": a MESMA regra da fila (private.radar_contato_visitar), só nos candidatos — o pré-corte da
  -- radar_lista (sinal de contabilidade ∪ correção positiva; quem não está nele não tem contato "da contabilidade").
  WITH vis AS MATERIALIZED (
    SELECT ev.cnpj
      FROM public.radar_empresas ev
     WHERE ev.cnpj IN (SELECT c.cnpj FROM public.radar_contato_contabil c
                       UNION SELECT k.cnpj FROM public.radar_contato_contabil_correcoes k WHERE k.veredito)
       AND private.radar_contato_visitar(ev.cnpj, ev.telefone1, ev.telefone2, ev.email, ev.logradouro)
  ), src AS MATERIALIZED (
    SELECT re.ultimo_lote AS lote, re.municipio_codigo AS mc, re.uf AS u, re.municipio_nome AS mn,
           re.prospeccao_status AS st, re.ja_cliente AS jc,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL) AS tt,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL) AS tc,
           COALESCE(re.primeira_vista_em >= v_ini, false) AS ined,
           re.cnae_principal AS cp,
           s.cs,
           COALESCE(re.data_abertura <= v_corte, false) AS est,
           COALESCE(re.data_abertura <= v_corte + 1, false) AS est1,
           (v.cnpj IS NOT NULL) AS vi,
           count(*) AS n
      FROM public.radar_empresas re
      LEFT JOIN vis v ON v.cnpj = re.cnpj
      CROSS JOIN LATERAL (
        SELECT NULL::text AS cs
        UNION ALL
        SELECT DISTINCT x.cs FROM unnest(re.cnaes_secundarios) AS x(cs) WHERE x.cs = ANY (v_cobertos)
      ) s
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14
  ), fino AS (
    INSERT INTO public.radar_agregado_cnae
           (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
            tem_telefone, tem_contato, inedito, cnae_principal, estabelecida, estabelecida_d1, visitar, n)
    SELECT lote, mc, u, mn, st, jc, tt, tc, ined, cp, est, est1, vi, n FROM src WHERE cs IS NULL
    RETURNING 1
  )
  INSERT INTO public.radar_agregado_cnae_sec
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, cnae_principal, cnae_secundario, estabelecida, estabelecida_d1, visitar, n)
  SELECT lote, mc, u, mn, st, jc, tt, tc, ined, cp, cs, est, est1, vi, n FROM src WHERE cs IS NOT NULL;

  -- O agregado por município é a soma do fino: a tabela grande é lida uma vez só.
  INSERT INTO public.radar_agregado_municipio
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, visitar, n)
  SELECT c.lote, c.municipio_codigo, c.uf, c.municipio_nome, c.prospeccao_status, c.ja_cliente,
         c.tem_telefone, c.tem_contato, c.inedito, c.visitar, sum(c.n)::bigint
    FROM public.radar_agregado_cnae c
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10;

  SELECT COALESCE(sum(a.n), 0), count(*), COALESCE(sum(a.n) FILTER (WHERE a.visitar), 0)
    INTO v_empresas, v_grupos, v_visitar FROM public.radar_agregado_municipio a;

  INSERT INTO public.radar_agregado_estado AS t (id, base_lote, base_iniciado_em, calculado_em, empresas, grupos, corte_estabelecida,
                                                  cnaes_secundarios_cobertos, visitar_calculado_em, visitar_base_contabil)
  VALUES (1, v_lote, v_ini, p_agora, v_empresas, v_grupos, v_corte, v_cobertos, p_agora, v_contabil)
  ON CONFLICT (id) DO UPDATE
     SET base_lote = EXCLUDED.base_lote, base_iniciado_em = EXCLUDED.base_iniciado_em,
         calculado_em = EXCLUDED.calculado_em, empresas = EXCLUDED.empresas, grupos = EXCLUDED.grupos,
         corte_estabelecida = EXCLUDED.corte_estabelecida,
         cnaes_secundarios_cobertos = EXCLUDED.cnaes_secundarios_cobertos,
         visitar_calculado_em = EXCLUDED.visitar_calculado_em,
         visitar_base_contabil = EXCLUDED.visitar_base_contabil;

  RETURN jsonb_build_object('recalculou', true, 'lote', v_lote, 'empresas', v_empresas, 'grupos', v_grupos,
                            'para_visitar', v_visitar,
                            'corte_estabelecida', v_corte, 'cnaes_secundarios_cobertos', cardinality(v_cobertos),
                            'calculado_em', p_agora);
END
$function$;

-- 4) O leitor (assinatura nova: DROP + CREATE; o DROP zera o ACL → reemitido abaixo, nomeando os papéis) -----
DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean);

CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL::text, p_cnae_prefix text DEFAULT NULL::text, p_cnae_exato text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ufs text[] DEFAULT NULL::text[], p_com_contato boolean DEFAULT false, p_cnae_secundario text DEFAULT NULL::text, p_com_telefone boolean DEFAULT false, p_so_visitar boolean DEFAULT false, p_municipio_codigo text DEFAULT NULL::text, p_so_agregado boolean DEFAULT false)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, total bigint, com_telefone bigint, a_contatar bigint, para_visitar bigint, para_visitar_total bigint, visitar_contado_em timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inedito_ok boolean;
  v_pub text := public.radar_lote_publicando();  -- P: mesma foto que V até a virada (função STABLE = 1 snapshot)
  v_corte date;
  v_estab text;  -- NULL = sem corte de data; 'd0' = estabelecida; 'd1' = estabelecida_d1; 'vivo' = fora do fino
  -- Dimensão "para visitar" do agregado vigente: NULL = indisponível (nunca 0). Com ela, p_so_visitar recorta;
  -- sem ela (ou no caminho vivo) a contagem sai SEM o recorte e visitar_contado_em NULL diz isso à tela.
  v_vis_em timestamptz := private.radar_agregado_visitar_em();
  v_so_vis boolean := COALESCE(p_so_visitar, false) AND v_vis_em IS NOT NULL;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;
  IF p_cnae_prefix IS NOT NULL AND p_cnae_prefix !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'cnae_prefix inválido'; END IF;
  IF p_cnae_exato  IS NOT NULL AND p_cnae_exato  !~ '^[0-9]{7}$'   THEN RAISE EXCEPTION 'cnae_exato inválido';  END IF;
  IF p_cnae_secundario IS NOT NULL AND p_cnae_secundario !~ '^[0-9]{7}$' THEN RAISE EXCEPTION 'cnae_secundario inválido'; END IF;
  -- Lote mal formado contaria ZERO em silêncio (nenhum ultimo_lote casa) — ausente ≠ zero: grita.
  IF p_lote IS NOT NULL AND p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'lote inválido'; END IF;
  -- Código de município mal formado também contaria zero em silêncio (código RFB: 4 dígitos).
  IF p_municipio_codigo IS NOT NULL AND p_municipio_codigo !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'municipio_codigo inválido'; END IF;
  -- Região vazia ou com UF mal formada também contaria zero em silêncio: grita.
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido';
  END IF;

  -- Inéditos cabem no agregado só quando são os DO LOTE VIGENTE (a identidade com que ele foi calculado).
  v_inedito_ok := p_primeira_vista_min IS NULL OR p_primeira_vista_min = (
    SELECT s.iniciado_em FROM public.radar_ingest_state s
     WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1);

  -- AGREGADO: tudo o que o recorte cabe em radar_agregado_municipio (UF, região, cidade, status, já-cliente, lote,
  -- contato, inéditos do lote vigente e "para visitar"). É o default do /radar e o roteirizador.
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
             COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac,
             CASE WHEN v_vis_em IS NOT NULL THEN COALESCE(sum(a.n) FILTER (WHERE a.visitar), 0)::bigint END AS pv
        FROM public.radar_agregado_municipio a
       WHERE (p_uf IS NULL OR a.uf = p_uf)
         AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
         AND (p_municipio_codigo IS NULL OR a.municipio_codigo = p_municipio_codigo)
         AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
              OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
         AND (p_incluir_ja_clientes OR a.ja_cliente = false)
         AND (p_lote IS NULL OR a.lote = p_lote)
         AND (p_primeira_vista_min IS NULL OR a.inedito)
         AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
         AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
         AND (NOT v_so_vis OR a.visitar)
       GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
    )
    SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
           sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint,
           sum(a.pv)::bigint, (sum(sum(a.pv)) OVER ())::bigint, v_vis_em
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
               COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac,
               CASE WHEN v_vis_em IS NOT NULL THEN COALESCE(sum(a.n) FILTER (WHERE a.visitar), 0)::bigint END AS pv
          FROM public.radar_agregado_cnae a
         WHERE (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_municipio_codigo IS NULL OR a.municipio_codigo = p_municipio_codigo)
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
           AND (NOT v_so_vis OR a.visitar)
         GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
      )
      SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
             sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint,
             sum(a.pv)::bigint, (sum(sum(a.pv)) OVER ())::bigint, v_vis_em
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
               COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac,
               CASE WHEN v_vis_em IS NOT NULL THEN COALESCE(sum(a.n) FILTER (WHERE a.visitar), 0)::bigint END AS pv
          FROM public.radar_agregado_cnae_sec a
         WHERE a.cnae_secundario = p_cnae_secundario
           AND (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_municipio_codigo IS NULL OR a.municipio_codigo = p_municipio_codigo)
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
           AND (NOT v_so_vis OR a.visitar)
         GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
      )
      SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
             sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint,
             sum(a.pv)::bigint, (sum(sum(a.pv)) OVER ())::bigint, v_vis_em
        FROM agg a
        LEFT JOIN public.radar_municipios m ON m.codigo = a.mc
       GROUP BY a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng
       ORDER BY sum(a.t) DESC, a.mc
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
      RETURN;
    END IF;
  END IF;

  -- p_so_agregado (o número do chip): o recorte não cabe em agregado nenhum → 0 linhas, sem ler radar_empresas.
  IF COALESCE(p_so_agregado, false) THEN
    RETURN;
  END IF;

  -- VIVO: data de abertura fora do corte, data mínima ou inéditos de outro lote — o caminho de antes. Aqui não há
  -- dimensão "para visitar" (a regra por lead custaria segundos): para_visitar NULL e visitar_contado_em NULL.
  -- p_uf vence p_ufs: com UF escolhida a região não entra (a UF já recorta mais fino). Prefixo de CNAE
  -- por starts_with: p_cnae_prefix só tem dígitos, então casa o mesmo que o LIKE de antes, sem curinga.
  RETURN QUERY
  SELECT re.municipio_codigo,
         COALESCE(m.nome, re.municipio_nome) AS municipio_nome,
         re.uf,
         m.lat, m.lng,
         count(*)::bigint AS total,
         count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS com_telefone,
         count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar')::bigint AS a_contatar,
         NULL::bigint, NULL::bigint, NULL::timestamptz
    FROM public.radar_empresas re
    LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
   WHERE (p_uf IS NULL OR re.uf = p_uf)
     AND (p_uf IS NOT NULL OR p_ufs IS NULL OR re.uf = ANY (p_ufs))
     AND (p_municipio_codigo IS NULL OR re.municipio_codigo = p_municipio_codigo)
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
END $function$;

REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean,boolean,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean,boolean,text,boolean) TO authenticated, service_role;
COMMENT ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean,boolean,text,boolean) IS
  'Contagem do recorte do /radar por município (agregado, fino ou vivo). p_so_visitar recorta pela dimensão "para visitar" do agregado quando ela existe para o recorte; visitar_contado_em NULL = não recortou (caminho vivo, ou dimensão indisponível) — nunca 0. para_visitar_total = do recorte inteiro, antes do LIMIT. p_so_agregado: recorte fora dos agregados devolve 0 linhas sem ler radar_empresas.';

-- PÓS: o estado que a tela precisa, relido do catálogo --------------------------------------------------
DO $post$
DECLARE
  c_sig_nova CONSTANT text := 'public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean,boolean,text,boolean)';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['radar_agregado_municipio', 'radar_agregado_cnae', 'radar_agregado_cnae_sec'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = t AND column_name = 'visitar' AND data_type = 'boolean') THEN
      RAISE EXCEPTION 'P1 FALHOU: %.visitar ausente — o recálculo novo não teria onde escrever', t;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'radar_agregado_estado'
         AND column_name IN ('visitar_calculado_em', 'visitar_base_contabil')) <> 2 THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_agregado_estado sem as colunas de validade da dimensão';
  END IF;
  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'P2 FALHOU: a assinatura velha da contagem sobreviveu — duas sobrecargas, chamada ambígua';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(c_sig_nova)) IS DISTINCT FROM '45e4f7424f2eb6d47e2544dcb58cd2c6'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.radar_agregado_recalcular(boolean,timestamp with time zone)'))
        IS DISTINCT FROM '2f226c740ad151ecfd0a2e4d0472c80d' THEN
    RAISE EXCEPTION 'P3 FALHOU: corpo vivo da contagem ou do recálculo diverge deste arquivo';
  END IF;
  IF NOT (SELECT p.prosecdef AND p.provolatile = 's' FROM pg_proc p WHERE p.oid = to_regprocedure(c_sig_nova)) THEN
    RAISE EXCEPTION 'P4 FALHOU: contagem não é STABLE SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated', c_sig_nova, 'EXECUTE')
     OR NOT has_function_privilege('service_role', c_sig_nova, 'EXECUTE')
     OR has_function_privilege('anon', c_sig_nova, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = to_regprocedure(c_sig_nova) AND a.grantee = 0) THEN
    RAISE EXCEPTION 'P5 FALHOU: ACL da contagem errado (authenticated/service_role sim; PUBLIC/anon não)';
  END IF;
  IF has_function_privilege('authenticated', 'private.radar_agregado_visitar_em()', 'EXECUTE')
     OR has_function_privilege('anon', 'private.radar_agregado_visitar_em()', 'EXECUTE') THEN
    RAISE EXCEPTION 'P5 FALHOU: private.radar_agregado_visitar_em executável fora do owner';
  END IF;
END
$post$;

COMMIT;
