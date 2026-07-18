-- Reposição — PR2: CANDIDATOS a PO excluído no Omie (detector, NÃO-MUTANTE) — money-path
-- ============================================================================
-- O PR1 (em prod desde 16/07) publica, a cada varredura COMPLETA e LIMPA, o marcador de run e o
-- `reposicao_po_last_seen` de todo PO visto. Esta RPC responde: quais pedidos `disparado` têm um PO que
-- NÃO apareceu no último run válido? Ela CLASSIFICA e NÃO decide — não muta, não cancela.
--
-- ⚠️ A LIÇÃO QUE MUDOU O DESIGN (dado de prod, 16/07 + Codex): "PO sumiu do Omie" NÃO prova "a compra não
-- existe". O `disparar-pedidos-aprovados` aciona o PORTAL DO FORNECEDOR **antes** de criar o PO no Omie —
-- então existe estado real em que o fornecedor está com o pedido PROTOCOLADO e o PO não está mais lá.
-- Prod: pedidos 281/286 (Sayerlack, protocolos 2097501/2097910, entrega prometida 10/06). Cancelá-los faria
-- o motor RECOMPRAR ~R$3.060 que a Sayerlack já tem protocolado.
--
-- 🔑 FAIL-CLOSED POR CONSTRUÇÃO, EM DOIS EIXOS (o v2 fechou só o primeiro e o Codex furou o segundo):
--   (a) CANAL: só a allowlist estrita prova "não aciona fornecedor"; desconhecido/nulo → humano.
--   (b) PAYLOAD: `resposta_canal` NÃO-NULO só prova ausência se for RECONHECIDO. Regex sobre payload de
--       terceiro prova PRESENÇA, nunca AUSÊNCIA — `{"fornecedorNotificado":true}`, `{"portal":{"status":
--       "sucesso_portal"}}`, `{"número_protocolo":"..."}` ou um JSON duplamente escapado não casam com
--       nenhum padrão conhecido e, no v2, viravam "ausência provada" → caminho do cancelamento (Codex v2 #1).
--       Agora: payload presente + nenhuma chave conhecida = `indeterminado` = humano.
-- Enumerar o perigoso não converge (2 rodadas, 8+ escapes). Só o default seguro mata a classe.
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
    -- "último completo válido" = maior fencing seq com volume_ok TRUE. Sem marcador → CROSS JOIN vazio →
    -- retorna VAZIO. Fail-closed: sem base de verdade não se classifica ninguém como ausente.
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
      -- ── SINAIS POSITIVOS de compromisso (normalizados; regex prova PRESENÇA) ──
      (p.portal_protocolo IS NOT NULL AND btrim(p.portal_protocolo) <> '') AS tem_protocolo,
      -- `~ 'sucesso'` com âncora de palavra evita casar 'insucesso_portal' (Codex v2 #2).
      (lower(btrim(COALESCE(p.status_envio_portal, ''))) ~ '(^|[^a-z])sucesso') AS portal_sucesso,
      (COALESCE(p.resposta_canal::text, '') ~* 'fornecedor.?notificad|notificado.?fornecedor') AS notificado,
      (COALESCE(p.resposta_canal::text, '') ~* 'protocolo|portal|sucesso') AS marca_portal_na_resposta,
      -- ── (a) CANAL: allowlist ESTRITA. Desconhecido/nulo NÃO prova ausência (portal-first é o padrão).
      --     btrim() só remove espaço ASCII → normalizo tab/NBSP/unicode antes (Codex v2: E'\tomie\t').
      (lower(btrim(regexp_replace(COALESCE(p.canal_usado, ''), '[\s ]+', '', 'g')))
         IN ('omie', 'manual', 'interno')) AS canal_sem_fornecedor,
      -- ── (b) PAYLOAD: só é RECONHECIDO se for objeto jsonb com ao menos uma chave que eu saiba interpretar.
      --     Qualquer outra coisa (chave nova, camelCase, acento, aninhado, array, string JSON escapada,
      --     escalar) = NÃO reconhecido → não prova ausência (Codex v2 #1: o furo que sobrou).
      (
        p.resposta_canal IS NULL
        OR (
          jsonb_typeof(p.resposta_canal) = 'object'
          AND EXISTS (
            SELECT 1 FROM jsonb_object_keys(p.resposta_canal) k
            WHERE k IN ('modo', 'omie_numero', 'notificacao_detalhe', 'fornecedor_notificado',
                        'gate', 'erro', 'mensagem', 'status')
          )
          -- e nenhum valor aninhado escondendo estrutura que eu não modelo
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(p.resposta_canal) e
            WHERE jsonb_typeof(e.value) IN ('object', 'array')
          )
        )
      ) AS payload_reconhecido,
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
    -- ⚠️ `pedido_compra_sugerido.empresa` é **text** ('OBEN'); as outras tabelas usam o ENUM empresa_reposicao.
    -- text = enum direto é erro de TIPO em runtime (PL/pgSQL late-bound: o CREATE passa, quebra ao EXECUTAR).
    WHERE upper(btrim(p.empresa)) = v_empresa::text
      AND p.status IN ('disparado', 'aprovado_aguardando_disparo')
      AND p.omie_pedido_compra_id IS NOT NULL
      AND btrim(p.omie_pedido_compra_id) <> ''
      AND (ls.run_id IS NULL OR ls.run_id <> m.run_id)
  )
  SELECT
    b.pedido_id,
    b.omie_codigo_pedido,
    b.data_ciclo,
    b.idade_dias,
    -- DANO ATIVO = a CTE em_transito só soma disparados dos últimos 7d. Idade classifica PRIORIDADE, não verdade.
    (b.idade_dias <= 7) AS dano_ativo,
    b.valor_total,
    CASE WHEN b.visto_run_id IS NULL THEN 'nunca_carimbado' ELSE 'visto_em_run_anterior' END AS visto_status,
    -- SINAL FRACO: o sync do tracking é upsert-only (nunca remove) → ausência do espelho NÃO prova exclusão.
    b.po_no_espelho,
    b.fornecedor_nome,
    b.canal_usado,
    CASE
      WHEN b.tem_protocolo             THEN 'protocolado'
      WHEN b.marca_portal_na_resposta  THEN 'marca_portal_na_resposta'
      WHEN b.portal_sucesso            THEN 'enviado_portal'
      WHEN b.notificado                THEN 'notificado'
      WHEN NOT b.payload_reconhecido   THEN 'indeterminado_payload'
      WHEN NOT b.canal_sem_fornecedor  THEN 'indeterminado_canal'
      ELSE 'nenhum'
    END AS compromisso_fornecedor,
    CASE
      -- ⛔ FAIL-CLOSED: elegível exige PROVA DE AUSÊNCIA nos DOIS eixos — canal na allowlist E payload
      -- reconhecido — mais nenhum sinal positivo. Todo o resto vai para humano.
      WHEN b.canal_sem_fornecedor
       AND b.payload_reconhecido
       AND NOT b.tem_protocolo
       AND NOT b.marca_portal_na_resposta
       AND NOT b.portal_sucesso
       AND NOT b.notificado
      THEN 'elegivel_prova_id'
      ELSE 'reconciliacao_humana'
    END AS rota,
    b.marcador_run_id,
    b.marcador_seq
  FROM base b
  ORDER BY (b.idade_dias <= 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$$;

COMMENT ON FUNCTION public.reposicao_pos_candidatos(text) IS
  'PR2 (NÃO-MUTANTE): pedidos disparado/aprovado cujo PO não apareceu no último run VÁLIDO. CLASSIFICA e NÃO decide. rota=elegivel_prova_id exige prova de AUSÊNCIA de compromisso em DOIS eixos (canal na allowlist E resposta_canal reconhecida) + nenhum sinal positivo; qualquer payload/canal não-reconhecido vai para reconciliacao_humana — regex sobre payload de terceiro prova presença, nunca ausência. Sem marcador válido retorna VAZIO (fail-closed).';

REVOKE ALL ON FUNCTION public.reposicao_pos_candidatos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;

COMMIT;
