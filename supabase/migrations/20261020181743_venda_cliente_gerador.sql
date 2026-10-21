-- ============================================================================================
-- Venda por cliente — Task 4: GERADOR D-1, reconstrução histórica e sombra
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md §7 Fase 2, §8 (ondas)
-- Plano: docs/superpowers/plans/2026-10-20-venda-por-cliente.md, Task 4
-- Prova PG17: db/test-venda-gerador.sh (os dois locales + --falsificar)
-- Depende de (já em prod): 20261020174221_venda_cliente_espinha (venda_sugestao, venda_config,
-- venda_fechar_desfechos) e 20261020150000_venda_cliente_recompra (venda_recompra_em, venda_situacao_em).
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR, por isso este arquivo NÃO
-- leva BEGIN/COMMIT. Idempotente: objetos novos com IF NOT EXISTS / CREATE OR REPLACE, cron por nome,
-- nenhuma escrita em venda_config (re-aplicar nunca desliga onda já ligada).
--
-- Decisões que o plano deixou ao construtor (registradas no PR):
--  • A lista do dia D é a UNIÃO de (a) compradores com SKU atrasado cuja cidade recebe entrega em D+1
--    e (b) os `teto_maiores_atrasos` compradores de maior valor esperado em atraso FORA de (a). O corte
--    só vale no eixo (b); (a) não tem teto (CLAUDE.md: corte por ranking só no eixo da decisão).
--  • Ranking de (b): SUM(valor_esperado) DESC NULLS LAST, desempate por comprador_id — determinístico,
--    porque a Onda 1 compara a lista ao vivo com a reconstruída. Comprador cujos atrasados não têm
--    preço fica com soma NULL (ausente ≠ zero) e vai para o fim, nunca entra como "R$ 0".
--  • Cidade do comprador = qualquer cadastro dele (alias → canônico) em customer_visit_scores, com a
--    mesma regra da fila de rota: city_norm igual e UF só desempata quando os DOIS lados têm UF
--    (cityKeyEquals de src/lib/whatsapp/route-city.ts). A UF do cadastro sai do texto `city` como no
--    normalizeCityKey — por isso o helper private.venda_city_uf, irmão de route_city_norm.
--  • venda_cidades_alvo é porta LITERAL de resolvePrepForWorkday: rota de D+1 de CALENDÁRIO (não
--    "próximo dia útil": a rota de prod é ter–sex, então sexta prepara sábado = só as diárias, igual à
--    fila de rota), + cidades diárias sempre, cancelamento por route_calendar_override(D+1).
--  • Reconstrução usa a carteira, a agenda de rota e a cidade ATUAIS (spec §7 Fase 2: "com a carteira
--    atual"); só os pedidos são recortados na data (venda_recompra_em/venda_situacao_em(d) usam < d).
--  • venda_gerador_execucao registra cada rodada (dia × fase): distingue "rodou e deu 0" de "não
--    rodou", e é a prova de que a reconstrução cobre 365 dias (Onda 1 exige isso, não "existe 1 linha").
--  • Onda 1 só conta um dia de sombra GERADO NAQUELE DIA (primeira_em no dia SP): sombra gravada a
--    posteriori não é "lista ao vivo". Lista vazia nos dois lados conta como idêntica (rodou e deu 0).
--  • Onda 2: por semana completa (seg–dom), cada farmer com linhas ativas tem ≥ 80% dos compradores
--    da lista com contato registrado na mesma semana; semana sem nenhuma lista ativa = sem evidência.
--  • Onda 3: tabela da Task 6 (venda_repasse_aprovado) via to_regclass + EXECUTE; se ela ainda não
--    existir ou tiver outra forma (42P01/42703), a condição é FALSA e o cron segue gerando a lista.
-- ============================================================================================

-- ── 1. Registro das rodadas do gerador e das ondas ligadas ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.venda_gerador_execucao (
  dia_referencia date        NOT NULL,
  fase           text        NOT NULL CHECK (fase IN ('historico','sombra','ativa')),
  primeira_em    timestamptz NOT NULL DEFAULT now(),
  ultima_em      timestamptz NOT NULL DEFAULT now(),
  linhas         integer     NOT NULL CHECK (linhas >= 0),
  PRIMARY KEY (dia_referencia, fase)
);

CREATE TABLE IF NOT EXISTS public.venda_onda_log (
  onda      text        PRIMARY KEY CHECK (onda IN ('onda_recompra','onda_complemento','onda_preco')),
  ligada_em timestamptz NOT NULL DEFAULT now(),
  condicao  jsonb       NOT NULL
);

ALTER TABLE public.venda_gerador_execucao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venda_onda_log         ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.venda_gerador_execucao, public.venda_onda_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.venda_gerador_execucao, public.venda_onda_log TO authenticated;
GRANT ALL ON public.venda_gerador_execucao, public.venda_onda_log TO service_role;

DROP POLICY IF EXISTS venda_gerador_execucao_select_master ON public.venda_gerador_execucao;
CREATE POLICY venda_gerador_execucao_select_master ON public.venda_gerador_execucao FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role));

DROP POLICY IF EXISTS venda_onda_log_select_master ON public.venda_onda_log;
CREATE POLICY venda_onda_log_select_master ON public.venda_onda_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role));

-- ── 2. UF do texto de cidade do cadastro (parte UF de normalizeCityKey) ──────────────────────
-- Mesma normalização e mesma precedência de public.route_city_norm (20260611150000), mas devolve a
-- UF que aquela descarta. '' = cadastro sem UF (casa por cidade, como no cityKeyEquals).
CREATE OR REPLACE FUNCTION private.venda_city_uf(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $func$
DECLARE
  s text;
BEGIN
  IF raw IS NULL THEN
    RETURN '';
  END IF;
  s := regexp_replace(raw, '[   -     　﻿]', ' ', 'g');
  s := btrim(upper(regexp_replace(normalize(s, NFD), '[̀-ͯ]', '', 'g')));
  IF s ~ '\([A-Z]{2}\)\s*$' THEN
    RETURN substring(s FROM '\(([A-Z]{2})\)\s*$');
  ELSIF s ~ '/\s*[A-Z]{2}\s*$' THEN
    RETURN substring(s FROM '/\s*([A-Z]{2})\s*$');
  ELSIF s ~ '\s[A-Z]{2}$' THEN
    RETURN substring(s FROM '\s([A-Z]{2})$');
  END IF;
  RETURN '';
END
$func$;
REVOKE ALL ON FUNCTION private.venda_city_uf(text) FROM PUBLIC, anon, authenticated;

-- ── 3. Cidades-alvo do dia de trabalho p_dia (porta de resolvePrepForWorkday) ────────────────
CREATE OR REPLACE FUNCTION public.venda_cidades_alvo(p_dia date)
RETURNS TABLE (city_norm text, uf text)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  -- Rota de D+1 (calendário) salvo cancelamento, + diárias sempre; dedup por cidade|UF.
  SELECT DISTINCT rs.city, rs.uf
    FROM public.route_schedule rs
   WHERE rs.ativo
     AND (rs.is_daily
          OR (rs.weekday = extract(dow FROM p_dia + 1)::int
              AND NOT EXISTS (SELECT 1 FROM public.route_calendar_override o
                               WHERE o.data = p_dia + 1 AND o.cancela_rota)))
$fn$;
REVOKE ALL ON FUNCTION public.venda_cidades_alvo(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_cidades_alvo(date) TO service_role;

-- ── 4. A lista do dia, calculada (sem gravar) — fonte única do gerador e da comparação da Onda 1 ─
CREATE OR REPLACE FUNCTION private.venda_lista_calc(p_dia date)
RETURNS TABLE (
  farmer_user_id      uuid,
  comprador_id        uuid,
  empresa             text,
  omie_codigo_produto bigint,
  qtd_ref             numeric,
  valor_ref           numeric,
  motivo_entrada      text
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_teto jsonb;
BEGIN
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_lista_calc: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  SELECT c.valor INTO v_teto FROM public.venda_config c WHERE c.chave = 'teto_maiores_atrasos';
  IF jsonb_typeof(v_teto) IS DISTINCT FROM 'number' OR (v_teto #>> '{}')::numeric < 0
     OR (v_teto #>> '{}')::numeric <> trunc((v_teto #>> '{}')::numeric) THEN
    RAISE EXCEPTION 'venda_lista_calc: venda_config.teto_maiores_atrasos ausente ou invalido' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH carteira AS (
    -- Só donos com papel comercial de farmer; comprador no id canônico (carteira guarda o alias).
    SELECT DISTINCT c.owner_user_id AS farmer, COALESCE(ca.canonical_user_id, c.customer_user_id) AS comprador
      FROM public.carteira_assignments c
      JOIN public.commercial_roles cr ON cr.user_id = c.owner_user_id AND cr.commercial_role = 'farmer'
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = c.customer_user_id AND ca.status = 'active'
     WHERE c.eligible
  ),
  situacao AS (
    SELECT s.comprador_id, s.situacao FROM public.venda_situacao_em(p_dia) s
  ),
  atrasado AS (
    -- Uma linha por comprador × empresa × SKU atrasado, de comprador que não está perdido.
    SELECT k.farmer, r.comprador_id AS comprador, r.empresa, r.omie_codigo_produto,
           r.qtd_sugerida, r.valor_esperado
      FROM public.venda_recompra_em(p_dia) r
      JOIN carteira k ON k.comprador = r.comprador_id
      JOIN situacao s ON s.comprador_id = r.comprador_id
     WHERE r.atrasado
       AND s.situacao <> 'perdido'
  ),
  alvo AS (
    SELECT a.city_norm, COALESCE(a.uf, '') AS uf FROM public.venda_cidades_alvo(p_dia) a
  ),
  na_rota AS (
    -- Comprador cuja cidade (de qualquer cadastro dele) recebe entrega amanhã; menor cidade desempata.
    SELECT x.comprador, min(x.city_norm) AS city_norm
      FROM (
        SELECT COALESCE(ca.canonical_user_id, v.customer_user_id) AS comprador, al.city_norm
          FROM public.customer_visit_scores v
          JOIN alvo al ON al.city_norm = v.city_norm
          LEFT JOIN public.customer_canonical_alias ca
                 ON ca.alias_user_id = v.customer_user_id AND ca.status = 'active'
         WHERE al.uf = '' OR private.venda_city_uf(v.city) = '' OR private.venda_city_uf(v.city) = al.uf
      ) x
     GROUP BY x.comprador
  ),
  comprador AS (
    SELECT t.farmer, t.comprador, sum(t.valor_esperado) AS valor_atrasado, nr.city_norm
      FROM atrasado t
      LEFT JOIN na_rota nr ON nr.comprador = t.comprador
     GROUP BY t.farmer, t.comprador, nr.city_norm
  ),
  ranqueado AS (
    SELECT c.farmer, c.comprador,
           row_number() OVER (PARTITION BY c.farmer
                              ORDER BY c.valor_atrasado DESC NULLS LAST, c.comprador) AS pos
      FROM comprador c
     WHERE c.city_norm IS NULL
  ),
  escolhido AS (
    SELECT c.farmer, c.comprador, 'entrega amanhã em ' || initcap(c.city_norm) AS motivo
      FROM comprador c
     WHERE c.city_norm IS NOT NULL
    UNION ALL
    SELECT r.farmer, r.comprador, 'maior atraso da carteira'
      FROM ranqueado r
     WHERE r.pos <= (v_teto #>> '{}')::int
  )
  SELECT t.farmer, t.comprador, t.empresa, t.omie_codigo_produto,
         CASE WHEN t.qtd_sugerida > 0 THEN t.qtd_sugerida END,
         CASE WHEN t.valor_esperado > 0 THEN t.valor_esperado END,      -- ausente = NULL, nunca 0
         e.motivo
    FROM atrasado t
    JOIN escolhido e ON e.farmer = t.farmer AND e.comprador = t.comprador;
END
$fn$;
REVOKE ALL ON FUNCTION private.venda_lista_calc(date) FROM PUBLIC, anon, authenticated;

-- ── 5. Gerador: grava a lista do dia (idempotente pela chave única da espinha) ───────────────
CREATE OR REPLACE FUNCTION public.venda_gerar_lista(p_dia date, p_fase text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_n     integer;
  v_total integer;
BEGIN
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_gerar_lista: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  IF p_fase IS NULL OR p_fase NOT IN ('historico','sombra','ativa') THEN
    RAISE EXCEPTION 'venda_gerar_lista: fase invalida' USING ERRCODE = '22023';
  END IF;
  IF p_fase = 'historico' AND p_dia >= (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'venda_gerar_lista: historico so para dia passado' USING ERRCODE = '22023';
  END IF;
  IF p_fase = 'ativa' AND NOT EXISTS (SELECT 1 FROM public.venda_config
                                       WHERE chave = 'onda_recompra' AND valor = 'true'::jsonb) THEN
    RAISE EXCEPTION 'venda_gerar_lista: fase ativa com onda_recompra desligada' USING ERRCODE = '22023';
  END IF;

  -- Uma rodada por vez (cron + reconstrução manual).
  PERFORM pg_advisory_xact_lock(hashtext('venda_gerar_lista'));

  INSERT INTO public.venda_sugestao
         (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto,
          qtd_ref, valor_ref, motivo_entrada)
  SELECT 'recompra', p_fase, p_dia, l.farmer_user_id, l.comprador_id, l.empresa, l.omie_codigo_produto,
         l.qtd_ref, l.valor_ref, l.motivo_entrada
    FROM private.venda_lista_calc(p_dia) l
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  SELECT count(*) INTO v_total
    FROM public.venda_sugestao
   WHERE dia_referencia = p_dia AND fase = p_fase AND tipo = 'recompra';

  INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, linhas)
  VALUES (p_dia, p_fase, v_total)
  ON CONFLICT (dia_referencia, fase)
  DO UPDATE SET ultima_em = now(), linhas = EXCLUDED.linhas;

  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.venda_gerar_lista(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_gerar_lista(date, text) TO service_role;

-- ── 6. Reconstrução histórica (linha de base) — rode em lotes de ~30 dias ────────────────────
CREATE OR REPLACE FUNCTION public.venda_reconstruir_historico(p_de date, p_ate date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_d date;
  v_n integer := 0;
BEGIN
  IF p_de IS NULL OR p_ate IS NULL OR p_de > p_ate THEN
    RAISE EXCEPTION 'venda_reconstruir_historico: intervalo invalido' USING ERRCODE = '22023';
  END IF;
  IF p_ate >= (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'venda_reconstruir_historico: p_ate tem de ser anterior a hoje' USING ERRCODE = '22023';
  END IF;

  v_d := p_de;
  WHILE v_d <= p_ate LOOP
    v_n := v_n + public.venda_gerar_lista(v_d, 'historico');
    v_d := v_d + 1;
  END LOOP;

  -- O futuro dessas datas já é conhecido: fecha os desfechos na hora.
  PERFORM public.venda_fechar_desfechos();
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.venda_reconstruir_historico(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_reconstruir_historico(date, date) TO service_role;

-- ── 7. Ondas: ligam sozinhas quando a condição vale; nunca desligam ──────────────────────────
CREATE OR REPLACE FUNCTION public.venda_avaliar_ondas(p_hoje date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_on1 boolean; v_on2 boolean; v_on3 boolean;
  v_hist_dias int;
  v_dias jsonb := '[]'::jsonb;
  v_d date;
  v_rodou boolean;
  v_diverg int;
  v_c1 boolean; v_c2 boolean; v_c3 boolean;
  v_semanas jsonb := '[]'::jsonb;
  v_seg date;
  v_sem_ok boolean;
  v_n_farmers int;
  v_min_taxa numeric;
  v_repasse boolean;
  v_repasse_erro text;
  v_cond jsonb;
  v_out jsonb;
BEGIN
  IF p_hoje IS NULL THEN
    RAISE EXCEPTION 'venda_avaliar_ondas: p_hoje NULL' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('venda_avaliar_ondas'));

  SELECT COALESCE(bool_or(chave = 'onda_recompra'    AND valor = 'true'::jsonb), false),
         COALESCE(bool_or(chave = 'onda_complemento' AND valor = 'true'::jsonb), false),
         COALESCE(bool_or(chave = 'onda_preco'       AND valor = 'true'::jsonb), false)
    INTO v_on1, v_on2, v_on3
    FROM public.venda_config;

  -- Onda 1: reconstrução de 365 dias carregada + 3 dias seguidos de sombra ao vivo idêntica.
  IF NOT v_on1 THEN
    SELECT count(*) INTO v_hist_dias
      FROM public.venda_gerador_execucao WHERE fase = 'historico' AND dia_referencia < p_hoje;
    v_c1 := v_hist_dias >= 365;
    FOR i IN 1..3 LOOP
      v_d := p_hoje - i;
      SELECT EXISTS (SELECT 1 FROM public.venda_gerador_execucao e
                      WHERE e.dia_referencia = v_d AND e.fase = 'sombra'
                        AND (e.primeira_em AT TIME ZONE 'America/Sao_Paulo')::date = v_d)
        INTO v_rodou;
      v_diverg := NULL;
      IF v_rodou THEN
        SELECT count(*) INTO v_diverg FROM (
          ( SELECT s.farmer_user_id, s.comprador_id, s.empresa, s.omie_codigo_produto
              FROM public.venda_sugestao s
             WHERE s.dia_referencia = v_d AND s.fase = 'sombra' AND s.tipo = 'recompra'
            EXCEPT
            SELECT l.farmer_user_id, l.comprador_id, l.empresa, l.omie_codigo_produto
              FROM private.venda_lista_calc(v_d) l )
          UNION ALL
          ( SELECT l.farmer_user_id, l.comprador_id, l.empresa, l.omie_codigo_produto
              FROM private.venda_lista_calc(v_d) l
            EXCEPT
            SELECT s.farmer_user_id, s.comprador_id, s.empresa, s.omie_codigo_produto
              FROM public.venda_sugestao s
             WHERE s.dia_referencia = v_d AND s.fase = 'sombra' AND s.tipo = 'recompra' )
        ) dif;
      END IF;
      v_dias := v_dias || jsonb_build_object('dia', v_d, 'sombra_ao_vivo', v_rodou, 'divergencias', v_diverg);
      v_c1 := v_c1 AND v_rodou AND v_diverg = 0;
    END LOOP;
    v_cond := jsonb_build_object('historico_dias', v_hist_dias, 'dias', v_dias);
    IF v_c1 THEN
      UPDATE public.venda_config SET valor = 'true'::jsonb, atualizado_em = now() WHERE chave = 'onda_recompra';
      INSERT INTO public.venda_onda_log (onda, condicao) VALUES ('onda_recompra', v_cond)
      ON CONFLICT (onda) DO NOTHING;
      v_on1 := true;
    END IF;
    v_out := jsonb_build_object('onda_recompra', jsonb_build_object(
               'ligada', v_c1, 'ligou_agora', v_c1, 'condicao', v_cond));
  ELSE
    v_out := jsonb_build_object('onda_recompra', jsonb_build_object('ligada', true, 'ligou_agora', false));
  END IF;

  -- Onda 2: Onda 1 ligada + ≥ 80% dos compradores da lista contatados, por farmer, em cada uma das
  -- 2 últimas semanas completas (seg–dom).
  IF NOT v_on2 THEN
    v_c2 := v_on1;
    FOR i IN 1..2 LOOP
      v_seg := date_trunc('week', p_hoje)::date - 7 * i;
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
      v_sem_ok := v_n_farmers > 0 AND v_min_taxa >= 0.8;
      v_semanas := v_semanas || jsonb_build_object('semana', v_seg, 'farmers', v_n_farmers,
                                                   'menor_taxa', v_min_taxa, 'ok', v_sem_ok);
      v_c2 := v_c2 AND v_sem_ok;
    END LOOP;
    v_cond := jsonb_build_object('onda_recompra_ligada', v_on1, 'semanas', v_semanas);
    IF v_c2 THEN
      UPDATE public.venda_config SET valor = 'true'::jsonb, atualizado_em = now() WHERE chave = 'onda_complemento';
      INSERT INTO public.venda_onda_log (onda, condicao) VALUES ('onda_complemento', v_cond)
      ON CONFLICT (onda) DO NOTHING;
      v_on2 := true;
    END IF;
    v_out := v_out || jsonb_build_object('onda_complemento', jsonb_build_object(
               'ligada', v_c2, 'ligou_agora', v_c2, 'condicao', v_cond));
  ELSE
    v_out := v_out || jsonb_build_object('onda_complemento', jsonb_build_object('ligada', true, 'ligou_agora', false));
  END IF;

  -- Onda 3: Onda 2 ligada + ≥ 1 repasse aprovado vigente (tabela da Task 6; ausente = falso).
  IF NOT v_on3 THEN
    v_repasse := false;
    IF to_regclass('public.venda_repasse_aprovado') IS NOT NULL THEN
      BEGIN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.venda_repasse_aprovado
                                 WHERE revogado_em IS NULL AND valido_ate >= $1)'
           INTO v_repasse USING p_hoje;
      EXCEPTION WHEN undefined_column OR undefined_table THEN
        v_repasse := false;
        v_repasse_erro := SQLSTATE;
      END;
    ELSE
      v_repasse_erro := 'tabela_ausente';
    END IF;
    v_c3 := v_on2 AND v_repasse;
    v_cond := jsonb_build_object('onda_complemento_ligada', v_on2, 'repasse_vigente', v_repasse,
                                 'repasse_indisponivel', v_repasse_erro);
    IF v_c3 THEN
      UPDATE public.venda_config SET valor = 'true'::jsonb, atualizado_em = now() WHERE chave = 'onda_preco';
      INSERT INTO public.venda_onda_log (onda, condicao) VALUES ('onda_preco', v_cond)
      ON CONFLICT (onda) DO NOTHING;
    END IF;
    v_out := v_out || jsonb_build_object('onda_preco', jsonb_build_object(
               'ligada', v_c3, 'ligou_agora', v_c3, 'condicao', v_cond));
  ELSE
    v_out := v_out || jsonb_build_object('onda_preco', jsonb_build_object('ligada', true, 'ligou_agora', false));
  END IF;

  RETURN jsonb_build_object('hoje', p_hoje) || v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.venda_avaliar_ondas(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_avaliar_ondas(date) TO service_role;

-- ── 8. Cron 08:15 UTC (05:15 SP): avalia as ondas e gera a lista do dia ──────────────────────
-- Depois de venda-recompra (07:50) e antes de venda-fechar-desfechos (09:30). Só SQL, sem HTTP.
SELECT cron.schedule('venda-gerador', '15 8 * * *',
  $cron$SELECT public.venda_avaliar_ondas(); SELECT public.venda_gerar_lista((now() AT TIME ZONE 'America/Sao_Paulo')::date, CASE WHEN (SELECT valor FROM public.venda_config WHERE chave = 'onda_recompra')::boolean THEN 'ativa' ELSE 'sombra' END);$cron$);

-- ── 9. Postcondição: aborta o apply se qualquer peça não pegou ───────────────────────────────
DO $post$
DECLARE
  f text;
  t text;
BEGIN
  -- G1 tabelas novas com RLS e sem escrita para authenticated / leitura para anon
  FOREACH t IN ARRAY ARRAY['venda_gerador_execucao','venda_onda_log'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r' AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'G1 FALHOU: public.% ausente ou sem RLS', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'G1 FALHOU: public.% com escrita para authenticated ou leitura para anon', t;
    END IF;
  END LOOP;

  -- G2 ACL: nenhuma função do gerador executável por anon/PUBLIC/authenticated
  FOREACH f IN ARRAY ARRAY['public.venda_cidades_alvo(date)','public.venda_gerar_lista(date,text)',
                           'public.venda_reconstruir_historico(date,date)','public.venda_avaliar_ondas(date)',
                           'private.venda_lista_calc(date)','private.venda_city_uf(text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'G2 FALHOU: % executavel por anon/PUBLIC/authenticated', f;
    END IF;
  END LOOP;

  -- G3 SECURITY DEFINER com search_path fixo nas 3 funções que escrevem
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('venda_gerar_lista','venda_reconstruir_historico','venda_avaliar_ondas')
         AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=public, pg_temp']) <> 3 THEN
    RAISE EXCEPTION 'G3 FALHOU: funcoes do gerador sem SECURITY DEFINER/search_path fixo (ou sobrecarga extra)';
  END IF;

  -- G4 dependências da espinha e da recompra presentes (o gerador é late-bound: falharia só no cron)
  IF to_regprocedure('public.venda_recompra_em(date)') IS NULL
     OR to_regprocedure('public.venda_situacao_em(date)') IS NULL
     OR to_regprocedure('public.venda_fechar_desfechos(date)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'teto_maiores_atrasos'
                     AND jsonb_typeof(valor) = 'number')
     OR to_regclass('public.venda_sugestao_chave_uq') IS NULL THEN
    RAISE EXCEPTION 'G4 FALHOU: espinha/recompra ausentes — aplique 20261020150000 e 20261020174221 antes';
  END IF;

  -- G5 cron único, no horário e com o comando esperado
  IF (SELECT count(*) FROM cron.job
       WHERE jobname = 'venda-gerador' AND schedule = '15 8 * * *' AND active
         AND command LIKE 'SELECT public.venda_avaliar_ondas(); SELECT public.venda_gerar_lista(%') <> 1 THEN
    RAISE EXCEPTION 'G5 FALHOU: cron venda-gerador ausente, duplicado ou divergente';
  END IF;

  RAISE NOTICE 'venda_cliente_gerador OK: 2 tabelas com RLS, 6 funcoes fechadas, cron 08:15 UTC';
END
$post$;
