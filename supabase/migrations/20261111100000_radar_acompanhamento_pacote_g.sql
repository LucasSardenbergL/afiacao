-- =============================================================================
-- Radar, pacote G: acompanhamento depois da ligação (2026-11-08)
-- =============================================================================
-- Manual (o Lovable não aplica custom migration). Ritual lovable-db-operator: pré-voo pg_get_functiondef da PROD
-- (db/fixtures/radar-g-predecessora-prod-20261108.sql), prova PG17 EXECUTANDO (db/test-radar-acompanhamento-g.sh,
-- --falsificar), REVOKE nas duas pontas, envelope BEGIN/COMMIT, conferência por psql-ro.
--
-- G1 retorno do "em conversa": o retorno mora no CONTATO (radar_contatos.retorno_em). O status já aponta para o
--    contato dono (prospeccao_contato_id), então o retorno vigente do lead é o do contato dono, e o desfazer restaura
--    o anterior sozinho. em_conversa: data do vendedor entre hoje e hoje+60 (RD008 fora disso); sem data (app velho
--    no service worker) → hoje+7, em dia útil, retorno_origem 'padrao'.
-- G2 "não atendeu" sai por um prazo e VOLTA para quem ligou: 1ª tentativa 3 dias, 2ª 7, 3ª em diante 30 (corridos,
--    empurrados para segunda se caem no fim de semana). A contagem segue a cadeia do status (contato_anterior_id):
--    é decidida no registro e não muda depois.
--    Retornos são uma FILA à parte (private.radar_retornos_do_vendedor): não disputam o top 3/top 5 dos leads novos
--    e não passam pelo "1 por raiz" (cada compromisso é um CNPJ). Responsável = dono da posse ativa, senão o autor do
--    contato, se ainda tiver acesso; sem ninguém, o lead volta à distribuição quando o retorno vence.
--    A raiz em acompanhamento (alguma filial com responsável) sai da distribuição de leads novos: a mesma empresa não
--    "reaparece" por outra filial no dia seguinte.
-- G3 posse que não vence calada: o compromisso vigente protege a posse até retorno+3 dias (do contato DONO do status,
--    sem depender da varredura de toques); o card devolve retornos e posses que vencem em 48 h; o e-mail semanal ganha
--    o bloco de acompanhamento (e sai só com ele, n_leads 0) e grava o que avisou em envios.acompanhamento; um tick
--    diário FECHA a posse vencida como 'expirado' (registro imutável para o denominador).
-- G4 a nota não se perde: a dedupe de 2 min só vale para o MESMO conteúdo (nota e data iguais ou não informadas).
--    Conteúdo diferente é registro novo. A resposta diz nota_gravada.
--
-- Revisão Codex do desenho (2026-11-08, high): ver docs/historico/radar-acompanhamento-pacote-g-2026-11-08.md.
-- Molde TRAVA → PRE → CREATE → PÓS. Envelope BEGIN/COMMIT.
-- =============================================================================

BEGIN;

-- ── TRAVA ────────────────────────────────────────────────────────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regclass('public.radar_contatos') IS NULL OR to_regclass('public.radar_atendimentos') IS NULL
     OR to_regclass('public.radar_email_vendedor_envios') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_contatos, radar_atendimentos ou radar_email_vendedor_envios ausente';
  END IF;
  IF to_regprocedure('private.radar_territorio_do_vendedor(uuid,integer)') IS NULL
     OR to_regprocedure('private.radar_contato_do_lead(text)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: aplique o pacote E (20261107230000) e o contato contábil (20261109140000) antes';
  END IF;
  -- ALTER sem efeito: prende cada função até o COMMIT antes de a PRE ler o corpo.
  IF to_regprocedure('public.registrar_contato_radar(text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.registrar_contato_radar(text, text, text) VOLATILE;
  END IF;
  IF to_regprocedure('public.registrar_contato_radar(text,text,text,date)') IS NOT NULL THEN
    ALTER FUNCTION public.registrar_contato_radar(text, text, text, date) VOLATILE;
  END IF;
  ALTER FUNCTION private.radar_atendimento_expira_em(text, uuid, timestamptz, timestamptz) STABLE;
  ALTER FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) STABLE;
  ALTER FUNCTION public.radar_prospectar_hoje(uuid, integer) STABLE;
  ALTER FUNCTION public.radar_avisar_vendedores(timestamptz) VOLATILE;
END
$trava$;

-- ── PRE: corpo vivo ∈ {predecessor revisado (PROD 2026-11-08), este arquivo} ───────────────────────────
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.alvo, v.predecessor, v.este, v.pode_faltar,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v.alvo)) AS vivo
      FROM (VALUES
        ('public.registrar_contato_radar(text,text,text)',
         '26c486a156b0fd90d5187bfa377daae5', NULL, true),        -- some nesta migration (ganha p_retorno)
        ('public.registrar_contato_radar(text,text,text,date)',
         NULL, '6d7138c65159a00dd2066a4a15b6583b', true),                           -- nasce nesta migration
        ('private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)',
         'fefd503925f5feaa33057895894f8b3c', '0ded55f382a8c3d5aaa4ea8372912479', false),
        ('private.radar_leads_do_vendedor(uuid,integer,timestamptz)',
         '09a18fe233086578bea5ce92a82999c3', '6e9fe43f4c40740727ed0c4559a37366', false),
        ('public.radar_prospectar_hoje(uuid,integer)',
         'd35f8f19e9b3612de3454c306f77a52d', 'e3fa4a1e1fd7db18547cd65ff31f15f5', false),
        ('public.radar_avisar_vendedores(timestamptz)',
         '6c5c9fd0423301f9e835008cb621019f', '8d978dcdd8131798070d9cfb3674b41d', false)
      ) AS v(alvo, predecessor, este, pode_faltar)
  LOOP
    IF r.vivo IS NULL THEN
      IF NOT r.pode_faltar THEN
        RAISE EXCEPTION 'PRE FALHOU: % ausente', r.alvo;
      END IF;
    ELSIF r.vivo IS DISTINCT FROM r.predecessor AND r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;
    END IF;
  END LOOP;
  IF to_regprocedure('public.registrar_contato_radar(text,text,text)') IS NULL
     AND to_regprocedure('public.registrar_contato_radar(text,text,text,date)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: nenhuma versão de public.registrar_contato_radar existe';
  END IF;
END
$pre$;

-- ── 1. Esquema ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.radar_contatos ADD COLUMN IF NOT EXISTS retorno_em date;
ALTER TABLE public.radar_contatos ADD COLUMN IF NOT EXISTS retorno_origem text;
ALTER TABLE public.radar_contatos DROP CONSTRAINT IF EXISTS radar_contatos_retorno_chk;
ALTER TABLE public.radar_contatos ADD CONSTRAINT radar_contatos_retorno_chk CHECK (
  (retorno_em IS NULL) = (retorno_origem IS NULL)
  AND (retorno_origem IS NULL OR retorno_origem IN ('vendedor', 'padrao'))
  AND (retorno_em IS NULL OR acao IN ('em_conversa', 'contatado_sem_resposta')));
COMMENT ON COLUMN public.radar_contatos.retorno_em IS
  'Pacote G: dia (BRT) em que o lead volta para o responsável. Vale o do contato DONO do status (prospeccao_contato_id). '
  'em_conversa: o vendedor escolhe (hoje..hoje+60) ou hoje+7; contatado_sem_resposta: 3/7/30 dias pela cadeia. Escritor: registrar_contato_radar.';
COMMENT ON COLUMN public.radar_contatos.retorno_origem IS
  'Pacote G: vendedor = data mandada pela ficha; padrao = o servidor calculou (não atendeu, ou app sem o campo).';

-- O acompanhamento é raro (em prod: 3 linhas em 573 mil): o índice parcial faz a leitura não varrer a tabela.
CREATE INDEX IF NOT EXISTS idx_radar_empresas_acompanhamento ON public.radar_empresas (cnpj)
  WHERE prospeccao_status IN ('em_conversa', 'contatado_sem_resposta');

-- E-mail só de acompanhamento (sem lead novo) também é um envio: o dispatcher resolve o destinatário por ele.
ALTER TABLE public.radar_email_vendedor_envios DROP CONSTRAINT IF EXISTS radar_email_vendedor_envios_n_leads_check;
ALTER TABLE public.radar_email_vendedor_envios ADD CONSTRAINT radar_email_vendedor_envios_n_leads_check
  CHECK (n_leads >= 0 AND n_leads <= 5);
ALTER TABLE public.radar_email_vendedor_envios ADD COLUMN IF NOT EXISTS acompanhamento jsonb;
COMMENT ON COLUMN public.radar_email_vendedor_envios.acompanhamento IS
  'Pacote G: o que o e-mail avisou — {retornos:[{cnpj,retorno_em,tipo}], posses_vencendo:[{atendimento_id,cnpj,expira_em}], '
  'posses_vencidas:[...]}. Insert-only, 1 escritor (radar_avisar_vendedores). O expira_em é a VERSÃO do prazo avisada.';

-- ── 2. Dia útil (fim de semana → segunda) ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.radar_dia_util(p_dia date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT CASE extract(isodow FROM p_dia) WHEN 6 THEN p_dia + 2 WHEN 7 THEN p_dia + 1 ELSE p_dia END
$fn$;
REVOKE ALL ON FUNCTION private.radar_dia_util(date) FROM PUBLIC, anon, authenticated;

-- ── 3. Posse: o compromisso vigente protege ────────────────────────────────────────────────────────────
-- vencimento = máximo(cadeia de toques de antes, proteção do compromisso). A proteção vem do contato DONO do status
-- (em_conversa do próprio dono com retorno), não da varredura: renovar a posse depois não a apaga, e um contato novo
-- (outro desfecho) a retira. Contato feito com a posse já vencida não ressuscita a posse.
CREATE OR REPLACE FUNCTION private.radar_atendimento_expira_em(p_cnpj text, p_dono uuid, p_assumido_em timestamptz, p_renovado_em timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_inicio timestamptz := GREATEST(p_assumido_em, p_renovado_em);
  v_expira timestamptz := v_inicio + interval '7 days';
  v_toque timestamptz;
  v_protege timestamptz;
BEGIN
  FOR v_toque IN
    SELECT c.created_at FROM public.radar_contatos c
     WHERE c.cnpj = p_cnpj AND c.criado_por = p_dono AND c.created_at > v_inicio
     ORDER BY c.created_at
  LOOP
    EXIT WHEN v_toque >= v_expira;
    v_expira := GREATEST(v_expira, v_toque + interval '7 days');
  END LOOP;
  SELECT ((c.retorno_em + 3)::timestamp AT TIME ZONE 'America/Sao_Paulo') INTO v_protege
    FROM public.radar_empresas e
    JOIN public.radar_contatos c ON c.id = e.prospeccao_contato_id AND c.cnpj = e.cnpj
   WHERE e.cnpj = p_cnpj AND e.prospeccao_status = 'em_conversa' AND c.acao = 'em_conversa'
     AND c.criado_por = p_dono AND c.retorno_em IS NOT NULL AND c.created_at < v_expira;
  RETURN GREATEST(v_expira, v_protege);
END
$fn$;

-- ── 4. Acompanhamentos (a leitura única que card, e-mail e distribuição usam) ─────────────────────────
-- Retorno sem data (contato anterior ao pacote G: "legado") vale a regra padrão a partir do dia do contato.
CREATE OR REPLACE FUNCTION private.radar_acompanhamentos(p_agora timestamptz)
RETURNS TABLE(cnpj text, raiz text, retorno_tipo text, contato_id uuid, autor uuid, responsavel uuid,
              retorno_em date, retorno_origem text, nota text, contato_em timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT e.cnpj, left(e.cnpj, 8),
         CASE e.prospeccao_status WHEN 'em_conversa' THEN 'conversa' ELSE 'nao_atendeu' END,
         c.id, c.criado_por,
         COALESCE(pa.dono, CASE WHEN COALESCE(private.cap_radar_prospectar(c.criado_por), false) THEN c.criado_por END),
         COALESCE(c.retorno_em,
                  private.radar_dia_util((COALESCE(c.created_at, e.prospeccao_atualizado_em, p_agora) AT TIME ZONE 'America/Sao_Paulo')::date
                                         + CASE WHEN e.prospeccao_status = 'em_conversa' THEN 7 ELSE 3 END)),
         COALESCE(c.retorno_origem, 'legado'),
         c.nota,
         COALESCE(c.created_at, e.prospeccao_atualizado_em)
    FROM public.radar_empresas e
    LEFT JOIN public.radar_contatos c ON c.id = e.prospeccao_contato_id AND c.cnpj = e.cnpj
    LEFT JOIN LATERAL (
      SELECT a.dono_user_id AS dono FROM public.radar_atendimentos a
       WHERE a.cnpj = e.cnpj AND a.encerrado_em IS NULL
         AND COALESCE(private.cap_radar_prospectar(a.dono_user_id), false)
         AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora
    ) pa ON true
   WHERE e.prospeccao_status IN ('em_conversa', 'contatado_sem_resposta')
     AND e.ja_cliente = false
$fn$;
REVOKE ALL ON FUNCTION private.radar_acompanhamentos(timestamptz) FROM PUBLIC, anon, authenticated;

-- Retornos do vendedor até p_ate (card: hoje; e-mail: domingo da semana). Todos, por CNPJ — é a agenda dele.
CREATE OR REPLACE FUNCTION private.radar_retornos_do_vendedor(p_vendedor uuid, p_ate date, p_agora timestamptz)
RETURNS TABLE(cnpj text, razao_social text, nome_fantasia text, municipio_nome text, uf text, retorno_tipo text,
              retorno_em date, atrasado boolean, nota text, contato_em timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT ac.cnpj, re.razao_social, re.nome_fantasia, re.municipio_nome, re.uf, ac.retorno_tipo, ac.retorno_em,
         ac.retorno_em < (p_agora AT TIME ZONE 'America/Sao_Paulo')::date, left(ac.nota, 140), ac.contato_em
    FROM private.radar_acompanhamentos(p_agora) ac
    JOIN public.radar_empresas re ON re.cnpj = ac.cnpj
   WHERE ac.responsavel = p_vendedor AND ac.retorno_em <= p_ate
   ORDER BY ac.retorno_em, ac.cnpj
$fn$;
REVOKE ALL ON FUNCTION private.radar_retornos_do_vendedor(uuid, date, timestamptz) FROM PUBLIC, anon, authenticated;

-- Posses do vendedor com vencimento em (p_desde, p_ate]: abertas (vencida = já passou de p_agora, o tick ainda não
-- fechou) e fechadas como 'expirado'. Liberada/reatribuída não é vencimento.
CREATE OR REPLACE FUNCTION private.radar_posses_do_vendedor(p_vendedor uuid, p_desde timestamptz, p_ate timestamptz, p_agora timestamptz)
RETURNS TABLE(atendimento_id bigint, cnpj text, razao_social text, nome_fantasia text, expira_em timestamptz, vencida boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT x.id, x.cnpj, re.razao_social, re.nome_fantasia, x.expira, x.expira <= p_agora
    FROM (
      SELECT a.id, a.cnpj,
             CASE WHEN a.encerrado_em IS NULL
                  THEN private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em)
                  ELSE a.encerrado_em END AS expira
        FROM public.radar_atendimentos a
       WHERE a.dono_user_id = p_vendedor
         AND (a.encerrado_em IS NULL OR (a.motivo_encerramento = 'expirado' AND a.encerrado_em > p_desde))
    ) x
    JOIN public.radar_empresas re ON re.cnpj = x.cnpj
   WHERE x.expira > p_desde AND x.expira <= p_ate
   ORDER BY x.expira, x.cnpj
$fn$;
REVOKE ALL ON FUNCTION private.radar_posses_do_vendedor(uuid, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 5. Registro do contato (ganha p_retorno; dedupe por conteúdo) ──────────────────────────────────────
-- DROP + CREATE: o app velho manda {p_cnpj, p_acao, p_nota} e cai no DEFAULT do 4º. O DROP reseta o ACL → o
-- REVOKE/GRANT abaixo nomeia as roles.
DROP FUNCTION IF EXISTS public.registrar_contato_radar(text, text, text);
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
        RETURN jsonb_build_object('id', v_existing, 'deduped', true, 'nota_gravada', v_nota IS NULL, 'retorno_em', NULL);
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
  SELECT c.id, c.retorno_em INTO v_existing, v_existing_retorno FROM public.radar_contatos c
   WHERE c.id = v_dono_atual AND c.criado_por = v_uid AND c.cnpj = p_cnpj AND c.acao = p_acao
     AND c.created_at > v_agora - interval '2 minutes'
     AND (v_nota IS NULL OR NULLIF(btrim(c.nota), '') IS NOT DISTINCT FROM v_nota)
     AND (p_retorno IS NULL OR c.retorno_em IS NOT DISTINCT FROM p_retorno);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true, 'nota_gravada', true, 'retorno_em', v_existing_retorno);
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

  RETURN jsonb_build_object('id', v_id, 'deduped', false, 'nota_gravada', true, 'retorno_em', v_retorno);
END
$fn$;
REVOKE ALL ON FUNCTION public.registrar_contato_radar(text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text, text, text, date) TO authenticated, service_role;
DO $grant$
BEGIN
  -- Paridade com o ACL de antes do DROP (a role do executor do Lovable só existe na PROD).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec_fzvklzpomgnyikkfkzai') THEN
    GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text, text, text, date) TO sandbox_exec_fzvklzpomgnyikkfkzai;
  END IF;
END
$grant$;

-- ── 6. Distribuição de leads novos: raiz em acompanhamento sai; acompanhamento órfão volta ─────────────
CREATE OR REPLACE FUNCTION private.radar_leads_do_vendedor(p_vendedor uuid, p_n integer, p_agora timestamptz DEFAULT now())
RETURNS TABLE(posicao integer, cnpj text, razao_social text, nome_fantasia text, municipio_codigo text, municipio_nome text,
              uf text, score smallint, score_motivos text[], elegiveis integer, atribuido boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  WITH par AS (
    SELECT date_trunc('week', p_agora AT TIME ZONE 'America/Sao_Paulo')::date AS semana,
           p_agora - interval '90 days' AS desde,
           (p_agora AT TIME ZONE 'America/Sao_Paulo')::date AS hoje,
           -- E1: a foto vigente é o maior lote COMPLETO (running/error no meio não é foto). Sem lote completo não
           -- recorta, como a fila (src/lib/radar/lote-vigente.ts: null é "não sei", nunca "zero").
           (SELECT s.mes_referencia FROM public.radar_ingest_state s
             WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1) AS lote
  ),
  terr AS (
    SELECT t.municipio_codigo, t.clientes, t.compartilhado FROM private.radar_territorio_do_vendedor(p_vendedor, 3) t
  ),
  -- G2: em acompanhamento (em conversa / não atendeu). Com responsável, a raiz inteira sai dos leads novos (o
  -- compromisso é de alguém); sem responsável com acesso e com o retorno vencido, o CNPJ volta à distribuição.
  acomp AS (
    SELECT ac.cnpj, ac.raiz, ac.responsavel, ac.retorno_em FROM private.radar_acompanhamentos(p_agora) ac
  ),
  -- E4: lead que o gestor passou a este vendedor e cuja posse segue ativa no relógio de p_agora.
  atrib AS (
    SELECT a.cnpj FROM public.radar_atendimentos a
     WHERE a.dono_user_id = p_vendedor
       AND a.atribuido_por IS NOT NULL
       AND a.encerrado_em IS NULL
       AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora
  ),
  -- Os filtros estáticos ficam DENTRO de cada ramo (o do território casa com o índice parcial idx_radar_muni).
  -- São os mesmos nos ramos: ja_cliente, status, score, RFB, foto vigente (E1) e contato (E1).
  alvo AS (
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, t.clientes, t.compartilhado, false AS atribuido
      FROM terr t
      JOIN public.radar_empresas re ON re.municipio_codigo = t.municipio_codigo
      CROSS JOIN par
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
    UNION ALL
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, 0, false, true
      FROM atrib ab
      JOIN public.radar_empresas re ON re.cnpj = ab.cnpj
      CROSS JOIN par
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
    UNION ALL
    -- G2: acompanhamento órfão (autor sem acesso, sem posse ativa) com retorno vencido, no território.
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, t.clientes, t.compartilhado, false
      FROM acomp o
      JOIN public.radar_empresas re ON re.cnpj = o.cnpj
      JOIN terr t ON t.municipio_codigo = re.municipio_codigo
      CROSS JOIN par
     WHERE o.responsavel IS NULL
       AND o.retorno_em <= par.hoje
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
  ),
  -- Atribuído no território aparece uma vez só, como atribuído.
  um_por_cnpj AS (
    SELECT DISTINCT ON (a.cnpj) a.*, left(a.cnpj, 8) AS raiz
      FROM alvo a
     ORDER BY a.cnpj, a.atribuido DESC, a.compartilhado, a.clientes DESC
  ),
  universo AS (
    SELECT u.*
      FROM um_por_cnpj u
      CROSS JOIN par
     WHERE NOT EXISTS (
             -- posse ativa: de OUTRO vendedor com acesso (como antes) ou do PRÓPRIO quando ele mesmo assumiu (E3);
             -- a do próprio que veio do gestor é justamente o E4 e fica.
             SELECT 1 FROM public.radar_atendimentos a
              WHERE a.cnpj = u.cnpj
                AND a.encerrado_em IS NULL
                AND ((a.dono_user_id <> p_vendedor AND private.cap_radar_prospectar(a.dono_user_id))
                     OR (a.dono_user_id = p_vendedor AND a.atribuido_por IS NULL))
                AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora)
       AND NOT EXISTS (
             -- G2: a empresa (raiz) está em acompanhamento de alguém: nenhuma filial dela entra como lead novo.
             SELECT 1 FROM acomp ac WHERE ac.raiz = u.raiz AND ac.responsavel IS NOT NULL)
       AND NOT EXISTS (
             -- E2: só e-mail ENTREGUE queima, e só os de semana ANTERIOR (os desta semana seguem no card).
             -- E6: no município COMPARTILHADO, o de OUTRO vendedor (na fila ou entregue) também tira o lead: o
             -- fallback não repete o dono. No território próprio, não: o dono nunca perde lead para o fallback.
             -- O atribuído pelo gestor vem com compartilhado = false. Envio de teste nunca conta.
             SELECT 1 FROM public.radar_email_vendedor_leads l
               JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id
               JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
              WHERE left(l.cnpj, 8) = u.raiz
                AND e.eh_teste = false
                AND e.criado_em >= par.desde
                AND ((e.vendedor_user_id = p_vendedor AND fa.status = 'notificado' AND e.semana < par.semana)
                     OR (e.vendedor_user_id <> p_vendedor AND u.compartilhado
                         AND fa.status IN ('notificado', 'pendente_notificacao'))))
  ),
  -- Uma empresa por raiz de CNPJ (a filial de maior score): em prod o top-5 da Regina trazia a mesma metalúrgica 4 vezes.
  por_raiz AS (
    SELECT DISTINCT ON (u.raiz) u.*
      FROM universo u
     ORDER BY u.raiz, u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
  )
  SELECT (row_number() OVER (ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj))::integer,
         u.cnpj, u.razao_social, u.nome_fantasia, u.municipio_codigo, u.municipio_nome, u.uf,
         u.score, u.score_motivos, (count(*) OVER ())::integer, u.atribuido
    FROM por_raiz u
   ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
   LIMIT GREATEST(1, LEAST(COALESCE(p_n, 5), 5));
$fn$;
REVOKE ALL ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 7. Card: + retornos e posses (aditivo: as chaves de antes não mudam) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_prospectar_hoje(p_vendedor uuid DEFAULT NULL, p_n integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid      uuid := (SELECT auth.uid());
  v_alvo     uuid;
  v_n        integer := GREATEST(1, LEAST(COALESCE(p_n, 3), 5));
  v_hoje     date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_terr     jsonb;
  v_motivo   text;
  v_leads    jsonb;
  v_retornos jsonb;
  v_posses   jsonb;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  v_alvo := COALESCE(p_vendedor, v_uid);
  IF v_alvo <> v_uid AND NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: leads de outro vendedor exigem gestor' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('municipio_codigo', t.municipio_codigo, 'municipio_nome', t.municipio_nome,
                                               'uf', t.uf, 'clientes', t.clientes, 'compartilhado', t.compartilhado)
                            ORDER BY t.clientes DESC, t.municipio_codigo), '[]'::jsonb)
    INTO v_terr
    FROM private.radar_territorio_do_vendedor(v_alvo, 3) t;
  IF jsonb_array_length(v_terr) = 0 THEN
    v_motivo := private.radar_territorio_motivo(v_alvo);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('posicao', x.posicao, 'cnpj', x.cnpj, 'razao_social', x.razao_social,
                                               'nome_fantasia', x.nome_fantasia, 'municipio_nome', x.municipio_nome,
                                               'uf', x.uf, 'score', x.score, 'score_motivos', to_jsonb(x.score_motivos),
                                               'elegiveis', x.elegiveis, 'atribuido', x.atribuido,
                                               -- "visitar": todo contato com indício de contabilidade → o card não oferece ligar.
                                               'visitar', COALESCE(ct.visitar, false), 'endereco', ct.endereco)
                            ORDER BY x.posicao), '[]'::jsonb)
    INTO v_leads
    FROM private.radar_leads_do_vendedor(v_alvo, v_n, now()) x
    LEFT JOIN LATERAL private.radar_contato_do_lead(x.cnpj) ct ON true;

  -- G1/G2: os retornos vencidos até hoje (a agenda: total + os 20 primeiros, mais antigos antes).
  SELECT jsonb_build_object('total', count(*)::integer,
           'itens', COALESCE(jsonb_agg(jsonb_build_object('cnpj', r.cnpj, 'razao_social', r.razao_social,
                                         'nome_fantasia', r.nome_fantasia, 'municipio_nome', r.municipio_nome, 'uf', r.uf,
                                         'retorno_tipo', r.retorno_tipo, 'retorno_em', r.retorno_em, 'atrasado', r.atrasado,
                                         'nota', r.nota)
                                       ORDER BY r.retorno_em, r.cnpj) FILTER (WHERE r.rn <= 20), '[]'::jsonb))
    INTO v_retornos
    FROM (SELECT x.*, row_number() OVER (ORDER BY x.retorno_em, x.cnpj) AS rn
            FROM private.radar_retornos_do_vendedor(v_alvo, v_hoje, now()) x) r;

  -- G3: posses que vencem nas próximas 48 h e as que venceram nos últimos 7 dias.
  SELECT jsonb_build_object(
           'vencendo', COALESCE(jsonb_agg(jsonb_build_object('atendimento_id', p.atendimento_id, 'cnpj', p.cnpj,
                                            'razao_social', p.razao_social, 'nome_fantasia', p.nome_fantasia,
                                            'expira_em', p.expira_em)
                                          ORDER BY p.expira_em, p.cnpj) FILTER (WHERE NOT p.vencida), '[]'::jsonb),
           'vencidas_7d', (count(*) FILTER (WHERE p.vencida))::integer)
    INTO v_posses
    FROM private.radar_posses_do_vendedor(v_alvo, now() - interval '7 days', now() + interval '48 hours', now()) p;

  RETURN jsonb_build_object('territorio', v_terr, 'territorio_motivo', v_motivo, 'leads', v_leads,
                            'retornos', v_retornos, 'posses', v_posses);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_prospectar_hoje(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_prospectar_hoje(uuid, integer) TO authenticated;

-- ── 8. E-mail semanal: + bloco de acompanhamento (e sai só com ele) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_avisar_vendedores(p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  c_n           constant integer := 5;
  c_app_padrao  constant text    := 'https://steu.lovable.app';
  c_url_ok      constant text    := '^https://[A-Za-z0-9.-]+(:[0-9]+)?$';
  c_email_ok    constant text    := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  v_ini         timestamptz := clock_timestamp();
  v_semana      date := date_trunc('week', p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  v_app         text;
  r             record;
  l             record;
  v_teste       boolean;
  v_tentativa   integer;
  v_email       text;
  v_nome        text;
  v_terr        jsonb;
  v_terr_txt    text;
  v_terr_nomes  text;
  v_leads       jsonb;
  v_qtd         integer;
  v_elegiveis   integer;
  v_atrib       integer;
  v_visitar     integer;
  v_lista       text;
  v_envio       uuid;
  v_alerta      bigint;
  v_titulo      text;
  v_corpo       text;
  v_estado      text;
  v_msg         text;
  v_desde       timestamptz;
  v_ret         jsonb;
  v_pos         jsonb;
  v_venc        jsonb;
  v_bloco       text;
  v_avisados    jsonb := '[]'::jsonb;
  v_pulados     jsonb := '[]'::jsonb;
  v_erros       jsonb := '[]'::jsonb;
BEGIN
  -- Uma distribuição por vez (parecer Codex): o SKIP LOCKED sozinho deixava duas execuções simultâneas pegarem
  -- vendedores diferentes sem enxergar os envios uma da outra (dono numa, fallback na outra → mesmo lead aos dois).
  -- A 2ª espera a 1ª terminar e então vê os envios dela (ja_enviado_na_semana).
  PERFORM pg_advisory_xact_lock(hashtext('radar.avisar_vendedores'));

  -- E7: a URL do link vem de company_config.app_url_publica (ausente = a de sempre). Valor fora do formato não
  -- manda link quebrado a ninguém: ledger 'erro' e nenhum e-mail.
  SELECT NULLIF(btrim(cc.value), '') INTO v_app FROM public.company_config cc WHERE cc.key = 'app_url_publica';
  v_app := rtrim(COALESCE(v_app, c_app_padrao), '/');
  IF v_app !~ c_url_ok THEN
    IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_config c WHERE c.ativo) THEN
      INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
      VALUES ('radar.avisar_vendedores', 'automatica', v_ini, clock_timestamp(), 'erro',
              jsonb_build_object('semana', v_semana, 'erro', 'company_config.app_url_publica fora do formato https://host',
                                 'app_url_publica', left(v_app, 200)));
    END IF;
    RETURN jsonb_build_object('semana', v_semana, 'erro', 'app_url_publica_invalida', 'avisados', '[]'::jsonb,
                              'pulados', '[]'::jsonb, 'erros', '[]'::jsonb);
  END IF;

  FOR r IN
    SELECT c.vendedor_user_id AS vendedor, c.email_teste
      FROM public.radar_email_vendedor_config c
     WHERE c.ativo
     -- E6: quem é dono de município vai antes, para o território compartilhado não levar os leads do dono.
     ORDER BY NOT EXISTS (SELECT 1 FROM private.radar_territorio_do_vendedor(c.vendedor_user_id, 3) t
                           WHERE NOT t.compartilhado),
              c.vendedor_user_id
       FOR UPDATE OF c SKIP LOCKED
  LOOP
    -- E5: cada vendedor numa subtransação. O erro de um desfaz só o envio dele, vai para `erros` e os outros seguem.
    BEGIN
      v_teste := r.email_teste IS NOT NULL;

      -- E2: e-mail que falhou (falha_notificacao) não consome a semana; na fila ou entregue, sim. Alerta sumido
      -- também bloqueia (fail-closed: na dúvida, não manda duas vezes).
      IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_envios e
                   LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
                  WHERE e.vendedor_user_id = r.vendedor AND e.semana = v_semana AND e.eh_teste = v_teste
                    AND fa.status IS DISTINCT FROM 'falha_notificacao') THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'ja_enviado_na_semana');
        CONTINUE;
      END IF;

      IF NOT COALESCE(private.cap_radar_prospectar(r.vendedor), false) THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_acesso_ao_radar');
        CONTINUE;
      END IF;

      SELECT p.email, p.name INTO v_email, v_nome
        FROM public.profiles p WHERE p.user_id = r.vendedor
       ORDER BY p.created_at LIMIT 1;
      v_email := COALESCE(r.email_teste, btrim(v_email));
      IF v_email IS NULL OR v_email !~ c_email_ok THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_email');
        CONTINUE;
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('municipio_codigo', t.municipio_codigo, 'municipio_nome', t.municipio_nome,
                                                   'uf', t.uf, 'clientes', t.clientes, 'compartilhado', t.compartilhado)
                                ORDER BY t.clientes DESC, t.municipio_codigo), '[]'::jsonb),
             string_agg(t.municipio_nome || ' (' || t.clientes || ' clientes seus)', ' · ' ORDER BY t.clientes DESC, t.municipio_codigo),
             string_agg(t.municipio_nome, ', ' ORDER BY t.clientes DESC, t.municipio_codigo)
        INTO v_terr, v_terr_txt, v_terr_nomes
        FROM private.radar_territorio_do_vendedor(r.vendedor, 3) t;

      -- A elegibilidade é a do pacote E (sem mudança); o contato de contabilidade só MARCA o lead como "visitar".
      SELECT COALESCE(jsonb_agg(to_jsonb(x) || jsonb_build_object('visitar', COALESCE(ct.visitar, false), 'endereco', ct.endereco)
                                ORDER BY x.posicao), '[]'::jsonb), count(*), max(x.elegiveis),
             count(*) FILTER (WHERE x.atribuido), count(*) FILTER (WHERE ct.visitar)
        INTO v_leads, v_qtd, v_elegiveis, v_atrib, v_visitar
        FROM private.radar_leads_do_vendedor(r.vendedor, c_n, p_agora) x
        LEFT JOIN LATERAL private.radar_contato_do_lead(x.cnpj) ct ON true;

      -- G3: acompanhamento. Retornos até domingo; posses que vencem nos próximos 8 dias (com e-mail semanal, toda
      -- posse viva na segunda é avisada com ≥ 24 h); posses que venceram desde o envio anterior.
      SELECT COALESCE(max(e.criado_em), p_agora - interval '7 days') INTO v_desde
        FROM public.radar_email_vendedor_envios e
       WHERE e.vendedor_user_id = r.vendedor AND e.eh_teste = v_teste AND e.criado_em < p_agora;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('cnpj', x.cnpj, 'nome', COALESCE(NULLIF(btrim(x.nome_fantasia), ''), x.razao_social, x.cnpj),
                                                   'municipio_nome', x.municipio_nome, 'uf', x.uf, 'tipo', x.retorno_tipo,
                                                   'retorno_em', x.retorno_em, 'atrasado', x.atrasado)
                                ORDER BY x.retorno_em, x.cnpj), '[]'::jsonb)
        INTO v_ret
        FROM private.radar_retornos_do_vendedor(r.vendedor, v_semana + 6, p_agora) x;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('atendimento_id', x.atendimento_id, 'cnpj', x.cnpj,
                                                   'nome', COALESCE(NULLIF(btrim(x.nome_fantasia), ''), x.razao_social, x.cnpj),
                                                   'expira_em', x.expira_em)
                                ORDER BY x.expira_em, x.cnpj) FILTER (WHERE NOT x.vencida), '[]'::jsonb),
             COALESCE(jsonb_agg(jsonb_build_object('atendimento_id', x.atendimento_id, 'cnpj', x.cnpj,
                                                   'nome', COALESCE(NULLIF(btrim(x.nome_fantasia), ''), x.razao_social, x.cnpj),
                                                   'expira_em', x.expira_em)
                                ORDER BY x.expira_em, x.cnpj) FILTER (WHERE x.vencida), '[]'::jsonb)
        INTO v_pos, v_venc
        FROM private.radar_posses_do_vendedor(r.vendedor, v_desde, p_agora + interval '8 days', p_agora) x;

      -- Sem território o e-mail ainda sai se o gestor passou leads (E4) ou se há acompanhamento (G3); sem nada, o
      -- motivo diz por quê (E6).
      IF v_qtd = 0 AND jsonb_array_length(v_ret) + jsonb_array_length(v_pos) + jsonb_array_length(v_venc) = 0 THEN
        IF jsonb_array_length(v_terr) = 0 THEN
          v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_territorio',
                                                       'causa', private.radar_territorio_motivo(r.vendedor));
        ELSE
          v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_leads', 'territorio', v_terr);
        END IF;
        CONTINUE;
      END IF;

      SELECT COALESCE(max(e.tentativa), 0) + 1 INTO v_tentativa
        FROM public.radar_email_vendedor_envios e
       WHERE e.vendedor_user_id = r.vendedor AND e.semana = v_semana AND e.eh_teste = v_teste;

      v_envio := gen_random_uuid();
      v_lista := '';
      FOR l IN
        SELECT * FROM jsonb_to_recordset(v_leads) AS x(posicao integer, cnpj text, razao_social text, nome_fantasia text,
                                                      municipio_codigo text, municipio_nome text, uf text, score smallint,
                                                      score_motivos text[], elegiveis integer, atribuido boolean,
                                                      visitar boolean, endereco text)
         ORDER BY x.posicao
      LOOP
        v_lista := v_lista
          || l.posicao || '. ' || COALESCE(NULLIF(btrim(l.nome_fantasia), ''), l.razao_social, l.cnpj)
          || CASE WHEN NULLIF(btrim(l.nome_fantasia), '') IS NOT NULL AND l.razao_social IS NOT NULL
                  THEN ' (' || l.razao_social || ')' ELSE '' END || E'\n'
          || '   ' || COALESCE(l.municipio_nome, '?') || '/' || COALESCE(l.uf, '?') || ' · score ' || l.score
          || CASE WHEN l.atribuido THEN ' · passada a você pelo gestor' ELSE '' END
          || COALESCE(' · ' || NULLIF(array_to_string(l.score_motivos[1:2], '; '), ''), '') || E'\n'
          -- Sem telefone a prometer: o contato que a Receita tem é, provavelmente, da contabilidade.
          || CASE WHEN l.visitar THEN '   VISITAR: o telefone e o e-mail da Receita parecem ser da contabilidade da empresa. Vá ao endereço: '
                                      || COALESCE(l.endereco, 'veja na ficha') || E'\n'
                  ELSE '' END
          || '   Abrir no Radar: ' || v_app || '/radar/abrir/' || v_envio || '/' || l.cnpj || E'\n\n';
      END LOOP;

      -- G3: o bloco de acompanhamento (o link é a ficha direta: não é lead "empurrado", não entra no funil H).
      v_bloco := '';
      IF jsonb_array_length(v_ret) > 0 THEN
        v_bloco := v_bloco || 'Retornos que você marcou até domingo (' || to_char(v_semana + 6, 'DD/MM') || '):' || E'\n'
          || (SELECT string_agg('- ' || (x->>'nome') || ' (' || COALESCE(x->>'municipio_nome', '?') || '/' || COALESCE(x->>'uf', '?') || ')'
                                || ' · ' || CASE x->>'tipo' WHEN 'conversa' THEN 'em conversa' ELSE 'não atendeu, tentar de novo' END
                                || ' · ' || to_char((x->>'retorno_em')::date, 'DD/MM')
                                || CASE WHEN (x->>'atrasado')::boolean THEN ' (atrasado)' ELSE '' END || E'\n'
                                || '  ' || v_app || '/radar?cnpj=' || (x->>'cnpj'), E'\n' ORDER BY ord)
                FROM jsonb_array_elements(v_ret) WITH ORDINALITY AS t(x, ord)) || E'\n\n';
      END IF;
      IF jsonb_array_length(v_pos) > 0 THEN
        v_bloco := v_bloco || 'Atendimentos seus que vencem nos próximos dias (registre um contato para continuar com eles):' || E'\n'
          || (SELECT string_agg('- ' || (x->>'nome') || ' · vence ' || to_char(((x->>'expira_em')::timestamptz) AT TIME ZONE 'America/Sao_Paulo', 'DD/MM')
                                || E'\n' || '  ' || v_app || '/radar?cnpj=' || (x->>'cnpj'), E'\n' ORDER BY ord)
                FROM jsonb_array_elements(v_pos) WITH ORDINALITY AS t(x, ord)) || E'\n\n';
      END IF;
      IF jsonb_array_length(v_venc) > 0 THEN
        v_bloco := v_bloco || 'Venceram desde o último e-mail e voltaram para a distribuição: '
          || (SELECT string_agg((x->>'nome'), ', ' ORDER BY ord) FROM jsonb_array_elements(v_venc) WITH ORDINALITY AS t(x, ord))
          || '.' || E'\n\n';
      END IF;

      IF v_qtd > 0 THEN
        v_titulo := 'Radar: ' || v_qtd || CASE WHEN v_qtd = 1 THEN ' empresa' ELSE ' empresas' END
                 || ' para prospectar esta semana' || COALESCE(' (' || v_terr_nomes || ')', '');
        v_corpo := 'Olá' || COALESCE(', ' || NULLIF(split_part(btrim(v_nome), ' ', 1), ''), '') || '!' || E'\n\n'
          || 'Separei ' || v_qtd || CASE WHEN v_qtd = 1 THEN ' empresa' ELSE ' empresas' END
          || ' para você prospectar esta semana'
          || COALESCE(', perto de onde você já tem clientes: ' || v_terr_txt, '') || '.'
          || CASE WHEN v_atrib = 1 THEN ' 1 delas foi passada a você pelo gestor.'
                  WHEN v_atrib > 1 THEN ' ' || v_atrib || ' delas foram passadas a você pelo gestor.'
                  ELSE '' END
          || E'\n\n'
          || v_lista
          || CASE WHEN v_visitar = v_qtd
                  THEN 'O link abre a ficha no Radar, com o endereço, sócios e o botão para registrar o contato. Nestas empresas '
                       || 'o telefone e o e-mail que a Receita tem parecem ser da contabilidade: vá direto ao endereço em vez de ligar.'
                  WHEN v_visitar > 0
                  THEN 'O link abre a ficha no Radar, com o telefone ou e-mail da empresa, sócios e o botão para registrar o contato. '
                       || 'Nas marcadas VISITAR, o telefone e o e-mail que a Receita tem parecem ser da contabilidade: vá direto ao endereço.'
                  ELSE 'O link abre a ficha no Radar, com o telefone ou e-mail da empresa, sócios e o botão para registrar o contato.' END
          || E'\n\n'
          || 'Como escolhi: '
          || CASE WHEN v_atrib > 0 THEN 'primeiro as que o gestor passou a você; depois, ' ELSE '' END
          || 'maior score do Radar entre ' || v_elegiveis || ' empresas a contatar. Ficam de fora '
          || 'quem já é cliente, descartados, empresas baixadas ou inaptas na Receita, empresas que não vieram na foto '
          || 'mais recente da Receita, empresas sem telefone nem e-mail, empresas sem score, leads que você já assumiu e '
          || 'leads em atendimento por outro vendedor. Nenhuma empresa desta lista volta a aparecer para você nos próximos 90 dias.'
          || CASE WHEN v_bloco <> '' THEN E'\n\n' || 'Seu acompanhamento' || E'\n\n' || rtrim(v_bloco, E'\n') ELSE '' END;
      ELSE
        v_titulo := 'Radar: seus retornos e atendimentos da semana';
        v_corpo := 'Olá' || COALESCE(', ' || NULLIF(split_part(btrim(v_nome), ' ', 1), ''), '') || '!' || E'\n\n'
          || 'Nenhuma empresa nova para prospectar esta semana, mas você tem acompanhamento pendente:' || E'\n\n'
          || rtrim(v_bloco, E'\n');
      END IF;
      v_corpo := v_corpo
        || CASE WHEN v_teste THEN E'\n\n[TESTE] Este e-mail era para ' || COALESCE(v_nome, r.vendedor::text)
                                  || ' e foi desviado para ' || v_email || '. Não entra na contagem de envios.'
                ELSE '' END;

      INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
      VALUES ('oben', 'outro', 'info', v_titulo, v_corpo, 'pendente_notificacao',
              jsonb_build_object('origem', 'radar.avisar_vendedores', 'envio_id', v_envio, 'semana', v_semana,
                                 'n_leads', v_qtd, 'teste', v_teste, 'tentativa', v_tentativa))
      RETURNING id INTO v_alerta;

      INSERT INTO public.radar_email_vendedor_envios
        (id, vendedor_user_id, semana, tentativa, destinatario_email, eh_teste, alerta_id, territorio, n_leads, elegiveis,
         criado_em, acompanhamento)
      VALUES (v_envio, r.vendedor, v_semana, v_tentativa, v_email, v_teste, v_alerta, v_terr, v_qtd, COALESCE(v_elegiveis, 0),
              p_agora, jsonb_build_object('retornos', v_ret, 'posses_vencendo', v_pos, 'posses_vencidas', v_venc));

      INSERT INTO public.radar_email_vendedor_leads (envio_id, posicao, cnpj, score, municipio_codigo, atribuido, visitar)
        SELECT v_envio, x.posicao, x.cnpj, x.score, x.municipio_codigo, x.atribuido, x.visitar
          FROM jsonb_to_recordset(v_leads) AS x(posicao smallint, cnpj text, score smallint, municipio_codigo text,
                                                atribuido boolean, visitar boolean);

      v_avisados := v_avisados || jsonb_build_object('vendedor', r.vendedor, 'envio_id', v_envio, 'alerta_id', v_alerta,
                                                     'n_leads', v_qtd, 'elegiveis', COALESCE(v_elegiveis, 0), 'atribuidos', v_atrib,
                                                     'visitar', v_visitar,
                                                     'retornos', jsonb_array_length(v_ret),
                                                     'posses_vencendo', jsonb_array_length(v_pos),
                                                     'posses_vencidas', jsonb_array_length(v_venc),
                                                     'tentativa', v_tentativa, 'teste', v_teste);
    EXCEPTION WHEN OTHERS THEN
      -- Não é engolir: o erro vai inteiro (SQLSTATE + mensagem) para o ledger, que sai com status 'erro'.
      GET STACKED DIAGNOSTICS v_estado = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_erros := v_erros || jsonb_build_object('vendedor', r.vendedor, 'sqlstate', v_estado, 'erro', left(v_msg, 300));
    END;
  END LOOP;

  -- Ledger só quando havia vendedor ligado: semana sem config ativa não suja acoes_execucoes
  -- (cron.job_run_details é a fonte do "rodou"). Pulado e erro também entram.
  IF jsonb_array_length(v_avisados) + jsonb_array_length(v_pulados) + jsonb_array_length(v_erros) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.avisar_vendedores', 'automatica', v_ini, clock_timestamp(),
            CASE WHEN jsonb_array_length(v_erros) = 0 THEN 'sucesso' ELSE 'erro' END,
            jsonb_build_object('semana', v_semana, 'avisados', v_avisados, 'pulados', v_pulados, 'erros', v_erros));
  END IF;

  RETURN jsonb_build_object('semana', v_semana, 'avisados', v_avisados, 'pulados', v_pulados, 'erros', v_erros);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_avisar_vendedores(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_avisar_vendedores(timestamptz) TO service_role;

-- ── 9. Tick diário: a posse vencida é FECHADA (registro imutável do vencimento) ────────────────────────
-- Fecha com encerrado_em = o vencimento calculado e motivo 'expirado' (o mesmo que radar_definir_atendimento grava ao
-- assumir por cima). A trava por CNPJ é a mesma do definir/atribuir: sem corrida com quem assume ou renova agora.
CREATE OR REPLACE FUNCTION public.radar_posses_vencer_tick(p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_ini timestamptz := clock_timestamp();
  r record;
  v_exp timestamptz;
  v_n integer := 0;
BEGIN
  FOR r IN SELECT a.id, a.cnpj FROM public.radar_atendimentos a WHERE a.encerrado_em IS NULL ORDER BY a.id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento:' || r.cnpj, 0));
    SELECT private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) INTO v_exp
      FROM public.radar_atendimentos a WHERE a.id = r.id AND a.encerrado_em IS NULL;
    IF FOUND AND v_exp <= p_agora THEN
      UPDATE public.radar_atendimentos a SET encerrado_em = v_exp, motivo_encerramento = 'expirado'
       WHERE a.id = r.id AND a.encerrado_em IS NULL;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.posses_vencer', 'automatica', v_ini, clock_timestamp(), 'sucesso', jsonb_build_object('fechadas', v_n));
  END IF;
  RETURN jsonb_build_object('fechadas', v_n);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_posses_vencer_tick(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_posses_vencer_tick(timestamptz) TO service_role;

-- 06:00 BRT, antes de o vendedor abrir o /meu-dia. SQL puro (sem net.http_post): não há timeout a configurar.
SELECT cron.schedule('radar-posses-vencer-diario', '0 9 * * *', 'SELECT public.radar_posses_vencer_tick()');

-- ── Postcondição ────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text;
BEGIN
  -- P1: a assinatura nova existe e a velha sumiu (duas convivendo deixariam o PostgREST escolher).
  IF to_regprocedure('public.registrar_contato_radar(text,text,text,date)') IS NULL
     OR to_regprocedure('public.registrar_contato_radar(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: registrar_contato_radar não está só na assinatura (text,text,text,date)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.radar_contatos'::regclass AND attname = 'retorno_em' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.radar_email_vendedor_envios'::regclass AND attname = 'acompanhamento' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'P1 FALHOU: coluna retorno_em ou acompanhamento ausente';
  END IF;

  -- P2: internas fechadas nas três pontas (o DROP+CREATE reseta o ACL; função nova nasce com o default do Supabase).
  FOREACH f IN ARRAY ARRAY['private.radar_dia_util(date)',
                           'private.radar_acompanhamentos(timestamptz)',
                           'private.radar_retornos_do_vendedor(uuid,date,timestamptz)',
                           'private.radar_posses_do_vendedor(uuid,timestamptz,timestamptz,timestamptz)',
                           'private.radar_leads_do_vendedor(uuid,integer,timestamptz)',
                           'public.radar_avisar_vendedores(timestamptz)',
                           'public.radar_posses_vencer_tick(timestamptz)'] LOOP
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P2 FALHOU: % executável por PUBLIC/anon/authenticated', f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.radar_posses_vencer_tick(timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.radar_avisar_vendedores(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: service_role perdeu o EXECUTE do tick ou do e-mail';
  END IF;

  -- P3: as RPCs do front: authenticated sim, PUBLIC/anon não; a leitura do card segue STABLE (allowlist da lente).
  FOREACH f IN ARRAY ARRAY['public.registrar_contato_radar(text,text,text,date)', 'public.radar_prospectar_hoje(uuid,integer)'] LOOP
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P3 FALHOU: ACL de % errada (quer authenticated sim, PUBLIC/anon não)', f;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'P3 FALHOU: radar_prospectar_hoje deixou de ser STABLE — sai da allowlist de leitura da lente';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.registrar_contato_radar(text,text,text,date)'::regprocedure) IS NOT TRUE THEN
    RAISE EXCEPTION 'P3 FALHOU: registrar_contato_radar perdeu o SECURITY DEFINER';
  END IF;

  -- P4: o cron do tick existe, ativo, no horário.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-posses-vencer-diario' AND active
                   AND schedule = '0 9 * * *' AND command = 'SELECT public.radar_posses_vencer_tick()') THEN
    RAISE EXCEPTION 'P4 FALHOU: cron radar-posses-vencer-diario ausente, inativo ou divergente';
  END IF;
END
$post$;

NOTIFY pgrst, 'reload schema';

COMMIT;
