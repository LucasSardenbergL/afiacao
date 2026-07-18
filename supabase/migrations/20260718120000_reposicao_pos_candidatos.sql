-- Reposição — PR2: CANDIDATOS a PO excluído no Omie (detector, NÃO-MUTANTE) — money-path
-- ============================================================================
-- O PR1 (em prod desde 16/07) publica, a cada varredura COMPLETA e LIMPA, o marcador de run e o
-- `reposicao_po_last_seen` de todo PO visto. Esta RPC responde: quais pedidos `disparado` têm um PO que
-- NÃO apareceu no último run válido? Ela CLASSIFICA e NÃO decide — não muta nada, não cancela nada.
--
-- ⚠️ A LIÇÃO QUE MUDOU O DESIGN (dado de prod, 16/07 + Codex): "PO sumiu do Omie" NÃO prova "a compra não
-- existe". O `disparar-pedidos-aprovados` aciona o PORTAL DO FORNECEDOR **antes** de criar o PO no Omie —
-- então existe estado real em que o fornecedor está com o pedido PROTOCOLADO e o PO não está mais lá.
-- Os 2 únicos candidatos de hoje são exatamente isso: pedidos 281/286 (Sayerlack, protocolos 2097501/2097910,
-- `fornecedor_notificado=true`, entrega prometida 10/06). Cancelá-los faria o motor RECOMPRAR ~R$3.060 que a
-- Sayerlack já tem protocolado — o pedido duplicado que o princípio precisão>recall existe para evitar.
-- Por isso a coluna `rota`: com compromisso de fornecedor NUNCA há auto-cancelamento, vai para humano.
--
-- Design: docs/superpowers/specs/2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md §5.5
-- Prova PG17: db/test-reposicao-pos-candidatos.sh
-- NÃO editar esta migration depois de aplicada (snapshot é a fonte de DR).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
RETURNS TABLE (
  pedido_id              bigint,
  omie_codigo_pedido     text,
  data_ciclo             date,
  idade_dias             integer,
  dano_ativo             boolean,
  valor_total            numeric,
  visto_status           text,
  po_no_espelho          boolean,
  fornecedor_nome        text,
  canal_usado            text,
  compromisso_fornecedor text,
  rota                   text,
  marcador_run_id        uuid,
  marcador_seq           bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_empresa public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
BEGIN
  -- Gate cron-or-staff NULL-aware: uid presente exige staff; uid NULL (service_role/cron SQL-local) passa.
  -- ⚠️ NUNCA gatear por auth.role()='service_role' — o pg_cron roda como postgres SEM JWT (auth.role()=NULL)
  -- e o gate mataria o cron em SILÊNCIO (reposicao.md: mordido 2x, migrations 20260627130000/20260627200000).
  IF (SELECT auth.uid()) IS NOT NULL
     AND NOT (SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) THEN
    RAISE EXCEPTION 'reposicao_pos_candidatos: acesso negado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH marcador AS (
    -- "último completo válido" = maior fencing seq com volume_ok TRUE. Se NÃO houver (bootstrap, ou todos os
    -- runs truncados), o CROSS JOIN não produz linhas → retorna VAZIO. Fail-closed de propósito: sem base de
    -- verdade não se classifica ninguém como ausente (senão TODO PO viraria candidato de uma vez).
    SELECT r.run_id, r.seq
    FROM public.reposicao_pedidos_compra_run r
    WHERE r.empresa = v_empresa AND r.status = 'ok' AND r.volume_ok IS TRUE
    ORDER BY r.seq DESC
    LIMIT 1
  ),
  base AS (
    SELECT
      p.id AS pedido_id,
      p.omie_pedido_compra_id AS omie_codigo_pedido,
      p.data_ciclo::date AS data_ciclo,
      (now()::date - p.data_ciclo::date)::integer AS idade_dias,
      p.fornecedor_nome,
      p.canal_usado,
      p.portal_protocolo,
      p.status_envio_portal,
      (p.resposta_canal ->> 'fornecedor_notificado') AS notificado_flag,
      m.run_id AS marcador_run_id,
      m.seq AS marcador_seq,
      ls.run_id AS visto_run_id,
      (SELECT sum(i.valor_linha) FROM public.pedido_compra_item i WHERE i.pedido_id = p.id) AS valor_total,
      EXISTS (
        SELECT 1 FROM public.purchase_orders_tracking t
        WHERE t.empresa = v_empresa AND t.omie_codigo_pedido::text = p.omie_pedido_compra_id
      ) AS po_no_espelho
    FROM public.pedido_compra_sugerido p
    CROSS JOIN marcador m
    LEFT JOIN public.reposicao_po_last_seen ls
           ON ls.empresa = v_empresa
          AND ls.omie_codigo_pedido::text = p.omie_pedido_compra_id
    -- ⚠️ `pedido_compra_sugerido.empresa` é **text** (valores 'OBEN'), enquanto purchase_orders_tracking /
    -- reposicao_po_last_seen / reposicao_pedidos_compra_run usam o ENUM empresa_reposicao. Comparar text = enum
    -- direto é erro de TIPO em runtime (PL/pgSQL é late-bound: o CREATE passa e só quebra ao EXECUTAR). O
    -- upper(btrim()) ainda tolera caixa divergente — o repo já foi mordido por 'OBEN' vs 'oben' (reposicao.md).
    WHERE upper(btrim(p.empresa)) = v_empresa::text
      AND p.status IN ('disparado', 'aprovado_aguardando_disparo')
      AND p.omie_pedido_compra_id IS NOT NULL
      AND btrim(p.omie_pedido_compra_id) <> ''
      -- CANDIDATO = o PO não foi visto no marcador atual. Duas formas: carimbado por um run ANTERIOR, ou
      -- NUNCA carimbado. "Nunca carimbado" entra de propósito (fail-closed) — mas veja `rota`: a decisão
      -- final é da prova por ID (PR2b), não daqui.
      AND (ls.run_id IS NULL OR ls.run_id <> m.run_id)
  )
  SELECT
    b.pedido_id,
    b.omie_codigo_pedido,
    b.data_ciclo,
    b.idade_dias,
    -- DANO ATIVO = a CTE em_transito do motor só soma disparados dos últimos 7d; fora disso o pedido não
    -- infla o estoque (o item já volta a ser sugerido). Idade classifica PRIORIDADE, não verdade.
    (b.idade_dias <= 7) AS dano_ativo,
    b.valor_total,
    CASE WHEN b.visto_run_id IS NULL THEN 'nunca_carimbado' ELSE 'visto_em_run_anterior' END AS visto_status,
    -- SINAL FRACO, informativo: o sync do tracking é upsert-only (nunca remove), então ausência do espelho
    -- NÃO prova exclusão — pode ser "nunca entrou na janela de previsão" (Codex refutou meu corroborante).
    b.po_no_espelho,
    b.fornecedor_nome,
    b.canal_usado,
    -- O GUARD QUE MUDOU O DESIGN: o portal do fornecedor é acionado ANTES do Omie. Protocolo/notificação =
    -- compromisso REAL lá fora, que a exclusão do PO no Omie não desfaz.
    CASE
      WHEN b.portal_protocolo IS NOT NULL AND btrim(b.portal_protocolo) <> '' THEN 'protocolado'
      WHEN b.status_envio_portal = 'sucesso_portal' THEN 'enviado_portal'
      WHEN lower(COALESCE(b.notificado_flag, '')) = 'true' THEN 'notificado'
      ELSE 'nenhum'
    END AS compromisso_fornecedor,
    CASE
      WHEN (b.portal_protocolo IS NOT NULL AND btrim(b.portal_protocolo) <> '')
        OR b.status_envio_portal = 'sucesso_portal'
        OR lower(COALESCE(b.notificado_flag, '')) = 'true'
      -- NUNCA auto-cancela: o fornecedor tem o pedido. O caminho provável é RECRIAR o PO no Omie (o sistema
      -- precisa refletir a compra que existe), não cancelar e re-sugerir (= comprar de novo).
      THEN 'reconciliacao_humana'
      ELSE 'elegivel_prova_id'
    END AS rota,
    b.marcador_run_id,
    b.marcador_seq
  FROM base b
  ORDER BY (b.idade_dias <= 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$$;

COMMENT ON FUNCTION public.reposicao_pos_candidatos(text) IS
  'PR2 (NÃO-MUTANTE): pedidos disparado/aprovado cujo PO não apareceu no último run VÁLIDO do omie-sync-pedidos-compra. CLASSIFICA (idade, dano_ativo, compromisso_fornecedor) e NÃO decide. rota=reconciliacao_humana quando há protocolo/notificação no fornecedor — nesses casos NUNCA auto-cancelar (o portal é acionado ANTES do Omie: o fornecedor pode estar com o pedido mesmo sem PO no Omie). Sem marcador válido retorna VAZIO (fail-closed).';

-- Leitura não-mutante: staff (gate interno) + service_role. anon nunca.
REVOKE ALL ON FUNCTION public.reposicao_pos_candidatos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;

COMMIT;
