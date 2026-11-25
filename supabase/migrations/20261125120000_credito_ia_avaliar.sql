-- ============================================================
-- Crédito-IA PR 4 — ficha do grupo, reivindicação por raiz, writer único da proposta,
-- aprovação endurecida (individual + lote) e o cron da edge credito-ia-avaliar.
-- Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md · Plano: docs/superpowers/plans/
-- 2026-11-20-credito-ia.md, "PR 4" + "Revisão pós-Codex (desenho)" (os 12 itens mandam).
--
-- Decisões do Lucas (não reabrir): a IA PROPÕE, só o Lucas aprova; limite único por GRUPO;
-- teto K = 3 × compra média mensal (180 d); cliente comprovadamente novo = R$ 5.000 / ≤ 28 d.
--
-- O que a ficha NÃO é: texto. Só números, enums e flags (anti-injection: nada de nome, CNPJ,
-- observação). Cada insumo ausente sai NULL + motivo — ausente ≠ zero. Os tetos (limite, prazo)
-- e o risco forçado são calculados AQUI, uma vez; a edge só aplica o mínimo e o writer
-- (credito_registrar_avaliacao) reconfere cada invariante antes de gravar.
--
-- Fontes (medidas na prod, psql-ro 2026-11-25):
--   * faturamento = títulos CR não cancelados, categoria 1.01.* (receita de venda; 1.03/1.04 ficam
--     fora), por data de EMISSÃO — uniforme nas 3 empresas (a colacor_sc não tem sales_orders, e o
--     sales_orders.customer_user_id pode ser o do vendedor). 37 títulos sem data_emissao em prod ⇒
--     o grupo que os tiver sai com faturamento NULL (inconclusivo), nunca com o subtotal.
--   * pagamento = fin_contas_receber × v_titulo_baixas (tipo 'CR', origem 'titulo') por parcela do
--     GRUPO; data_recebimento do CR é NULL em 100%.
--   * piso = mesma régua do gate (vencimento <= hoje_SP − 60, PAGTO PARCIAL conta, saldo/vencimento
--     NULL = indeterminado) — 20261124170000.
-- Escopo declarado: a reavaliação semanal só roda para grupo SEM limite vigente (os vigentes são a
-- varredura da sombra do PR 5 — sem isso a fila do Lucas receberia a carteira inteira toda semana).
--
-- Sem BEGIN/COMMIT: a transação é do `bun run db:aplicar`.
-- Prova: db/test-credito-ia-avaliar.sh (PG17, com falsificação, nos 2 locales).
-- ============================================================

-- ── 0. Guarda de drift: os corpos que esta migration substitui/consome são os da PROD ───────
DO $guarda$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.credito_aprovar_proposta(uuid,text)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'GUARDA credito-ia-avaliar: credito_aprovar_proposta não existe';
  END IF;
  -- re-aplicação: o corpo já é o desta migration (marca ficha_superada) ⇒ segue
  IF md5(v_src) <> '1daabbc57fe299393c83f66720a53975' AND position('ficha_superada' IN v_src) = 0 THEN
    RAISE EXCEPTION 'GUARDA credito-ia-avaliar: corpo de credito_aprovar_proposta diverge do pre-flight (drift: refazer)';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.credito_propor_limite(uuid,numeric,integer,text,numeric,jsonb,jsonb,jsonb,text,text,timestamp with time zone,text,integer)');
  IF v_src IS NULL OR md5(v_src) <> 'e52366e646eff48a7700d814f5b0f7e6' THEN
    RAISE EXCEPTION 'GUARDA credito-ia-avaliar: credito_propor_limite ausente ou divergente do pre-flight';
  END IF;
END
$guarda$;

-- ── 1. Estado de avaliação por raiz (reivindicação + backoff) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.credito_avaliacao (
  raiz uuid PRIMARY KEY,
  token uuid,
  reivindicada_ate timestamptz,
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  proxima_tentativa_em timestamptz,
  ultimo_erro text CHECK (ultimo_erro IS NULL OR length(ultimo_erro) <= 500),
  ultima_avaliacao_em timestamptz,
  ultima_proposta_em timestamptz,
  ultima_proposta_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((token IS NULL) = (reivindicada_ate IS NULL))
);

DO $rls$
DECLARE
  r record;
BEGIN
  ALTER TABLE public.credito_avaliacao ENABLE ROW LEVEL SECURITY;
  -- fecho por ALLOWLIST (o default ACL de public dá DML também ao builder do Lovable)
  REVOKE ALL ON public.credito_avaliacao FROM PUBLIC, anon;
  FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
             FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.oid = 'public.credito_avaliacao'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.credito_avaliacao FROM %s', r.papel);
    IF r.papel NOT IN ('authenticated', 'service_role', 'claude_ro') THEN
      EXECUTE format('REVOKE SELECT ON public.credito_avaliacao FROM %s', r.papel);
    END IF;
  END LOOP;
  GRANT SELECT ON public.credito_avaliacao TO authenticated, service_role;
  DROP POLICY IF EXISTS credito_avaliacao_select_gestor ON public.credito_avaliacao;
  CREATE POLICY credito_avaliacao_select_gestor ON public.credito_avaliacao FOR SELECT TO authenticated
    USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
END
$rls$;

-- ── 2. No máximo 1 proposta pendente por grupo (a nova substitui a antiga no writer) ───────
CREATE UNIQUE INDEX IF NOT EXISTS credito_limite_proposta_uma_pendente
  ON public.credito_limite_proposta (grupo_user_id) WHERE status = 'pendente';

-- ── 3. Sinais de deterioração do grupo (ficha, writer e aprovação leem o MESMO predicado) ──
CREATE OR REPLACE FUNCTION private.credito_sinais_grupo(p_raiz uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d),
  pares AS (
    SELECT DISTINCT g.company, g.omie_codigo_cliente AS codigo FROM public.credito_grupo_pares(p_raiz) g
  ),
  ab AS (
    SELECT f.saldo, f.status_titulo, f.data_vencimento,
           -- mesma régua do piso (20261124170000): >= 60 d, PAGTO PARCIAL conta com saldo cheio
           (f.data_vencimento <= h.d - 60 AND (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL')) AS v60,
           (f.data_vencimento <= h.d - 15 AND (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL')) AS v15,
           (f.saldo IS NULL OR f.data_vencimento IS NULL) AS indet
      FROM pares p
      JOIN public.fin_contas_receber f ON f.company = p.company AND f.omie_codigo_cliente = p.codigo
      CROSS JOIN hoje h
     WHERE f.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL')
  )
  SELECT jsonb_build_object(
    'piso_estado', CASE WHEN COALESCE(bool_or(v60), false) THEN 'comprovado'
                        WHEN COALESCE(bool_or(indet), false) THEN 'indeterminado'
                        ELSE 'livre' END,
    'n_titulos_vencidos_60d', count(*) FILTER (WHERE v60),
    'vencido_60d_brl', CASE WHEN COALESCE(bool_or(v60 AND saldo IS NULL), false) THEN NULL
                            ELSE COALESCE(sum(saldo) FILTER (WHERE v60), 0) END,
    'n_titulos_vencidos_15d', count(*) FILTER (WHERE v15),
    'vencido_15d_brl', CASE WHEN COALESCE(bool_or(v15 AND saldo IS NULL), false) THEN NULL
                            ELSE COALESCE(sum(saldo) FILTER (WHERE v15), 0) END,
    'n_titulos_abertos', count(*),
    'em_aberto_brl', CASE WHEN COALESCE(bool_or(saldo IS NULL), false) THEN NULL
                          ELSE COALESCE(sum(saldo) FILTER (WHERE saldo > 0), 0) END
  )
  FROM ab;
$$;

-- Degrau seguinte ao maior prazo honrado (spec: "prazo_max ≤ maior honrado + 1 degrau"); sem honrado ⇒ 28.
CREATE OR REPLACE FUNCTION private.credito_teto_prazo(p_honrado integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_honrado IS NULL THEN 28
              ELSE COALESCE((SELECT min(d) FROM unnest(ARRAY[7,14,21,28,35,42,56,63,70,84,90,120]) d
                              WHERE d > p_honrado), 120) END;
$$;

-- ── 4. A ficha do grupo (só números/enums/flags; NULL + motivo quando falta) ───────────────
CREATE OR REPLACE FUNCTION public.credito_ficha(p_raiz uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_motivos text[] := ARRAY[]::text[];
  v_pares jsonb;
  v_sync jsonb := '{}'::jsonb;
  v_sync_ok boolean := true;
  v_sync_ok_todas boolean := true;
  v_co text;
  v_h numeric;
  v_n_co integer;
  v_s jsonb;
  v_fat numeric;
  v_fat_n integer;
  v_fat_indet boolean;
  v_cm numeric;
  v_hist_n integer;
  v_prim date;
  v_estado text;
  v_pg_n integer;
  v_p50 numeric;
  v_p80 numeric;
  v_pct numeric;
  v_honrado integer;
  v_sem_baixa integer;
  v_doc text;
  v_vig text;
  v_sit text;
  v_cad text;
  v_lim record;
  v_evid boolean;
  v_teto_lim numeric;
  v_teto_prazo integer;
  v_risco_forcado text;
BEGIN
  IF p_raiz IS NULL THEN
    RAISE EXCEPTION 'credito_ficha: raiz obrigatória' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_canonical_alias a
              WHERE a.alias_user_id = p_raiz AND a.status = 'active') THEN
    RAISE EXCEPTION 'credito_ficha: % é alias, não raiz', p_raiz USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_object_agg(x.company, x.n) INTO v_pares
    FROM (SELECT g.company, count(DISTINCT g.omie_codigo_cliente) AS n
            FROM public.credito_grupo_pares(p_raiz) g GROUP BY g.company) x;
  IF v_pares IS NULL THEN
    RAISE EXCEPTION 'credito_ficha: grupo sem par Omie comprovado' USING ERRCODE = '22023';
  END IF;

  -- frescor do CR por empresa (> 48 h ou ausente ⇒ defasado); "todas" = as 3 (prova de novo)
  FOREACH v_co IN ARRAY ARRAY['oben','colacor','colacor_sc'] LOOP
    SELECT round((extract(epoch FROM now() - max(s.last_sync_at)) / 3600)::numeric, 1) INTO v_h
      FROM public.sync_state s
     WHERE s.account = v_co AND s.entity_type = 'fin_cr_incremental_ok';
    v_n_co := COALESCE((v_pares ->> v_co)::integer, 0);
    v_sync := v_sync || jsonb_build_object(v_co, jsonb_build_object('horas', v_h, 'fresco', COALESCE(v_h <= 48, false)));
    IF NOT COALESCE(v_h <= 48, false) THEN
      v_sync_ok_todas := false;
      IF v_n_co > 0 THEN
        v_sync_ok := false;
        v_motivos := v_motivos || ('sync_defasado:' || v_co);
      END IF;
    END IF;
  END LOOP;

  v_s := private.credito_sinais_grupo(p_raiz);
  IF v_s ->> 'em_aberto_brl' IS NULL THEN
    v_motivos := v_motivos || 'exposicao_indeterminada'::text;
  END IF;

  -- faturamento comprovado (180 d por emissão; receita de venda 1.01.*)
  SELECT count(*) FILTER (WHERE f.data_emissao > v_hoje - 180 AND f.data_emissao <= v_hoje),
         sum(f.valor_documento) FILTER (WHERE f.data_emissao > v_hoje - 180 AND f.data_emissao <= v_hoje),
         COALESCE(bool_or(f.data_emissao IS NULL
                          OR (f.data_emissao > v_hoje - 180 AND f.valor_documento IS NULL)), false)
    INTO v_fat_n, v_fat, v_fat_indet
    FROM (SELECT DISTINCT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(p_raiz) g) p
    JOIN public.fin_contas_receber f ON f.company = p.company AND f.omie_codigo_cliente = p.omie_codigo_cliente
   WHERE f.status_titulo IS DISTINCT FROM 'CANCELADO'
     AND f.ausente_omie_desde IS NULL
     AND f.categoria_codigo LIKE '1.01.%';
  IF v_fat_indet THEN
    v_fat := NULL;
    v_motivos := v_motivos || 'faturamento_indeterminado'::text;
  ELSE
    v_fat := COALESCE(v_fat, 0);   -- 0 título na janela com fonte íntegra é zero observado
  END IF;
  v_cm := CASE WHEN v_fat IS NULL THEN NULL ELSE round(v_fat / 6, 2) END;

  -- histórico inteiro (qualquer categoria, qualquer data) — define "comprovadamente novo"
  SELECT count(*), min(f.data_emissao) INTO v_hist_n, v_prim
    FROM (SELECT DISTINCT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(p_raiz) g) p
    JOIN public.fin_contas_receber f ON f.company = p.company AND f.omie_codigo_cliente = p.omie_codigo_cliente
   WHERE f.status_titulo IS DISTINCT FROM 'CANCELADO';

  v_estado := CASE
    WHEN v_hist_n = 0 AND v_sync_ok_todas THEN 'novo_comprovado'
    WHEN v_cm IS NOT NULL AND v_cm > 0 THEN 'com_historico'
    ELSE 'historico_inconclusivo' END;

  -- pagamento por PARCELA do grupo (365 d de baixa; tolerância de 5 d sobre o vencimento)
  WITH parc AS (
    SELECT DISTINCT ON (f.company, f.omie_codigo_lancamento)
           f.valor_documento, f.data_vencimento, f.data_emissao, b.data_baixa_final,
           (b.data_baixa_final::date - f.data_vencimento) AS atraso
      FROM (SELECT DISTINCT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(p_raiz) g) p
      JOIN public.fin_contas_receber f ON f.company = p.company AND f.omie_codigo_cliente = p.omie_codigo_cliente
      JOIN public.v_titulo_baixas b ON b.company = f.company AND b.omie_codigo_lancamento = f.omie_codigo_lancamento
                                   AND b.tipo = 'CR' AND b.origem_baixa = 'titulo'
     WHERE f.status_titulo = 'RECEBIDO'
       AND b.data_baixa_final IS NOT NULL
       AND b.data_baixa_final::date >= v_hoje - 365
       AND f.data_vencimento IS NOT NULL
     ORDER BY f.company, f.omie_codigo_lancamento, b.data_baixa_final DESC
  )
  SELECT count(*),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY atraso)::numeric, 1),
         round(percentile_cont(0.8) WITHIN GROUP (ORDER BY atraso)::numeric, 1),
         CASE WHEN COALESCE(sum(valor_documento), 0) > 0 AND NOT bool_or(valor_documento IS NULL)
              THEN round(sum(valor_documento) FILTER (WHERE atraso > 5) / sum(valor_documento), 4) END,
         max(data_vencimento - data_emissao) FILTER (WHERE atraso <= 5 AND data_emissao IS NOT NULL)
    INTO v_pg_n, v_p50, v_p80, v_pct, v_honrado
    FROM parc;
  IF COALESCE(v_pg_n, 0) = 0 THEN
    v_motivos := v_motivos || 'sem_pagamento_observado'::text;
  ELSIF v_pct IS NULL THEN
    v_motivos := v_motivos || 'valor_pago_indeterminado'::text;
  END IF;

  SELECT count(*) INTO v_sem_baixa
    FROM (SELECT DISTINCT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(p_raiz) g) p
    JOIN public.fin_contas_receber f ON f.company = p.company AND f.omie_codigo_cliente = p.omie_codigo_cliente
   WHERE f.status_titulo = 'RECEBIDO'
     AND NOT EXISTS (SELECT 1 FROM public.v_titulo_baixas b
                      WHERE b.company = f.company AND b.omie_codigo_lancamento = f.omie_codigo_lancamento
                        AND b.tipo = 'CR' AND b.data_baixa_final IS NOT NULL);

  -- situação cadastral da raiz (lote PUBLICADO do Radar; ausência é ausência, não "ativa")
  SELECT p.document INTO v_doc FROM public.profiles p WHERE p.user_id = p_raiz LIMIT 1;
  v_doc := regexp_replace(COALESCE(v_doc, ''), '[^0-9]', '', 'g');
  SELECT max(i.mes_referencia) INTO v_vig FROM public.radar_ingest_state i
   WHERE i.status = 'complete' AND i.situacao_aplicada_em IS NOT NULL;
  IF v_doc = '' THEN
    v_cad := 'sem_documento';
  ELSIF length(v_doc) <> 14 THEN
    v_cad := 'sem_cnpj';
  ELSIF v_vig IS NULL THEN
    v_cad := 'sem_dado';
  ELSE
    SELECT s.situacao INTO v_sit FROM public.radar_situacao_cadastral s
     WHERE s.cnpj = v_doc AND s.lote <= v_vig ORDER BY s.lote DESC LIMIT 1;
    v_cad := CASE WHEN v_sit IS NULL THEN 'sem_dado'
                  WHEN v_sit IN ('03','04','08') THEN 'irregular'
                  WHEN v_sit = '02' THEN 'ativa'
                  ELSE 'outra' END;
  END IF;

  SELECT l.versao, l.limite_brl, l.prazo_max_dias, l.risco INTO v_lim
    FROM public.credito_limite l WHERE l.grupo_user_id = p_raiz;

  -- evidência suficiente: fonte fresca, exposição conhecida e, para quem tem histórico, compra média
  -- e pagamento observados. O "novo" já exige as 3 empresas em dia na própria definição.
  v_evid := v_sync_ok
            AND (v_s ->> 'em_aberto_brl') IS NOT NULL
            AND (v_estado = 'novo_comprovado'
                 OR (v_estado = 'com_historico' AND COALESCE(v_pg_n, 0) > 0 AND v_pct IS NOT NULL));

  -- tetos e risco forçado — a política inteira num lugar (a edge e o writer leem DAQUI)
  IF v_s ->> 'piso_estado' <> 'livre' THEN
    v_teto_lim := 0; v_teto_prazo := 0; v_risco_forcado := 'alto';
  ELSIF v_estado = 'historico_inconclusivo' THEN
    v_teto_lim := 0; v_teto_prazo := 0; v_risco_forcado := 'sem_evidencia';
  ELSE
    IF v_estado = 'novo_comprovado' THEN
      v_teto_lim := 5000; v_teto_prazo := 28;
    ELSE
      v_teto_lim := floor(3 * v_cm / 100) * 100;
      v_teto_prazo := private.credito_teto_prazo(v_honrado);
    END IF;
    v_risco_forcado := CASE WHEN v_cad = 'irregular' THEN 'alto'
                            WHEN NOT v_evid THEN 'sem_evidencia' END;
  END IF;

  RETURN jsonb_build_object(
    'versao_ficha', 1,
    'raiz', p_raiz,
    'assinatura', public.credito_grupo_assinatura(p_raiz),
    'limite_versao_base', v_lim.versao,
    'calculada_em', now(),
    'hoje_sp', v_hoje,
    'pares', v_pares,
    'sync', v_sync,
    'piso_estado', v_s ->> 'piso_estado',
    'n_titulos_vencidos_60d', (v_s ->> 'n_titulos_vencidos_60d')::integer,
    'vencido_60d_brl', (v_s ->> 'vencido_60d_brl')::numeric,
    'n_titulos_vencidos_15d', (v_s ->> 'n_titulos_vencidos_15d')::integer,
    'vencido_15d_brl', (v_s ->> 'vencido_15d_brl')::numeric,
    'n_titulos_abertos', (v_s ->> 'n_titulos_abertos')::integer,
    'em_aberto_brl', (v_s ->> 'em_aberto_brl')::numeric,
    'faturamento_180d_brl', v_fat,
    'n_titulos_180d', v_fat_n,
    'compra_media_mensal_brl', v_cm,
    'estado_historico', v_estado,
    'n_titulos_historico', v_hist_n,
    'antiguidade_dias', CASE WHEN v_prim IS NULL THEN NULL ELSE v_hoje - v_prim END,
    'n_parcelas_pagas_365d', COALESCE(v_pg_n, 0),
    'atraso_p50_dias', v_p50,
    'atraso_p80_dias', v_p80,
    'pct_valor_atrasado', v_pct,
    'maior_prazo_honrado_dias', v_honrado,
    'n_recebidos_sem_baixa', v_sem_baixa,
    'situacao_cadastral', v_cad,
    'limite_vigente_brl', v_lim.limite_brl,
    'prazo_vigente_dias', v_lim.prazo_max_dias,
    'risco_vigente', v_lim.risco,
    'evidencia_suficiente', v_evid,
    'teto_limite_brl', v_teto_lim,
    'teto_prazo_dias', v_teto_prazo,
    'risco_forcado', v_risco_forcado,
    'motivos_ausencia', to_jsonb(v_motivos)
  );
END;
$$;

-- ── 5. Carteira ativa: raízes com título emitido em 180 d OU título em aberto ──────────────
CREATE OR REPLACE FUNCTION public.credito_carteira_ativa()
RETURNS TABLE(raiz uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT (r.j ->> 'raiz')::uuid
    FROM (SELECT DISTINCT f.company, f.omie_codigo_cliente
            FROM public.fin_contas_receber f
           WHERE f.omie_codigo_cliente > 0
             AND f.status_titulo IS DISTINCT FROM 'CANCELADO'
             AND (f.data_emissao > ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 180)
                  OR f.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL'))) p
    CROSS JOIN LATERAL (SELECT public.credito_grupo_raiz(p.company, p.omie_codigo_cliente) AS j) r
   WHERE r.j ->> 'raiz' IS NOT NULL;
$$;

-- Elegível = na carteira, SEM limite vigente, sem proposta nos últimos 7 d, fora de backoff e de
-- reivindicação viva. (Vigentes: varredura da sombra do PR 5.)
CREATE OR REPLACE FUNCTION private.credito_raizes_elegiveis()
RETURNS TABLE(raiz uuid, ultima_proposta_em timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.raiz, a.ultima_proposta_em
    FROM public.credito_carteira_ativa() c
    LEFT JOIN public.credito_avaliacao a ON a.raiz = c.raiz
   WHERE NOT EXISTS (SELECT 1 FROM public.credito_limite l WHERE l.grupo_user_id = c.raiz)
     AND (a.raiz IS NULL
          OR ((a.proxima_tentativa_em IS NULL OR a.proxima_tentativa_em <= now())
              AND (a.ultima_proposta_em IS NULL OR a.ultima_proposta_em < now() - interval '7 days')));
$$;
-- (a reivindicação VIVA é filtrada só em credito_reivindicar_raizes, como predicado direto na linha
-- travada: é o que o FOR UPDATE reavalia sob concorrência; aqui ela só faria o cron acordar à toa.)

CREATE OR REPLACE FUNCTION private.credito_avaliacao_ha_elegivel()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM private.credito_raizes_elegiveis()); $$;

-- ── 6. Reivindicação atômica ANTES da chamada ao Claude (2 workers nunca pagam a mesma raiz) ─
CREATE OR REPLACE FUNCTION public.credito_reivindicar_raizes(p_n integer, p_token uuid, p_ttl_segundos integer DEFAULT 300)
RETURNS SETOF uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_token IS NULL OR p_n IS NULL OR p_n < 1 OR p_n > 50
     OR p_ttl_segundos IS NULL OR p_ttl_segundos < 30 OR p_ttl_segundos > 900 THEN
    RAISE EXCEPTION 'credito_reivindicar_raizes: parâmetros fora da faixa (n 1..50, ttl 30..900, token)'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.credito_avaliacao (raiz)
  SELECT e.raiz FROM private.credito_raizes_elegiveis() e
  ON CONFLICT (raiz) DO NOTHING;

  RETURN QUERY
  WITH alvo AS (
    SELECT a.raiz
      FROM public.credito_avaliacao a
     WHERE a.raiz IN (SELECT e.raiz FROM private.credito_raizes_elegiveis() e)
       AND (a.reivindicada_ate IS NULL OR a.reivindicada_ate < now())
     ORDER BY a.ultima_proposta_em NULLS FIRST, a.raiz
     LIMIT p_n
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.credito_avaliacao a
     SET token = p_token, reivindicada_ate = now() + make_interval(secs => p_ttl_segundos)
    FROM alvo
   WHERE a.raiz = alvo.raiz
  RETURNING a.raiz;
END;
$$;

-- ── 7. O ÚNICO writer de proposta: confere o token, reconfere as travas, substitui a pendente ─
CREATE OR REPLACE FUNCTION public.credito_registrar_avaliacao(
  p_token uuid,
  p_raiz uuid,
  p_proposta jsonb,
  p_erro text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a public.credito_avaliacao%ROWTYPE;
  v_f jsonb;
  v_lim numeric;
  v_prazo integer;
  v_risco text;
  v_em timestamptz;
  v_s jsonb;
  v_old uuid;
  v_id uuid;
BEGIN
  IF p_token IS NULL OR p_raiz IS NULL THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: token e raiz obrigatórios' USING ERRCODE = '22023';
  END IF;
  -- mesma fila da aprovação e do gate do grupo
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || p_raiz::text, 0));
  SELECT * INTO v_a FROM public.credito_avaliacao WHERE raiz = p_raiz FOR UPDATE;
  IF NOT FOUND OR v_a.token IS DISTINCT FROM p_token OR v_a.reivindicada_ate < now() THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: reivindicacao_perdida (raiz %)', p_raiz USING ERRCODE = 'P0001';
  END IF;

  IF p_proposta IS NULL THEN
    -- falha: backoff persistido (15 min × 2^tentativas, teto 24 h); a raiz volta sozinha
    UPDATE public.credito_avaliacao
       SET tentativas = tentativas + 1,
           proxima_tentativa_em = now() + LEAST(interval '15 minutes' * power(2, LEAST(tentativas, 10)), interval '24 hours'),
           ultimo_erro = left(COALESCE(NULLIF(btrim(p_erro), ''), 'erro_nao_informado'), 500),
           ultima_avaliacao_em = now(), token = NULL, reivindicada_ate = NULL
     WHERE raiz = p_raiz;
    RETURN NULL;
  END IF;

  v_f := p_proposta -> 'ficha';
  IF v_f IS NULL OR jsonb_typeof(v_f) <> 'object' THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: ficha ausente' USING ERRCODE = '22023';
  END IF;
  IF (v_f ->> 'raiz') IS DISTINCT FROM p_raiz::text THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: ficha de outra raiz' USING ERRCODE = '22023';
  END IF;
  IF (v_f ->> 'assinatura') IS DISTINCT FROM public.credito_grupo_assinatura(p_raiz) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: grupo_mudou desde a ficha' USING ERRCODE = 'P0001';
  END IF;
  v_em := (v_f ->> 'calculada_em')::timestamptz;
  IF v_em IS NULL OR v_em < now() - interval '30 minutes' OR v_em > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: ficha fora da janela de 30 min' USING ERRCODE = 'P0001';
  END IF;
  IF (v_f ->> 'limite_versao_base') IS DISTINCT FROM
     (SELECT l.versao::text FROM public.credito_limite l WHERE l.grupo_user_id = p_raiz) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: limite vigente mudou desde a ficha' USING ERRCODE = 'P0001';
  END IF;
  -- a deterioração que aconteceu entre a ficha e a gravação também barra
  v_s := private.credito_sinais_grupo(p_raiz);
  IF (v_s ->> 'piso_estado') IS DISTINCT FROM (v_f ->> 'piso_estado')
     OR (v_s ->> 'n_titulos_vencidos_15d')::integer > COALESCE((v_f ->> 'n_titulos_vencidos_15d')::integer, -1) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: ficha_superada (deterioração desde a ficha)' USING ERRCODE = 'P0001';
  END IF;

  v_lim := (p_proposta ->> 'limite_brl')::numeric;
  v_prazo := (p_proposta ->> 'prazo_max_dias')::integer;
  v_risco := p_proposta ->> 'risco';
  -- invariantes da política (espelho das travas da edge; a ficha é a fonte dos tetos)
  IF v_lim IS NULL OR v_prazo IS NULL OR v_risco IS NULL
     OR (v_f ->> 'teto_limite_brl') IS NULL OR (v_f ->> 'teto_prazo_dias') IS NULL THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (campo nulo)' USING ERRCODE = '22023';
  END IF;
  IF v_lim < 0 OR v_lim % 100 <> 0 OR v_lim > (v_f ->> 'teto_limite_brl')::numeric THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (limite % > teto % ou fora do degrau de R$ 100)',
      v_lim, v_f ->> 'teto_limite_brl' USING ERRCODE = '22023';
  END IF;
  IF v_prazo > (v_f ->> 'teto_prazo_dias')::integer
     OR NOT (v_prazo = ANY (ARRAY[0,7,14,21,28,35,42,56,63,70,84,90,120])) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (prazo % fora do teto %/degraus)',
      v_prazo, v_f ->> 'teto_prazo_dias' USING ERRCODE = '22023';
  END IF;
  IF (v_lim = 0) <> (v_prazo = 0) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (limite 0 ⇔ prazo 0)' USING ERRCODE = '22023';
  END IF;
  IF (v_f ->> 'risco_forcado') IS NOT NULL AND v_risco IS DISTINCT FROM (v_f ->> 'risco_forcado') THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (risco % ≠ forçado %)',
      v_risco, v_f ->> 'risco_forcado' USING ERRCODE = '22023';
  END IF;

  -- a pendente anterior sai como EXPIRADA (≠ recusada: o sensor mede só decisão do Lucas)
  FOR v_old IN SELECT p.id FROM public.credito_limite_proposta p
                WHERE p.grupo_user_id = p_raiz AND p.status = 'pendente' FOR UPDATE LOOP
    PERFORM public.credito_portao(v_old::text);
    UPDATE public.credito_limite_proposta
       SET status = 'expirada', decidido_em = now(), motivo_decisao = 'substituida_por_reavaliacao'
     WHERE id = v_old AND status = 'pendente';
  END LOOP;
  PERFORM public.credito_portao(NULL);

  v_id := public.credito_propor_limite(
    p_raiz, v_lim, v_prazo, v_risco, (p_proposta ->> 'confianca')::numeric, v_f,
    p_proposta -> 'saida_ia', p_proposta -> 'travas', p_proposta ->> 'modelo',
    p_proposta ->> 'versao_politica', v_em, v_f ->> 'assinatura', (v_f ->> 'limite_versao_base')::integer);

  UPDATE public.credito_avaliacao
     SET tentativas = 0, proxima_tentativa_em = NULL, ultimo_erro = NULL,
         ultima_avaliacao_em = now(), ultima_proposta_em = now(), ultima_proposta_id = v_id,
         token = NULL, reivindicada_ate = NULL
   WHERE raiz = p_raiz;
  RETURN v_id;
END;
$$;

-- ── 8. Aprovação individual endurecida (corpo de PROD + 4 travas novas, sob o mesmo lock) ──
CREATE OR REPLACE FUNCTION public.credito_aprovar_proposta(p_proposta_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.credito_limite_proposta%ROWTYPE;
  v_versao_atual integer;
  v_nova integer;
  v_s jsonb;
BEGIN
  IF NOT (COALESCE(private.cap_credito_escrever(v_uid), false)
          AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = v_uid)) THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: só o aprovador de crédito decide' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = p_proposta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta inexistente' USING ERRCODE = 'P0002';
  END IF;
  -- mesma fila da reserva: aprovação e gate do grupo não se cruzam
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || v_p.grupo_user_id::text, 0));
  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = p_proposta_id FOR UPDATE;
  IF v_p.status <> 'pendente' THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta_nao_pendente (%)', v_p.status USING ERRCODE = 'P0001';
  END IF;
  SELECT l.versao INTO v_versao_atual FROM public.credito_limite l
   WHERE l.grupo_user_id = v_p.grupo_user_id FOR UPDATE;
  IF v_versao_atual IS DISTINCT FROM v_p.limite_versao_base THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta_desatualizada (base %, vigente %)',
      v_p.limite_versao_base, v_versao_atual USING ERRCODE = 'P0001';
  END IF;
  IF public.credito_grupo_assinatura(v_p.grupo_user_id) IS DISTINCT FROM v_p.grupo_assinatura THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: grupo_mudou desde a proposta' USING ERRCODE = 'P0001';
  END IF;
  -- PR 4 (Codex desenho P1-5): a ficha envelhece, a titularidade muda sem mudar os pares, o
  -- cliente piora entre a ficha e o clique — nenhum deles pode virar limite vigente.
  IF v_p.ficha_calculada_em < now() - interval '14 days' THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: ficha_vencida (calculada em %)', v_p.ficha_calculada_em
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.credito_grupo_pares(v_p.grupo_user_id) g
              WHERE (public.credito_grupo_raiz(g.company, g.omie_codigo_cliente) ->> 'raiz')
                    IS DISTINCT FROM v_p.grupo_user_id::text) THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: grupo_mudou (titularidade de um par)' USING ERRCODE = 'P0001';
  END IF;
  v_s := private.credito_sinais_grupo(v_p.grupo_user_id);
  IF ((v_p.ficha ->> 'piso_estado') = 'livre' AND (v_s ->> 'piso_estado') <> 'livre')
     OR (v_p.ficha ->> 'piso_estado') IS NULL
     OR (v_s ->> 'n_titulos_vencidos_15d')::integer > COALESCE((v_p.ficha ->> 'n_titulos_vencidos_15d')::integer, -1) THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: ficha_superada (o grupo piorou desde a ficha)' USING ERRCODE = 'P0001';
  END IF;

  v_nova := COALESCE(v_versao_atual, 0) + 1;
  PERFORM public.credito_portao(v_p.grupo_user_id::text);
  INSERT INTO public.credito_limite AS l (
    grupo_user_id, limite_brl, prazo_max_dias, risco, versao, grupo_assinatura,
    ficha_calculada_em, origem_proposta_id, aprovado_por, vigente_desde)
  VALUES (v_p.grupo_user_id, v_p.limite_sugerido_brl, v_p.prazo_max_dias, v_p.risco, v_nova,
          v_p.grupo_assinatura, v_p.ficha_calculada_em, v_p.id, v_uid, now())
  ON CONFLICT (grupo_user_id) DO UPDATE SET
    limite_brl = EXCLUDED.limite_brl, prazo_max_dias = EXCLUDED.prazo_max_dias,
    risco = EXCLUDED.risco, versao = EXCLUDED.versao, grupo_assinatura = EXCLUDED.grupo_assinatura,
    ficha_calculada_em = EXCLUDED.ficha_calculada_em, origem_proposta_id = EXCLUDED.origem_proposta_id,
    aprovado_por = EXCLUDED.aprovado_por, vigente_desde = EXCLUDED.vigente_desde;

  PERFORM public.credito_portao(v_p.id::text);
  UPDATE public.credito_limite_proposta
     SET status = 'aprovada', decidido_por = v_uid, decidido_em = now(), motivo_decisao = p_motivo
   WHERE id = v_p.id AND status = 'pendente';
  PERFORM public.credito_portao(NULL);
  RETURN jsonb_build_object('grupo_user_id', v_p.grupo_user_id, 'versao', v_nova,
                            'limite_brl', v_p.limite_sugerido_brl, 'prazo_max_dias', v_p.prazo_max_dias);
END;
$function$;

-- ── 9. Lote: ≤ 50 ids, deduplicados, em ordem de raiz; cada um pela MESMA decisão individual ─
CREATE OR REPLACE FUNCTION public.credito_aprovar_propostas_lote(p_ids uuid[], p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  r record;
  v_res jsonb := '[]'::jsonb;
  v_ok integer := 0;
  v_ret jsonb;
  v_state text;
  v_msg text;
BEGIN
  IF NOT (COALESCE(private.cap_credito_escrever(v_uid), false)
          AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = v_uid)) THEN
    RAISE EXCEPTION 'credito_aprovar_propostas_lote: só o aprovador de crédito decide' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 50 THEN
    RAISE EXCEPTION 'credito_aprovar_propostas_lote: de 1 a 50 ids por chamada' USING ERRCODE = '22023';
  END IF;
  -- ordem de RAIZ: dois lotes sobrepostos pegam os locks na mesma ordem (sem deadlock)
  FOR r IN SELECT DISTINCT i.id, p.grupo_user_id
             FROM unnest(p_ids) AS i(id)
             LEFT JOIN public.credito_limite_proposta p ON p.id = i.id
            WHERE i.id IS NOT NULL
            ORDER BY p.grupo_user_id NULLS LAST, i.id LOOP
    BEGIN
      v_ret := public.credito_aprovar_proposta(r.id, p_motivo);
      v_ok := v_ok + 1;
      v_res := v_res || jsonb_build_object('id', r.id, 'ok', true, 'versao', v_ret -> 'versao');
    EXCEPTION WHEN OTHERS THEN
      -- resultado POR ID (não é teste): o erro de um não desfaz os outros; o front reconcilia
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_res := v_res || jsonb_build_object('id', r.id, 'ok', false, 'sqlstate', v_state, 'erro', left(v_msg, 300));
    END;
  END LOOP;
  RETURN jsonb_build_object('aprovadas', v_ok, 'resultados', v_res);
END;
$$;

-- ── 10. Leitura da tela (gestor/master) — o nome vem de profiles AQUI, nunca vai à IA ───────
CREATE OR REPLACE FUNCTION public.credito_fila_propostas(p_status text DEFAULT 'pendente')
RETURNS TABLE(
  id uuid, grupo_user_id uuid, nome text, documento text, status text,
  limite_sugerido_brl numeric, prazo_max_dias integer, risco text, confianca numeric,
  ficha jsonb, saida_ia jsonb, travas jsonb, modelo text, versao_politica text,
  ficha_calculada_em timestamptz, created_at timestamptz, decidido_em timestamptz, motivo_decisao text,
  limite_vigente_brl numeric, prazo_vigente_dias integer, versao_vigente integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'credito_fila_propostas: só gestor/master' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pendente','aprovada','recusada','expirada') THEN
    RAISE EXCEPTION 'credito_fila_propostas: status inválido' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT p.id, p.grupo_user_id,
         (SELECT COALESCE(NULLIF(btrim(pr.razao_social), ''), pr.name) FROM public.profiles pr
           WHERE pr.user_id = p.grupo_user_id LIMIT 1),
         (SELECT pr.document FROM public.profiles pr WHERE pr.user_id = p.grupo_user_id LIMIT 1),
         p.status, p.limite_sugerido_brl, p.prazo_max_dias, p.risco, p.confianca,
         p.ficha, p.saida_ia, p.travas, p.modelo, p.versao_politica,
         p.ficha_calculada_em, p.created_at, p.decidido_em, p.motivo_decisao,
         l.limite_brl, l.prazo_max_dias, l.versao
    FROM public.credito_limite_proposta p
    LEFT JOIN public.credito_limite l ON l.grupo_user_id = p.grupo_user_id
   WHERE p.status = p_status
   ORDER BY p.created_at DESC, p.id;
END;
$$;

-- Progresso da 1ª leva (denominador do sensor): carteira × vigentes × pendentes × retry.
CREATE OR REPLACE FUNCTION public.credito_avaliacao_progresso()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'credito_avaliacao_progresso: só gestor/master' USING ERRCODE = '42501';
  END IF;
  WITH c AS (SELECT raiz FROM public.credito_carteira_ativa())
  SELECT jsonb_build_object(
    'carteira', (SELECT count(*) FROM c),
    'vigentes', (SELECT count(*) FROM c JOIN public.credito_limite l ON l.grupo_user_id = c.raiz),
    'pendentes', (SELECT count(*) FROM public.credito_limite_proposta p WHERE p.status = 'pendente'),
    'em_retry', (SELECT count(*) FROM public.credito_avaliacao a WHERE a.tentativas > 0),
    'nunca_avaliadas', (SELECT count(*) FROM c LEFT JOIN public.credito_avaliacao a ON a.raiz = c.raiz
                         WHERE a.ultima_avaliacao_em IS NULL
                           AND NOT EXISTS (SELECT 1 FROM public.credito_limite l WHERE l.grupo_user_id = c.raiz)),
    'ultima_avaliacao_em', (SELECT max(a.ultima_avaliacao_em) FROM public.credito_avaliacao a)
  ) INTO v;
  RETURN v;
END;
$$;

-- ── 11. ACL: allowlist por função (o builder do Lovable ganha EXECUTE por default ACL) ─────
DO $acl$
DECLARE
  f record;
  g record;
BEGIN
  FOR f IN SELECT * FROM (VALUES
      ('private.credito_sinais_grupo(uuid)',                         ARRAY[]::text[]),
      ('private.credito_teto_prazo(integer)',                        ARRAY[]::text[]),
      ('private.credito_raizes_elegiveis()',                         ARRAY[]::text[]),
      ('private.credito_avaliacao_ha_elegivel()',                    ARRAY[]::text[]),
      ('public.credito_ficha(uuid)',                                 ARRAY['service_role']),
      ('public.credito_carteira_ativa()',                            ARRAY['service_role']),
      ('public.credito_reivindicar_raizes(integer,uuid,integer)',    ARRAY['service_role']),
      ('public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)',   ARRAY['service_role']),
      ('public.credito_propor_limite(uuid,numeric,integer,text,numeric,jsonb,jsonb,jsonb,text,text,timestamp with time zone,text,integer)', ARRAY[]::text[]),
      ('public.credito_aprovar_propostas_lote(uuid[],text)',         ARRAY['authenticated']),
      ('public.credito_fila_propostas(text)',                        ARRAY['authenticated']),
      ('public.credito_avaliacao_progresso()',                       ARRAY['authenticated'])
    ) v(fn, permitidos) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.fn);
    FOR g IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
              WHERE p.oid = to_regprocedure(f.fn) AND a.grantee <> 0 AND a.grantee <> p.proowner LOOP
      IF NOT (g.papel = ANY (f.permitidos)) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', f.fn, g.papel);
      END IF;
    END LOOP;
    FOR g IN SELECT unnest(f.permitidos) AS papel LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', f.fn, g.papel);
    END LOOP;
  END LOOP;
END
$acl$;

-- ── 12. Cron: a cada 15 min, só acorda a edge se houver raiz elegível ──────────────────────
SELECT cron.schedule('credito-ia-avaliar', '*/15 * * * *', $cron$
  SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/credito-ia-avaliar',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
    body:=jsonb_build_object('origem','cron'), timeout_milliseconds:=150000)
  WHERE private.credito_avaliacao_ha_elegivel();
$cron$);

-- ── 13. Pós-condição (aborta a transação do envelope se algo não pegou) ────────────────────
DO $post$
DECLARE
  f text;
  v_src text;
BEGIN
  FOREACH f IN ARRAY ARRAY['private.credito_sinais_grupo(uuid)', 'private.credito_raizes_elegiveis()',
                           'private.credito_avaliacao_ha_elegivel()', 'public.credito_ficha(uuid)',
                           'public.credito_carteira_ativa()', 'public.credito_reivindicar_raizes(integer,uuid,integer)',
                           'public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)',
                           'public.credito_aprovar_proposta(uuid,text)', 'public.credito_aprovar_propostas_lote(uuid[],text)',
                           'public.credito_fila_propostas(text)', 'public.credito_avaliacao_progresso()'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'POS FALHOU: % não existe', f;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'POS FALHOU: % não é SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.credito_ficha(uuid)', 'public.credito_carteira_ativa()',
                           'public.credito_reivindicar_raizes(integer,uuid,integer)',
                           'public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)'] LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % deveria ser só service_role', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.credito_aprovar_propostas_lote(uuid[],text)', 'public.credito_fila_propostas(text)',
                           'public.credito_avaliacao_progresso()', 'public.credito_aprovar_proposta(uuid,text)'] LOOP
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % sem EXECUTE para authenticated', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['private.credito_sinais_grupo(uuid)', 'private.credito_raizes_elegiveis()',
                           'public.credito_propor_limite(uuid,numeric,integer,text,numeric,jsonb,jsonb,jsonb,text,text,timestamp with time zone,text,integer)'] LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % não pode ser chamada de fora (só pelos writers)', f;
    END IF;
  END LOOP;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.credito_aprovar_proposta(uuid,text)');
  IF position('ficha_superada' IN v_src) = 0 OR position('ficha_vencida' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS FALHOU: credito_aprovar_proposta sem as travas do PR 4';
  END IF;
  IF to_regclass('public.credito_limite_proposta_uma_pendente') IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: índice de 1 pendente por grupo ausente';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.credito_avaliacao'::regclass) THEN
    RAISE EXCEPTION 'POS FALHOU: credito_avaliacao sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.credito_avaliacao', 'INSERT')
     OR has_table_privilege('authenticated', 'public.credito_avaliacao', 'UPDATE')
     OR has_table_privilege('service_role', 'public.credito_avaliacao', 'UPDATE') THEN
    RAISE EXCEPTION 'POS FALHOU: credito_avaliacao com DML fora dos writers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'credito-ia-avaliar'
                  AND command LIKE '%timeout_milliseconds%' AND command LIKE '%credito_avaliacao_ha_elegivel%') THEN
    RAISE EXCEPTION 'POS FALHOU: cron credito-ia-avaliar ausente ou sem timeout explícito';
  END IF;
END
$post$;
