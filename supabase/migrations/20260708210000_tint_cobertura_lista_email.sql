-- ============================================================================================
-- Migration — Sentinela: LISTA de produtos no e-mail do alerta tint_cobertura_bases (2026-07-08)
-- ============================================================================================
-- Follow-up do vigia tint (spec 2026-06-15-tint-vigia-cobertura-sentinela-design): quando o
-- Check A (tint_cobertura_bases) dispara, ANEXAR ao CORPO DO E-MAIL a lista dos produtos
-- divergentes (código + descrição + motivo: sem is_tintometric / tint_type na aba errada) —
-- hoje o e-mail só diz "N base(s) divergente(s)", sem QUAL, e o plantão re-diagnostica no banco.
-- Espelha EXATAMENTE o tratamento especial de vendas_familia_ausente: função dedicada
-- _<check>_lista_email(50) concatenada no data_health_watchdog.
--
-- ⚠️ ESCOPO MÍNIMO ANTI-CASCATA: NÃO toca _data_health_compute (arquivo QUENTE, reverteu 5×)
--    nem fin_sync_heartbeat. Só:
--      1) CRIA a função aditiva _tint_cobertura_bases_lista_email(int) (nova → nada a reverter);
--      2) CREATE OR REPLACE data_health_watchdog com corpo = DEF VIVA DA PROD (pg_get_functiondef
--         em 2026-07-08) + APENAS 1 ramo novo no CASE do corpo do e-mail (tint_cobertura_bases).
--    O IN-list do watchdog NÃO muda (tint_cobertura_bases já faz push desde a 20260615130000).
--
-- ⚠️ A DEF VIVA do watchdog DIVERGE do repo: a 20260615130000 tem IN-list de 14 sources, mas a
--    PROD tem 17 — migrations posteriores (2026-06-23 custos_proxy_conf_alta/custos_product_cost_
--    revivido; 2026-06-26 pedidos_compra_sync) promoveram +3 ao push. O corpo abaixo preserva os
--    17 VERBATIM da def viva; partir da migration do repo REVERTERIA esses 3 (6ª cascata).
--
-- ⚠️ PRE-FLIGHT no SQL Editor ANTES de aplicar: confirme que a def viva do watchdog ainda bate
--    com a base abaixo (17 sources no IN + ramo família-ausente presente):
--      SELECT pg_get_functiondef('public.data_health_watchdog()'::regprocedure);
--    Divergiu (outra sessão mexeu no watchdog)? Rebaseie sobre o corpo vivo antes de aplicar.
-- PG17: db/test-tint-cobertura-lista-email.sh (aplica → semeia divergentes → prova a lista no
--    e-mail + falsifica). Aplicar manual no SQL Editor. Idempotente (CREATE OR REPLACE). BEGIN/COMMIT.

BEGIN;

-- 1) Função de lista (aditiva; molde = _vendas_familia_ausente_lista_email). Espelha o WHERE do
--    Check A no _data_health_compute, retornando código + descrição + o motivo da divergência.
CREATE OR REPLACE FUNCTION public._tint_cobertura_bases_lista_email(p_limit integer DEFAULT 50)
  RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $$
  WITH itens AS (
    SELECT op.codigo, op.descricao,
           CASE WHEN op.is_tintometric IS NOT TRUE
                THEN 'sem is_tintometric (some do mapeamento)'
                ELSE 'tint_type "' || COALESCE(op.tint_type, '∅') || '" deveria ser "'
                     || CASE lower(btrim(op.familia))
                          WHEN 'bases mixmachine' THEN 'base'
                          WHEN 'concentrados mixmachine' THEN 'concentrado' END
                     || '" (aba trocada)'
           END AS motivo,
           row_number() OVER (ORDER BY op.familia, op.descricao, op.codigo) AS rn
    FROM public.omie_products op
    WHERE op.account = 'oben' AND op.ativo = true
      AND lower(btrim(op.familia)) IN ('bases mixmachine','concentrados mixmachine')
      AND op.created_at < now() - interval '30 hours'
      AND ( op.is_tintometric IS NOT TRUE
         OR op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))
              WHEN 'bases mixmachine' THEN 'base'
              WHEN 'concentrados mixmachine' THEN 'concentrado' END )
  ),
  agg AS (
    SELECT
      count(*)::int AS n_total,
      count(*) FILTER (WHERE rn <= GREATEST(p_limit, 0))::int AS n_mostrados,
      string_agg(
        CASE WHEN rn <= GREATEST(p_limit, 0)
             THEN '• ' || descricao || ' (cód. ' || codigo || ') — ' || motivo
             ELSE NULL END,
        E'\n' ORDER BY rn) AS corpo
    FROM itens
  )
  SELECT CASE
    WHEN n_total = 0 THEN NULL
    ELSE 'Bases/concentrados MixMachine divergentes (corrija no Omie ou rode tint_marcar_bases_mixmachine):'
         || E'\n' || corpo
         || CASE WHEN n_total > n_mostrados
                 THEN E'\n… e mais ' || (n_total - n_mostrados)::text || ' item(ns) — veja no painel Saúde de Dados.'
                 ELSE '' END
  END
  FROM agg;
$$;

REVOKE ALL ON FUNCTION public._tint_cobertura_bases_lista_email(integer) FROM PUBLIC, anon, authenticated;

-- 2) data_health_watchdog: corpo VERBATIM da DEF VIVA (pg_get_functiondef 2026-07-08, 17 sources
--    no IN) + APENAS o ramo tint_cobertura_bases no CASE do corpo do e-mail. Nada mais muda.
CREATE OR REPLACE FUNCTION public.data_health_watchdog()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_sev_fin text;
  v_sev_forn text;
BEGIN
  FOR r IN
    SELECT * FROM public._data_health_compute()
    -- ⚠️ estoque_reposicao: 18º check, adicionado DIRETO EM PROD (migration fora do repo, drift §5),
    --    promovido ao push (watchdog+heartbeat) lá. Descoberto no apply (total_checks=18 vs 17 do teste;
    --    o heartbeat, não-tocado, ainda o tinha). PRESERVADO aqui pra não revertê-lo do e-mail.
    WHERE source IN ('vendas_pedidos','estoque_inventario','estoque_reposicao','reposicao_sugestoes','carteira_scores',
                     'custos_produtos','vendas_cadastros',
                     'reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano',
                     'reposicao_sayerlack_fabricado','omie_tipo_produto_oben','vendas_familia_ausente',
                     'tint_cobertura_bases',
                     'custos_proxy_conf_alta','custos_product_cost_revivido','pedidos_compra_sync')  -- [VIGIA tint 2026-06-15] só o Check A faz push; tint_vinculo_omie é dashboard-only
  LOOP
    v_sev_fin  := CASE WHEN r.severity = 'critical' THEN 'critico' ELSE 'aviso' END;
    v_sev_forn := CASE WHEN r.severity = 'critical' THEN 'urgente' ELSE 'atencao' END;
    IF r.status <> 'ok' THEN
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES ('oben', 'data_health_' || r.source, v_sev_fin, r.message,
              jsonb_build_object('source', r.source, 'domain', r.domain, 'status', r.status,
                                 'age_seconds', r.age_seconds, 'freshness_basis', r.freshness_basis))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        -- DELTA [2026-07-08]: família-ausente E tint_cobertura_bases anexam a lista dos produtos ao
        -- corpo do e-mail (função dedicada _<check>_lista_email). COALESCE p/ não anexar se vier NULL
        -- (defensivo; o branch só roda com o check degradado, mas a lista pode zerar por corrida).
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES ('oben', 'outro', v_sev_forn, '[Saúde de dados] ' || r.source,
                CASE WHEN r.source = 'vendas_familia_ausente'
                     THEN r.message || COALESCE(E'\n\n' || public._vendas_familia_ausente_lista_email(50), '')
                     WHEN r.source = 'tint_cobertura_bases'
                     THEN r.message || COALESCE(E'\n\n' || public._tint_cobertura_bases_lista_email(50), '')
                     ELSE r.message END,
                'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$function$;

COMMIT;

-- Validação pós-apply (read-only): a função existe + com a cobertura limpa hoje retorna NULL (0
-- divergentes = esperado). Prova real da lista = PG17 (db/test-tint-cobertura-lista-email.sh).
SELECT 'MIGRATION tint_cobertura_lista_email OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = '_tint_cobertura_bases_lista_email') AS fn_existe,
  public._tint_cobertura_bases_lista_email(50) AS lista_hoje;  -- NULL esperado (cobertura limpa)
