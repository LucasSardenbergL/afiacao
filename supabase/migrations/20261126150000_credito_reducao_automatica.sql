-- ============================================================
-- Crédito-IA fatia 5b — REDUÇÃO AUTOMÁTICA do limite vigente (só desce, nunca sobe) com 1 writer,
-- auditoria por linha e o caminho de volta pela proposta da IA aprovada pelo Lucas.
-- Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §5.3 ("redução por deterioração aplica
-- na hora"), §9.9 e builder-check · Plano: docs/superpowers/plans/2026-11-20-credito-ia.md (PR 4,
-- revisão pós-Codex item 8) · Desenho 5b + 2 rodadas Codex: docs/historico/credito-reducao-backtest-5b-2026-11.md
--
-- Invariantes:
--  * 1 WRITER de credito_limite: private.credito_limite_gravar. A aprovação do Lucas e a redução
--    automática passam por ele; a pós-condição varre pg_proc e aborta se outra função escrever na tabela.
--  * Toda escrita é amarrada a uma linha de credito_limite_proposta (trigger credito_limite_lastro):
--    valores = os da proposta; origem 'pendente' = aprovação (aprovador na allowlist); origem
--    'aplicada_auto_reducao' = redução (nunca INSERT; limite e prazo não sobem, risco não melhora, ≥ 1
--    piora estrita, versão +1, e assinatura/ficha_calculada_em/aprovado_por do vigente PRESERVADOS —
--    a redução não lava `grupo_mudou` nem `limite_desatualizado`, nem se passa por aprovação).
--  * Só evidência COMPROVADA corta (Codex desenho P1-1/P1-2): E1 piso comprovado (vencido ≥ 60 d) ⇒
--    0/0/alto; E2 título aberto que cruzou 15 d de atraso DEPOIS da ficha que o Lucas aprovou ⇒ limite
--    = floor₁₀₀(títulos abertos + reservas efetivas ativas) ("nada novo"); E3 cadastro irregular ⇒ risco
--    alto. Dado ausente (exposição NULL, piso indeterminado, sync defasado, inconclusivo) NÃO escreve:
--    o gate já dá 🟡 na hora, e o corte permanente por falta de dado seria fabricação.
--  * Substituição declarada do builder-check do spec ("reduz para max(exposição, sugerido pela IA)"):
--    a IA não roda para vigente na hora do corte, então o corte é determinístico ("nada novo") e a IA
--    re-propõe em seguida (caminho de volta abaixo). Aceite: exposição R$ 650 e vigente R$ 3.000 ⇒ R$ 600.
--  * Caminho de volta: vigente REVISÁVEL (origem = redução automática, ou composição do grupo mudada)
--    volta ao laço da edge credito-ia-avaliar; a proposta nova cai na fila do Lucas com o vigente ao
--    lado. Só sobe com o clique dele (credito_aprovar_proposta — inalterada salvo o writer).
--  * Lote curto (≤ 25 raízes, ~20 s) a cada 5 min, retomável por credito_reducao_verificacao (a raiz
--    menos recente primeiro), lock_timeout de 2 s por raiz (grupo ocupado pelo gate = próxima volta).
--
-- Inerte em prod enquanto credito_limite estiver vazio (1ª leva não aprovada) — o lote não acha raiz.
-- Não toca: núcleo do gate (private.credito_avaliar_reservar), piso, sombra, enforcement (PR 6),
-- omie-vendas-sync. A redução não bloqueia pedido por si: quem bloqueia é o enforcement do PR 6 (desligado).
--
-- Sem BEGIN/COMMIT: a transação é do `bun run db:aplicar`.
-- Prova: db/test-credito-reducao-auto.sh (PG17, falsificação, nos 2 locales).
-- Reversão: SELECT cron.unschedule('credito-reducao-auto'); (as linhas de redução ficam como trilha).
-- ============================================================

-- ── 0. Guarda de drift: os 3 corpos substituídos são os da PROD (pré-voo psql-ro 2026-11-26) ──
--     ou já são os desta migration (re-aplicação). Dois hashes EXATOS por função (Codex desenho P2).
DO $guarda$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.credito_aprovar_proposta(uuid,text)',                 '331de37f80c02ad166a559c8ed7c77cb', 'be6ce845a30e0783291bc6d692e97167'),
      ('private.credito_raizes_elegiveis()',                         '21f0380fb0b293ee0ba8dcf3d73a94ca', '0f119a19be79d37f35f5b78dff4de7e6'),
      ('public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)',   '9b113c73b33a9a478dcbe378e55faade', 'fa7e30aef95f0488baeef8dc453b9949')
    ) v(fn, prod, novo) LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(r.fn);
    IF v_md5 IS NULL OR v_md5 NOT IN (r.prod, r.novo) THEN
      RAISE EXCEPTION 'GUARDA credito-reducao-auto: % ausente ou divergente do pre-flight (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$guarda$;

-- ── 1. Status novo da proposta (previsto no spec §5.4) ─────────────────────────────────────
ALTER TABLE public.credito_limite_proposta DROP CONSTRAINT IF EXISTS credito_limite_proposta_status_check;
ALTER TABLE public.credito_limite_proposta ADD CONSTRAINT credito_limite_proposta_status_check
  CHECK (status IN ('pendente','aprovada','recusada','expirada','aplicada_auto_reducao'));

-- ── 2. Estado da varredura por raiz (retomável; legível pelo diagnóstico) ──────────────────
CREATE TABLE IF NOT EXISTS public.credito_reducao_verificacao (
  raiz uuid PRIMARY KEY,
  verificada_em timestamptz NOT NULL,
  resultado text NOT NULL,
  erro text CHECK (erro IS NULL OR length(erro) <= 500),
  detalhes jsonb
);

DO $rls$
DECLARE
  r record;
BEGIN
  ALTER TABLE public.credito_reducao_verificacao ENABLE ROW LEVEL SECURITY;
  -- fecho por ALLOWLIST (o default ACL de public dá DML também ao builder do Lovable)
  REVOKE ALL ON public.credito_reducao_verificacao FROM PUBLIC, anon, authenticated;
  FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
             FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.oid = 'public.credito_reducao_verificacao'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON public.credito_reducao_verificacao FROM %s', r.papel);
  END LOOP;
  GRANT SELECT ON public.credito_reducao_verificacao TO service_role;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT SELECT ON public.credito_reducao_verificacao TO claude_ro;
  END IF;
END
$rls$;

-- ── 3. Ordem de risco (o que "não melhora" quer dizer) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION private.credito_risco_rank(p_risco text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  -- risco fora do vocabulário é ERRO, nunca NULL (uma comparação NULL passaria por "não melhorou")
  IF p_risco IS NULL OR p_risco NOT IN ('baixo','medio','sem_evidencia','alto') THEN
    RAISE EXCEPTION 'credito_risco_rank: risco fora do vocabulário (%)', p_risco USING ERRCODE = '22023';
  END IF;
  RETURN CASE p_risco WHEN 'baixo' THEN 0 WHEN 'medio' THEN 1 WHEN 'sem_evidencia' THEN 2 ELSE 3 END;
END;
$$;

-- ── 4. O ÚNICO writer de credito_limite ────────────────────────────────────────────────────
-- Lê os valores DA proposta (nunca de parâmetro); a versão do vigente tem de ser a esperada E a
-- versão-base da proposta. Toma o lock do grupo ele mesmo (re-entrante na transação).
CREATE OR REPLACE FUNCTION private.credito_limite_gravar(p_proposta_id uuid, p_aprovado_por uuid, p_versao_esperada integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_p public.credito_limite_proposta%ROWTYPE;
  v_l public.credito_limite%ROWTYPE;
  v_tem boolean;
  v_nova integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'credito_limite_gravar: exige READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = p_proposta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credito_limite_gravar: proposta inexistente' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || v_p.grupo_user_id::text, 0));
  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = p_proposta_id FOR UPDATE;
  SELECT * INTO v_l FROM public.credito_limite WHERE grupo_user_id = v_p.grupo_user_id FOR UPDATE;
  v_tem := FOUND;
  IF (CASE WHEN v_tem THEN v_l.versao END) IS DISTINCT FROM p_versao_esperada
     OR p_versao_esperada IS DISTINCT FROM v_p.limite_versao_base THEN
    RAISE EXCEPTION 'credito_limite_gravar: versao_divergente (vigente %, esperada %, base da proposta %)',
      CASE WHEN v_tem THEN v_l.versao END, p_versao_esperada, v_p.limite_versao_base USING ERRCODE = 'P0001';
  END IF;
  v_nova := COALESCE(p_versao_esperada, 0) + 1;

  IF v_p.status = 'pendente' THEN
    -- aprovação: quem chama já conferiu allowlist, ficha, teto, titularidade e deterioração
    IF p_aprovado_por IS NULL THEN
      RAISE EXCEPTION 'credito_limite_gravar: aprovação sem aprovador' USING ERRCODE = '22023';
    END IF;
    PERFORM public.credito_portao(v_p.grupo_user_id::text);
    INSERT INTO public.credito_limite AS l (
      grupo_user_id, limite_brl, prazo_max_dias, risco, versao, grupo_assinatura,
      ficha_calculada_em, origem_proposta_id, aprovado_por, vigente_desde)
    VALUES (v_p.grupo_user_id, v_p.limite_sugerido_brl, v_p.prazo_max_dias, v_p.risco, v_nova,
            v_p.grupo_assinatura, v_p.ficha_calculada_em, v_p.id, p_aprovado_por, now())
    ON CONFLICT (grupo_user_id) DO UPDATE SET
      limite_brl = EXCLUDED.limite_brl, prazo_max_dias = EXCLUDED.prazo_max_dias,
      risco = EXCLUDED.risco, versao = EXCLUDED.versao, grupo_assinatura = EXCLUDED.grupo_assinatura,
      ficha_calculada_em = EXCLUDED.ficha_calculada_em, origem_proposta_id = EXCLUDED.origem_proposta_id,
      aprovado_por = EXCLUDED.aprovado_por, vigente_desde = EXCLUDED.vigente_desde;
  ELSIF v_p.status = 'aplicada_auto_reducao' THEN
    IF p_aprovado_por IS NOT NULL THEN
      RAISE EXCEPTION 'credito_limite_gravar: redução automática não tem aprovador' USING ERRCODE = '22023';
    END IF;
    IF NOT v_tem THEN
      RAISE EXCEPTION 'credito_limite_gravar: reducao_sem_vigente' USING ERRCODE = 'P0001';
    END IF;
    -- só a linha de redução DESTA transação (uma antiga reaplicada nunca vale)
    IF v_p.decidido_em IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'credito_limite_gravar: reducao_de_outra_transacao' USING ERRCODE = 'P0001';
    END IF;
    IF v_p.limite_sugerido_brl > v_l.limite_brl OR v_p.prazo_max_dias > v_l.prazo_max_dias
       OR private.credito_risco_rank(v_p.risco) < private.credito_risco_rank(v_l.risco) THEN
      RAISE EXCEPTION 'credito_limite_gravar: reducao_aumentaria' USING ERRCODE = 'P0001';
    END IF;
    IF NOT (v_p.limite_sugerido_brl < v_l.limite_brl OR v_p.prazo_max_dias < v_l.prazo_max_dias
            OR private.credito_risco_rank(v_p.risco) > private.credito_risco_rank(v_l.risco)) THEN
      -- versão +1 sem piora invalidaria o lastro das reservas à toa (Codex desenho P1-4)
      RAISE EXCEPTION 'credito_limite_gravar: reducao_sem_piora' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.credito_portao(v_p.grupo_user_id::text);
    UPDATE public.credito_limite
       SET limite_brl = v_p.limite_sugerido_brl, prazo_max_dias = v_p.prazo_max_dias, risco = v_p.risco,
           versao = v_nova, origem_proposta_id = v_p.id, vigente_desde = now()
     WHERE grupo_user_id = v_p.grupo_user_id;
  ELSE
    RAISE EXCEPTION 'credito_limite_gravar: proposta % não grava vigente', v_p.status USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.credito_portao(NULL);
  RETURN v_nova;
END;
$$;

-- ── 5. Defesa em profundidade: cada linha do vigente casa com a proposta que a autorizou ───
CREATE OR REPLACE FUNCTION public.credito_limite_lastro()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_p public.credito_limite_proposta%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = NEW.origem_proposta_id;
  IF NOT FOUND OR v_p.grupo_user_id IS DISTINCT FROM NEW.grupo_user_id
     OR v_p.limite_sugerido_brl IS DISTINCT FROM NEW.limite_brl
     OR v_p.prazo_max_dias IS DISTINCT FROM NEW.prazo_max_dias
     OR v_p.risco IS DISTINCT FROM NEW.risco THEN
    RAISE EXCEPTION 'credito_limite: linha não casa com a proposta de origem' USING ERRCODE = '42501';
  END IF;
  IF v_p.status = 'pendente' THEN
    IF NOT EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = NEW.aprovado_por)
       OR NEW.grupo_assinatura IS DISTINCT FROM v_p.grupo_assinatura
       OR NEW.ficha_calculada_em IS DISTINCT FROM v_p.ficha_calculada_em THEN
      RAISE EXCEPTION 'credito_limite: aprovação fora da allowlist ou fora da proposta' USING ERRCODE = '42501';
    END IF;
  ELSIF v_p.status = 'aplicada_auto_reducao' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'credito_limite: redução automática não cria vigente' USING ERRCODE = '42501';
    END IF;
    IF NEW.limite_brl > OLD.limite_brl OR NEW.prazo_max_dias > OLD.prazo_max_dias
       OR private.credito_risco_rank(NEW.risco) < private.credito_risco_rank(OLD.risco)
       OR NEW.grupo_assinatura IS DISTINCT FROM OLD.grupo_assinatura
       OR NEW.ficha_calculada_em IS DISTINCT FROM OLD.ficha_calculada_em
       OR NEW.aprovado_por IS DISTINCT FROM OLD.aprovado_por
       OR NEW.versao IS DISTINCT FROM OLD.versao + 1
       OR v_p.limite_versao_base IS DISTINCT FROM OLD.versao
       -- ≥ 1 piora estrita: versão +1 sem piora invalidaria o lastro das reservas à toa
       OR NOT (NEW.limite_brl < OLD.limite_brl OR NEW.prazo_max_dias < OLD.prazo_max_dias
               OR private.credito_risco_rank(NEW.risco) > private.credito_risco_rank(OLD.risco)) THEN
      RAISE EXCEPTION 'credito_limite: redução automática só desce e preserva a aprovação' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'credito_limite: origem com status % não grava vigente', v_p.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.credito_limite_lastro() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS credito_limite_lastro ON public.credito_limite;
CREATE TRIGGER credito_limite_lastro BEFORE INSERT OR UPDATE ON public.credito_limite
  FOR EACH ROW EXECUTE FUNCTION public.credito_limite_lastro();

-- ── 6. Vigente revisável (a redução cortou, ou a composição mudou) — elegibilidade e writer ─
CREATE OR REPLACE FUNCTION private.credito_vigente_revisavel(p_raiz uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.credito_limite l
      LEFT JOIN public.credito_limite_proposta p ON p.id = l.origem_proposta_id
     WHERE l.grupo_user_id = p_raiz
       AND (p.status = 'aplicada_auto_reducao'
            OR l.grupo_assinatura IS DISTINCT FROM public.credito_grupo_assinatura(p_raiz)));
$$;

-- ── 7. Laço da edge: inclui o vigente revisável (corpo de prod + o ramo 5b) ─────────────────
CREATE OR REPLACE FUNCTION private.credito_raizes_elegiveis()
RETURNS TABLE(raiz uuid, ultima_proposta_em timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.raiz, a.ultima_proposta_em
    -- carteira ativa ∪ todo vigente: o vigente revisável de cliente fora da carteira (sem título em
    -- aberto e sem emissão em 180 d) também precisa voltar ao Lucas (Codex diff P1-4)
    FROM (SELECT ca.raiz FROM public.credito_carteira_ativa() ca
          UNION
          SELECT lv.grupo_user_id FROM public.credito_limite lv) c
    LEFT JOIN public.credito_avaliacao a ON a.raiz = c.raiz
    LEFT JOIN public.credito_limite l ON l.grupo_user_id = c.raiz
   WHERE (a.raiz IS NULL OR a.proxima_tentativa_em IS NULL OR a.proxima_tentativa_em <= now())
     AND CASE
           -- sem vigente: o laço do PR 4 (1ª leva + reavaliação semanal)
           WHEN l.grupo_user_id IS NULL THEN
             a.raiz IS NULL OR a.ultima_proposta_em IS NULL OR a.ultima_proposta_em < now() - interval '7 days'
           -- 5b: vigente REVISÁVEL (cortado pela redução, ou composição mudada) — a 1ª proposta da IA
           -- sobre a versão vigente sai já; depois, semanal. É o caminho de volta (só sobe pelo Lucas).
           WHEN private.credito_vigente_revisavel(c.raiz) THEN
             NOT EXISTS (SELECT 1 FROM public.credito_limite_proposta p
                          WHERE p.grupo_user_id = c.raiz AND p.limite_versao_base = l.versao
                            AND p.status <> 'aplicada_auto_reducao')
             OR a.ultima_proposta_em IS NULL OR a.ultima_proposta_em < now() - interval '7 days'
           -- vigente aprovado e íntegro: fora (a redução automática o vigia)
           ELSE false
         END;
$$;

-- ── 8. Writer da proposta: aceita o vigente revisável (corpo de prod + o ramo 5b) ───────────
CREATE OR REPLACE FUNCTION public.credito_registrar_avaliacao(
  p_token uuid,
  p_raiz uuid,
  p_proposta jsonb,
  p_erro text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a public.credito_avaliacao%ROWTYPE;
  v_f jsonb;
  v_lim numeric;
  v_prazo integer;
  v_risco text;
  v_em timestamptz;
  v_fr jsonb;
  v_old uuid;
  v_id uuid;
  v_vig public.credito_limite%ROWTYPE;
BEGIN
  IF p_token IS NULL OR p_raiz IS NULL THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: token e raiz obrigatórios' USING ERRCODE = '22023';
  END IF;
  -- mesma fila da aprovação e do gate do grupo
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || p_raiz::text, 0));
  SELECT * INTO v_a FROM public.credito_avaliacao WHERE raiz = p_raiz FOR UPDATE;
  IF NOT FOUND OR v_a.token IS DISTINCT FROM p_token OR v_a.reivindicada_ate < now() THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: reivindicacao_perdida (raiz %)', p_raiz USING ERRCODE = 'P0001';
  END IF;

  IF p_proposta IS NULL THEN
    -- falha: backoff persistido (15 min × 2^tentativas, teto 24 h); a raiz volta sozinha
    UPDATE public.credito_avaliacao
       SET tentativas = tentativas + 1,
           proxima_tentativa_em = now() + LEAST(interval '15 minutes' * power(2, LEAST(tentativas, 10)), interval '24 hours'),
           ultimo_erro = left(COALESCE(NULLIF(btrim(p_erro), ''), 'erro_nao_informado'), 500),
           ultima_avaliacao_em = now(), token = NULL, reivindicada_ate = NULL
     WHERE raiz = p_raiz;
    RETURN NULL;
  END IF;

  v_f := p_proposta -> 'ficha';
  IF v_f IS NULL OR jsonb_typeof(v_f) <> 'object' THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: ficha ausente' USING ERRCODE = '22023';
  END IF;
  IF (v_f ->> 'raiz') IS DISTINCT FROM p_raiz::text THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: ficha de outra raiz' USING ERRCODE = '22023';
  END IF;
  IF (v_f ->> 'assinatura') IS DISTINCT FROM public.credito_grupo_assinatura(p_raiz) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: grupo_mudou desde a ficha' USING ERRCODE = 'P0001';
  END IF;
  v_em := (v_f ->> 'calculada_em')::timestamptz;
  IF v_em IS NULL OR v_em < now() - interval '30 minutes' OR v_em > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: ficha fora da janela de 30 min' USING ERRCODE = 'P0001';
  END IF;
  -- escopo do PR 4 = grupo SEM vigente (o vigente é da sombra do PR 5). Cobre também a corrida
  -- "o Lucas aprovou a pendente anterior enquanto esta raiz estava reivindicada" (Codex diff P2-7).
  -- 5b: grupo COM vigente só entra quando o vigente é REVISÁVEL (cortado pela redução automática, ou
  -- com a composição do grupo mudada) e a ficha foi calculada sobre a versão vigente — reconferido sob
  -- o lock (Codex desenho 5b v2 P1-1). Fora disso continua o escopo do PR 4 (grupo SEM vigente).
  SELECT * INTO v_vig FROM public.credito_limite l WHERE l.grupo_user_id = p_raiz FOR UPDATE;
  IF FOUND AND NOT (private.credito_vigente_revisavel(p_raiz)
                    AND (v_f ->> 'limite_versao_base')::integer IS NOT DISTINCT FROM v_vig.versao) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: grupo_com_limite_vigente' USING ERRCODE = 'P0001';
  END IF;
  -- a ficha enviada é conferida contra a RECALCULADA agora: tetos, piso, estado, evidência e risco
  -- forçado têm de bater, e nenhum vencido > 15 d novo (Codex diff P1-1 — a assinatura só cobre os pares)
  v_fr := public.credito_ficha(p_raiz);
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['piso_estado','estado_historico','teto_limite_brl','teto_prazo_dias',
                                        'risco_forcado','evidencia_suficiente']) k
              WHERE (v_fr -> k) IS DISTINCT FROM (v_f -> k))
     OR (v_fr ->> 'n_titulos_vencidos_15d')::integer > COALESCE((v_f ->> 'n_titulos_vencidos_15d')::integer, -1) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: ficha_superada (a ficha enviada difere da recalculada)' USING ERRCODE = 'P0001';
  END IF;

  v_lim := (p_proposta ->> 'limite_brl')::numeric;
  v_prazo := (p_proposta ->> 'prazo_max_dias')::integer;
  v_risco := p_proposta ->> 'risco';
  -- invariantes da política (espelho das travas da edge; a ficha é a fonte dos tetos)
  IF v_lim IS NULL OR v_prazo IS NULL OR v_risco IS NULL
     OR (v_f ->> 'teto_limite_brl') IS NULL OR (v_f ->> 'teto_prazo_dias') IS NULL THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (campo nulo)' USING ERRCODE = '22023';
  END IF;
  IF v_lim < 0 OR v_lim % 100 <> 0 OR v_lim > (v_f ->> 'teto_limite_brl')::numeric THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (limite % > teto % ou fora do degrau de R$ 100)',
      v_lim, v_f ->> 'teto_limite_brl' USING ERRCODE = '22023';
  END IF;
  IF v_prazo > (v_f ->> 'teto_prazo_dias')::integer
     OR NOT (v_prazo = ANY (ARRAY[0,7,14,21,28,35,42,56,63,70,84,90,120])) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (prazo % fora do teto %/degraus)',
      v_prazo, v_f ->> 'teto_prazo_dias' USING ERRCODE = '22023';
  END IF;
  IF (v_lim = 0) <> (v_prazo = 0) THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (limite 0 ⇔ prazo 0)' USING ERRCODE = '22023';
  END IF;
  IF (v_f ->> 'risco_forcado') IS NOT NULL AND v_risco IS DISTINCT FROM (v_f ->> 'risco_forcado') THEN
    RAISE EXCEPTION 'credito_registrar_avaliacao: trava_violada (risco % ≠ forçado %)',
      v_risco, v_f ->> 'risco_forcado' USING ERRCODE = '22023';
  END IF;

  -- a pendente anterior sai como EXPIRADA (≠ recusada: o sensor mede só decisão do Lucas)
  FOR v_old IN SELECT p.id FROM public.credito_limite_proposta p
                WHERE p.grupo_user_id = p_raiz AND p.status = 'pendente' FOR UPDATE LOOP
    PERFORM public.credito_portao(v_old::text);
    UPDATE public.credito_limite_proposta
       SET status = 'expirada', decidido_em = now(), motivo_decisao = 'substituida_por_reavaliacao'
     WHERE id = v_old AND status = 'pendente';
  END LOOP;
  PERFORM public.credito_portao(NULL);

  v_id := public.credito_propor_limite(
    p_raiz, v_lim, v_prazo, v_risco, (p_proposta ->> 'confianca')::numeric, v_f,
    p_proposta -> 'saida_ia', p_proposta -> 'travas', p_proposta ->> 'modelo',
    p_proposta ->> 'versao_politica', v_em, v_f ->> 'assinatura', (v_f ->> 'limite_versao_base')::integer);

  UPDATE public.credito_avaliacao
     SET tentativas = 0, proxima_tentativa_em = NULL, ultimo_erro = NULL,
         ultima_avaliacao_em = now(), ultima_proposta_em = now(), ultima_proposta_id = v_id,
         token = NULL, reivindicada_ate = NULL
   WHERE raiz = p_raiz;
  RETURN v_id;
END;
$$;

-- ── 9. Aprovação: corpo de prod, gravando pelo writer único ────────────────────────────────
CREATE OR REPLACE FUNCTION public.credito_aprovar_proposta(p_proposta_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.credito_limite_proposta%ROWTYPE;
  v_versao_atual integer;
  v_nova integer;
  v_fr jsonb;
BEGIN
  IF NOT (COALESCE(private.cap_credito_escrever(v_uid), false)
          AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = v_uid)) THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: só o aprovador de crédito decide' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = p_proposta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta inexistente' USING ERRCODE = 'P0002';
  END IF;
  -- mesma fila da reserva: aprovação e gate do grupo não se cruzam
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || v_p.grupo_user_id::text, 0));
  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = p_proposta_id FOR UPDATE;
  IF v_p.status <> 'pendente' THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta_nao_pendente (%)', v_p.status USING ERRCODE = 'P0001';
  END IF;
  SELECT l.versao INTO v_versao_atual FROM public.credito_limite l
   WHERE l.grupo_user_id = v_p.grupo_user_id FOR UPDATE;
  IF v_versao_atual IS DISTINCT FROM v_p.limite_versao_base THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta_desatualizada (base %, vigente %)',
      v_p.limite_versao_base, v_versao_atual USING ERRCODE = 'P0001';
  END IF;
  IF public.credito_grupo_assinatura(v_p.grupo_user_id) IS DISTINCT FROM v_p.grupo_assinatura THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: grupo_mudou desde a proposta' USING ERRCODE = 'P0001';
  END IF;
  -- PR 4 (Codex desenho P1-5): a ficha envelhece, a titularidade muda sem mudar os pares, o
  -- cliente piora entre a ficha e o clique — nenhum deles pode virar limite vigente.
  IF v_p.ficha_calculada_em < now() - interval '14 days' THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: ficha_vencida (calculada em %)', v_p.ficha_calculada_em
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.credito_grupo_pares(v_p.grupo_user_id) g
              WHERE (public.credito_grupo_raiz(g.company, g.omie_codigo_cliente) ->> 'raiz')
                    IS DISTINCT FROM v_p.grupo_user_id::text) THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: grupo_mudou (titularidade de um par)' USING ERRCODE = 'P0001';
  END IF;
  -- a ficha de HOJE manda: o teto cai quando venda sai da janela, o piso zera o teto, o cadastro
  -- irregular força o risco (Codex diff P1-2). Teto ausente = 0 (lado seguro).
  v_fr := public.credito_ficha(v_p.grupo_user_id);
  IF v_p.limite_sugerido_brl > COALESCE((v_fr ->> 'teto_limite_brl')::numeric, 0)
     OR v_p.prazo_max_dias > COALESCE((v_fr ->> 'teto_prazo_dias')::integer, 0)
     OR ((v_fr ->> 'risco_forcado') IS NOT NULL AND v_p.risco IS DISTINCT FROM (v_fr ->> 'risco_forcado')) THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: ficha_superada (teto ou risco de hoje abaixo da proposta)' USING ERRCODE = 'P0001';
  END IF;
  IF (v_p.ficha ->> 'n_titulos_vencidos_15d') IS NULL
     OR (v_fr ->> 'n_titulos_vencidos_15d')::integer > (v_p.ficha ->> 'n_titulos_vencidos_15d')::integer THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: ficha_superada (o grupo piorou desde a ficha)' USING ERRCODE = 'P0001';
  END IF;

  -- 5b: o vigente tem UM writer (private.credito_limite_gravar); a versão devolvida é a gravada
  v_nova := private.credito_limite_gravar(v_p.id, v_uid, v_versao_atual);

  PERFORM public.credito_portao(v_p.id::text);
  UPDATE public.credito_limite_proposta
     SET status = 'aprovada', decidido_por = v_uid, decidido_em = now(), motivo_decisao = p_motivo
   WHERE id = v_p.id AND status = 'pendente';
  PERFORM public.credito_portao(NULL);
  RETURN jsonb_build_object('grupo_user_id', v_p.grupo_user_id, 'versao', v_nova,
                            'limite_brl', v_p.limite_sugerido_brl, 'prazo_max_dias', v_p.prazo_max_dias);
END;
$function$;

-- ── 10. A redução de UMA raiz (sob o lock do grupo; não escreve por dado ausente) ──────────
-- Lock de SESSÃO para ler: sem corte, solta na hora (o gate daquela raiz não espera o fim do lote).
-- Com corte, troca pelo lock de TRANSAÇÃO antes de escrever (segura até o COMMIT — Codex diff P1-3).
CREATE OR REPLACE FUNCTION private.credito_reduzir_limite(p_raiz uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_k bigint;
  v_l public.credito_limite%ROWTYPE;
  v_f jsonb;
  v_mudou boolean;
  v_hoje date;
  v_base date;
  v_lim numeric;
  v_prazo integer;
  v_risco text;
  v_travas jsonb := '[]'::jsonb;
  v_regras text[] := ARRAY[]::text[];
  v_avisos text[] := ARRAY[]::text[];
  v_sync_ok boolean;
  v_novos integer;
  v_titulos numeric;
  v_indet boolean;
  v_reservas numeric;
  v_corte numeric;
  v_id uuid;
  v_versao integer;
BEGIN
  IF p_raiz IS NULL THEN
    RAISE EXCEPTION 'credito_reduzir_limite: raiz obrigatória' USING ERRCODE = '22023';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'credito_reduzir_limite: exige READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  -- mesma chave da aprovação, do registro e do gate; TUDO o mais é lido depois do lock
  v_k := hashtextextended('credito_grupo:' || p_raiz::text, 0);
  PERFORM pg_advisory_lock(v_k);
  -- leitura SEM FOR UPDATE: todo writer do vigente toma este lock; um lock de linha aqui ficaria
  -- até o fim do lote e seguraria a aprovação
  SELECT * INTO v_l FROM public.credito_limite WHERE grupo_user_id = p_raiz;
  IF NOT FOUND THEN
    PERFORM pg_advisory_unlock(v_k);
    RETURN jsonb_build_object('resultado', 'sem_vigente');
  END IF;
  -- base = data SP da ÚLTIMA ficha aprovada pelo Lucas (o writer preserva ficha_calculada_em na
  -- redução; ler a ficha da origem perderia o título após o 1º corte — Codex desenho v2 P1-3)
  v_base := (v_l.ficha_calculada_em AT TIME ZONE 'America/Sao_Paulo')::date;

  -- UM snapshot (Codex diff P1-2): identidade, ficha (STABLE ⇒ o snapshot do comando que a chama),
  -- causador do E2, exposição e reservas vêm do MESMO comando — nada de combinar leituras de momentos
  -- diferentes. Identidade mudada ⇒ não corta pela ficha de outro grupo (o gate já dá 🟡).
  SELECT (public.credito_grupo_assinatura(p_raiz) IS DISTINCT FROM v_l.grupo_assinatura
          OR EXISTS (SELECT 1 FROM public.credito_grupo_pares(p_raiz) g
                      WHERE (public.credito_grupo_raiz(g.company, g.omie_codigo_cliente) ->> 'raiz')
                            IS DISTINCT FROM p_raiz::text)),
         CASE WHEN EXISTS (SELECT 1 FROM public.credito_grupo_pares(p_raiz)) THEN public.credito_ficha(p_raiz) END,
         t.novos, t.titulos, t.indet, r.reservas
    INTO v_mudou, v_f, v_novos, v_titulos, v_indet, v_reservas
    FROM (SELECT count(*) FILTER (WHERE (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL')
                                    AND f.data_vencimento <= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 15
                                    AND f.data_vencimento > v_base - 15) AS novos,
                 COALESCE(sum(f.saldo) FILTER (WHERE f.saldo > 0), 0) AS titulos,
                 -- mesma régua de valor desconhecido de credito_sinais_grupo
                 COALESCE(bool_or(f.saldo IS NULL OR (f.status_titulo = 'PAGTO PARCIAL' AND f.saldo <= 0)), false) AS indet
            FROM (SELECT DISTINCT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(p_raiz) g) p
            JOIN public.fin_contas_receber f ON f.company = p.company AND f.omie_codigo_cliente = p.omie_codigo_cliente
           WHERE f.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL')) t,
         -- reservas efetivas ativas do grupo, cada uma uma vez: pelo par atual OU pela raiz que a gravou
         (SELECT COALESCE(sum(rr.valor_brl), 0) AS reservas
            FROM public.credito_reserva rr
           WHERE rr.status = 'ativa' AND rr.modo = 'efetivo'
             AND (rr.grupo_user_id = p_raiz
                  OR EXISTS (SELECT 1 FROM public.credito_grupo_pares(p_raiz) g
                              WHERE g.company = rr.company AND g.omie_codigo_cliente = rr.omie_codigo_cliente))) r;
  IF v_mudou OR v_f IS NULL THEN
    PERFORM pg_advisory_unlock(v_k);
    RETURN jsonb_build_object('resultado', 'grupo_mudou', 'versao', v_l.versao);
  END IF;

  v_hoje := (v_f ->> 'hoje_sp')::date;
  v_lim := v_l.limite_brl; v_prazo := v_l.prazo_max_dias; v_risco := v_l.risco;
  -- evidência FINANCEIRA (E1, E2) só com o espelho do CR em dia nas empresas do grupo: título pago no
  -- Omie e ainda aberto no espelho não pode virar corte permanente (Codex diff P1-1)
  v_sync_ok := NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_f -> 'motivos_ausencia') m
                            WHERE m LIKE 'sync_defasado:%');
  IF NOT v_sync_ok THEN
    v_avisos := v_avisos || 'sync_defasado'::text;
  END IF;

  -- E1 piso comprovado (vencido ≥ 60 d com saldo; mesma régua do piso) ⇒ 0 / 0 / alto
  IF v_sync_ok AND v_f ->> 'piso_estado' = 'comprovado' THEN
    IF v_lim > 0 OR v_prazo > 0 OR private.credito_risco_rank(v_risco) < 3 THEN
      v_travas := v_travas || jsonb_build_object('regra', 'E1_piso_comprovado', 'campo', 'piso_estado',
        'n_titulos_vencidos_60d', v_f -> 'n_titulos_vencidos_60d',
        'antes', jsonb_build_object('limite_brl', v_lim, 'prazo_max_dias', v_prazo, 'risco', v_risco),
        'depois', jsonb_build_object('limite_brl', 0, 'prazo_max_dias', 0, 'risco', 'alto'));
      v_regras := v_regras || 'E1_piso_comprovado'::text;
      v_lim := 0; v_prazo := 0; v_risco := 'alto';
    END IF;
  ELSIF v_f ->> 'piso_estado' = 'indeterminado' THEN
    v_avisos := v_avisos || 'piso_indeterminado'::text;   -- dado ausente: não corta (o gate segura)
  END IF;

  -- E2 título aberto que cruzou 15 d de atraso DEPOIS da ficha aprovada (régua ≥ 15 d de
  -- credito_sinais_grupo, a mesma da aprovação) ⇒ "nada novo": limite = títulos + reservas efetivas
  IF v_sync_ok AND v_novos > 0 AND v_lim > 0 THEN
    IF v_indet THEN
      v_avisos := v_avisos || 'exposicao_indeterminada'::text;   -- não fabrica exposição: não corta
    ELSE
      v_corte := floor((v_titulos + v_reservas) / 100) * 100;
      IF v_corte < v_lim THEN
        v_travas := v_travas || jsonb_build_object('regra', 'E2_vencido_15d_novo', 'campo', 'em_aberto_brl',
          'n_titulos_novos', v_novos, 'base_sp', v_base, 'titulos_brl', v_titulos, 'reservas_brl', v_reservas,
          'antes', jsonb_build_object('limite_brl', v_lim), 'depois', jsonb_build_object('limite_brl', v_corte));
        v_regras := v_regras || 'E2_vencido_15d_novo'::text;
        v_lim := v_corte;
      END IF;
    END IF;
  END IF;

  -- E3 cadastro irregular no lote publicado do Radar ⇒ risco alto (limite intacto)
  IF v_f ->> 'situacao_cadastral' = 'irregular' AND private.credito_risco_rank(v_risco) < 3 THEN
    v_travas := v_travas || jsonb_build_object('regra', 'E3_cadastro_irregular', 'campo', 'situacao_cadastral',
      'antes', jsonb_build_object('risco', v_risco), 'depois', jsonb_build_object('risco', 'alto'));
    v_regras := v_regras || 'E3_cadastro_irregular'::text;
    v_risco := 'alto';
  END IF;

  -- fecho: limite 0 ⇔ prazo 0 (o invariante do writer de proposta)
  IF v_lim = 0 AND v_prazo > 0 THEN
    v_prazo := 0;
  END IF;

  IF cardinality(v_regras) = 0 THEN
    PERFORM pg_advisory_unlock(v_k);
    RETURN jsonb_build_object('resultado', 'sem_mudanca', 'versao', v_l.versao, 'avisos', to_jsonb(v_avisos));
  END IF;

  -- vai escrever: o lock passa a ser da TRANSAÇÃO (re-entrante: já é nosso) e o de sessão sai
  PERFORM pg_advisory_xact_lock(v_k);
  PERFORM pg_advisory_unlock(v_k);

  -- trilha: a redução é uma linha de proposta já decidida (ficha de hoje, cortes antes/depois)
  v_id := gen_random_uuid();
  PERFORM public.credito_portao(v_id::text);
  INSERT INTO public.credito_limite_proposta (
    id, grupo_user_id, grupo_assinatura, limite_versao_base, limite_sugerido_brl, prazo_max_dias, risco,
    confianca, ficha, saida_ia, travas, modelo, versao_politica, ficha_calculada_em,
    status, decidido_por, decidido_em, motivo_decisao)
  VALUES (v_id, p_raiz, v_l.grupo_assinatura, v_l.versao, v_lim, v_prazo, v_risco,
          NULL, v_f, NULL, v_travas, NULL, 'reducao-auto-v1', (v_f ->> 'calculada_em')::timestamptz,
          'aplicada_auto_reducao', NULL, now(),
          'reducao_automatica: ' || array_to_string(v_regras, ','));
  PERFORM public.credito_portao(NULL);
  -- o writer relê o vigente FOR UPDATE e confere a versão: se ele mudou, recusa (nada sobrescreve)
  v_versao := private.credito_limite_gravar(v_id, NULL, v_l.versao);
  RETURN jsonb_build_object('resultado', 'reduzido', 'proposta_id', v_id, 'versao', v_versao,
    'regras', to_jsonb(v_regras), 'avisos', to_jsonb(v_avisos),
    'antes', jsonb_build_object('limite_brl', v_l.limite_brl, 'prazo_max_dias', v_l.prazo_max_dias, 'risco', v_l.risco),
    'depois', jsonb_build_object('limite_brl', v_lim, 'prazo_max_dias', v_prazo, 'risco', v_risco));
END;
$$;

-- ── 11. O lote do cron: ≤ p_max raízes, menos recente primeiro, cada uma num sub-bloco ──────
-- Para na 1ª REDUÇÃO: no máximo um corte por transação, e o único lock que sobra até o COMMIT é o
-- dessa raiz (as verificadas sem corte já soltaram o lock de sessão). Um timeout depois do corte não
-- existe: o corte é a última coisa do lote (Codex diff P1-3).
CREATE OR REPLACE FUNCTION private.credito_reducao_lote(p_max integer DEFAULT 25, p_orcamento_seg integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_ini timestamptz := clock_timestamp();
  v_res jsonb;
  v_cont jsonb := '{}'::jsonb;
  v_k text;
  v_state text;
  v_msg text;
  v_n integer := 0;
BEGIN
  IF p_max IS NULL OR p_max < 1 OR p_max > 200 OR p_orcamento_seg IS NULL OR p_orcamento_seg < 1 OR p_orcamento_seg > 120 THEN
    RAISE EXCEPTION 'credito_reducao_lote: parâmetros fora da faixa (max 1..200, orçamento 1..120 s)' USING ERRCODE = '22023';
  END IF;
  -- grupo ocupado (gate/aprovação segurando o lock) não trava o lote: vira erro 55P03 e volta depois
  PERFORM set_config('lock_timeout', '2s', true);
  FOR r IN SELECT l.grupo_user_id AS raiz
             FROM public.credito_limite l
             LEFT JOIN public.credito_reducao_verificacao v ON v.raiz = l.grupo_user_id
            ORDER BY v.verificada_em NULLS FIRST, l.grupo_user_id
            LIMIT p_max LOOP
    EXIT WHEN clock_timestamp() - v_ini > make_interval(secs => p_orcamento_seg);
    v_n := v_n + 1;
    BEGIN
      v_res := private.credito_reduzir_limite(r.raiz);
      v_k := v_res ->> 'resultado';
      INSERT INTO public.credito_reducao_verificacao AS v (raiz, verificada_em, resultado, erro, detalhes)
      VALUES (r.raiz, now(), v_k, NULL, v_res)
      ON CONFLICT (raiz) DO UPDATE SET verificada_em = EXCLUDED.verificada_em, resultado = EXCLUDED.resultado,
                                       erro = NULL, detalhes = EXCLUDED.detalhes;
    EXCEPTION WHEN OTHERS THEN
      -- resultado POR raiz (não é teste): o erro de uma não desfaz as outras; fica registrado
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      -- o lock de SESSÃO não sai com o rollback do sub-bloco: solta aqui (o backend do cron não tem outro)
      PERFORM pg_advisory_unlock_all();
      v_k := 'erro';
      INSERT INTO public.credito_reducao_verificacao AS v (raiz, verificada_em, resultado, erro, detalhes)
      VALUES (r.raiz, now(), 'erro', left(v_state || ':' || v_msg, 500), NULL)
      ON CONFLICT (raiz) DO UPDATE SET verificada_em = EXCLUDED.verificada_em, resultado = 'erro',
                                       erro = EXCLUDED.erro, detalhes = NULL;
    END;
    v_cont := v_cont || jsonb_build_object(v_k, COALESCE((v_cont ->> v_k)::integer, 0) + 1);
    EXIT WHEN v_k = 'reduzido';
  END LOOP;
  RETURN jsonb_build_object('raizes', v_n, 'por_resultado', v_cont,
                            'segundos', round(extract(epoch FROM clock_timestamp() - v_ini)::numeric, 1));
END;
$$;

-- ── 12. ACL: tudo privado (só o dono — o pg_cron roda como postgres); aprovar segue authenticated ─
DO $acl$
DECLARE
  f record;
  g record;
BEGIN
  FOR f IN SELECT * FROM (VALUES
      ('private.credito_risco_rank(text)',                           ARRAY[]::text[]),
      ('private.credito_limite_gravar(uuid,uuid,integer)',           ARRAY[]::text[]),
      ('private.credito_vigente_revisavel(uuid)',                    ARRAY[]::text[]),
      ('private.credito_raizes_elegiveis()',                         ARRAY[]::text[]),
      ('private.credito_reduzir_limite(uuid)',                       ARRAY[]::text[]),
      ('private.credito_reducao_lote(integer,integer)',              ARRAY[]::text[]),
      ('public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)',   ARRAY['service_role']),
      ('public.credito_aprovar_proposta(uuid,text)',                 ARRAY['authenticated'])
    ) v(fn, permitidos) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.fn);
    FOR g IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
              WHERE p.oid = to_regprocedure(f.fn) AND a.grantee <> 0 AND a.grantee <> p.proowner LOOP
      IF NOT (g.papel = ANY (f.permitidos)) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', f.fn, g.papel);
      END IF;
    END LOOP;
    FOR g IN SELECT unnest(f.permitidos) AS papel LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', f.fn, g.papel);
    END LOOP;
  END LOOP;
END
$acl$;

-- ── 13. Cron: lote curto a cada 5 min (inerte sem vigente) ─────────────────────────────────
DO $cron$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'credito-reducao-auto';
  PERFORM cron.schedule('credito-reducao-auto', '2-59/5 * * * *',
                        'SET statement_timeout = ''60s''; SELECT private.credito_reducao_lote(25, 20);');
END
$cron$;

-- ── 14. Pós-condição (aborta a transação do envelope se algo não pegou) ────────────────────
DO $post$
DECLARE
  f text;
  v_src text;
  v_n integer;
BEGIN
  -- 1 writer: nenhuma função além do writer faz DML em credito_limite (varre pg_proc inteiro)
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?credito_limite(\s|$|\()'
     AND p.oid <> to_regprocedure('private.credito_limite_gravar(uuid,uuid,integer)');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: % função(ões) além do writer escrevem em credito_limite', v_n;
  END IF;
  FOREACH f IN ARRAY ARRAY['private.credito_limite_gravar(uuid,uuid,integer)', 'private.credito_vigente_revisavel(uuid)',
                           'private.credito_reduzir_limite(uuid)', 'private.credito_reducao_lote(integer,integer)',
                           'public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)', 'private.credito_raizes_elegiveis()',
                           'public.credito_aprovar_proposta(uuid,text)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'POS FALHOU: % não existe', f;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'POS FALHOU: % não é SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['private.credito_limite_gravar(uuid,uuid,integer)', 'private.credito_reduzir_limite(uuid)',
                           'private.credito_reducao_lote(integer,integer)', 'private.credito_vigente_revisavel(uuid)',
                           'private.credito_risco_rank(text)'] LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('service_role', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname LIKE 'sandbox_exec%' AND has_function_privilege(r.oid, f, 'EXECUTE')) THEN
      RAISE EXCEPTION 'POS FALHOU: % não pode ser chamada de fora', f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.credito_aprovar_proposta(uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.credito_aprovar_proposta(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: credito_aprovar_proposta deveria ser só authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.credito_registrar_avaliacao(uuid,uuid,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: credito_registrar_avaliacao deveria ser só service_role';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.credito_aprovar_proposta(uuid,text)');
  IF position('ficha_superada' IN v_src) = 0 OR position('ficha_vencida' IN v_src) = 0
     OR position('private.credito_limite_gravar' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS FALHOU: credito_aprovar_proposta sem as travas do PR 4 ou sem o writer único';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.credito_limite'::regclass
                  AND tgname = 'credito_limite_lastro' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POS FALHOU: trigger credito_limite_lastro ausente ou desligado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.credito_limite_proposta'::regclass
                  AND conname = 'credito_limite_proposta_status_check'
                  AND pg_get_constraintdef(oid) LIKE '%aplicada_auto_reducao%') THEN
    RAISE EXCEPTION 'POS FALHOU: status aplicada_auto_reducao ausente do CHECK';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.credito_reducao_verificacao'::regclass)
     OR has_table_privilege('authenticated', 'public.credito_reducao_verificacao', 'SELECT')
     OR has_table_privilege('service_role', 'public.credito_reducao_verificacao', 'INSERT')
     OR has_table_privilege('anon', 'public.credito_reducao_verificacao', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: credito_reducao_verificacao sem RLS ou com acesso fora do desenho';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'credito-reducao-auto'
                  AND command LIKE '%statement_timeout%' AND command LIKE '%private.credito_reducao_lote(%') THEN
    RAISE EXCEPTION 'POS FALHOU: cron credito-reducao-auto ausente ou sem statement_timeout';
  END IF;
  RAISE NOTICE 'POSCONDICAO credito-reducao-auto OK';
END
$post$;
