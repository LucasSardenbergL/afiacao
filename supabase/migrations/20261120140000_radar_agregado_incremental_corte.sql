-- =============================================================================
-- Radar (Mini): o recálculo diário do agregado só ajusta quem cruza o corte de "estabelecida"
-- =============================================================================
-- O cron `radar-agregado-recalcular` (35 * * * *) recalcula 1×/dia, depois do marco das 06:35 UTC, e relê
-- radar_empresas inteira (heap 731 MB, ~583 mil linhas): ~2,6 GB lidos, 2–3 min (docs/historico/
-- tint-purge-staging-io.md, fatia nº 1). O motivo do diário é o relógio: estabelecida = data_abertura <= corte
-- e estabelecida_d1 = data_abertura <= corte + 1, com corte = hoje em São Paulo − 5 anos. As outras dimensões só
-- mudam com escrita na linha.
--
-- Esta migration:
--   1. radar_agregado_estado ganha `completo_em` (último recálculo COMPLETO) e `impressao` (impressão digital lida
--      ANTES daquele recálculo, por índices: max(updated_at), nº de já-clientes, correções do vendedor
--      (count:max(id), insert-only), exclusões de titular (md5 de raiz:escopo) e o calculado_em da contabilidade).
--   2. private.radar_agregado_impressao() — a impressão, sem ler o heap.
--   3. private.radar_agregado_delta_corte(de, para, início do lote, CNAEs cobertos) — as empresas com
--      data_abertura em (de, para + 1], achadas pelo idx_radar_empresas_fila (ultimo_lote, prospeccao_status,
--      data_abertura DESC) com as combinações (lote, status) de uma varredura solta do MESMO índice. Cada uma sai
--      da chave velha (corte `de`) e entra na nova (corte `para`), no fino (secundário NULL) e no _sec (1 por
--      secundário coberto distinto), com as MESMAS expressões do recálculo completo. Agrupado, só o saldo <> 0.
--   4. radar_agregado_recalcular: o gate de "nada a fazer" é o de antes. Quando há o que fazer, o caminho é
--      INCREMENTAL se — e só se — não é forçado, o estado tem cálculo completo, lote/início/contabilidade/visitar
--      são os do completo, o completo tem menos de 6 d 12 h (rede: a rodada do 7º dia recalcula tudo), não há
--      exclusão de escopo `contato` (os 2 escritores de privacidade mudam contato/status SEM updated_at — parecer
--      Codex ALTO 1), a impressão é a gravada e o corte não voltou. O delta entra por MERGE (saldo 0 → DELETE).
--      Qualquer incoerência estoura o CHECK (n > 0) ou o MERGE (21000), e a impressão relida DEPOIS do delta tem
--      de ser a mesma (ALTO 3: escrita que commitou no meio) — senão o bloco volta atrás e o recálculo é COMPLETO.
--      radar_agregado_municipio não tem estabelecida: o incremental não o toca.
--   5. Semente: o agregado vigente é de um completo; se nada foi escrito depois dele (max(updated_at), correções e
--      exclusões até calculado_em, nenhuma exclusão `contato`, lote e contabilidade iguais), a impressão de agora é
--      a dele — o cron de amanhã já pode ser incremental.
--
-- Heurística aceita (a mesma do gate do score, 20261105150000): transação que começou ANTES da leitura da impressão
-- e commita DEPOIS, sem mudar o nº de já-clientes, fica invisível ao max(updated_at). O teto da defasagem é a rede.
-- Aplicação: `bun run db:aplicar supabase/migrations/20261120140000_radar_agregado_incremental_corte.sql`, fora dos
-- minutos :35–:40 (o advisory lock do recálculo).
-- Prova PG17: db/test-radar-agregado-incremental.sh (os dois locales; --falsificar).
-- =============================================================================
SET LOCAL lock_timeout = '5s';

-- TRAVA: ALTER sem efeito no objeto VIVO que a PRE guarda e este arquivo recria (segura outra sessão).
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_agregado_recalcular(boolean,timestamp with time zone)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_agregado_recalcular(boolean, timestamp with time zone) VOLATILE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo é o predecessor revisado (20261111160000, pg_get_functiondef de prod 2026-11-20) ou este.
DO $pre$
DECLARE
  v_rec text := (SELECT md5(p.prosrc) FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.radar_agregado_recalcular(boolean,timestamp with time zone)'));
BEGIN
  IF v_rec IS NULL OR v_rec NOT IN ('2f226c740ad151ecfd0a2e4d0472c80d', '209066abac30ebc4cb8b54c1e55346c3') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_agregado_recalcular vivo (md5 %) não é o predecessor revisado nem este', v_rec;
  END IF;
  -- A varredura solta do delta para no 1º NULL: as duas colunas da chave do índice têm de ser NOT NULL.
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.radar_empresas'::regclass AND a.attname IN ('ultimo_lote', 'prospeccao_status')
         AND a.attnotnull) <> 2 THEN
    RAISE EXCEPTION 'PRE FALHOU: ultimo_lote/prospeccao_status aceitam NULL — o delta perderia empresas';
  END IF;
  IF to_regclass('public.idx_radar_empresas_fila') IS NULL OR to_regclass('public.idx_radar_empresas_updated_at') IS NULL
     OR to_regclass('public.idx_radar_empresas_ja_cliente') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: índice de que o incremental depende ausente (fila, updated_at ou ja_cliente)';
  END IF;
END
$pre$;

-- 1) Estado ------------------------------------------------------------------------------------------------
ALTER TABLE public.radar_agregado_estado ADD COLUMN IF NOT EXISTS completo_em timestamptz;
ALTER TABLE public.radar_agregado_estado ADD COLUMN IF NOT EXISTS impressao jsonb;
COMMENT ON COLUMN public.radar_agregado_estado.completo_em IS
  'Último recálculo COMPLETO (releitura de radar_empresas). NULL = o próximo é completo. Rede: completo com 6 d 12 h ou mais → completo.';
COMMENT ON COLUMN public.radar_agregado_estado.impressao IS
  'private.radar_agregado_impressao() lida ANTES do último recálculo completo. Diferente da de agora = houve escrita → completo.';

-- 2) Impressão digital (índices, nunca o heap) ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_agregado_impressao()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  -- epoch, não o texto do timestamptz: o texto depende do TimeZone da sessão (apply ≠ cron).
  SELECT jsonb_build_object(
    'max_updated_at', (SELECT extract(epoch FROM max(re.updated_at)) FROM public.radar_empresas re),
    'ja_clientes',    (SELECT count(*) FROM public.radar_empresas re WHERE re.ja_cliente),
    'correcoes',      (SELECT count(*) || ':' || COALESCE(max(k.id)::text, '-') FROM public.radar_contato_contabil_correcoes k),
    'exclusoes',      (SELECT md5(COALESCE(string_agg(x.raiz || ':' || x.escopo, ',' ORDER BY x.raiz), ''))
                         FROM public.radar_exclusoes_titular x),
    'contabil',       (SELECT extract(epoch FROM s.calculado_em) FROM public.radar_contato_contabil_estado s WHERE s.id))
$function$;
REVOKE ALL ON FUNCTION private.radar_agregado_impressao() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION private.radar_agregado_impressao() IS
  'Impressão digital do que muda as dimensões do agregado do Radar sem o relógio (gate do incremental de radar_agregado_recalcular).';

-- 3) Delta do corte ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_agregado_delta_corte(p_de date, p_para date, p_ini timestamptz, p_cobertos text[])
RETURNS TABLE (lote text, municipio_codigo text, uf text, municipio_nome text, prospeccao_status text,
               ja_cliente boolean, tem_telefone boolean, tem_contato boolean, inedito boolean, cnae_principal text,
               cnae_secundario text, estabelecida boolean, estabelecida_d1 boolean, visitar boolean, dn bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  -- Combinações (lote, status) existentes: varredura solta do idx_radar_empresas_fila, uma descida por par.
  WITH RECURSIVE k(kl, ks) AS (
    (SELECT r.ultimo_lote, r.prospeccao_status FROM public.radar_empresas r
      ORDER BY r.ultimo_lote, r.prospeccao_status LIMIT 1)
    UNION ALL
    SELECT x.kl, x.ks
      FROM k CROSS JOIN LATERAL (
        SELECT r.ultimo_lote AS kl, r.prospeccao_status AS ks FROM public.radar_empresas r
         WHERE (r.ultimo_lote, r.prospeccao_status) > (k.kl, k.ks)
         ORDER BY r.ultimo_lote, r.prospeccao_status LIMIT 1) x
  ), mov AS MATERIALIZED (
    -- As mesmas expressões do recálculo completo; data_abertura aqui nunca é NULL (faixa).
    SELECT re.ultimo_lote AS ml, re.municipio_codigo AS mmc, re.uf AS mu, re.municipio_nome AS mmn,
           re.prospeccao_status AS mst, re.ja_cliente AS mjc,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL) AS mtt,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL) AS mtc,
           COALESCE(re.primeira_vista_em >= p_ini, false) AS mined,
           re.cnae_principal AS mcp, re.cnaes_secundarios AS mcss,
           re.data_abertura <= p_de AS est_v, re.data_abertura <= p_de + 1 AS est1_v,
           re.data_abertura <= p_para AS est_n, re.data_abertura <= p_para + 1 AS est1_n,
           -- "Para visitar" = candidato (sinal da contabilidade ∪ correção positiva) E a regra da fila. No completo a
           -- regra é um WHERE (NULL fica fora); o COALESCE espelha isso, caso a regra um dia devolva NULL.
           COALESCE((EXISTS (SELECT 1 FROM public.radar_contato_contabil c WHERE c.cnpj = re.cnpj)
                     OR EXISTS (SELECT 1 FROM public.radar_contato_contabil_correcoes kc WHERE kc.cnpj = re.cnpj AND kc.veredito))
                    AND private.radar_contato_visitar(re.cnpj, re.telefone1, re.telefone2, re.email, re.logradouro),
                    false) AS mvi
      FROM k
      JOIN public.radar_empresas re ON re.ultimo_lote = k.kl AND re.prospeccao_status = k.ks
     WHERE re.data_abertura > p_de AND re.data_abertura <= p_para + 1
  ), sec AS (
    SELECT m.*, s.scs
      FROM mov m
      CROSS JOIN LATERAL (
        SELECT NULL::text AS scs
        UNION ALL
        SELECT DISTINCT x.cs FROM unnest(m.mcss) AS x(cs) WHERE x.cs = ANY (p_cobertos)
      ) s
  ), chg AS (
    SELECT q.ml, q.mmc, q.mu, q.mmn, q.mst, q.mjc, q.mtt, q.mtc, q.mined, q.mcp, q.scs, q.est_n AS qe, q.est1_n AS qe1, q.mvi, 1 AS qd
      FROM sec q
    UNION ALL
    SELECT q.ml, q.mmc, q.mu, q.mmn, q.mst, q.mjc, q.mtt, q.mtc, q.mined, q.mcp, q.scs, q.est_v, q.est1_v, q.mvi, -1
      FROM sec q
  )
  SELECT g.ml, g.mmc, g.mu, g.mmn, g.mst, g.mjc, g.mtt, g.mtc, g.mined, g.mcp, g.scs, g.qe, g.qe1, g.mvi, sum(g.qd)::bigint
    FROM chg g
   GROUP BY g.ml, g.mmc, g.mu, g.mmn, g.mst, g.mjc, g.mtt, g.mtc, g.mined, g.mcp, g.scs, g.qe, g.qe1, g.mvi
  HAVING sum(g.qd) <> 0
$function$;
REVOKE ALL ON FUNCTION private.radar_agregado_delta_corte(date, date, timestamptz, text[]) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION private.radar_agregado_delta_corte(date, date, timestamptz, text[]) IS
  'Saldo por grupo do agregado fino/_sec quando o corte de "estabelecida" anda de p_de para p_para (empresas com data_abertura em (p_de, p_para + 1]). Lê só o índice de fila e as linhas que cruzam.';

-- 4) O escritor ----------------------------------------------------------------------------------------------
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
  v_contabil timestamptz;
  v_impressao jsonb;
  v_motivo text;
  v_fino bigint;
  v_sec bigint;
BEGIN
  -- Um cálculo por vez: o segundo espera o primeiro e relê o estado já novo.
  PERFORM pg_advisory_xact_lock(20261103, 1);
  -- Publicação em passos em andamento (20261111120000): os rótulos físicos misturam a foto velha e a nova
  -- — o agregado segue o da foto vigente até a virada (o tick seguinte recalcula).
  IF public.radar_lote_publicando() IS NOT NULL THEN
    RETURN jsonb_build_object('recalculou', false, 'adiado', 'publicacao_em_andamento',
                              'lote_em_publicacao', public.radar_lote_publicando());
  END IF;

  -- A regra "para visitar" lê a contabilidade calculada às 06:50 UTC (DEPOIS do marco): recalculada depois da
  -- dimensão, ela pede um recálculo no tick seguinte (07:35) — senão o mapa ficaria até 24 h atrás da fila.
  -- Lida DEPOIS do lock (parecer Codex): quem esperou o lock vê a contabilidade de agora.
  v_contabil := (SELECT s.calculado_em FROM public.radar_contato_contabil_estado s WHERE s.id);

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

  -- Impressão digital ANTES de qualquer cálculo (índices, nunca o heap). Igual à do último completo = nenhuma
  -- escrita mudou dimensão: só o relógio andou, e só quem cruzou o corte muda de grupo.
  v_impressao := private.radar_agregado_impressao();
  v_motivo := CASE
    WHEN COALESCE(p_forcar, false) THEN 'forcado'
    WHEN NOT v_tem_estado OR e.completo_em IS NULL OR e.impressao IS NULL THEN 'sem_completo'
    WHEN e.base_lote IS DISTINCT FROM v_lote OR e.base_iniciado_em IS DISTINCT FROM v_ini THEN 'lote'
    WHEN e.visitar_calculado_em IS DISTINCT FROM e.calculado_em
      OR e.visitar_base_contabil IS DISTINCT FROM v_contabil THEN 'contabilidade'
    WHEN e.completo_em <= p_agora - interval '6 days 12 hours' THEN 'rede'
    -- Os 2 escritores de privacidade (expurgo horário, reaplicação de exclusão) mudam contato/status sem updated_at.
    WHEN EXISTS (SELECT 1 FROM public.radar_exclusoes_titular x WHERE x.escopo = 'contato') THEN 'exclusao_contato'
    WHEN e.impressao IS DISTINCT FROM v_impressao THEN 'escrita'
    WHEN e.corte_estabelecida IS NULL OR v_corte < e.corte_estabelecida THEN 'corte'
  END;

  IF v_motivo IS NULL THEN
    BEGIN
      MERGE INTO public.radar_agregado_cnae t
      USING (SELECT * FROM private.radar_agregado_delta_corte(e.corte_estabelecida, v_corte, v_ini, e.cnaes_secundarios_cobertos) d
              WHERE d.cnae_secundario IS NULL) d
         ON t.lote = d.lote AND t.prospeccao_status = d.prospeccao_status AND t.ja_cliente = d.ja_cliente
        AND t.tem_telefone = d.tem_telefone AND t.tem_contato = d.tem_contato AND t.inedito = d.inedito
        AND t.cnae_principal = d.cnae_principal AND t.estabelecida = d.estabelecida
        AND t.estabelecida_d1 = d.estabelecida_d1 AND t.visitar IS NOT DISTINCT FROM d.visitar
        AND t.municipio_codigo IS NOT DISTINCT FROM d.municipio_codigo AND t.uf IS NOT DISTINCT FROM d.uf
        AND t.municipio_nome IS NOT DISTINCT FROM d.municipio_nome
      WHEN MATCHED AND t.n + d.dn = 0 THEN DELETE
      WHEN MATCHED THEN UPDATE SET n = t.n + d.dn
      WHEN NOT MATCHED THEN
        INSERT (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
                tem_telefone, tem_contato, inedito, cnae_principal, estabelecida, estabelecida_d1, visitar, n)
        VALUES (d.lote, d.municipio_codigo, d.uf, d.municipio_nome, d.prospeccao_status, d.ja_cliente,
                d.tem_telefone, d.tem_contato, d.inedito, d.cnae_principal, d.estabelecida, d.estabelecida_d1, d.visitar, d.dn);
      GET DIAGNOSTICS v_fino = ROW_COUNT;

      MERGE INTO public.radar_agregado_cnae_sec t
      USING (SELECT * FROM private.radar_agregado_delta_corte(e.corte_estabelecida, v_corte, v_ini, e.cnaes_secundarios_cobertos) d
              WHERE d.cnae_secundario IS NOT NULL) d
         ON t.lote = d.lote AND t.prospeccao_status = d.prospeccao_status AND t.ja_cliente = d.ja_cliente
        AND t.tem_telefone = d.tem_telefone AND t.tem_contato = d.tem_contato AND t.inedito = d.inedito
        AND t.cnae_principal = d.cnae_principal AND t.cnae_secundario = d.cnae_secundario
        AND t.estabelecida = d.estabelecida AND t.estabelecida_d1 = d.estabelecida_d1
        AND t.visitar IS NOT DISTINCT FROM d.visitar
        AND t.municipio_codigo IS NOT DISTINCT FROM d.municipio_codigo AND t.uf IS NOT DISTINCT FROM d.uf
        AND t.municipio_nome IS NOT DISTINCT FROM d.municipio_nome
      WHEN MATCHED AND t.n + d.dn = 0 THEN DELETE
      WHEN MATCHED THEN UPDATE SET n = t.n + d.dn
      WHEN NOT MATCHED THEN
        INSERT (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
                tem_telefone, tem_contato, inedito, cnae_principal, cnae_secundario, estabelecida, estabelecida_d1, visitar, n)
        VALUES (d.lote, d.municipio_codigo, d.uf, d.municipio_nome, d.prospeccao_status, d.ja_cliente,
                d.tem_telefone, d.tem_contato, d.inedito, d.cnae_principal, d.cnae_secundario, d.estabelecida,
                d.estabelecida_d1, d.visitar, d.dn);
      GET DIAGNOSTICS v_sec = ROW_COUNT;

      -- Escrita que commitou entre a impressão e o delta: as duas leituras do delta podem ser de fotos diferentes.
      IF private.radar_agregado_impressao() IS DISTINCT FROM v_impressao THEN
        RAISE EXCEPTION 'impressao mudou durante o delta' USING ERRCODE = 'RA001';
      END IF;

      UPDATE public.radar_agregado_estado
         SET corte_estabelecida = v_corte, calculado_em = p_agora, visitar_calculado_em = p_agora
       WHERE id = 1;
    EXCEPTION
      -- CHECK (n > 0): saldo negativo sem grupo ou abaixo de zero = o agregado não é o que a impressão diz.
      WHEN check_violation THEN v_motivo := 'delta_inconsistente';
      WHEN cardinality_violation THEN v_motivo := 'delta_inconsistente';
      WHEN SQLSTATE 'RA001' THEN v_motivo := 'escrita_durante_delta';
    END;
    IF v_motivo IS NULL THEN
      RETURN jsonb_build_object('recalculou', true, 'modo', 'incremental', 'lote', v_lote,
                                'empresas', e.empresas, 'grupos', e.grupos,
                                'corte_anterior', e.corte_estabelecida, 'corte_estabelecida', v_corte,
                                'grupos_alterados', v_fino + v_sec, 'completo_em', e.completo_em,
                                'calculado_em', p_agora);
    END IF;
    -- O bloco voltou atrás: impressão relida para o completo abaixo.
    v_impressao := private.radar_agregado_impressao();
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
                                                  cnaes_secundarios_cobertos, visitar_calculado_em, visitar_base_contabil,
                                                  completo_em, impressao)
  VALUES (1, v_lote, v_ini, p_agora, v_empresas, v_grupos, v_corte, v_cobertos, p_agora, v_contabil, p_agora, v_impressao)
  ON CONFLICT (id) DO UPDATE
     SET base_lote = EXCLUDED.base_lote, base_iniciado_em = EXCLUDED.base_iniciado_em,
         calculado_em = EXCLUDED.calculado_em, empresas = EXCLUDED.empresas, grupos = EXCLUDED.grupos,
         corte_estabelecida = EXCLUDED.corte_estabelecida,
         cnaes_secundarios_cobertos = EXCLUDED.cnaes_secundarios_cobertos,
         visitar_calculado_em = EXCLUDED.visitar_calculado_em,
         visitar_base_contabil = EXCLUDED.visitar_base_contabil,
         completo_em = EXCLUDED.completo_em, impressao = EXCLUDED.impressao;

  RETURN jsonb_build_object('recalculou', true, 'modo', 'completo', 'motivo', v_motivo, 'lote', v_lote,
                            'empresas', v_empresas, 'grupos', v_grupos, 'para_visitar', v_visitar,
                            'corte_estabelecida', v_corte, 'cnaes_secundarios_cobertos', cardinality(v_cobertos),
                            'calculado_em', p_agora);
END
$function$;

-- 5) Semente: o agregado vigente veio de um completo; sem escrita depois dele, a impressão de agora é a dele ------
UPDATE public.radar_agregado_estado e
   SET completo_em = e.calculado_em, impressao = private.radar_agregado_impressao()
 WHERE e.id = 1
   AND e.completo_em IS NULL
   AND e.visitar_calculado_em = e.calculado_em
   AND e.visitar_base_contabil IS NOT DISTINCT FROM (SELECT s.calculado_em FROM public.radar_contato_contabil_estado s WHERE s.id)
   AND private.radar_agregado_valido() IS NOT NULL   -- lote e início do lote = os do agregado
   AND COALESCE((SELECT max(re.updated_at) FROM public.radar_empresas re) <= e.calculado_em, true)
   AND COALESCE((SELECT max(k.criado_em) FROM public.radar_contato_contabil_correcoes k) <= e.calculado_em, true)
   AND COALESCE((SELECT max(x.registrado_em) FROM public.radar_exclusoes_titular x) <= e.calculado_em, true)
   AND NOT EXISTS (SELECT 1 FROM public.radar_exclusoes_titular x WHERE x.escopo = 'contato');

-- PÓS: o estado que o cron precisa, relido do catálogo ---------------------------------------------------------
DO $post$
DECLARE
  c_rec CONSTANT text := 'public.radar_agregado_recalcular(boolean,timestamp with time zone)';
  f text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'radar_agregado_estado'
         AND column_name IN ('completo_em', 'impressao')) <> 2 THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_agregado_estado sem completo_em/impressao';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(c_rec)) IS DISTINCT FROM '209066abac30ebc4cb8b54c1e55346c3'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('private.radar_agregado_delta_corte(date,date,timestamp with time zone,text[])'))
        IS DISTINCT FROM 'bc0a659e2ee76728a47f737ee9aae162'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('private.radar_agregado_impressao()'))
        IS DISTINCT FROM '570f951899fcf167f6902cef8e2ded79' THEN
    RAISE EXCEPTION 'P2 FALHOU: corpo vivo do recálculo, do delta ou da impressão diverge deste arquivo';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(c_rec)) THEN
    RAISE EXCEPTION 'P3 FALHOU: recálculo deixou de ser SECURITY DEFINER';
  END IF;
  FOREACH f IN ARRAY ARRAY[c_rec, 'private.radar_agregado_delta_corte(date,date,timestamp with time zone,text[])',
                           'private.radar_agregado_impressao()'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P4 FALHOU: % executável por anon/authenticated', f;
    END IF;
  END LOOP;
END
$post$;
