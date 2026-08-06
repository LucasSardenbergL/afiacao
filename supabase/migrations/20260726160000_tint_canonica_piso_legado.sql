-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — SEPARA o RÓTULO do PISO: `preco_piso_legado` (14ª coluna)
-- (follow-up do challenge Codex xhigh no #1523, achado "(c)/(d) NULL e gate";
-- decisão do founder 2026-07-21, com o spec CORRIGIDO pela medição abaixo).
--
-- O PROBLEMA: `preco_csv_legado` servia DOIS consumidores com necessidades
-- OPOSTAS.
--   1. O RÓTULO do balcão ("Tabela (versão anterior)") quer PRECISÃO DE
--      PROVENIÊNCIA — só a geração congelada '1' pode alimentá-lo. Foi por isso
--      que o #1505 trocou blocklist por allowlist.
--   2. O PISO do gate de submit (`tint_gate_revalida`, 20260722100001) quer
--      CONSERVADORISMO: `v_floor := LEAST(v_calc, COALESCE(v_tab, v_calc))`.
--      Encolher o conjunto do max() REDUZ v_tab, o que REDUZ o piso — a
--      allowlist podia AMPLIAR a aceitação de preço baixo, o oposto do que se
--      quer numa fronteira de submit.
--   Cenário do Codex: calc 500, geração '1' = 300, personalizada = 400.
--     blocklist → v_tab=400, piso=400 ⇒ manual 350 BLOQUEADO.
--     allowlist → v_tab=300, piso=300 ⇒ manual 350 PASSA.
--
-- ⚠️ O SPEC INGÊNUO ("max de TODAS as ativas, sem allowlist") ESTÁ ERRADO —
-- ele inverte a direção numa sub-população REAL. Como o piso é
-- `LEAST(v_calc, COALESCE(v_tab, v_calc))`, **v_tab NULL produz o piso MAIS
-- ALTO possível** (= v_calc): qualquer número abaixo de calc só faz o piso
-- CAIR. Então trocar NULL por "max de todas" AFROUXA nas chaves onde a
-- allowlist não acha geração '1'.
--   Medido em prod (psql-ro 2026-07-21): das 495.057 chaves com SL ativa,
--   **31.062 (6,3%) NÃO têm geração '1' ativa** — nelas `preco_csv_legado` é
--   NULL hoje e o piso é v_calc. O spec ingênuo derrubaria o piso dessas 31.062
--   para o CSV de qualquer linha ativa. As outras 463.995 (93,7%) são o caso do
--   Codex, onde o spec ingênuo de fato APERTA. Ou seja: certo em 94%, fail-OPEN
--   em 6% — e o fail-open é exatamente a direção que este exercício existe para
--   impedir.
--
-- REGRA (NULL-preserving — duas perguntas INDEPENDENTES):
--   (a) PODE descer abaixo de calc?  → decidido pela PROVENIÊNCIA:
--       só se `preco_csv_legado` existir (há "versão anterior" provada).
--   (b) Até ONDE pode descer?        → decidido pelo CONSERVADORISMO:
--       até o max de TODAS as linhas ATIVAS da chave (nunca menos).
--   ⇒ preco_piso_legado = NULL quando preco_csv_legado é NULL;
--     senão, max(preco_final_sayersystem) de TODAS as ativas da chave.
--
-- INVARIANTES DA VIEW (sobre os valores CRUS; provados no harness e
-- re-conferíveis em prod):
--   I1. (preco_csv_legado IS NULL) ⟺ (preco_piso_legado IS NULL)
--   I2. preco_piso_legado >= preco_csv_legado  (o max de um SUPERconjunto)
--
-- ⚠️ I1+I2 **NÃO BASTAM** para garantir "o piso novo é sempre >= o de hoje" —
-- e afirmar isso foi o erro que o challenge Codex xhigh derrubou (2026-07-21).
-- O gate normaliza com um guard `> 0` DEPOIS de ler as colunas, criando uma
-- SEGUNDA forma de "ausente" que a view não conhece:
--     csv = 0 (≠ NULL) · piso = 90 · calc = 102.5
--     ⇒ I1 passa (nenhum é NULL) e I2 passa (90 >= 0) — os dois VERDES —
--       mas v_tab vira NULL e v_piso vira 90, e o piso EFETIVO cai de 102.5
--       para 90: um manual de 95 passa a ser aceito onde hoje bloqueia.
-- Por isso a elegibilidade de v_piso no gate é ACOPLADA à de v_tab (ver §2).
-- O invariante que de fato sustenta a alegação é o EFETIVO, no gate:
--   E1. v_tab IS NULL ⇒ v_piso IS NULL
--   E2. ambos presentes ⇒ v_piso >= v_tab
--   ⇒ v_floor novo >= v_floor de hoje, SEMPRE.
-- Provados por G34 (comportamento) e G35 (os 2 ramos) em
-- db/test-tint-gate-revalida.sh, com F12/F13 falsificando cada um.
--
-- DELTA CONTRA A PROD HOJE: **0 linhas** (psql-ro 2026-07-21). Nenhuma linha SL
-- ativa carrega CSV (0 de 495.057) e as 756 personalizadas ativas com CSV vivem
-- em 756 chaves que não têm NEM SL NEM geração '1' ativa — logo a canônica
-- delas não é SL, a allowlist não dispara, e csv já é igual ao piso. É
-- blindagem semântica pura: muda o que ACONTECERIA, não o que acontece.
--
-- O RÓTULO NÃO MUDA: `preco_csv_legado` segue com a allowlist e continua sendo
-- o que a fonte 'tabela' valida — a escolha da vendedora é sobre PROVENIÊNCIA.
-- Só o PISO (fontes 'manual' e legado/ausente) passa a usar a coluna nova.
--
-- REPLACE: ordem das 13 colunas PRESERVADA (a 14ª só ACRESCENTA no fim) e
-- WITH (security_invoker = on) REPETIDO — omitir RESETA a opção e a view passa
-- a ler como OWNER, bypassando RLS (armadilha #1375: falha ABERTA, muda
-- autorização e não comportamento, e o CI não vê).
-- Prova: db/test-tint-canonica.sh (piso) + db/test-tint-gate-revalida.sh (gate).
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. A view: 13 colunas verbatim da 20260724130000 + a 14ª (piso).
--    ⚠️ A subquery do `preco_csv_legado` aparece DUAS vezes (como coluna 13 e
--    como teste de NULL da 14ª). É duplicação deliberada: manter a coluna 13
--    intocada byte a byte é o que torna este REPLACE auditável contra a
--    migration anterior. O risco de drift entre as duas cópias é coberto pelo
--    invariante I1, provado no harness E re-conferível em prod pela query de
--    validação pós-apply (uma cópia divergente quebra I1 imediatamente).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_tint_formula_canonica
WITH (security_invoker = on)
AS
SELECT
  f.id,
  f.account,
  f.sku_id,
  f.cor_id,
  f.nome_cor,
  f.preco_final_sayersystem,
  f.subcolecao_id,
  f.personalizada,
  f.updated_at,
  rf.is_sl,
  rf.tem_receita,
  rf.receita_valida,
  -- 13ª — RÓTULO ("Tabela (versão anterior)"): allowlist, VERBATIM da
  -- 20260724130000. Precisão de proveniência: canônica SL → só a geração
  -- congelada '1'; canônica não-SL → max de todas as ativas.
  (SELECT max(g2.preco_final_sayersystem)
     FROM public.tint_formulas g2
    WHERE g2.account = f.account
      AND g2.sku_id  = f.sku_id
      AND g2.cor_id  = f.cor_id
      AND g2.desativada_em IS NULL
      AND (NOT rf.is_sl
           OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                      WHERE s2.id = g2.subcolecao_id
                        AND s2.account = g2.account
                        AND s2.id_subcolecao_sayersystem = '1'))) AS preco_csv_legado,
  -- 14ª — PISO do gate de submit: conservadorismo, NÃO proveniência.
  -- NULL-preserving: sem "versão anterior" provada (coluna 13 NULL), o piso
  -- NÃO desce abaixo do calculado — devolver um número aqui AFROUXARIA o gate
  -- (ver o bloco do spec ingênuo no cabeçalho). Com ela provada, desce só até
  -- o max de TODAS as ativas da chave (superconjunto do max da allowlist ⇒
  -- I2: piso >= csv, sempre).
  CASE
    WHEN (SELECT max(g2.preco_final_sayersystem)
            FROM public.tint_formulas g2
           WHERE g2.account = f.account
             AND g2.sku_id  = f.sku_id
             AND g2.cor_id  = f.cor_id
             AND g2.desativada_em IS NULL
             AND (NOT rf.is_sl
                  OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                             WHERE s2.id = g2.subcolecao_id
                               AND s2.account = g2.account
                               AND s2.id_subcolecao_sayersystem = '1'))) IS NULL
      THEN NULL
    ELSE (SELECT max(g3.preco_final_sayersystem)
            FROM public.tint_formulas g3
           WHERE g3.account = f.account
             AND g3.sku_id  = f.sku_id
             AND g3.cor_id  = f.cor_id
             AND g3.desativada_em IS NULL)
  END AS preco_piso_legado
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  -- rank de preferência da PRÓPRIA linha (bloco gêmeo do rank da gêmea, abaixo)
  SELECT v.is_sl,
         v.tem_receita,
         (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (
    SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s
              WHERE s.id = f.subcolecao_id
                AND s.account = f.account
                AND s.id_subcolecao_sayersystem = 'SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi
              WHERE fi.formula_id = f.id) AS tem_receita,
      -- [MIRROR get_tint_prices.corantes_completos] todo item precisa de corante
      -- com omie valor>0 + ativo + volume>0; item órfão de corante conta como ruim.
      NOT EXISTS (
        SELECT 1
        FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c  ON c.id = fi.corante_id
        LEFT JOIN public.omie_products op ON op.id = c.omie_product_id
        WHERE fi.formula_id = f.id
          AND NOT (COALESCE(op.valor_unitario, 0) > 0
                   AND COALESCE(op.ativo, false)
                   AND c.volume_total_ml IS NOT NULL
                   AND c.volume_total_ml > 0)
      ) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL
  AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    -- existe gêmea MELHOR na mesma chave? (rank menor; empate → menor id vence)
    SELECT 1
    FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      -- rank de preferência da GÊMEA — bloco gêmeo verbatim do rank acima
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (
        SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s
                  WHERE s.id = g.subcolecao_id
                    AND s.account = g.account
                    AND s.id_subcolecao_sayersystem = 'SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi
                  WHERE fi.formula_id = g.id) AS tem_receita,
          NOT EXISTS (
            SELECT 1
            FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c  ON c.id = fi.corante_id
            LEFT JOIN public.omie_products op ON op.id = c.omie_product_id
            WHERE fi.formula_id = g.id
              AND NOT (COALESCE(op.valor_unitario, 0) > 0
                       AND COALESCE(op.ativo, false)
                       AND c.volume_total_ml IS NOT NULL
                       AND c.volume_total_ml > 0)
          ) AS corantes_ok
      ) w
    ) rg
    WHERE g.account = f.account
      AND g.sku_id  = f.sku_id
      AND g.cor_id  = f.cor_id
      AND g.desativada_em IS NULL
      AND g.id <> f.id
      AND (rg.rank_pref < rf.rank_pref
           OR (rg.rank_pref = rf.rank_pref AND g.id < f.id))
  );

COMMENT ON VIEW public.v_tint_formula_canonica IS
  'Fase 2 tintométrico: 1 fórmula canônica por (account, sku_id, cor_id) — '
  'preferência SL válida, fallback SAYERLACK/personalizada; não desativa nada. '
  'receita_valida espelha corantes_completos da RPC get_tint_prices (validade '
  'POR FÓRMULA; base_disponivel fica fora — gêmeas compartilham o SKU). '
  'preco_csv_legado = RÓTULO "Tabela (versão anterior)" (allowlist da geração '
  '''1'' quando a canônica é SL — precisão de PROVENIÊNCIA). '
  'preco_piso_legado = PISO do gate de submit (max de TODAS as ativas da chave '
  '— CONSERVADORISMO), NULL-preserving: NULL exatamente quando '
  'preco_csv_legado é NULL, senão o piso desceria onde hoje ele é o calculado. '
  'Invariantes: (csv IS NULL) ⟺ (piso IS NULL) e piso >= csv. '
  'security_invoker=on: repetir o WITH em todo replace (#1375).';

-- Grants inalterados (REPLACE preserva ACL); re-afirmados por idempotência do bloco.
REVOKE ALL ON public.v_tint_formula_canonica FROM PUBLIC;
REVOKE ALL ON public.v_tint_formula_canonica FROM anon;
GRANT SELECT ON public.v_tint_formula_canonica TO authenticated;
GRANT SELECT ON public.v_tint_formula_canonica TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. O gate: o PISO passa a ler a coluna nova; o RÓTULO ('tabela') não muda.
--    Corpo verbatim da 20260722100001 (md5 do pg_get_functiondef em PROD
--    conferido 2026-07-21: 0af971f5d05b29f58b35643fd4364cf9) exceto:
--      • DECLARE ganha v_can_piso / v_piso
--      • os 2 SELECT da canônica trazem também c.preco_piso_legado
--      • v_piso computado ao lado de v_tab (mesmo ceil10 — arredondar p/ CIMA
--        num piso é conservador)
--      • fontes 'manual' e ausente(legado): v_floor usa v_piso, não v_tab
--    A fonte 'tabela' segue validando contra v_tab (preco_csv_legado).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_gate_revalida(
  p_account text,
  p_customer_user_id uuid,
  p_sales_order_id uuid,
  p_contexto text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bloqueios jsonb := '[]'::jsonb;
  v_warnings  jsonb := '[]'::jsonb;
  v_baseline  jsonb;
  v_base_sigs jsonb;              -- {assinatura: count} do baseline
  v_usados    jsonb := '{}'::jsonb; -- {assinatura: count} já consumidos do payload
  v_item      jsonb;
  v_idx       int;
  v_cor       text;
  v_cod_txt   text;
  v_sig       text;
  v_base_n    int;
  v_uso_n     int;
  v_declarada uuid;
  v_declarada_coerente boolean;
  v_prod_id   uuid;
  v_is_base_tint boolean;
  v_n_skus    int;
  v_can_id    uuid;
  v_can_csv   numeric;
  v_can_piso  numeric;            -- 14ª coluna: piso conservador (NULL-preserving)
  v_price     jsonb;
  v_calc_raw  float8;
  v_calc      float8;
  v_tab       float8;
  v_piso      float8;             -- ceil10 do v_can_piso (espelha v_tab)
  v_vu        float8;
  v_fonte     text;
  v_desc      float8;
  v_esperado  float8;
  v_floor     float8;
  v_ult       jsonb;
  v_motivo    text;
  v_legado_ok boolean;

  -- espelhos JS (float8 de ponta a ponta — ver cabeçalho da 20260722100001):
  --   ceil10(v) ≡ Math.ceil(v*10)/10 · round2(v) ≡ floor(v*100+0.5)/100
BEGIN
  IF p_contexto NOT IN ('criacao', 'edicao') THEN
    RETURN jsonb_build_object('ok', false, 'bloqueios', jsonb_build_array(
      jsonb_build_object('index', -1, 'motivo', 'payload_invalido',
                         'detalhe', 'contexto desconhecido: ' || COALESCE(p_contexto, 'NULL'))),
      'warnings', v_warnings);
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'bloqueios', jsonb_build_array(
      jsonb_build_object('index', -1, 'motivo', 'payload_invalido',
                         'detalhe', 'items ausente ou não é array')),
      'warnings', v_warnings);
  END IF;

  -- Baseline PERSISTIDO (fonte de proveniência/intocabilidade — o caller não
  -- controla; a edição só persiste APÓS o gate). Linha ausente ⇒ '[]'.
  SELECT CASE WHEN jsonb_typeof(so.items) = 'array' THEN so.items ELSE '[]'::jsonb END
    INTO v_baseline
  FROM public.sales_orders so WHERE so.id = p_sales_order_id;
  v_baseline := COALESCE(v_baseline, '[]'::jsonb);

  -- Assinaturas do baseline (com contagem): T|produto|cor|qtd|valor|fonte|desc
  -- para item tint; B|produto|qtd|valor para base-sem-cor. Números
  -- canonicalizados via float8::text; campo malformado vira '?' (nunca erro).
  SELECT COALESCE(jsonb_object_agg(sig, n), '{}'::jsonb) INTO v_base_sigs
  FROM (
    SELECT
      CASE WHEN bi.item->>'tint_cor_id' IS NOT NULL AND bi.item->>'tint_cor_id' <> '' THEN
        'T|' || COALESCE(bi.item->>'omie_codigo_produto', '?') || '|' || (bi.item->>'tint_cor_id') || '|'
             || CASE WHEN jsonb_typeof(bi.item->'quantidade') = 'number'
                     THEN ((bi.item->>'quantidade')::float8)::text ELSE '?' END || '|'
             || CASE WHEN jsonb_typeof(bi.item->'valor_unitario') = 'number'
                     THEN ((bi.item->>'valor_unitario')::float8)::text ELSE '?' END || '|'
             || COALESCE(bi.item->>'tint_price_source', '-') || '|'
             || CASE WHEN jsonb_typeof(bi.item->'tint_discount_pct') = 'number'
                     THEN ((bi.item->>'tint_discount_pct')::float8)::text ELSE '0' END
      ELSE
        'B|' || COALESCE(bi.item->>'omie_codigo_produto', '?') || '|'
             || CASE WHEN jsonb_typeof(bi.item->'quantidade') = 'number'
                     THEN ((bi.item->>'quantidade')::float8)::text ELSE '?' END || '|'
             || CASE WHEN jsonb_typeof(bi.item->'valor_unitario') = 'number'
                     THEN ((bi.item->>'valor_unitario')::float8)::text ELSE '?' END
      END AS sig,
      count(*) AS n
    FROM jsonb_array_elements(v_baseline) AS bi(item)
    GROUP BY 1
  ) s;

  FOR v_idx, v_item IN
    SELECT (ord - 1)::int, val
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(val, ord)
  LOOP
    v_cor := NULLIF(v_item->>'tint_cor_id', '');

    -- valor_unitario numérico (o edge já barrou ≤0/NaN antes; defesa em profundidade)
    IF jsonb_typeof(v_item->'valor_unitario') <> 'number' THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'payload_invalido',
        'detalhe', 'valor_unitario não numérico');
      CONTINUE;
    END IF;
    v_vu := (v_item->>'valor_unitario')::float8;

    -- Código do produto: number OU string numérica (o edge trafega os dois —
    -- Codex P1 do diff: "900001" string escapava da classificação). Código
    -- ilegível NUNCA vira "não-tint": é payload_invalido (fail-closed).
    v_cod_txt := v_item->>'omie_codigo_produto';
    IF v_cod_txt IS NULL OR v_cod_txt !~ '^[0-9]{1,15}$' THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'payload_invalido',
        'detalhe', 'omie_codigo_produto ausente/não numérico: ' || COALESCE(v_cod_txt, 'NULL'));
      CONTINUE;
    END IF;

    v_prod_id := NULL; v_is_base_tint := false;
    SELECT op.id, COALESCE(op.is_tintometric, false) AND op.tint_type = 'base'
      INTO v_prod_id, v_is_base_tint
    FROM public.omie_products op
    WHERE op.omie_codigo_produto = v_cod_txt::bigint
      AND op.account = p_account;

    IF v_cor IS NULL THEN
      -- Item SEM marcador tint: só interessa se o PRODUTO é base tintométrica
      -- (classificação server-side — a ausência do marcador NÃO decide sozinha;
      -- Codex P1: omitir tint_cor_id não pode desligar o gate).
      CONTINUE WHEN NOT v_is_base_tint;
      IF p_contexto = 'criacao' THEN
        -- Push nunca produziu base sem cor (0 na história) — omissão = bloqueio.
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'motivo', 'base_sem_cor',
          'detalhe', 'base tintométrica sem cor não é vendável pelo app — escolha a cor no balcão de tinta');
        CONTINUE;
      END IF;
      -- Edição: linha inbound (balcão físico, importada do Omie) é legítima —
      -- mas SÓ intocada (mesma assinatura B| com contagem no baseline).
      v_sig := 'B|' || v_cod_txt || '|'
            || CASE WHEN jsonb_typeof(v_item->'quantidade') = 'number'
                    THEN ((v_item->>'quantidade')::float8)::text ELSE '?' END || '|'
            || (v_vu)::text;
      v_base_n := COALESCE((v_base_sigs->>v_sig)::int, 0);
      v_uso_n  := COALESCE((v_usados->>v_sig)::int, 0);
      IF v_uso_n < v_base_n THEN
        v_usados := jsonb_set(v_usados, ARRAY[v_sig], to_jsonb(v_uso_n + 1));
        CONTINUE; -- inbound preservada
      END IF;
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'motivo', 'base_sem_cor_alterada',
        'detalhe', 'base tintométrica sem cor alterada/nova na edição — reprecifique pela tela de tinta');
      CONTINUE;
    END IF;

    -- ── item COM tint_cor_id ──
    IF v_prod_id IS NULL THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'produto_nao_encontrado',
        'detalhe', 'produto do item tint não existe na conta ' || p_account);
      CONTINUE;
    END IF;

    -- Edição: item IDÊNTICO ao baseline (assinatura completa, com contagem)
    -- passa com warning — o valor já está no Omie; barrar impediria editar
    -- parcela/observação. Item novo/alterado segue para a validação.
    IF p_contexto = 'edicao' THEN
      v_sig := 'T|' || v_cod_txt || '|' || v_cor || '|'
            || CASE WHEN jsonb_typeof(v_item->'quantidade') = 'number'
                    THEN ((v_item->>'quantidade')::float8)::text ELSE '?' END || '|'
            || (v_vu)::text || '|'
            || COALESCE(v_item->>'tint_price_source', '-') || '|'
            || CASE WHEN jsonb_typeof(v_item->'tint_discount_pct') = 'number'
                    THEN ((v_item->>'tint_discount_pct')::float8)::text ELSE '0' END;
      v_base_n := COALESCE((v_base_sigs->>v_sig)::int, 0);
      v_uso_n  := COALESCE((v_usados->>v_sig)::int, 0);
      IF v_uso_n < v_base_n THEN
        v_usados := jsonb_set(v_usados, ARRAY[v_sig], to_jsonb(v_uso_n + 1));
        v_warnings := v_warnings || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'aviso', 'tint_intocado',
          'detalhe', 'item tint idêntico ao pedido persistido — preço não revalidado (já está no Omie)');
        CONTINUE;
      END IF;
    END IF;

    -- fórmula declarada (cast defensivo — uuid inválido vira NULL)
    v_declarada := NULL;
    IF (v_item->>'tint_formula_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_declarada := (v_item->>'tint_formula_id')::uuid;
    END IF;
    -- fórmula declarada COERENTE = existe em tint_formulas para (conta, cor) —
    -- qualquer geração (a declarada pode ser a gêmea re-canonizada). Fórmula
    -- ALHEIA (outra conta/cor) ou inexistente NÃO desambigua nem audita nada.
    v_declarada_coerente := false;
    IF v_declarada IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.tint_formulas tf
        WHERE tf.id = v_declarada AND tf.account = p_account AND tf.cor_id = v_cor
      ) INTO v_declarada_coerente;
    END IF;

    v_fonte := v_item->>'tint_price_source';

    -- Fonte declarada pelo PICKER exige a fórmula que o picker viu (anti-
    -- adulteração — Codex P1 do diff). 'manual' (edição humana) e legado não
    -- têm picker por trás, então não exigem.
    IF v_fonte IN ('calculado', 'tabela', 'cliente') AND NOT v_declarada_coerente THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'payload_invalido',
        'detalhe', 'fonte declarada sem tint_formula_id válido de (conta, cor) — reprecifique no balcão de tinta');
      CONTINUE;
    END IF;

    -- Canônicas candidatas da célula: produto pode ter MAIS de um SKU com a
    -- cor. Sem fórmula declarada que desambigue, célula ambígua BLOQUEIA
    -- (nunca desempatar preço por UUID — Codex P1 do diff).
    SELECT count(*) INTO v_n_skus
    FROM public.tint_skus s
    JOIN public.v_tint_formula_canonica c
      ON c.account = p_account AND c.sku_id = s.id AND c.cor_id = v_cor
    WHERE s.omie_product_id = v_prod_id
      AND s.account = p_account;

    IF v_n_skus = 0 THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'formula_morta',
        'detalhe', 'não há fórmula ativa/canônica desta cor para o produto — reprecifique no balcão de tinta');
      CONTINUE;
    END IF;

    v_can_id := NULL; v_can_csv := NULL; v_can_piso := NULL;
    IF v_n_skus > 1 THEN
      -- só a fórmula declarada (do picker) desambigua a célula
      SELECT c.id, c.preco_csv_legado, c.preco_piso_legado
        INTO v_can_id, v_can_csv, v_can_piso
      FROM public.tint_skus s
      JOIN public.v_tint_formula_canonica c
        ON c.account = p_account AND c.sku_id = s.id AND c.cor_id = v_cor
      WHERE s.omie_product_id = v_prod_id
        AND s.account = p_account
        AND c.id = v_declarada;
      IF v_can_id IS NULL THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'formula_ambigua',
          'detalhe', 'o produto tem mais de um SKU com esta cor e a fórmula declarada não resolve — reprecifique no balcão de tinta');
        CONTINUE;
      END IF;
    ELSE
      SELECT c.id, c.preco_csv_legado, c.preco_piso_legado
        INTO v_can_id, v_can_csv, v_can_piso
      FROM public.tint_skus s
      JOIN public.v_tint_formula_canonica c
        ON c.account = p_account AND c.sku_id = s.id AND c.cor_id = v_cor
      WHERE s.omie_product_id = v_prod_id
        AND s.account = p_account;
    END IF;

    IF v_declarada_coerente AND v_declarada <> v_can_id THEN
      -- geração trocou (ex.: Fase 5 desativar a SAYERLACK) — informa, não barra;
      -- o PREÇO é validado contra a canônica atual de qualquer forma.
      v_warnings := v_warnings || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'aviso', 'formula_recanonizada',
        'declarada', v_declarada, 'canonica', v_can_id);
    END IF;

    -- motor de preço AGORA (get_tint_price REAL — sem cache de 5min)
    v_price := public.get_tint_price(v_can_id);
    v_calc_raw := (v_price->>'precoFinal')::float8;
    IF v_calc_raw IS NULL THEN
      -- paridade com selectTintPrice regra 1: motor sem preço bloqueia TODAS
      -- as fontes (inclusive tabela/cliente) — nunca vender o que a RPC barra.
      v_motivo := CASE
        WHEN NOT COALESCE((v_price->>'baseDisponivel')::boolean, false) THEN 'base'
        WHEN NOT COALESCE((v_price->>'corantesCompletos')::boolean, false) THEN 'corante'
        ELSE 'receita' END;
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'sem_preco_motor',
        'detalhe', 'motor honesto sem preço (' || v_motivo || ') — corrija no Omie/tintométrico antes de vender');
      CONTINUE;
    END IF;

    v_calc := ceil(v_calc_raw * 10) / 10;                       -- ceil10 (≡ JS)
    -- RÓTULO (fonte 'tabela'): allowlist, proveniência provada.
    v_tab  := CASE WHEN v_can_csv IS NOT NULL AND v_can_csv > 0
                   THEN ceil((v_can_csv)::float8 * 10) / 10 ELSE NULL END;
    -- PISO (fontes 'manual' e legado): conservador.
    -- ⚠️ ELEGIBILIDADE ACOPLADA a v_tab (achado P1 do challenge Codex xhigh,
    -- 2026-07-21). O NULL-preserving da view garante os invariantes sobre os
    -- valores CRUS — mas o guard `> 0` aqui cria uma SEGUNDA forma de "ausente"
    -- que a view não conhece, e por ela a monotonicidade vazava:
    --   csv = 0 (≠ NULL) e piso = 90, calc = 102.5
    --   ⇒ I1 passa (nenhum é NULL) e I2 passa (90 >= 0) — os dois invariantes
    --     provados ficam VERDES — mas v_tab vira NULL e v_piso vira 90, então
    --     o piso EFETIVO cai de 102.5 para 90 e um manual de 95 passa a ser
    --     aceito onde hoje bloqueia. Afrouxamento pela porta dos fundos.
    -- Gatear v_piso em v_tab restaura a monotonicidade no nível EFETIVO:
    --   v_tab IS NULL ⇒ v_piso IS NULL   ·   ambos presentes ⇒ v_piso >= v_tab
    --   ⇒ v_floor novo >= v_floor de hoje SEMPRE. Sem isto a alegação é falsa.
    -- (Classe medida em prod 2026-07-21: 0 chaves — latente, como o resto.)
    v_piso := CASE WHEN v_tab IS NOT NULL AND v_can_piso IS NOT NULL AND v_can_piso > 0
                   THEN ceil((v_can_piso)::float8 * 10) / 10 ELSE NULL END;

    -- desconto declarado (0 ≤ d < 100; ausente = 0). d=100 é incompatível com
    -- o guard global preço>0 do edge — contrato alinhado (Codex).
    v_desc := 0;
    IF v_item ? 'tint_discount_pct' THEN
      IF jsonb_typeof(v_item->'tint_discount_pct') <> 'number' THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'desconto_invalido',
          'detalhe', 'tint_discount_pct não numérico');
        CONTINUE;
      END IF;
      v_desc := (v_item->>'tint_discount_pct')::float8;
      IF v_desc < 0 OR v_desc >= 100 THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'desconto_invalido',
          'detalhe', 'tint_discount_pct fora de 0–99.99: ' || v_desc);
        CONTINUE;
      END IF;
    END IF;

    IF v_fonte = 'calculado' THEN
      v_esperado := floor(v_calc * (1 - v_desc/100) * 100 + 0.5) / 100;

    ELSIF v_fonte = 'tabela' THEN
      -- ⚠️ a fonte 'tabela' valida contra o RÓTULO (v_tab), NÃO contra o piso:
      -- a escolha da vendedora é sobre PROVENIÊNCIA ("versão anterior"), e
      -- validar contra o piso conservador barraria a escolha legítima.
      IF v_tab IS NULL THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'fonte_tabela_indisponivel',
          'detalhe', 'a fonte "tabela" foi escolhida mas a chave não tem mais CSV — reprecifique no balcão');
        CONTINUE;
      END IF;
      v_esperado := floor(v_tab * (1 - v_desc/100) * 100 + 0.5) / 100;

    ELSIF v_fonte = 'cliente' THEN
      v_ult := public.tint_ultimo_preco_cliente(
        p_customer_user_id, v_prod_id, v_cor, p_sales_order_id);
      IF v_ult IS NULL OR jsonb_typeof(v_ult->'price') <> 'number' THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'preco_cliente_sem_historico',
          'detalhe', 'a fonte "cliente" exige pedido real no Omie (não-cancelado, últimos 180 dias) — não encontrado');
        CONTINUE;
      END IF;
      v_esperado := floor((v_ult->>'price')::float8 * (1 - v_desc/100) * 100 + 0.5) / 100;

    ELSIF v_fonte = 'manual' THEN
      -- Preço digitado pelo humano na EDIÇÃO (o front seta 'manual' ao editar
      -- valor de item tint): subir é livre; baixar além do piso atual das
      -- fontes legítimas bloqueia. Nada abaixo do que 'tabela'/'calculado'
      -- sem desconto já permitiriam (Codex P1 do diff: sem esta fonte, todo
      -- aumento manual legítimo caía em metadados_ausentes).
      -- ⚠️ v_piso (conservador), NÃO v_tab (allowlist): encolher o conjunto do
      -- max para dar precisão AO RÓTULO não pode afrouxar o PISO.
      v_floor := LEAST(v_calc, COALESCE(v_piso, v_calc));
      IF v_vu < v_floor - 0.005 THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'preco_obsoleto',
          'detalhe', 'preço manual abaixo do piso atual das fontes (calc/tabela) — reprecifique no balcão de tinta',
          'esperado_minimo', v_floor, 'recebido', v_vu);
      END IF;
      CONTINUE;

    ELSIF v_fonte IS NULL THEN
      -- SEM metadados: o fallback legado (piso) EXIGE prova de proveniência —
      -- existe no baseline persistido um item da MESMA célula TAMBÉM sem fonte
      -- (orçamento/pedido pré-Fase-3). Sem essa prova, item novo que omite
      -- metadados é bloqueado (o fallback não é controlável pelo caller).
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_baseline) AS bi(item)
        WHERE bi.item->>'omie_codigo_produto' = v_cod_txt
          AND bi.item->>'tint_cor_id' = v_cor
          AND bi.item->>'tint_price_source' IS NULL
      ) INTO v_legado_ok;
      IF NOT v_legado_ok THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'metadados_ausentes',
          'detalhe', 'item tint sem fonte de preço declarada e sem lastro legado no pedido — reprecifique no balcão de tinta');
        CONTINUE;
      END IF;
      -- mesmo piso conservador da fonte 'manual' (ver nota acima)
      v_floor := LEAST(v_calc, COALESCE(v_piso, v_calc));
      IF v_vu < v_floor - 0.005 THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'preco_obsoleto',
          'detalhe', 'preço abaixo do piso atual das fontes (calc/tabela) — reprecifique no balcão de tinta',
          'esperado_minimo', v_floor, 'recebido', v_vu);
      END IF;
      CONTINUE;

    ELSE
      -- fonte desconhecida (typo/adulteração) — nunca cair no fallback
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'fonte_invalida',
        'detalhe', 'tint_price_source desconhecida: ' || v_fonte);
      CONTINUE;
    END IF;

    -- Auditoria: preco_sem_desconto declarado divergente da fonte recomputada
    -- vira WARNING (o preço COBRADO já é validado acima — bloquear aqui só
    -- criaria falso positivo sem proteção extra).
    IF jsonb_typeof(v_item->'tint_preco_sem_desconto') = 'number' THEN
      IF abs((v_item->>'tint_preco_sem_desconto')::float8 -
             CASE v_fonte
               WHEN 'calculado' THEN v_calc
               WHEN 'tabela'    THEN v_tab
               ELSE (v_ult->>'price')::float8
             END) > 0.005 THEN
        v_warnings := v_warnings || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'aviso', 'preco_sem_desconto_divergente',
          'declarado', (v_item->>'tint_preco_sem_desconto')::float8);
      END IF;
    END IF;

    IF abs(v_vu - v_esperado) > 0.005 THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'preco_divergente',
        'detalhe', 'o preço da fonte "' || v_fonte || '" mudou desde a montagem do pedido — reprecifique no balcão de tinta',
        'fonte', v_fonte, 'esperado', v_esperado, 'recebido', v_vu);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_bloqueios) = 0,
    'bloqueios', v_bloqueios,
    'warnings', v_warnings);
END;
$$;

COMMENT ON FUNCTION public.tint_gate_revalida(text, uuid, uuid, text, jsonb) IS
  'Fase 3 tint: gate da fronteira omie-vendas-sync (criar_pedido/alterar_'
  'pedido). Revalida item tint contra o estado ATUAL (canônica viva + preço '
  'recomputado + fonte declarada, aritmética float8 ≡ JS). Baseline persistido '
  'decide proveniência (legado=piso) e intocabilidade (edição). Fontes: '
  'calculado/tabela/cliente (exigem tint_formula_id coerente) · manual (piso) '
  '· ausente (legado com lastro). Base tint sem cor: bloqueia na criação; na '
  'edição só intocada (inbound). Multi-SKU sem fórmula que desambigue: '
  'bloqueia. service_role-only. Bloqueio ⇒ {ok:false,bloqueios:[…]} — o edge '
  'NÃO toca o Omie. '
  '2026-07-21: o PISO ("manual"/legado) passou a ler preco_piso_legado (max '
  'CONSERVADOR de todas as ativas da chave); a fonte "tabela" segue lendo '
  'preco_csv_legado (RÓTULO, allowlist). Separar os dois impede que dar '
  'precisão de proveniência ao rótulo afrouxe o piso do submit.';

-- Autorização inalterada (REPLACE preserva ACL); re-afirmada por idempotência.
REVOKE ALL ON FUNCTION public.tint_gate_revalida(text, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tint_gate_revalida(text, uuid, uuid, text, jsonb) TO service_role;

-- Coluna nova exposta via PostgREST
NOTIFY pgrst, 'reload schema';
