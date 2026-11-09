-- =============================================================================
-- Radar, pacote L: o contato dá a posse, e a posse não vence para trás (2026-11-08)
-- =============================================================================
-- Manual (o Lovable não aplica custom migration). Ritual lovable-db-operator: pré-voo pg_get_functiondef da PROD
-- (db/fixtures/radar-l-predecessora-prod-20261108.sql + os corpos do pacote G, conferidos por md5 em 2026-11-08), prova
-- PG17 EXECUTANDO (db/test-radar-posse-l.sh, --falsificar), REVOKE nas duas pontas, conferência por psql-ro.
--
-- L1 registrar contato dá a posse: "em conversa" e "não atendeu" assumem o lead LIVRE, renovam o do PRÓPRIO e nunca
--    tomam o de outro vendedor. Antes, posse só com o botão "Assumir" — e radar_atendimentos tinha 0 linhas em prod.
--    O registro chama o escritor de sempre (public.radar_definir_atendimento) DEPOIS de gravar o contato: as regras
--    (já-cliente, teto de 100, dono sem acesso, vencida) são as dele. A resposta ganha a chave `posse` (aditiva).
--    Falha FECHADA: erro inesperado do assumir aborta o registro (o vendedor vê o erro e repete); recusa prevista
--    (de outro, limite, já-cliente) não é erro e o contato fica gravado.
--    Desfazer o contato que CRIOU a posse desfaz a posse (radar_atendimentos.contato_origem_id), se nenhum outro
--    contato do dono veio depois. Renovação feita pelo contato desfeito fica (só estendeu o prazo).
-- L2 a posse não vence retroativamente: o vencimento é UMA reconstrução cronológica — cada contato do dono, no instante
--    em que acontece, estende a cadeia (+7 dias) E define o compromisso vigente (o "em conversa" com retorno protege
--    até retorno+3 dias; outro desfecho do dono o substitui). Antes, a cadeia de 7 dias era reconstruída sem a proteção
--    e a proteção vinha só do contato dono do status HOJE: assumir 1/11, conversa 2/11 com retorno 30/11, nova conversa
--    20/11 → a posse aparecia vencida em 9/11 (achado do Codex na 3ª revisão do Radar).
--    Contato de OUTRO usuário não mexe na posse do dono (nem na proteção): senão a própria conversa do colega
--    derrubaria a proteção e o auto-assumir dele tomaria o lead (L1 "nunca tomar de outro").
--    Contato feito com a posse já vencida continua não ressuscitando a posse.
--
-- Revisão independente: Codex barrado pelo guard de cota (exit 79, 90%) → Caminho B (régua + revisor independente);
-- ver docs/historico/radar-posse-pacote-l-2026-11-08.md.
-- Molde TRAVA → PRE → CREATE → PÓS. Sem BEGIN/COMMIT no arquivo: a transação é do executor (`bun run db:aplicar`);
-- no SQL Editor, cole entre BEGIN; e COMMIT;.
-- =============================================================================

-- ── TRAVA ────────────────────────────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.registrar_contato_radar(text,text,text,date)') IS NULL
     OR to_regprocedure('private.radar_acompanhamentos(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: aplique o pacote G (20261111100000) antes';
  END IF;
  IF to_regprocedure('public.radar_definir_atendimento(text,text)') IS NULL
     OR to_regprocedure('public.desfazer_contato_radar(uuid)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_definir_atendimento ou desfazer_contato_radar ausente';
  END IF;
  -- ALTER sem efeito: prende cada função até o COMMIT antes de a PRE ler o corpo.
  ALTER FUNCTION public.registrar_contato_radar(text, text, text, date) VOLATILE;
  ALTER FUNCTION public.desfazer_contato_radar(uuid) VOLATILE;
  ALTER FUNCTION private.radar_atendimento_expira_em(text, uuid, timestamptz, timestamptz) STABLE;
  ALTER FUNCTION public.radar_definir_atendimento(text, text) VOLATILE;
END
$trava$;

-- ── PRE: corpo vivo ∈ {predecessor revisado (PROD 2026-11-08), este arquivo} ───────────────────────────
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.alvo, v.predecessor, v.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v.alvo)) AS vivo
      FROM (VALUES
        ('public.registrar_contato_radar(text,text,text,date)',
         '6d7138c65159a00dd2066a4a15b6583b', '641ef8187924b7f658e0156cd121ce13'),
        ('private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)',
         '0ded55f382a8c3d5aaa4ea8372912479', '9ba83e9f13a980df9c25508da713a187'),
        ('public.desfazer_contato_radar(uuid)',
         'b2f4de64f1110150c4c66905cfe3c542', '04bfe8609883415c83eef43f263c161a'),
        -- Não é recriada aqui: o auto-assumir depende das regras DELA (lidas na revisão). Mudou → refaça o pré-voo.
        ('public.radar_definir_atendimento(text,text)',
         '0b64fb7ec8d8700e2183af484675a7d7', '0b64fb7ec8d8700e2183af484675a7d7')
      ) AS v(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NULL THEN
      RAISE EXCEPTION 'PRE FALHOU: % ausente', r.alvo;
    ELSIF r.vivo IS DISTINCT FROM r.predecessor AND r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ── 1. Esquema ───────────────────────────────────────────────────────────────────────────────────────────
-- Sem FK: o desfazer APAGA o contato, e a posse sobrevive a ele quando outro contato do dono veio depois.
ALTER TABLE public.radar_atendimentos ADD COLUMN IF NOT EXISTS contato_origem_id uuid;
COMMENT ON COLUMN public.radar_atendimentos.contato_origem_id IS
  'Pacote L: o contato (radar_contatos.id) que CRIOU esta posse pelo auto-assumir de registrar_contato_radar; NULL = '
  'assumida pelo botão ou atribuída pelo gestor. desfazer_contato_radar fecha a posse quando desfaz este contato.';
COMMENT ON TABLE public.radar_atendimentos IS
  'Radar: "em atendimento por X". 1 aberto por CNPJ; vence pela reconstrução cronológica dos contatos do dono '
  '(private.radar_atendimento_expira_em). Escritores: radar_definir_atendimento (assumir/renovar/liberar, também '
  'chamado por registrar_contato_radar), radar_atribuir_atendimento (gestor), radar_posses_vencer_tick (expirado) e '
  'desfazer_contato_radar (fecha a posse criada pelo contato desfeito).';

-- ── 2. Vencimento: uma reconstrução cronológica ────────────────────────────────────────────────────────
-- Estado no início (assumido_em ou a renovação, a maior): cadeia = início + 7 dias; compromisso = o do último contato
-- do DONO até o início (o contato que acabou de auto-assumir/renovar tem created_at <= início e entra aqui).
-- Para cada contato do dono depois do início, em ordem: se a posse já tinha morrido (contato >= limite), para — contato
-- tardio não ressuscita; senão a cadeia vai a contato + 7 dias e o compromisso passa a ser o DESTE contato. O limite é
-- sempre o maior entre a cadeia e o compromisso vigente: como a cadeia só cresce e cada contato é anterior ao limite de
-- então, o limite nunca cai para antes de um instante em que a posse já estava viva (sem vencimento retroativo).
-- Compromisso = (retorno_em + 3 dias) à meia-noite BRT, só do "em conversa" com retorno; outro desfecho zera.
CREATE OR REPLACE FUNCTION private.radar_atendimento_expira_em(p_cnpj text, p_dono uuid, p_assumido_em timestamptz, p_renovado_em timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_inicio timestamptz := GREATEST(p_assumido_em, p_renovado_em);
  v_cadeia timestamptz := v_inicio + interval '7 days';
  v_protege timestamptz;
  v_limite timestamptz;
  c record;
BEGIN
  SELECT CASE WHEN x.acao = 'em_conversa' AND x.retorno_em IS NOT NULL
              THEN ((x.retorno_em + 3)::timestamp AT TIME ZONE 'America/Sao_Paulo') END
    INTO v_protege
    FROM public.radar_contatos x
   WHERE x.cnpj = p_cnpj AND x.criado_por = p_dono AND x.created_at <= v_inicio
   ORDER BY x.created_at DESC, x.id DESC
   LIMIT 1;
  v_limite := GREATEST(v_cadeia, v_protege);
  FOR c IN
    SELECT x.created_at, x.acao, x.retorno_em FROM public.radar_contatos x
     WHERE x.cnpj = p_cnpj AND x.criado_por = p_dono AND x.created_at > v_inicio
     ORDER BY x.created_at, x.id
  LOOP
    EXIT WHEN c.created_at >= v_limite;
    v_cadeia := GREATEST(v_cadeia, c.created_at + interval '7 days');
    v_protege := CASE WHEN c.acao = 'em_conversa' AND c.retorno_em IS NOT NULL
                      THEN ((c.retorno_em + 3)::timestamp AT TIME ZONE 'America/Sao_Paulo') END;
    v_limite := GREATEST(v_cadeia, v_protege);
  END LOOP;
  RETURN v_limite;
END
$fn$;
REVOKE ALL ON FUNCTION private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 3. Registro do contato: dá a posse ───────────────────────────────────────────────────────────────────
-- Mesma assinatura (CREATE OR REPLACE preserva o ACL). O corpo é o do pacote G até o UPDATE do status; o L acrescenta
-- o passo da posse no fim. Ordem das travas: linha de radar_empresas (FOR UPDATE) → advisory do registro → advisory
-- do CNPJ e do dono (dentro do definir). Nenhum caminho pega o advisory do CNPJ e depois a linha da empresa (o definir,
-- o atribuir e o tick não travam radar_empresas), então não há ciclo.
CREATE OR REPLACE FUNCTION public.registrar_contato_radar(p_cnpj text, p_acao text, p_nota text DEFAULT NULL,
                                                         p_retorno date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_status_atual text;
  v_codigo_atual text;
  v_motivo_atual text;
  v_atualizado_atual timestamptz;
  v_dono_atual uuid;
  v_confirmado boolean;
  v_agora timestamptz;
  v_hoje date;
  v_nota text := NULLIF(btrim(p_nota), '');
  v_existing uuid;
  v_existing_retorno date;
  v_tentativa integer;
  v_retorno date;
  v_origem text;
  v_id uuid;
  v_posse jsonb;
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
  -- G1: a data de retorno é só do "em conversa"; a do "não atendeu" é do servidor.
  IF p_retorno IS NOT NULL AND p_acao <> 'em_conversa' THEN
    RAISE EXCEPTION 'RADAR_RETORNO_INVALIDO: data de retorno só vale para "em conversa" (recebido para %)', p_acao
      USING ERRCODE = 'RD008';
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
        -- Nada é gravado aqui: com nota, a resposta diz que ela NÃO foi (a ficha mantém o texto).
        RETURN jsonb_build_object('id', v_existing, 'deduped', true, 'nota_gravada', v_nota IS NULL, 'retorno_em', NULL,
                                  'posse', NULL);
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
  v_hoje := (v_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  IF p_retorno IS NOT NULL AND (p_retorno < v_hoje OR p_retorno > v_hoje + 60) THEN
    RAISE EXCEPTION 'RADAR_RETORNO_INVALIDO: o retorno tem de ser entre hoje (%) e 60 dias (recebido %)', v_hoje, p_retorno
      USING ERRCODE = 'RD008';
  END IF;

  -- G4: clique repetido só é o MESMO registro se ele ainda é o dono do status E tem o mesmo CONTEÚDO. Nota ou data
  -- diferente é registro novo (nada do vendedor se perde); nota/data não informadas preservam o que está gravado.
  -- L1: o clique repetido não mexe na posse (a 1ª chamada já assumiu ou renovou) — `posse` null = "não mexi".
  SELECT c.id, c.retorno_em INTO v_existing, v_existing_retorno FROM public.radar_contatos c
   WHERE c.id = v_dono_atual AND c.criado_por = v_uid AND c.cnpj = p_cnpj AND c.acao = p_acao
     AND c.created_at > v_agora - interval '2 minutes'
     AND (v_nota IS NULL OR NULLIF(btrim(c.nota), '') IS NOT DISTINCT FROM v_nota)
     AND (p_retorno IS NULL OR c.retorno_em IS NOT DISTINCT FROM p_retorno);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true, 'nota_gravada', true, 'retorno_em', v_existing_retorno,
                              'posse', NULL);
  END IF;

  IF p_acao = 'em_conversa' THEN
    v_retorno := COALESCE(p_retorno, private.radar_dia_util(v_hoje + 7));
    v_origem := CASE WHEN p_retorno IS NULL THEN 'padrao' ELSE 'vendedor' END;
  ELSIF p_acao = 'contatado_sem_resposta' THEN
    -- G2: quantos "não atendeu" seguidos a cadeia do status já tem (o contato dono e os anteriores dele).
    WITH RECURSIVE cadeia AS (
      SELECT c.id, c.contato_anterior_id, 1 AS n FROM public.radar_contatos c
       WHERE c.id = v_dono_atual AND c.cnpj = p_cnpj AND c.acao = 'contatado_sem_resposta'
      UNION ALL
      SELECT c.id, c.contato_anterior_id, k.n + 1 FROM cadeia k
        JOIN public.radar_contatos c ON c.id = k.contato_anterior_id
       WHERE c.cnpj = p_cnpj AND c.acao = 'contatado_sem_resposta' AND k.n < 2
    )
    SELECT COALESCE(max(n), 0) + 1 INTO v_tentativa FROM cadeia;
    v_retorno := private.radar_dia_util(v_hoje + CASE v_tentativa WHEN 1 THEN 3 WHEN 2 THEN 7 ELSE 30 END);
    v_origem := 'padrao';
  END IF;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, created_at,
                                     status_anterior, descarte_motivo_anterior, atualizado_anterior, contato_anterior_id,
                                     retorno_em, retorno_origem)
  VALUES (p_cnpj, p_acao, p_nota, v_uid, v_agora,
          v_status_atual, v_motivo_atual, v_atualizado_atual, v_dono_atual,
          v_retorno, v_origem)
  RETURNING id INTO v_id;

  UPDATE public.radar_empresas SET
    prospeccao_status = p_acao,
    prospeccao_atualizado_em = v_agora,
    prospeccao_contato_id = v_id,
    descarte_motivo = CASE WHEN p_acao = 'descartado' THEN p_nota ELSE NULL END,
    updated_at = now()
  WHERE cnpj = p_cnpj;

  -- L1: quem conversou ou tentou fica com o lead. O escritor de sempre decide (livre → assume; do próprio → renova;
  -- de outro → recusa sem mexer; já-cliente/limite → recusa). Descartar ou voltar a "a contatar" não mexe na posse.
  IF p_acao IN ('em_conversa', 'contatado_sem_resposta') THEN
    v_posse := public.radar_definir_atendimento(p_cnpj, 'assumir');
    IF (v_posse->>'ok')::boolean AND NOT COALESCE((v_posse->>'renovado')::boolean, true) THEN
      UPDATE public.radar_atendimentos a SET contato_origem_id = v_id
       WHERE a.cnpj = p_cnpj AND a.encerrado_em IS NULL AND a.dono_user_id = v_uid AND a.contato_origem_id IS NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'deduped', false, 'nota_gravada', true, 'retorno_em', v_retorno, 'posse', v_posse);
END
$fn$;

-- ── 4. Desfazer: a posse criada pelo contato desfeito sai junto ──────────────────────────────────────────
-- Corpo da PROD (20261031111000) + o fecho da posse antes do DELETE. Só fecha se a posse foi CRIADA por este contato,
-- é do mesmo usuário e nenhum outro contato dele no CNPJ veio depois (esse outro contato sustenta a posse).
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
  v_criado timestamptz;
  v_restaurou boolean := false;
  v_posse_desfeita boolean := false;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;

  SELECT cnpj INTO v_cnpj FROM public.radar_contatos WHERE id = p_id AND criado_por = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'status_restaurado', false);
  END IF;

  SELECT prospeccao_contato_id INTO v_dono FROM public.radar_empresas WHERE cnpj = v_cnpj FOR UPDATE;
  -- L1: mesma ordem do registro (linha da empresa → advisory do CNPJ), e o mesmo advisory do escritor da posse.
  PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento:' || v_cnpj, 0));
  v_agora := clock_timestamp();

  -- Relido SOB a trava, com a janela medida depois da espera.
  SELECT acao, status_anterior, descarte_motivo_anterior, atualizado_anterior, contato_anterior_id, created_at
    INTO v_acao, v_anterior, v_motivo_anterior, v_atualizado_anterior, v_dono_anterior, v_criado
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

  -- L1: a posse que ESTE contato criou (auto-assumir) sai com ele — o clique errado não prende o lead por 7 dias.
  UPDATE public.radar_atendimentos a
     SET encerrado_em = GREATEST(v_agora, a.assumido_em), encerrado_por = v_uid, motivo_encerramento = 'liberado'
   WHERE a.cnpj = v_cnpj AND a.encerrado_em IS NULL AND a.contato_origem_id = p_id AND a.dono_user_id = v_uid
     AND NOT EXISTS (SELECT 1 FROM public.radar_contatos o
                      WHERE o.cnpj = v_cnpj AND o.criado_por = v_uid AND o.id <> p_id AND o.created_at >= v_criado);
  v_posse_desfeita := FOUND;

  -- Tirar o contato da cadeia: quem o tinha como dono anterior herda o retrato DELE. Sem isto, A desfaz sem ser dono,
  -- B (que veio depois) desfaz e o retrato "antes de B" ressuscita o efeito que A acabou de desfazer.
  UPDATE public.radar_contatos SET
    status_anterior = v_anterior,
    descarte_motivo_anterior = v_motivo_anterior,
    atualizado_anterior = v_atualizado_anterior,
    contato_anterior_id = v_dono_anterior
  WHERE contato_anterior_id = p_id;

  DELETE FROM public.radar_contatos WHERE id = p_id;
  RETURN jsonb_build_object('deleted', true, 'status_restaurado', v_restaurou, 'posse_desfeita', v_posse_desfeita);
END $function$;

-- O REPLACE preserva o ACL; reemitido nomeando as roles para o arquivo valer sozinho.
REVOKE ALL ON FUNCTION public.registrar_contato_radar(text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text, text, text, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.desfazer_contato_radar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desfazer_contato_radar(uuid) TO authenticated, service_role;

-- ── 5. Sensor da agenda "Hoje" do /radar (regra de fase: a superfície nasce com o sensor, no LEDGER) ─────────
-- 'vista': o bloco apareceu com itens (1 por vendedor por dia; guarda quantos retornos e posses havia = denominador).
-- 'aberta': o vendedor abriu um item da agenda (1 por CNPJ por dia). O PostHog é cego para o founder: a medição lê
-- isto (db/medir-radar-agenda.sql).
CREATE TABLE IF NOT EXISTS public.radar_agenda_uso (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL,
  dia        date NOT NULL,
  evento     text NOT NULL CHECK (evento IN ('vista', 'aberta')),
  cnpj       text NOT NULL DEFAULT '' CHECK ((evento = 'vista') = (cnpj = '')),
  n_retornos integer CHECK (n_retornos >= 0),
  n_posses   integer CHECK (n_posses >= 0),
  criado_em  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dia, evento, cnpj)
);
CREATE INDEX IF NOT EXISTS idx_radar_agenda_uso_dia ON public.radar_agenda_uso (dia);
ALTER TABLE public.radar_agenda_uso ENABLE ROW LEVEL SECURITY;
-- Sem policy de propósito (como as tabelas do funil): o front só passa pela RPC.
REVOKE ALL ON TABLE public.radar_agenda_uso FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.radar_agenda_uso TO service_role;
COMMENT ON TABLE public.radar_agenda_uso IS
  'Radar pacote L: uso da agenda "Hoje" do /radar. vista = o bloco apareceu com itens (1/vendedor/dia, n_retornos e '
  'n_posses = o que havia); aberta = um item foi aberto (1/CNPJ/dia). Escritor único: radar_registrar_agenda_uso(). '
  'Medição: db/medir-radar-agenda.sql. Migration 20261111130000.';

CREATE OR REPLACE FUNCTION public.radar_registrar_agenda_uso(p_evento text, p_cnpj text DEFAULT NULL,
                                                            p_n_retornos integer DEFAULT NULL, p_n_posses integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_n   integer;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_evento IS NULL OR p_evento NOT IN ('vista', 'aberta') THEN
    RAISE EXCEPTION 'evento invalido: %', p_evento USING ERRCODE = '22023';
  END IF;
  IF p_evento = 'aberta' AND (p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$') THEN
    RAISE EXCEPTION 'cnpj invalido' USING ERRCODE = '22023';
  END IF;
  IF p_evento = 'vista' AND (p_n_retornos IS NULL OR p_n_posses IS NULL OR p_n_retornos < 0 OR p_n_posses < 0
                             OR p_n_retornos + p_n_posses = 0) THEN
    -- Agenda vazia não é "vista": o denominador é o dia em que havia o que fazer.
    RAISE EXCEPTION 'vista exige n_retornos e n_posses (soma >= 1)' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.radar_agenda_uso (user_id, dia, evento, cnpj, n_retornos, n_posses)
  VALUES (v_uid, (now() AT TIME ZONE 'America/Sao_Paulo')::date, p_evento,
          CASE WHEN p_evento = 'aberta' THEN p_cnpj ELSE '' END,
          CASE WHEN p_evento = 'vista' THEN p_n_retornos END, CASE WHEN p_evento = 'vista' THEN p_n_posses END)
  ON CONFLICT (user_id, dia, evento, cnpj) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'registrado', v_n = 1);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_registrar_agenda_uso(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_agenda_uso(text, text, integer, integer) TO authenticated;

-- ── Postcondição ────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text;
BEGIN
  -- P4: o ledger da agenda fechado para o JWT (só a RPC escreve) e a RPC só para authenticated.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.radar_agenda_uso'::regclass)
     OR has_table_privilege('authenticated', 'public.radar_agenda_uso', 'SELECT')
     OR has_table_privilege('anon', 'public.radar_agenda_uso', 'SELECT') THEN
    RAISE EXCEPTION 'P4 FALHOU: radar_agenda_uso sem RLS ou legível pelo JWT';
  END IF;
  f := 'public.radar_registrar_agenda_uso(text,text,integer,integer)';
  IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: ACL de % errada', f;
  END IF;

  -- P1: coluna nova e uma só assinatura de cada RPC.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.radar_atendimentos'::regclass
                   AND attname = 'contato_origem_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_atendimentos.contato_origem_id ausente';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname IN ('registrar_contato_radar', 'desfazer_contato_radar')) <> 2 THEN
    RAISE EXCEPTION 'P1 FALHOU: registrar_contato_radar/desfazer_contato_radar com mais de uma assinatura';
  END IF;

  -- P2: o vencimento segue interno (nas três pontas) e STABLE (leituras do card e da lista).
  f := 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)';
  IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: % executável por PUBLIC/anon/authenticated', f;
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = f::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'P2 FALHOU: % deixou de ser STABLE', f;
  END IF;

  -- P3: as RPCs do front: authenticated sim, PUBLIC/anon não, SECURITY DEFINER.
  FOREACH f IN ARRAY ARRAY['public.registrar_contato_radar(text,text,text,date)', 'public.desfazer_contato_radar(uuid)'] LOOP
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P3 FALHOU: ACL de % errada (quer authenticated sim, PUBLIC/anon não)', f;
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) IS NOT TRUE THEN
      RAISE EXCEPTION 'P3 FALHOU: % perdeu o SECURITY DEFINER', f;
    END IF;
  END LOOP;
END
$post$;

NOTIFY pgrst, 'reload schema';
