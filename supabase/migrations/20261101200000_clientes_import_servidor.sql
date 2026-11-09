-- ============================================================
-- clientes_import_rodada — o "Importar Clientes (3 Contas Omie)" passa a rodar no SERVIDOR.
--
-- POR QUE (2026-11-01): o import era um laço no NAVEGADOR (useAnalyticsSync.ts) chamando a edge
-- `omie-cliente` action `sync_all_clients` página a página, com o cursor só na memória da aba. No
-- mesmo dia o laço morreu 3 vezes no meio — preview do editor recarregou (19:42Z), falha de rede
-- "Failed to send a request to the Edge Function" (20:27Z) — deixando `acoes_execucoes` órfãs em
-- `executando` (22/07, 17:20Z, 18:57Z, 18:58Z) e o backlog da Oben (~10 mil não vinculados)
-- incompleto. Cada clique recomeçava da página 1 e relia 15–30 min de páginas já feitas.
--
-- O DESENHO copia o import de PEDIDOS (vendas_sync_cursor + semear + lease cercado + cron):
--  • 1 linha por RODADA, com o cursor (conta_slug, start_page, total_paginas) que antes vivia na
--    aba. Índice único parcial = no máximo UMA rodada aberta (clique duplo, cron semanal concorrente).
--  • o botão SEMEIA (clientes_import_semear, staff); o cron de 1 min chama a edge, que reivindica
--    o lease, processa um lote com o orçamento de tempo da v1.5 e AVANÇA o cursor — tudo cercado
--    pelo lease_token (worker que perdeu o lease não escreve).
--  • lease de 7 MIN, acima do tempo máximo de parede de uma edge (400 s): nem uma invocação que
--    siga viva depois do corte do gateway coincide com a seguinte — e a dupla é o que criaria
--    identidade DUPLICADA (createUser placeholder), porque o dedup é carregado no início de cada uma.
--  • falha persistente vira TERMINAL visível e re-armável (5 erros seguidos, ou 20 invocações sem
--    avanço), nunca re-tentativa infinita.
--  • cron semanal (domingo 06:00 SP) semeia uma varredura completa.
--
-- Idempotente. Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>`; no SQL Editor,
-- envolver em BEGIN; … COMMIT;.
-- Prova: db/test-clientes-import-servidor.sh.
-- ============================================================

SELECT pg_advisory_xact_lock(hashtext('public.clientes_import_rodada'));

CREATE TABLE IF NOT EXISTS public.clientes_import_rodada (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origem                   text NOT NULL CHECK (origem IN ('manual', 'cron_semanal')),
  solicitado_por           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  criado_em                timestamptz NOT NULL DEFAULT now(),
  -- cursor. A conta é o SLUG, não o índice: `getOmieAccounts()` filtra credencial ausente, então o
  -- índice muda de conta se uma credencial some no meio (achado Codex P1). NULL = início da varredura.
  conta_slug               text CHECK (conta_slug IS NULL OR conta_slug IN ('colacor_sc', 'oben', 'colacor')),
  start_page               integer NOT NULL DEFAULT 1 CHECK (start_page >= 1),
  total_paginas            integer NOT NULL DEFAULT 0 CHECK (total_paginas >= 0),
  -- desfecho
  concluida_em             timestamptz,
  falhou_em                timestamptz,
  motivo_falha             text CHECK (motivo_falha IS NULL OR motivo_falha IN ('erro_persistente', 'sem_progresso')),
  ultimo_erro              text,
  -- lease
  running_since            timestamptz,
  heartbeat_at             timestamptz,
  lease_token              uuid,
  -- acumulados (somam os deltas de cada lote)
  importados               integer NOT NULL DEFAULT 0,
  pulados                  integer NOT NULL DEFAULT 0,
  erros                    integer NOT NULL DEFAULT 0,
  telefones_repostos       integer NOT NULL DEFAULT 0,
  -- contas abandonadas (falha que interrompeu a conta) e contas sem credencial — nunca silencioso
  falhas                   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(falhas) = 'array'),
  contas_sem_credencial    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contas_sem_credencial) = 'array'),
  -- terminalidade
  invocacoes               integer NOT NULL DEFAULT 0,
  invocacoes_sem_progresso integer NOT NULL DEFAULT 0,
  erros_consecutivos       integer NOT NULL DEFAULT 0,
  atualizado_em            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clientes_import_rodada_terminal_exclusivo CHECK (concluida_em IS NULL OR falhou_em IS NULL)
);

COMMENT ON TABLE public.clientes_import_rodada IS
  'Rodadas do import de clientes no servidor (omie-cliente continuar_import_clientes). No máximo uma aberta. '
  'Escritor único: as RPCs clientes_import_* (service_role) e clientes_import_semear (staff).';

-- No máximo UMA rodada aberta no sistema.
CREATE UNIQUE INDEX IF NOT EXISTS clientes_import_rodada_uma_aberta
  ON public.clientes_import_rodada ((true))
  WHERE concluida_em IS NULL AND falhou_em IS NULL;

CREATE INDEX IF NOT EXISTS clientes_import_rodada_criado_em
  ON public.clientes_import_rodada (criado_em DESC);

ALTER TABLE public.clientes_import_rodada ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clientes_import_rodada_select_staff ON public.clientes_import_rodada;
CREATE POLICY clientes_import_rodada_select_staff ON public.clientes_import_rodada
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = (SELECT auth.uid())
                    AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)));

DROP POLICY IF EXISTS clientes_import_rodada_service_all ON public.clientes_import_rodada;
CREATE POLICY clientes_import_rodada_service_all ON public.clientes_import_rodada
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Leitura só por SELECT (RLS); escrita só pelas RPCs.
REVOKE ALL ON public.clientes_import_rodada FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.clientes_import_rodada TO authenticated;
GRANT ALL ON public.clientes_import_rodada TO service_role;

-- ─────────────── semear (interno): INSERT da rodada aberta, ou devolve a que já está aberta ───────────────
CREATE OR REPLACE FUNCTION private.clientes_import_semear_interno(p_origem text, p_por uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_row public.clientes_import_rodada;
BEGIN
  IF p_origem IS NULL OR p_origem NOT IN ('manual', 'cron_semanal') THEN
    RAISE EXCEPTION 'origem inválida: %', coalesce(p_origem, 'NULL') USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.clientes_import_rodada (origem, solicitado_por)
  VALUES (p_origem, p_por)
  ON CONFLICT ((true)) WHERE concluida_em IS NULL AND falhou_em IS NULL DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('desfecho', 'semeada', 'rodada_id', v_row.id);
  END IF;
  SELECT * INTO v_row FROM public.clientes_import_rodada
   WHERE concluida_em IS NULL AND falhou_em IS NULL;
  RETURN jsonb_build_object('desfecho', 'ja_aberta', 'rodada_id', v_row.id,
                            'conta_slug', v_row.conta_slug, 'start_page', v_row.start_page);
END;
$$;
REVOKE ALL ON FUNCTION private.clientes_import_semear_interno(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.clientes_import_semear_interno(text, uuid) TO service_role;

-- ─────────────── semear (staff): o botão da tela ───────────────
CREATE OR REPLACE FUNCTION public.clientes_import_semear()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL
     OR NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'clientes_import_semear: acesso restrito à equipe interna' USING ERRCODE = '42501';
  END IF;
  RETURN private.clientes_import_semear_interno('manual', v_uid);
END;
$$;
REVOKE ALL ON FUNCTION public.clientes_import_semear() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clientes_import_semear() TO authenticated, service_role;

-- ─────────────── re-armar (staff): sai do terminal mantendo o cursor ───────────────
CREATE OR REPLACE FUNCTION public.clientes_import_rearmar(p_rodada_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL
     OR NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'clientes_import_rearmar: acesso restrito à equipe interna' USING ERRCODE = '42501';
  END IF;
  -- Só a rodada FALHADA (não concluída — o CHECK garante) e sem lease. Mantém o cursor e os
  -- acumulados; zera as sequências de falha. Se outra rodada já está aberta, o índice único recusa
  -- o UPDATE — a corrida semear×rearmar é decidida por ele, não por um SELECT anterior.
  BEGIN
    UPDATE public.clientes_import_rodada
       SET falhou_em = NULL, motivo_falha = NULL, ultimo_erro = NULL,
           erros_consecutivos = 0, invocacoes_sem_progresso = 0,
           running_since = NULL, lease_token = NULL, atualizado_em = now()
     WHERE id = p_rodada_id AND falhou_em IS NOT NULL AND running_since IS NULL;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('desfecho', 'outra_aberta');
  END;
  IF FOUND THEN
    RETURN jsonb_build_object('desfecho', 'rearmada');
  END IF;
  RETURN jsonb_build_object('desfecho', 'nao_rearmavel');
END;
$$;
REVOKE ALL ON FUNCTION public.clientes_import_rearmar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clientes_import_rearmar(uuid) TO authenticated, service_role;

-- ─────────────── acquire cercado (service_role): pula terminal; roubar lease MORTO conta ───────────────
-- Lease de 7 min > 400 s de parede da edge. Roubar um lease morto (running_since ainda setado) é
-- evidência de worker que morreu sem avançar: conta como invocação sem progresso, e na 20ª a rodada
-- vai a TERMINAL ali mesmo, sem entregar o lease.
CREATE OR REPLACE FUNCTION public.clientes_import_lease_acquire()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  UPDATE public.clientes_import_rodada
     SET running_since = CASE WHEN running_since IS NOT NULL AND invocacoes_sem_progresso + 1 >= 20 THEN NULL ELSE now() END,
         lease_token   = CASE WHEN running_since IS NOT NULL AND invocacoes_sem_progresso + 1 >= 20 THEN NULL ELSE gen_random_uuid() END,
         invocacoes_sem_progresso = CASE WHEN running_since IS NOT NULL THEN invocacoes_sem_progresso + 1 ELSE invocacoes_sem_progresso END,
         falhou_em     = CASE WHEN running_since IS NOT NULL AND invocacoes_sem_progresso + 1 >= 20 THEN now() ELSE falhou_em END,
         motivo_falha  = CASE WHEN running_since IS NOT NULL AND invocacoes_sem_progresso + 1 >= 20 THEN 'sem_progresso' ELSE motivo_falha END,
         invocacoes    = invocacoes + 1,
         heartbeat_at  = now(),
         atualizado_em = now()
   WHERE concluida_em IS NULL
     AND falhou_em IS NULL
     AND (running_since IS NULL OR heartbeat_at < now() - interval '7 minutes')
  RETURNING CASE WHEN falhou_em IS NULL THEN jsonb_build_object(
    'rodada_id', id, 'lease_token', lease_token,
    'conta_slug', conta_slug, 'start_page', start_page, 'total_paginas', total_paginas) END;
$$;
REVOKE ALL ON FUNCTION public.clientes_import_lease_acquire() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clientes_import_lease_acquire() TO service_role;

-- ─────────────── avançar cercado (service_role): grava o lote, libera o lease ───────────────
-- Progresso = o cursor andou (conta ou página) OU entrou cliente novo. Orçamento esgotado no meio
-- da página mantém a página mas importa → conta como progresso. Sem progresso 20× → terminal.
CREATE OR REPLACE FUNCTION public.clientes_import_avancar(
  p_rodada_id uuid, p_lease_token uuid,
  p_conta_slug text, p_start_page integer, p_total_paginas integer,
  p_importados integer, p_pulados integer, p_erros integer, p_telefones integer,
  p_falha jsonb, p_contas_sem_credencial jsonb, p_concluida boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_start_page IS NULL OR p_start_page < 1 OR p_total_paginas IS NULL OR p_total_paginas < 0 OR p_concluida IS NULL
     OR (p_conta_slug IS NOT NULL AND p_conta_slug NOT IN ('colacor_sc', 'oben', 'colacor'))
     OR (NOT p_concluida AND p_conta_slug IS NULL) THEN
    RAISE EXCEPTION 'clientes_import_avancar: cursor inválido (%, %, %, %)',
      p_conta_slug, p_start_page, p_total_paginas, p_concluida USING ERRCODE = '22023';
  END IF;
  IF least(coalesce(p_importados, -1), coalesce(p_pulados, -1), coalesce(p_erros, -1), coalesce(p_telefones, -1)) < 0 THEN
    RAISE EXCEPTION 'clientes_import_avancar: contadores devem ser >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_falha IS NOT NULL AND jsonb_typeof(p_falha) <> 'object' THEN
    RAISE EXCEPTION 'clientes_import_avancar: p_falha deve ser objeto ou NULL' USING ERRCODE = '22023';
  END IF;
  IF p_contas_sem_credencial IS NULL OR jsonb_typeof(p_contas_sem_credencial) <> 'array' THEN
    RAISE EXCEPTION 'clientes_import_avancar: p_contas_sem_credencial deve ser array' USING ERRCODE = '22023';
  END IF;

  UPDATE public.clientes_import_rodada r
     SET invocacoes_sem_progresso = CASE
           WHEN p_concluida OR p_importados > 0 OR p_conta_slug IS DISTINCT FROM r.conta_slug OR p_start_page <> r.start_page THEN 0
           ELSE r.invocacoes_sem_progresso + 1 END,
         falhou_em = CASE
           WHEN NOT p_concluida AND p_importados = 0 AND p_conta_slug IS NOT DISTINCT FROM r.conta_slug AND p_start_page = r.start_page
                AND r.invocacoes_sem_progresso + 1 >= 20 THEN now()
           ELSE r.falhou_em END,
         motivo_falha = CASE
           WHEN NOT p_concluida AND p_importados = 0 AND p_conta_slug IS NOT DISTINCT FROM r.conta_slug AND p_start_page = r.start_page
                AND r.invocacoes_sem_progresso + 1 >= 20 THEN 'sem_progresso'
           ELSE r.motivo_falha END,
         conta_slug    = CASE WHEN p_concluida THEN NULL ELSE p_conta_slug END,
         start_page    = p_start_page,
         total_paginas = p_total_paginas,
         importados    = r.importados + p_importados,
         pulados       = r.pulados + p_pulados,
         erros         = r.erros + p_erros,
         telefones_repostos = r.telefones_repostos + p_telefones,
         -- só a falha que ABANDONOU a conta entra no relatório (a retentativa em curso não interrompeu nada)
         falhas = CASE WHEN p_falha IS NOT NULL AND coalesce((p_falha->>'conta_abandonada')::boolean, false)
                       THEN r.falhas || jsonb_build_array(p_falha || jsonb_build_object('em', now()))
                       ELSE r.falhas END,
         contas_sem_credencial = (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb)
                                    FROM jsonb_array_elements(r.contas_sem_credencial || p_contas_sem_credencial) AS x),
         concluida_em = CASE WHEN p_concluida THEN now() ELSE r.concluida_em END,
         erros_consecutivos = 0,
         ultimo_erro   = NULL,
         running_since = NULL,
         lease_token   = NULL,
         heartbeat_at  = now(),
         atualizado_em = now()
   WHERE r.id = p_rodada_id
     AND r.concluida_em IS NULL
     AND r.falhou_em IS NULL
     AND r.running_since IS NOT NULL
     AND r.lease_token = p_lease_token;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.clientes_import_avancar(uuid, uuid, text, integer, integer, integer, integer, integer, integer, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clientes_import_avancar(uuid, uuid, text, integer, integer, integer, integer, integer, integer, jsonb, jsonb, boolean) TO service_role;

-- ─────────────── liberar com erro (service_role): 5 seguidos → terminal ───────────────
CREATE OR REPLACE FUNCTION public.clientes_import_liberar_erro(p_rodada_id uuid, p_lease_token uuid, p_motivo text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  WITH u AS (
    UPDATE public.clientes_import_rodada
       SET erros_consecutivos = erros_consecutivos + 1,
           ultimo_erro   = left(coalesce(p_motivo, 'erro sem mensagem'), 500),
           falhou_em     = CASE WHEN erros_consecutivos + 1 >= 5 THEN now() ELSE falhou_em END,
           motivo_falha  = CASE WHEN erros_consecutivos + 1 >= 5 THEN 'erro_persistente' ELSE motivo_falha END,
           running_since = NULL,
           lease_token   = NULL,
           heartbeat_at  = now(),
           atualizado_em = now()
     WHERE id = p_rodada_id
       AND concluida_em IS NULL
       AND falhou_em IS NULL
       AND running_since IS NOT NULL
       AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.clientes_import_liberar_erro(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clientes_import_liberar_erro(uuid, uuid, text) TO service_role;

-- ─────────────── crons ───────────────
-- Continuação: a cada minuto, SÓ se há rodada aberta. O lease (7 min) torna as chamadas
-- sobrepostas no-op; pg_net é assíncrono e o timeout explícito evita o corte silencioso de 5 s.
SELECT cron.schedule('clientes-import-continuacao-1min', '* * * * *', $cmd$
  DO $inner$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.clientes_import_rodada WHERE concluida_em IS NULL AND falhou_em IS NULL) THEN
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-cliente',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object('action', 'continuar_import_clientes'),
        timeout_milliseconds := 150000
      );
    END IF;
  END $inner$;
$cmd$);

-- Varredura completa semanal: domingo 09:00 UTC (06:00 SP). Se já há uma aberta, é no-op.
SELECT cron.schedule('clientes-import-semanal', '0 9 * * 0', $cmd$
  SELECT private.clientes_import_semear_interno('cron_semanal', NULL);
$cmd$);

NOTIFY pgrst, 'reload schema';

-- ─────────────── postcondição ───────────────
DO $post$
DECLARE
  f text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'clientes_import_rodada' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'P1 FALHOU: clientes_import_rodada ausente ou sem RLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'clientes_import_rodada_uma_aberta' AND i.indisunique AND i.indisvalid) THEN
    RAISE EXCEPTION 'P2 FALHOU: índice único de rodada aberta ausente/inválido — clique duplo abriria duas rodadas';
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'public.clientes_import_lease_acquire()',
    'public.clientes_import_avancar(uuid,uuid,text,integer,integer,integer,integer,integer,integer,jsonb,jsonb,boolean)',
    'public.clientes_import_liberar_erro(uuid,uuid,text)',
    'private.clientes_import_semear_interno(text,uuid)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR has_function_privilege('public', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P3 FALHOU: % executável fora do service_role', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.clientes_import_semear()', 'public.clientes_import_rearmar(uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P4 FALHOU: ACL de % fora do esperado (authenticated sim; anon/PUBLIC não)', f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clientes-import-continuacao-1min' AND active
                    AND command LIKE '%timeout_milliseconds := 150000%' AND command LIKE '%continuar_import_clientes%') THEN
    RAISE EXCEPTION 'P5 FALHOU: cron de continuação ausente, inativo ou sem timeout explícito';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clientes-import-semanal' AND active
                    AND command LIKE '%clientes_import_semear_interno(''cron_semanal''%') THEN
    RAISE EXCEPTION 'P6 FALHOU: cron semanal ausente ou inativo';
  END IF;
  RAISE NOTICE 'clientes_import_rodada pronta: tabela+RLS, 1 aberta por vez, RPCs cercadas, 2 crons';
END
$post$;
