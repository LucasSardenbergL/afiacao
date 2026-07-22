-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║  FU4-E hardening — `IS NOT TRUE` nas 3 RPCs de ESCRITA  [money-path / autorização]         ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
-- Prova: db/test-authz-is-not-true-escritas.sh (PG17, SET ROLE authenticated, com falsificação)
-- Achado [P2] da revisão adversária retroativa via Codex (2026-07-20) dos #1462/#1467/#1472.
--
-- ── O QUE MUDA (e o que NÃO muda) ──────────────────────────────────────────────────────────
-- As 3 RPCs de escrita de compras gateiam com `IF NOT private.cap_compras_escrever(...)`:
--   · public.despinar_parametro(text,text)
--   · public.reverter_parametro_auto(uuid)
--   · public.reverter_run_auto(uuid)
-- Hoje isso é CORRETO, porque `cap_compras_escrever` faz `COALESCE(..., false)` e nunca devolve
-- NULL. Zero mudança de comportamento com a capability atual — é hardening, não correção.
--
-- ── POR QUE MESMO ASSIM VALE ───────────────────────────────────────────────────────────────
-- `IF NOT x` é fail-OPEN quando x é NULL: `NOT NULL` = NULL, o IF não entra, e a SECURITY
-- DEFINER EXECUTA. O gate correto depende hoje de um detalhe INTERNO da capability (o COALESCE),
-- não do contrato do chamador. Se um dia alguém retirar o COALESCE, acrescentar um ramo que
-- devolva NULL, ou trocar a capability por outra função, as 3 RPCs voltam a ser fail-open —
-- silenciosamente, sem erro, sem teste vermelho.
-- Isso NÃO é hipotético: foi exatamente o que aconteceu com o gate ANTERIOR. Com
-- `pode_ver_carteira_completa` (TRI-STATE, medido), um `employee` SEM linha em commercial_roles
-- produzia NULL e as 3 RPCs O DEIXAVAM ESCREVER. O #1462 fechou isso por efeito colateral de
-- trocar a função — não por ter corrigido a FORMA do gate. A forma continua frágil.
-- O #1472 já aplicou `IS NOT TRUE` na RPC de LEITURA pelo mesmo motivo. Isto alinha a escrita.
--
-- `IS NOT TRUE` trata NULL como negado (fail-CLOSED) e é idêntico a `NOT` para true/false ⇒
-- a defesa passa a valer independentemente de quem implementa a capability.
--
-- ⚠️ Migration MANUAL (Lovable não aplica nome custom) — colar no SQL Editor.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 0) PRECONDIÇÕES
-- ════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_alvos text[] := ARRAY['public.despinar_parametro(text,text)',
                          'public.reverter_parametro_auto(uuid)',
                          'public.reverter_run_auto(uuid)'];
  v_a text;
BEGIN
  IF to_regprocedure('private.cap_compras_escrever(uuid)') IS NULL THEN
    RAISE EXCEPTION 'FU4-E/INT: private.cap_compras_escrever(uuid) ausente — aplique o #1462 antes'
      USING ERRCODE = 'raise_exception';
  END IF;
  FOREACH v_a IN ARRAY v_alvos LOOP
    IF to_regprocedure(v_a) IS NULL THEN
      RAISE EXCEPTION 'FU4-E/INT: funcao % nao encontrada — banco divergente', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 1) A TROCA — `IF NOT cap(...)` vira `IF cap(...) IS NOT TRUE`
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Substituição programática guardada a partir do corpo VIVO (mesmo padrão do #1462/#1472: o repo
-- diverge de prod em CREATE OR REPLACE e a última a recriar vence).
--
-- ⚠️ O regex casa `NOT` + a chamada + `THEN`, e preserva o ARGUMENTO verbatim — `despinar_parametro`
-- e `reverter_run_auto` passam `auth.uid()`, `reverter_parametro_auto` passa `v_uid` (medido).
-- Fixar o argumento no padrão quebraria a terceira, que foi a armadilha registrada no #1462.
DO $$
DECLARE
  v_alvos text[] := ARRAY['public.despinar_parametro(text,text)',
                          'public.reverter_parametro_auto(uuid)',
                          'public.reverter_run_auto(uuid)'];
  v_a     text;
  v_def   text;
  v_novo  text;
  v_ocorr int;
  -- forma ANTIGA: `IF NOT private.cap_compras_escrever(<arg>) THEN`. `\1` captura o argumento.
  c_re_antigo constant text := 'IF\s+NOT\s+private\.cap_compras_escrever\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)\s+THEN';
  -- forma NOVA, já aplicada (idempotência)
  c_re_novo   constant text := 'private\.cap_compras_escrever\s*\([^;]*\)\s+IS NOT TRUE\s+THEN';
BEGIN
  FOREACH v_a IN ARRAY v_alvos LOOP
    v_def := pg_get_functiondef(to_regprocedure(v_a));

    -- IDEMPOTENTE: já migrada ⇒ segue (o dono cola à mão; rede caindo não pode travar a 2ª vez).
    IF v_def ~ c_re_novo AND v_def !~ c_re_antigo THEN
      RAISE NOTICE 'FU4-E/INT: % já usa IS NOT TRUE — nada a fazer', v_a;
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_ocorr FROM regexp_matches(v_def, c_re_antigo, 'g');
    IF v_ocorr <> 1 THEN
      RAISE EXCEPTION 'FU4-E/INT: esperava 1 gate `IF NOT cap(...)` em %, encontrei % — inspecione pg_get_functiondef', v_a, v_ocorr
        USING ERRCODE = 'raise_exception';
    END IF;

    -- `\1` devolve o argumento exatamente como estava (auth.uid() ou v_uid).
    v_novo := regexp_replace(v_def, c_re_antigo,
                             'IF private.cap_compras_escrever(\1) IS NOT TRUE THEN', 'g');

    IF v_novo = v_def THEN
      RAISE EXCEPTION 'FU4-E/INT: nenhum padrao casou em % — nao aplicar no-op silencioso', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo ~ c_re_antigo THEN
      RAISE EXCEPTION 'FU4-E/INT: sobrou `IF NOT cap(...)` em % apos a troca', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo !~ c_re_novo THEN
      RAISE EXCEPTION 'FU4-E/INT: a forma IS NOT TRUE nao aparece em % apos a troca', v_a
        USING ERRCODE = 'raise_exception';
    END IF;

    EXECUTE v_novo;

    -- pós-check no CATÁLOGO (o guard acima valida a string; isto valida o que ficou gravado)
    v_def := pg_get_functiondef(to_regprocedure(v_a));
    IF v_def !~ c_re_novo OR v_def ~ c_re_antigo THEN
      RAISE EXCEPTION 'FU4-E/INT: pos-check falhou em %', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY → db/valida-fu4e-cap-compras-escrever.sql (atualizado neste mesmo PR).
-- ════════════════════════════════════════════════════════════════════════════════════════════
