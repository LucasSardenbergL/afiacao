-- ============================================================================================
-- analytics_outbox_pedido_compra — migration CANÔNICA do corpo que a PROD já roda
-- (I2 · plano v2, item 5, ciclo 2)
--
-- POR QUE EXISTE: desde 2026-10-18 a prod roda um corpo que NENHUMA migration commitada
-- reproduz. O ramo "pedido INSERIDO já aprovado emite criada E aprovada" (a importação do portal
-- Sayerlack perdia 'aprovada', 3 de 3 — #3149) entrou pelo envelope
-- db/aplicar-analytics-outbox-insert-ja-aprovado.sql (db:aplicar, ledger db_aplicacoes #518).
-- Resultado: a última migration do repo que define a função
-- (20261011150000_reposicao_recusa_definitiva_portal_servidor) é um ANCESTRAL do corpo vivo, e
-- um `CREATE OR REPLACE` a partir dela (restore só de migrations, "re-cola pra garantir")
-- apagaria o ramo em silêncio — "a última a recriar vence" (docs/agent/database.md §2). O
-- auditor `deriva:corpo:prod` só aceitava a distância por baseline (EDICAO_MANUAL em
-- db/deriva-corpo-baseline.json).
--
-- O QUE FAZ: torna o corpo vivo a declaração CANÔNICA do repo. O CREATE abaixo é o
-- `pg_get_functiondef` da PROD de 2026-10-20 copiado BYTE A BYTE (hex → arquivo, não
-- redigitado; md5(prosrc) = ae665653674267a3613b015366375a33, igual ao corpo do envelope). Em
-- prod, aplicar é um no-op de corpo (a PRE aceita o próprio estado); num restore só de
-- migrations (DR) é o que reconstrói o ramo. NÃO impede que alguém cole de novo, DEPOIS, o CREATE
-- antigo (a TRAVA só protege esta transação): o que esta migration dá é a definição canônica para
-- reconstruir, e torna essa regressão DETECTÁVEL pelo auditor (o corpo vivo deixa de bater). Mesmo desenho da opção (a) da decisão #1 do plano
-- v2, já aplicada às 2 financeiras no ciclo 1 (docs/historico/deriva-canonica-i2.md).
--
-- FORA, de propósito: o BACKFILL do envelope (one-shot, com teto aprovado_em < 2026-10-19 e
-- dedup). Num restore os eventos voltam só se o BACKUP de dados os tiver: backup anterior ao
-- reparo conserva a lacuna, e a outbox sofre expurgo — re-rodar o backfill depois da purga
-- duplicaria evento no destino. Recuperar de backup antigo exige reconciliação própria, não DML
-- histórico aqui. E a ACL: nenhuma migration da cadeia declara ACL para esta função; o REPLACE
-- preserva a viva (inclusive uma mais restrita) e esta migration não a normaliza.
--
-- MOLDE (skill lovable-db-operator, "Recriar objeto VIVO"): TRAVA → PRE → CREATE → PÓS numa
-- transação só — este arquivo é para o SQL Editor/MCP, por isso leva BEGIN/COMMIT. A PRE exige
-- que o corpo vivo seja o predecessor revisado (20261011150000, md5
-- 049e1b52b0c41950456268409ecb927f) OU este; qualquer outro estado ABORTA: outra entrega recriou
-- a função e o pré-flight tem de ser refeito — nunca trocar a constante no SQL Editor. PRE e PÓS
-- pinam também o contrato FORA do prosrc (RETURNS trigger, plpgsql, SECURITY DEFINER,
-- VOLATILE, não-STRICT, proconfig inteiro = search_path vazio) e o OWNER: SECURITY DEFINER roda
-- com os privilégios do dono, e um dono sem INSERT na outbox calaria o funil pelo fail-open sem
-- erro nenhum (parecer Codex de desenho, P1). O REPLACE preserva o dono — por isso a PRE aborta em
-- vez de "corrigir". A PÓS lê a DEFINIÇÃO do trigger e o `tgfoid` (a função pública, não uma
-- homônima noutro schema), e o UNIQUE de `analytics_outbox(chave_dedup)` que o `ON CONFLICT`
-- infere: sem ele o INSERT dá 42P10, o fail-open engole, e corpo+trigger iguais emitem zero
-- eventos (Codex, P2). Não recria a outbox; só recusa terminar verde sem ela. A PÓS não executa
-- a função (trigger não é chamável direto, e disparar exigiria INSERT em pedido de compra de
-- prod): a execução está na prova PG17.
--
-- Idempotente: colar duas vezes é seguro. Prova PG17 com falsificação (dois locales):
-- db/test-analytics-outbox-canonica.sh. Depois de mergeada, `bun run deriva:corpo:prod` julga
-- esta identidade EM_DIA e a entrada EDICAO_MANUAL sai da baseline.
-- Narrativa: docs/historico/plano-v2-ciclo-2.md
-- ============================================================================================
BEGIN ISOLATION LEVEL READ COMMITTED;   -- o nível em que a TRAVA serializa (provado em PG17 no repo)
SET LOCAL lock_timeout = '5s';          -- orçamento: a TRAVA espera no máximo isto
SET LOCAL statement_timeout = '60s';

-- TRAVA: ALTER sem efeito (a volatilidade VIVA é VOLATILE) — serializa com qualquer
-- CREATE OR REPLACE concorrente, que morre com XX000 "tuple concurrently updated". A volatilidade
-- é conferida ANTES do ALTER (que a normalizaria): com o mesmo corpo e outra volatilidade, aborta.
DO $trava$
BEGIN
  IF to_regprocedure('public.analytics_outbox_pedido_compra()') IS NOT NULL THEN
    IF (SELECT p.provolatile FROM pg_catalog.pg_proc p
         WHERE p.oid = to_regprocedure('public.analytics_outbox_pedido_compra()')) <> 'v' THEN
      RAISE EXCEPTION 'PRE FALHOU: analytics_outbox_pedido_compra viva não é VOLATILE — alguém mudou a volatilidade à mão; reconcilie antes de colar';
    END IF;
    ALTER FUNCTION public.analytics_outbox_pedido_compra() VOLATILE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo pertence a {predecessor revisado, este}. Ausente ABORTA (a cadeia não chegou).
DO $pre$
DECLARE
  v_oid  oid := to_regprocedure('public.analytics_outbox_pedido_compra()');
  v_vivo text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.analytics_outbox_pedido_compra() não existe — aplique antes a cadeia até 20261011150000_reposicao_recusa_definitiva_portal_servidor';
  END IF;
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF v_vivo NOT IN ('049e1b52b0c41950456268409ecb927f',   -- 20261011150000: o predecessor revisado (restore só de migrations)
                    'ae665653674267a3613b015366375a33')   -- PROD 2026-10-20: ESTE corpo (reaplicar é no-op)
  THEN
    RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de analytics_outbox_pedido_compra (md5 %) não é o predecessor revisado nem este — outra entrega o recriou; NÃO troque a constante: recapture a definição da prod e refaça o pré-flight', v_vivo;
  END IF;
  -- O contrato FORA do prosrc, ANTES de o CREATE o sobrescrever: o mesmo corpo com outro
  -- search_path, SECURITY INVOKER ou STRICT não pode ser normalizado em silêncio.
  IF pg_get_function_arguments(v_oid) IS DISTINCT FROM ''
     OR pg_get_function_result(v_oid) IS DISTINCT FROM 'trigger'
     OR (SELECT l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE p.oid = v_oid) IS DISTINCT FROM 'plpgsql'
     OR (SELECT NOT p.prosecdef OR p.proisstrict FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
     OR (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM ARRAY['search_path=""']::text[]
  THEN
    RAISE EXCEPTION 'PRE FALHOU: atributos vivos de analytics_outbox_pedido_compra fora do contrato (sem argumentos, RETURNS trigger, plpgsql, SECURITY DEFINER, não-STRICT, search_path vazio) — mudança à mão; reconcilie antes de colar';
  END IF;
  IF (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM 'postgres'::regrole THEN
    RAISE EXCEPTION 'PRE FALHOU: owner de analytics_outbox_pedido_compra é % (esperado postgres) — SECURITY DEFINER roda com os privilégios do dono; reconcilie antes de colar',
      (SELECT p.proowner::regrole FROM pg_catalog.pg_proc p WHERE p.oid = v_oid);
  END IF;
END
$pre$;

-- CREATE: pg_get_functiondef da PROD (2026-10-20), byte a byte.
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

-- PÓS: o corpo vivo é ESTE, com o contrato inteiro — e o trigger segue ligado com a definição certa.
DO $pos$
DECLARE
  v_oid oid := to_regprocedure('public.analytics_outbox_pedido_compra()');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU [FUNCAO]: analytics_outbox_pedido_compra sumiu depois do CREATE';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM 'ae665653674267a3613b015366375a33' THEN
    RAISE EXCEPTION 'POS FALHOU [CORPO]: o corpo vivo (md5 %) não é o canônico — o CREATE não pegou',
      (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid);
  END IF;
  IF pg_get_function_arguments(v_oid) IS DISTINCT FROM ''
     OR pg_get_function_result(v_oid) IS DISTINCT FROM 'trigger'
     OR (SELECT l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE p.oid = v_oid) IS DISTINCT FROM 'plpgsql'
     OR (SELECT NOT p.prosecdef OR p.proisstrict OR p.provolatile <> 'v' FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
     OR (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM ARRAY['search_path=""']::text[]
  THEN
    RAISE EXCEPTION 'POS FALHOU [ATRIBUTOS]: fora do contrato (sem argumentos, RETURNS trigger, plpgsql, SECURITY DEFINER, VOLATILE, não-STRICT, search_path vazio)';
  END IF;
  IF (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM 'postgres'::regrole THEN
    RAISE EXCEPTION 'POS FALHOU [OWNER]: o dono não é postgres';
  END IF;
  -- A DEFINIÇÃO, não só nome+habilitado: trigger só em UPDATE, com WHEN ou chamando outra função
  -- passaria num EXISTS por nome (achado Codex do #3149). O nome entre parênteses na regex é
  -- de propósito: sem ele o extrator do `audit:migrations` lê a string como um CREATE TRIGGER real.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.pedido_compra_sugerido'::regclass
                    AND t.tgname = 'trg_analytics_outbox_pedido_compra'
                    AND NOT t.tgisinternal AND t.tgenabled = 'O'
                    AND t.tgfoid = v_oid
                    AND pg_catalog.pg_get_triggerdef(t.oid)
                        ~ '^CREATE TRIGGER (trg_analytics_outbox_pedido_compra) AFTER INSERT OR UPDATE ON public\.pedido_compra_sugerido FOR EACH ROW EXECUTE FUNCTION (public\.)?analytics_outbox_pedido_compra\(\)$') THEN
    RAISE EXCEPTION 'POS FALHOU [TRIGGER]: trg_analytics_outbox_pedido_compra ausente, desabilitado, chamando outra função ou com definição diferente de AFTER INSERT OR UPDATE FOR EACH ROW -> public.analytics_outbox_pedido_compra()';
  END IF;
  -- O árbitro do `ON CONFLICT (chave_dedup)`: UNIQUE válido, imediato, sem predicado nem
  -- expressão, exatamente sobre `chave_dedup`.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                  WHERE i.indrelid = to_regclass('public.analytics_outbox')
                    AND i.indisunique AND i.indisvalid AND i.indimmediate
                    AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts = 1
                    AND i.indkey[0] = (SELECT a.attnum FROM pg_catalog.pg_attribute a
                                        WHERE a.attrelid = i.indrelid AND a.attname = 'chave_dedup' AND NOT a.attisdropped)) THEN
    RAISE EXCEPTION 'POS FALHOU [OUTBOX]: public.analytics_outbox sem UNIQUE válido e imediato em (chave_dedup) — o ON CONFLICT do trigger daria 42P10 e o fail-open calaria o funil';
  END IF;
  -- E nenhum árbitro inferível DIFERÍVEL: o ON CONFLICT (chave_dedup) infere TODOS os UNIQUE
  -- não-parciais sobre a coluna, e o executor recusa o diferível (55000) — mesmo com o imediato
  -- presente, o fail-open calaria o funil (parecer Codex de código, P2).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_index i
              WHERE i.indrelid = to_regclass('public.analytics_outbox')
                AND i.indisunique AND NOT i.indimmediate
                AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts = 1
                AND i.indkey[0] = (SELECT a.attnum FROM pg_catalog.pg_attribute a
                                    WHERE a.attrelid = i.indrelid AND a.attname = 'chave_dedup' AND NOT a.attisdropped)) THEN
    RAISE EXCEPTION 'POS FALHOU [OUTBOX]: há UNIQUE DIFERÍVEL em analytics_outbox(chave_dedup) — o ON CONFLICT o infere e o INSERT do trigger daria 55000';
  END IF;
END
$pos$;

COMMIT;
