-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║  FU4-G — o bypass SECDEF da matriz de LEITURA de compras  [money-path / autorização]      ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
-- Prova: db/test-authz-cap-compras-ler-pos-candidatos.sh (PG17, SET ROLE authenticated, com falsificação)
-- Continuação do E2/FU4 (#1434, aplicado) e do FU4-E (#1462, aplicado).
--
-- ── O FURO (medido em prod via psql-ro, 2026-07-20) ────────────────────────────────────────
-- O #1434 fechou as 9 tabelas `reposicao_*` em `private.cap_compras_ler` (master-only) via RLS.
-- Mas `public.reposicao_pos_candidatos(text)` é **SECURITY DEFINER** — ela BYPASSA essa RLS e
-- faz o próprio gate no corpo, que ficou no gate ANTIGO `pode_ver_carteira_completa`.
-- Ela lê `reposicao_pedidos_compra_run` e `reposicao_po_last_seen` (2 das 9) e PROJETA
-- `valor_total`, `fornecedor_nome`, `portal_protocolo`, `status_envio_portal` e `resposta_canal`
-- (JSON cru do canal). Tem `EXECUTE` para `authenticated`.
-- ⇒ um `gerencial` não lê as tabelas direto (RLS nega), mas lê o CONTEÚDO delas pela RPC.
-- É o mesmo padrão que o #1434 tratou nas 4 RPCs SECDEF de CUSTO, e que o FU4-E tratou nas 3 de
-- ESCRITA de compras — aqui na LEITURA de compras.
--
-- POR QUE ESCAPOU: a função nasceu no #1453 (migration 20260721190000), DEPOIS da matriz. O
-- #1434 não tinha como tratá-la. Não é regressão de nenhum dos dois — é superfície nova que
-- nasceu com o gate velho, e é assim que uma matriz de autorização se erode.
--
-- INERTE HOJE, LATENTE AMANHÃ: medido 2026-07-20 — 2 farmer + 1 master, ZERO gerencial. Como o
-- gate antigo é `master OR gestor comercial` e não há gestor vivo, só o master passa hoje nos
-- DOIS gates ⇒ a troca não retira acesso de ninguém. O furo abre no dia da primeira promoção.
--
-- ── VARREDURA DAS IRMÃS (o gate parcial é vazamento latente — database.md §66) ──────────────
-- 6 funções SECDEF tocam as 9 tabelas fora da matriz. As outras 5
-- (`aplicar_parametros_automatico_diario`, `reposicao_aplicar_depara_sayerlack_auto`,
-- `reposicao_cold_start_parametros`, `reposicao_param_auto_resumo_tick`,
-- `reposicao_publicar_run_completo`) NÃO são furo: não têm gate JWT, mas medi
-- `has_function_privilege(authenticated|anon, …)` = FALSE nas cinco — são service-role-only pela
-- fronteira de GRANT, o padrão correto para engine de cron (database.md §61). `pos_candidatos` é
-- a ÚNICA com EXECUTE para `authenticated`.
--
-- ── POR QUE `cap_compras_ler` E NÃO `cap_compras_escrever` ─────────────────────────────────
-- A função é `STABLE` e `RETURNS TABLE` — leitura pura, não muta nada. Ler telemetria de compras
-- é exatamente o que `cap_compras_ler` governa nas 9 tabelas; usar a de escrita seria mais
-- restritivo que a policy equivalente e incoerente com a matriz.
--
-- ── O `IS NOT TRUE` FICA (e o comentário dele precisa mudar) ────────────────────────────────
-- O corpo usa `IS NOT TRUE` porque `pode_ver_carteira_completa` é TRI-STATE: para um `employee`
-- sem linha em `commercial_roles` ela devolve NULL, e `NOT NULL` = NULL ⇒ o IF não entrava e a
-- SECDEF entregava tudo (bypass real, Codex v11). `private.cap_compras_ler` faz
-- `COALESCE(…,false)` e NUNCA devolve NULL, então hoje `IS NOT TRUE` ≡ `NOT (…)`. Mantemos por
-- defesa em profundidade — mas o COMENTÁRIO que afirma "é TRI-STATE" passaria a ser FALSO sobre
-- a função nova, então ele é corrigido junto (§1, replace 2). Comentário errado num gate de
-- autorização é dívida que o próximo leitor paga.
--
-- ⚠️ Migration MANUAL (Lovable não aplica nome custom) — colar no SQL Editor.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 0) PRECONDIÇÕES — aborta se o banco vivo divergir do medido
-- ════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_gerenciais int;
BEGIN
  IF to_regprocedure('public.reposicao_pos_candidatos(text)') IS NULL THEN
    RAISE EXCEPTION 'FU4-G: reposicao_pos_candidatos(text) ausente — banco divergente, abortando'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- DEPENDÊNCIA REAL (≠ FU4-E, que era autônoma de propósito): aqui o gate de destino é a
  -- capability criada pelo #1434. Sem ela, o CREATE OR REPLACE passaria (plpgsql é late-bound) e
  -- a função só quebraria ao ser CHAMADA — deixando a fila de atenção morta em runtime, para o
  -- master inclusive. Precondição explícita em vez de caller órfão (a falha do #1423).
  IF to_regprocedure('private.cap_compras_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'FU4-G: private.cap_compras_ler(uuid) ausente — aplique o #1434 (20260718190000) antes'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF to_regclass('public.commercial_roles') IS NULL THEN
    RAISE EXCEPTION 'FU4-G: tabela commercial_roles ausente — banco divergente, abortando'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO v_gerenciais FROM public.commercial_roles
   WHERE commercial_role IN ('gerencial','estrategico','super_admin');
  IF v_gerenciais > 0 THEN
    RAISE EXCEPTION 'FU4-G: % papel(is) gerencial(is) vivo(s) — a troca muda o acesso deles. Revise antes de aplicar.', v_gerenciais
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 1) A TROCA — substituição programática guardada, a partir do corpo VIVO
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠️ DIFERENÇA CRÍTICA em relação ao FU4-E: aqui o corpo MENCIONA `pode_ver_carteira_completa`
-- DUAS vezes — uma na chamada (código) e outra num COMENTÁRIO que explica o `IS NOT TRUE`.
-- O padrão do FU4-E (contar ocorrências do nome e exigir exatamente 1) ABORTARIA aqui, e um
-- `regexp_replace` global reescreveria o comentário para uma afirmação FALSA
-- ("private.cap_compras_ler() é TRI-STATE" — ela não é, faz COALESCE).
-- Solução: os dois casos são textualmente DISTINGUÍVEIS e tratados por regex separados —
--   · chamada:    `pode_ver_carteira_completa((SELECT …`  → parênteses COM argumento
--   · comentário: `pode_ver_carteira_completa()`          → parênteses VAZIOS
-- Cada um com contagem própria; qualquer divergência aborta.
DO $$
DECLARE
  v_alvo  constant text := 'public.reposicao_pos_candidatos(text)';
  v_oid   regprocedure;
  v_def   text;
  v_novo  text;
  v_ocorr int;
  -- a CHAMADA: nome qualificado + `(` + `(SELECT`. Tolerante a espaçamento; o alternador aceita
  -- `private.` porque a prod tem as duas formas do gate antigo (impl private + wrapper public).
  c_re_chamada  constant text := '(public\.|private\.)?pode_ver_carteira_completa\s*\(\s*\(\s*SELECT';
  -- o COMENTÁRIO: a afirmação que fica falsa depois da troca.
  c_re_coment   constant text := 'pode_ver_carteira_completa\(\) é TRI-STATE';
  -- o gate NOVO, na forma de chamada (não de menção textual).
  c_re_novo     constant text := 'private\.cap_compras_ler\s*\(\s*\(\s*SELECT';
BEGIN
  v_oid := to_regprocedure(v_alvo);   -- existência já garantida na §0
  v_def := pg_get_functiondef(v_oid);

  -- IDEMPOTENTE: já migrada ⇒ segue. O dono cola à mão; uma queda de rede no meio não pode
  -- travar a 2ª tentativa.
  IF v_def ~ c_re_novo AND v_def !~ c_re_chamada THEN
    RAISE NOTICE 'FU4-G: % já está no gate novo — nada a fazer', v_alvo;
    RETURN;
  END IF;

  -- exatamente 1 CHAMADA do gate antigo — medido em prod 2026-07-20.
  SELECT count(*) INTO v_ocorr FROM regexp_matches(v_def, c_re_chamada, 'g');
  IF v_ocorr <> 1 THEN
    RAISE EXCEPTION 'FU4-G: esperava 1 CHAMADA do gate antigo em %, encontrei % — inspecione pg_get_functiondef antes de prosseguir', v_alvo, v_ocorr
      USING ERRCODE = 'raise_exception';
  END IF;

  -- exatamente 1 menção no COMENTÁRIO. Zero significaria corpo diferente do medido (o comentário
  -- foi reescrito por outra migration) — abortar é melhor que deixar comentário incoerente.
  SELECT count(*) INTO v_ocorr FROM regexp_matches(v_def, c_re_coment, 'g');
  IF v_ocorr <> 1 THEN
    RAISE EXCEPTION 'FU4-G: esperava 1 mencao do gate antigo no comentario de %, encontrei % — corpo divergente do medido', v_alvo, v_ocorr
      USING ERRCODE = 'raise_exception';
  END IF;

  -- replace 1 — a CHAMADA. Troca nome + abre-parêntese; o argumento `((SELECT auth.uid()))` e o
  -- `IS NOT TRUE` ficam intactos.
  v_novo := regexp_replace(v_def, c_re_chamada, 'private.cap_compras_ler((SELECT', 'g');

  -- replace 2 — o COMENTÁRIO que ficaria falso. Preserva a história (por que o IS NOT TRUE
  -- existe) e diz a verdade sobre a função nova.
  v_novo := regexp_replace(
    v_novo, c_re_coment,
    'pode_ver_carteira_completa() era TRI-STATE (o gate ANTERIOR; private.cap_compras_ler faz COALESCE e nunca devolve NULL, entao IS NOT TRUE fica como defesa em profundidade)',
    'g');

  IF v_novo = v_def THEN
    RAISE EXCEPTION 'FU4-G: nenhum padrao casou em % — nao aplicar no-op silencioso', v_alvo
      USING ERRCODE = 'raise_exception';
  END IF;
  IF v_novo ~ c_re_chamada THEN
    RAISE EXCEPTION 'FU4-G: sobrou CHAMADA ao gate antigo em % apos a troca', v_alvo
      USING ERRCODE = 'raise_exception';
  END IF;
  IF v_novo !~ c_re_novo THEN
    RAISE EXCEPTION 'FU4-G: o gate NOVO nao aparece como chamada em % apos a troca', v_alvo
      USING ERRCODE = 'raise_exception';
  END IF;

  EXECUTE v_novo;

  -- pós-check POSITIVO no catálogo. ⚠️ Checa a CHAMADA, não a MENÇÃO: exigir ausência total da
  -- string `pode_ver_carteira_completa` falharia de propósito — o comentário histórico a mantém,
  -- e é assim que tem de ser.
  v_def := pg_get_functiondef(to_regprocedure(v_alvo));
  IF v_def !~ c_re_novo THEN
    RAISE EXCEPTION 'FU4-G: pos-check falhou — % nao ficou com o gate novo', v_alvo
      USING ERRCODE = 'raise_exception';
  END IF;
  IF v_def ~ c_re_chamada THEN
    RAISE EXCEPTION 'FU4-G: pos-check falhou — % ainda CHAMA o gate antigo', v_alvo
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY → db/valida-fu4g-pos-candidatos.sql (só catálogo; roda de qualquer role).
-- Não repetida aqui de propósito: o rodapé da 20260719120000 trazia uma query que INVOCAVA a
-- função e mentia de duas formas (NULL sem cast ⇒ "does not exist"; falta de EXECUTE ⇒
-- "permission denied" — que era o REVOKE funcionando). database.md, §validação pós-apply.
-- ════════════════════════════════════════════════════════════════════════════════════════════
