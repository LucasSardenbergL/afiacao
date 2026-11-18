#!/usr/bin/env bash
# PROVA DE TRIAGEM — scanner Lovable Security, lote 6 (docs/historico/scanner-lovable-rescan-lote6.md).
#
# Não guarda conserto de banco (o lote 6 não tem migration): EXECUTA, num PG17 descartável, os três
# fatos de banco em que a triagem dos achados se apoia. DDL, policies e consultas foram copiadas da
# PROD em 2026-11-17 (psql-ro: pg_policy, pg_get_functiondef, prosrc).
#
#   A  gamification_scores (achado 1): a conta logada grava a PRÓPRIA linha com qualquer valor, não
#      toca a alheia, e o ranking do staff lê o valor forjado em 1º.
#   B  webauthn_challenges (achado 2): o upsert da edge (ON CONFLICT (credential_id)) falha com 42P10,
#      porque a tabela só tem índice NÃO único nessa coluna — nada é gravado. Controle: com UNIQUE o
#      mesmo comando grava e a 2ª chamada troca o desafio (é o que o scanner descreve).
#   C  tint_staging_corantes (achado 3): as duas consultas de "mais recente" do corpo vivo de
#      tint_promote_sync_run e o DELETE de tint_staging_purge. Uma linha com created_at forjado vence
#      o run honesto, o reenvio honesto posterior não desfaz, e a purga apaga as honestas e poupa a
#      forjada. É uma MINIATURA das consultas, não a função inteira; o critério (created_at, id) da
#      função inteira está provado em db/test-tint-promote-latest-indexado.sh.
#
# Uso:  db/test-seg-lote6-triagem.sh               (LOCALE_TESTE=C|pt_BR.UTF-8, PGPORT_TEST=<porta>)
#       db/test-seg-lote6-triagem.sh --falsificar  (controle verde + 5 sabotagens, nos dois locales)
#
# Sabotagens (cada uma é também o ESTADO que fecharia o achado):
#   gam_sem_escrita_do_dono   sem as 2 policies de escrita do dono     → caem A1, A2 e A6
#   webauthn_com_unique       com UNIQUE (credential_id)               → cai B1
#   tint_data_do_servidor     a linha entra com created_at do servidor → caem C2 e C3 (C1 não: a
#                             linha mais nova continua vencendo — é a autoridade normal do conector)
# E duas de NÃO-VACUIDADE (a 1ª escrita some sem erro; o assert tem de notar que nada foi gravado):
#   gam_insert_descartado     gatilho descarta o INSERT de score 999999     → cai A1
#   webauthn_ctl_1a_descartada gatilho descarta o 1º desafio do controle    → cai B2
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--falsificar" ]; then
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-lote6.XXXXXX")"
  trap 'rm -rf "$LOGDIR"' EXIT
  falhas=0
  for loc in C pt_BR.UTF-8; do
    # CONTROLE na mesma invocação do laço: sem ele, uma suíte sempre-vermelha aprovaria tudo.
    if ! LOCALE_TESTE="$loc" bash "$0" > "$LOGDIR/controle.log" 2>&1 || ! grep -q '^PROVA_TRIAGEM_OK' "$LOGDIR/controle.log"; then
      echo "CONTROLE vermelho em $loc — abortando antes de sabotar"; tail -5 "$LOGDIR/controle.log"; exit 3
    fi
    echo "controle verde ($loc)"
    for par in "gam_sem_escrita_do_dono:A1_ A2_ A6_" "webauthn_com_unique:B1_" "tint_data_do_servidor:C2_ C3_" \
               "gam_insert_descartado:A1_" "webauthn_ctl_1a_descartada:B2_"; do
      sab="${par%%:*}"; esperados="${par#*:}"
      if SABOTAGEM="$sab" LOCALE_TESTE="$loc" bash "$0" > "$LOGDIR/sab.log" 2>&1; then
        echo "FALHA: sabotagem $sab ficou VERDE ($loc)"; falhas=$((falhas + 1)); continue
      fi
      n_esperados=0
      for a in $esperados; do
        n_esperados=$((n_esperados + 1))
        grep -q "^FALHOU | ${a}" "$LOGDIR/sab.log" || { echo "FALHA: sabotagem $sab não derrubou ${a} ($loc)"; falhas=$((falhas + 1)); }
      done
      n_caidos="$(grep -c '^FALHOU | ' "$LOGDIR/sab.log" || true)"
      if [ "$n_caidos" -ne "$n_esperados" ]; then
        echo "FALHA: sabotagem $sab derrubou $n_caidos assert(s), esperado $n_esperados ($loc)"; falhas=$((falhas + 1))
      else
        echo "sabotagem $sab vermelha no(s) assert(s) esperado(s): $esperados ($loc)"
      fi
    done
  done
  echo "FALSIFICACAO: $falhas falha(s)"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5978}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-lote6.XXXXXX")"
DATA="$WORK/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ── Os três pontos que a falsificação troca ──────────────────────────────────────────────────
GAM_ESCRITA_DO_DONO="sim"                     # as 2 policies de escrita do dono existem (PROD)
WEBAUTHN_UNIQUE=""                            # PROD: só índice não único em credential_id
FORJA_CREATED_AT="'2099-01-01T00:00:00Z'"     # o created_at que o item escolhia (edge v1.3)
GAM_GATILHO=""                                # não-vacuidade: descarta em silêncio o INSERT do A1
CTL_GATILHO=""                                # não-vacuidade: descarta em silêncio o 1º desafio do B2
case "${SABOTAGEM:-}" in
  '') ;;
  gam_sem_escrita_do_dono) GAM_ESCRITA_DO_DONO="nao" ;;
  webauthn_com_unique)     WEBAUTHN_UNIQUE="ALTER TABLE public.webauthn_challenges ADD UNIQUE (credential_id);" ;;
  tint_data_do_servidor)   FORJA_CREATED_AT="DEFAULT" ;;
  gam_insert_descartado)   GAM_GATILHO="CREATE TRIGGER t_descarta BEFORE INSERT ON public.gamification_scores FOR EACH ROW WHEN (NEW.total_score = 999999) EXECUTE FUNCTION public._descarta();" ;;
  webauthn_ctl_1a_descartada) CTL_GATILHO="CREATE TRIGGER t_descarta BEFORE INSERT ON public.webauthn_challenges_ctl FOR EACH ROW WHEN (NEW.challenge = 'desafio-A') EXECUTE FUNCTION public._descarta();" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "${SABOTAGEM:-}" ] || echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P() { "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }

P -v gam_escrita="$GAM_ESCRITA_DO_DONO" -v webauthn_unique="$WEBAUTHN_UNIQUE" -v forja_created_at="$FORJA_CREATED_AT" \
  -v gam_gatilho="$GAM_GATILHO" -v ctl_gatilho="$CTL_GATILHO" >/dev/null <<'SQL'
-- ───────── infra mínima ─────────
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
-- corpo vivo de has_role (pg_get_functiondef na PROD)
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE TABLE public._veredito (nome text PRIMARY KEY, ok boolean NOT NULL, detalhe text);
-- só as sabotagens de não-vacuidade a usam: um BEFORE INSERT que devolve NULL descarta a linha SEM erro
CREATE FUNCTION public._descarta() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;
GRANT ALL ON public._veredito TO anon, authenticated;

-- ───────── A. gamification_scores como na PROD ─────────
CREATE TABLE public.gamification_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  consistency_score numeric NOT NULL DEFAULT 0,
  organization_score numeric NOT NULL DEFAULT 0,
  education_score numeric NOT NULL DEFAULT 0,
  referral_score numeric NOT NULL DEFAULT 0,
  efficiency_score numeric NOT NULL DEFAULT 0,
  total_score numeric NOT NULL DEFAULT 0,
  level integer NOT NULL DEFAULT 1,
  level_name text NOT NULL DEFAULT 'Operacional',
  tool_health_index numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gamification_scores ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.gamification_scores TO anon, authenticated;   -- relacl da PROD: arwdDxtm nos dois
-- as 5 policies, expressões copiadas de pg_policy (polroles = PUBLIC)
CREATE POLICY "Staff can manage all gamification scores" ON public.gamification_scores FOR ALL
  USING ((( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'employee'::app_role) AS has_role)))
  WITH CHECK ((( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'employee'::app_role) AS has_role)));
CREATE POLICY "Staff can view all gamification scores" ON public.gamification_scores FOR SELECT
  USING ((( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'employee'::app_role) AS has_role)));
CREATE POLICY "Users can view their own gamification score" ON public.gamification_scores FOR SELECT
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can upsert their own score" ON public.gamification_scores FOR INSERT
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update their own score" ON public.gamification_scores FOR UPDATE
  USING ((auth.uid() = user_id));
SELECT (:'gam_escrita' = 'nao') AS tira_escrita_do_dono \gset
\if :tira_escrita_do_dono
  DROP POLICY "Users can upsert their own score" ON public.gamification_scores;
  DROP POLICY "Users can update their own score" ON public.gamification_scores;
\endif

:gam_gatilho

-- atores: C1 é conta SEM papel nenhum (cadastro recém-feito, não aprovado); E1 é employee
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-0000000000e1', 'employee');
-- linha honesta do C2, gravada pelo dono da tabela
INSERT INTO public.gamification_scores (user_id, total_score, level, level_name)
  VALUES ('00000000-0000-0000-0000-0000000000c2', 35, 2, 'Organizado');

-- A1: conta sem papel insere a PRÓPRIA linha com valores absurdos
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
DO $$
DECLARE v_state text := 'OK'; v_total numeric; v_level int; v_nome text;
BEGIN
  BEGIN
    INSERT INTO public.gamification_scores (user_id, total_score, level, level_name)
      VALUES ('00000000-0000-0000-0000-0000000000c1', 999999, 99, 'TEXTO LIVRE DO CLIENTE');
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  -- "não deu erro" não basta: relê, como o próprio dono, o que ficou gravado
  SELECT total_score, level, level_name INTO v_total, v_level, v_nome
    FROM public.gamification_scores WHERE user_id = '00000000-0000-0000-0000-0000000000c1';
  INSERT INTO public._veredito VALUES ('A1_cliente_insere_propria_linha_forjada',
    coalesce(v_state = 'OK' AND v_total = 999999 AND v_level = 99 AND v_nome = 'TEXTO LIVRE DO CLIENTE', false),
    v_state || '; gravado=' || coalesce(v_total::text, 'NADA') || '/' || coalesce(v_level::text, '-') || '/' || coalesce(v_nome, '-'));
END $$;
-- A2: o upsert do hook (onConflict user_id) regrava a própria linha
DO $$
DECLARE v_state text := 'OK'; v_total numeric; v_level int; v_nome text;
BEGIN
  BEGIN
    INSERT INTO public.gamification_scores (user_id, total_score, level, level_name)
      VALUES ('00000000-0000-0000-0000-0000000000c1', 100, 5, 'Parceiro Estratégico')
      ON CONFLICT (user_id) DO UPDATE SET total_score = EXCLUDED.total_score, level = EXCLUDED.level, level_name = EXCLUDED.level_name;
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  SELECT total_score, level, level_name INTO v_total, v_level, v_nome
    FROM public.gamification_scores WHERE user_id = '00000000-0000-0000-0000-0000000000c1';
  INSERT INTO public._veredito VALUES ('A2_cliente_upsert_proprio',
    coalesce(v_state = 'OK' AND v_total = 100 AND v_level = 5 AND v_nome = 'Parceiro Estratégico', false),
    v_state || '; gravado=' || coalesce(v_total::text, 'NADA') || '/' || coalesce(v_level::text, '-') || '/' || coalesce(v_nome, '-'));
END $$;
-- A3: a mesma conta NÃO insere linha de outro usuário (esperado 42501; outro erro aborta a prova)
DO $$
DECLARE v_state text := 'OK';
BEGIN
  BEGIN
    INSERT INTO public.gamification_scores (user_id, total_score) VALUES ('00000000-0000-0000-0000-0000000000c3', 100);
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  INSERT INTO public._veredito VALUES ('A3_cliente_nao_insere_linha_alheia', v_state = '42501', v_state);
END $$;
-- A4: nem altera a linha do C2 (zero linha, sem erro)
DO $$
DECLARE v_n int;
BEGIN
  UPDATE public.gamification_scores SET total_score = 100 WHERE user_id = '00000000-0000-0000-0000-0000000000c2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public._veredito VALUES ('A4_cliente_nao_altera_linha_alheia', v_n = 0, v_n::text || ' linha(s)');
END $$;
RESET ROLE;
-- A5: anon não escreve — esperado 42501
SET ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', false);
DO $$
DECLARE v_state text := 'OK';
BEGIN
  BEGIN
    INSERT INTO public.gamification_scores (user_id, total_score) VALUES ('00000000-0000-0000-0000-0000000000c4', 100);
  EXCEPTION WHEN insufficient_privilege THEN v_state := SQLSTATE;
  END;
  INSERT INTO public._veredito VALUES ('A5_anon_nao_escreve', v_state = '42501', v_state);
END $$;
RESET ROLE;
-- A6: o ranking do staff (AdminGamification: ORDER BY total_score DESC) lê o valor forjado em 1º
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
DO $$
DECLARE v_top uuid; v_score numeric; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.gamification_scores;
  SELECT user_id, total_score INTO v_top, v_score FROM public.gamification_scores ORDER BY total_score DESC LIMIT 1;
  INSERT INTO public._veredito VALUES ('A6_ranking_do_staff_le_o_forjado',
    v_n = 2 AND v_top = '00000000-0000-0000-0000-0000000000c1' AND v_score = 100,
    v_n::text || ' linhas; topo=' || right(v_top::text, 2) || ' score=' || v_score::text);
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- ───────── B. webauthn_challenges como na PROD (PK em id, índice NÃO único em credential_id) ─────────
CREATE TABLE public.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + '00:05:00'::interval),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webauthn_challenges_credential_id ON public.webauthn_challenges USING btree (credential_id);
:webauthn_unique
-- gêmea de CONTROLE: a mesma tabela COM a unicidade que o upsert pressupõe
CREATE TABLE public.webauthn_challenges_ctl (LIKE public.webauthn_challenges INCLUDING DEFAULTS);
ALTER TABLE public.webauthn_challenges_ctl ADD PRIMARY KEY (id), ADD UNIQUE (credential_id);
:ctl_gatilho

-- B1: o upsert da edge (PostgREST: INSERT ... ON CONFLICT (credential_id) DO UPDATE) na tabela da PROD
DO $$
DECLARE v_state text := 'OK'; v_n int;
BEGIN
  BEGIN
    INSERT INTO public.webauthn_challenges (credential_id, challenge, expires_at)
      VALUES ('cred-da-vitima', 'desafio-A', now() + interval '5 minutes')
      ON CONFLICT (credential_id) DO UPDATE SET challenge = EXCLUDED.challenge, expires_at = EXCLUDED.expires_at;
  EXCEPTION WHEN invalid_column_reference THEN v_state := SQLSTATE;   -- 42P10
  END;
  SELECT count(*) INTO v_n FROM public.webauthn_challenges;
  INSERT INTO public._veredito VALUES ('B1_upsert_da_edge_falha_42P10_e_nada_grava', v_state = '42P10' AND v_n = 0,
    'sqlstate=' || v_state || '; linhas=' || v_n::text);
END $$;
-- B2 (controle): com UNIQUE(credential_id) o MESMO comando grava, e a 2ª chamada troca o desafio
DO $$
DECLARE v_state text := 'OK'; v_n1 int; v_ch1 text; v_n int; v_ch text;
BEGIN
  BEGIN
    INSERT INTO public.webauthn_challenges_ctl (credential_id, challenge, expires_at)
      VALUES ('cred-da-vitima', 'desafio-A', now() + interval '5 minutes')
      ON CONFLICT (credential_id) DO UPDATE SET challenge = EXCLUDED.challenge, expires_at = EXCLUDED.expires_at;
    -- a 1ª gravação tem de estar lá ANTES da 2ª: senão "o desafio final é o do terceiro" não prova troca
    SELECT count(*), max(challenge) INTO v_n1, v_ch1 FROM public.webauthn_challenges_ctl;
    INSERT INTO public.webauthn_challenges_ctl (credential_id, challenge, expires_at)
      VALUES ('cred-da-vitima', 'desafio-do-terceiro', now() + interval '5 minutes')
      ON CONFLICT (credential_id) DO UPDATE SET challenge = EXCLUDED.challenge, expires_at = EXCLUDED.expires_at;
  EXCEPTION WHEN invalid_column_reference THEN v_state := SQLSTATE;
  END;
  SELECT count(*), max(challenge) INTO v_n, v_ch FROM public.webauthn_challenges_ctl;
  INSERT INTO public._veredito VALUES ('B2_controle_com_unique_o_desafio_e_trocado',
    coalesce(v_state = 'OK' AND v_n1 = 1 AND v_ch1 = 'desafio-A' AND v_n = 1 AND v_ch = 'desafio-do-terceiro', false),
    'sqlstate=' || v_state || '; depois da 1a=' || coalesce(v_n1::text, '?') || ' linha(s) com ' || coalesce(v_ch1, 'NULL')
      || '; no fim=' || v_n::text || ' linha(s) com ' || coalesce(v_ch, 'NULL'));
END $$;

-- ───────── C. tint_staging_corantes como na PROD ─────────
CREATE TABLE public.tint_staging_corantes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid NOT NULL,
  account text NOT NULL,
  store_code text NOT NULL,
  id_corante_sayersystem text NOT NULL,
  descricao text,
  preco_litro numeric,
  raw_data jsonb,
  staging_status text NOT NULL DEFAULT 'pending',
  matched_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  custo numeric,
  volume_ml numeric
);
-- As duas consultas do corpo VIVO de tint_promote_sync_run (linhas 126-142 e 526-532 do prosrc) e o
-- DELETE de tint_staging_purge (linhas 52-57), copiados da PROD; as variáveis viraram parâmetros.
CREATE FUNCTION public._c_tp_cor(p_sync_run_id uuid, v_account text, v_store text)
RETURNS TABLE (id_corante_sayersystem text, custo numeric, volume_ml numeric) LANGUAGE sql AS $f$
  WITH chaves AS (
    SELECT DISTINCT id_corante_sayersystem FROM tint_staging_corantes
    WHERE sync_run_id = p_sync_run_id AND id_corante_sayersystem IS NOT NULL
  ),
  latest AS (
    SELECT l.id_corante_sayersystem, l.descricao, l.preco_litro, l.custo, l.volume_ml
    FROM chaves c
    CROSS JOIN LATERAL (
      SELECT s.id_corante_sayersystem, s.descricao, s.preco_litro, s.custo, s.volume_ml
      FROM tint_staging_corantes s
      WHERE s.account = v_account AND s.store_code = v_store AND s.id_corante_sayersystem = c.id_corante_sayersystem
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    ) l
  )
  SELECT id_corante_sayersystem, custo, volume_ml FROM latest;
$f$;
CREATE FUNCTION public._c_cor_latest(v_account text, v_store text)
RETURNS TABLE (id_corante_sayersystem text, custo numeric, volume_ml numeric) LANGUAGE sql AS $f$
  SELECT DISTINCT ON (id_corante_sayersystem)
         id_corante_sayersystem, custo, volume_ml
  FROM tint_staging_corantes
  WHERE account = v_account AND store_code = v_store
    AND custo IS NOT NULL AND volume_ml IS NOT NULL
  ORDER BY id_corante_sayersystem, created_at DESC, id DESC;
$f$;
CREATE FUNCTION public._c_purga() RETURNS int LANGUAGE plpgsql AS $f$
DECLARE v_n int;
BEGIN
  DELETE FROM tint_staging_corantes s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_corantes n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.id_corante_sayersystem = s.id_corante_sayersystem
        AND (n.created_at, n.id) > (s.created_at, s.id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $f$;

-- C0 (controle): só linhas honestas → vence a mais nova (custo 12)
INSERT INTO public.tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, custo, volume_ml, created_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'oben', 'M01', 'COR-1', 10, 1000, now() - interval '2 days'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'oben', 'M01', 'COR-1', 12, 1000, now() - interval '1 hour');
DO $$
DECLARE v_a numeric; v_b numeric;
BEGIN
  SELECT custo INTO v_a FROM public._c_tp_cor('aaaaaaaa-0000-0000-0000-000000000003', 'oben', 'M01');
  SELECT custo INTO v_b FROM public._c_cor_latest('oben', 'M01');
  INSERT INTO public._veredito VALUES ('C0_controle_sem_forja_vence_a_mais_nova', v_a = 12 AND v_b = 12, 'tp_cor=' || v_a || '; cor_latest=' || v_b);
END $$;
-- C1: entra UMA linha de custo 0,01 com o created_at que o ITEM escolheu (o que a edge v1.3 gravava)
INSERT INTO public.tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, custo, volume_ml, created_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002', 'oben', 'M01', 'COR-1', 0.01, 1000, :forja_created_at);
DO $$
DECLARE v_a numeric; v_b numeric;
BEGIN
  -- a promoção do run HONESTO (…003) passa a ler a linha de custo 0,01
  SELECT custo INTO v_a FROM public._c_tp_cor('aaaaaaaa-0000-0000-0000-000000000003', 'oben', 'M01');
  SELECT custo INTO v_b FROM public._c_cor_latest('oben', 'M01');
  INSERT INTO public._veredito VALUES ('C1_linha_de_custo_001_vence_o_run_honesto', v_a = 0.01 AND v_b = 0.01, 'tp_cor=' || v_a || '; cor_latest=' || v_b);
END $$;
-- C2: reenvio honesto DEPOIS (run …004) não desfaz
SELECT pg_sleep(0.05);
INSERT INTO public.tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, custo, volume_ml) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000004', 'oben', 'M01', 'COR-1', 13, 1000);
DO $$
DECLARE v_a numeric;
BEGIN
  SELECT custo INTO v_a FROM public._c_tp_cor('aaaaaaaa-0000-0000-0000-000000000004', 'oben', 'M01');
  INSERT INTO public._veredito VALUES ('C2_reenvio_honesto_posterior_nao_desfaz', v_a = 0.01, 'tp_cor=' || v_a);
END $$;
-- C3: passados 30+ dias, a purga apaga as HONESTAS (têm uma "mais nova") e poupa a forjada
UPDATE public.tint_staging_corantes SET created_at = created_at - interval '40 days' WHERE created_at < '2090-01-01';
DO $$
DECLARE v_del int; v_rest int; v_custo numeric;
BEGIN
  v_del := public._c_purga();
  SELECT count(*), max(custo) INTO v_rest, v_custo FROM public.tint_staging_corantes;
  INSERT INTO public._veredito VALUES ('C3_purga_apaga_as_honestas_e_poupa_a_forjada', v_del = 3 AND v_rest = 1 AND v_custo = 0.01,
    'apagadas=' || v_del || '; restam=' || v_rest || '; custo=' || v_custo);
END $$;
SQL

echo "== veredito (locale $LOC) =="
P -At -F ' | ' -c "SELECT CASE WHEN ok THEN 'ok' ELSE 'FALHOU' END, nome, detalhe FROM public._veredito ORDER BY nome"
TOTAL="$(P -At -c "SELECT count(*) FROM public._veredito")"
FALHAS="$(P -At -c "SELECT count(*) FROM public._veredito WHERE NOT ok")"
echo "TOTAL=$TOTAL FALHAS=$FALHAS"
if [ "$TOTAL" -eq 12 ] && [ "$FALHAS" -eq 0 ]; then
  echo "PROVA_TRIAGEM_OK locale=$LOC"
else
  exit 1
fi
