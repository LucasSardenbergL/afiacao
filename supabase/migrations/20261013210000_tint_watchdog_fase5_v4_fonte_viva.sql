-- ============================================================================================
-- 20261013210000 · tint_watchdog_fase5 v4 — o watchdog passa a medir a FONTE, não o relógio
-- Prova: db/test-tint-fase5-watchdog-v4.sh (PG17, v1 + v2 + v3 + v4 REAIS, falsificação de
-- conjunto exato no MESMO laço que roda o controle verde)
-- [money-path]
--
-- O QUE MUDA
--   S2 (`tint_fase5_fonte_retirada`) deixa de ser "chave carimbada sem ativa há >30 dias" e passa a
--      ser RETIRADA NOVA: chave carimbada sem fórmula ativa cuja chave-fonte estava em algum snapshot
--      de chaves APLICADO dos últimos 7 dias e está ausente do último aplicado. O total de carimbadas
--      sem ativa (as retiradas permanentes, ~12 mil, sem remediação) segue como MÉTRICA no marcador
--      (`fonte_retirada_bruto`) e alimenta o S4, mas não alarma.
--   S5 NOVO (`tint_fase5_fonte_fantasma`): fórmula ATIVA cuja chave-fonte não está no último snapshot
--      aplicado e que não tem staging recebido depois dele. É o sinal que teria pegado o incidente de
--      13/10 e o que vigia se o conserto de raiz (20261013150000) segue de pé.
--   Helper `_tint_watchdog_fase5_transicao` v2: com fator 1.0 o e-mail compara com o CICLO ANTERIOR;
--      subida de severidade notifica mesmo com o número caindo. A regra multiplicativa 2.0 fica igual.
--   Encerramento por MUDANÇA DE CRITÉRIO fica anotado no alerta (inclusive o v2→v3, retroativo).
--   Série histórica: uma amostra por execução bem-sucedida em `tint_watchdog_fase5_amostras`
--      (retenção de 180 dias).
--   S1, S3 (universo encolheu), S4 (colapso, 5%/20%), o lock e o marcador: corpo da v3, sem mudança.
--
-- POR QUÊ — o que a v3 afirmava e a medição desmentiu (psql-ro, 2026-10-13)
--   A v3 contava S2 por `max(desativada_em) < now() - 30 dias`, partindo da hipótese de que a cor
--   retirada voltava antes de 30 dias. A hipótese era FALSA, e o sinal estava CEGO: `desativada_em`
--   não mede ausência na FONTE. O apply do snapshot (~03:13) desativava a fórmula ausente, o promote
--   (a cada ~10 min) a reativava pelo staging antigo, e o relógio zerava todo dia. Das 12.386 chaves
--   do S2, 3.099 chaves-fonte, todas ausentes do snapshot de 13/10, e 3.052 fora de TODO snapshot
--   desde 14/09 — cor retirada há semanas, ressuscitada diariamente. Em 13/10 12:15 UTC eram 26.180
--   fórmulas ATIVAS ausentes da fonte (6.545 chaves-fonte), 9.164 com preço final no balcão. Ainda
--   às ~19h, já com o 20261013150000 aplicado: 25.476 (6.369 chaves-fonte) — o conserto impede a
--   ressurreição NOVA, as já ativas saem no próximo apply de snapshot novo. O cron de re-apply do
--   20261013180000 não as tira: o apply do MESMO snapshot sai `skipped: fora de ordem` (medido 18:30).
--   O que mede presença na fonte é o SNAPSHOT, e é dele que a v4 lê.
--
-- DECISÕES (do founder, 2026-10-13 — não re-litigar)
--   · S2 vira métrica + alerta só de retirada nova (janela de 7 dias de snapshots aplicados).
--   · Fantasma ≠ cor nova: staging RECEBIDO depois do último snapshot aplicado é evidência nova de
--     presença (cor que a fonte acabou de cadastrar) e não conta. Mesmo critério temporal do
--     20261013150000, relógio do SERVIDOR nos dois lados (`created_at` do staging × max(`created_at`)
--     do snapshot). `aplicado_em` só ORDENA a escolha do snapshot, nunca é relógio de presença: um
--     re-apply skipado regrava `aplicado_em` sem mudar o snapshot.
--   · Limpar ou recarimbar o tombstone da Fase 5 segue PROIBIDO (rejeitado em 20260924120000,
--     barrado por trigger desde 20261010120000); a pós-condição P4 barra o texto que mandava fazê-lo.
--
-- CHAVE-FONTE: o formato de 4 partes do tint_apply_keys_snapshot (cor_id|cod_produto|
--   id_base_sayersystem|personalizada, SEM embalagem). No staging, `cod_produto`/`id_base` já são os
--   ids SAYER (medido: 5.000/5.000 casam com tint_produtos/tint_bases). Universo do S5 = o do apply
--   (ativas da conta com produto e base resolvidos) — o sensor não pode alarmar o que o apply nunca
--   desativaria.
--
-- SNAPSHOT DE REFERÊNCIA: o último APLICADO da conta (como no 20261013150000). Recebido e não
--   aplicado pode estar incompleto. Sem snapshot aplicado nenhum, S2 e S5 ficam NULL no marcador e
--   os alertas deles NÃO são tocados (ausência de dado ≠ saudável; não abre, não fecha).
--
-- CUSTO (prod, psql-ro 2026-10-13): S5 = 2,6s (517 mil ativas × 122.842 chaves; staging pós-snapshot
--   é pequena: 347 linhas de 134.351); retirada nova = 1,1s (52 chaves-fonte na janela). A varredura
--   da v3 leva 105-149s; o total segue no cron de 6h (supabase_admin, statement_timeout=0). NUNCA no
--   `_data_health_compute` (authenticated tem 8s).
--
-- EFEITO ESPERADO EM PROD
--   · Antes do apply do snapshot novo (~03:13): S5 ≈ 25 mil fantasmas → 'critico' + e-mail. É VERDADE
--     (o balcão cota essas cores agora). Depois do apply: S5 → 0 → dismiss.
--   · S2: hoje 0 (as 128 chaves carimbadas das 52 chaves-fonte retiradas na janela ainda têm fórmula
--     ativa — são fantasmas). Depois do apply devem virar ~128 → 'aviso', e saem sozinhas quando a
--     retirada sai da janela de 7 dias.
--
-- LIMITES CONHECIDOS (registrados)
--   (a) O pré-filtro da retirada nova casa `cor_id` pela 1ª parte da chave (`split_part(chave,'|',1)`)
--       para usar o índice (account, cor_id, …). Um `cor_id` com '|' escaparia do S2 (falso negativo):
--       medido 0 em prod. A comparação final é a chave inteira, então não há falso positivo.
--   (b) Retirada mais velha que 7 dias com snapshots purgados não volta a alarmar: é a decisão (alerta
--       só de retirada NOVA); o estoque fica na métrica.
--   (c) Se o conector parar, o "último aplicado" envelhece e o S5 mede contra um retrato velho. Quem
--       vigia conector parado é outro sensor; aqui o snapshot de referência vai no contexto/amostra.
--   (d) REVISÃO INDEPENDENTE PENDENTE: cota do Codex em 3% até 20/10; adversário próprio (Caminho B).
--
-- GUARD ANTI-ROLLBACK: aborta se a função em prod não for a v3 nem a v4. O marcador passa a v4.
-- CREATE OR REPLACE preserva o ACL; o REVOKE é reemitido nomeando as roles por cinto.
--
-- APLICAR: bun run db:aplicar supabase/migrations/20261013210000_tint_watchdog_fase5_v4_fonte_viva.sql
-- — o executor fornece a transação (sem BEGIN/COMMIT aqui). Idempotente. Não executa a varredura.
-- ============================================================================================
DO $pre$
DECLARE
  v_src text := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.tint_watchdog_fase5_check()'));
BEGIN
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_fase5_check() não existe — aplique v1, v2 e v3 antes';
  END IF;
  IF position('tint_watchdog_fase5 guard v3' IN v_src) = 0 AND position('tint_watchdog_fase5 guard v4' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PRE FALHOU: a função em prod não é a v3 nem a v4 (marcador desconhecido) — não sobrescrevo às cegas';
  END IF;
  IF to_regprocedure('public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: o helper _tint_watchdog_fase5_transicao não existe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tint_keys_snapshots'
                    AND column_name = 'aplicacao_status') THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_keys_snapshots.aplicacao_status ausente — sem ela não há snapshot de referência confiável';
  END IF;
END
$pre$;

-- ── Série histórica (P2d) ───────────────────────────────────────────────────────────────────────
-- Uma linha por execução BEM-SUCEDIDA (o INSERT fica no fim da função, junto do marcador: execução que
-- aborta não deixa amostra, e o buraco na série é ele mesmo um sinal). Retenção de 180 dias (~720 linhas).
CREATE TABLE IF NOT EXISTS public.tint_watchdog_fase5_amostras (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  medido_em            timestamptz NOT NULL DEFAULT clock_timestamp(),
  criterio             text        NOT NULL,
  universo             bigint      NOT NULL,
  s1_sem_preco         bigint      NOT NULL,
  sem_ativa_bruto      bigint      NOT NULL,   -- carimbadas sem ativa (retiradas permanentes + novas)
  s2_retirada_nova     bigint,                 -- NULL = sem snapshot aplicado de referência
  fantasmas            bigint,                 -- NULL = idem
  fantasmas_vendaveis  bigint,
  cor_nova             bigint,
  snapshot_id          uuid,
  snapshot_recebido_em timestamptz,
  duracao_s            numeric
);
ALTER TABLE public.tint_watchdog_fase5_amostras ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tint_watchdog_fase5_amostras FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.tint_watchdog_fase5_amostras IS
  'Série do tint_watchdog_fase5_check (v4+): uma amostra por execução bem-sucedida, retenção 180 dias. '
  'Único writer: a função (SECURITY DEFINER). Sem policy de propósito: leitura via SQL de staff.';

-- ── Helper v2 (P2a) ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._tint_watchdog_fase5_transicao(
  p_company  text,
  p_tipo     text,
  p_n        bigint,   -- 0 => estado saudável => dismiss
  p_sev      text,     -- 'info' | 'aviso' | 'critico'  (CHECK de fin_alertas)
  p_titulo   text,
  p_msg      text,
  p_ctx      jsonb,
  p_fator    numeric DEFAULT 1.0   -- histerese do E-MAIL: 1.0 = toda piora; 2.0 = só ao dobrar
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- tint_watchdog_fase5 helper v2 (20261013210000)
  v_ant      bigint;
  -- fornecedor_alerta tem CHECK próprio e vocabulário DIFERENTE de fin_alertas
  -- (info/atencao/urgente vs info/aviso/critico). Derivar aqui, em vez de passar
  -- como parâmetro, elimina o modo de falha "severidade inválida derruba o cron".
  v_sev_forn text := CASE p_sev WHEN 'critico' THEN 'urgente'
                                WHEN 'aviso'   THEN 'atencao'
                                ELSE 'info' END;
  v_upd int;
  v_ant_email bigint;
  v_emitir boolean;
  v_subiu_sev boolean;
  v_sev_ant text;
BEGIN
  IF p_n <= 0 THEN
    UPDATE fin_alertas SET dismissed_at = now()
     WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL;
    RETURN;
  END IF;

  INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
  VALUES (p_company, p_tipo, p_sev, p_msg,
          p_ctx || jsonb_build_object('_n', p_n, 'avaliado_em', now(), '_n_email', p_n))
  ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;

  IF FOUND THEN
    INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
    VALUES (p_company, 'outro', v_sev_forn, p_titulo, p_msg, 'pendente_notificacao');
    RETURN;
  END IF;

  -- Alerta já aberto. Duas âncoras: `_n` = valor do último CICLO; `_n_email` = valor de quando o
  -- último e-mail saiu.
  SELECT COALESCE((contexto->>'_n')::bigint, 0),
         COALESCE((contexto->>'_n_email')::bigint, COALESCE((contexto->>'_n')::bigint, 0)),
         severidade
    INTO v_ant, v_ant_email, v_sev_ant
    FROM fin_alertas
   WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL;

  -- REARME NA RECUPERAÇÃO (fator 2.0): se o sinal cai à metade ou menos do valor emailado, a
  -- âncora desce junto — senão um novo patamar logo abaixo do pico ficaria mudo para sempre.
  v_ant_email := CASE WHEN p_n <= v_ant_email / 2 THEN p_n ELSE v_ant_email END;

  -- v2 (20261013210000, challenge Codex v3b P2a):
  --  · SUBIDA DE SEVERIDADE notifica SEMPRE, inclusive com o número CAINDO. No S4 a severidade é
  --    uma FRAÇÃO (bruto/universo): o universo encolher sobe o alerta a 'critico' com o bruto
  --    parado ou menor, e a v1 calava isso pelo `AND p_n > v_ant` do envio.
  --  · FATOR 1.0 ("toda piora") compara com o CICLO ANTERIOR, não com a âncora do e-mail. Com a
  --    âncora, 90.000 → 46.000 → 89.000 não reemitia: 46.000 não chega à metade (não rearma) e
  --    89.000 < 90.000 — uma piora de 43.000 em silêncio.
  --  · FATOR 2.0 inalterado: re-emissão logarítmica pela âncora (e só se cresceu no ciclo).
  v_subiu_sev := (CASE p_sev     WHEN 'critico' THEN 3 WHEN 'aviso' THEN 2 ELSE 1 END)
               > (CASE v_sev_ant WHEN 'critico' THEN 3 WHEN 'aviso' THEN 2 ELSE 1 END);
  v_emitir := v_subiu_sev
              OR CASE WHEN p_fator <= 1.0
                      THEN p_n > v_ant
                      ELSE p_n >= GREATEST(v_ant_email * p_fator, v_ant_email + 1) AND p_n > v_ant
                 END;

  -- O UPDATE é INCONDICIONAL: o estado no banco reflete SEMPRE o ciclo atual; a histerese governa
  -- só o E-MAIL. UPDATE ... RETURNING numa passada só: um dismiss CONCORRENTE entre o SELECT e o
  -- UPDATE não pode gerar um e-mail "AGRAVOU" sem alerta aberto por trás (Codex [P2]).
  UPDATE fin_alertas
     SET severidade = p_sev,
         mensagem   = p_msg,
         contexto   = p_ctx || jsonb_build_object('_n', p_n, 'avaliado_em', now(),
                                                  'agravou_de', v_ant,
                                                  -- só avança quando o e-mail de fato sai
                                                  '_n_email', CASE WHEN v_emitir THEN p_n ELSE v_ant_email END)
   WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL
  RETURNING 1 INTO v_upd;

  IF v_upd IS NOT NULL AND v_emitir THEN
    INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
    VALUES (p_company, 'outro', v_sev_forn, 'AGRAVOU: ' || p_titulo,
            p_msg || E'\n\n(agravamento: eram ' || v_ant || ', severidade ' || COALESCE(v_sev_ant, '?') || ')',
            'pendente_notificacao');
  END IF;
END;
$function$;

-- ── check() v4 ──────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_watchdog_fase5_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- tint_watchdog_fase5 guard v4 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v5, v6...), para que
  -- re-aplicar ESTA por cima dela ABORTE em vez de revertê-la em silêncio.
  v_conta       text := 'oben';   -- 100% do catálogo tint é oben (medido)
  v_criterio    constant text := 'v4';
  v_t0          timestamptz := clock_timestamp();
  v_s1          bigint;
  v_s2          bigint;   -- RETIRADA NOVA (janela de 7 dias de snapshots) — o que alarma
  v_s2_bruto    bigint;   -- carimbadas sem ativa — MÉTRICA e denominador do S4
  v_universo    bigint;
  v_max         bigint;
  v_ancora      timestamptz;
  v_dismiss     timestamptz;
  v_queda       numeric;
  v_msg         text;
  v_snap_id     uuid;          -- último snapshot de chaves APLICADO
  v_snap_rec    timestamptz;   -- max(created_at) dos chunks dele: relógio do SERVIDOR
  v_ret_fonte   bigint;        -- chaves-fonte retiradas na janela
  v_fant        bigint;        -- S5: ativas ausentes da fonte, sem staging posterior
  v_fant_vend   bigint;
  v_fant_fonte  bigint;
  v_cor_nova    bigint;        -- ausentes do snapshot COM staging posterior (legítimas)
BEGIN
  -- Anti-sobreposição: um ciclo preso não pode empilhar outro por cima. Se já há um rodando,
  -- SAI SEM avançar o marcador — e o marcador parado é o que faz o dead-man cruzado alarmar.
  IF NOT pg_try_advisory_xact_lock(hashtext('tint_watchdog_fase5')) THEN
    RETURN;
  END IF;

  -- ── A FONTE: o último snapshot de chaves APLICADO ─────────────────────────────────────────
  -- aplicado_em só ORDENA (o mais recente aplicado); a presença é medida por created_at.
  SELECT ks.snapshot_id, max(ks.created_at)
    INTO v_snap_id, v_snap_rec
    FROM tint_keys_snapshots ks
   WHERE ks.account = v_conta AND ks.entity = 'formulas'
     AND ks.aplicacao_status = 'aplicado'
   GROUP BY ks.snapshot_id
   ORDER BY max(ks.aplicado_em) DESC NULLS LAST, max(ks.created_at) DESC
   LIMIT 1;

  -- Temporárias sempre criadas (vazias sem snapshot) para a varredura não depender do ramo.
  -- Qualificadas por pg_temp na LEITURA: com search_path 'public','pg_temp', uma tabela homônima
  -- em public venceria.
  DROP TABLE IF EXISTS pg_temp._wd5_snap, pg_temp._wd5_retirada, pg_temp._wd5_k_retirada, pg_temp._wd5_novo;
  CREATE TEMP TABLE _wd5_snap      (chave text PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE _wd5_retirada  (chave text PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE _wd5_k_retirada (account text NOT NULL, sku_id uuid NOT NULL, cor_id text NOT NULL,
                                     PRIMARY KEY (account, sku_id, cor_id)) ON COMMIT DROP;
  CREATE TEMP TABLE _wd5_novo      (chave text PRIMARY KEY) ON COMMIT DROP;

  IF v_snap_id IS NOT NULL THEN
    INSERT INTO pg_temp._wd5_snap
    SELECT DISTINCT c.chave
      FROM tint_keys_snapshots ks, jsonb_array_elements_text(ks.keys) AS c(chave)
     WHERE ks.snapshot_id = v_snap_id AND ks.entity = 'formulas' AND c.chave IS NOT NULL;

    -- RETIRADA NOVA: chave-fonte presente em algum snapshot APLICADO dos últimos 7 dias e ausente
    -- do último aplicado.
    INSERT INTO pg_temp._wd5_retirada
    SELECT DISTINCT c.chave
      FROM tint_keys_snapshots ks, jsonb_array_elements_text(ks.keys) AS c(chave)
     WHERE ks.account = v_conta AND ks.entity = 'formulas'
       AND ks.aplicacao_status = 'aplicado'
       AND ks.snapshot_id <> v_snap_id
       AND ks.created_at >= now() - interval '7 days'
       AND c.chave IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_temp._wd5_snap s WHERE s.chave = c.chave);
    GET DIAGNOSTICS v_ret_fonte = ROW_COUNT;

    -- As chaves (account, sku_id, cor_id) que expandem essas chaves-fonte (N embalagens por fonte).
    -- Pré-filtro por cor_id (índice account, cor_id, …); a comparação que decide é a chave inteira.
    INSERT INTO pg_temp._wd5_k_retirada
    SELECT DISTINCT f.account, f.sku_id, f.cor_id
      FROM tint_formulas f
      JOIN tint_produtos p ON p.id = f.produto_id
      JOIN tint_bases    b ON b.id = f.base_id
     WHERE f.account = v_conta AND f.sku_id IS NOT NULL
       AND f.cor_id IN (SELECT split_part(r.chave, '|', 1) FROM pg_temp._wd5_retirada r)
       AND (f.cor_id || '|' || p.cod_produto || '|' || b.id_base_sayersystem || '|'
            || (CASE WHEN f.personalizada THEN 'true' ELSE 'false' END))
           IN (SELECT r.chave FROM pg_temp._wd5_retirada r);

    -- COR NOVA: staging RECEBIDO a partir do snapshot (mesmo critério do 20261013150000, que barra
    -- só `created_at < v_snap_recebido`).
    INSERT INTO pg_temp._wd5_novo
    SELECT DISTINCT x.chave
      FROM (SELECT sf.cor_id || '|' || sf.cod_produto || '|' || sf.id_base || '|'
                   || (CASE WHEN sf.personalizada THEN 'true' ELSE 'false' END) AS chave
              FROM tint_staging_formulas sf
             WHERE sf.account = v_conta AND sf.created_at >= v_snap_rec) x
     WHERE x.chave IS NOT NULL;

    ANALYZE pg_temp._wd5_snap;
    ANALYZE pg_temp._wd5_k_retirada;
    ANALYZE pg_temp._wd5_novo;
  END IF;

  -- ── VARREDURA ÚNICA do universo carimbado (S1, S2, bruto, universo) ─────────────────────────
  -- count(DISTINCT ...) no universo, não count(*): a unicidade da view por chave é propriedade
  -- dela, não invariante imposta aqui (Codex [P1]).
  SELECT count(*) FILTER (WHERE k.tem_ativa AND v.account IS NULL),
         count(DISTINCT (k.account, k.sku_id, k.cor_id))
           FILTER (WHERE NOT k.tem_ativa AND kr.cor_id IS NOT NULL),
         count(DISTINCT (k.account, k.sku_id, k.cor_id)) FILTER (WHERE NOT k.tem_ativa),
         count(DISTINCT (k.account, k.sku_id, k.cor_id))
    INTO v_s1, v_s2, v_s2_bruto, v_universo
  FROM (
    -- as chaves carimbadas pela Fase 5, com "ainda tem fórmula ativa?" por agregação
    SELECT f.account, f.sku_id, f.cor_id,
           bool_or(f.desativada_em IS NULL AND f.sku_id IS NOT NULL) AS tem_ativa
      FROM tint_formulas f
     WHERE (f.account, f.sku_id, f.cor_id) IN (
             SELECT account, sku_id, cor_id
               FROM tint_formulas
              WHERE desativada_motivo = 'fase5_geracao_legada')
     GROUP BY f.account, f.sku_id, f.cor_id
  ) k
  LEFT JOIN (
    -- o oráculo: o que o balcão consegue precificar hoje
    SELECT account, sku_id, cor_id
      FROM v_tint_formula_canonica
     WHERE receita_valida
  ) v ON v.account = k.account AND v.sku_id = k.sku_id AND v.cor_id = k.cor_id
  LEFT JOIN pg_temp._wd5_k_retirada kr
         ON kr.account = k.account AND kr.sku_id = k.sku_id AND kr.cor_id = k.cor_id;

  -- ── S5: fórmula ATIVA que a fonte não tem (o universo é o do apply) ─────────────────────────
  IF v_snap_id IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE n.chave IS NULL),
           count(*) FILTER (WHERE n.chave IS NULL AND o.sku_id IS NOT NULL),
           count(DISTINCT o.chave) FILTER (WHERE n.chave IS NULL),
           count(*) FILTER (WHERE n.chave IS NOT NULL)
      INTO v_fant, v_fant_vend, v_fant_fonte, v_cor_nova
      FROM (SELECT f.sku_id,
                   (f.cor_id || '|' || p.cod_produto || '|' || b.id_base_sayersystem || '|'
                    || (CASE WHEN f.personalizada THEN 'true' ELSE 'false' END)) AS chave
              FROM tint_formulas f
              JOIN tint_produtos p ON p.id = f.produto_id
              JOIN tint_bases    b ON b.id = f.base_id
             WHERE f.account = v_conta AND f.desativada_em IS NULL) o
      LEFT JOIN pg_temp._wd5_novo n ON n.chave = o.chave
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp._wd5_snap s WHERE s.chave = o.chave);
  ELSE
    v_s2 := NULL;   -- sem referência da fonte: ausente, não zero
  END IF;

  -- ── S3: CARDINALIDADE do universo (o vigia de vacuidade) — corpo da v3 ──────────────────────
  SELECT COALESCE((metadata->>'universo_max')::bigint, 0),
         COALESCE((metadata->>'ancora_em')::timestamptz, '-infinity'::timestamptz)
    INTO v_max, v_ancora
    FROM sync_state
   WHERE entity_type = 'tint_watchdog_fase5' AND account = v_conta;
  v_max    := COALESCE(v_max, 0);
  v_ancora := COALESCE(v_ancora, '-infinity'::timestamptz);

  SELECT max(dismissed_at) INTO v_dismiss
    FROM fin_alertas
   WHERE company = v_conta AND tipo = 'tint_fase5_universo_encolheu'
     AND dismissed_at IS NOT NULL;

  -- Dismiss manual re-ancora só com universo > 0 e queda <= 1.000 chaves (teto ABSOLUTO, Codex
  -- [P1]); acima disso o rebaseline é escrita deliberada no SQL Editor.
  IF v_dismiss IS NOT NULL AND v_dismiss > v_ancora THEN
    IF v_universo > 0 AND (v_max - v_universo) <= 1000 THEN
      v_max := v_universo; v_ancora := now();
    ELSE
      v_ancora := v_dismiss;   -- consome o dismiss sem rebaixar o patamar
    END IF;
  END IF;

  IF v_universo > v_max THEN                    -- high-water-mark sobe sozinho
    v_max := v_universo; v_ancora := now();
  END IF;

  v_queda := CASE WHEN v_max > 0
                  THEN (v_max - v_universo)::numeric / v_max ELSE 0 END;

  IF v_max > 0 AND v_universo < v_max THEN
    v_msg := 'Tintometrico/Fase 5: o universo carimbado ENCOLHEU de ' || v_max ||
             ' para ' || v_universo || ' chaves (' ||
             round(v_queda * 100, 1) || '%). O watchdog por chave mede sobre esse ' ||
             'universo: se ele sumir, S1/S2 vao a zero por VACUIDADE e a rede fica ' ||
             'cega sem nunca ficar vermelha. ' ||
             CASE WHEN (v_max - v_universo) <= 1000
                  THEN 'Se a mudanca foi deliberada, dispense este alerta que ' ||
                       'o patamar novo vira a referencia.'
                  ELSE 'Queda ACIMA do teto de re-ancoragem (1.000 chaves): dispensar ' ||
                       'NAO muda o patamar e o alerta reabre no proximo ciclo. Restaure ' ||
                       'o universo, ou faca o rebaseline explicito no SQL Editor: ' ||
                       'UPDATE sync_state SET metadata = metadata || jsonb_build_object(' ||
                       '''universo_max'', ' || v_universo || ', ''ancora_em'', now()) ' ||
                       'WHERE entity_type=''tint_watchdog_fase5'';' END;
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_universo_encolheu', v_max - v_universo,
      CASE WHEN v_universo = 0 OR v_queda >= 0.5 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] universo carimbado da Fase 5 encolheu', v_msg,
      jsonb_build_object('universo', v_universo, 'universo_max', v_max,
                         'queda_pct', round(v_queda * 100, 2)));
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_universo_encolheu', 0, 'info', '', '', '{}'::jsonb);
    v_ancora := now();   -- auto-dismiss NAO pode parecer aceite manual
  END IF;

  -- ── S1: a chave existe e NAO PRECIFICA (dano de venda real) — corpo da v3 ───────────────────
  IF v_s1 > 0 THEN
    v_msg := 'Tintometrico: ' || v_s1 || ' chave(s) desativada(s) pela Fase 5 estao ' ||
             'SEM formula precificavel - a RPC devolve precoFinal NULL (fail-closed) ' ||
             'e o balcao nao vende essas cores. A geracao 1 que as respaldava ja foi ' ||
             'desativada e NAO e mais fallback. Causa tipica: corante sem custo Omie ' ||
             'ou receita corrompida por sync.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_chave_sem_preco', v_s1,
      CASE WHEN v_s1 >= 1000 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] chaves da Fase 5 sem preco', v_msg,
      jsonb_build_object('chaves', v_s1, 'universo', v_universo));
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_chave_sem_preco', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── S2: RETIRADA NOVA pela fonte ──────────────────────────────────────────────────────────
  -- Encerramento por MUDANÇA DE CRITÉRIO (P2c): um alerta aberto sob outro critério não é
  -- "resolvido" quando o número dele zera aqui — ele mede outra coisa. Fecha anotando de qual
  -- critério para qual, e o critério novo abre o seu (com e-mail) se tiver o que dizer.
  UPDATE fin_alertas
     SET dismissed_at = now(),
         contexto = COALESCE(contexto, '{}'::jsonb)
                    || jsonb_build_object('encerrado_por', 'mudanca_criterio',
                                          'criterio_de', COALESCE(contexto->>'criterio', 'v3'),
                                          'criterio_para', v_criterio,
                                          'encerrado_em', now())
   WHERE company = v_conta AND tipo = 'tint_fase5_fonte_retirada' AND dismissed_at IS NULL
     AND (contexto->>'criterio') IS DISTINCT FROM v_criterio;

  IF v_s2 IS NULL THEN
    NULL;   -- sem snapshot aplicado: não abre nem fecha (ausência de dado ≠ saudável)
  ELSIF v_s2 > 0 THEN
    v_msg := 'Tintometrico: ' || v_s2 || ' chave(s) carimbada(s) pela Fase 5 ficaram sem ' ||
             'formula ativa porque a FONTE retirou a cor nos ultimos 7 dias (' || v_ret_fonte ||
             ' chave(s)-fonte estavam num snapshot aplicado da janela e sumiram do ultimo). ' ||
             'Nao e venda perdida por defeito (S1 mede isso): e a cor saindo do catalogo do ' ||
             'SayerSystem. NAO mexa no tombstone da Fase 5: ele e o piso do tint_gate_revalida ' ||
             'e o rotulo do balcao, e alterar o carimbo foi REJEITADO em 20260924120000 e e ' ||
             'barrado por trigger (20261010120000). A acao e confirmar na fonte se a cor saiu ' ||
             'mesmo e, se sim, decidir em PRODUTO o que fazer com o piso dela.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_retirada', v_s2,
      -- v2 (decisão do founder): S2 NUNCA é crítico.
      CASE WHEN v_s2 >= 100 THEN 'aviso' ELSE 'info' END,
      '[Tintometrico] fonte retirou cores com carimbo da Fase 5', v_msg,
      jsonb_build_object('criterio', v_criterio, 'chaves', v_s2,
                         'chaves_fonte_retiradas_7d', v_ret_fonte,
                         'bruto', v_s2_bruto, 'universo', v_universo,
                         'snapshot_id', v_snap_id),
      -- histerese 2.0: retirada chega em lote; re-emissão logarítmica.
      2.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_retirada', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── S4: COLAPSO do bruto (snapshot truncado / retirada em massa) — corpo da v3 ──────────────
  -- LIMIAR 5% (aviso) e 20% (crítico) do universo. O churn normal medido fica em ~2,7%.
  IF v_universo > 0 AND v_s2_bruto::numeric / v_universo >= 0.05 THEN
    v_msg := 'Tintometrico: ' || v_s2_bruto || ' de ' || v_universo || ' chaves ' ||
             'carimbadas (' || round(v_s2_bruto::numeric * 100 / v_universo, 1) ||
             '%) estao SEM formula ativa AGORA. O patamar normal fica em torno de 2-3% ' ||
             '(maxima medida 2,7%); este indica snapshot TRUNCADO ou retirada em ' ||
             'massa pela fonte. O balcao nao vende essas cores enquanto durar. Acao: ' ||
             'conferir o ultimo ciclo do conector (tint_sync_runs) e a fonte.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_colapso', v_s2_bruto,
      CASE WHEN v_s2_bruto::numeric / v_universo >= 0.20 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] colapso de disponibilidade no catalogo carimbado', v_msg,
      jsonb_build_object('bruto', v_s2_bruto, 'universo', v_universo,
                         'pct', round(v_s2_bruto::numeric * 100 / v_universo, 2)),
      1.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_colapso', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── S5: FANTASMA — a fórmula está ATIVA e a fonte não a tem ─────────────────────────────────
  -- Nasce em ZERO por construção: o apply desativa toda ativa ausente do snapshot, e desde
  -- 20261013150000 o promote não reativa staging recebido antes dele. Qualquer valor > 0 é o
  -- balcão cotando cor que o SayerSystem não tem. Fator 1.0: toda piora merece e-mail.
  IF v_fant IS NULL THEN
    NULL;   -- sem snapshot aplicado: não abre nem fecha
  ELSIF v_fant > 0 THEN
    v_msg := 'Tintometrico: ' || v_fant || ' formula(s) ATIVA(s) (' || v_fant_vend ||
             ' com SKU, ' || v_fant_fonte || ' chave(s)-fonte) NAO estao no ultimo snapshot de ' ||
             'chaves APLICADO da fonte (recebido em ' || to_char(v_snap_rec AT TIME ZONE 'UTC',
             'YYYY-MM-DD HH24:MI') || ' UTC) e nao tem staging recebido depois dele. O balcao ' ||
             'cota cor que o SayerSystem nao tem mais. Nao e cor nova (' || v_cor_nova ||
             ' formula(s) com staging posterior ficaram de fora deste numero). Causa tipica: o ' ||
             'promote voltou a reativar staging antigo (regressao do 20261013150000) ou o apply do ' ||
             'snapshot nao desativou (tint_sync_runs keys_snapshot: skipped, erro, blast radius).';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_fantasma', v_fant,
      CASE WHEN v_fant >= 1000 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] formulas ativas que a fonte nao tem', v_msg,
      jsonb_build_object('formulas', v_fant, 'com_sku', v_fant_vend,
                         'chaves_fonte', v_fant_fonte, 'cor_nova', v_cor_nova,
                         'snapshot_id', v_snap_id, 'snapshot_recebido_em', v_snap_rec),
      1.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_fantasma', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── SÉRIE (P2d) + MARCADOR DE SUCESSO ─────────────────────────────────────────────────────
  -- Só chega aqui quem varreu E transicionou todos os alertas; exceção acima aborta a função e
  -- não grava amostra nem avança o marcador que o dead-man cruzado vigia (>13h => alerta).
  INSERT INTO tint_watchdog_fase5_amostras
    (criterio, universo, s1_sem_preco, sem_ativa_bruto, s2_retirada_nova, fantasmas,
     fantasmas_vendaveis, cor_nova, snapshot_id, snapshot_recebido_em, duracao_s)
  VALUES (v_criterio, v_universo, v_s1, v_s2_bruto, v_s2, v_fant, v_fant_vend, v_cor_nova,
          v_snap_id, v_snap_rec,
          round(EXTRACT(epoch FROM clock_timestamp() - v_t0)::numeric, 1));
  DELETE FROM tint_watchdog_fase5_amostras WHERE medido_em < now() - interval '180 days';

  INSERT INTO sync_state (entity_type, account, last_sync_at, status, error_message, metadata)
  -- clock_timestamp(), não now(): now() é o início da TRANSAÇÃO e a varredura leva minutos.
  VALUES ('tint_watchdog_fase5', v_conta, clock_timestamp(), 'complete', NULL,
          jsonb_build_object('criterio', v_criterio,
                             'chaves_sem_preco', v_s1, 'fonte_retirada', v_s2,
                             'fonte_retirada_bruto', v_s2_bruto,
                             'chaves_fonte_retiradas_7d', v_ret_fonte,
                             'fantasmas', v_fant, 'fantasmas_com_sku', v_fant_vend,
                             'cor_nova', v_cor_nova,
                             'snapshot_id', v_snap_id, 'snapshot_recebido_em', v_snap_rec,
                             'universo', v_universo, 'universo_max', v_max,
                             'ancora_em', v_ancora,
                             'duracao_s', round(EXTRACT(epoch FROM clock_timestamp() - v_t0)::numeric, 1)))
  ON CONFLICT (entity_type, account) DO UPDATE
    SET last_sync_at  = clock_timestamp(),
        status        = 'complete',
        error_message = NULL,
        updated_at    = now(),
        metadata      = EXCLUDED.metadata;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tint_watchdog_fase5_check() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric)
  FROM PUBLIC, anon, authenticated;

-- ── P2c RETROATIVO: o encerramento v2→v3 do S2 ───────────────────────────────────────────────
-- A v3 (aplicada em 2026-10-13 09:17:17 UTC, recibo #401) zerou o S2 por CONSTRUÇÃO, e a 1ª rodada
-- dela dismissou o alerta aberto desde 2026-09-28 (12.386 chaves) como se fosse resolução. Alerta
-- ABERTO antes da v3 e FECHADO depois dela = fechado pela troca de critério. Idempotente (não
-- re-anota) e não toca alerta fechado sob a v2.
UPDATE public.fin_alertas
   SET contexto = COALESCE(contexto, '{}'::jsonb)
                  || jsonb_build_object('encerrado_por', 'mudanca_criterio',
                                        'criterio_de', 'v2', 'criterio_para', 'v3',
                                        'anotado_por', '20261013210000',
                                        'nota', 'a v3 contava so chave sem ativa ha >30 dias, numero que '
                                                || 'zerava por construcao; o fechamento nao foi resolucao')
 WHERE tipo = 'tint_fase5_fonte_retirada'
   AND criado_em    <  timestamptz '2026-10-13 09:17:17+00'
   AND dismissed_at >= timestamptz '2026-10-13 09:17:17+00'
   AND NOT (COALESCE(contexto, '{}'::jsonb) ? 'encerrado_por');

DO $post$
DECLARE
  v_oid  oid := to_regprocedure('public.tint_watchdog_fase5_check()');
  v_hoid oid := to_regprocedure('public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric)');
  v_src  text;
  v_hsrc text;
BEGIN
  SELECT prosrc INTO v_src  FROM pg_proc WHERE oid = v_oid;
  SELECT prosrc INTO v_hsrc FROM pg_proc WHERE oid = v_hoid;
  IF position('tint_watchdog_fase5 guard v4' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P1 FALHOU: o marcador v4 não está na função';
  END IF;
  IF position('tint_watchdog_fase5 helper v2' IN v_hsrc) = 0 THEN
    RAISE EXCEPTION 'P1b FALHOU: o helper v2 não está gravado';
  END IF;
  IF position('tint_fase5_fonte_fantasma' IN v_src) = 0 OR position('tint_fase5_fonte_colapso' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P2 FALHOU: S5 (fantasma) ou S4 (colapso) ausente da função';
  END IF;
  -- o corte de 30 dias da v3 (cego) não pode voltar
  IF v_src ~ 'interval ''30 days''' THEN
    RAISE EXCEPTION 'P2b FALHOU: o corte de 30 dias da v3 voltou à função';
  END IF;
  IF v_src ~ 'v_s2 >= [0-9]+ THEN ''critico''' THEN
    RAISE EXCEPTION 'P3 FALHOU: S2 voltou a escalar para critico (decisão de 20261010230000)';
  END IF;
  IF v_src ~ 'recarimbar/limpar' THEN
    RAISE EXCEPTION 'P4 FALHOU: a mensagem voltou a instruir limpar/recarimbar o tombstone (ação rejeitada em 20260924120000 e barrada por trigger)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_hoid) THEN
    RAISE EXCEPTION 'P5 FALHOU: função ou helper deixou de ser SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_hoid, 'EXECUTE') OR has_function_privilege('authenticated', v_hoid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: anon/authenticated executam o watchdog ou o helper';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tint_watchdog_fase5_amostras'::regclass) THEN
    RAISE EXCEPTION 'P7 FALHOU: tint_watchdog_fase5_amostras sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.tint_watchdog_fase5_amostras', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.tint_watchdog_fase5_amostras', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'P8 FALHOU: anon/authenticated têm privilégio em tint_watchdog_fase5_amostras';
  END IF;
  RAISE NOTICE 'tint_watchdog_fase5 v4: marcador v4, helper v2, S5 fantasma, sem corte de 30d, definer, ACL e RLS conferidos';
END
$post$;
