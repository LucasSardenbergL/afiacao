#!/usr/bin/env bash
# Prova PG17 da 20261030233200_radar_amostra_vigente_leitura.sql: a fila do Radar lê a amostra de controle do
# sorteio vigente pela RPC `radar_amostra_vigente()`, sob o gate do Radar, e a tabela `radar_coorte_controle`
# continua fechada (sem policy, sem privilégio de tabela para anon/authenticated).
#
# Monta a tabela com o DDL e a ACL da 20261029150100 (copiados, não a migration inteira: ela puxa o score e o
# ledger), a cap do Radar como STUB (uma tabela de autorizados; a cap real é da 20261029201200 e tem prova própria
# em db/test-radar-acesso-vendedor.sh) e o auth.uid() pelo GUC de JWT. Os default privileges de public imitam prod
# (anon/authenticated com tudo), para os REVOKE terem o que revogar. Executa a RPC sob SET ROLE.
#
#   bash db/test-radar-amostra-vigente.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-amostra-vigente.sh   # tem de ficar VERMELHA
#   bash db/test-radar-amostra-vigente.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261030233200_radar_amostra_vigente_leitura.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:P4` = a POSTCONDIÇÃO da migration aborta o apply.
  SABOTAGENS="sem_gate:A2 topo_junto:A1 sorteio_mais_antigo:A1 anon_executa_sem_pos:A4 anon_executa:post:P4 sem_secdef:post:P2 tabela_aberta:post:P5"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-amostra.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde ($(grep -c '^PASS ' "$LOGDIR/controle.log") asserts)"
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
TMPD="$(mktemp -d "/tmp/pgtest-radar-amostra.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
MIG_USADA="$TMPD/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = arquivo, $2 = de, $3 = para (literal)
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para, 1))
PY
}

SABOTAGEM="${SABOTAGEM:-}"
if [ -n "$SABOTAGEM" ]; then
  case "$SABOTAGEM" in
    sem_gate)             sabotar "$MIG_USADA" "  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN" \
                                               "  IF false AND NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN" ;;
    topo_junto)           sabotar "$MIG_USADA" "   WHERE k.grupo = 'amostra'" "   WHERE k.grupo IN ('amostra', 'topo')" ;;
    sorteio_mais_antigo)  sabotar "$MIG_USADA" "ORDER BY v.sorteada_em DESC, v.sorteio DESC" "ORDER BY v.sorteada_em ASC, v.sorteio ASC" ;;
    anon_executa_sem_pos) sabotar "$MIG_USADA" "REVOKE ALL ON FUNCTION public.radar_amostra_vigente() FROM PUBLIC, anon;" \
                                               "REVOKE ALL ON FUNCTION public.radar_amostra_vigente() FROM PUBLIC;"
                          sabotar "$MIG_USADA" "  IF has_function_privilege('anon', v_fn, 'EXECUTE')" \
                                               "  IF false AND has_function_privilege('anon', v_fn, 'EXECUTE')" ;;
    anon_executa)         sabotar "$MIG_USADA" "REVOKE ALL ON FUNCTION public.radar_amostra_vigente() FROM PUBLIC, anon;" \
                                               "REVOKE ALL ON FUNCTION public.radar_amostra_vigente() FROM PUBLIC;" ;;
    sem_secdef)           sabotar "$MIG_USADA" " STABLE SECURITY DEFINER" " STABLE SECURITY INVOKER" ;;
    tabela_aberta)        sabotar "$MIG_USADA" "-- ── PÓS:" "GRANT SELECT ON TABLE public.radar_coorte_controle TO authenticated;
-- ── PÓS:" ;;
    *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
  esac
  echo "SABOTAGEM ATIVA: $SABOTAGEM"
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses=''" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h "$TMPD" -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

U_OK='00000000-0000-0000-0000-0000000000a1'
U_NAO='00000000-0000-0000-0000-0000000000a2'

P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privileges de prod (pg_default_acl, psql-ro 2026-10-29): toda tabela/função nova nasce aberta.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  \$\$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid \$\$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- STUB da cap do Radar: só quem está em private.radar_autorizados passa (a real tem prova própria).
CREATE SCHEMA private;
CREATE TABLE private.radar_autorizados (uid uuid PRIMARY KEY);
INSERT INTO private.radar_autorizados VALUES ('$U_OK');
CREATE FUNCTION private.cap_radar_prospectar(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
  \$\$ SELECT COALESCE(_uid IS NOT NULL AND EXISTS (SELECT 1 FROM private.radar_autorizados a WHERE a.uid = _uid), false) \$\$;
REVOKE ALL ON FUNCTION private.cap_radar_prospectar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_radar_prospectar(uuid) TO authenticated, service_role;

-- DDL e ACL de radar_coorte_controle = 20261029150100 (linhas 101-124).
CREATE TABLE public.radar_coorte_controle (
  sorteio          text NOT NULL,
  grupo            text NOT NULL CHECK (grupo IN ('topo', 'amostra')),
  cnpj             text NOT NULL,
  lote             text NOT NULL,
  posicao          integer NOT NULL CHECK (posicao >= 1),
  score_no_sorteio smallint NOT NULL,
  score_versao     text NOT NULL,
  sorteada_em      timestamptz NOT NULL,
  PRIMARY KEY (sorteio, cnpj),
  UNIQUE (sorteio, grupo, posicao)
);
ALTER TABLE public.radar_coorte_controle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_coorte_controle FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.radar_coorte_controle TO service_role;

-- Sorteio antigo (só amostra) e o vigente (topo + amostra), inseridos fora de ordem de posição.
INSERT INTO public.radar_coorte_controle VALUES
  ('coorte-2026-09', 'amostra', 'VELHO01', '2026-09', 1, 50, 'v3', '2026-09-30 10:00+00'),
  ('coorte-2026-09', 'amostra', 'VELHO02', '2026-09', 2, 51, 'v3', '2026-09-30 10:00+00'),
  ('coorte-2026-10', 'amostra', 'AMOS03',  '2026-10', 3, 44, 'v3', '2026-10-30 10:08+00'),
  ('coorte-2026-10', 'topo',    'TOPO01',  '2026-10', 1, 94, 'v3', '2026-10-30 10:08+00'),
  ('coorte-2026-10', 'amostra', 'AMOS01',  '2026-10', 1, 66, 'v3', '2026-10-30 10:08+00'),
  ('coorte-2026-10', 'topo',    'TOPO02',  '2026-10', 2, 70, 'v3', '2026-10-30 10:08+00'),
  ('coorte-2026-10', 'amostra', 'AMOS02',  '2026-10', 2, 40, 'v3', '2026-10-30 10:08+00');

-- Tentativa sob o papel da sessão: captura SÓ a 42501 (a marca do ramo vem no SQLERRM); o resto re-lança.
CREATE SCHEMA teste;
GRANT USAGE ON SCHEMA teste TO anon, authenticated;
CREATE FUNCTION teste.ler_amostra() RETURNS text LANGUAGE plpgsql AS \$\$
DECLARE v text;
BEGIN
  -- Na ordem em que a RPC devolve (WITH ORDINALITY), não reordenada aqui.
  SELECT coalesce(string_agg(a.sorteio || '/' || a.grupo || '/' || a.cnpj || '/' || a.posicao, ',' ORDER BY a.n), '(vazio)')
    INTO v
    FROM public.radar_amostra_vigente() WITH ORDINALITY AS a(sorteio, grupo, cnpj, posicao, n);
  RETURN v;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN '42501 ' || SQLERRM;
END \$\$;
CREATE FUNCTION teste.ler_tabela() RETURNS text LANGUAGE plpgsql AS \$\$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.radar_coorte_controle;
  RETURN 'leu ' || n;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN '42501 ' || SQLERRM;
END \$\$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA teste TO anon, authenticated;
SQL

# A migration REAL (ou a sabotada), 2× — a 2ª prova a idempotência (re-rodar recria o corpo e reemite a ACL).
P -q -f "$MIG_USADA"
P -q -f "$MIG_USADA"
echo "MIGRATION_APLICADA_2X"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
como() { # $1 = papel, $2 = sub do JWT ('' = sem JWT), $3 = SQL
  local claims=''
  [ -n "$2" ] && claims="{\"sub\":\"$2\",\"role\":\"$1\"}"
  Pq -c "SET ROLE $1; SELECT set_config('request.jwt.claims', '$claims', false) IS NULL; $3" | tail -1
}

eq "A1 autorizado lê SÓ a amostra do sorteio VIGENTE, por posição" \
   "$(como authenticated "$U_OK" "SELECT teste.ler_amostra();")" \
   "coorte-2026-10/amostra/AMOS01/1,coorte-2026-10/amostra/AMOS02/2,coorte-2026-10/amostra/AMOS03/3"
eq "A2 authenticated SEM a cap do Radar é barrado pelo gate" \
   "$(como authenticated "$U_NAO" "SELECT teste.ler_amostra();")" "42501 forbidden: radar_prospectar"
eq "A3 authenticated sem JWT (auth.uid() NULL) é barrado pelo gate" \
   "$(como authenticated "" "SELECT teste.ler_amostra();")" "42501 forbidden: radar_prospectar"
eq "A4 anon não executa a RPC (privilégio, antes do gate)" \
   "$(como anon "" "SELECT teste.ler_amostra();")" "42501 permission denied for function radar_amostra_vigente"
eq "A5 authenticated autorizado NÃO lê a tabela direto (o front só lê pela RPC)" \
   "$(como authenticated "$U_OK" "SELECT teste.ler_tabela();")" "42501 permission denied for table radar_coorte_controle"

# Um sorteio NOVO registrado vira o vigente (o mais recente por sorteada_em), sem parâmetro do cliente.
Pq -c "INSERT INTO public.radar_coorte_controle VALUES
  ('coorte-2026-11', 'amostra', 'NOVO01', '2026-11', 1, 45, 'v3', '2026-11-30 10:00+00'),
  ('coorte-2026-11', 'topo',    'NOVO99', '2026-11', 1, 80, 'v3', '2026-11-30 10:00+00');" >/dev/null
eq "A6 o sorteio mais recente passa a ser o vigente" \
   "$(como authenticated "$U_OK" "SELECT teste.ler_amostra();")" "coorte-2026-11/amostra/NOVO01/1"

eq "A7 a tabela segue sem policy e com RLS ligada depois de 2 applies" \
   "$(Pq -c "SELECT (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.radar_coorte_controle'::regclass) || '/' || relrowsecurity FROM pg_class WHERE oid = 'public.radar_coorte_controle'::regclass;")" \
   "0/true"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_AMOSTRA_PROVA_OK"
[ "$FAIL" -eq 0 ]
