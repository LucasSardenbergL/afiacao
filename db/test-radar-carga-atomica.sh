#!/usr/bin/env bash
# Prova PG17 da PUBLICAÇÃO ATÔMICA da carga mensal do Radar — migration 20261110130000:
#   B*  carga PARCIAL não vira vigente: durante os chunks a foto vigente fica inteira e intocada (nenhuma linha
#       sai, nenhum campo muda, empresa nova não aparece); carga que morre no meio vira `error`/`falhou` e a
#       foto anterior segue vigente; chunk depois disso é recusado; contagem que não bate reprova a validação.
#   C*  carga COMPLETA troca de uma vez: validada ≠ vigente; o job publica numa transação (rótulo, cadastro,
#       ja_cliente recruzado, `complete` + finalizado_em, staging vazio, ledger); republicar = no-op.
#   D*  falha DENTRO da publicação (gatilho que explode na última linha) desfaz tudo: foto vigente intacta, lote
#       `falhou`, ledger 'erro'.
#   F*  re-run de lote `complete` mantém a foto no ar (begin e falha não rebaixam); begin de lote mais antigo
#       que o vigente é recusado.
#   H*  queda > 15% contra a foto vigente reprova (dump truncado não vira foto); `aceitar_queda` libera.
#   G*  ACL: staging e RPCs fechados ao JWT (42501 sob SET ROLE); publicação só do owner (cron).
#   J*  cron radar-publicar-lote registrado fora da hora 06 UTC, com statement_timeout explícito.
# Esquema mínimo com os CHECKs de prod (psql-ro, 2026-11-08) + o CORPO REAL de radar_recruzar_ja_cliente
# (20261019150000). Aplica a migration DUAS vezes (idempotência).
#
#   bash db/test-radar-carga-atomica.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-carga-atomica.sh   # tem de ficar VERMELHA
#   bash db/test-radar-carga-atomica.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-carga-atomica.sh   # os DOIS locales (CLAUDE.md)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261110130000_radar_carga_publicacao_atomica.sql"
MIG_RECRUZAR="$REPO_ROOT/supabase/migrations/20261019150000_radar_recruzar_mascara_exata.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `post:Pn` = a POSTCONDIÇÃO da migration aborta com "Pn FALHOU".
  SABOTAGENS="receber_em_fechado:B7 validar_frouxo:B8 pendente_nao_bloqueia:C3 sem_recruzar:C7 sem_truncate:C8 iniciar_rebaixa:F1 falhar_rebaixa:F2 sem_regride:F3 sem_queda:H1 staging_aberto:post:P2 publicar_exposto:post:P7 cron_na_hora_6:post:P8"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-carga.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "RADAR_CARGA_ATOMICA_PROVA_OK" "$LOGDIR/controle.log"; then
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
PORT="${PGPORT_TEST:-5497}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-carga.XXXXXX")"
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
case "${SABOTAGEM:-}" in
  "") ;;
  receber_em_fechado) sabotar "  IF v_fase IS DISTINCT FROM 'recebendo' THEN" "  IF false THEN" ;;
  validar_frouxo)     sabotar "    WHEN v_n <> p_esperado" "    WHEN false" ;;
  pendente_nao_bloqueia) sabotar "  IF EXISTS (SELECT 1 FROM public.radar_ingest_state WHERE carga_fase = 'validada') THEN" "  IF false THEN" ;;
  sem_recruzar)       sabotar "    v_marcados := public.radar_recruzar_ja_cliente();" "    v_marcados := 0;" ;;
  sem_truncate)       sabotar "    TRUNCATE public.radar_empresas_carga;

    v_estado := 'publicado';" "    v_estado := 'publicado';" ;;
  iniciar_rebaixa)    sabotar "       SET status        = CASE WHEN v_antes = 'complete' THEN 'complete' ELSE 'running' END," "       SET status        = 'running'," ;;
  falhar_rebaixa)     sabotar "     SET carga_fase = 'falhou', carga_erro = left(coalesce(p_erro, 'erro sem mensagem'), 500),
         status = CASE WHEN status = 'complete' THEN 'complete' ELSE 'error' END," "     SET carga_fase = 'falhou', carga_erro = left(coalesce(p_erro, 'erro sem mensagem'), 500),
         status = 'error'," ;;
  sem_regride)        sabotar "  IF v_vig IS NOT NULL AND p_lote < v_vig THEN" "  IF false THEN" ;;
  sem_queda)          sabotar "    WHEN v_ref > 0 AND v_n < v_ref * 0.85 AND NOT coalesce(p_aceitar_queda, false)" "    WHEN false" ;;
  staging_aberto)     sabotar "REVOKE ALL ON TABLE public.radar_empresas_carga FROM PUBLIC, anon, authenticated, service_role;" "GRANT SELECT ON TABLE public.radar_empresas_carga TO authenticated;" ;;
  publicar_exposto)   sabotar "REVOKE ALL ON FUNCTION public.radar_carga_publicar_pendente() FROM PUBLIC, anon, authenticated, service_role;" "REVOKE ALL ON FUNCTION public.radar_carga_publicar_pendente() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.radar_carga_publicar_pendente() TO service_role;" ;;
  cron_na_hora_6)     sabotar "  '*/15 0-5,7-23 * * *'," "  '*/15 * * * *'," ;;
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
tem() { if printf '%s' "$2" | grep -qF -- "$3"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — [$3] ausente em [$2]"; FAIL=$((FAIL+1)); fi; }

# ── Esquema mínimo com os MESMOS CHECKs/colunas de prod ────────────────────────────────────────────────
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
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY CHECK (mes_referencia ~ '^[0-9]{4}-[0-9]{2}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status = ANY (ARRAY['running','complete','error'])),
  total_recebido integer NOT NULL DEFAULT 0,
  novos integer,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  erro text,
  avisado_em timestamptz,
  situacao_aplicada_fechamento timestamptz,
  situacao_aplicada_em timestamptz,
  situacao_resultado jsonb);
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
  score smallint);
CREATE INDEX idx_radar_empresas_fila ON public.radar_empresas (ultimo_lote, prospeccao_status);
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), document text);
CREATE TABLE public.omie_clientes_nao_vinculados (codigo text, cnpj_cpf text);
CREATE TABLE public.acoes_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','automatica')),
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando','sucesso','erro')),
  detalhes jsonb);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
SQL

# Corpo REAL do recruzar (o vigente em prod): o bloco CREATE … até o REVOKE da migration 20261019150000.
python3 -I - "$MIG_RECRUZAR" > "$TMPD/recruzar.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente()")
j = s.index("REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente()")
print(s[i:j])
PY
P -q -f "$TMPD/recruzar.sql"

# ── Foto vigente: 2026-10 complete com 5 empresas (E2 em conversa com o vendedor) ─────────────────────
P -q <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em, finalizado_em)
VALUES ('2026-10', 'complete', 5, 0, '2026-10-27 16:20+00', '2026-10-27 16:38+00');
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, primeira_vista_em, prospeccao_status)
SELECT '000000000' || lpad(n::text, 3, '0') || lpad(n::text, 2, '0'), 'VELHA ' || n, '4744001', '2026-10',
       '2026-06-12 02:00+00', CASE WHEN n = 2 THEN 'em_conversa' ELSE 'a_contatar' END
  FROM generate_series(1, 5) n;
-- N7 já é cliente (profiles): ao entrar na foto tem de entrar marcado.
INSERT INTO public.profiles (document) VALUES ('00.000.000/0007-07');
SQL

# ── A: apply (2×) ──────────────────────────────────────────────────────────────────────────────────────
P -q -f "$MIG_USADA" > "$TMPD/apply1.log" 2>&1 || { cat "$TMPD/apply1.log"; echo "FAIL A1 apply abortou"; exit 1; }
echo "PASS A1 migration aplica (postcondição verde)"; PASS=$((PASS+1))
P -q -f "$MIG_USADA" > "$TMPD/apply2.log" 2>&1 || { cat "$TMPD/apply2.log"; echo "FAIL A2 re-apply abortou"; exit 1; }
echo "PASS A2 re-apply idempotente"; PASS=$((PASS+1))

cnpj() { printf '000000000%03d%02d' "$1" "$1"; }
# linhas JSON: $1 = prefixo da razão social, demais = números das empresas
linhas() {
  local pre="$1"; shift; local out="[" sep=""
  for n in "$@"; do
    out="$out$sep{\"cnpj\":\"$(cnpj "$n")\",\"cnae_principal\":\"4744001\",\"razao_social\":\"$pre $n\",\"cnaes_secundarios\":[\"4789099\"],\"data_abertura\":\"2020-01-0$(( (n % 9) + 1 ))\",\"capital_social\":1000.5,\"uf\":\"SC\"}"
    sep=","
  done
  printf '%s]' "$out"
}
vigente() { Pq -c "SELECT max(mes_referencia) FROM public.radar_ingest_state WHERE status = 'complete';"; }
na_foto() { Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '$1';"; }

# ── B: carga PARCIAL não vira vigente ─────────────────────────────────────────────────────────────────
Pq -c "SELECT public.radar_carga_iniciar('2026-11');" >/dev/null
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA 1 2)'::jsonb);" >/dev/null
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA 3 6)'::jsonb);" >/dev/null
eq "B1 durante a carga o vigente segue 2026-10" "$(vigente)" "2026-10"
eq "B2 durante a carga nenhuma empresa sai da foto vigente" "$(na_foto 2026-10)" "5"
eq "B3 durante a carga o cadastro da foto vigente não muda (foto não mistura)" \
   "$(Pq -c "SELECT string_agg(razao_social, ',' ORDER BY cnpj) FROM public.radar_empresas;")" "VELHA 1,VELHA 2,VELHA 3,VELHA 4,VELHA 5"
eq "B4 empresa nova da carga não aparece antes da publicação" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE cnpj = '$(cnpj 6)';")" "0"
Pq -c "SELECT public.radar_carga_falhar('2026-11', 'chunk 3 morreu: 503');" >/dev/null
eq "B5 carga que morre no meio: lote error, fase falhou" \
   "$(Pq -c "SELECT status||'|'||carga_fase||'|'||erro FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" \
   "error|falhou|chunk 3 morreu: 503"
eq "B6 depois da falha a foto anterior segue vigente e inteira" "$(vigente)|$(na_foto 2026-10)" "2026-10|5"
tem "B7 chunk depois da falha é recusado (55000 RCARGA_LOTE_FECHADO)" \
    "$(Perro "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA 7)'::jsonb);")" "55000: RCARGA_LOTE_FECHADO"
# Contagem que não bate (um chunk perdido): a validação reprova e o job não publica nada.
Pq -c "SELECT public.radar_carga_iniciar('2026-11');" >/dev/null
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA 1 2 3)'::jsonb);" >/dev/null
eq "B8 staging com 3 e carga declarando 6: validação reprova (RCARGA_CONTAGEM_DIVERGE)" \
   "$(Pq -c "SELECT (r->>'ok')||'|'||split_part(r->>'motivo', ':', 1) FROM public.radar_carga_validar('2026-11', 6) r;")" \
   "false|RCARGA_CONTAGEM_DIVERGE"
eq "B9 job sem lote validado não publica nada" \
   "$(Pq -c "SELECT public.radar_carga_publicar_pendente()->'publicado';")" "null"
eq "B10 depois da reprovação a foto vigente segue 2026-10 inteira" "$(vigente)|$(na_foto 2026-10)" "2026-10|5"

# ── C: carga COMPLETA troca de uma vez ────────────────────────────────────────────────────────────────
Pq -c "SELECT public.radar_carga_iniciar('2026-11');" >/dev/null
eq "C0 re-run esvazia o staging e reabre o lote em running/recebendo" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.radar_empresas_carga)||'|'||status||'|'||carga_fase FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" \
   "0|running|recebendo"
# E5 saiu do dump; N6 e N7 são novas (N7 já é cliente).
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA 1 2 3)'::jsonb);" >/dev/null
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA 4 6 7)'::jsonb);" >/dev/null
Pq -c "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA 4 6 7)'::jsonb);" >/dev/null   # replay do chunk
eq "C1 validada NÃO é vigente: status running, foto 2026-10 intacta" \
   "$(Pq -c "SELECT (r->>'ok')||'|'||(r->>'recebidas') FROM public.radar_carga_validar('2026-11', 6) r;")|$(vigente)|$(na_foto 2026-10)" \
   "true|6|2026-10|5"
eq "C1b replay do finalize devolve o mesmo veredito" \
   "$(Pq -c "SELECT (r->>'ok')||'|'||(r->>'replay') FROM public.radar_carga_validar('2026-11', 6) r;")" "true|true"
tem "C2 chunk depois da validação é recusado" \
    "$(Perro "SELECT public.radar_carga_receber('2026-11', '$(linhas NOVA 8)'::jsonb);")" "55000: RCARGA_LOTE_FECHADO"
tem "C3 begin de outra carga com lote validado pendente é recusado" \
    "$(Perro "SELECT public.radar_carga_iniciar('2026-12');")" "55000: RCARGA_PUBLICACAO_PENDENTE"
eq "C4 o job publica: complete, total 6, novos 2, finalizado_em, fase publicada" \
   "$(Pq -c "SELECT public.radar_carga_publicar_pendente()->>'estado';")|$(Pq -c "SELECT status||'|'||total_recebido||'|'||novos||'|'||(finalizado_em IS NOT NULL)||'|'||carga_fase FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" \
   "publicado|complete|6|2|true|publicada"
eq "C5 a foto trocou inteira: 6 com 2026-11, E5 (saiu do dump) ficou em 2026-10" \
   "$(vigente)|$(na_foto 2026-11)|$(Pq -c "SELECT ultimo_lote FROM public.radar_empresas WHERE cnpj = '$(cnpj 5)';")" "2026-11|6|2026-10"
eq "C6 cadastro novo aplicado, prospecção e primeira_vista preservadas" \
   "$(Pq -c "SELECT razao_social||'|'||prospeccao_status||'|'||(primeira_vista_em = '2026-06-12 02:00+00')||'|'||cnaes_secundarios::text||'|'||capital_social FROM public.radar_empresas WHERE cnpj = '$(cnpj 2)';")" \
   "NOVA 2|em_conversa|true|{4789099}|1000.5"
eq "C7 empresa nova que já é cliente entra na foto marcada (recruzar na mesma transação)" \
   "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj = '$(cnpj 7)';")" "t"
eq "C8 staging vazio depois da publicação" "$(Pq -c "SELECT count(*) FROM public.radar_empresas_carga;")" "0"
eq "C9 ledger radar.publicar_lote sucesso" \
   "$(Pq -c "SELECT status||'|'||(detalhes->>'lote') FROM public.acoes_execucoes WHERE acao = 'radar.publicar_lote' ORDER BY finalizado_em DESC LIMIT 1;")" \
   "sucesso|2026-11"
eq "C10 republicar = no-op" "$(Pq -c "SELECT public.radar_carga_publicar_pendente()->'publicado';")" "null"

# ── D: falha DENTRO da publicação desfaz tudo ─────────────────────────────────────────────────────────
P -q <<'SQL'
CREATE FUNCTION public.t_explode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.razao_social = 'DEZ 7' THEN RAISE EXCEPTION 'explodiu na ultima linha'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_explode BEFORE INSERT OR UPDATE ON public.radar_empresas FOR EACH ROW EXECUTE FUNCTION public.t_explode();
SQL
Pq -c "SELECT public.radar_carga_iniciar('2026-12');" >/dev/null
Pq -c "SELECT public.radar_carga_receber('2026-12', '$(linhas DEZ 1 2 3 4 6 7)'::jsonb);" >/dev/null
Pq -c "SELECT public.radar_carga_validar('2026-12', 6);" >/dev/null
eq "D1 publicação que explode: lote falhou/error com o motivo" \
   "$(Pq -c "SELECT public.radar_carga_publicar_pendente()->>'estado';")|$(Pq -c "SELECT status||'|'||carga_fase||'|'||(carga_erro LIKE '%explodiu na ultima linha%') FROM public.radar_ingest_state WHERE mes_referencia = '2026-12';")" \
   "falhou|error|falhou|true"
eq "D2 foto vigente intacta: 2026-11 com 6, nenhum cadastro DEZ gravado" \
   "$(vigente)|$(na_foto 2026-11)|$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE razao_social LIKE 'DEZ%' OR ultimo_lote = '2026-12';")" \
   "2026-11|6|0"
eq "D3 ledger radar.publicar_lote erro" \
   "$(Pq -c "SELECT status FROM public.acoes_execucoes WHERE acao = 'radar.publicar_lote' ORDER BY finalizado_em DESC LIMIT 1;")" "erro"
P -q -c "DROP TRIGGER t_explode ON public.radar_empresas;"

# ── F: re-run de lote complete mantém a foto no ar ────────────────────────────────────────────────────
Pq -c "SELECT public.radar_carga_iniciar('2026-11');" >/dev/null
eq "F1 begin de re-run de lote complete NÃO o rebaixa (vigente segue 2026-11, 6 na foto)" \
   "$(Pq -c "SELECT status||'|'||carga_fase FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")|$(vigente)|$(na_foto 2026-11)" \
   "complete|recebendo|2026-11|6"
Pq -c "SELECT public.radar_carga_falhar('2026-11', 'runner morreu');" >/dev/null
eq "F2 re-run que morre deixa o lote complete e vigente" \
   "$(Pq -c "SELECT status||'|'||carga_fase||'|'||coalesce(erro, '-') FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")|$(vigente)" \
   "complete|falhou|-|2026-11"
tem "F3 begin de lote mais antigo que o vigente é recusado (22023 RCARGA_LOTE_REGRIDE)" \
    "$(Perro "SELECT public.radar_carga_iniciar('2026-10');")" "22023: RCARGA_LOTE_REGRIDE"

# ── H: queda > 15% contra a foto vigente reprova ──────────────────────────────────────────────────────
Pq -c "SELECT public.radar_carga_iniciar('2026-12');" >/dev/null
Pq -c "SELECT public.radar_carga_receber('2026-12', '$(linhas DEZ 1 2)'::jsonb);" >/dev/null
eq "H1 2 linhas contra 6 da foto vigente: validação reprova (RCARGA_QUEDA)" \
   "$(Pq -c "SELECT (r->>'ok')||'|'||split_part(r->>'motivo', ':', 1) FROM public.radar_carga_validar('2026-12', 2) r;")" "false|RCARGA_QUEDA"
Pq -c "SELECT public.radar_carga_iniciar('2026-12');" >/dev/null
Pq -c "SELECT public.radar_carga_receber('2026-12', '$(linhas DEZ 1 2)'::jsonb);" >/dev/null
eq "H2 aceitar_queda libera a validação" \
   "$(Pq -c "SELECT r->>'ok' FROM public.radar_carga_validar('2026-12', 2, true) r;")" "true"

# ── G: ACL ─────────────────────────────────────────────────────────────────────────────────────────────
tem "G1 authenticated não lê o staging (42501)" \
    "$(Perro "SET ROLE authenticated; SELECT count(*) FROM public.radar_empresas_carga;")" "42501:"
tem "G2 anon não abre carga (42501)" \
    "$(Perro "SET ROLE anon; SELECT public.radar_carga_iniciar('2027-01');")" "42501:"
tem "G3 service_role não publica (só o cron/owner)" \
    "$(Perro "SET ROLE service_role; SELECT public.radar_carga_publicar_pendente();")" "42501:"
eq "G4 service_role executa as 4 da carga" \
   "$(Pq -c "SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE')) FROM unnest(ARRAY['public.radar_carga_iniciar(text)','public.radar_carga_receber(text,jsonb)','public.radar_carga_validar(text,integer,boolean)','public.radar_carga_falhar(text,text)']) f;")" "t"

# ── J: cron ────────────────────────────────────────────────────────────────────────────────────────────
eq "J1 cron a cada 15 min fora da hora 06 UTC, com statement_timeout" \
   "$(Pq -c "SELECT schedule||'|'||command FROM cron.job WHERE jobname = 'radar-publicar-lote';")" \
   "*/15 0-5,7-23 * * *|SET statement_timeout = '30min'; SELECT public.radar_carga_publicar_pendente();"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_CARGA_ATOMICA_PROVA_OK"
[ "$FAIL" -eq 0 ]
