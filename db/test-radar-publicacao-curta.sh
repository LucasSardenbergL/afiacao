#!/usr/bin/env bash
# Prova PG17 da PUBLICAÇÃO EM PASSOS da carga mensal do Radar — migration 20261111120000 (sobre a 20261110130000):
#   A*  aplica 2× (idempotente) com a postcondição verde; o cron segue INATIVO e passa a `CALL` único.
#   B*  a cada passo comitado de um MÊS NOVO a foto vigente é EXATAMENTE a velha (A): radar_lista e a contagem
#       por município (caminho vivo) devolvem as 25 de 2026-10 — nem menos (já trocadas de rótulo), nem as novas
#       (rótulo novo, anterior NULL), nem a que volta ao dump; sem filtro de lote a nova também não aparece;
#       o físico, sim, está mudando (prova de que o passo andou).
#   C*  durante a publicação: score, agregado e aviso esperam a virada; o sorteio de coorte recusa; iniciar outra
#       carga é recusado; o passo não começa com score/agregado em voo (adiado).
#   D*  erro no meio (gatilho) NÃO vira `falhou`: a foto segue A, o erro fica registrado e o tick seguinte retoma.
#   E*  57014 (statement_timeout durante espera de lock) tem ramo próprio: no 'reivindicar' → `falhou` sem escrever;
#       no 'lote' → segue em publicação, carga_erro 57014, tentativas 1. Nunca o laço de 2026-11-08.
#   F*  CALL completa e vira de uma vez: complete/publicada, foto = B (26), quem saiu fica com o rótulo velho, a que
#       volta ganha o novo, nova que já é cliente entra marcada, staging vazio, ledger sucesso, P = NULL.
#   G*  re-run do mês vigente: mesma membresia → refresh in place (só o que difere é reescrito); membresia
#       diferente → `falhou` RCARGA_RERUN_MEMBRESIA sem tocar a foto.
#   H*  ACL: passo/procedure/antiga só do owner; P legível por authenticated, não por anon.
# Esquema: o da prova da 20261110130000 + stubs mínimos dos leitores. Corpo REAL do recruzar (20261019150000).
#
#   bash db/test-radar-publicacao-curta.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-publicacao-curta.sh   # tem de ficar VERMELHA
#   bash db/test-radar-publicacao-curta.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-publicacao-curta.sh   # os DOIS locales (CLAUDE.md)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_BASE="$REPO_ROOT/supabase/migrations/20261110130000_radar_carga_publicacao_atomica.sql"
MIG="$REPO_ROOT/supabase/migrations/20261111120000_radar_carga_publicacao_curta.sql"
MIG_RECRUZAR="$REPO_ROOT/supabase/migrations/20261019150000_radar_recruzar_mascara_exata.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `post:Pn` = a POSTCONDIÇÃO da migration aborta com "Pn FALHOU".
  SABOTAGENS="lista_sem_anterior:B1 contagem_sem_anterior:B2 lista_mostra_nova:B4 score_sem_guarda:C1 agregado_sem_guarda:C2 passo_ignora_job:C6 erro_vira_falhou:D2 cancel_em_others:E1 rerun_sem_membresia:G3 virada_sem_conferir:F7 procedure_definer:post:P4 cron_com_set:post:P6"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-pub-curta.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "RADAR_PUBLICACAO_CURTA_PROVA_OK" "$LOGDIR/controle.log"; then
    echo "❌ controle sem marcador de fim — falsificação abortada"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      post:*) padrao="${a#post:} FALHOU" ;;
      *)      padrao="^FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5498}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-pub-curta.XXXXXX")"
DATA="$TMPD/data"
MIG_USADA="$TMPD/mig.sql"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; tem de ocorrer UMA vez no arquivo)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("padrao deve ocorrer 1 vez, ocorre %d: %s" % (s.count(de), de))
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# A postcondição confere o md5 dos corpos: a sabotagem de CORPO desliga só esse laço (P3), para o comportamento
# sabotado chegar aos asserts — as de atributo/cron (post:P4/P6) mantêm o P3 e caem na postcondição.
sem_md5() { sabotar "    IF v_md5 IS DISTINCT FROM c_corpos[i][2] THEN" "    IF false THEN"; }
# shellcheck disable=SC2016  # $9/$21/$w$ nas sabotagens são do SQL dinâmico, não do shell
case "${SABOTAGEM:-}" in
  "") ;;
  lista_sem_anterior)    sem_md5; sabotar 'v_w := array_append(v_w, $w$e.ultimo_lote = ANY (ARRAY[$9, $21]) AND (e.ultimo_lote = $9 OR e.lote_anterior = $9)$w$);' 'v_w := array_append(v_w, $w$e.ultimo_lote = $9$w$);' ;;
  contagem_sem_anterior) sem_md5; sabotar "     AND (p_lote IS NULL OR (re.ultimo_lote = ANY (ARRAY[p_lote, v_pub])
                             AND (re.ultimo_lote = p_lote OR re.lote_anterior = p_lote)))" "     AND (p_lote IS NULL OR re.ultimo_lote = p_lote)" ;;
  lista_mostra_nova)     sem_md5; sabotar "    ELSIF v_pub IS NOT NULL THEN
      -- Sem recorte de lote" "    ELSIF false THEN
      -- Sem recorte de lote" ;;
  score_sem_guarda)      sem_md5; sabotar "    RETURN jsonb_build_object('adiado', 'publicacao_em_andamento', 'lote_em_publicacao', public.radar_lote_publicando());" "    NULL;" ;;
  agregado_sem_guarda)   sem_md5; sabotar "    RETURN jsonb_build_object('recalculou', false, 'adiado', 'publicacao_em_andamento'," "    RETURN jsonb_build_object('recalculou', true, 'adiado', 'publicacao_em_andamento'," ;;
  passo_ignora_job)      sem_md5; sabotar "      IF NOT pg_try_advisory_xact_lock(20261105, 1) OR NOT pg_try_advisory_xact_lock(20261103, 1) THEN" "      IF false THEN" ;;
  erro_vira_falhou)      sem_md5; sabotar "         SET carga_erro = v_msg, carga_tentativas = COALESCE(carga_tentativas, 0) + 1" "         SET carga_erro = v_msg, carga_tentativas = COALESCE(carga_tentativas, 0) + 1, carga_fase = 'falhou'" ;;
  cancel_em_others)      sem_md5; sabotar "    WHEN query_canceled THEN  -- 57014 (statement_timeout/cancel): NÃO cai em OTHERS
      v_estado := 'cancelado';
      v_msg := left(SQLSTATE || ': ' || SQLERRM, 500);
" "" ;;
  rerun_sem_membresia)   sem_md5; sabotar "        IF v_m <> r.carga_esperado OR v_n <> r.carga_esperado THEN" "        IF false THEN" ;;
  virada_sem_conferir)   sem_md5; sabotar "      IF v_n IS DISTINCT FROM r.carga_esperado THEN
        RAISE EXCEPTION 'RCARGA_FOTO_DIVERGE" "      IF false THEN
        RAISE EXCEPTION 'RCARGA_FOTO_DIVERGE" ;;
  procedure_definer)     sabotar "CREATE OR REPLACE PROCEDURE public.radar_carga_publicar(p_orcamento interval DEFAULT interval '8 minutes')
LANGUAGE plpgsql" "CREATE OR REPLACE PROCEDURE public.radar_carga_publicar(p_orcamento interval DEFAULT interval '8 minutes')
LANGUAGE plpgsql SECURITY DEFINER" ;;
  cron_com_set)          sabotar "command := 'CALL public.radar_carga_publicar()');" "command := 'SET statement_timeout = ''30min''; CALL public.radar_carga_publicar()');" ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# Erro esperado: devolve o stderr VERBOSE (a SQLSTATE vem antes da mensagem); o assert casa SQLSTATE+marca.
Perro() { if out="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "SEM_ERRO: $out"; else echo "$out"; fi; }

PASS=0; FAIL=0
eq()  { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
tem() { if grep -qF -- "$3" <<<"$2"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — [$3] ausente em [$2]"; FAIL=$((FAIL+1)); fi; }

# ── Esquema mínimo (o da prova da 20261110130000) + stubs dos leitores ─────────────────────────────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privilege do Supabase: relação e função novas NASCEM abertas (o REVOKE da migration é o que fecha).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true,
  username text DEFAULT 'postgres', database text DEFAULT current_database());
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
-- Mesma assinatura do pg_cron 1.6 (parâmetro NULL = não mexe).
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job j SET schedule = COALESCE(alter_job.schedule, j.schedule), command = COALESCE(alter_job.command, j.command),
         database = COALESCE(alter_job.database, j.database), username = COALESCE(alter_job.username, j.username),
         active = COALESCE(alter_job.active, j.active)
   WHERE j.jobid = alter_job.job_id $$;
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY CHECK (mes_referencia ~ '^[0-9]{4}-[0-9]{2}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status = ANY (ARRAY['running','complete','error'])),
  total_recebido integer NOT NULL DEFAULT 0, novos integer, iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz, erro text, avisado_em timestamptz, situacao_aplicada_fechamento timestamptz,
  situacao_aplicada_em timestamptz, situacao_resultado jsonb);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social text, nome_fantasia text,
  cnae_principal text NOT NULL CHECK (cnae_principal ~ '^[0-9]{7}$'),
  cnae_descricao text, cnaes_secundarios text[] NOT NULL DEFAULT '{}'::text[], data_abertura date, porte text,
  capital_social numeric, logradouro text, numero text, complemento text, bairro text, municipio_codigo text,
  municipio_nome text, uf text, cep text, telefone1 text, telefone2 text, email text, socios_nomes text,
  primeira_vista_em timestamptz NOT NULL DEFAULT now(),
  ultimo_lote text NOT NULL CHECK (ultimo_lote ~ '^[0-9]{4}-[0-9]{2}$'),
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar'
    CHECK (prospeccao_status IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente')),
  prospeccao_atualizado_em timestamptz, descarte_motivo text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  score smallint, omie_codigo_cliente text, rfb_situacao text);
CREATE INDEX idx_radar_empresas_fila ON public.radar_empresas (ultimo_lote, prospeccao_status);
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), document text);
CREATE TABLE public.omie_clientes_nao_vinculados (codigo text, cnpj_cpf text);
CREATE TABLE public.acoes_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','automatica')),
  iniciado_em timestamptz NOT NULL DEFAULT now(), finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando','sucesso','erro')), detalhes jsonb);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
-- Stubs do que os 6 leitores referenciam (só o que a prova executa; o resto é late-bound).
CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
CREATE FUNCTION private.cap_radar_prospectar(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION private.padrao_like_contem(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::text $$;
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text, uf text, lat double precision, lng double precision);
CREATE TABLE public.radar_agregado_estado (id int PRIMARY KEY, base_lote text, base_iniciado_em timestamptz, calculado_em timestamptz);
CREATE TABLE public.radar_score_estado (id int PRIMARY KEY);
CREATE TABLE public.radar_coorte_controle (sorteio text, cnpj text, grupo text);
SQL

python3 -I - "$MIG_RECRUZAR" > "$TMPD/recruzar.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente()")
j = s.index("REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente()")
print(s[i:j])
PY
P -q -f "$TMPD/recruzar.sql"
P -q -f "$MIG_BASE" > "$TMPD/base.log" 2>&1 || { cat "$TMPD/base.log"; echo "FAIL A0 migration base abortou"; exit 1; }
# Como em prod desde a contenção de 2026-11-08: o job está PAUSADO antes desta migration.
Pq -c "UPDATE cron.job SET active = false WHERE jobname = 'radar-publicar-lote';" >/dev/null

# ── Foto vigente 2026-10: E1..E25 (E2 em conversa); E26..E28 saíram do dump em 2026-08 ─────────────────
cnpj() { printf '000000000%03d%02d' "$1" "$(( $1 % 100 ))"; }
P -q <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em, finalizado_em)
VALUES ('2026-08', 'complete', 28, 0, '2026-08-20 16:00+00', '2026-08-20 16:30+00'),
       ('2026-10', 'complete', 25, 0, '2026-10-27 16:20+00', '2026-10-27 16:38+00');
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, primeira_vista_em, prospeccao_status,
                                   municipio_codigo, uf, cnaes_secundarios, data_abertura, capital_social)
SELECT '000000000' || lpad(n::text, 3, '0') || lpad((n % 100)::text, 2, '0'), 'VELHA ' || n, '4744001',
       CASE WHEN n <= 25 THEN '2026-10' ELSE '2026-08' END, '2026-06-12 02:00+00',
       CASE WHEN n = 2 THEN 'em_conversa' ELSE 'a_contatar' END, '8105', 'SC', '{4789099}',
       ('2020-01-0' || ((n % 9) + 1))::date, 1000.5
  FROM generate_series(1, 28) n;
INSERT INTO public.radar_municipios VALUES ('8105', 'JOINVILLE', 'SC', -26.3, -48.8);
-- N33 já é cliente (profiles): ao entrar na foto tem de entrar marcado.
INSERT INTO public.profiles (document) VALUES ('00.000.000/0033-33');
SQL

# ── A: apply (2×) ──────────────────────────────────────────────────────────────────────────────────────
P -q -f "$MIG_USADA" > "$TMPD/apply1.log" 2>&1 || { cat "$TMPD/apply1.log"; echo "FAIL A1 apply abortou"; exit 1; }
echo "PASS A1 migration aplica (postcondição verde)"; PASS=$((PASS+1))
P -q -f "$MIG_USADA" > "$TMPD/apply2.log" 2>&1 || { cat "$TMPD/apply2.log"; echo "FAIL A2 re-apply abortou"; exit 1; }
echo "PASS A2 re-apply idempotente"; PASS=$((PASS+1))
eq "A3 cron vira CALL único e continua INATIVO (religar é passo à parte)" \
   "$(Pq -c "SELECT command||'|'||active FROM cron.job WHERE jobname = 'radar-publicar-lote';")" \
   "CALL public.radar_carga_publicar()|false"

# linhas JSON: $1 = prefixo da razão social, demais = números das empresas
linhas() {
  local pre="$1"; shift; local out="[" sep=""
  for n in "$@"; do
    out="$out$sep{\"cnpj\":\"$(cnpj "$n")\",\"cnae_principal\":\"4744001\",\"razao_social\":\"$pre $n\",\"cnaes_secundarios\":[\"4789099\"],\"data_abertura\":\"2020-01-0$(( (n % 9) + 1 ))\",\"capital_social\":1000.5,\"uf\":\"SC\",\"municipio_codigo\":\"8105\"}"
    sep=","
  done
  printf '%s]' "$out"
}
seqn() { seq "$1" "$2" | tr '\n' ' '; }
vigente() { Pq -c "SELECT max(mes_referencia) FROM public.radar_ingest_state WHERE status = 'complete';"; }
# A foto vista pelo LEITOR (RPC), como o front pede: radar_lista(p_ultimo_lote = vigente), todos os status.
foto_lista() { Pq -c "SELECT string_agg(right(cnpj, 5), ',' ORDER BY cnpj) FROM public.radar_lista(p_ultimo_lote := '$1', p_incluir_ja_clientes := true, p_limit := 200, p_ordem := 'data_abertura');"; }
foto_contagem() { Pq -c "SELECT coalesce(sum(total), 0) FROM public.radar_contagem_por_municipio(p_data_abertura_min := '1900-01-01', p_incluir_ja_clientes := true, p_lote := '$1');"; }
sem_filtro() { Pq -c "SELECT count(*) FROM public.radar_lista(p_incluir_ja_clientes := true, p_limit := 200, p_ordem := 'data_abertura');"; }
FOTO_A="$(foto_lista 2026-10)"
eq "A4 foto A de partida (25 empresas de 2026-10)" "$(Pq -c "SELECT count(*) FROM public.radar_lista(p_ultimo_lote := '2026-10', p_incluir_ja_clientes := true, p_limit := 200, p_ordem := 'data_abertura');")" "25"
passo() { Pq -c "SELECT public.radar_carga_publicar_passo(${1:-4});"; }
estado() { passo "$@" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["estado"])'; }

# ── Carga 2026-11 (mês novo): B = E1..E20 (E3 muda a razão) + E26 (volta ao dump) + N31..N35; E21..E25 saem ─
Pq -c "SELECT public.radar_carga_iniciar('2026-11');" >/dev/null
# shellcheck disable=SC2046  # a lista de números TEM de virar argumentos separados
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA $(seqn 1 20) 26 31 32 33 34 35)'::jsonb);" >/dev/null
Pq -c "UPDATE public.radar_empresas_carga SET razao_social = 'VELHA ' || ltrim(substr(cnpj, 10, 3), '0') WHERE cnpj <> '$(cnpj 3)' AND substr(cnpj, 10, 3)::int <= 20;" >/dev/null
Pq -c "SELECT public.radar_carga_validar('2026-11', 26);" >/dev/null

# ── C (antes de reivindicar): score/agregado em voo adiam o início ─────────────────────────────────────
P -q -c "SELECT pg_advisory_lock(20261105, 1);" -c "SELECT pg_sleep(3);" &
for _ in $(seq 1 50); do
  [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid = 20261105 AND objid = 1 AND objsubid = 2 AND granted;")" = "1" ] && break
  sleep 0.1
done
eq "C6 com o score em voo o passo não começa a trocar rótulo (adiado)" "$(estado)" "adiado"
wait

# ── B: cada passo comitado mantém a foto A para o leitor ───────────────────────────────────────────────
eq "B0 reivindicar" "$(estado)" "avancou"
eq "B0b P = 2026-11 assim que a publicação começa" "$(Pq -c "SELECT public.radar_lote_publicando();")" "2026-11"
estado 4 >/dev/null   # 1º lote de 4: E1..E4 trocam de rótulo
estado 4 >/dev/null   # 2º lote: E5..E8
eq "B1 no meio da publicação radar_lista(vigente) devolve exatamente a foto A" "$(foto_lista 2026-10)" "$FOTO_A"
eq "B2 no meio da publicação a contagem por município (vivo) soma 25" "$(foto_contagem 2026-10)" "25"
eq "B3 o físico mudou: 8 linhas já têm o rótulo novo vindo de 2026-10" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND lote_anterior = '2026-10';")" "8"
eq "B3b o refresh cadastral do que mudou já está gravado (E3), o igual não foi reescrito (E4)" \
   "$(Pq -c "SELECT string_agg(razao_social || ':' || (updated_at > now() - interval '1 hour'), ',' ORDER BY cnpj) FROM public.radar_empresas WHERE cnpj IN ('$(cnpj 3)', '$(cnpj 4)');")" \
   "NOVA 3:true,VELHA 4:true"
for _ in 1 2 3 4 5; do estado 4 >/dev/null; done   # até E26/N31.. (cursor passa dos novos)
eq "B4 sem filtro de lote, a empresa nova (só no lote em publicação) não aparece: 28 de antes" "$(sem_filtro)" "28"
eq "B5 a nova está no físico, oculta (rótulo 2026-11, anterior NULL)" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND lote_anterior IS NULL;")" "5"
eq "B6 a que volta ao dump (E26) segue fora da foto vigente durante a publicação" \
   "$(foto_lista 2026-10 | tr ',' '\n' | grep -c "^$(cnpj 26 | cut -c10-)$" || true)" "0"
eq "B7 vigente segue 2026-10" "$(vigente)" "2026-10"

# ── C: durante a publicação ────────────────────────────────────────────────────────────────────────────
eq "C1 score espera a virada" "$(Pq -c "SELECT public.radar_score_recalcular()->>'adiado';")" "publicacao_em_andamento"
eq "C2 agregado espera a virada (não recalcula)" \
   "$(Pq -c "SELECT (r->>'recalculou')||'|'||(r->>'adiado') FROM public.radar_agregado_recalcular(true) r;")" "false|publicacao_em_andamento"
eq "C3 aviso espera a virada" "$(Pq -c "SELECT public.radar_avisar_lote()->>'adiado';")" "publicacao_em_andamento"
tem "C4 sorteio de coorte recusa (55000 RCOORTE_PUBLICACAO_EM_ANDAMENTO)" \
    "$(Perro "SELECT public.radar_coorte_sortear();")" "55000: RCOORTE_PUBLICACAO_EM_ANDAMENTO"
tem "C5 iniciar outra carga durante a publicação é recusado (staging imutável)" \
    "$(Perro "SELECT public.radar_carga_iniciar('2026-12');")" "55000: RCARGA_PUBLICACAO_PENDENTE"

# ── D: erro no meio não derruba a foto; o tick seguinte retoma ────────────────────────────────────────
P -q <<'SQL'
CREATE FUNCTION public.t_explode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ultimo_lote = '2026-11' AND OLD.ultimo_lote IS DISTINCT FROM '2026-11' THEN RAISE EXCEPTION 'explodiu no lote'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_explode BEFORE UPDATE ON public.radar_empresas FOR EACH ROW EXECUTE FUNCTION public.t_explode();
SQL
# Volta o cursor para reprocessar E9.. (que ainda não trocaram — o gatilho explode no 1º UPDATE).
Pq -c "UPDATE public.radar_ingest_state SET carga_cursor = '$(cnpj 8)', carga_examinadas = 8, carga_varrida_em = NULL WHERE mes_referencia = '2026-11';" >/dev/null
Pq -c "UPDATE public.radar_empresas SET ultimo_lote = '2026-10', lote_anterior = NULL WHERE cnpj IN ('$(cnpj 9)', '$(cnpj 10)', '$(cnpj 11)', '$(cnpj 12)');" >/dev/null
eq "D1 passo que explode devolve erro" "$(estado 4)" "erro"
eq "D2 o lote NÃO vira falhou: segue validada/em publicação, erro registrado, tentativas 1" \
   "$(Pq -c "SELECT carga_fase||'|'||(carga_publicacao_iniciada_em IS NOT NULL)||'|'||(carga_erro LIKE '%explodiu no lote%')||'|'||carga_tentativas FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" \
   "validada|true|true|1"
eq "D3 a foto do leitor segue A depois do erro" "$(foto_lista 2026-10)" "$FOTO_A"
eq "D4 ledger registra o erro do passo" \
   "$(Pq -c "SELECT status||'|'||(detalhes->>'etapa') FROM public.acoes_execucoes WHERE acao = 'radar.publicar_lote' ORDER BY finalizado_em DESC LIMIT 1;")" "erro|lote"
P -q -c "DROP TRIGGER t_explode ON public.radar_empresas;"

# ── E: 57014 tem ramo próprio ──────────────────────────────────────────────────────────────────────────
# 'lote': outra sessão segura a linha de E9; statement_timeout (1s) < lock_timeout (5s) → query_canceled.
P -q -c "BEGIN; SELECT 1 FROM public.radar_empresas WHERE cnpj = '$(cnpj 9)' FOR UPDATE; SELECT pg_sleep(3); COMMIT;" >/dev/null &
for _ in $(seq 1 50); do
  [ "$(Pq -c "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.query LIKE '%pg_sleep(3)%' AND l.locktype = 'transactionid';")" -ge 1 ] && break
  sleep 0.1
done
eq "E1 cancelamento no meio do lote é 'cancelado' (não escapa como erro cru)" \
   "$(Pq -c "SET statement_timeout = '1s'; SELECT public.radar_carga_publicar_passo(4)->>'estado';" | tail -1)" "cancelado"
eq "E2 e o lote segue em publicação com o 57014 registrado (tentativas 2)" \
   "$(Pq -c "SELECT carga_fase||'|'||left(carga_erro, 5)||'|'||carga_tentativas FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" \
   "validada|57014|2"
wait
eq "E3 a foto do leitor segue A depois do cancelamento" "$(foto_lista 2026-10)" "$FOTO_A"

# ── F: o CALL termina e a foto vira de uma vez ─────────────────────────────────────────────────────────
P -q -c "CALL public.radar_carga_publicar();"
eq "F1 complete/publicada, total 26, novos 5, P = NULL" \
   "$(Pq -c "SELECT status||'|'||carga_fase||'|'||total_recebido||'|'||novos||'|'||coalesce(public.radar_lote_publicando(), 'null') FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" \
   "complete|publicada|26|5|null"
eq "F2 foto nova = B (E1..E20, E26, N31..N35)" "$(foto_lista 2026-11)" \
   "$(for n in $(seqn 1 20) 26 31 32 33 34 35; do cnpj "$n" | cut -c10-; done | paste -sd, -)"
eq "F3 quem saiu (E21..E25) ficou com 2026-10" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-10';")" "5"
eq "F4 nova que já é cliente (N33) entrou marcada; prospecção de E2 preservada" \
   "$(Pq -c "SELECT (SELECT ja_cliente::text FROM public.radar_empresas WHERE cnpj = '$(cnpj 33)')||'|'||(SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj = '$(cnpj 2)');")" "true|em_conversa"
eq "F5 staging vazio e ledger sucesso" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.radar_empresas_carga)||'|'||(SELECT status FROM public.acoes_execucoes WHERE acao = 'radar.publicar_lote' ORDER BY finalizado_em DESC LIMIT 1);")" "0|sucesso"
eq "F6 republicar = nada" "$(estado)" "nada"

# ── G: re-run do mês vigente ───────────────────────────────────────────────────────────────────────────
Pq -c "SELECT public.radar_carga_iniciar('2026-11');" >/dev/null
# shellcheck disable=SC2046
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA $(seqn 1 20) 26 31 32 33 34 35)'::jsonb);" >/dev/null
# Mesmo cadastro da foto publicada, menos E5: o re-run só tem 1 diferença real.
Pq -c "UPDATE public.radar_empresas_carga c SET razao_social = e.razao_social FROM public.radar_empresas e WHERE e.cnpj = c.cnpj;" >/dev/null
Pq -c "UPDATE public.radar_empresas_carga SET razao_social = 'RERUN 5' WHERE cnpj = '$(cnpj 5)';" >/dev/null
Pq -c "SELECT public.radar_carga_validar('2026-11', 26);" >/dev/null
Pq -c "UPDATE public.radar_empresas SET updated_at = '2026-01-01' WHERE ultimo_lote = '2026-11';" >/dev/null
P -q -c "CALL public.radar_carga_publicar();"
eq "G1 re-run de mesma membresia publica e aplica o refresh (E5)" \
   "$(Pq -c "SELECT carga_fase FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")|$(Pq -c "SELECT razao_social FROM public.radar_empresas WHERE cnpj = '$(cnpj 5)';")" \
   "publicada|RERUN 5"
eq "G2 re-run só reescreveu a linha que mudou" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND updated_at > '2026-01-01';")" "1"
Pq -c "SELECT public.radar_carga_iniciar('2026-11');" >/dev/null
# shellcheck disable=SC2046
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA $(seqn 1 20) 26 31 32 33 34 35 36)'::jsonb);" >/dev/null
Pq -c "SELECT public.radar_carga_validar('2026-11', 27);" >/dev/null
P -q -c "CALL public.radar_carga_publicar();"
eq "G3 re-run com membresia diferente: falhou RCARGA_RERUN_MEMBRESIA, lote segue complete" \
   "$(Pq -c "SELECT status||'|'||carga_fase||'|'||split_part(carga_erro, ':', 2) FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" \
   "complete|falhou| RCARGA_RERUN_MEMBRESIA"
eq "G4 e a foto não mudou (26, a 36 não entrou)" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11';")|$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE cnpj = '$(cnpj 36)';")" "26|0"

# ── F7: a virada confere a foto (rótulo do lote = esperado) ────────────────────────────────────────────
Pq -c "SELECT public.radar_carga_iniciar('2026-12');" >/dev/null
# shellcheck disable=SC2046
Pq -c "SELECT public.radar_carga_receber('2026-12', '$(linhas DEZ $(seqn 1 20) 26 31 32 33 34 35)'::jsonb);" >/dev/null
Pq -c "SELECT public.radar_carga_validar('2026-12', 26);" >/dev/null
for _ in $(seq 1 12); do [ "$(estado 50)" = "avancou" ] || break; r="$(Pq -c "SELECT carga_recruzada_em IS NOT NULL FROM public.radar_ingest_state WHERE mes_referencia = '2026-12';")"; [ "$r" = "t" ] && break; done
# Uma linha "de fora" com o rótulo novo (não deveria existir): a virada tem de recusar, não publicar 27.
Pq -c "UPDATE public.radar_empresas SET ultimo_lote = '2026-12', lote_anterior = '2026-10' WHERE cnpj = '$(cnpj 21)';" >/dev/null
eq "F7 virada com contagem divergente não publica (erro, vigente segue 2026-11)" "$(estado)|$(vigente)" "erro|2026-11"

# ── H: ACL ─────────────────────────────────────────────────────────────────────────────────────────────
tem "H1 service_role não roda passo (42501)" "$(Perro "SET ROLE service_role; SELECT public.radar_carga_publicar_passo(1);")" "42501:"
tem "H2 authenticated não chama a procedure (42501)" "$(Perro "SET ROLE authenticated; CALL public.radar_carga_publicar();")" "42501:"
eq "H3 P legível por authenticated (o front de gestor), não por anon" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', 'public.radar_lote_publicando()', 'EXECUTE')||'|'||has_function_privilege('anon', 'public.radar_lote_publicando()', 'EXECUTE');")" "true|false"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_PUBLICACAO_CURTA_PROVA_OK"
[ "$FAIL" -eq 0 ]
