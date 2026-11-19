-- ============================================================
-- pedido_sugerido_evento — trilha de quem REMOVEU itens e de cada APROVAÇÃO RECUSADA
--
-- Por quê (2026-11-18, pedidos 4493/4497): 7 itens do 4497 saíram por "Remover 7 itens" na
-- tela e o banco não guardou nada — só a telemetria do cliente (PostHog) contou a história.
-- E as aprovações recusadas pelo RPC ({error} no jsonb) não deixavam rastro algum no servidor:
-- "não aprovou" e "nunca clicou" eram indistinguíveis.
--
-- O que muda:
--   1. tabela append-only `pedido_sugerido_evento`, SEM FK para o pedido — de propósito: o motor
--      APAGA os pendentes ao regerar, e a trilha tem de sobreviver ao pedido que descreve;
--   2. gravador único `private.registrar_evento_pedido_sugerido` (SECURITY DEFINER): ninguém
--      escreve na tabela por PostgREST; só por ele, que carimba auth.uid() do servidor;
--   3. `remover_itens_pedido_sugerido` grava o SNAPSHOT dos itens apagados na MESMA transação
--      (falhou o registro → a remoção inteira volta: não há remoção sem trilha);
--   4. o wrapper `aprovar_pedido_sugerido(bigint,text)` — o que a tela chama — registra a
--      recusa que a versão de 3 argumentos devolve. O corpo de 3 argumentos (money-path, selo)
--      NÃO é tocado.
--
-- Aplicar com `bun run db:aplicar` (a transação é do executor — sem BEGIN/COMMIT aqui).
-- Molde TRAVA → PRE → CREATE → PÓS (.claude/skills/lovable-db-operator/references/sql-house-style.md).
-- Prova: db/test-pedido-sugerido-evento.sh
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito nos dois objetos vivos que este arquivo recria.
-- COST (não VOLATILE): a PÓS confere o corpo, e o CREATE OR REPLACE reaplica o custo default.
DO $trava$
BEGIN
  IF to_regprocedure('public.remover_itens_pedido_sugerido(bigint,bigint[],text)') IS NOT NULL THEN
    ALTER FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint[], text) COST 100;
  END IF;
  IF to_regprocedure('public.aprovar_pedido_sugerido(bigint,text)') IS NOT NULL THEN
    ALTER FUNCTION public.aprovar_pedido_sugerido(bigint, text) COST 100;
  END IF;
END
$trava$;

-- PRE: o corpo vivo de cada função é o predecessor revisado (lido da PROD em 2026-11-19) ou
-- este arquivo (re-aplicação). Qualquer outra coisa = alguém mudou depois do pré-voo → ABORTA.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('remover_itens_pedido_sugerido(bigint,bigint[],text)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public.remover_itens_pedido_sugerido(bigint,bigint[],text)')),
         '2c34777763a45e0ce5e87188b460dd4e', 'd74204f18510722a2d1a1ede120b7fff'),
        ('aprovar_pedido_sugerido(bigint,text)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public.aprovar_pedido_sugerido(bigint,text)')),
         'dd87b376da51b2d1603e8ade8c28b3a8', 'f0163119eef31848c34bf7e145899cca')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ── 1. Tabela ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pedido_sugerido_evento (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id  bigint NOT NULL,           -- SEM FK: sobrevive à regeração que apaga o pedido
  evento     text   NOT NULL CHECK (evento IN ('itens_removidos', 'aprovacao_recusada')),
  usuario    text,                      -- o p_usuario que a tela mandou (e-mail)
  auth_uid   uuid,                      -- o que o SERVIDOR viu (NULL = service/cron)
  detalhe    jsonb  NOT NULL DEFAULT '{}'::jsonb,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedido_sugerido_evento_pedido
  ON public.pedido_sugerido_evento (pedido_id, criado_em);

ALTER TABLE public.pedido_sugerido_evento ENABLE ROW LEVEL SECURITY;

-- Leitura: quem tem capacidade de compras (o mesmo gate das RPCs de pedido).
DROP POLICY IF EXISTS "pedido_sugerido_evento_select_compras" ON public.pedido_sugerido_evento;
CREATE POLICY "pedido_sugerido_evento_select_compras"
  ON public.pedido_sugerido_evento
  FOR SELECT
  TO authenticated
  USING (private.cap_compras_ler(auth.uid()));

-- Escrita: NINGUÉM por PostgREST. Sem policy de INSERT/UPDATE/DELETE a RLS já barra, e o
-- REVOKE tira também o privilégio de tabela (as duas pontas, nomeando as roles).
REVOKE ALL ON public.pedido_sugerido_evento FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.pedido_sugerido_evento TO authenticated;
GRANT SELECT, INSERT ON public.pedido_sugerido_evento TO service_role;  -- append-only também aqui
-- A sequence da identity tem ACL PRÓPRIA (o REVOKE da tabela não a alcança) e, neste projeto,
-- sequence criada em public nasce com ALL para anon/authenticated: mexer no contador colide PK
-- e trava toda remoção (achado Codex).
REVOKE ALL ON SEQUENCE public.pedido_sugerido_evento_id_seq FROM PUBLIC, anon, authenticated;

-- ── 2. Gravador único ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.registrar_evento_pedido_sugerido(
  p_pedido_id bigint,
  p_evento    text,
  p_usuario   text,
  p_detalhe   jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Mesmo gate das RPCs que o chamam: só compras (ou service/cron, auth.uid() NULL).
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.pedido_sugerido_evento (pedido_id, evento, usuario, auth_uid, detalhe)
  VALUES (p_pedido_id, p_evento, p_usuario, auth.uid(), COALESCE(p_detalhe, '{}'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION private.registrar_evento_pedido_sugerido(bigint, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.registrar_evento_pedido_sugerido(bigint, text, text, jsonb) TO authenticated, service_role;

-- ── 3. remover_itens_pedido_sugerido: mesmo corpo + snapshot do que foi apagado ──
CREATE OR REPLACE FUNCTION public.remover_itens_pedido_sugerido(p_pedido_id bigint, p_item_ids bigint[], p_usuario text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status    text;
  v_removidos bigint[];
  v_snapshot  jsonb;
  v_restantes integer;
  v_total     numeric;
  v_cancelou  boolean := false;
BEGIN
  IF p_item_ids IS NULL OR cardinality(p_item_ids) = 0 THEN
    RETURN jsonb_build_object('error', 'nenhum item informado');
  END IF;

  -- (0) GATE na entrada (20261120120000, achado Codex): a RPC é INVOKER e a RLS do PAI deixa
  -- qualquer employee ler/atualizar o pedido, mas a dos ITENS exige capacidade de compras.
  -- Sem este gate, um employee sem a capacidade via 0 itens → o DELETE apagava 0 → count 0 →
  -- o pedido era carimbado `cancelado_humano` com os itens ainda lá.
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;

  -- (1) TRAVA O PAI ANTES DE QUALQUER ESCRITA. Esta é a linha que faz o guard valer:
  -- em READ COMMITTED, se o disparador/aprovador já segura a linha, este SELECT ESPERA o
  -- commit dele e relê a versão NOVA (EvalPlanQual) — então `v_status` abaixo é o status
  -- REAL, não um retrato. E o lock é mantido até o fim da transação, de modo que a decisão
  -- tomada sobre ele continua verdadeira enquanto as escritas acontecem.
  -- ⚠️ Não troque por um SELECT sem lock nem mova esta leitura para depois do DELETE:
  -- as duas coisas reabrem exatamente o [P1] que esta migration fecha.
  SELECT s.status INTO v_status
    FROM pedido_compra_sugerido s
   WHERE s.id = p_pedido_id
     FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido não encontrado');
  END IF;

  -- (2) ALLOWLIST — a regra do cliente virando política de servidor. Ver o cabeçalho:
  -- `aprovado_aguardando_disparo` fica DE FORA de propósito (é o estado que o disparador pega).
  IF v_status NOT IN ('pendente_aprovacao', 'bloqueado_guardrail') THEN
    -- COALESCE porque `'texto' || NULL` colapsa a STRING INTEIRA para NULL: sem ele, se o
    -- NOT NULL de `status` algum dia cair, a recusa viraria {"error": null} e o front leria
    -- "sem erro" — a recusa SUMIRIA da tela. Mesma lição da 20260905224959.
    RETURN jsonb_build_object(
      'error', 'pedido não permite remoção de itens (status atual: ' || COALESCE(v_status, '(desconhecido)') || ')'
    );
  END IF;

  -- ⚠️ DAQUI PARA BAIXO JÁ HÁ ESCRITA. Toda falha vira RAISE (rollback da transação inteira),
  -- NUNCA `RETURN jsonb_build_object('error', …)`: devolver JSON de erro depois de um DELETE
  -- não desfaz o DELETE — o PostgREST commita a transação que termina sem erro SQL, e o
  -- operador veria "falhou" com os itens já apagados (achado Codex).

  -- (3) O DELETE é preso ao pedido JÁ TRAVADO. O `pedido_id = p_pedido_id` não é redundante:
  -- é ele que impede que um id de item de OUTRO pedido (que não passou pelo guard acima)
  -- seja apagado de carona. O RETURNING leva o SNAPSHOT do que saiu (20261120120000):
  -- é a trilha que faltou no 4497.
  WITH apagados AS (
    DELETE FROM pedido_compra_item
     WHERE pedido_id = p_pedido_id
       AND id = ANY(p_item_ids)
    RETURNING id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario
  )
  SELECT array_agg(id ORDER BY id),
         jsonb_agg(jsonb_build_object(
           'id', id,
           'sku_codigo_omie', sku_codigo_omie,
           'sku_descricao', sku_descricao,
           'qtde_sugerida', qtde_sugerida,
           'qtde_final', qtde_final,
           'preco_unitario', preco_unitario
         ) ORDER BY id)
    INTO v_removidos, v_snapshot
    FROM apagados;

  -- Nada apagado (ids de outro pedido, ou itens invisíveis à RLS) = nada a recalcular e,
  -- sobretudo, NADA a cancelar: o DELETE de 0 linhas não escreveu, então devolver {error}
  -- aqui é seguro (não há escrita a desfazer). Antes seguia e podia carimbar cancelado.
  IF COALESCE(cardinality(v_removidos), 0) = 0 THEN
    RETURN jsonb_build_object('error', 'nenhum dos itens informados foi removido (não pertencem a este pedido ou já saíram)');
  END IF;

  -- (4) RECÁLCULO A PARTIR DO BANCO, não do retrato do browser. O total que o front somava
  -- vinha de um SELECT anterior ao DELETE: com dois removedores concorrentes, cada um contava
  -- o item que o outro ainda não tinha commitado e ambos gravavam um total errado. Somar aqui,
  -- sob o lock do pai, elimina isso.
  SELECT count(*)::integer,
         COALESCE(SUM(COALESCE(qtde_final, qtde_sugerida, 0) * COALESCE(preco_unitario, 0)), 0)
    INTO v_restantes, v_total
    FROM pedido_compra_item
   WHERE pedido_id = p_pedido_id;

  -- (5) O recálculo NÃO é condicional ao cancelamento: `valor_total`/`num_skus` são derivados
  -- legítimos e são gravados nos DOIS ramos. O que o guard condiciona é o CARIMBO DE STATUS.
  IF v_restantes = 0 THEN
    UPDATE pedido_compra_sugerido
       SET valor_total = 0,
           num_skus = 0,
           status = 'cancelado_humano',
           cancelado_por = p_usuario,
           cancelado_em = NOW(),
           justificativa_cancelamento = 'Todos os itens foram removidos manualmente',
           status_envio_portal = 'nao_aplicavel',  -- higiene do portal (20260530210001)
           portal_proximo_retry_em = NULL,         -- e cancela qualquer retry agendado
           atualizado_em = NOW()
     WHERE id = p_pedido_id;
    v_cancelou := true;
  ELSE
    UPDATE pedido_compra_sugerido
       SET valor_total = v_total,
           num_skus = v_restantes,
           atualizado_em = NOW()
     WHERE id = p_pedido_id;
  END IF;

  -- UPDATE que pega ZERO linhas não é sucesso (achado Codex): sob RLS, um chamador que
  -- enxerga a linha no SELECT pode não poder atualizá-la. Sem este assert a função devolveria
  -- 'ok' com os itens apagados e o cabeçalho intacto — pior que a falha original.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remover_itens_pedido_sugerido: o UPDATE do pedido % nao pegou nenhuma linha (RLS de escrita?) -- itens ja apagados, abortando para nao deixar cabecalho divergente', p_pedido_id;
  END IF;

  -- (6) TRILHA, na MESMA transação: se o registro falhar, a remoção inteira volta. Só registra
  -- quando algo saiu de fato (ids de outro pedido não apagam nada e não viram evento).
  PERFORM private.registrar_evento_pedido_sugerido(
    p_pedido_id, 'itens_removidos', p_usuario,
    jsonb_build_object(
      'itens', v_snapshot,
      'status_antes', v_status,
      'restantes', v_restantes,
      'cancelado', v_cancelou
    )
  );

  RETURN jsonb_build_object(
    'status', 'ok',
    'pedido_id', p_pedido_id,
    'removidos', COALESCE(cardinality(v_removidos), 0),
    'restantes', v_restantes,
    'valor_total', v_total,
    'cancelado', v_cancelou
  );
END;
$function$;

-- ── 4. aprovar_pedido_sugerido(bigint,text): o wrapper da tela registra a recusa ──
CREATE OR REPLACE FUNCTION public.aprovar_pedido_sugerido(p_pedido_id bigint, p_usuario text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_res jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;
  v_res := public.aprovar_pedido_sugerido(p_pedido_id, p_usuario, NULL::jsonb);
  -- Recusa de NEGÓCIO volta como {error} (não exceção), então a transação commita: o evento
  -- fica. Exceção (selo, SA008) desfaz tudo, inclusive isto — e chega à tela como erro de
  -- transporte, que já é visível. 20261120120000: sem esta linha, recusa não deixava rastro.
  -- A trilha NÃO pode mudar a resposta (achado Codex): id NULL violaria o NOT NULL e a tela
  -- receberia 23502 no lugar da recusa. Por isso: pula o id NULL, e qualquer falha do registro
  -- vira WARNING no log do servidor — o evento falta, a recusa original chega intacta.
  -- (Na REMOÇÃO é o contrário, de propósito: lá sem trilha não há remoção.)
  IF v_res ? 'error' AND p_pedido_id IS NOT NULL THEN
    BEGIN
      PERFORM private.registrar_evento_pedido_sugerido(
        p_pedido_id, 'aprovacao_recusada', p_usuario,
        jsonb_build_object('erro', v_res -> 'error')
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'aprovar_pedido_sugerido: recusa do pedido % sem trilha (% %)', p_pedido_id, SQLSTATE, SQLERRM;
    END;
  END IF;
  RETURN v_res;
END;
$function$;

-- O CREATE OR REPLACE preserva o ACL; reafirmado aqui mesmo assim (anon fora, nomeado).
REVOKE ALL ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint[], text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) TO authenticated, service_role;

-- PÓS: o estado provado — corpos são ESTES, a tabela tem RLS e não aceita escrita do cliente,
-- o gravador é DEFINER e anon não executa nada disto.
DO $pos$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.remover_itens_pedido_sugerido(bigint,bigint[],text)'))
     IS DISTINCT FROM 'd74204f18510722a2d1a1ede120b7fff' THEN
    RAISE EXCEPTION 'POS FALHOU: remover_itens_pedido_sugerido não é o corpo deste arquivo';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.aprovar_pedido_sugerido(bigint,text)'))
     IS DISTINCT FROM 'f0163119eef31848c34bf7e145899cca' THEN
    RAISE EXCEPTION 'POS FALHOU: aprovar_pedido_sugerido(bigint,text) não é o corpo deste arquivo';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
           WHERE c.oid = to_regclass('public.pedido_sugerido_evento')) THEN
    RAISE EXCEPTION 'POS FALHOU: pedido_sugerido_evento sem RLS — trilha legível/gravável por qualquer um';
  END IF;
  IF has_table_privilege('authenticated', 'public.pedido_sugerido_evento', 'INSERT')
     OR has_table_privilege('authenticated', 'public.pedido_sugerido_evento', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pedido_sugerido_evento', 'DELETE') THEN
    RAISE EXCEPTION 'POS FALHOU: authenticated pode escrever na trilha direto (forjar/apagar evento)';
  END IF;
  IF has_sequence_privilege('authenticated', 'public.pedido_sugerido_evento_id_seq', 'UPDATE')
     OR has_sequence_privilege('anon', 'public.pedido_sugerido_evento_id_seq', 'UPDATE')
     OR has_table_privilege('service_role', 'public.pedido_sugerido_evento', 'DELETE') THEN
    RAISE EXCEPTION 'POS FALHOU: contador da trilha alterável pelo cliente, ou service_role apaga evento';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('private.registrar_evento_pedido_sugerido(bigint,text,text,jsonb)')) THEN
    RAISE EXCEPTION 'POS FALHOU: gravador não é SECURITY DEFINER — o INSERT cairia na RLS e a remoção abortaria';
  END IF;
  IF has_function_privilege('anon', 'private.registrar_evento_pedido_sugerido(bigint,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.remover_itens_pedido_sugerido(bigint,bigint[],text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.aprovar_pedido_sugerido(bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: anon executa função de pedido';
  END IF;
  IF NOT has_function_privilege('authenticated', 'private.registrar_evento_pedido_sugerido(bigint,text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: authenticated não executa o gravador — remover/aprovar (INVOKER) quebrariam';
  END IF;
END
$pos$;
