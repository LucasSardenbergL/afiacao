-- ============================================================================================================
-- 20261029201200_radar_acesso_vendedor.sql — Radar de Clientes: gate PRÓPRIO que inclui o vendedor, dono
-- temporário do lead ("em atendimento por X", 7 dias) e aviso de telefone compartilhado.
-- Spec: docs/superpowers/specs/2026-10-29-radar-acesso-vendedor-design.md. Diário: docs/historico/radar-acesso-vendedor.md.
--
-- Por quê: a medição de 2026-10-28 mostrou que só o master abre o Radar. O gate era o da inteligência da
-- carteira (`pode_ver_carteira_completa` / `private.cap_carteira_ler`: master ou gestor comercial), e os 2
-- vendedores (`employee/farmer`) ficavam de fora. Aquele gate protege a carteira inteira em dezenas de RPCs e
-- NÃO muda aqui: o Radar ganha a capability `private.cap_radar_prospectar`, que soma farmer/hunter/closer.
-- Decisão do founder (2026-10-29): o vendedor vê, registra contato, assume lead e cadastra no Omie em 1 clique;
-- resolver conflito de cadastro e atribuir tarefa seguem gestor/master.
--
-- Caminho: `bun run db:aplicar` (a transação é do executor; o arquivo NÃO leva BEGIN/COMMIT). Molde
-- TRAVA → PRE → reescrita → PÓS para as 8 RPCs vivas (references/sql-house-style.md, "Recriar objeto VIVO"):
-- a troca é um replace() LITERAL do gate e da mensagem sobre o pg_get_functiondef VIVO, com o md5 exato do
-- predecessor de prod (psql-ro, 2026-10-29) e do resultado. Re-rodar é no-op (a PRE aceita "este").
-- Prova: db/test-radar-acesso-vendedor.sh (núcleo do CI). Revisão de desenho: Codex max, 2026-10-29 (3 P1 corrigidos).
-- ============================================================================================================

-- ── TRAVA: ALTER sem efeito (a volatilidade VIVA) em cada RPC que este arquivo reescreve, ANTES de ler ──────
DO $trava$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.sig, x.vol FROM (VALUES
      ('public.radar_kpis()', 'VOLATILE'),
      ('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone)', 'STABLE'),
      ('public.radar_estado_cadastro_omie(text)', 'VOLATILE'),
      ('public.radar_irmaos_por_raiz(text[])', 'STABLE'),
      ('public.radar_prospects_para_rota(text,integer)', 'STABLE'),
      ('public.radar_registrar_cadastro_omie(text,text,boolean)', 'VOLATILE'),
      ('public.radar_registrar_cadastro_omie_v2(text,text,boolean)', 'VOLATILE'),
      ('public.registrar_contato_radar(text,text,text)', 'VOLATILE')
    ) AS x(sig, vol)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'TRAVA FALHOU: % não existe — o predecessor de prod é obrigatório', r.sig;
    END IF;
    EXECUTE format('ALTER FUNCTION %s %s', r.sig, r.vol);
  END LOOP;
END
$trava$;

-- ── 1. A capability do Radar (NOVA: nenhuma função existente muda de significado) ────────────────────────────
CREATE OR REPLACE FUNCTION private.cap_radar_prospectar(_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('gerencial','estrategico','super_admin','farmer','hunter','closer')
        )
      )
    ), false);
$function$;
COMMENT ON FUNCTION private.cap_radar_prospectar(uuid) IS
  'Radar de Clientes: master, gestor comercial (gerencial/estrategico/super_admin) ou vendedor (farmer/hunter/closer). '
  'Dados do Radar são da RFB (públicos) + estado de prospecção: NÃO é pode_ver_carteira_completa, que segue protegendo a carteira.';
REVOKE ALL ON FUNCTION private.cap_radar_prospectar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_radar_prospectar(uuid) TO authenticated, service_role;

-- ── 2. Troca do gate nas 8 RPCs vivas: PRE (md5 exato) → replace literal → EXECUTE → guard do resultado ──────
-- Ficam gestor/master (o Codex achou o furo de cada uma ao abrir): radar_registrar_conflito_cadastro (um relato
-- livre de divergência vira bloqueio GLOBAL do CNPJ; o front já trata a recusa como aviso local "não sincronizado",
-- e a v2 segue gravando RD001/RD002 conferidos pelo banco), radar_salvar_geocode (sobrescreve coordenadas; sem
-- caller no app), radar_resolver_conflito_cadastro e radar_atribuir_tarefa (decisão do founder).
-- radar_irmaos_por_raiz ganha gate de PROJEÇÃO: os clientes que só existem no Omie (radar_docs_clientes ⊃
-- omie_clientes_nao_vinculados, tabela gestor-only) entram só para quem passa em cap_carteira_ler; o vendedor vê
-- os irmãos que o próprio Radar já mostra (radar_empresas.ja_cliente).
DO $troca$
DECLARE
  r record;
  t jsonb;
  v_vivo text;
  v_def text;
  v_novo text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.radar_kpis()',
       '19d4b2c33d5c6749b522147aae09c969', 'de4e4731507e4be5a085c90efdfc0687',
       '[["IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN",
          "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN"],
         ["forbidden: gestor/master only", "forbidden: radar_prospectar"]]'::jsonb),
      ('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone)',
       '321d07f0c0003cc0fc9cf269ba944883', '85dbce2b7d578f858e1239a5fbebcd43',
       '[["IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN",
          "IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN"],
         ["forbidden: gestor/master only", "forbidden: radar_prospectar"]]'::jsonb),
      ('public.radar_estado_cadastro_omie(text)',
       '79dea3224bbf32ad725a83d22b29aaac', 'f7001d52e2dda4002b5a51796091283f',
       '[["IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN",
          "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN"],
         ["forbidden: gestor/master only", "forbidden: radar_prospectar"]]'::jsonb),
      ('public.radar_irmaos_por_raiz(text[])',
       '15d1e7035c3deb7c44ffc6430f03021e', 'e7e9182a7662d0fc644b52a971dc2561',
       '[["IF NOT COALESCE(private.cap_carteira_ler(auth.uid()), false) THEN",
          "IF NOT (COALESCE(private.cap_radar_prospectar(auth.uid()), false)) THEN"],
         ["forbidden: carteira", "forbidden: radar_prospectar"],
         ["    SELECT d.doc, d.nome FROM public.radar_docs_clientes() d\n     WHERE left(d.doc, 8) IN (SELECT raiz FROM pedidos)",
          "    SELECT d.doc, d.nome FROM public.radar_docs_clientes() d\n     WHERE (SELECT COALESCE(private.cap_carteira_ler(auth.uid()), false)) AND left(d.doc, 8) IN (SELECT raiz FROM pedidos)"]]'::jsonb),
      ('public.radar_prospects_para_rota(text,integer)',
       '096e5379e5903f1b36c4a869445e34af', '816c866e853fa8eef7359bdc36bcee90',
       '[["IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN",
          "IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN"],
         ["forbidden: gestor/master only", "forbidden: radar_prospectar"]]'::jsonb),
      ('public.radar_registrar_cadastro_omie(text,text,boolean)',
       '2b3dbe0da01ac37b07b1cb5b76be139c', '0cd48f99a8683fa14c05a744372eb030',
       '[["IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN",
          "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN"],
         ["forbidden: gestor/master only", "forbidden: radar_prospectar"]]'::jsonb),
      ('public.radar_registrar_cadastro_omie_v2(text,text,boolean)',
       'b07c1a878e9930cb1a1a3c175be691d6', 'bda54cdc691c0682bb0e8b39a0fd7b0d',
       '[["IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN",
          "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN"],
         ["forbidden: gestor/master only", "forbidden: radar_prospectar"]]'::jsonb),
      ('public.registrar_contato_radar(text,text,text)',
       'c84e25c9e0926410a08775d8574d6734', '658d383c7f34f97427aacb053714ea3e',
       '[["IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN",
          "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN"],
         ["forbidden: gestor/master only", "forbidden: radar_prospectar"]]'::jsonb)
    ) AS x(sig, md5_predecessor, md5_este, trocas)
  LOOP
    SELECT md5(p.prosrc), pg_get_functiondef(p.oid) INTO v_vivo, v_def
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_vivo IS NULL THEN
      RAISE EXCEPTION 'PRE FALHOU: % não existe', r.sig;
    END IF;
    IF v_vivo = r.md5_este THEN
      CONTINUE;  -- já aplicada: re-rodar é no-op
    END IF;
    IF v_vivo <> r.md5_predecessor THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado (%) nem este (%)',
        r.sig, v_vivo, r.md5_predecessor, r.md5_este;
    END IF;
    v_novo := v_def;
    FOR t IN SELECT * FROM jsonb_array_elements(r.trocas) LOOP
      -- Guard do no-op: cada trecho casa EXATAMENTE 1× (corpo levemente diferente do medido aborta, não "aplica").
      IF (length(v_novo) - length(replace(v_novo, t->>0, ''))) / length(t->>0) <> 1 THEN
        RAISE EXCEPTION 'TROCA FALHOU: em %, o trecho [%] não casou exatamente 1×', r.sig, left(t->>0, 60);
      END IF;
      v_novo := replace(v_novo, t->>0, t->>1);
    END LOOP;
    EXECUTE v_novo;
    -- Guard do resultado: o md5 exato do esperado (calculado a partir do predecessor de prod).
    SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_vivo IS DISTINCT FROM r.md5_este THEN
      RAISE EXCEPTION 'TROCA FALHOU: % ficou com md5 % (esperado %)', r.sig, v_vivo, r.md5_este;
    END IF;
  END LOOP;
END
$troca$;

-- ACL reemitido NOMEANDO as roles (o CREATE OR REPLACE preserva, mas o fecho de função tem DUAS pontas).
REVOKE EXECUTE ON FUNCTION public.radar_kpis() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.radar_estado_cadastro_omie(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.radar_irmaos_por_raiz(text[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.radar_prospects_para_rota(text,integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie_v2(text,text,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_kpis() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.radar_estado_cadastro_omie(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.radar_irmaos_por_raiz(text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.radar_prospects_para_rota(text,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie_v2(text,text,boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) TO authenticated, service_role;
-- A v1 do cadastro pula a checagem "conflito ABERTO bloqueia o CNPJ" da v2, que a chama por dentro (SECURITY
-- DEFINER, dona postgres: a chamada aninhada não precisa de grant ao caller). Nenhum caller do app chama a v1
-- direto: ela sai do alcance do JWT, inclusive do gestor. O service_role fica como estava.
REVOKE EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) TO service_role;

-- ── 3. Policies de leitura (InitPlan). Ficam gestor: radar_cadastro_conflitos (quem resolve é o gestor; o lead
-- lê os abertos pela radar_estado_cadastro_omie) e radar_situacao_cadastral (guarda a situação RFB de CLIENTES fora
-- do Radar: o conjunto acompanhado é informação comercial; a ficha usa radar_empresas.rfb_situacao*) ────────────
ALTER POLICY radar_empresas_select_gestor ON public.radar_empresas
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));
ALTER POLICY radar_contatos_select_gestor ON public.radar_contatos
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));
ALTER POLICY radar_ingest_state_select_gestor ON public.radar_ingest_state
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));
ALTER POLICY radar_municipios_select_gestor ON public.radar_municipios
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));
-- radar_situacao_cadastral segue gestor, mas a policy viva chama o wrapper public.pode_ver_carteira_completa, que
-- NÃO tem EXECUTE para authenticated em prod (medido 2026-10-29): a leitura dava "permission denied" para TODO
-- mundo, gestor incluso — fail-closed latente, sem leitor no app. Mesma semântica, pela capability que funciona.
ALTER POLICY radar_situacao_cadastral_select_gestor ON public.radar_situacao_cadastral
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));
COMMENT ON POLICY radar_empresas_select_gestor ON public.radar_empresas IS
  'Nome histórico: desde 20261029201200 lê quem passa em private.cap_radar_prospectar (inclui vendedor).';
COMMENT ON POLICY radar_contatos_select_gestor ON public.radar_contatos IS
  'Nome histórico: desde 20261029201200 lê quem passa em private.cap_radar_prospectar (inclui vendedor).';
COMMENT ON POLICY radar_ingest_state_select_gestor ON public.radar_ingest_state IS
  'Nome histórico: desde 20261029201200 lê quem passa em private.cap_radar_prospectar (inclui vendedor).';
COMMENT ON POLICY radar_municipios_select_gestor ON public.radar_municipios IS
  'Nome histórico: desde 20261029201200 lê quem passa em private.cap_radar_prospectar (inclui vendedor).';

-- ── 4. Dono temporário do lead ──────────────────────────────────────────────────────────────────────────────
-- Uma linha por "atendimento"; no máximo 1 aberto por CNPJ. A expiração NÃO é escrita por cron: é calculada na
-- leitura pela cadeia de toques do dono, então registrar contato renova sem tocar registrar_contato_radar (frente 3).
CREATE TABLE IF NOT EXISTS public.radar_atendimentos (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cnpj text NOT NULL REFERENCES public.radar_empresas(cnpj),
  dono_user_id uuid NOT NULL,
  assumido_em timestamptz NOT NULL,
  renovado_em timestamptz,
  encerrado_em timestamptz,
  encerrado_por uuid,
  motivo_encerramento text,
  CONSTRAINT radar_atendimentos_motivo_chk
    CHECK (motivo_encerramento IN ('liberado', 'expirado', 'gestor_liberou')),
  CONSTRAINT radar_atendimentos_encerramento_chk
    CHECK ((encerrado_em IS NULL) = (motivo_encerramento IS NULL)),
  CONSTRAINT radar_atendimentos_ordem_chk
    CHECK (encerrado_em IS NULL OR encerrado_em >= assumido_em)
);
CREATE UNIQUE INDEX IF NOT EXISTS radar_atendimentos_aberto_uniq
  ON public.radar_atendimentos (cnpj) WHERE encerrado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_radar_atendimentos_dono_aberto
  ON public.radar_atendimentos (dono_user_id) WHERE encerrado_em IS NULL;
ALTER TABLE public.radar_atendimentos ENABLE ROW LEVEL SECURITY;
-- Fechada para o JWT: sem policy e sem grant (o REVOKE vem ANTES do GRANT: o default privilege do Supabase dá
-- arwdDxtm a anon/authenticated/service_role em toda tabela nova). Escrita só pela RPC (dona postgres); leitura
-- pelas RPCs gateadas e pelo service_role (placar server-side, frente 3).
REVOKE ALL ON TABLE public.radar_atendimentos FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.radar_atendimentos TO service_role;
COMMENT ON TABLE public.radar_atendimentos IS
  'Radar: "em atendimento por X". 1 aberto por CNPJ; expira 7 dias depois do último toque VÁLIDO do dono '
  '(calculado na leitura por private.radar_atendimento_expira_em). Único escritor: public.radar_definir_atendimento.';

-- Expiração pela CADEIA de toques: começa em assumido_em + 7 dias; cada contato do dono (ou renovação) ANTES de
-- expirar empurra para toque + 7 dias; o primeiro toque DEPOIS de expirar encerra a cadeia — contato tardio não
-- ressuscita a posse (achado 5 do Codex no desenho). O prazo vive SÓ aqui.
CREATE OR REPLACE FUNCTION private.radar_atendimento_expira_em(
  p_cnpj text, p_dono uuid, p_assumido_em timestamptz, p_renovado_em timestamptz)
 RETURNS timestamptz
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expira timestamptz := p_assumido_em + interval '7 days';
  v_toque timestamptz;
BEGIN
  FOR v_toque IN
    SELECT s.t FROM (
      SELECT c.created_at AS t FROM public.radar_contatos c
       WHERE c.cnpj = p_cnpj AND c.criado_por = p_dono AND c.created_at > p_assumido_em
      UNION ALL
      SELECT p_renovado_em WHERE p_renovado_em IS NOT NULL
    ) s ORDER BY s.t
  LOOP
    EXIT WHEN v_toque >= v_expira;
    v_expira := GREATEST(v_expira, v_toque + interval '7 days');
  END LOOP;
  RETURN v_expira;
END
$function$;
REVOKE ALL ON FUNCTION private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;

-- O ÚNICO escritor de radar_atendimentos. Trava por CNPJ com advisory (não a linha de radar_empresas: o recálculo
-- diário do score segura essas linhas). O relógio é lido DEPOIS da trava (clock_timestamp): now() é o início da
-- transação e, depois de esperar outra sessão, decidiria expiração com um instante velho (achado 6 do Codex).
CREATE OR REPLACE FUNCTION public.radar_definir_atendimento(p_cnpj text, p_acao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_agora timestamptz;
  v_ja_cliente boolean;
  v_aberto public.radar_atendimentos;
  v_ativo boolean := false;
  v_expira timestamptz;
  v_nome text;
  v_meus integer;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_acao IS NULL OR p_acao NOT IN ('assumir', 'liberar') THEN
    RAISE EXCEPTION 'radar_definir_atendimento: ação inválida (%)', COALESCE(p_acao, 'NULL') USING ERRCODE = '22023';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento:' || p_cnpj, 0));
  v_agora := clock_timestamp();

  SELECT e.ja_cliente INTO v_ja_cliente FROM public.radar_empresas e WHERE e.cnpj = p_cnpj;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_aberto FROM public.radar_atendimentos a WHERE a.cnpj = p_cnpj AND a.encerrado_em IS NULL;
  IF FOUND THEN
    v_expira := private.radar_atendimento_expira_em(v_aberto.cnpj, v_aberto.dono_user_id, v_aberto.assumido_em, v_aberto.renovado_em);
    IF v_expira > v_agora THEN
      v_ativo := true;
    ELSE
      UPDATE public.radar_atendimentos a
         SET encerrado_em = v_expira, motivo_encerramento = 'expirado'
       WHERE a.id = v_aberto.id;
    END IF;
  END IF;

  IF p_acao = 'assumir' THEN
    -- Já cliente não se assume nem se renova: não há o que prospectar.
    IF COALESCE(v_ja_cliente, false) THEN
      RETURN jsonb_build_object('ok', false, 'motivo', 'ja_cliente');
    END IF;
    IF v_ativo AND v_aberto.dono_user_id = v_uid THEN
      UPDATE public.radar_atendimentos a SET renovado_em = v_agora WHERE a.id = v_aberto.id;
      RETURN jsonb_build_object('ok', true, 'renovado', true, 'expira_em',
        private.radar_atendimento_expira_em(v_aberto.cnpj, v_aberto.dono_user_id, v_aberto.assumido_em, v_agora));
    ELSIF v_ativo THEN
      SELECT p.name INTO v_nome FROM public.profiles p WHERE p.user_id = v_aberto.dono_user_id;
      RETURN jsonb_build_object('ok', false, 'motivo', 'em_atendimento',
        'dono_user_id', v_aberto.dono_user_id, 'dono_nome', v_nome, 'expira_em', v_expira);
    END IF;
    -- Teto por dono: ninguém "trabalha" mais de 100 leads ao mesmo tempo, e o teto mantém a leitura dos ativos
    -- longe do corte de 1.000 linhas do PostgREST.
    SELECT count(*) INTO v_meus FROM public.radar_atendimentos a
     WHERE a.dono_user_id = v_uid AND a.encerrado_em IS NULL
       AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > v_agora;
    IF v_meus >= 100 THEN
      RETURN jsonb_build_object('ok', false, 'motivo', 'limite', 'limite', 100);
    END IF;
    INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES (p_cnpj, v_uid, v_agora);
    RETURN jsonb_build_object('ok', true, 'renovado', false, 'expira_em',
      private.radar_atendimento_expira_em(p_cnpj, v_uid, v_agora, NULL));
  END IF;

  -- liberar
  IF NOT v_ativo THEN
    RETURN jsonb_build_object('ok', true, 'ja_livre', true);
  END IF;
  IF v_aberto.dono_user_id = v_uid THEN
    UPDATE public.radar_atendimentos a
       SET encerrado_em = v_agora, encerrado_por = v_uid, motivo_encerramento = 'liberado'
     WHERE a.id = v_aberto.id;
  ELSIF COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    UPDATE public.radar_atendimentos a
       SET encerrado_em = v_agora, encerrado_por = v_uid, motivo_encerramento = 'gestor_liberou'
     WHERE a.id = v_aberto.id;
  ELSE
    SELECT p.name INTO v_nome FROM public.profiles p WHERE p.user_id = v_aberto.dono_user_id;
    RETURN jsonb_build_object('ok', false, 'motivo', 'nao_e_dono',
      'dono_user_id', v_aberto.dono_user_id, 'dono_nome', v_nome, 'expira_em', v_expira);
  END IF;
  RETURN jsonb_build_object('ok', true, 'ja_livre', false);
END
$function$;
REVOKE ALL ON FUNCTION public.radar_definir_atendimento(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_definir_atendimento(text,text) TO authenticated, service_role;

-- Os atendimentos ATIVOS (não expirados, de dono que ainda passa na capability). Lista e ficha leem a mesma
-- consulta; o teto de 100 por dono mantém o total longe do corte de 1.000 do PostgREST.
CREATE OR REPLACE FUNCTION public.radar_atendimentos_ativos()
 RETURNS TABLE(cnpj text, dono_user_id uuid, dono_nome text, assumido_em timestamptz, expira_em timestamptz, eh_meu boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.cnpj, a.dono_user_id, p.name, a.assumido_em, x.expira, (a.dono_user_id = v_uid)
      FROM public.radar_atendimentos a
      CROSS JOIN LATERAL (SELECT private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) AS expira) x
      LEFT JOIN public.profiles p ON p.user_id = a.dono_user_id
     WHERE a.encerrado_em IS NULL
       AND x.expira > now()
       AND private.cap_radar_prospectar(a.dono_user_id)
     ORDER BY a.cnpj;
END
$function$;
REVOKE ALL ON FUNCTION public.radar_atendimentos_ativos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_atendimentos_ativos() TO authenticated, service_role;

-- ── 5. Telefone compartilhado: em quantas OUTRAS raízes de CNPJ o número aparece (aviso, nunca classificação) ─
-- Medido em 2026-10-29: 23.369 números em ≥2 raízes, 1.740 em ≥5, máx. 267 (provável contador). Formato uniforme
-- `(DD) NNNNNNNN` (552.727 de 556 mil) ⇒ casamento pelo texto. Os índices travam a ESCRITA em radar_empresas
-- durante a construção (segundos): aplicar fora da janela dos crons do radar (06:05–06:45 UTC).
CREATE INDEX IF NOT EXISTS idx_radar_empresas_tel1 ON public.radar_empresas (telefone1) WHERE telefone1 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_radar_empresas_tel2 ON public.radar_empresas (telefone2) WHERE telefone2 IS NOT NULL;

CREATE OR REPLACE FUNCTION public.radar_telefone_compartilhado(p_cnpj text)
 RETURNS TABLE(telefone text, outras_raizes integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH t AS (
      SELECT DISTINCT v.tel
        FROM public.radar_empresas e
        CROSS JOIN LATERAL (VALUES (e.telefone1), (e.telefone2)) AS v(tel)
       WHERE e.cnpj = p_cnpj AND NULLIF(btrim(v.tel), '') IS NOT NULL
    )
    SELECT t.tel,
           (SELECT count(DISTINCT left(o.cnpj, 8))::integer
              FROM public.radar_empresas o
             WHERE (o.telefone1 = t.tel OR o.telefone2 = t.tel)
               AND left(o.cnpj, 8) <> left(p_cnpj, 8))
      FROM t
     ORDER BY t.tel;
END
$function$;
REVOKE ALL ON FUNCTION public.radar_telefone_compartilhado(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_telefone_compartilhado(text) TO authenticated, service_role;

-- ── PÓS: relê o catálogo; qualquer estado insuficiente aborta a transação inteira ───────────────────────────
DO $post$
DECLARE
  r record;
  v text;
BEGIN
  -- capability: existe, SECDEF, fechada para anon/PUBLIC, aberta para authenticated; uid nulo é false.
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('private.cap_radar_prospectar(uuid)')) THEN
    RAISE EXCEPTION 'A1 FALHOU: private.cap_radar_prospectar ausente ou sem SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'private.cap_radar_prospectar(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'private.cap_radar_prospectar(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'private.cap_radar_prospectar(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A2 FALHOU: ACL de cap_radar_prospectar (anon/PUBLIC fechados, authenticated aberto)';
  END IF;
  IF private.cap_radar_prospectar(NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'A3 FALHOU: cap_radar_prospectar(NULL) não é false — fail-open';
  END IF;

  -- as 8 RPCs trocadas: gate novo, sem pode_ver_carteira_completa, SECDEF preservado, ACL certo.
  FOR r IN SELECT * FROM (VALUES
      ('public.radar_kpis()', true),
      ('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone)', true),
      ('public.radar_estado_cadastro_omie(text)', true),
      ('public.radar_irmaos_por_raiz(text[])', true),
      ('public.radar_prospects_para_rota(text,integer)', true),
      ('public.radar_registrar_cadastro_omie(text,text,boolean)', false),
      ('public.radar_registrar_cadastro_omie_v2(text,text,boolean)', true),
      ('public.registrar_contato_radar(text,text,text)', true)
    ) AS x(sig, authenticated_executa)
  LOOP
    SELECT p.prosrc INTO v FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig) AND p.prosecdef;
    IF v IS NULL OR v !~ 'IF NOT \(COALESCE\(private\.cap_radar_prospectar\(' OR v ~ 'pode_ver_carteira_completa' THEN
      RAISE EXCEPTION 'B1 FALHOU: % sem o gate novo, sem SECDEF ou com sobra do antigo', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') OR has_function_privilege('public', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'B2 FALHOU: % executável por anon/PUBLIC', r.sig;
    END IF;
    IF has_function_privilege('authenticated', r.sig, 'EXECUTE') IS DISTINCT FROM r.authenticated_executa THEN
      RAISE EXCEPTION 'B3 FALHOU: EXECUTE de authenticated em % deveria ser %', r.sig, r.authenticated_executa;
    END IF;
  END LOOP;
  -- irmãos: a projeção dos clientes só-Omie segue no gate da carteira (exatamente 1 menção).
  SELECT p.prosrc INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_irmaos_por_raiz(text[])');
  IF (length(v) - length(replace(v, 'private.cap_carteira_ler(auth.uid())', ''))) / length('private.cap_carteira_ler(auth.uid())') <> 1 THEN
    RAISE EXCEPTION 'B4 FALHOU: radar_irmaos_por_raiz perdeu a projeção dos clientes só-Omie';
  END IF;
  -- os que ficam gestor/master NÃO mudaram.
  FOR r IN SELECT * FROM (VALUES
      ('public.radar_resolver_conflito_cadastro(bigint,integer,text)'),
      ('public.radar_atribuir_tarefa(text,integer)'),
      ('public.radar_registrar_conflito_cadastro(text,text,text,text)'),
      ('public.radar_salvar_geocode(text,double precision,double precision,text)')
    ) AS x(sig)
  LOOP
    SELECT p.prosrc INTO v FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v IS NULL OR v !~ 'pode_ver_carteira_completa' OR v ~ 'cap_radar_prospectar' THEN
      RAISE EXCEPTION 'B5 FALHOU: % deveria seguir gestor/master', r.sig;
    END IF;
  END LOOP;

  -- policies: as 4 com a capability nova; conflitos e situação seguem gestor.
  FOR r IN SELECT * FROM (VALUES ('radar_empresas'), ('radar_contatos'), ('radar_ingest_state'), ('radar_municipios')) AS x(t)
  LOOP
    SELECT p.qual INTO v FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = r.t AND p.policyname = r.t || '_select_gestor' AND p.cmd = 'SELECT';
    IF v IS NULL OR v !~ 'cap_radar_prospectar' OR v ~ '(cap_carteira_ler|pode_ver_carteira_completa)' THEN
      RAISE EXCEPTION 'C1 FALHOU: policy de leitura de % sem a capability nova', r.t;
    END IF;
  END LOOP;
  IF (SELECT p.qual FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'radar_cadastro_conflitos'
        AND p.policyname = 'radar_cadastro_conflitos_select_gestor') !~ 'cap_carteira_ler'
     OR (SELECT p.qual FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'radar_situacao_cadastral'
        AND p.policyname = 'radar_situacao_cadastral_select_gestor') !~ 'cap_carteira_ler' THEN
    RAISE EXCEPTION 'C2 FALHOU: radar_cadastro_conflitos e radar_situacao_cadastral deveriam seguir no gate do gestor';
  END IF;

  -- atendimentos: RLS ligada, fechada para o JWT, 1 aberto por CNPJ garantido por índice VÁLIDO.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.radar_atendimentos'::regclass) THEN
    RAISE EXCEPTION 'D1 FALHOU: radar_atendimentos sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.radar_atendimentos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.radar_atendimentos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.radar_atendimentos', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.radar_atendimentos', 'SELECT') THEN
    RAISE EXCEPTION 'D2 FALHOU: ACL de radar_atendimentos (JWT fechado; service_role só SELECT)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.radar_atendimentos_aberto_uniq')
                   AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION 'D3 FALHOU: índice único parcial de atendimento aberto ausente ou inválido';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.radar_atendimentos'::regclass
        AND c.contype IN ('c', 'f') AND c.convalidated) <> 4 THEN
    RAISE EXCEPTION 'D4 FALHOU: radar_atendimentos deveria ter 3 CHECK + 1 FK validados';
  END IF;

  -- RPCs novas: SECDEF, gate na forma reconhecida, ACL de duas pontas.
  FOR r IN SELECT * FROM (VALUES ('public.radar_definir_atendimento(text,text)'),
                                  ('public.radar_atendimentos_ativos()'),
                                  ('public.radar_telefone_compartilhado(text)')) AS x(sig)
  LOOP
    SELECT p.prosrc INTO v FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig) AND p.prosecdef;
    IF v IS NULL OR v !~ 'IF NOT \(COALESCE\(private\.cap_radar_prospectar\(' THEN
      RAISE EXCEPTION 'E1 FALHOU: % ausente, sem SECDEF ou sem o gate', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') OR has_function_privilege('public', r.sig, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'E2 FALHOU: ACL de %', r.sig;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'E3 FALHOU: radar_atendimento_expira_em alcançável pelo JWT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.idx_radar_empresas_tel1') AND i.indisvalid)
     OR NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.idx_radar_empresas_tel2') AND i.indisvalid) THEN
    RAISE EXCEPTION 'E4 FALHOU: índices de telefone ausentes ou inválidos';
  END IF;
  RAISE NOTICE 'radar_acesso_vendedor: capability + 8 RPCs + 4 policies + atendimentos + telefone OK';
END
$post$;
