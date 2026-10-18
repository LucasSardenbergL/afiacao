-- ============================================================================
-- analytics_outbox_pedido_compra — pedido INSERIDO já aprovado emite criada E aprovada
-- Corpo para o `bun run db:aplicar` (SEM begin/commit: a transação é do executor).
--
-- Incidente (sensor `analytics_outbox_trigger`, 'broken' desde 2026-10-16 22:12 UTC):
--   "Orfas: 2 de 3 aprovacoes em 48h". Diagnóstico por psql-ro em 2026-10-18: as órfãs
--   (pcs 3644, 3669, 3670 — 3 de 3 com `condicao_origem = 'importado_portal'`) têm
--   `criado_em = aprovado_em` e SÓ a linha `reposicao.sugestao_criada` na outbox. Não
--   foi INSERT perdido (fail-open): foi a 2ª causa que o próprio sensor previa — a RPC
--   `sayerlack_importar_pedido_portal` (nasceu 2026-10-14, 1º uso real 2026-10-16)
--   INSERE o pedido já com `aprovado_em`, e o ramo `TG_OP = 'INSERT'` do trigger só
--   emitia 'criada'. O funil perdia a transição 'aprovada' de TODO pedido importado.
--
-- O que muda: no INSERT, se `NEW.aprovado_em IS NOT NULL`, nascem DUAS linhas (criada e
-- aprovada), uma por transição — a chave de dedup já inclui o evento. Resto do corpo =
-- prod (pg_get_functiondef 2026-10-18, md5(prosrc) 049e1b52b0c41950456268409ecb927f).
-- Backfill: as aprovadas que faltam aos pedidos importados (ocorrido_em = aprovado_em),
-- marcadas em props.backfill. O drain manda cada linha com o seu event_id como uuid, então
-- nada duplica no PostHog. Prova PG17: db/test-analytics-outbox-insert-ja-aprovado.sh.
-- ============================================================================

-- TRAVA, antes de ler: ALTER sem efeito no objeto que a PRE guarda e este arquivo recria.
DO $trava$
BEGIN
  IF to_regprocedure('public.analytics_outbox_pedido_compra()') IS NOT NULL THEN
    ALTER FUNCTION public.analytics_outbox_pedido_compra() VOLATILE;   -- a volatilidade VIVA
  END IF;
END
$trava$;

-- PRE anti-deriva: md5 EXATO do corpo vivo ∈ {prod revisado em 2026-10-18, este}. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.analytics_outbox_pedido_compra()');
  IF v_vivo IS NULL OR v_vivo NOT IN ('049e1b52b0c41950456268409ecb927f',   -- predecessor (prod 2026-10-18)
                                      'ae665653674267a3613b015366375a33')   -- este arquivo (medido em PG17)
  THEN
    RAISE EXCEPTION 'PRE FALHOU: analytics_outbox_pedido_compra vivo (md5 %) nao e o predecessor revisado nem este arquivo — outra sessao recriou a funcao; releia a prod antes de aplicar', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.analytics_outbox_pedido_compra()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_eventos text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_eventos := ARRAY['reposicao.sugestao_criada'];
    -- ⚠️ Pedido INSERIDO já aprovado (importação do portal Sayerlack —
    -- `sayerlack_importar_pedido_portal`, 1º uso real 2026-10-16): a transição
    -- criada→aprovada acontece na MESMA escrita, e o ramo de UPDATE abaixo nunca
    -- a vê. Sem isto o funil perde 'aprovada' de todo pedido importado e o sensor
    -- `analytics_outbox_trigger` acusa órfã (3 de 3 em 2026-10-16). Uma linha por
    -- transição: a chave de dedup já carrega o evento.
    IF NEW.aprovado_em IS NOT NULL THEN
      -- array_append, nao `||`: `text[] || 'literal'` resolve como array||array e quebra
      -- ("malformed array literal") FORA do bloco fail-open — derrubaria o INSERT do pedido.
      v_eventos := array_append(v_eventos, 'reposicao.sugestao_aprovada');
    END IF;
  ELSIF NEW.aprovado_em IS NOT NULL AND OLD.aprovado_em IS NULL THEN
    v_eventos := ARRAY['reposicao.sugestao_aprovada'];
  -- ⚠️ `IS DISTINCT FROM` e não `UPDATE OF status`: o Postgres dispara
  -- `UPDATE OF` mesmo quando o valor final não mudou.
  ELSIF NEW.status = 'expirado_sem_aprovacao' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_eventos := ARRAY['reposicao.sugestao_expirada'];
  ELSIF NEW.status IN ('cancelado_humano', 'cancelado') AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_eventos := ARRAY['reposicao.sugestao_cancelada'];
  ELSE
    RETURN NULL;  -- AFTER trigger: o retorno é ignorado
  END IF;

  -- FAIL-OPEN deliberado: telemetria NUNCA reprova o money-path. Aprovar uma
  -- compra não pode falhar porque a outbox está indisponível.
  -- ⚠️ Isto deixa de ser outbox transacional ESTRITA, e a troca é declarada,
  -- não escondida. O que impede virar a "sonda que degrada em silêncio" do
  -- CLAUDE.md é a view do bloco 5: o silêncio é AUDITÁVEL contra a fonte, e a
  -- ausência ganha denominador. Fail-open SEM reconciliação seria a armadilha.
  BEGIN
    INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup, ocorrido_em)
    SELECT
      e.evento,
      'sistema:reposicao',
      NULL,
      jsonb_build_object(
        'sugestao_id',        NEW.id,
        'status',             NEW.status,
        'condicao_origem',    NEW.condicao_origem,
        'origem_evento_tipo', NEW.origem_evento_tipo,
        -- booleano, não o e-mail: diz SE houve humano, sem dizer QUEM.
        'aprovacao_humana',   (NEW.aprovado_por IS NOT NULL),
        'origem_cancelamento', CASE NEW.status WHEN 'cancelado_humano' THEN 'humano'
                                               WHEN 'cancelado' THEN 'sistema' END
      ),
      -- ⚠️ a chave inclui o EVENTO, não só o id: um pedido passa por criada →
      -- aprovada → (expirada|cancelada) e cada transição é uma linha. Chavear
      -- só por id engoliria o funil inteiro depois do primeiro evento.
      'pcs:' || NEW.id::text || ':' || e.evento,
      now()
    FROM unnest(v_eventos) WITH ORDINALITY AS e(evento, ordem)
    ORDER BY e.ordem
    ON CONFLICT (chave_dedup) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[analytics_outbox] evento(s) % do pedido % perdido(s) (fail-open): % / %',
      array_to_string(v_eventos, ','), NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NULL;
END;
$function$;

-- BACKFILL das 'aprovada' que o ramo velho engoliu. Só pedidos importados do portal (a RPC
-- nasceu em 2026-10-14, DEPOIS do trigger — nenhum é pré-trigger), ocorrido_em = aprovado_em
-- (o que o próprio sensor manda fazer), status o que a RPC grava no INSERT. Idempotente pela
-- chave de dedup. Precisão > recall: órfã de OUTRA origem não entra aqui — seria outra causa.
DO $backfill$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup, ocorrido_em)
  SELECT
    'reposicao.sugestao_aprovada',
    'sistema:reposicao',
    NULL,
    jsonb_build_object(
      'sugestao_id',        p.id,
      'status',             'aprovado_aguardando_disparo',
      'condicao_origem',    p.condicao_origem,
      'origem_evento_tipo', p.origem_evento_tipo,
      'aprovacao_humana',   (p.aprovado_por IS NOT NULL),
      'origem_cancelamento', NULL,
      'backfill',           'insert_ja_aprovado_2026-10-18'
    ),
    'pcs:' || p.id::text || ':reposicao.sugestao_aprovada',
    p.aprovado_em
  FROM public.pedido_compra_sugerido p
  WHERE p.condicao_origem = 'importado_portal'
    AND p.aprovado_em IS NOT NULL
    AND p.aprovado_em >= '2026-10-14 00:00:00+00'
  ON CONFLICT (chave_dedup) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'backfill: % linha(s) reposicao.sugestao_aprovada inserida(s) para pedidos importados do portal', v_n;
END
$backfill$;

-- PÓS: o corpo novo está vivo, o trigger segue ligado, e nenhum pedido importado ficou sem 'aprovada'.
DO $post$
DECLARE
  v_src   text;
  v_orfas integer;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.analytics_outbox_pedido_compra()');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU [FUNCAO]: analytics_outbox_pedido_compra nao existe';
  END IF;
  IF v_src !~ 'array_append\(v_eventos, ''reposicao\.sugestao_aprovada''\)' THEN
    RAISE EXCEPTION 'POS FALHOU [RAMO]: o INSERT ja aprovado continua emitindo so criada';
  END IF;
  IF v_src !~ 'IN \(''cancelado_humano'', ''cancelado''\)' THEN
    RAISE EXCEPTION 'POS FALHOU [REGRESSAO]: o ramo de cancelamento do sistema (2026-10-11) sumiu do corpo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'public.pedido_compra_sugerido'::regclass
                    AND tgname = 'trg_analytics_outbox_pedido_compra'
                    AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POS FALHOU [TRIGGER]: trg_analytics_outbox_pedido_compra ausente/desabilitado';
  END IF;
  SELECT count(*) INTO v_orfas
    FROM public.pedido_compra_sugerido p
   WHERE p.condicao_origem = 'importado_portal'
     AND p.aprovado_em IS NOT NULL
     AND p.aprovado_em >= '2026-10-14 00:00:00+00'
     AND NOT EXISTS (SELECT 1 FROM public.analytics_outbox o
                      WHERE o.chave_dedup = 'pcs:' || p.id::text || ':reposicao.sugestao_aprovada');
  IF v_orfas <> 0 THEN
    RAISE EXCEPTION 'POS FALHOU [BACKFILL]: % pedido(s) importado(s) do portal ainda sem reposicao.sugestao_aprovada na outbox', v_orfas;
  END IF;
  RAISE NOTICE 'analytics_outbox_pedido_compra: INSERT ja aprovado emite criada+aprovada; trigger ativo; zero importados orfaos';
END
$post$;
