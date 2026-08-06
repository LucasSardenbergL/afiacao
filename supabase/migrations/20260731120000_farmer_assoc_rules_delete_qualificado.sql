-- ============================================================
-- farmer_association_rules_substituir — o DELETE ganha WHERE (destrava a RPC)
--
-- INCIDENTE: desde o deploy da edge com a RPC (entre 2026-07-27 07:30 e 2026-07-29
-- 06:00 UTC) TODA chamada morre com HTTP 500:
--     {"error":"farmer_association_rules_substituir: DELETE requires a WHERE clause"}
-- Medido em prod: `acoes_execucoes.analytics_sync.recalcular_regras` = sucesso ×10 até
-- 2026-07-27 07:30:12, erro ×2 depois (06:00 via sync_all, 07:30 via o cron dedicado).
-- As 24 regras vigentes estão CONGELADAS desde 27/07 — e têm 24 `created_at` DISTINTOS,
-- prova de que vieram de 24 transações (o caminho ANTIGO, INSERT por regra): a RPC
-- atômica nunca chegou a gravar uma vez sequer em produção.
--
-- CAUSA RAIZ: o Supabase pré-carrega o módulo `safeupdate` na sessão do role que o
-- PostgREST usa —  `authenticator` tem `session_preload_libraries=safeupdate` (conferido
-- em `pg_roles.rolconfig`). O módulo instala um **post_parse_analyze_hook** que recusa
-- todo DELETE/UPDATE cuja árvore de PARSE tenha `jointree->quals == NULL`, com
-- ERRCODE 21000 (cardinality_violation).
--
-- As duas consequências que tornam o bug invisível aos gates existentes:
--   1. o hook é de SESSÃO, não de role: `SECURITY DEFINER` troca o ROLE, não o hook —
--      logo o DELETE lá DENTRO da função também é recusado;
--   2. o hook roda no PARSE, antes do planner — então não há plano, EXPLAIN nem RLS
--      envolvidos, e o harness PG17 (psql como superuser, sem o módulo) fica VERDE
--      enquanto a produção está 100% quebrada.
--
-- CONSERTO: `WHERE true`. Basta o `quals` existir na árvore de parse; o planner dobra a
-- constante fora em seguida, então o PLANO é idêntico ao do DELETE sem WHERE (medido:
-- `Delete on ... -> Seq Scan on ...`, sem nó de filtro). Custo zero, semântica idêntica.
--
-- FORMA: substituição programática sobre o corpo VIVO (padrão do repo p/ mudança de 1
-- linha), não recópia do corpo — assim qualquer hardening que outra worktree aplique
-- nesta função na janela até o founder colar é PRESERVADO, em vez de revertido.
-- Detecção e verificação rodam sobre a definição SEM COMENTÁRIOS: o comentário que esta
-- própria migration injeta cita a forma do bug, e mediria a si mesmo.
-- ============================================================

DO $mig$
DECLARE
  v_oid       oid;
  v_def       text;
  v_def_nu    text;   -- "nu" = sem comentários
  v_novo      text;
  c_antigo    constant text := 'DELETE FROM public.farmer_association_rules;';
  c_novo      constant text := 'DELETE FROM public.farmer_association_rules WHERE true;';
BEGIN
  -- GUARD 1 — a função tem que existir (to_regprocedure devolve NULL, não levanta erro)
  v_oid := to_regprocedure('public.farmer_association_rules_substituir(jsonb)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'farmer_association_rules_substituir(jsonb) não existe — aplique 20260729120000 primeiro';
  END IF;

  v_def    := pg_get_functiondef(v_oid);
  v_def_nu := regexp_replace(v_def, '--[^\n]*', '', 'g');

  -- IDEMPOTÊNCIA — já corrigida? sai sem tocar em nada.
  IF position(c_novo in v_def_nu) > 0 THEN
    RAISE NOTICE 'DELETE já qualificado — migration é no-op';
    RETURN;
  END IF;

  -- GUARD 2 — o padrão tem que casar. Se o corpo divergiu, ABORTA em vez de
  -- "aplicar" sem mudar nada (falha silenciosa exatamente onde não se pode ter uma).
  IF position(c_antigo in v_def_nu) = 0 THEN
    RAISE EXCEPTION 'padrão do DELETE não encontrado no corpo vivo — revise à mão antes de aplicar';
  END IF;

  v_novo := replace(
    v_def,
    c_antigo,
    -- O comentário mora AQUI de propósito: é onde bate a tentação de "limpar" o
    -- `WHERE true` achando que é redundante. Ele não é.
    '-- ⚠️ `WHERE true` NÃO é decoração — é o que mantém esta função CHAMÁVEL.' || E'\n' ||
    '  --    O Supabase pré-carrega o módulo `safeupdate` na sessão do `authenticator`' || E'\n' ||
    '  --    (o role do PostgREST). O post_parse_analyze_hook dele RECUSA, com ERRCODE' || E'\n' ||
    '  --    21000, todo DELETE/UPDATE cujo `jointree->quals` seja NULL na árvore de' || E'\n' ||
    '  --    PARSE — inclusive dentro de plpgsql SECURITY DEFINER, porque o DEFINER' || E'\n' ||
    '  --    troca o ROLE e não o hook, que é de SESSÃO. Sem o WHERE, toda chamada via' || E'\n' ||
    '  --    PostgREST morre com "DELETE requires a WHERE clause" (incidente 2026-07-29).' || E'\n' ||
    '  --    O planner dobra o `true` fora: o plano é o mesmo do DELETE sem WHERE.' || E'\n' ||
    '  ' || c_novo
  );

  -- GUARD 3 — replace no-op não pode passar por sucesso
  IF v_novo = v_def THEN
    RAISE EXCEPTION 'replace foi no-op — nada seria alterado';
  END IF;

  EXECUTE v_novo;

  -- GUARD 4 — sobra do padrão antigo (medido sem comentários: o texto que acabei de
  -- injetar fala do bug e casaria a si mesmo num `position` sobre a def crua)
  IF position(c_antigo in regexp_replace(pg_get_functiondef(v_oid), '--[^\n]*', '', 'g')) > 0 THEN
    RAISE EXCEPTION 'o DELETE sem WHERE sobreviveu ao replace';
  END IF;

  RAISE NOTICE 'farmer_association_rules_substituir: DELETE qualificado com WHERE true';
END
$mig$;
