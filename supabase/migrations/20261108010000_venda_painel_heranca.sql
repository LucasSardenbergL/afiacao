-- Sucessor declarado, entrega 3 — o PAINEL DE GESTÃO (venda_painel) separa a parte HERDADA.
-- Base: PR B (20261107210000, a coluna venda_sugestao.sucessao_origem que o gerador preenche) e PR C
-- (20261108000000, os consumidores do vendedor), ambos em prod desde 2026-11-07.
--
-- O que esta migration faz: RECRIA `public.venda_painel(p_de, p_ate)` do corpo VIVO (md5 78d9e58f…, lido em prod
-- via psql-ro em 2026-11-07 — o mesmo da 20261020235000), só ACRESCENTANDO seis chaves a cada linha
-- farmer × semana:
--   - `herdadas`: {na_lista, sugestoes, virou, nao_virou, nao_medivel, pendentes, receita_realizada,
--     receita_incompleta} — as MESMAS réguas da linha (fase ativa; desfecho e receita só de recompra), restritas às
--     sugestões com `sucessao_origem`. Ausente ≠ zero: `receita_realizada` NULL sem venda casada herdada.
--   - `taxa_ativa_propria`: virou ÷ (virou + não virou) SEM as herdadas (NULL com denominador 0). O histórico de
--     uma sugestão herdada inclui compras da antiga.
--   - `base_historico_propria` / `taxa_base_historico_propria` e `base_sombra_propria` / `taxa_base_sombra_propria`:
--     a linha de base com a mesma régua (sem herdadas). O gerador grava a origem nas TRÊS fases, então a base antiga
--     também mistura: própria se compara com própria (P2 do Codex).
-- Nada sai, nada muda de valor: tirando as seis chaves, o JSON é o do corpo anterior (provado em PG17).
--
-- Não muda: o gate (master), o período, as ondas, a linha de base, o ACL, nenhuma outra função.
-- Prova PG17: db/test-venda-painel-heranca.sh (controle + sabotagens, os dois locales).
-- Validação pós-apply: db/validar-venda-painel-heranca.sql (via psql-ro).
--
-- Molde TRAVA → PRE → CREATE → PÓS. Sem BEGIN/COMMIT: o SQL Editor roda o script inteiro numa transação implícita.
-- Idempotente.

SET LOCAL lock_timeout = '5s';

-- ── 0. TRAVA (antes de ler): ALTER sem efeito, com a volatilidade VIVA, na função que este arquivo recria ─────
DO $trava$
BEGIN
  IF to_regprocedure('public.venda_painel(date,date)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: public.venda_painel(date,date) ausente';
  END IF;
  ALTER FUNCTION public.venda_painel(date, date) STABLE;
END
$trava$;

-- ── PRE: a base (a coluna do PR B) e o corpo vivo ∈ {o lido em prod, este} ───────────────────────────────────
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.venda_painel(date,date)'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'venda_sugestao' AND column_name = 'sucessao_origem') THEN
    RAISE EXCEPTION 'PRE FALHOU: falta venda_sugestao.sucessao_origem (PR B do plano de rateio, 20261107210000)';
  END IF;
  IF v_vivo IS NULL OR NOT (v_vivo = ANY (ARRAY['78d9e58f73c7fb3a902f864a2e131993', '2b3f2c1b9af99c6dcc34f413f9534c54'])) THEN
    RAISE EXCEPTION 'PRE FALHOU: public.venda_painel vivo (md5 %) não é o corpo revisado', v_vivo;
  END IF;
END
$pre$;

-- ── 1. O painel: + a parte herdada de cada linha, sem mudar nada do que já sai ───────────────────────────────
CREATE OR REPLACE FUNCTION public.venda_painel(p_de date, p_ate date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_ini date;
  v_fim date;   -- exclusivo
  v_cfg_on1 boolean; v_cfg_on2 boolean; v_cfg_on3 boolean;
  v_base_confiavel boolean;
  v_linhas jsonb;
  v_hist_dias int;
  v_sombra_dias jsonb := '[]'::jsonb;
  v_d date;
  v_semanas jsonb := '[]'::jsonb;
  v_seg date;
  v_n_farmers int;
  v_min_taxa numeric;
  v_repasse boolean;
  v_ondas jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'venda_painel: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_de IS NULL OR p_ate IS NULL OR p_ate < p_de OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'PAINEL_PERIODO: periodo invalido (de=%, ate=%; maximo 400 dias)', p_de, p_ate
      USING ERRCODE = '22023';
  END IF;

  -- semanas inteiras (seg–dom) que tocam o período
  v_ini := date_trunc('week', p_de)::date;
  v_fim := date_trunc('week', p_ate)::date + 7;

  SELECT COALESCE(bool_or(chave = 'onda_recompra'    AND valor = 'true'::jsonb), false),
         COALESCE(bool_or(chave = 'onda_complemento' AND valor = 'true'::jsonb), false),
         COALESCE(bool_or(chave = 'onda_preco'       AND valor = 'true'::jsonb), false)
    INTO v_cfg_on1, v_cfg_on2, v_cfg_on3
    FROM public.venda_config;

  v_base_confiavel := EXISTS (SELECT 1 FROM public.venda_onda_log WHERE onda = 'onda_recompra');

  -- ── por farmer × semana ────────────────────────────────────────────────────────────────────
  WITH semanas AS (
    SELECT g::date AS semana FROM generate_series(v_ini, v_fim - 7, interval '7 days') g
  ),
  farmers AS (
    SELECT cr.user_id AS farmer_user_id
      FROM public.commercial_roles cr
     WHERE cr.commercial_role = 'farmer'
    UNION
    SELECT DISTINCT s.farmer_user_id
      FROM public.venda_sugestao s
     WHERE s.fase IN ('ativa', 'sombra') AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
  ),
  ativa AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana,
           count(DISTINCT s.comprador_id)                                              AS na_lista,
           count(DISTINCT s.comprador_id) FILTER (WHERE s.mostrada_em IS NOT NULL)     AS mostradas,
           count(DISTINCT s.comprador_id) FILTER (WHERE s.tipo = 'recompra'
                                                    AND s.desfecho = 'virou_pedido')   AS compraram,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho IS NULL)          AS pendentes,
           sum(s.valor_realizado) FILTER (WHERE s.tipo = 'recompra'
                                            AND s.desfecho = 'virou_pedido')           AS receita,
           COALESCE(bool_or(s.tipo = 'recompra' AND s.desfecho = 'virou_pedido'
                            AND s.valor_realizado IS NULL), false)                     AS receita_incompleta,
           -- sucessor declarado (entrega 3): a fatia HERDADA (sucessao_origem preenchida pelo gerador) — as
           -- mesmas réguas de cima, só restritas a ela; a taxa própria sai por diferença, no SELECT final
           count(DISTINCT s.comprador_id) FILTER (WHERE s.sucessao_origem IS NOT NULL)   AS h_na_lista,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL)                         AS h_sugestoes,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho = 'virou_pedido')                           AS h_virou,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho = 'nao_virou')                              AS h_nao_virou,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho = 'nao_medivel')                            AS h_nao_medivel,
           count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho IS NULL)                                    AS h_pendentes,
           sum(s.valor_realizado) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                                            AND s.desfecho = 'virou_pedido')           AS h_receita,
           COALESCE(bool_or(s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                            AND s.desfecho = 'virou_pedido' AND s.valor_realizado IS NULL), false)
                                                                                         AS h_receita_incompleta
      FROM public.venda_sugestao s
     WHERE s.fase = 'ativa' AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
     GROUP BY 1, 2
  ),
  lista AS (
    SELECT DISTINCT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana, s.comprador_id
      FROM public.venda_sugestao s
     WHERE s.fase = 'ativa' AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
  ),
  contatos AS (
    SELECT l.farmer_user_id, l.semana, count(*) AS contatados
      FROM lista l
     WHERE EXISTS (SELECT 1 FROM public.venda_contato c
                    WHERE c.farmer_user_id = l.farmer_user_id AND c.comprador_id = l.comprador_id
                      AND c.dia >= l.semana AND c.dia < l.semana + 7)
     GROUP BY 1, 2
  ),
  sombra AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana,
           count(DISTINCT s.comprador_id) AS na_lista
      FROM public.venda_sugestao s
     WHERE s.fase = 'sombra' AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
     GROUP BY 1, 2
  ),
  -- mesma semana do ano anterior: 52 semanas = 364 dias (segunda cai em segunda)
  hist AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date + 364 AS semana,
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL)          AS pendentes,
           -- a base PRÓPRIA (sem herdadas): o gerador grava a origem nas três fases, então a base também mistura
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido' AND s.sucessao_origem IS NULL) AS p_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou'    AND s.sucessao_origem IS NULL) AS p_nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel'  AND s.sucessao_origem IS NULL) AS p_nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL          AND s.sucessao_origem IS NULL) AS p_pendentes
      FROM public.venda_sugestao s
     WHERE s.fase = 'historico' AND s.tipo = 'recompra'
       AND s.dia_referencia >= v_ini - 364 AND s.dia_referencia < v_fim - 364
     GROUP BY 1, 2
  ),
  -- sombra (antes do go-live) inteira, por farmer — a 2ª linha de base
  base_sombra AS (
    SELECT s.farmer_user_id,
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL)          AS pendentes,
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido' AND s.sucessao_origem IS NULL) AS p_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou'    AND s.sucessao_origem IS NULL) AS p_nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel'  AND s.sucessao_origem IS NULL) AS p_nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL          AND s.sucessao_origem IS NULL) AS p_pendentes
      FROM public.venda_sugestao s
     WHERE s.fase = 'sombra' AND s.tipo = 'recompra'
     GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'farmer_user_id',   f.farmer_user_id,
           'farmer_nome',      p.name,
           'semana',           sm.semana,
           'na_lista',         COALESCE(a.na_lista, 0),
           'mostradas',        COALESCE(a.mostradas, 0),
           'contatados',       COALESCE(ct.contatados, 0),
           'compraram',        COALESCE(a.compraram, 0),
           'virou',            COALESCE(a.virou, 0),
           'nao_virou',        COALESCE(a.nao_virou, 0),
           'nao_medivel',      COALESCE(a.nao_medivel, 0),
           'pendentes',        COALESCE(a.pendentes, 0),
           -- ausente ≠ zero: sem nenhuma venda casada a receita é NULL, não R$ 0
           'receita_realizada', a.receita,
           'receita_incompleta', COALESCE(a.receita_incompleta, false),
           'taxa_ativa',       round(a.virou::numeric / NULLIF(a.virou + a.nao_virou, 0), 4),
           'na_lista_sombra',  COALESCE(so.na_lista, 0),
           'base_historico',   jsonb_build_object(
                                 'virou', COALESCE(h.virou, 0), 'nao_virou', COALESCE(h.nao_virou, 0),
                                 'nao_medivel', COALESCE(h.nao_medivel, 0), 'pendentes', COALESCE(h.pendentes, 0)),
           'taxa_base_historico_mesma_semana', round(h.virou::numeric / NULLIF(h.virou + h.nao_virou, 0), 4),
           'base_sombra',      jsonb_build_object(
                                 'virou', COALESCE(bs.virou, 0), 'nao_virou', COALESCE(bs.nao_virou, 0),
                                 'nao_medivel', COALESCE(bs.nao_medivel, 0), 'pendentes', COALESCE(bs.pendentes, 0)),
           'taxa_base_sombra', round(bs.virou::numeric / NULLIF(bs.virou + bs.nao_virou, 0), 4),
           'base_confiavel',   v_base_confiavel,
           -- sucessor declarado: a parte herdada da linha (ausente ≠ zero: receita NULL sem venda casada)
           'herdadas',         jsonb_build_object(
                                 'na_lista', COALESCE(a.h_na_lista, 0), 'sugestoes', COALESCE(a.h_sugestoes, 0),
                                 'virou', COALESCE(a.h_virou, 0), 'nao_virou', COALESCE(a.h_nao_virou, 0),
                                 'nao_medivel', COALESCE(a.h_nao_medivel, 0), 'pendentes', COALESCE(a.h_pendentes, 0),
                                 'receita_realizada', a.h_receita,
                                 'receita_incompleta', COALESCE(a.h_receita_incompleta, false)),
           -- a conversão SEM as herdadas: o histórico delas inclui compras da antiga, a própria não
           'taxa_ativa_propria', round((a.virou - a.h_virou)::numeric
                                       / NULLIF((a.virou - a.h_virou) + (a.nao_virou - a.h_nao_virou), 0), 4),
           -- e a linha de base com a MESMA régua (sem herdadas): própria × própria, nunca própria × mistura
           'base_historico_propria', jsonb_build_object(
                                 'virou', COALESCE(h.p_virou, 0), 'nao_virou', COALESCE(h.p_nao_virou, 0),
                                 'nao_medivel', COALESCE(h.p_nao_medivel, 0), 'pendentes', COALESCE(h.p_pendentes, 0)),
           'taxa_base_historico_propria', round(h.p_virou::numeric / NULLIF(h.p_virou + h.p_nao_virou, 0), 4),
           'base_sombra_propria', jsonb_build_object(
                                 'virou', COALESCE(bs.p_virou, 0), 'nao_virou', COALESCE(bs.p_nao_virou, 0),
                                 'nao_medivel', COALESCE(bs.p_nao_medivel, 0), 'pendentes', COALESCE(bs.p_pendentes, 0)),
           'taxa_base_sombra_propria', round(bs.p_virou::numeric / NULLIF(bs.p_virou + bs.p_nao_virou, 0), 4)
         ) ORDER BY p.name NULLS LAST, f.farmer_user_id, sm.semana DESC), '[]'::jsonb)
    INTO v_linhas
    FROM farmers f
   CROSS JOIN semanas sm
    LEFT JOIN public.profiles p ON p.user_id = f.farmer_user_id
    LEFT JOIN ativa a     ON a.farmer_user_id = f.farmer_user_id AND a.semana = sm.semana
    LEFT JOIN contatos ct ON ct.farmer_user_id = f.farmer_user_id AND ct.semana = sm.semana
    LEFT JOIN sombra so   ON so.farmer_user_id = f.farmer_user_id AND so.semana = sm.semana
    LEFT JOIN hist h      ON h.farmer_user_id = f.farmer_user_id AND h.semana = sm.semana
    LEFT JOIN base_sombra bs ON bs.farmer_user_id = f.farmer_user_id;

  -- ── ondas: estado + pré-requisitos da PRÓXIMA avaliação (leitura; quem liga é o cron) ──────────
  -- Onda 1: as mesmas condições baratas de venda_avaliar_ondas (dias de histórico, sombra ao vivo
  -- nos 3 dias anteriores). A comparação de lista idêntica é do cron (custa ~8 s/dia).
  SELECT count(*) INTO v_hist_dias
    FROM public.venda_gerador_execucao WHERE fase = 'historico' AND dia_referencia < v_hoje;
  FOR i IN 1..3 LOOP
    v_d := v_hoje - i;
    v_sombra_dias := v_sombra_dias || jsonb_build_object('dia', v_d, 'ao_vivo', EXISTS (
      SELECT 1 FROM public.venda_gerador_execucao e
       WHERE e.dia_referencia = v_d AND e.fase = 'sombra'
         AND (e.primeira_em AT TIME ZONE 'America/Sao_Paulo')::date = v_d));
  END LOOP;

  -- Onda 2: ≥ 80% de contatados por farmer em cada uma das 2 últimas semanas completas.
  FOR i IN 1..2 LOOP
    v_seg := date_trunc('week', v_hoje)::date - 7 * i;
    WITH lista AS (
      SELECT DISTINCT s.farmer_user_id, s.comprador_id
        FROM public.venda_sugestao s
       WHERE s.fase = 'ativa' AND s.dia_referencia >= v_seg AND s.dia_referencia < v_seg + 7
    ),
    por_farmer AS (
      SELECT l.farmer_user_id,
             (count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM public.venda_contato c
                 WHERE c.farmer_user_id = l.farmer_user_id AND c.comprador_id = l.comprador_id
                   AND c.dia >= v_seg AND c.dia < v_seg + 7)))::numeric / count(*) AS taxa
        FROM lista l
       GROUP BY l.farmer_user_id
    )
    SELECT count(*), min(pf.taxa) INTO v_n_farmers, v_min_taxa FROM por_farmer pf;
    v_semanas := v_semanas || jsonb_build_object('semana', v_seg, 'farmers', v_n_farmers,
                                                 'menor_taxa', round(v_min_taxa, 4),
                                                 'ok', v_n_farmers > 0 AND v_min_taxa >= 0.8);
  END LOOP;

  -- Onda 3: ≥ 1 repasse aprovado vigente (tabela da Task 6; ausente = NULL, "não sei", não false).
  v_repasse := NULL;
  IF to_regclass('public.venda_repasse_aprovado') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.venda_repasse_aprovado
                               WHERE revogado_em IS NULL AND valido_ate >= $1)'
         INTO v_repasse USING v_hoje;
    EXCEPTION WHEN undefined_column OR undefined_table THEN
      v_repasse := NULL;
    END;
  END IF;

  SELECT jsonb_build_object(
    'onda_recompra', jsonb_build_object(
      'ligada', v_cfg_on1,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_recompra'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_recompra'),
      'prerequisitos', jsonb_build_object(
        'historico_dias', v_hist_dias, 'historico_meta', 365,
        'sombra_ao_vivo', v_sombra_dias,
        -- o cron avalia e DEPOIS gera a lista do dia: lista de hoje gravada = avaliação de hoje já rodou
        'avaliada_hoje', EXISTS (SELECT 1 FROM public.venda_gerador_execucao e
                                  WHERE e.dia_referencia = v_hoje AND e.fase IN ('sombra', 'ativa')))),
    'onda_complemento', jsonb_build_object(
      'ligada', v_cfg_on2,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_complemento'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_complemento'),
      'prerequisitos', jsonb_build_object('onda_recompra_ligada', v_cfg_on1, 'semanas', v_semanas)),
    'onda_preco', jsonb_build_object(
      'ligada', v_cfg_on3,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_preco'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_preco'),
      'prerequisitos', jsonb_build_object('onda_complemento_ligada', v_cfg_on2, 'repasse_vigente', v_repasse)))
    INTO v_ondas;

  RETURN jsonb_build_object(
    'hoje', v_hoje,
    'periodo', jsonb_build_object('de', v_ini, 'ate', v_fim - 1),
    'base_confiavel', v_base_confiavel,
    'repasse_disponivel', to_regprocedure('public.venda_repasse_candidatos()') IS NOT NULL,
    'linhas', v_linhas,
    'ondas', v_ondas);
END
$function$;

REVOKE ALL ON FUNCTION public.venda_painel(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_painel(date, date) TO authenticated;

-- ── PÓS: relê o catálogo; qualquer estado insuficiente aborta a transação inteira ───────────────────────────
DO $pos$
DECLARE
  v_oid regprocedure := to_regprocedure('public.venda_painel(date,date)');
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM '2b3f2c1b9af99c6dcc34f413f9534c54' THEN
    RAISE EXCEPTION 'PÓS FALHOU: public.venda_painel não ficou com o corpo deste arquivo';
  END IF;
  IF NOT (SELECT p.prosecdef AND p.provolatile = 's' FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'PÓS FALHOU: public.venda_painel não é STABLE SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('public', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PÓS FALHOU: ACL de public.venda_painel (anon/PUBLIC fechados, authenticated aberto)';
  END IF;
END
$pos$;
