-- ============================================================================================
-- 20261010230000 · tint_watchdog_fase5 v2 — "a fonte retirou a chave" deixa de ser CRÍTICO
-- Prova: db/test-tint-fase5-watchdog.sh (PG17, v1 + esta v2 REAIS, falsificação F6)
--
-- O QUE: o alerta `tint_fase5_fonte_retirada` (S2) passa a ter teto 'aviso' (era 'critico' a partir
-- de 10.000 chaves). Em prod estava aberto como CRÍTICO desde 2026-09-28 com 12.386 chaves estáveis.
-- A própria mensagem diz "não é venda perdida" — medido em 2026-10-10 (psql-ro): 226 cores; 77 seguem
-- vendáveis em outro SKU; das que sumiram, as únicas pedidas em 180d (346J/345J/341J PEARL, 346I)
-- mudaram de CÓDIGO na fonte ("346J - PEARL BS" → "346J - ACRIL BS") e seguem vendáveis.
-- Dispensar não resolvia: `_tint_watchdog_fase5_transicao` reabre um alerta NOVO na rodada seguinte
-- (≤6h) e notifica. Com 'aviso', o alerta aberto é rebaixado na próxima rodada (o UPDATE da transição
-- grava a severidade nova) e só volta a e-mailar se DOBRAR (histerese 2.0, inalterada).
--
-- NADA MAIS MUDA: o corpo é o da v1 (20260730120000) — pré-flight 2026-10-10: prosrc da PROD ==
-- corpo do repo (diff vazio) — exceto o marcador (v1→v2) e o CASE do S2.
--
-- GUARD ANTI-ROLLBACK: aborta se a função em prod não for a v1 nem a v2 (versão desconhecida — não
-- sobrescrever às cegas). CREATE OR REPLACE preserva o ACL (anon/authenticated sem EXECUTE).
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação
-- (não há BEGIN/COMMIT aqui). Idempotente. Não executa a função (a varredura leva ~80-120s e grava
-- alerta); a execução de verdade é a prova PG17. Efeito em prod: na próxima rodada do cron (6/6h).
-- ============================================================================================
DO $pre$
DECLARE
  v_src text := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.tint_watchdog_fase5_check()'));
BEGIN
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_fase5_check() não existe — aplique a v1 (20260730120000) antes';
  END IF;
  IF position('tint_watchdog_fase5 guard v1' IN v_src) = 0 AND position('tint_watchdog_fase5 guard v2' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PRE FALHOU: a função em prod não é a v1 nem a v2 (marcador desconhecido) — não sobrescrevo às cegas';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.tint_watchdog_fase5_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- tint_watchdog_fase5 guard v2 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v2, v3...), para que
  -- re-aplicar ESTA por cima dela ABORTE em vez de revertê-la em silêncio.
  v_conta      text := 'oben';   -- 100% do catálogo tint é oben (medido)
  v_t0         timestamptz := clock_timestamp();
  v_s1         bigint;
  v_s2         bigint;
  v_universo   bigint;
  v_max        bigint;
  v_ancora     timestamptz;
  v_dismiss    timestamptz;
  v_queda      numeric;
  v_msg        text;
BEGIN
  -- Anti-sobreposição. A varredura custa ~53s contra um ciclo de 6h (margem 400x),
  -- mas um ciclo preso não pode empilhar um segundo por cima. Se já há um rodando,
  -- SAI SEM avançar o marcador — e é justamente o marcador parado que faz o
  -- dead-man cruzado do PR 1 alarmar em 13h. Falha aberta vira alerta, não silêncio.
  IF NOT pg_try_advisory_xact_lock(hashtext('tint_watchdog_fase5')) THEN
    RETURN;
  END IF;

  -- ── VARREDURA ÚNICA (ver "A FORMA DA QUERY" no cabeçalho) ───────────────
  -- Uma passada só produz os 3 sinais: materializar a view duas vezes dobraria o
  -- custo, e duas varreduras em instantes diferentes poderiam se contradizer.
  -- count(DISTINCT ...) no universo, não count(*): o count(*) conta LINHAS pós-JOIN,
  -- e a unicidade da view por chave é propriedade dela, não invariante imposta aqui
  -- (Codex [P1]). Medido hoje: 0 chaves com >1 linha na view — então é hardening, não
  -- correção de bug. Se um dia duplicar, o universo inflaria e uma queda real poderia
  -- ser mascarada por duplicidade.
  SELECT count(*) FILTER (WHERE k.tem_ativa AND v.account IS NULL),
         count(*) FILTER (WHERE NOT k.tem_ativa),
         count(DISTINCT (k.account, k.sku_id, k.cor_id))
    INTO v_s1, v_s2, v_universo
  FROM (
    -- as chaves carimbadas pela Fase 5, com "ainda existe na fonte?" por agregação
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
  ) v ON v.account = k.account AND v.sku_id = k.sku_id AND v.cor_id = k.cor_id;

  -- ── S3: CARDINALIDADE do universo (Codex [P1]: o carimbo não é durável) ──
  -- Sem isto, limpar o carimbo (follow-up 5b#1) ou deletar as linhas esvazia o
  -- universo, S1 e S2 vão a zero por VACUIDADE, e o watchdog fica "verde" tendo
  -- perdido a visão. Âncora = maior universo já visto.
  SELECT COALESCE((metadata->>'universo_max')::bigint, 0),
         COALESCE((metadata->>'ancora_em')::timestamptz, '-infinity'::timestamptz)
    INTO v_max, v_ancora
    FROM sync_state
   WHERE entity_type = 'tint_watchdog_fase5' AND account = v_conta;
  v_max    := COALESCE(v_max, 0);
  v_ancora := COALESCE(v_ancora, '-infinity'::timestamptz);

  -- Um encolhimento DELIBERADO (a limpeza do 5b#1) não pode deixar um alerta preso
  -- para sempre — alerta imortal treina o founder a ignorar alertas. O dismiss
  -- MANUAL é o aceite do novo patamar: re-ancora. O auto-dismiss abaixo avança a
  -- âncora junto, então nunca é lido como aceite manual.
  SELECT max(dismissed_at) INTO v_dismiss
    FROM fin_alertas
   WHERE company = v_conta AND tipo = 'tint_fase5_universo_encolheu'
     AND dismissed_at IS NOT NULL;

  -- Re-ancorar por dismiss é o aceite do patamar novo — mas dismiss é um clique de UI,
  -- não uma autorização auditada (Codex [P1]). Dois venenos ficam barrados aqui:
  --   (a) dismiss com universo ZERO gravaria universo_max=0, e S1/S2/S3 ficariam
  --       verdes por VACUIDADE para sempre;
  --   (b) dismiss durante um COLAPSO transitório (>=50%) canonizaria o valor
  --       degradado como referência.
  -- Nesses casos o alerta é dispensado (o founder não fica com alerta imortal), mas a
  -- ÂNCORA NÃO desce: se o colapso for real e deliberado, o rebaseline é decisão
  -- explícita — uma migration, não um clique.
  IF v_dismiss IS NOT NULL AND v_dismiss > v_ancora THEN
    -- Teto ABSOLUTO, não percentual (2ª rodada do Codex, [P1]): 50% de 463.995 são
    -- ~232 mil chaves — um único clique de dismiss canonizaria a perda de metade da
    -- cobertura. Uma limpeza legítima do 5b#1 mexe em centenas (hoje S2=300), então
    -- 1.000 cobre o caso real com folga e barra o catastrófico. Acima disso o
    -- rebaseline é escrita deliberada no SQL Editor — o gate humano do repo.
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

  -- Limiar de 1%: este sinal é sobre o universo COLAPSAR (o vigia de vacuidade),
  -- não sobre erosão de unidades. O universo é estático por desenho — nada o
  -- escreve — então tolerar <1% custa recall irrelevante e compra silêncio.
  -- QUALQUER queda alarma (2ª rodada do Codex, [P1]): o piso de 100 que eu tinha
  -- posto ainda deixava 99 chaves saírem da cobertura em SILÊNCIO PERMANENTE — elas
  -- somem do universo E de S1/S2, e nada mais as vigia. Como o universo é ESTÁTICO
  -- por desenho (nenhum writer o toca; só uma limpeza deliberada do 5b#1 o muda),
  -- o limiar coerente com a premissa é 1, não um percentual: qualquer queda é
  -- anômala por construção. Trocar 4.639 silenciosas por 99 silenciosas seria
  -- reduzir o dano em vez de fechar o furo.
  IF v_max > 0 AND v_universo < v_max THEN
    v_msg := 'Tintometrico/Fase 5: o universo carimbado ENCOLHEU de ' || v_max ||
             ' para ' || v_universo || ' chaves (' ||
             round(v_queda * 100, 1) || '%). O watchdog por chave mede sobre esse ' ||
             'universo: se ele sumir, S1/S2 vao a zero por VACUIDADE e a rede fica ' ||
             'cega sem nunca ficar vermelha. ' ||
             -- A mensagem TEM de dizer a verdade sobre o que o dismiss faz (2a rodada
             -- do Codex, [P1]): acima do teto ele NAO re-ancora, e o alerta reabre no
             -- ciclo seguinte. Prometer "dispense e pronto" treinaria o founder a
             -- clicar num botao que nao resolve.
             CASE WHEN (v_max - v_universo) <= 1000
                  THEN 'Se a limpeza foi deliberada (5b#1), dispense este alerta que ' ||
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

  -- ── S1: a chave existe e NAO PRECIFICA (dano de venda real) ─────────────
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

  -- ── S2: a FONTE retirou a chave, tombstone órfão (higiene) ──────────────
  -- Tipo SEPARADO de S1 de propósito: remediação diferente, cadência diferente
  -- (~30/dia esperados), e no mesmo tipo silenciaria S1 pelo ON CONFLICT.
  IF v_s2 > 0 THEN
    v_msg := 'Tintometrico: ' || v_s2 || ' chave(s) carimbada(s) pela Fase 5 nao tem ' ||
             'mais NENHUMA formula ativa - a fonte retirou a chave e o carimbo da ' ||
             'geracao 1 ficou orfao (o writer tint_apply_keys_snapshot desativa a SL ' ||
             'sem setar desativada_motivo). Nao e venda perdida: a cor saiu do ' ||
             'catalogo. E higiene do carimbo - recarimbar/limpar e o follow-up 5b#1.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_retirada', v_s2,
      -- v2 (2026-10-10, decisão do founder): S2 NUNCA é crítico. É higiene do carimbo, não
      -- venda perdida (medido: as 4 PEARL vendidas mudaram de CÓDIGO na fonte e seguem
      -- vendáveis). Crítico ficava aberto para sempre; dispensar não colava (reabre e notifica).
      CASE WHEN v_s2 >= 100 THEN 'aviso' ELSE 'info' END,
      '[Tintometrico] fonte retirou chaves com carimbo da Fase 5', v_msg,
      jsonb_build_object('chaves', v_s2, 'universo', v_universo),
      -- HISTERESE 2.0 (Codex [P1]): S2 cresce ~60 chaves/dia por DESENHO da fonte.
      -- Com re-emissão a cada incremento seriam ~4 e-mails/dia — o alerta viraria
      -- ruído e treinaria o founder a ignorar a família inteira. Só um SALTO (dobro)
      -- volta a e-mailar; o alerta em fin_alertas segue sempre atualizado.
      2.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_retirada', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── MARCADOR DE SUCESSO (Codex [P1]: "verde por construção") ────────────
  -- last_sync_at = último sucesso COMPLETO. Só chega aqui quem varreu E transicionou
  -- os 3 alertas; qualquer exceção acima aborta a função e NAO avança o marcador.
  -- É este marcador que o dead-man cruzado do PR 1 (*/5) vigia: >13h sem sucesso
  -- => alerta tint_watchdog_fase5_parado. Sem ele, "sem alerta" seria
  -- indistinguível de "nunca rodou" — que é o modo de falha do vigia silencioso.
  INSERT INTO sync_state (entity_type, account, last_sync_at, status, error_message, metadata)
  -- clock_timestamp(), não now(): now() é o início da TRANSAÇÃO, e esta varredura
  -- leva ~53s. Registrar o início faria uma execução longa parecer mais velha do que
  -- é para o dead-man do PR 1 (Codex [P2]).
  VALUES ('tint_watchdog_fase5', v_conta, clock_timestamp(), 'complete', NULL,
          jsonb_build_object('chaves_sem_preco', v_s1, 'fonte_retirada', v_s2,
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

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.tint_watchdog_fase5_check()');
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position('tint_watchdog_fase5 guard v2' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P1 FALHOU: o marcador v2 não está na função';
  END IF;
  IF v_src ~ 'v_s2 >= [0-9]+ THEN ''critico''' THEN
    RAISE EXCEPTION 'P2 FALHOU: S2 ainda escala para critico';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'P3 FALHOU: a função deixou de ser SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: anon/authenticated executam o watchdog — o ACL não foi preservado';
  END IF;
  RAISE NOTICE 'tint_watchdog_fase5 v2: marcador v2, S2 com teto aviso, definer, ACL preservado';
END
$post$;
