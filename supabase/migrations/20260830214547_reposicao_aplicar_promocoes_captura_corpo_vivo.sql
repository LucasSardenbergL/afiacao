-- ============================================================
-- aplicar_promocoes_no_ciclo — CAPTURA do corpo VIVO de produção
--
-- POR QUE ESTA MIGRATION EXISTE (leia antes de mexer)
-- Três migrations de 2026-06-06 redefinem esta função com CREATE OR REPLACE:
--   20260606170000_reposicao_fix_aplicar_promocoes.sql        define, SEM hardening
--   20260606180000_reposicao_aplicar_promocoes_hardening.sql  ADICIONA o hardening
--   20260606200000_reposicao_promo_forward_buying_min.sql     redefine SEM o hardening
-- A das 20h desfez o hardening das 18h DENTRO DO REPO — a armadilha do
-- "a última a recriar vence" (docs/agent/database.md §4), só que no repo.
-- Produção ficou na linhagem das 18h; o repo ficou com a versão regressiva.
--
-- ⛔ A 20260606200000 está APOSENTADA. NÃO a aplique — ela REGRIDE produção:
--    perde o guard `ajustado_humano IS NOT TRUE`, perde o join com
--    promocao_campanha + janela de datas + tipo_ciclo='normal', e troca o
--    `::text` por `::bigint` no join de código de produto (o que ainda
--    inutiliza o índice idx_pedido_compra_item_sku, btree sobre coluna text).
--    Os 3 defeitos que ela declarava fechar estão medidos como não-defeitos
--    (docs/historico/deriva-de-corpo-prod-a-frente-do-repo.md).
--
-- O QUE ESTA MIGRATION FAZ: re-emite o corpo VIVO, VERBATIM, para que a ÚLTIMA
-- migration do repo que define a função volte a ser a hardened. Medido em
-- 2026-08-30 via psql-ro: o corpo vivo é IDÊNTICO ao da 20260606180000 (md5 do
-- corpo sem comentários, espaço colapsado = f3587d9f51e3fa20635a598abe98aae1 dos
-- dois lados). O apply é NO-OP DE EFEITO — não muda comportamento.
--
-- ⚠️ Os comentários internos aparecem truncados ("-- [H7]" em vez de
--    "-- [H7] guard NaN/∞/zero (promoção)"). Isso é FIEL a produção, não descuido:
--    a ferramenta de apply do Lovable descarta o rabo dos comentários, e capturar
--    verbatim é o que mantém o md5 do corpo estável entre repo e banco (é o que a
--    Seção 3 de scripts/audit-custom-migrations.ts compara). Os comentários
--    completos estão na 20260606180000.
--
-- CREATE OR REPLACE (nunca DROP+CREATE): a função tem ACL EXPLÍCITA
-- (anon/authenticated/service_role com EXECUTE) que o REPLACE preserva e o
-- DROP+CREATE zeraria (CLAUDE.md).
-- ============================================================

-- ---------- GUARD: só substitui sobre um corpo da linhagem HARDENED ----------
-- Evidência de banco tem VALIDADE (database.md §2): se alguém tocou a função
-- entre a medição e este apply, colar às cegas repetiria o erro que esta migration
-- existe para consertar. O gate tem DOIS eixos, porque um só não basta:
--   (1) SEMÂNTICO — os marcadores do hardening têm de estar presentes. É o que
--       pega o caso perigoso de verdade: prod estar com o corpo da 20260606200000.
--   (2) md5 em ALLOWLIST — dois corpos conhecidos-bons, que diferem SÓ em
--       comentário: o vivo de prod (rabo truncado pelo apply) e o que a
--       20260606180000 instala (comentários completos, que é o que um replay do
--       repo produz). md5 fora da lista COM os marcadores presentes = alguma outra
--       variante hardened apareceu ⇒ aborta pedindo re-medição, em vez de decidir
--       sozinha. Fail-closed nos dois eixos.
DO $guard$
DECLARE
  v_src       text;
  v_md5       text;
  c_vivo      constant text := 'b48783701e1a5987cffc04da2965d719';  -- prod 2026-08-30 (comentário truncado)
  c_migracao  constant text := 'c0ac59ea6b0d5efb186bb9c7e1669097';  -- o que a 20260606180000 instala
BEGIN
  SELECT p.prosrc,
         md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g'))
    INTO v_src, v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'aplicar_promocoes_no_ciclo'
    AND pg_get_function_identity_arguments(p.oid) = 'p_empresa text, p_data_ciclo date';

  IF v_src IS NULL THEN
    RAISE EXCEPTION
      'ABORT: public.aplicar_promocoes_no_ciclo(text, date) nao existe. Esta migration '
      'e um CREATE OR REPLACE de CAPTURA, nao a criacao inicial — aplique antes a '
      '20260606180000_reposicao_aplicar_promocoes_hardening.sql.';
  END IF;

  -- eixo 1: semantico
  IF position('ajustado_humano'   in v_src) = 0
     OR position('promocao_campanha' in v_src) = 0
     OR position('tipo_ciclo'        in v_src) = 0 THEN
    RAISE EXCEPTION
      'ABORT: o corpo vivo NAO e da linhagem hardened (faltam marcadores). '
      'Provavelmente a 20260606200000 foi aplicada — ela e REGRESSIVA e esta '
      'APOSENTADA. Investigue antes de substituir: psql-ro + pg_get_functiondef.';
  END IF;

  -- eixo 2: allowlist de md5 conhecidos-bons
  IF v_md5 <> c_vivo AND v_md5 <> c_migracao THEN
    RAISE EXCEPTION
      'ABORT: corpo hardened porem DESCONHECIDO (md5=%). Nao esta na allowlist '
      '(vivo=% / 20260606180000=%). Alguem evoluiu a funcao depois de 2026-08-30: '
      're-meca com pg_get_functiondef via psql-ro e reavalie esta captura antes de '
      'sobrescrever trabalho alheio.', v_md5, c_vivo, c_migracao;
  END IF;
END
$guard$;

-- ---------- O CORPO VIVO, VERBATIM ----------
CREATE OR REPLACE FUNCTION public.aplicar_promocoes_no_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(itens_flat_aplicados integer, itens_forward_buying_aplicados integer, pedidos_afetados integer, economia_total_estimada numeric, pedidos_bloqueados_por_delta integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_flat int := 0;
  v_fb int := 0;
  v_pedidos int := 0;
  v_economia numeric := 0;
  v_bloqueados int := 0;
BEGIN
  -- ========== MODO FLAT: desconto no preço, quantidade inalterada ==========
  WITH aplicados_flat AS (
    UPDATE pedido_compra_item pci
    SET preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        valor_linha = pci.qtde_final * (pci.preco_unitario * (1 - av.desconto_perc / 100)),
        modo_promocao = 'flat',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = pci.qtde_final * pci.preco_unitario * av.desconto_perc / 100
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs, promocao_campanha pc
    WHERE pcs.id = pci.pedido_id
      AND pc.id = av.campanha_id                                       -- [H2]
      AND pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim        -- [H2] vigência na data do pedido
      AND av.modo_aplicacao = 'flat'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND pcs.fornecedor_nome = av.fornecedor_nome                     -- [H1]
      AND pci.sku_codigo_omie = av.sku_codigo_omie::text               -- [H3]
      AND pci.ajustado_humano IS NOT TRUE                              -- [H4]
      AND pci.qtde_final > 0 AND pci.qtde_final < 'Infinity'::numeric   -- [H7b]
      AND pci.modo_promocao IS NULL                                    -- idempotência
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_flat FROM aplicados_flat;

  -- ========== MODO FORWARD BUYING: infla quantidade (nunca rebaixa) ==========
  WITH aplicados_fb AS (
    UPDATE pedido_compra_item pci
    SET qtde_sem_promocao = pci.qtde_final,                            -- [H6] baseline real
        qtde_final = GREATEST(av.qtde_com_desconto, pci.qtde_final),   -- [H6] nunca rebaixa o mínimo/ajuste
        valor_linha = GREATEST(av.qtde_com_desconto, pci.qtde_final) * pci.preco_unitario * (1 - av.desconto_perc / 100),
        preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        modo_promocao = 'forward_buying',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = GREATEST(av.qtde_com_desconto, pci.qtde_final) * pci.preco_unitario * av.desconto_perc / 100  -- [H6]
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs, promocao_campanha pc
    WHERE pcs.id = pci.pedido_id
      AND pc.id = av.campanha_id                                       -- [H2]
      AND pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim        -- [H2]
      AND av.modo_aplicacao = 'forward_buying'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND pcs.fornecedor_nome = av.fornecedor_nome                     -- [H1]
      AND pci.sku_codigo_omie = av.sku_codigo_omie::text               -- [H3]
      AND pci.ajustado_humano IS NOT TRUE                              -- [H4]
      AND pci.modo_promocao IS NULL
      AND av.qtde_com_desconto > 0 AND av.qtde_com_desconto < 'Infinity'::numeric  -- [H7]
      AND pci.qtde_final > 0 AND pci.qtde_final < 'Infinity'::numeric   -- [H7b]
      AND pci.qtde_final >= COALESCE(av.qtde_base, 0)                  -- [H7]
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_fb FROM aplicados_fb;

  -- Conta pedidos afetados e soma economia (estado do ciclo)
  SELECT COUNT(DISTINCT pedido_id), COALESCE(SUM(economia_estimada_valor), 0)
  INTO v_pedidos, v_economia
  FROM pedido_compra_item
  WHERE pedido_id IN (
      SELECT id FROM pedido_compra_sugerido
      WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND tipo_ciclo = 'normal'  -- [H5]
    )
    AND modo_promocao IS NOT NULL;

  -- Recalcula valor_total dos pedidos afetados
  UPDATE pedido_compra_sugerido pcs
  SET valor_total = (
      SELECT COALESCE(SUM(valor_linha), 0)
      FROM pedido_compra_item
      WHERE pedido_id = pcs.id
    )
  WHERE pcs.empresa = p_empresa
    AND pcs.data_ciclo = p_data_ciclo
    AND pcs.status = 'pendente_aprovacao'
    AND pcs.tipo_ciclo = 'normal'                                      -- [H5]
    AND EXISTS (
      SELECT 1 FROM pedido_compra_item pci
      WHERE pci.pedido_id = pcs.id AND pci.modo_promocao IS NOT NULL
    );

  -- Reavalia guardrail de delta — só para pedidos inflados por forward_buying
  WITH reavaliacao AS (
    UPDATE pedido_compra_sugerido pcs
    SET delta_vs_anterior_perc = CASE
          WHEN pcs.pedido_anterior_valor > 0
          THEN ROUND(((pcs.valor_total - pcs.pedido_anterior_valor) / pcs.pedido_anterior_valor * 100)::numeric, 1)
          ELSE NULL END,
        status = CASE
          WHEN pcs.pedido_anterior_valor > 0
            AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
              (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
               WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
            )
          THEN 'bloqueado_guardrail'
          ELSE pcs.status END,
        mensagem_bloqueio = CASE
          WHEN pcs.pedido_anterior_valor > 0
            AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
              (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
               WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
            )
          THEN 'Variação acima do delta máximo — forward buying promocional inflou pedido, revisar'
          ELSE pcs.mensagem_bloqueio END
    WHERE pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND EXISTS (
        SELECT 1 FROM pedido_compra_item pci
        WHERE pci.pedido_id = pcs.id AND pci.modo_promocao = 'forward_buying'
      )
    RETURNING id, status
  )
  SELECT COUNT(*) FILTER (WHERE status = 'bloqueado_guardrail') INTO v_bloqueados FROM reavaliacao;

  RETURN QUERY SELECT v_flat, v_fb, v_pedidos, v_economia, v_bloqueados;
END;
$function$;

-- ---------- VERIFICAÇÃO: o hardening sobreviveu ao replace ----------
-- Asserção POSITIVA e específica sobre o corpo QUE FICOU. Se algum marcador do
-- hardening sumir, a transação inteira reverte — o oposto do que a 20260606200000 faz.
DO $verifica$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'aplicar_promocoes_no_ciclo'
    AND pg_get_function_identity_arguments(p.oid) = 'p_empresa text, p_data_ciclo date';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'ABORT: funcao sumiu apos o replace.';
  END IF;

  -- [H4] promocao nao pisa em quantidade ajustada a mao
  IF position('ajustado_humano' in v_src) = 0 THEN
    RAISE EXCEPTION 'ABORT: guard `ajustado_humano` AUSENTE — corpo regressivo instalado.';
  END IF;

  -- [H1/H5] janela de campanha + tipo de ciclo
  IF position('promocao_campanha' in v_src) = 0 THEN
    RAISE EXCEPTION 'ABORT: join com `promocao_campanha` AUSENTE — corpo regressivo instalado.';
  END IF;
  IF position('tipo_ciclo' in v_src) = 0 THEN
    RAISE EXCEPTION 'ABORT: filtro `tipo_ciclo` AUSENTE — corpo regressivo instalado.';
  END IF;

  -- [H3] join de codigo de produto por TEXTO (mantem idx_pedido_compra_item_sku utilizavel)
  IF position('av.sku_codigo_omie::text' in v_src) = 0 THEN
    RAISE EXCEPTION 'ABORT: join `::text` AUSENTE — a variante `::bigint` foi instalada.';
  END IF;
  IF position('sku_codigo_omie::bigint' in v_src) > 0 THEN
    RAISE EXCEPTION 'ABORT: join `::bigint` PRESENTE — corpo da 20260606200000 instalado.';
  END IF;

  RAISE NOTICE 'OK: aplicar_promocoes_no_ciclo com o hardening integro (5 marcadores).';
END
$verifica$;
