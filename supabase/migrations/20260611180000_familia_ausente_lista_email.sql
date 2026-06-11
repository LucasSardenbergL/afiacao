-- ============================================================================================
-- Migration — e-mail do check `vendas_familia_ausente` passa a LISTAR os produtos (não só contar)
-- ============================================================================================
-- Pedido do founder (2026-06-11): o e-mail "[Saúde de dados] vendas_familia_ausente" trazia só a
-- contagem ("12 produto(s) ativo(s) sem família (oben 12 · colacor 0)"). Ele quer a LISTA dos itens
-- no próprio e-mail, pra ir no Omie e classificar sem precisar abrir o painel/rodar query.
--
-- Onde a lista entra (decisão deliberada):
--   • A `message` do check em _data_health_compute() é renderizada em UMA LINHA no painel
--     SaudeDados.tsx (<span text-sm>, sem whitespace-pre-line) → inflá-la com 12+ itens quebra a UI.
--   • O corpo do e-mail vem de fornecedor_alerta.mensagem (montada pelo data_health_watchdog), e o
--     dispatch-notifications faz escapeHtml(msg).replace(/\n/g,'<br/>') → uma lista com '\n' renderiza
--     bonita no e-mail. LOGO: a lista vai SÓ no e-mail (watchdog), a `message`/painel ficam enxutos.
--
-- O que esta migration faz (escopo mínimo, ORTOGONAL ao conjunto de checks):
--   1. CRIA a função helper `_vendas_familia_ausente_lista_email(p_limit)` — texto formatado dos
--      produtos ativos sem família (mesmo predicado do check: NULLIF(btrim(familia),'') IS NULL,
--      ativo, contas oben/colacor), '• [empresa] descrição (cód. X)', ordem estável, cap + "… e mais N".
--   2. CREATE OR REPLACE de `data_health_watchdog()` — corpo VERBATIM da 20260609085244 (def viva em
--      prod, comprovada pelo e-mail real ID 53 de 11/06) + ÚNICO DELTA: a mensagem do fornecedor_alerta
--      anexa a lista QUANDO r.source='vendas_familia_ausente' (todos os outros sources: r.message igual).
--
-- ⚠️ NÃO toca _data_health_compute() NEM fin_sync_heartbeat() → o conjunto de checks e os 2 IN-lists de
--    push ficam IDÊNTICOS. Isso evita a armadilha de cascata do arquivo quente (§10, já reverteu 4x):
--    nenhum source é adicionado/removido, então não há desincronização compute×watchdog×heartbeat.
--
-- ⚠️ ANTES DE APLICAR (pré-flight anti-cascata): confirme em prod que data_health_watchdog equivale à
--    20260609085244 — `SELECT pg_get_functiondef('public.data_health_watchdog()'::regprocedure);`. Se
--    divergir (outra sessão recriou), rebaseie o corpo abaixo sobre a def VIVA, preservando o IN-list
--    dela e aplicando só o delta da mensagem. Idempotente (CREATE OR REPLACE). Tudo em transação.
-- ============================================================================================

BEGIN;

-- ── Helper: lista formatada dos produtos ativos sem família (corpo do e-mail) ──────────────
-- SECURITY DEFINER + REVOKE (espelha _data_health_compute): a função lê omie_products como owner;
-- o watchdog (DEFINER) a chama no contexto do owner. Revogada de anon/authenticated/PUBLIC pra não
-- virar RPC pública (não é dado sensível, mas higiene/consistência com as internals do Sentinela).
CREATE OR REPLACE FUNCTION public._vendas_familia_ausente_lista_email(p_limit int DEFAULT 50)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH itens AS (
    SELECT account, codigo, descricao,
           row_number() OVER (ORDER BY account, descricao, codigo) AS rn
    FROM public.omie_products
    WHERE NULLIF(btrim(familia), '') IS NULL
      AND COALESCE(ativo, false)
      AND account IN ('oben','colacor')
  ),
  agg AS (
    SELECT
      count(*)::int AS n_total,
      count(*) FILTER (WHERE rn <= GREATEST(p_limit, 0))::int AS n_mostrados,
      -- string_agg ignora NULL → itens acima do cap (ELSE NULL) não viram separador órfão
      string_agg(
        CASE WHEN rn <= GREATEST(p_limit, 0)
             THEN '• [' || account || '] ' || descricao || ' (cód. ' || codigo || ')'
             ELSE NULL END,
        E'\n' ORDER BY rn) AS corpo
    FROM itens
  )
  SELECT CASE
    WHEN n_total = 0 THEN NULL  -- sem itens → nada a anexar (o watchdog só chama com n>0, defensivo)
    ELSE 'Produtos sem família (classifique no Omie):' || E'\n' || corpo
         || CASE WHEN n_total > n_mostrados
                 THEN E'\n… e mais ' || (n_total - n_mostrados)::text
                      || ' produto(s) — veja no painel Saúde de Dados ou filtre no Omie por família vazia.'
                 ELSE '' END
  END
  FROM agg;
$$;

REVOKE ALL ON FUNCTION public._vendas_familia_ausente_lista_email(int) FROM PUBLIC, anon, authenticated;

-- ── Watchdog: corpo VERBATIM da 20260609085244 + único delta na mensagem do source família ──
CREATE OR REPLACE FUNCTION public.data_health_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_sev_fin text;
  v_sev_forn text;
BEGIN
  FOR r IN
    SELECT * FROM public._data_health_compute()
    WHERE source IN ('vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores',
                     'custos_produtos','vendas_cadastros',
                     'reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano',
                     'reposicao_sayerlack_fabricado','omie_tipo_produto_oben','vendas_familia_ausente')
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
        -- DELTA: só o source de família-ausente anexa a lista dos produtos ao corpo do e-mail.
        -- COALESCE p/ não anexar nada se a lista vier NULL (defensivo; o branch só roda com n>0).
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES ('oben', 'outro', v_sev_forn, '[Saúde de dados] ' || r.source,
                CASE WHEN r.source = 'vendas_familia_ausente'
                     THEN r.message || COALESCE(E'\n\n' || public._vendas_familia_ausente_lista_email(50), '')
                     ELSE r.message END,
                'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$$;

COMMIT;

-- Validação pós-apply (read-only): a função existe, lista os itens, e o watchdog segue compilando.
SELECT 'MIGRATION familia_ausente_lista_email OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = '_vendas_familia_ausente_lista_email') AS func_existe,
  (SELECT count(*) FROM public._data_health_compute()) AS total_checks,
  left(public._vendas_familia_ausente_lista_email(50), 120) AS amostra_lista;
