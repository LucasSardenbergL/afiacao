-- ============================================================================================
-- deploy_sonda: o `request_id` do pg_net é RECICLADO — a identidade de um disparo é
-- (request_id, tick_id), não o request_id sozinho.
--
-- INCIDENTE (2026-11-26): a sequência de `net._http_response.id` reinicia (136392→4, 1193→3,
-- 2183→1, 36397→2 entre 2026-10-29 e 2026-11-25). Com a PK de `deploy_sonda_disparos` só em
-- `request_id`, o `INSERT … WHERE NOT EXISTS (request_id = v_req)` do dispatcher PULA EM SILÊNCIO
-- todo disparo cujo id já foi usado por um disparo antigo: o post sai, a função devolve a linha,
-- e a atribuição não é gravada. Em 2026-11-26 21:30Z o contador estava em ~1629 e já havia 284
-- disparos antigos com id entre 1672 e 3000 — o próximo ciclo do cron cegaria a sonda por cron
-- (o ledger para de atestar → `pendencias:deploy` acusa → o vigia RETÉM o Publish).
-- O gêmeo no leitor (scripts/pendencias-deploy.ts) foi corrigido em #4207.
--
-- 2º defeito, mesma família (o id/resposta some): o pg_net retém respostas ~6 h, e o coletor
-- reprocessa 48 h. Quando a resposta é purgada, o LEFT JOIN vem NULL e o `ON CONFLICT DO UPDATE`
-- REBAIXAVA o resultado já colhido para "sem resposta" (346/383 resultados de 48 h estavam NULL).
-- Ausente ≠ zero: resposta purgada não apaga o que foi observado.
--
-- O que muda:
--   1. `deploy_sonda_disparos`  PK (request_id)  → PK (request_id, tick_id)
--   2. `deploy_sonda_resultados` PK (request_id) → PK (request_id, tick_id)
--   3. `deploy_sonda_disparar`: INSERT sem o `NOT EXISTS` (tick é novo a cada chamada — colisão
--      de (request_id, tick_id) é impossível; se acontecer, ERRO alto, nunca pulo silencioso).
--   4. `deploy_sonda_resultados_colher`: casa a resposta com o disparo MAIS RECENTE com aquele id
--      enfileirado até o `created` da resposta; ON CONFLICT na chave nova; nunca rebaixa resultado
--      colhido para NULL.
-- Corpo das funções = corpo de PROD (pg_get_functiondef em 2026-11-26) + só as mudanças acima.
-- `CREATE OR REPLACE` preserva o ACL; a postcondição confere que nenhum role novo ganhou EXECUTE.
-- Aplicar com `bun run db:aplicar` (o executor dá a transação — este arquivo não leva BEGIN).
-- ============================================================================================

-- 1+2. PKs pela identidade verdadeira. Idempotente: só troca se a PK atual não for a nova.
DO $pk$
DECLARE
  v_tab text;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY['deploy_sonda_disparos', 'deploy_sonda_resultados'] LOOP
    IF (SELECT pg_get_constraintdef(c.oid)
          FROM pg_constraint c
         WHERE c.conrelid = format('public.%I', v_tab)::regclass AND c.contype = 'p')
       IS DISTINCT FROM 'PRIMARY KEY (request_id, tick_id)' THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_tab, v_tab || '_pkey');
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (request_id, tick_id)',
                     v_tab, v_tab || '_pkey');
    END IF;
  END LOOP;
END
$pk$;

-- 3. O dispatcher.
CREATE OR REPLACE FUNCTION public.deploy_sonda_disparar(p_alvos text[] DEFAULT NULL::text[])
 RETURNS TABLE(tick_id uuid, edge text, request_id bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_tick    uuid := gen_random_uuid();
  v_secret  text;
  v_n       integer;
  v_edge    text;
  v_req     bigint;
BEGIN
  -- O segredo do CRON tem de ser ÚNICO e não-vazio. Duas linhas com o mesmo nome tornariam o
  -- `SELECT INTO` arbitrário — o dispatcher passaria a autenticar com um valor que ninguém escolheu,
  -- e o sintoma seria 401 no relé, intermitente e inexplicável. Zero linhas é o caso trivial.
  SELECT count(*), max(s.decrypted_secret) INTO v_n, v_secret
  FROM vault.decrypted_secrets s
  WHERE s.name = 'CRON_SECRET'
    AND s.decrypted_secret IS NOT NULL
    AND s.decrypted_secret <> '';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'deploy_sonda_disparar: esperava EXATAMENTE 1 CRON_SECRET nao vazio no vault, achei % — nenhum disparo feito', v_n;
  END IF;

  FOR v_edge IN
    SELECT a.edge
    FROM public.deploy_sonda_alvos a
    WHERE a.ativo
      AND (p_alvos IS NULL OR a.edge = ANY (p_alvos))
    ORDER BY a.edge
  LOOP
    -- Headers: SÓ o que o relé precisa. Nenhuma credencial de sonda sai daqui — quem a deriva é o
    -- relé, a partir de `SONDA_HMAC_KEY`, que vive só nos secrets das edges e o banco nem conhece.
    SELECT net.http_post(
             url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sonda-relay',
             headers := jsonb_build_object(
               'Content-Type', 'application/json',
               'x-cron-secret', v_secret),
             body := jsonb_build_object('alvo', v_edge, 'tick', v_tick::text),
             timeout_milliseconds := 20000)
      INTO v_req;

    -- MESMA transação do post: o pg_net só envia após o COMMIT, então não existe janela em que a
    -- resposta chegue sem a linha de atribuição já estar aqui.
    --
    -- ⚠️ SEM filtro de existência por request_id: o pg_net RECICLA o id (a sequência reinicia),
    -- e aquele filtro pulava EM SILÊNCIO o disparo novo que colidisse com um antigo. A identidade
    -- é (request_id, tick_id), e o tick é novo a cada chamada — colisão aqui é impossível; se
    -- acontecer, o INSERT falha ALTO e derruba a leva, nunca a grava pela metade.
    INSERT INTO public.deploy_sonda_disparos (request_id, tick_id, edge)
    VALUES (v_req, v_tick, v_edge);

    tick_id := v_tick;
    edge := v_edge;
    request_id := v_req;
    RETURN NEXT;
  END LOOP;
END
$function$;

-- 4. O coletor.
CREATE OR REPLACE FUNCTION public.deploy_sonda_resultados_colher()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_n integer;
BEGIN
  -- A resposta pertence ao disparo MAIS RECENTE com aquele id enfileirado até o `created` dela:
  -- o pg_net recicla o id, e um disparo de antes do reinício casaria com a resposta de outro.
  WITH candidatos AS (
    SELECT d.request_id, d.tick_id, d.edge,
           r.status_code, r.created,
           CASE WHEN r.content IS NOT NULL
                     AND left(ltrim(r.content), 1) = '{'
                     AND r.content IS JSON OBJECT
                THEN r.content::jsonb END AS c
    FROM public.deploy_sonda_disparos d
    LEFT JOIN net._http_response r
           ON r.id = d.request_id
          AND r.created >= d.enfileirado_em
          AND NOT EXISTS (
                SELECT 1 FROM public.deploy_sonda_disparos d2
                 WHERE d2.request_id = d.request_id
                   AND d2.enfileirado_em > d.enfileirado_em
                   AND d2.enfileirado_em <= r.created)
    WHERE d.enfileirado_em > now() - interval '48 hours'
  ), classificados AS (
    SELECT request_id, tick_id, edge, status_code, created,
           CASE
             WHEN c IS NULL THEN NULL
             WHEN (c -> 'probe') = to_jsonb(true) AND jsonb_typeof(c -> 'edge') = 'string' THEN 'atestou'
             WHEN jsonb_typeof(c -> 'classe') = 'string' THEN c ->> 'classe'
             ELSE 'sem-corpo-reconhecido'
           END AS classe
    FROM candidatos
  )
  INSERT INTO public.deploy_sonda_resultados (request_id, tick_id, edge, status_code, classe, observado_em)
  SELECT request_id, tick_id, edge, status_code, classe, created
  FROM classificados
  ON CONFLICT (request_id, tick_id) DO UPDATE
    SET status_code = EXCLUDED.status_code,
        classe = EXCLUDED.classe,
        observado_em = EXCLUDED.observado_em,
        colhido_em = now()
    -- Resposta purgada pelo pg_net (~6 h) chega aqui como NULL: NÃO rebaixa o que já foi colhido.
    WHERE EXCLUDED.status_code IS NOT NULL
      AND (public.deploy_sonda_resultados.classe IS DISTINCT FROM EXCLUDED.classe
        OR public.deploy_sonda_resultados.status_code IS DISTINCT FROM EXCLUDED.status_code);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;

-- Postcondição: aborta a transação inteira se qualquer peça não pegou.
DO $post$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.deploy_sonda_disparos'::regclass AND c.contype = 'p')
     IS DISTINCT FROM 'PRIMARY KEY (request_id, tick_id)' THEN
    RAISE EXCEPTION 'POS FALHOU: PK de deploy_sonda_disparos nao e (request_id, tick_id)';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.deploy_sonda_resultados'::regclass AND c.contype = 'p')
     IS DISTINCT FROM 'PRIMARY KEY (request_id, tick_id)' THEN
    RAISE EXCEPTION 'POS FALHOU: PK de deploy_sonda_resultados nao e (request_id, tick_id)';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.deploy_sonda_disparar(text[])'::regprocedure)
     LIKE '%WHERE NOT EXISTS%' THEN
    RAISE EXCEPTION 'POS FALHOU: deploy_sonda_disparar ainda tem o NOT EXISTS que pula id reciclado';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.deploy_sonda_resultados_colher()'::regprocedure)
     NOT LIKE '%ON CONFLICT (request_id, tick_id)%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.deploy_sonda_resultados_colher()'::regprocedure)
     NOT LIKE '%EXCLUDED.status_code IS NOT NULL%' THEN
    RAISE EXCEPTION 'POS FALHOU: deploy_sonda_resultados_colher nao tem a chave nova ou a trava de rebaixamento';
  END IF;
  IF has_function_privilege('anon', 'public.deploy_sonda_disparar(text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deploy_sonda_disparar(text[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.deploy_sonda_resultados_colher()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deploy_sonda_resultados_colher()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: funcao de sonda ficou executavel por anon/authenticated';
  END IF;
  RAISE NOTICE 'POS OK: deploy_sonda com identidade (request_id, tick_id)';
END
$post$;
