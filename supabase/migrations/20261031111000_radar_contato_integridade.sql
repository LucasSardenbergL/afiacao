-- ============================================================================================================
-- 20261031111000_radar_contato_integridade.sql — Radar de Clientes: integridade das RPCs de contato.
-- Diário: docs/historico/radar-contato-integridade.md.
--
-- Por quê: a frente 2 (20261029201200, PR #3417) abriu o Radar ao vendedor, e a revisão do Codex achou duas falhas
-- ANTIGAS que antes só o gestor alcançava:
--   1. `registrar_contato_radar` aceitava 'virou_cliente' sem a confirmação do Omie que o cadastro
--      (`radar_registrar_cadastro_omie`) exige no ledger `omie_cliente_confirmacoes`. Qualquer vendedor marcava um lead
--      como cliente e falseava o funil, o KPI do mês e o placar da frente 3. Decisão do founder (2026-10-31): RECUSAR.
--   2. `desfazer_contato_radar` restaurava o status só porque ele "continuava igual à ação desfeita": A e B registram a
--      mesma ação, A desfaz e o efeito de B some.
--
-- Desenho (Codex max, 2026-10-31 — o carimbo `prospeccao_atualizado_em` como versão foi REPROVADO: v1 e o cron gravam
-- com now()/p_agora, e reconstruir autoria por ordem de relógio apagava o descarte da RFB num desfazer encadeado):
--   · AUTORIA EXPLÍCITA: `radar_empresas.prospeccao_contato_id` é o contato que escreveu o estado atual; cada contato
--     guarda o RETRATO do estado que substituiu (status, motivo, carimbo e o dono anterior). Desfazer restaura o retrato
--     só se o contato é o dono, sob a trava da linha; o dono anterior apagado encerra a cadeia (nunca um substituto).
--   · TRIGGER `private.radar_empresas_status_guard` (fecha a classe, não a porta): qualquer escrita de status que não
--     declara o dono (cadastro v1, cron radar_aplicar_situacao, chamada do corpo ANTIGO em voo) zera a autoria; e
--     'virou_cliente' só entra com o vínculo confirmado no ledger (RD005), seja qual for o caminho.
--   · 'virou_cliente' não se desfaz pela RPC genérica (RD006): o cliente continua no Omie e repetir a v1 é no-op.
--   · Cliente confirmado só sai de 'virou_cliente' pelo gestor (RD007), e re-marcar 'virou_cliente' é no-op: o KPI do mês
--     conta o status pelo carimbo, então os dois caminhos falseavam a conversão (para baixo e para cima).
--
-- Medido em prod (psql-ro, 2026-10-31): 0 contatos 'virou_cliente' na história, 0 empresas nesse status, 0 linhas no
-- ledger, 5 contatos humanos (1 usuário), 573.021 empresas. Nenhum número histórico muda; nenhum dependente de
-- %ROWTYPE/SETOF/view sobre as duas tabelas (as colunas novas vão no fim, nulas, sem reescrita).
--
-- Caminho: `bun run db:aplicar` (a transação é do executor; o arquivo NÃO leva BEGIN/COMMIT). Molde
-- TRAVA → PRE (md5 exato ∈ {predecessor vivo, este}) → DDL → CREATE OR REPLACE → PÓS (corpo + atributos + ACL +
-- colunas + triggers). O gate `private.cap_radar_prospectar` da frente 2 é PRESERVADO em registrar e passa a valer
-- também no desfazer. Prova: db/test-radar-contato-integridade.sh (núcleo do CI).
-- ============================================================================================================

-- O ALTER TABLE pede ACCESS EXCLUSIVE em radar_empresas (lida pela tela inteira): espera curta, ou aborta sem efeito.
-- (lock_timeout vale para a próxima espera. O tempo de RETENÇÃO é limitado pelo statement_timeout do executor, 300 s:
-- um SET LOCAL aqui dentro não rearma o temporizador já iniciado (Codex, código). Por isso nada pesado roda depois do
-- ALTER: a varredura de radar_empresas fica antes dele.)
SET LOCAL lock_timeout = '5s';

-- ── TRAVA: ALTER sem efeito (a volatilidade VIVA) nas 2 RPCs, ANTES de ler o corpo ───────────────────────────
DO $trava$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.sig FROM (VALUES
      ('public.registrar_contato_radar(text,text,text)'),
      ('public.desfazer_contato_radar(uuid)')
    ) AS x(sig)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'TRAVA FALHOU: % não existe — o predecessor de prod é obrigatório', r.sig;
    END IF;
    EXECUTE format('ALTER FUNCTION %s VOLATILE', r.sig);
  END LOOP;
END
$trava$;

-- ── PRE: o corpo vivo é o predecessor revisado (psql-ro, 2026-10-31) ou já é este ───────────────────────────
DO $pre$
DECLARE
  r record;
  v_vivo text;
BEGIN
  FOR r IN
    SELECT x.sig, x.predecessor, x.este FROM (VALUES
      ('public.registrar_contato_radar(text,text,text)', '658d383c7f34f97427aacb053714ea3e', '26c486a156b0fd90d5187bfa377daae5'),
      ('public.desfazer_contato_radar(uuid)',            'f695b1e6ca8fd9dac19f7b0ea08897e7', 'b2f4de64f1110150c4c66905cfe3c542')
    ) AS x(sig, predecessor, este)
  LOOP
    SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_vivo IS NULL OR v_vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado (%) nem este (%)',
        r.sig, v_vivo, r.predecessor, r.este;
    END IF;
  END LOOP;
END
$pre$;

-- A invariante vale para o que já existe (0 em prod no pré-voo de 2026-10-31). Varre radar_empresas ANTES do ALTER,
-- sem segurar ACCESS EXCLUSIVE; depois dele o trigger guarda qualquer entrada nova.
DO $pre_invariante$
BEGIN
  IF EXISTS (SELECT 1 FROM public.radar_empresas e
              WHERE e.prospeccao_status = 'virou_cliente'
                AND NOT EXISTS (SELECT 1 FROM public.omie_cliente_confirmacoes c
                                 WHERE c.account = 'oben' AND c.documento = e.cnpj
                                   AND c.codigo_cliente = NULLIF(btrim(e.omie_codigo_cliente), ''))) THEN
    RAISE EXCEPTION 'PRE FALHOU: há empresa em virou_cliente sem cliente confirmado no ledger';
  END IF;
END
$pre_invariante$;

-- ── 1. Autoria do status e retrato do estado substituído ─────────────────────────────────────────────────────
ALTER TABLE public.radar_empresas ADD COLUMN IF NOT EXISTS prospeccao_contato_id uuid;
COMMENT ON COLUMN public.radar_empresas.prospeccao_contato_id IS
  'Contato (radar_contatos.id) que escreveu o status atual; NULL = escrito por outro caminho (cadastro, cron da RFB). '
  'Único critério de desfazer_contato_radar para restaurar. Escritores: registrar/desfazer_contato_radar; o trigger '
  'radar_empresas_status_guard zera em qualquer outra escrita de status.';
ALTER TABLE public.radar_contatos ADD COLUMN IF NOT EXISTS contato_anterior_id uuid;
ALTER TABLE public.radar_contatos ADD COLUMN IF NOT EXISTS descarte_motivo_anterior text;
ALTER TABLE public.radar_contatos ADD COLUMN IF NOT EXISTS atualizado_anterior timestamptz;
COMMENT ON COLUMN public.radar_contatos.contato_anterior_id IS
  'Retrato do estado que este contato substituiu (com status_anterior, descarte_motivo_anterior e atualizado_anterior): '
  'o dono anterior do status. Gravado por registrar_contato_radar; NULL nos contatos de outros caminhos e nos antigos.';

-- ── 2. Guarda do status: autoria + invariante "virou_cliente ⇒ cliente confirmado" ──────────────────────────
CREATE OR REPLACE FUNCTION private.radar_empresas_status_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- As regras abaixo valem para QUALQUER escritor, inclusive o corpo ANTIGO de uma RPC que estava em voo quando a
  -- migration commitou (o PL/pgSQL mantém a definição de quando a chamada começou — Codex, código).
  IF TG_OP = 'UPDATE' AND OLD.prospeccao_status = 'virou_cliente' THEN
    IF NEW.prospeccao_status = 'virou_cliente' THEN
      -- A data da conversão é a da ENTRADA em virou_cliente: regravar o mesmo status não recarimba (o KPI do mês
      -- conta pelo carimbo, e recarimbar era conversão nova no mês seguinte).
      NEW.prospeccao_atualizado_em := OLD.prospeccao_atualizado_em;
    ELSIF auth.uid() IS NOT NULL
          AND NOT COALESCE(private.cap_carteira_ler(auth.uid()), false)
          AND EXISTS (SELECT 1 FROM public.omie_cliente_confirmacoes c
                       WHERE c.account = 'oben' AND c.documento = OLD.cnpj
                         AND c.codigo_cliente = NULLIF(btrim(OLD.omie_codigo_cliente), '')) THEN
      -- Cliente confirmado só sai de virou_cliente pelo gestor. Sem JWT (cron, SQL do founder) é escrita de servidor.
      RAISE EXCEPTION 'RADAR_CLIENTE_CONFIRMADO: o CNPJ % é cliente confirmado no Omie/Oben e só sai de virou_cliente pelo gestor', OLD.cnpj
        USING ERRCODE = 'RD007';
    END IF;
  END IF;
  -- Escrita de status que NÃO declara o dono (o mesmo valor de antes) não é de um contato desfazível: zera a autoria.
  IF TG_OP = 'UPDATE'
     AND (NEW.prospeccao_status IS DISTINCT FROM OLD.prospeccao_status
          OR NEW.descarte_motivo IS DISTINCT FROM OLD.descarte_motivo
          OR NEW.prospeccao_atualizado_em IS DISTINCT FROM OLD.prospeccao_atualizado_em)
     AND NEW.prospeccao_contato_id IS NOT DISTINCT FROM OLD.prospeccao_contato_id THEN
    NEW.prospeccao_contato_id := NULL;
  END IF;
  -- Ausente ≠ confirmado: entrar em 'virou_cliente' exige o vínculo E a linha que o SERVIDOR gravou no ledger
  -- (conta Oben + este CNPJ + este código) — o predicado de radar_registrar_cadastro_omie, valendo para TODO caminho.
  IF NEW.prospeccao_status = 'virou_cliente'
     AND (TG_OP = 'INSERT' OR OLD.prospeccao_status IS DISTINCT FROM 'virou_cliente')
     AND NOT EXISTS (SELECT 1 FROM public.omie_cliente_confirmacoes c
                      WHERE c.account = 'oben' AND c.documento = NEW.cnpj
                        AND c.codigo_cliente = NULLIF(btrim(NEW.omie_codigo_cliente), '')) THEN
    RAISE EXCEPTION 'RADAR_VIROU_CLIENTE_SEM_CONFIRMACAO: o CNPJ % não tem cliente confirmado no Omie/Oben', NEW.cnpj
      USING ERRCODE = 'RD005';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION private.radar_empresas_status_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_radar_status_guard_upd ON public.radar_empresas;
CREATE TRIGGER trg_radar_status_guard_upd
  BEFORE UPDATE ON public.radar_empresas
  FOR EACH ROW
  WHEN (NEW.prospeccao_status IS DISTINCT FROM OLD.prospeccao_status
        OR NEW.descarte_motivo IS DISTINCT FROM OLD.descarte_motivo
        OR NEW.prospeccao_atualizado_em IS DISTINCT FROM OLD.prospeccao_atualizado_em
        OR NEW.prospeccao_contato_id IS DISTINCT FROM OLD.prospeccao_contato_id)
  EXECUTE FUNCTION private.radar_empresas_status_guard();
DROP TRIGGER IF EXISTS trg_radar_status_guard_ins ON public.radar_empresas;
CREATE TRIGGER trg_radar_status_guard_ins
  BEFORE INSERT ON public.radar_empresas
  FOR EACH ROW
  WHEN (NEW.prospeccao_status = 'virou_cliente')
  EXECUTE FUNCTION private.radar_empresas_status_guard();

-- ── 3. registrar_contato_radar ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_contato_radar(p_cnpj text, p_acao text, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status_atual text;
  v_codigo_atual text;
  v_motivo_atual text;
  v_atualizado_atual timestamptz;
  v_dono_atual uuid;
  v_confirmado boolean;
  v_agora timestamptz;
  v_existing uuid;
  v_id uuid;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido';
  END IF;
  IF p_acao IS NULL OR p_acao NOT IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente') THEN
    RAISE EXCEPTION 'ação inválida: %', p_acao;
  END IF;

  SELECT prospeccao_status, NULLIF(btrim(omie_codigo_cliente), ''), descarte_motivo, prospeccao_atualizado_em,
         prospeccao_contato_id
    INTO v_status_atual, v_codigo_atual, v_motivo_atual, v_atualizado_atual, v_dono_atual
    FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- Ausente ≠ confirmado: o vínculo que o cadastro gravou E a linha que o SERVIDOR gravou no ledger (o predicado de
  -- radar_registrar_cadastro_omie; o trigger radar_empresas_status_guard repete-o para todo caminho).
  v_confirmado := v_codigo_atual IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.omie_cliente_confirmacoes c
     WHERE c.account = 'oben' AND c.documento = p_cnpj AND c.codigo_cliente = v_codigo_atual);

  IF p_acao = 'virou_cliente' AND NOT v_confirmado THEN
    RAISE EXCEPTION 'RADAR_VIROU_CLIENTE_SEM_CONFIRMACAO: o CNPJ % não tem cliente confirmado no Omie/Oben — "virou cliente" vem do cadastro pelo Radar', p_cnpj
      USING ERRCODE = 'RD005';
  END IF;
  IF v_status_atual = 'virou_cliente' AND v_confirmado THEN
    -- Já é cliente confirmado: re-marcar não é conversão nova (o KPI do mês conta o carimbo) e tirar daí é do gestor.
    IF p_acao = 'virou_cliente' THEN
      SELECT id INTO v_existing FROM public.radar_contatos
       WHERE cnpj = p_cnpj AND acao = 'virou_cliente' ORDER BY created_at DESC, id DESC LIMIT 1;
      IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('id', v_existing, 'deduped', true);
      END IF;
    ELSIF NOT COALESCE(private.cap_carteira_ler(v_uid), false) THEN
      RAISE EXCEPTION 'RADAR_CLIENTE_CONFIRMADO: o CNPJ % é cliente confirmado no Omie/Oben — só o gestor muda o status', p_cnpj
        USING ERRCODE = 'RD007';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_cnpj||':'||p_acao||':radar', 0));
  -- Instante lido DEPOIS das travas: now() é o início da transação, e quem esperou não pode medir janela nem carimbar
  -- com o relógio de antes da espera.
  v_agora := clock_timestamp();
  -- Clique repetido só é o MESMO registro se ele ainda é o dono do status: alguém (gestor, cadastro, cron) mudou o lead
  -- no meio → é registro novo, não "já feito".
  SELECT id INTO v_existing FROM public.radar_contatos
   WHERE id = v_dono_atual AND criado_por = v_uid AND cnpj = p_cnpj AND acao = p_acao
     AND created_at > v_agora - interval '2 minutes';
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, created_at,
                                     status_anterior, descarte_motivo_anterior, atualizado_anterior, contato_anterior_id)
  VALUES (p_cnpj, p_acao, p_nota, v_uid, v_agora,
          v_status_atual, v_motivo_atual, v_atualizado_atual, v_dono_atual)
  RETURNING id INTO v_id;

  UPDATE public.radar_empresas SET
    prospeccao_status = p_acao,
    prospeccao_atualizado_em = v_agora,
    prospeccao_contato_id = v_id,
    descarte_motivo = CASE WHEN p_acao = 'descartado' THEN p_nota ELSE NULL END,
    updated_at = now()
  WHERE cnpj = p_cnpj;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $function$;

-- ── 4. desfazer_contato_radar: restaura o retrato só se o contato é o DONO do status ─────────────────────────
CREATE OR REPLACE FUNCTION public.desfazer_contato_radar(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_cnpj text;
  v_dono uuid;
  v_agora timestamptz;
  v_acao text;
  v_anterior text;
  v_motivo_anterior text;
  v_atualizado_anterior timestamptz;
  v_dono_anterior uuid;
  v_restaurou boolean := false;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;

  SELECT cnpj INTO v_cnpj FROM public.radar_contatos WHERE id = p_id AND criado_por = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'status_restaurado', false);
  END IF;

  SELECT prospeccao_contato_id INTO v_dono FROM public.radar_empresas WHERE cnpj = v_cnpj FOR UPDATE;
  v_agora := clock_timestamp();

  -- Relido SOB a trava, com a janela medida depois da espera.
  SELECT acao, status_anterior, descarte_motivo_anterior, atualizado_anterior, contato_anterior_id
    INTO v_acao, v_anterior, v_motivo_anterior, v_atualizado_anterior, v_dono_anterior
    FROM public.radar_contatos
   WHERE id = p_id AND criado_por = v_uid AND cnpj = v_cnpj AND created_at > v_agora - interval '5 minutes';
  IF NOT FOUND THEN  -- apagado por um desfazer concorrente, ou fora da janela
    RETURN jsonb_build_object('deleted', false, 'status_restaurado', false);
  END IF;

  -- A conversão confirmada fica no Omie e repetir o cadastro é no-op: apagar o contato só esconderia o cliente.
  IF v_acao = 'virou_cliente' THEN
    RAISE EXCEPTION 'RADAR_CONVERSAO_NAO_SE_DESFAZ: o contato % é a conversão do CNPJ % — o cliente continua no Omie', p_id, v_cnpj
      USING ERRCODE = 'RD006';
  END IF;

  -- Só o DONO restaura: outro contato (de qualquer usuário), o cadastro ou o cron escreveram depois → o status fica.
  IF v_dono IS NOT DISTINCT FROM p_id THEN
    UPDATE public.radar_empresas SET
      prospeccao_status = COALESCE(v_anterior, 'a_contatar'),
      descarte_motivo = v_motivo_anterior,
      prospeccao_atualizado_em = v_atualizado_anterior,
      -- O dono anterior apagado (desfeito fora de ordem) encerra a cadeia: nunca um substituto com a mesma ação.
      prospeccao_contato_id = (SELECT o.id FROM public.radar_contatos o WHERE o.id = v_dono_anterior AND o.cnpj = v_cnpj),
      updated_at = now()
    WHERE cnpj = v_cnpj;
    v_restaurou := true;
  END IF;

  -- Tirar o contato da cadeia: quem o tinha como dono anterior herda o retrato DELE. Sem isto, A desfaz sem ser dono,
  -- B (que veio depois) desfaz e o retrato "antes de B" ressuscita o efeito que A acabou de desfazer.
  UPDATE public.radar_contatos SET
    status_anterior = v_anterior,
    descarte_motivo_anterior = v_motivo_anterior,
    atualizado_anterior = v_atualizado_anterior,
    contato_anterior_id = v_dono_anterior
  WHERE contato_anterior_id = p_id;

  DELETE FROM public.radar_contatos WHERE id = p_id;
  RETURN jsonb_build_object('deleted', true, 'status_restaurado', v_restaurou);
END $function$;

REVOKE EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.desfazer_contato_radar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.desfazer_contato_radar(uuid) TO authenticated, service_role;

-- ── PÓS: corpos (md5 exato), atributos, ACL, colunas e triggers ─────────────────────────────────────────────
DO $post$
DECLARE
  r record;
  v record;
BEGIN
  FOR r IN
    SELECT x.sig, x.este, x.config FROM (VALUES
      ('public.registrar_contato_radar(text,text,text)', '26c486a156b0fd90d5187bfa377daae5', ARRAY['search_path=public']),
      ('public.desfazer_contato_radar(uuid)',            'b2f4de64f1110150c4c66905cfe3c542',  ARRAY['search_path=public']),
      ('private.radar_empresas_status_guard()',          '8e3db85603b8e94d31262c68505d4983',     ARRAY['search_path=public, pg_temp'])
    ) AS x(sig, este, config)
  LOOP
    SELECT md5(p.prosrc) AS md5, p.prosecdef, p.provolatile, p.proconfig,
           (SELECT count(*) FROM pg_catalog.pg_proc o WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) AS sobrecargas
      INTO v FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v.md5 IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PÓS FALHOU: % ficou com md5 % (esperado %)', r.sig, v.md5, r.este;
    END IF;
    IF NOT v.prosecdef OR v.provolatile <> 'v' OR v.proconfig IS DISTINCT FROM r.config THEN
      RAISE EXCEPTION 'PÓS FALHOU: % perdeu atributos (secdef %, vol %, config %)', r.sig, v.prosecdef, v.provolatile, v.proconfig;
    END IF;
    IF v.sobrecargas <> 1 THEN
      RAISE EXCEPTION 'PÓS FALHOU: % tem % sobrecargas (esperado 1)', r.sig, v.sobrecargas;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure(r.sig) AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PÓS FALHOU: ACL de % (anon/PUBLIC não podem executar)', r.sig;
    END IF;
    -- As RPCs são do JWT; a função do trigger, de ninguém.
    IF has_function_privilege('authenticated', r.sig, 'EXECUTE') IS DISTINCT FROM (r.sig LIKE 'public.%') THEN
      RAISE EXCEPTION 'PÓS FALHOU: EXECUTE de authenticated em % fora do esperado', r.sig;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'radar_empresas' AND column_name = 'prospeccao_contato_id' AND data_type = 'uuid')
           OR (table_name = 'radar_contatos' AND column_name = 'contato_anterior_id' AND data_type = 'uuid')
           OR (table_name = 'radar_contatos' AND column_name = 'descarte_motivo_anterior' AND data_type = 'text')
           OR (table_name = 'radar_contatos' AND column_name = 'atualizado_anterior' AND data_type = 'timestamp with time zone'))) <> 4 THEN
    RAISE EXCEPTION 'PÓS FALHOU: colunas de autoria/retrato ausentes ou com tipo errado';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.radar_empresas'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
         AND t.tgfoid = 'private.radar_empresas_status_guard()'::regprocedure
         AND t.tgname IN ('trg_radar_status_guard_upd', 'trg_radar_status_guard_ins')) <> 2 THEN
    RAISE EXCEPTION 'PÓS FALHOU: os 2 triggers da guarda do status não estão ativos em radar_empresas';
  END IF;

  RAISE NOTICE 'VALIDADO 20261031111000: RPCs de contato, guarda do status e colunas de autoria no estado esperado';
END
$post$;
