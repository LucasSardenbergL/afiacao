-- 20260830204210_captura_authz_escopo_carteira_farmer.sql
-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  CAPTURA (não mudança) — o corpo VIVO em prod de                             ║
-- ║  farmer_recomendacoes_substituir e farmer_bundle_recomendacoes_substituir.    ║
-- ║  Só o VIVO tem o guard de ESCOPO DE CARTEIRA. Sem ele, um farmer grava       ║
-- ║  recomendação para cliente de OUTRO farmer — e é o repo que não tem.         ║
-- ║                                                                              ║
-- ║  Origem: docs/historico/deriva-de-corpo-prod-a-frente-do-repo.md (pendência  ║
-- ║  nº 1). Irmã de 20260830204209 (as 3 RPCs de preço); separadas porque os     ║
-- ║  domínios e as dependências são disjuntos — cada uma aplica e se prova só.   ║
-- ║                                                                              ║
-- ║  ── O QUE SÓ EXISTE VIVO (última def no repo: 20260815181500) ────────────── ║
-- ║  1. `PERFORM 1 … FOR SHARE` sobre farmer_client_scores — o LOCK CAUSAL do    ║
-- ║     lote. **`FOR SHARE` não aparece em NENHUMA migration deste repo.**       ║
-- ║  2. `SELECT count(*) INTO v_fora_escopo … WHERE s.farmer_id IS DISTINCT      ║
-- ║     FROM p_farmer_id` + `RAISE EXCEPTION … USING ERRCODE = 'FG009'`.         ║
-- ║  3. A variável `v_fora_escopo` no DECLARE.                                   ║
-- ║  O raciocínio completo — por que FOR SHARE e não FOR KEY SHARE, a janela     ║
-- ║  T1/T2 entre este guard e a trigger de troca de dono, por que FG009 e não    ║
-- ║  FG008 — está preservado nos comentários do próprio corpo, abaixo. É o       ║
-- ║  melhor registro que existe desse desenho: não reescreva, não resuma.        ║
-- ║                                                                              ║
-- ║  Medido antes de escrever (diff por TOKEN, stripper compartilhado            ║
-- ║  removerComentariosSql): o vivo SÓ ACRESCENTA. As únicas remoções são do     ║
-- ║  renderizador (`NULL`→`NULL::text` nos DEFAULT, `SECURITY INVOKER` que é o   ║
-- ║  default e o pg_get_functiondef omite). Nenhuma remoção semântica.           ║
-- ║                                                                              ║
-- ║  ⚠️ Estas duas são SECURITY INVOKER, de propósito — quem autoriza é a RLS.   ║
-- ║  O `SET search_path TO 'public','pg_temp'` é reafirmado em cada CREATE OR    ║
-- ║  REPLACE (omitir RESETARIA a opção).                                         ║
-- ║                                                                              ║
-- ║  ⚠️ APLICAR É NO-OP SEMÂNTICO EM PROD — recria com o texto que JÁ roda       ║
-- ║  (pg_get_functiondef via psql-ro, 2026-08-30). Prova: o md5 do functiondef   ║
-- ║  pós-apply tem de ser IDÊNTICO ao de antes (query no rodapé).                ║
-- ║                                                                              ║
-- ║  Prova de execução (PL/pgSQL é late-bound — CREATE passar não prova nada):   ║
-- ║  db/test-farmer-escopo-carteira.sh, que aplica ESTE arquivo e falsifica.     ║
-- ║                                                                              ║
-- ║  ⚠️ MIGRATION MANUAL — Lovable não auto-aplica nome custom. SQL Editor → Run.║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ── Guard de dependências — FAIL-CLOSED ──────────────────────────────────────
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'private' AND p.proname = 'cap_carteira_escrever') THEN
    RAISE EXCEPTION 'dep ausente: private.cap_carteira_escrever — gate de escrita destas 2 RPCs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'farmer_client_scores') THEN
    RAISE EXCEPTION 'dep ausente: public.farmer_client_scores — o guard FG009 trava (FOR SHARE) e conta nela';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uid' AND pronamespace = 'auth'::regnamespace) THEN
    RAISE EXCEPTION 'dep ausente: auth.uid';
  END IF;

  -- AVISO, não bloqueio: `SELECT … FOR SHARE` exige UPDATE/DELETE além de SELECT para
  -- travar linha, e estas RPCs são SECURITY INVOKER — quem trava é o `authenticated` do
  -- farmer, não o owner. Um endurecimento futuro plausível ("authenticated não escreve em
  -- farmer_client_scores, revoga UPDATE") derruba a RPC em RUNTIME, no caminho FELIZ, com
  -- 42501. Medido em prod 2026-08-30: relacl = authenticated=arwdDxtm, então hoje passa.
  -- Não é EXCEPTION porque o estado é o mesmo antes e depois desta migration — bloquear a
  -- captura não consertaria nada, só deixaria o repo desalinhado por mais tempo.
  -- Provado por db/test-farmer-escopo-carteira.sh (assert PRIV1).
  IF NOT has_table_privilege('authenticated', 'public.farmer_client_scores', 'UPDATE') THEN
    RAISE WARNING 'authenticated NÃO tem UPDATE em public.farmer_client_scores — o FOR SHARE do guard de escopo vai falhar com 42501 em runtime para o farmer. Investigue ANTES de considerar isto no ar.';
  END IF;
END
$guard$;

-- ── farmer_recomendacoes_substituir — guard de escopo FG009 + FOR SHARE ──
-- Corpo VERBATIM da PROD (pg_get_functiondef, 2026-08-30). Não reescrever à mão.
CREATE OR REPLACE FUNCTION public.farmer_recomendacoes_substituir(p_farmer_id uuid, p_run_id uuid, p_geracao_vista uuid, p_linhas jsonb, p_completude text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_insumos jsonb DEFAULT NULL::jsonb, p_head_visto uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total          integer;
  v_invalidas      integer;
  v_fora_escopo        integer;
  v_geracao_atual  uuid;
  v_expiradas      integer;
  v_inseridas      integer;
  v_head_atual     uuid;
BEGIN
  -- 1) Gate de MENSAGEM (a RLS é quem autoriza — ver cabeçalho).
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  -- ⚠️ `IS NOT TRUE`, não `NOT (...)`. Numa sessão SEM JWT (pg_cron, psql) `auth.uid()`
  -- devolve NULL, então `p_farmer_id = auth.uid()` é NULL e a disjunção inteira vira
  -- NULL — e `IF NOT NULL THEN` NÃO dispara em PL/pgSQL. Medido em prod:
  --   NOT (false OR NULL OR false)          => NULL   (o RAISE nunca acontece)
  --   (false OR NULL OR false) IS NOT TRUE  => true   (barra, como se quer)
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  -- 2) FORMATO.
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  -- 3) LOTE VAZIO = RECUSA, não "expira tudo e deixa o farmer sem oferta".
  -- Zero recomendação quase sempre é dado faltando a montante (catálogo, scores,
  -- get_skus_margem_positiva), não "este farmer não tem o que oferecer" — mesmo
  -- raciocínio que farmer_association_rules_substituir aplica ao lote vazio.
  -- ⚠️ Isto SEGUE valendo depois do head: quem tem geração legitimamente vazia
  -- chama `farmer_geracao_registrar` (que move o head e não toca em linha nenhuma),
  -- e não esta função. Afrouxar aqui religaria a expiração — que está FORA do escopo
  -- desta fase por decisão explícita.
  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: as % recomendação(ões) pendentes deste farmer foram preservadas',
      (SELECT count(*) FROM public.farmer_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  -- Teto defensivo: a maior geração medida em prod tem ~1.000 linhas
  -- (3 cross + 2 up por cliente). 50k é ~50x isso — folga sem ficar ilimitado.
  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  -- 4) SERIALIZAÇÃO por FARMER (não global: duas vendedoras recalculando ao mesmo
  -- tempo mexem em escopos disjuntos e não têm por que esperar uma pela outra).
  -- `xact` = o lock sai sozinho no commit/rollback.
  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  -- 5) GUARD CAUSAL (compare-and-swap).
  -- O advisory lock acima só cobre a TRANSAÇÃO da RPC — ele não cobre a janela
  -- longa entre "o motor leu o snapshot" e "o motor chamou esta função". Sem este
  -- guard, dois recálculos sobrepostos terminam com o MAIS LENTO vencendo, e o
  -- mais lento é justamente o que leu o snapshot mais VELHO (money-path §10: o
  -- degradado terminar depois do saudável é o desfecho esperado, não o azar).
  -- NULL casa NULL: primeira execução, e as linhas legadas (run_id NULL).
  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  -- 6) VALIDAÇÃO ANTES DE MEXER (nada é expirado se o lote tem lixo).
  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    affinity_score          numeric
  )
  WHERE r.customer_user_id IS NULL
     OR r.product_id IS NULL
     OR r.recommendation_type IS NULL
     OR r.recommendation_type NOT IN ('cross_sell', 'up_sell')
     -- Finitude nos TRÊS lados. `>= 0` sozinho NÃO sanea: medido em prod,
     -- `'NaN' >= 0` é TRUE e `'Infinity' >= 0` é TRUE (money-path §2).
     OR r.affinity_score IS NULL
     OR NOT (
          r.affinity_score >= 0
          AND r.affinity_score < 'Infinity'::numeric
          AND r.affinity_score <> 'NaN'::numeric
        );

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % linha(s) inválidas (cliente/produto/tipo ausente, ou afinidade nula/negativa/NaN/Infinita) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;
  -- 6-bis) ESCOPO DE CARTEIRA — o cliente do lote precisa ser DESTE farmer.
  --
  -- `farmer_client_scores` tem UNIQUE (customer_user_id): o dono de um cliente é uma
  -- FUNÇÃO, computável aqui dentro. Até esta versão a RPC aceitava qualquer cliente e
  -- carimbava `p_farmer_id` por cima — foi por essa porta que o fallback do browser
  -- ("carteira vazia ⇒ carregue TODOS os scores") gravou 2.676 linhas com `farmer_id` ≠
  -- dono do cliente. Medido em prod (psql-ro, 21/08/2026): o lote de abril sob o farmer
  -- 33f59dc7 cobria 166 clientes e só 25,9% eram dele, contra os 18,8% da base que ele
  -- detém — a assinatura de quem sorteou da base inteira, não de quem leu a própria carteira.
  --
  -- O gate tinha que ser AQUI, não só no browser: o cliente não pode ser a autoridade
  -- sobre o próprio escopo (#1840 — o browser reescrevia as regras do servidor por cima).
  --
  -- E o dano SOBREVIVE ao conserto do browser porque a etapa 7 expira
  -- `WHERE farmer_id = p_farmer_id`: a linha do cliente C gravada sob A, quando o dono é B,
  -- é INVISÍVEL ao recálculo de B — o dono real recalcula e ela segue pendente, dando ao
  -- mesmo cliente duas gerações vivas ao mesmo tempo.
  --
  -- `IS DISTINCT FROM`, não `<>`: o cliente SEM linha de score precisa cair do MESMO lado.
  -- `<>` com NULL devolve NULL, o `WHERE` descarta, e o cliente de dono desconhecido passaria
  -- — exatamente o caso mais suspeito. Dono desconhecido é recusa, nunca "grave assim mesmo".
  --
  -- Isto é FAIL-CLOSED sob a RLS: a função é SECURITY INVOKER e `farmer_client_scores` só
  -- se deixa ler por `cap_carteira_ler(uid) OR carteira_visivel_para(cliente, uid)`. Se a RLS
  -- esconder do chamador a linha de um cliente alheio, o LEFT JOIN devolve NULL — e NULL é
  -- recusado. A cegueira da RLS vira RECUSA, não passagem.
  -- 6-ter) LOCK CAUSAL DO ESCOPO — a metade que a trigger de troca de dono NÃO cobre.
  -- O guard do #1850 compara o lote com o dono LIDO aqui; a trigger nova
  -- (private.farmer_expirar_pendentes_do_dono_anterior) expira o que já existia quando o
  -- dono muda. Nenhum dos dois cobre a janela ENTRE eles:
  --
  --   T1 (esta RPC, farmer A)          T2 (reatribuição do cliente C para B)
  --   ------------------------         -------------------------------------
  --   FG009 lê score de C = A
  --                                    UPDATE farmer_client_scores: C -> B
  --                                    trigger expira as pendentes de C que existiam
  --   INSERT da oferta C sob A         (a linha NOVA nasce depois da varredura)
  --   COMMIT                           COMMIT
  --
  -- A oferta nova sobrevive fora de escopo. O advisory lock do passo 4 não ajuda: ele é
  -- por FARMER, e quem reatribui não o toma. Travar as linhas de score do lote até o
  -- COMMIT resolve nos dois sentidos — se a troca chega antes, ela espera e a trigger
  -- alcança a linha nova; se chega depois, esta RPC já lê o dono novo e o FG009 recusa.
  --
  -- `FOR SHARE`, não `FOR KEY SHARE`: um UPDATE que não mexe em chave toma
  -- `FOR NO KEY UPDATE`, que NÃO conflita com `FOR KEY SHARE` — o lock mais fraco
  -- deixaria a corrida exatamente como estava, e o teste do caminho feliz seguiria verde.
  -- `FOR SHARE` conflita, e é compartilhado: duas vendedoras com lotes disjuntos não se
  -- esperam (só quem tenta REATRIBUIR espera).
  --
  -- O `ORDER BY` é best-effort contra deadlock (o PG não garante ordem de travamento sob
  -- ORDER BY). A garantia real é a ordem de RECURSOS, que esta fatia mantém única em todo
  -- o domínio: farmer_client_scores -> farmer_recommendations. A trigger segue a mesma
  -- ordem (é disparada POR um UPDATE em scores e só então toca recomendações), então não
  -- há ciclo a inverter.
  --
  -- Cliente do lote SEM linha de score não trava nada — não há linha. Não é buraco: o
  -- FG009 logo abaixo recusa o lote inteiro nesse caso (dono desconhecido é recusa).
  PERFORM 1
    FROM public.farmer_client_scores s
   WHERE s.customer_user_id IN (
           SELECT DISTINCT c.customer_user_id
             FROM jsonb_to_recordset(p_linhas) AS c(customer_user_id uuid)
            WHERE c.customer_user_id IS NOT NULL
         )
   ORDER BY s.customer_user_id
     FOR SHARE;

  SELECT count(*) INTO v_fora_escopo
  FROM jsonb_to_recordset(p_linhas) AS r(customer_user_id uuid)
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = r.customer_user_id
  WHERE s.farmer_id IS DISTINCT FROM p_farmer_id;

  -- FG009, não FG008: o 008 JÁ É de outra defesa deste mesmo domínio — a trigger que barra
  -- INSERT direto de pendente sem `run_id` (migration 20260814223445). Reusar o código
  -- tornaria dois erros distintos indistinguíveis pela SQLSTATE, que é justamente o que um
  -- chamador usa para decidir o que fazer. Verificado em prod: FG001–FG008 e FG101–FG107
  -- ocupados; 009 livre.
  IF v_fora_escopo > 0 THEN
    RAISE EXCEPTION '% de % linha(s) são de cliente fora da carteira deste farmer — nada foi expirado',
      v_fora_escopo, v_total USING ERRCODE = 'FG009';
  END IF;

  -- 7) A TROCA — os dois statements na MESMA transação.
  -- Só 'pendente' é tocado: linha com desfecho ('ofertado'/'aceito'/'rejeitado')
  -- é histórico e fica imutável. E é UPDATE, nunca DELETE.
  UPDATE public.farmer_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_recommendations (
    farmer_id, customer_user_id, recommendation_type, product_id, current_product_id,
    p_ij, m_ij, lie, affinity_score, complexity_factor, cluster_volume_estimate,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.recommendation_type, r.product_id, r.current_product_id,
    r.p_ij,
    -- m_ij e lie são DINHEIRO e saíram de cena no #1520 (o custo não chega mais ao
    -- browser). Fixados em NULL aqui, não copiados do payload: o cliente não tem
    -- como fabricá-los de volta.
    NULL, NULL,
    r.affinity_score, coalesce(r.complexity_factor, 1), coalesce(r.cluster_volume_estimate, 1),
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    current_product_id      uuid,
    p_ij                    numeric,
    affinity_score          numeric,
    complexity_factor       numeric,
    cluster_volume_estimate numeric
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  -- 8) O HEAD, na MESMA transação — com o head que o CHAMADOR viu ANTES do cálculo.
  --
  -- ⚠️ A 1ª versão lia o head AQUI DENTRO e o passava adiante, o que satisfazia o CAS por
  -- construção e abria a assimetria que o challenge Codex xhigh encontrou: um run VAZIO
  -- que commita entre a leitura e a escrita de um run COM LINHAS não é visto pelo CAS da
  -- etapa 5 (ele compara LINHAS, e o vazio não mexeu em linha nenhuma), então o run antigo
  -- sobrescrevia um vazio mais novo. O sistema misturava duas ordens: frescor causal para
  -- o vazio e ordem-de-commit para as linhas. Comparar o head ORIGINAL alinha as duas.
  --
  -- `p_completude IS NULL` é o marcador de chamador ANTERIOR ao sensor (assinatura de 4
  -- args, bundle velho em cache): ele não tem head para declarar, então cai no head
  -- corrente em vez de ser recusado por não saber de algo que não existia quando foi
  -- escrito. Os dois sinais de "cliente antigo" são o mesmo, de propósito.
  IF p_completude IS NULL THEN
    SELECT run_id INTO v_head_atual
    FROM public.farmer_geracao_vigente
    WHERE motor = 'cross_sell' AND farmer_id = p_farmer_id;
  ELSE
    v_head_atual := p_head_visto;
  END IF;

  PERFORM public.farmer_geracao_registrar(
    'cross_sell', p_farmer_id, p_run_id, 'linhas', v_inseridas,
    p_completude, p_motivo, p_insumos, v_head_atual
  );

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$;

-- ── farmer_bundle_recomendacoes_substituir — idem, no bundle ──
-- Corpo VERBATIM da PROD (pg_get_functiondef, 2026-08-30). Não reescrever à mão.
CREATE OR REPLACE FUNCTION public.farmer_bundle_recomendacoes_substituir(p_farmer_id uuid, p_run_id uuid, p_geracao_vista uuid, p_linhas jsonb, p_completude text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_insumos jsonb DEFAULT NULL::jsonb, p_head_visto uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total         integer;
  v_invalidas     integer;
  v_fora_escopo       integer;
  v_geracao_atual uuid;
  v_expiradas     integer;
  v_inseridas     integer;
  v_head_atual    uuid;
BEGIN
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: os % bundle(s) pendentes deste farmer foram preservados',
      (SELECT count(*) FROM public.farmer_bundle_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_bundle_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo de bundles deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_bundle_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente de bundles mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id uuid,
    bundle_products  jsonb,
    affinity_bundle  numeric
  )
  WHERE r.customer_user_id IS NULL
     OR r.bundle_products IS NULL
     OR jsonb_typeof(r.bundle_products) <> 'array'
     OR jsonb_array_length(r.bundle_products) = 0
     OR r.affinity_bundle IS NULL
     OR NOT (
          r.affinity_bundle >= 0
          AND r.affinity_bundle < 'Infinity'::numeric
          AND r.affinity_bundle <> 'NaN'::numeric
        );

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % bundle(s) inválidos (cliente/produtos ausentes, ou afinidade nula/negativa/NaN/Infinita) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;
  -- 6-bis) ESCOPO DE CARTEIRA — o cliente do lote precisa ser DESTE farmer.
  --
  -- `farmer_client_scores` tem UNIQUE (customer_user_id): o dono de um cliente é uma
  -- FUNÇÃO, computável aqui dentro. Até esta versão a RPC aceitava qualquer cliente e
  -- carimbava `p_farmer_id` por cima — foi por essa porta que o fallback do browser
  -- ("carteira vazia ⇒ carregue TODOS os scores") gravou 2.676 linhas com `farmer_id` ≠
  -- dono do cliente. Medido em prod (psql-ro, 21/08/2026): o lote de abril sob o farmer
  -- 33f59dc7 cobria 166 clientes e só 25,9% eram dele, contra os 18,8% da base que ele
  -- detém — a assinatura de quem sorteou da base inteira, não de quem leu a própria carteira.
  --
  -- O gate tinha que ser AQUI, não só no browser: o cliente não pode ser a autoridade
  -- sobre o próprio escopo (#1840 — o browser reescrevia as regras do servidor por cima).
  --
  -- E o dano SOBREVIVE ao conserto do browser porque a etapa 7 expira
  -- `WHERE farmer_id = p_farmer_id`: a linha do cliente C gravada sob A, quando o dono é B,
  -- é INVISÍVEL ao recálculo de B — o dono real recalcula e ela segue pendente, dando ao
  -- mesmo cliente duas gerações vivas ao mesmo tempo.
  --
  -- `IS DISTINCT FROM`, não `<>`: o cliente SEM linha de score precisa cair do MESMO lado.
  -- `<>` com NULL devolve NULL, o `WHERE` descarta, e o cliente de dono desconhecido passaria
  -- — exatamente o caso mais suspeito. Dono desconhecido é recusa, nunca "grave assim mesmo".
  --
  -- Isto é FAIL-CLOSED sob a RLS: a função é SECURITY INVOKER e `farmer_client_scores` só
  -- se deixa ler por `cap_carteira_ler(uid) OR carteira_visivel_para(cliente, uid)`. Se a RLS
  -- esconder do chamador a linha de um cliente alheio, o LEFT JOIN devolve NULL — e NULL é
  -- recusado. A cegueira da RLS vira RECUSA, não passagem.
  -- 6-ter) LOCK CAUSAL DO ESCOPO — a metade que a trigger de troca de dono NÃO cobre.
  -- O guard do #1850 compara o lote com o dono LIDO aqui; a trigger nova
  -- (private.farmer_expirar_pendentes_do_dono_anterior) expira o que já existia quando o
  -- dono muda. Nenhum dos dois cobre a janela ENTRE eles:
  --
  --   T1 (esta RPC, farmer A)          T2 (reatribuição do cliente C para B)
  --   ------------------------         -------------------------------------
  --   FG009 lê score de C = A
  --                                    UPDATE farmer_client_scores: C -> B
  --                                    trigger expira as pendentes de C que existiam
  --   INSERT da oferta C sob A         (a linha NOVA nasce depois da varredura)
  --   COMMIT                           COMMIT
  --
  -- A oferta nova sobrevive fora de escopo. O advisory lock do passo 4 não ajuda: ele é
  -- por FARMER, e quem reatribui não o toma. Travar as linhas de score do lote até o
  -- COMMIT resolve nos dois sentidos — se a troca chega antes, ela espera e a trigger
  -- alcança a linha nova; se chega depois, esta RPC já lê o dono novo e o FG009 recusa.
  --
  -- `FOR SHARE`, não `FOR KEY SHARE`: um UPDATE que não mexe em chave toma
  -- `FOR NO KEY UPDATE`, que NÃO conflita com `FOR KEY SHARE` — o lock mais fraco
  -- deixaria a corrida exatamente como estava, e o teste do caminho feliz seguiria verde.
  -- `FOR SHARE` conflita, e é compartilhado: duas vendedoras com lotes disjuntos não se
  -- esperam (só quem tenta REATRIBUIR espera).
  --
  -- O `ORDER BY` é best-effort contra deadlock (o PG não garante ordem de travamento sob
  -- ORDER BY). A garantia real é a ordem de RECURSOS, que esta fatia mantém única em todo
  -- o domínio: farmer_client_scores -> farmer_recommendations. A trigger segue a mesma
  -- ordem (é disparada POR um UPDATE em scores e só então toca recomendações), então não
  -- há ciclo a inverter.
  --
  -- Cliente do lote SEM linha de score não trava nada — não há linha. Não é buraco: o
  -- FG009 logo abaixo recusa o lote inteiro nesse caso (dono desconhecido é recusa).
  PERFORM 1
    FROM public.farmer_client_scores s
   WHERE s.customer_user_id IN (
           SELECT DISTINCT c.customer_user_id
             FROM jsonb_to_recordset(p_linhas) AS c(customer_user_id uuid)
            WHERE c.customer_user_id IS NOT NULL
         )
   ORDER BY s.customer_user_id
     FOR SHARE;

  SELECT count(*) INTO v_fora_escopo
  FROM jsonb_to_recordset(p_linhas) AS r(customer_user_id uuid)
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = r.customer_user_id
  WHERE s.farmer_id IS DISTINCT FROM p_farmer_id;

  IF v_fora_escopo > 0 THEN
    RAISE EXCEPTION '% de % linha(s) são de cliente fora da carteira deste farmer — nada foi expirado',
      v_fora_escopo, v_total USING ERRCODE = 'FG009';
  END IF;

  UPDATE public.farmer_bundle_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_bundle_recommendations (
    farmer_id, customer_user_id, bundle_products, support, confidence, lift,
    p_bundle, m_bundle, lie_bundle, affinity_bundle, complexity_factor,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.bundle_products,
    r.support, r.confidence, r.lift, r.p_bundle,
    -- m_bundle/lie_bundle: dinheiro, fora de cena desde o #1520 (ver RPC irmã).
    NULL, NULL,
    r.affinity_bundle, coalesce(r.complexity_factor, 1),
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id  uuid,
    bundle_products   jsonb,
    support           numeric,
    confidence        numeric,
    lift              numeric,
    p_bundle          numeric,
    affinity_bundle   numeric,
    complexity_factor numeric
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  -- O HEAD, na MESMA transação, com o head ORIGINAL do chamador (ver RPC irmã para o
  -- racional da assimetria que isto fecha).
  IF p_completude IS NULL THEN
    SELECT run_id INTO v_head_atual
    FROM public.farmer_geracao_vigente
    WHERE motor = 'bundle' AND farmer_id = p_farmer_id;
  ELSE
    v_head_atual := p_head_visto;
  END IF;

  PERFORM public.farmer_geracao_registrar(
    'bundle', p_farmer_id, p_run_id, 'linhas', v_inseridas,
    p_completude, p_motivo, p_insumos, v_head_atual
  );

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$;

-- ── Grants: reafirmação idempotente, NOMEANDO as roles ───────────────────────
REVOKE ALL ON FUNCTION public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid)           FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid)        TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid)    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid) TO authenticated, service_role;

-- ── Validação pós-apply (read-only) — cole DEPOIS do Run ─────────────────────
--   SELECT p.proname,
--          md5(pg_get_functiondef(p.oid)) AS md5_atual,
--          CASE WHEN md5(pg_get_functiondef(p.oid)) = CASE p.proname
--            WHEN 'farmer_recomendacoes_substituir'        THEN 'b19de14fcff1a5cc7c440c25712d2e04'
--            WHEN 'farmer_bundle_recomendacoes_substituir' THEN '38f8855de795ea4e6e8406aacdbdc3c3'
--          END THEN '✅ captura fiel (no-op)' ELSE '❌ o corpo MUDOU — pare e avise' END AS status
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('farmer_recomendacoes_substituir','farmer_bundle_recomendacoes_substituir');
