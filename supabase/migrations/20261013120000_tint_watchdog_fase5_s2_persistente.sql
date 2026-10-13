-- ============================================================================================
-- 20261013120000 · tint_watchdog_fase5 v3 — S2 deixa de medir o CHURN do snapshot
-- Prova: db/test-tint-fase5-watchdog.sh (PG17, v1 + v2 + v3 REAIS, falsificações F7/F8)
--
-- O QUE: o alerta `tint_fase5_fonte_retirada` (S2) passa a contar só a chave sem NENHUMA
-- fórmula ativa HÁ MAIS DE 30 DIAS. O número bruto vira MÉTRICA no marcador, e um sinal novo
-- (`tint_fase5_fonte_colapso`) vigia o bruto contra o universo para não cegar o caso agudo.
--
-- POR QUÊ — a medição que inverteu o diagnóstico (psql-ro, 2026-10-13):
--     bruto 12.386 · >=1d 12.386 · >=3d 3.694 · >=7d 79 · >=14d 47 · >=30d ZERO
-- Nenhuma chave está retirada há 30 dias: TODA cor que sai do catálogo volta antes disso.
-- E o conjunto é ROTATIVO, não estável — 11.763 das 12.386 de hoje foram desativadas entre
-- 09 e 11/10, dias atrás, enquanto um volume parecido saiu no mesmo intervalo. O total ficava
-- "estável" por fluxo, não por permanência. Logo 99,4% do que a v2 alarmava era ATRITO DO
-- CONECTOR, não dano: o alerta media o churn do snapshot e chamava de higiene do carimbo.
--
-- Efeito: S2 cai de 12.386 para 0 (medido). O sinal volta a ter a propriedade que o desenho
-- original valorizava — nasce em ZERO MEDIDO e o número que ele vigia é o que deve continuar
-- zero — em vez de um 'aviso' permanentemente aberto desde 2026-09-28 (15 dias) cuja próxima
-- notificação exigiria 24.772 chaves (histerese ancorada em _n_email=12.386: uma ZONA MORTA de
-- +12.385 chaves, onde um snapshot truncado de 8.000 passaria calado).
--
-- A MENSAGEM DO ALERTA TAMBÉM ESTAVA ERRADA, e isso é o conserto mais urgente deste diff: a v2
-- instrui "recarimbar/limpar é o follow-up 5b#1". Essa ação foi REJEITADA em 20260924120000
-- ("re-duplicaria o catálogo e tiraria a linha do piso legado") e desde 20261010120000 é
-- BARRADA POR TRIGGER. O alerta mandava o operador fazer algo proibido; agora diz o que fazer.
--
-- POR QUE 30 DIAS, E NÃO 7: com 7 dias sobrariam 79 chaves — um número pequeno mas ainda
-- transitório (>=14d já cai para 47, >=30d para 0), ou seja o corte de 7d ainda mediria cauda
-- de churn. 30 dias é o primeiro corte em que a série MEDIDA zera, então é onde "persistente"
-- para de ser opinião e passa a ser o que os dados sustentam.
--
-- POR QUE O S4 (colapso) ENTRA JUNTO: o corte de 30 dias cega o S2 para o evento AGUDO — um
-- snapshot truncado hoje só apareceria em S2 daqui a 30 dias, com o balcão sem vender no
-- intervalo. O S4 fecha exatamente esse vão, no eixo certo: COLAPSO do bruto (fração do
-- universo), não incremento por ciclo — o churn aqui é diário e em lotes de milhares, então
-- "salto por ciclo" alarmaria todo dia e seria pior que o alerta crônico que este diff remove.
--
-- NADA MAIS MUDA: o corpo é o da v2 (20261010230000) — pré-flight 2026-10-13: prosrc da PROD ==
-- corpo do repo (diff VAZIO) — exceto o marcador (v2→v3), a varredura (ganha sem_ativa_desde e
-- o contador bruto), o bloco do S2, o S4 novo e o metadata. S1, S3, o dead-man, o lock e a
-- histerese do helper seguem intactos.
--
-- LIMITES CONHECIDOS (registrados, não corrigidos — revisão adversária própria, Caminho B):
--  (a) VÃO RESIDUAL 3%-5%: entre o churn normal e o limiar do S4 ainda cabem ~14.000 a 23.000
--      chaves sem ativa que não têm 30 dias. Baixar mais o limiar trocaria cegueira por alerta
--      crônico (o churn medido já é 2,7%), então o vão é DELIBERADO e menor que o de 10%.
--  (b) `max(desativada_em)` avança se um writer INSERIR uma linha já desativada para a chave: a
--      chave sairia do S2 sem nunca ter voltado a vender. Nenhum writer legítimo faz isso (o
--      promote faz upsert com desativada_em=NULL; a Fase 5 era one-shot e o tombstone é imutável
--      desde 20261010120000), mas a propriedade não é imposta por constraint.
--  (c) A semântica depende da DATA da '1' carimbada (2026-07-22). Se a Fase 5 fosse re-carimbada
--      com data nova, todo o universo pareceria recente e o S2 zeraria por 30 dias. O trigger de
--      imutabilidade torna isso improvável, mas é dependência real — e foi o que derrubou 8
--      asserts da prova quando o seed carimbava com now() em vez de uma data antiga.
--  (d) REVISÃO INDEPENDENTE PENDENTE: a cota do Codex (janela de 7d) estava em 95% em 2026-10-13
--      e reabre em 18/10. O adversário aqui foi próprio, com 46 asserts + 8 falsificações de
--      conjunto exato. Auto-prova não substitui revisão independente — rodar o challenge
--      retroativo quando a cota voltar.
--
-- GUARD ANTI-ROLLBACK: aborta se a função em prod não for a v2 nem a v3 (versão desconhecida —
-- não sobrescrever às cegas). CREATE OR REPLACE preserva o ACL (anon/authenticated sem EXECUTE).
--
-- APLICAR: bun run db:aplicar supabase/migrations/20261013120000_tint_watchdog_fase5_s2_persistente.sql
-- — o executor fornece a transação (não há BEGIN/COMMIT aqui). Idempotente. Não executa a função
-- (a varredura leva ~105s e grava alerta); a execução de verdade é a prova PG17. Efeito em prod:
-- na próxima rodada do cron (6/6h) o alerta aberto de S2 é DISMISSADO (v_s2=0 ⇒ dismiss).
-- ============================================================================================
DO $pre$
DECLARE
  v_src text := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.tint_watchdog_fase5_check()'));
BEGIN
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_fase5_check() não existe — aplique a v1 (20260730120000) e a v2 (20261010230000) antes';
  END IF;
  IF position('tint_watchdog_fase5 guard v2' IN v_src) = 0 AND position('tint_watchdog_fase5 guard v3' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PRE FALHOU: a função em prod não é a v2 nem a v3 (marcador desconhecido) — não sobrescrevo às cegas';
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
  -- tint_watchdog_fase5 guard v3 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v4, v5...), para que
  -- re-aplicar ESTA por cima dela ABORTE em vez de revertê-la em silêncio.
  v_conta      text := 'oben';   -- 100% do catálogo tint é oben (medido)
  v_t0         timestamptz := clock_timestamp();
  v_s1         bigint;
  v_s2         bigint;   -- PERSISTENTE (>= 30d sem ativa) — o que alarma
  v_s2_bruto   bigint;   -- todas as sem ativa, inclusive o churn — METRICA
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
         -- count(*) e nao count(DISTINCT): toda chave contada aqui tem NOT tem_ativa, e sem
         -- formula ativa ela nao aparece na view => o LEFT JOIN nao a duplica. O DISTINCT so
         -- pagaria sort/hash (medido: 181s -> 415s na prova do CI). O universo abaixo mantem o
         -- DISTINCT, onde o hardening e real.
         count(*) FILTER (WHERE NOT k.tem_ativa
                            AND k.sem_ativa_desde < now() - interval '30 days'),
         count(*) FILTER (WHERE NOT k.tem_ativa),
         count(DISTINCT (k.account, k.sku_id, k.cor_id))
    INTO v_s1, v_s2, v_s2_bruto, v_universo
  FROM (
    -- as chaves carimbadas pela Fase 5, com "ainda existe na fonte?" por agregação
    SELECT f.account, f.sku_id, f.cor_id,
           bool_or(f.desativada_em IS NULL AND f.sku_id IS NOT NULL) AS tem_ativa,
           -- max() sobre o GRUPO INTEIRO: a chave ficou sem ativa quando a ULTIMA
           -- linha dela foi desativada. Inclui a '1' carimbada (22/07), que nunca
           -- vence o max quando a SL caiu depois — e se a SL caiu antes, a chave
           -- nao estaria carimbada (a Fase 5 exigia gemea SL ATIVA).
           max(f.desativada_em) AS sem_ativa_desde
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

  -- ── S2: a fonte retirou a chave E NAO DEVOLVEU em 30 dias ───────────────
  -- Tipo SEPARADO de S1 de propósito: remediação diferente, cadência diferente,
  -- e no mesmo tipo silenciaria S1 pelo ON CONFLICT.
  -- v3: o corte de 30 DIAS é o coração desta versão. Medido em prod 2026-10-13:
  --   bruto 12.386 · >=1d 12.386 · >=3d 3.694 · >=7d 79 · >=14d 47 · >=30d ZERO.
  -- Ou seja: TODA cor que sai do catálogo volta em menos de 30 dias — 99,4% do que
  -- a v2 alarmava era CHURN do snapshot, não dano. Era o alerta medindo o atrito do
  -- conector e chamando de higiene. Com o corte, o sinal volta a nascer em ZERO
  -- MEDIDO (a propriedade que o desenho original valorizava) e qualquer disparo é
  -- genuinamente "a fonte retirou e não devolveu".
  IF v_s2 > 0 THEN
    v_msg := 'Tintometrico: ' || v_s2 || ' chave(s) carimbada(s) pela Fase 5 estao sem ' ||
             'NENHUMA formula ativa HA MAIS DE 30 DIAS. Como 100% do churn normal do ' ||
             'snapshot volta antes disso (medido), estas sao as que a fonte retirou e ' ||
             'NAO devolveu - a cor saiu do catalogo de verdade. Nao e venda perdida ' ||
             '(S1 mede isso). NAO limpe nem recarimbe o motivo: o tombstone e o piso ' ||
             'do tint_gate_revalida e o rotulo do balcao, a limpeza foi REJEITADA em ' ||
             '20260924120000 e hoje e barrada por trigger (20261010120000). A acao e ' ||
             'confirmar na fonte se a cor saiu mesmo e, se sim, decidir em PRODUTO o ' ||
             'que fazer com o piso dela.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_retirada', v_s2,
      -- v2 (2026-10-10, decisão do founder): S2 NUNCA é crítico. É higiene do carimbo, não
      -- venda perdida (medido: as 4 PEARL vendidas mudaram de CÓDIGO na fonte e seguem
      -- vendáveis). Crítico ficava aberto para sempre; dispensar não colava (reabre e notifica).
      CASE WHEN v_s2 >= 100 THEN 'aviso' ELSE 'info' END,
      '[Tintometrico] fonte retirou chaves com carimbo da Fase 5', v_msg,
      jsonb_build_object('chaves', v_s2, 'bruto', v_s2_bruto, 'universo', v_universo),
      -- HISTERESE 2.0 preservada. Com o corte de 30d o número é pequeno (0 hoje), mas
      -- o fator continua certo: se a fonte retirar um bloco e não devolver, o sinal
      -- sobe em lote e a re-emissão logarítmica evita e-mail por incremento.
      2.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_retirada', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── S4: COLAPSO do bruto (o evento anômalo que o corte de 30d deixaria passar) ──
  -- O corte de 30 dias cega o S2 para um evento AGUDO: se a fonte mandar um snapshot
  -- truncado hoje, 200 mil chaves perdem a ativa e o S2 só reagiria em 30 dias — com
  -- o balcão sem vender nesse intervalo. Este sinal vigia o BRUTO contra o universo.
  -- LIMIAR 5%, e o número tem derivação. O bruto medido em prod oscila até ~12.400
  -- (2,7% de 463.995) como atrito normal, então 5% = 23.200 é ~1,85x a máxima
  -- observada. A primeira versão deste diff usava 10%, e a revisão adversária própria
  -- (Caminho B, docs/agent/money-path.md — a cota do Codex estava esgotada) achou o
  -- furo: entre 3% e 10% cabem 14.000 a 46.000 chaves sem fórmula ativa, com idade
  -- insuficiente para o S2 (30 dias) e volume insuficiente para o S4 — o balcão não
  -- venderia essas cores e NADA alarmaria. 10% era um número redondo, não uma medição.
  -- O que este sinal mede não é só catástrofe: é DISPONIBILIDADE DO CATÁLOGO AGORA,
  -- e 23 mil cores indisponíveis merecem aviso mesmo que voltem depois.
  -- ⚠️ O limiar é calibrado sobre o churn OBSERVADO. Se o churn crescer
  -- estruturalmente (catálogo maior, conector mais instável), isto vira alerta crônico
  -- — exatamente o que este diff remove do S2. A série para recalibrar fica no
  -- metadata do marcador (`fonte_retirada_bruto`, gravado todo ciclo).
  -- Fica em tipo PRÓPRIO: remediação (acionar o conector/a fonte) e urgência são outras.
  IF v_universo > 0 AND v_s2_bruto::numeric / v_universo >= 0.05 THEN
    v_msg := 'Tintometrico: ' || v_s2_bruto || ' de ' || v_universo || ' chaves ' ||
             'carimbadas (' || round(v_s2_bruto::numeric * 100 / v_universo, 1) ||
             '%) estao SEM formula ativa AGORA. O churn normal do snapshot fica em ' ||
             'torno de 2-3% (maxima medida 2,7%); este patamar indica snapshot ' ||
             'TRUNCADO ou retirada em ' ||
             'massa pela fonte. O balcao nao vende essas cores enquanto durar. Acao: ' ||
             'conferir o ultimo ciclo do conector (tint_sync_runs) e a fonte.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_colapso', v_s2_bruto,
      CASE WHEN v_s2_bruto::numeric / v_universo >= 0.20 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] colapso de disponibilidade no catalogo carimbado', v_msg,
      jsonb_build_object('bruto', v_s2_bruto, 'universo', v_universo,
                         'pct', round(v_s2_bruto::numeric * 100 / v_universo, 2)),
      -- fator 1.0, como S1 e S3: o colapso é RARO e GRAVE, e nessa classe qualquer
      -- piora merece e-mail. A histerese 2.0 do S2 existe para churn crônico — aqui
      -- ela abriria zona morta (46.400 -> 80.000 chaves sem aviso) num evento agudo.
      1.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_colapso', 0, 'info', '', '', '{}'::jsonb);
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
                             'fonte_retirada_bruto', v_s2_bruto,
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
  IF position('tint_watchdog_fase5 guard v3' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P1 FALHOU: o marcador v3 não está na função';
  END IF;
  IF v_src !~ 'sem_ativa_desde < now\(\) - interval ''30 days''' THEN
    RAISE EXCEPTION 'P2 FALHOU: o corte de 30 dias do S2 não está na varredura';
  END IF;
  IF position('tint_fase5_fonte_colapso' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: o sinal de colapso (S4) não está na função';
  END IF;
  -- Herdado da v2 e preservado aqui: S2 nunca volta a escalar para 'critico'. O S4 é quem pode
  -- ser crítico agora (colapso >=30%), e ele tem tipo próprio — o teto do S2 segue 'aviso'.
  IF v_src ~ 'v_s2 >= [0-9]+ THEN ''critico''' THEN
    RAISE EXCEPTION 'P3b FALHOU: S2 voltou a escalar para critico (decisão de 20261010230000)';
  END IF;
  -- A instrução REJEITADA não pode voltar: a v2 mandava limpar/recarimbar o motivo, que hoje
  -- é barrado por trigger. Se um replace futuro ressuscitar esse texto, isto aborta.
  IF v_src ~ 'recarimbar/limpar' THEN
    RAISE EXCEPTION 'P4 FALHOU: a mensagem voltou a instruir limpar/recarimbar o tombstone (ação rejeitada em 20260924120000 e barrada por trigger)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'P5 FALHOU: a função deixou de ser SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: anon/authenticated executam o watchdog — o ACL não foi preservado';
  END IF;
  RAISE NOTICE 'tint_watchdog_fase5 v3: marcador v3, S2 com corte de 30d, S4 de colapso, definer, ACL preservado';
END
$post$;
