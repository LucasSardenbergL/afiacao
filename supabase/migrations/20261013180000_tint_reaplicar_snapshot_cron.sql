-- ============================================================================================
-- 20261013180000 · tint_reaplicar_snapshot_tick() + cron de 6h — MITIGAÇÃO TEMPORÁRIA
-- Prova: db/test-tint-reaplicar-snapshot.sh (PG17, migration REAL, 5 falsificações)
--
-- ⚠️ LEIA ISTO PRIMEIRO — ESTA MIGRATION TEM PRAZO DE VALIDADE E CONFLITA COM O #3051.
-- Ela NÃO conserta nada: encurta a janela de uma exposição enquanto o conserto de raiz
-- (#3051, `20261013150000_tint_promote_nao_ressuscita_fantasma.sql`) não estiver APLICADO em
-- prod. Quando o #3051 entrar, REMOVA este cron:
--     select cron.unschedule('tint-reaplicar-snapshot-6h');
-- Manter os dois é pior que manter só o #3051 — ver "POR QUE OS DOIS SE MORDEM" abaixo.
--
-- O QUE: um cron de 6h que re-marca o snapshot de chaves mais recente como `pendente`. O
-- `tint_promocao_tick` (cron de 15s) então o re-aplica, e o `tint_apply_keys_snapshot`
-- desativa de novo toda fórmula ativa cuja chave não está no snapshot.
--
-- POR QUÊ — a medição (psql-ro, prod, 2026-10-13 12:15 UTC):
--   26.180 fórmulas ATIVAS de 6.545 cores que a FONTE não tem (ausentes do snapshot aplicado).
--   Todas canônicas, todas com receita válida; 9.164 com PREÇO FINAL no balcão (408 cores, 9
--   produtos). Das 3.099 cores-fonte por trás dos alertas, 3.052 (98,5%) não aparecem em NENHUM
--   snapshot desde 14/09 — não é cor que sai e volta, é cor retirada há semanas, reativada todo
--   dia. O ciclo: o apply (~03:13) desativa 2.600-6.300/dia com `desativada_motivo` NULL; ao
--   longo do dia o promote reexpande o staging latest do par (across todos os runs) e o upsert
--   faz `desativada_em = NULL`. Medido hoje: entre 10:53:37 e 12:43:42 UTC o promote tocou
--   460.424 linhas ativas em 460.424 chaves carimbadas — 99,2% do universo de 463.995.
--   Venda registrada: ZERO, mas só porque `tint_vendas`/`tint_vendas_itens` estão vazias (0/0
--   medido) — a exposição até agora é de COTAÇÃO. O #3047 ("negociar a cor no carrinho") mergeou
--   em 13/10 12:45 UTC, então isso está a um passo de virar pedido.
--
-- POR QUE UM CRON, E NÃO "aumentar a frequência do apply": o apply NÃO tem agenda própria. O
--   `tint_promocao_tick` já roda a cada 15 SEGUNDOS e aplica qualquer snapshot com
--   `aplicacao_status='pendente'`; a cadência diária é do CONECTOR, que entrega um snapshot por
--   dia (~03:05). Mexer em frequência de cron seria no-op: a fila fica vazia entre entregas. O
--   único gatilho que existe é marcar `pendente` de novo — é o que esta função faz.
--
-- POR QUE 6h (`30 */6`): o apply leva ~8 min (03:05:24→03:13:24; 7:56 / 8:30 / 8:12 / 8:20 nos
--   4 dias anteriores) e o `tint_promocao_tick` serializa por advisory lock ⇒ cada re-apply
--   PAUSA a fila de promoção por ~8 min. A 6h são 4 re-applies/dia (~32 min/dia de pausa) e a
--   exposição média cai de ~24h para ~3h. O `:30` evita o `:00` do `tint-watchdog-fase5-6h`
--   (varredura de 131s) e a chegada do snapshot das ~03:05.
--
-- POR QUE OS DOIS SE MORDEM (#3051 × esta): o #3051 bloqueia a ressurreição por critério
--   TEMPORAL — staging recebido DEPOIS do snapshot passa (é evidência nova de que a cor
--   existe), staging anterior a um snapshot que não contém a chave não passa. O corpo do #3051
--   rejeita explicitamente o bloqueio por PRESENÇA PURA, porque ele "atrasaria em até 24h toda
--   cor nova da fonte". Esta migration É presença pura: re-aplicar um snapshot de até 36h
--   desativa o que não está nele, inclusive cor nova e legítima que o promote ativou depois. Com
--   o #3051 aplicado, este cron voltaria a matar exatamente o que o critério temporal deixa
--   passar de propósito. Os dois juntos = o falso positivo que o #3051 foi desenhado para evitar.
--
-- O FALSO POSITIVO, MEDIDO (é o que torna a mitigação aceitável NO INTERVALO): o conjunto de
--   chaves da fonte é quase estático. Snapshot de hoje vs de ontem: 122.842 ↔ 122.842, ZERO
--   entraram, ZERO saíram. Em 7 dias (06/10→13/10): 37 entraram, 36 saíram ≈ 5 chaves/dia. Então
--   re-aplicar um snapshot de até 24h arrisca desativar da ordem de ~5 chaves reais por dia,
--   contra 6.545 chaves-fantasma hoje ativas — ~1.300:1. A cor atingida volta no apply do dia
--   seguinte (ela ESTÁ no snapshot novo), então o pior caso é ficar invendável por <1 dia.
--   ⚠️ Esta razão é de HOJE. Se a fonte voltar a crescer, o falso positivo cresce com ela e a
--   mitigação deixa de valer — mais um motivo para o prazo de validade no topo.
--
-- LIMITES CONHECIDOS (registrados, não corrigidos):
--  (a) GUARD DE OBSOLESCÊNCIA de 36h: se o conector parar de entregar (houve buraco de 14/08 a
--      28/09 — snapshots de 21 a 25/09 com `aplicado_em` NULL, primeiro apply em 28/09 10:25), o
--      cron PARA em vez de impor um snapshot cada vez mais velho. Falha para o lado de não agir:
--      a exposição volta ao que era, sem um apply que desativaria o catálogo inteiro à medida que
--      a fonte andasse. O `tint_watchdog_fase5_check` e o dead-man continuam sendo o sensor.
--  (b) SNAPSHOT EM `erro` NÃO É RE-SELECIONADO: a função só pega `aplicacao_status='aplicado'`.
--      Se um re-apply falhar 3× o tick o deixa em `erro`, e a partir daí este cron não acha mais
--      alvo — a mitigação para EM SILÊNCIO (o rastro fica em `aplicacao_erro`). Deliberado: um
--      snapshot que falhou pode ter falhado por blast radius, e re-enfileirá-lo a cada 6h
--      transformaria uma recusa correta em laço. A query de vigilância está em "VALIDAÇÃO".
--  (c) Não há lock próprio: dois ticks simultâneos poderiam marcar o mesmo snapshot. Inócuo (o
--      UPDATE é idempotente e o `tint_promocao_tick` tem advisory lock próprio), e o cron é de 6h.
--
-- GUARD: `cron.schedule` com o mesmo nome ATUALIZA o job (idempotente). A função é CREATE OR
-- REPLACE. Postcondições P1-P6 no fim abortam se o job não ficar exatamente como descrito.
-- ⚠️ Função NOVA ⇒ o REVOKE nomeia as roles: `REVOKE FROM PUBLIC` não tira `anon`/`authenticated`
-- (grant explícito do Supabase). Ninguém além do cron precisa executar isto.
--
-- APLICAR: SQL Editor do Lovable (custom migration NÃO auto-aplica). Idempotente.
-- VALIDAÇÃO pós-apply (psql-ro):
--   -- o job entrou?
--   select jobname, schedule, active from cron.job where jobname='tint-reaplicar-snapshot-6h';
--   -- cada re-apply desativou quanto? (e a mitigação parou em silêncio?)
--   select generated_at, aplicacao_status, aplicacao_tentativas, aplicado_em, aplicacao_erro
--     from tint_keys_snapshots where entity='formulas'
--     order by generated_at desc, chunk_index limit 6;
--   -- o bruto do watchdog deve SUBIR na rodada seguinte (as fantasmas voltam a contar como
--   -- "sem ativa"), e é isso que se quer ver: o sinal volta a ver o que o promote escondia.
--   select metadata from sync_state where entity_type='tint_watchdog_fase5';
-- ============================================================================================

CREATE OR REPLACE FUNCTION public.tint_reaplicar_snapshot_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r              record;
  v_chunks       int;
  v_snaps        int := 0;
  v_total_chunks int := 0;
  v_saltados     int := 0;
BEGIN
  -- Alvo = o snapshot APLICADO mais recente de cada (account, store_code), e só se ele for
  -- fresco o bastante (limite (a) do cabeçalho). `aplicado` de propósito: `erro` fica fora
  -- (limite (b)) e `NULL` é da era pré-fila (30 chunks de até 25/09 em prod).
  FOR r IN
    SELECT DISTINCT ON (ks.account, ks.store_code)
           ks.snapshot_id, ks.account, ks.store_code, ks.generated_at
      FROM tint_keys_snapshots ks
     WHERE ks.entity = 'formulas'
       AND ks.aplicacao_status = 'aplicado'
       AND ks.generated_at > now() - interval '36 hours'
     ORDER BY ks.account, ks.store_code, ks.generated_at DESC
  LOOP
    -- NÃO EMPILHA: se já existe pendente para o par, o tick anterior ainda não foi consumido.
    -- Marcar outro faria dois snapshots do mesmo par disputarem a cabeça da fila.
    PERFORM 1
       FROM tint_keys_snapshots p
      WHERE p.entity = 'formulas'
        AND p.account = r.account
        AND p.store_code = r.store_code
        AND p.aplicacao_status = 'pendente';
    IF FOUND THEN
      v_saltados := v_saltados + 1;
      CONTINUE;
    END IF;

    -- `aplicacao_tentativas = 0` É PARTE DO CONSERTO, não higiene: o tick INCREMENTA tentativas
    -- e NÃO as zera no sucesso, e o teto é 3. Sem zerar aqui, o 3º re-apply esgotaria o
    -- orçamento de retry e a PRIMEIRA falha real de verdade iria direto para `erro`, sem retry.
    UPDATE tint_keys_snapshots ks
       SET aplicacao_status     = 'pendente',
           aplicacao_tentativas = 0,
           aplicacao_proxima_em = NULL,
           aplicacao_erro       = NULL
     WHERE ks.entity = 'formulas'
       AND ks.snapshot_id = r.snapshot_id;
    GET DIAGNOSTICS v_chunks = ROW_COUNT;

    v_snaps        := v_snaps + 1;
    v_total_chunks := v_total_chunks + v_chunks;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'snapshots_remarcados', v_snaps,
    'chunks_marcados', v_total_chunks,
    'pares_saltados_por_pendente', v_saltados
  );
END
$function$;

-- Só o cron (postgres) executa. Função NOVA ⇒ revogar NOMEANDO as roles.
REVOKE ALL ON FUNCTION public.tint_reaplicar_snapshot_tick() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tint_reaplicar_snapshot_tick() FROM anon;
REVOKE ALL ON FUNCTION public.tint_reaplicar_snapshot_tick() FROM authenticated;

SELECT cron.schedule(
  'tint-reaplicar-snapshot-6h',
  '30 */6 * * *',
  $c$SELECT public.tint_reaplicar_snapshot_tick();$c$
);

DO $post$
DECLARE
  v_n     int;
  v_cmd   text;
  v_sched text;
  v_ativo boolean;
  v_acl   boolean;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'tint-reaplicar-snapshot-6h';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P1 FALHOU: % job(s) tint-reaplicar-snapshot-6h — esperado exatamente 1', v_n;
  END IF;

  SELECT command, schedule, active INTO v_cmd, v_sched, v_ativo
    FROM cron.job WHERE jobname = 'tint-reaplicar-snapshot-6h';

  IF v_cmd <> $c$SELECT public.tint_reaplicar_snapshot_tick();$c$ THEN
    RAISE EXCEPTION 'P2 FALHOU: comando do job inesperado: %', v_cmd;
  END IF;
  IF v_sched <> '30 */6 * * *' THEN
    RAISE EXCEPTION 'P3 FALHOU: horário do job inesperado: %', v_sched;
  END IF;
  IF NOT v_ativo THEN
    RAISE EXCEPTION 'P4 FALHOU: job inativo — a mitigação não rodaria';
  END IF;
  IF to_regprocedure('public.tint_reaplicar_snapshot_tick()') IS NULL THEN
    RAISE EXCEPTION 'P5 FALHOU: a função chamada pelo job não existe';
  END IF;

  -- P6: o REVOKE pegou. `has_function_privilege` em role que não existe lança, então o
  -- EXISTS protege o teste de ambiente sem as roles do Supabase (PG local da prova).
  SELECT bool_or(has_function_privilege(rolname, 'public.tint_reaplicar_snapshot_tick()', 'EXECUTE'))
    INTO v_acl
    FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  IF COALESCE(v_acl, false) THEN
    RAISE EXCEPTION 'P6 FALHOU: anon/authenticated ainda têm EXECUTE na função';
  END IF;

  RAISE NOTICE 'tint-reaplicar-snapshot-6h: 1 job ativo, 30 */6 * * *, função sem EXECUTE para anon/authenticated';
  RAISE NOTICE 'MITIGAÇÃO TEMPORÁRIA: remover com cron.unschedule(''tint-reaplicar-snapshot-6h'') quando o #3051 estiver aplicado';
END
$post$;
