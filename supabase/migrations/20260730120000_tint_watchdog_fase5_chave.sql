-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — WATCHDOG da Fase 5, Camada B: a CHAVE carimbada sem preço
-- (Fase 5b#2, PR 2 de 2 — spec docs/superpowers/specs/2026-07-22-tint-fase5-watchdog-design.md)
--
-- POR QUE EXISTE. A Fase 5 (20260727120000) desativou 463.995 fórmulas da geração
-- '1' porque cada chave (account, sku_id, cor_id) tinha gêmea SL ATIVA E VÁLIDA.
-- Os guards provaram isso NO INSTANTE DO APPLY — a propriedade NÃO É DURÁVEL.
-- O PR 1 (20260727150000) vigia a CAUSA-RAIZ dominante (corante impagável, 14
-- linhas, 214ms, */5). Esta camada vigia o EFEITO, com fidelidade ao que o balcão
-- lê: a chave que ficou sem NENHUMA fórmula precificável.
--
-- POR QUE AS DUAS. A Camada A não vê receita corrompida numa fórmula isolada nem
-- chave retirada pela fonte; a B só detectaria a avalanche na varredura seguinte e
-- ignora dano fora do tombstone. São complementares, com funções e crons PRÓPRIOS
-- (Codex [P1]: "A e B no mesmo job = dependência de falha").
--
-- ORÁCULO = a própria v_tint_formula_canonica, não uma reimplementação do
-- predicado. (i) É o que o balcão lê, então mede o dano REAL em vez de um proxy;
-- (ii) precisão > recall — não alarma se a chave tiver outro fallback válido;
-- (iii) o predicado de validade já vive em 2 lugares (a view e a migration da Fase
-- 5); uma TERCEIRA cópia é exatamente o acoplamento da lição §9 do money-path.
--
-- NAO vive no _data_health_compute, e não é preferência: authenticated tem
-- statement_timeout=8s e o dashboard /health chama get_data_health() -> o compute
-- (useDataHealth.ts:21, repetido pelo DataHealthBadge). SECURITY DEFINER troca
-- privilégio, NAO o statement_timeout. Esta varredura custa ~53s: ali derrubaria o
-- dashboard para todo mundo. Este cron roda como supabase_admin (timeout 0).
--
-- ── A FORMA DA QUERY É PARTE DO DESENHO (medido em prod 2026-07-23) ──
-- A formulação óbvia — `NOT EXISTS (SELECT 1 FROM v_tint_formula_canonica v WHERE
-- v.account=... AND v.receita_valida)` correlacionado por chave — NAO TERMINOU em
-- 180s: são 464k avaliações de uma view que já é cara. A forma abaixo (agregação
-- + LEFT JOIN anti-join, materializando a view UMA vez) mede 52,7s. Não troque uma
-- pela outra "por legibilidade": a primeira não roda.
--
-- ── AS DUAS CLASSES SÃO DISJUNTAS, E ISSO É O ACHADO [P1] DO CODEX ──
-- Partição por "a chave ainda existe na fonte?":
--   S1 tem linha ATIVA e nenhuma canônica válida -> a chave existe e NAO PRECIFICA.
--      Dano de venda real. Remediação: consertar corante/receita.
--   S2 não tem linha ativa nenhuma -> a FONTE retirou a chave e o tombstone da '1'
--      ficou órfão (o writer tint_apply_keys_snapshot desativa a SL sem setar
--      desativada_motivo). Higiene, não venda perdida. Remediação: recarimbar (5b#1).
-- Juntar as duas no MESMO tipo as silencia pelo ON CONFLICT DO NOTHING: com ~30
-- retiradas/dia o alerta nunca voltaria a zero, e a degradação real (S1) ficaria
-- MUDA atrás de um alerta cronicamente aberto de S2. Daí tipos separados.
--
-- ── Achados do challenge Codex (gpt-5.6-sol, 2026-07-22) endereçados aqui ──
--  [P0] "B diária deixa a avalanche invisível por 24h" -> 6h, não diária.
--  [P1] "classes distintas no mesmo tipo se silenciam"  -> tipos separados (acima).
--  [P1] "A e B no mesmo job"                            -> função e cron PRÓPRIOS.
--  [P1] "sem last_success_at, ausência de alerta não é saúde" -> marcador
--       sync_state tint_watchdog_fase5, que só avança em sucesso COMPLETO. É o
--       marcador que o dead-man cruzado do PR 1 JA espera (>13h => alerta
--       tint_watchdog_fase5_parado): esta migration ATIVA uma vigilância que já
--       está em prod, hoje inerte por ausência do marcador.
--  [P1] "carimbo não é fundamento durável: delete/limpeza fazem o universo sumir
--       => zero => verde"                               -> S3, vigia de
--       CARDINALIDADE do universo (substituto barato do ledger, que fica p/ v2).
--  [P2] "falta política de agravamento"                 -> severidade escala com a
--       contagem, e um conjunto que PIORA re-emite e-mail em vez de ficar mudo.
--
-- LIMITE CONHECIDO (registrado, não corrigido): os dois oráculos compartilham a
-- definição de validade, logo não são independentes — Codex [P2], aceito.
-- E `base_disponivel` fica FORA do gatilho de propósito: 296.536 das carimbadas
-- (64%) já tinham base indisponível ANTES da Fase 5; incluí-la produziria 296k
-- alertas no dia 1 sobre condição pré-existente (o watchdog nasceria como ruído).
--
-- Prova: db/test-tint-fase5-watchdog.sh (PG17, migration REAL, view REAL, falsificação).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Helper de TRANSIÇÃO de alerta — uma cópia para os 3 sinais.
-- O PR 1 tem essa lógica inline porque tinha um sinal só; aqui são três, e três
-- cópias divergiriam. Encapsula o ciclo completo: abre / agrava+re-emite / dismissa.
-- `_n` no contexto é a grandeza comparável entre ciclos (é o que define "piorou").
-- ───────────────────────────────────────────────────────────────────────────
-- A assinatura de 7 args existiu na v1 deste arquivo (nunca aplicada em prod). Sem o
-- DROP, adicionar p_fator criaria um OVERLOAD e a chamada de 7 args ficaria ambígua.
DROP FUNCTION IF EXISTS public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb);

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

  -- Alerta já aberto. Com ON CONFLICT DO NOTHING puro, uma PIORA durante um
  -- incidente aberto ficaria MUDA (Codex [P1]). Se o conjunto cresceu, atualiza o
  -- alerta e re-enfileira o e-mail.
  -- Duas âncoras DIFERENTES, e confundi-las quebra a histerese (pego pelo assert
  -- B16c): `_n` é o valor do último CICLO e avança sempre, então comparar com ele
  -- faria o gatilho fugir junto — S2 subindo 15/ciclo nunca alcançaria o dobro e o
  -- e-mail NUNCA mais sairia, nem se explodisse de 300 para 100.000. A âncora certa
  -- é `_n_email`: o valor de quando o último e-mail saiu. Assim a re-emissão é
  -- logarítmica (300 → 600 → 1200 …): silenciosa no crescimento vegetativo, mas
  -- garantida a cada duplicação.
  SELECT COALESCE((contexto->>'_n')::bigint, 0),
         COALESCE((contexto->>'_n_email')::bigint, COALESCE((contexto->>'_n')::bigint, 0)),
         severidade
    INTO v_ant, v_ant_email, v_sev_ant
    FROM fin_alertas
   WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL;

  -- ⚠️ O UPDATE é INCONDICIONAL (2ª rodada do challenge Codex, [P1]). A versão
  -- anterior o embrulhava num `IF p_n > v_ant`, então uma MELHORA parcial não
  -- atualizava nada: com S2 caindo de 1.200 para 300, o alerta seguia mostrando
  -- 1.200 e a severidade do pico, e S2 podia voltar a 1.199 em silêncio total.
  -- Estado no banco reflete SEMPRE o ciclo atual; o que a histerese governa é só
  -- o E-MAIL.
  --
  -- Duas âncoras DIFERENTES, e confundi-las quebra a histerese (pego pelo assert
  -- B16c): `_n` é o valor do ciclo atual; `_n_email` é o valor de quando o último
  -- e-mail saiu. Comparar com `_n` faria o gatilho fugir junto com o valor e o
  -- e-mail nunca mais sairia. Com `_n_email`, a re-emissão é logarítmica.
  --
  -- REARME NA RECUPERAÇÃO ([P1] da 2ª rodada): se o sinal MELHORA materialmente
  -- (cai a metade ou menos do valor emailado), a âncora desce junto — senão, depois
  -- de um pico de 1.200, um novo patamar de 1.199 ficaria mudo para sempre.
  v_ant_email := CASE WHEN p_n <= v_ant_email / 2 THEN p_n ELSE v_ant_email END;

  -- Emite se DOBROU desde o último e-mail, OU se a SEVERIDADE SUBIU ([P1] da 2ª
  -- rodada): 9.600 'aviso' → 10.000 'critico' mudava o alerta para crítico sem
  -- avisar ninguém, e o próximo e-mail só sairia em 19.200.
  v_emitir := p_n >= GREATEST(v_ant_email * p_fator, v_ant_email + 1)
              OR (CASE p_sev      WHEN 'critico' THEN 3 WHEN 'aviso' THEN 2 ELSE 1 END
                > CASE v_sev_ant WHEN 'critico' THEN 3 WHEN 'aviso' THEN 2 ELSE 1 END);

  -- UPDATE ... RETURNING numa passada só: um dismiss CONCORRENTE entre o SELECT e o
  -- UPDATE faria o UPDATE não achar linha e, com o INSERT incondicional, sairia um
  -- e-mail "AGRAVOU" fantasma, sem alerta aberto por trás (Codex [P2]).
  UPDATE fin_alertas
     SET severidade = p_sev,
         mensagem   = p_msg,
         contexto   = p_ctx || jsonb_build_object('_n', p_n, 'avaliado_em', now(),
                                                  'agravou_de', v_ant,
                                                  -- só avança quando o e-mail de fato sai
                                                  '_n_email', CASE WHEN v_emitir THEN p_n ELSE v_ant_email END)
   WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL
  RETURNING 1 INTO v_upd;

  IF v_upd IS NOT NULL AND v_emitir AND p_n > v_ant THEN
    INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
    VALUES (p_company, 'outro', v_sev_forn, 'AGRAVOU: ' || p_titulo,
            p_msg || E'\n\n(agravamento: eram ' || v_ant || ')', 'pendente_notificacao');
  END IF;
END;
$function$;

COMMENT ON FUNCTION public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric) IS
  'Privada da Camada B (Fase 5b#2 PR 2): ciclo de vida de um alerta fin_alertas + '
  'e-mail via fornecedor_alerta. n=0 dismissa; n>0 abre, ou RE-EMITE se piorou em '
  'relação ao contexto->>_n do alerta aberto (ON CONFLICT DO NOTHING sozinho '
  'silenciaria o agravamento). Deriva a severidade de fornecedor_alerta da de '
  'fin_alertas — os dois CHECKs têm vocabulários diferentes.';


-- ───────────────────────────────────────────────────────────────────────────
-- A varredura da Camada B.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_watchdog_fase5_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- tint_watchdog_fase5 guard v1 — MARCADOR do guard anti-rollback. Uma versão
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
      CASE WHEN v_s2 >= 10000 THEN 'critico'
           WHEN v_s2 >= 100   THEN 'aviso' ELSE 'info' END,
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

COMMENT ON FUNCTION public.tint_watchdog_fase5_check() IS
  'Fase 5b#2 (PR 2): Camada B do watchdog - vigia a CHAVE carimbada pela Fase 5 que '
  'ficou sem formula precificavel, usando v_tint_formula_canonica como oraculo (o que '
  'o balcao le), nao uma 3a copia do predicado de validade. Emite 3 sinais em tipos '
  'SEPARADOS: chave sem preco (venda perdida), fonte retirada (tombstone orfao) e '
  'universo encolheu (o carimbo sumiu => risco de verde por vacuidade). Roda 6h '
  '(~53s). Grava o marcador sync_state tint_watchdog_fase5 que o dead-man cruzado do '
  'PR 1 vigia. NAO pode migrar para _data_health_compute: authenticated tem '
  'statement_timeout=8s e o dashboard /health chama aquele caminho.';

-- ───────────────────────────────────────────────────────────────────────────
-- SUPERFÍCIE DE EXECUÇÃO. Função SECURITY DEFINER nasce com EXECUTE para PUBLIC:
-- exposta como RPC do PostgREST, qualquer anon dispararia uma varredura de 53s
-- (amplificação de DoS barata) e escreveria em fin_alertas/sync_state.
-- Medido em prod: tint_watchdog_corante_check (PR 1) está HOJE com anon=X e
-- authenticated=X — corrigido aqui junto, por REVOKE puro (não recria a função,
-- logo não colide com o guard anti-rollback dela).
-- REVOKE FROM PUBLIC NAO tira anon/authenticated (grant explícito) => por nome.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.tint_watchdog_fase5_check()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tint_watchdog_corante_check()
  FROM PUBLIC, anon, authenticated;

-- Cron SQL-local (roda no Postgres como supabase_admin => statement_timeout=0).
-- NAO usa net.http_post, então não precisa de timeout_milliseconds; e o
-- job_run_details aqui carrega o erro plpgsql REAL (cron SQL-local é fonte
-- primária confiável - docs/agent/sync.md).
-- 6h, não diária: o Codex reprovou 24h de cegueira ([P0]). cron.schedule faz
-- upsert por nome => idempotente. O nome bate com o texto do alerta do PR 1.
-- ⚠️ SEMEADURA DO MARCADOR — fecha o [P0] do challenge Codex sobre este diff.
-- O marcador só era gravado no FIM da função. O dead-man cruzado do PR 1 (em prod
-- desde 23/07) só alarma quando a linha EXISTE e está velha:
--     SELECT now() - ss.last_sync_at INTO v_b_atraso ... IF v_b_atraso IS NOT NULL
-- Logo, se TODA execução falhasse antes do INSERT (erro na view, timeout, metadata
-- corrompida), o marcador nunca nasceria, o dead-man ficaria inerte e a camada
-- inteira seria VERDE PARA SEMPRE — exatamente o modo de falha que ela existe para
-- eliminar. Semear resolve sem tocar o PR 1: se nenhum ciclo concluir, em 13h o
-- alerta tint_watchdog_fase5_parado dispara sozinho.
--
-- E semear a BASELINE junto fecha o [P1] irmão: com universo_max ausente, a PRIMEIRA
-- execução ancoraria oportunisticamente QUALQUER universo que encontrasse — se o
-- carimbo colapsasse entre o apply e o 1º ciclo, o patamar destruído viraria a
-- referência e S3 nunca alarmaria. 463.995 é medição de prod (psql-ro, 2026-07-28),
-- não chute. ON CONFLICT DO NOTHING: re-aplicar a migration NÃO rebaixa um marcador
-- já vivo (nem sobrescreve um universo_max legítimo maior).
INSERT INTO sync_state (entity_type, account, last_sync_at, status, error_message, metadata)
VALUES ('tint_watchdog_fase5', 'oben', now(), 'pending', NULL,
        jsonb_build_object('universo_max', 463995, 'ancora_em', now(),
                           'semeado_pela_migration', true))
-- No conflito, NAO tocar last_sync_at/status (um marcador vivo nao volta a 'pending'),
-- mas GARANTIR a baseline: uma linha pre-existente sem universo_max — ou com um valor
-- MENOR, ja envenenado — faria a 1a execucao canonizar o universo degradado (Codex
-- [P2] da 2a rodada). GREATEST nunca REBAIXA um patamar legitimo maior.
ON CONFLICT (entity_type, account) DO UPDATE
  SET metadata = sync_state.metadata || jsonb_build_object(
        'universo_max', GREATEST(COALESCE((sync_state.metadata->>'universo_max')::bigint, 0), 463995),
        'ancora_em', COALESCE(sync_state.metadata->>'ancora_em', now()::text));

SELECT cron.schedule(
  'tint-watchdog-fase5-6h',
  '0 */6 * * *',
  $cron$SELECT public.tint_watchdog_fase5_check();$cron$
);

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- VALIDAÇÃO PÓS-APPLY (read-only; o founder cola, ou eu rodo via psql-ro)
--   1) funções + cron armado:
--      SELECT to_regprocedure('public.tint_watchdog_fase5_check()') IS NOT NULL AS fn_ok,
--             (SELECT active FROM cron.job WHERE jobname='tint-watchdog-fase5-6h') AS cron_ativo;
--   2) anon/authenticated FORA das 3 funções (esperado: 0 linhas):
--      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--       WHERE n.nspname='public'
--         AND p.proname IN ('tint_watchdog_fase5_check','_tint_watchdog_fase5_transicao',
--                           'tint_watchdog_corante_check')
--         AND (array_to_string(p.proacl,' ') ~ '(^| )(anon|authenticated)='
--              OR array_to_string(p.proacl,' ') ~ '(^| )=X');
--   3) primeira execução (~53s) + marcador (esperado 2026-07-28: S1=0 / S2=300 / 463995):
--      SELECT public.tint_watchdog_fase5_check();
--      SELECT status, last_sync_at, metadata FROM public.sync_state
--       WHERE entity_type='tint_watchdog_fase5' AND account='oben';
--   4) ⚠️ NAO nasce tudo em zero, e isso é CORRETO. Medido em prod 2026-07-28:
--      S2=300 (a fonte retirou 300 chaves em 5 dias; era 0 em 23/07) => a 1a execução
--      ABRE tint_fase5_fonte_retirada com severidade 'aviso' e manda 1 e-mail.
--      Isso é sinal honesto de HIGIENE do carimbo (follow-up 5b#1), NAO venda perdida:
--      S1, que mede venda perdida de verdade, nasce em 0.
--      SELECT tipo, severidade, contexto->>'_n' AS n FROM public.fin_alertas
--       WHERE tipo IN ('tint_fase5_chave_sem_preco','tint_fase5_fonte_retirada',
--                      'tint_fase5_universo_encolheu','tint_watchdog_fase5_parado')
--         AND dismissed_at IS NULL;
--      -- esperado: exatamente 1 linha (tint_fase5_fonte_retirada / aviso / 300)
--   5) o dead-man cruzado do PR 1 deixa de ser inerte (o marcador agora existe):
--      SELECT entity_type, status, last_sync_at FROM public.sync_state
--       WHERE entity_type='tint_watchdog_fase5';   -- 'pending' até o 1o ciclo concluir
-- ───────────────────────────────────────────────────────────────────────────
