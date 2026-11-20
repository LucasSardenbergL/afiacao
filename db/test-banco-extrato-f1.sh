#!/usr/bin/env bash
# Prova PG17 — F1 do extrato bancario Itau, Task 1: esquema, RLS, privilegios, bucket, ancora manual e seed.
# Plano: docs/superpowers/plans/2026-11-20-f1-extrato-bancario-itau.md (Task 1).
# Migration sob prova: supabase/migrations/20261120214417_banco_extrato_f1.sql (aplicada INTEIRA, 2x).
#
# Fixtures: NENHUM numero real de agencia/conta. Agencia '0000'; contas '00000-0' (colacor) e '00000-1' (oben,
# so para nao colidir no UNIQUE global). Os ACLs default espelham prod (pg_default_acl medido 2026-11-20:
# postgres concede ALL a anon/authenticated/service_role em tabela nova) — sem isso o REVOKE nao teria dente.
#
# Rodar:  bash db/test-banco-extrato-f1.sh > log 2>&1; echo "exit=$?"     (NAO pipe pra tail — engole o exit)
#         LOCALE_TESTE=pt_BR.UTF-8 bash db/test-banco-extrato-f1.sh        (o 2o idioma — money-path.md)
#         bash db/test-banco-extrato-f1.sh --falsificar                    (controle verde + 1 camada por vez)
# Sentinelas ASCII, caixa fixa. Negativos casam a SQLSTATE EXATA (qualquer outra = FAIL).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261120214417_banco_extrato_f1.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert(s) que TEM de acusa-la, separados por +>
  SABOTAGENS="sem_rls_linha:t1_rls_le_so_empresa_permitida+t1_migration_aplica
    policy_linha_aberta:t1_rls_le_so_empresa_permitida
    seed_banco_999:t1_seed_pix_itau_ligada+t1_migration_aplica
    seed_sem_pix:t1_seed_pix_itau_ligada+t1_migration_aplica
    seed_liga_inativa:t1_seed_ignora_inativa
    seed_sem_normalizar:t1_seed_normaliza_digitos
    unique_por_empresa:t1_unique_conta_global
    grant_linha_aberto:t1_truncate_negado+t1_migration_aplica
    insert_aberto:t1_insert_direto_negado
    storage_insert_sem_pasta:t1_storage_outra_empresa_negado
    storage_select_sem_pasta:t1_storage_select_so_propria
    storage_insert_sem_gate_nem_rls_conta:t1_storage_outra_empresa_negado
    ancora_sem_gate:t1_ancora_sem_acesso_negado
    ancora_anon:t1_ancora_execute_fechado+t1_migration_aplica
    ancora_dia_aberto:t1_ancora_dia_aberto_negado
    ancora_sobrescreve:t1_ancora_divergente_negada
    pre_sem_duas_principais:t1_pre_duas_principais_aborta
    tabela_sem_if_not_exists:t1_idempotente"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-banco-extrato-f1.XXXXXX")"
  echo "== CONTROLE (locale=${LOCALE_TESTE:-C}) =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "controle VERMELHO — falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK banco-extrato-f1" "$LOGDIR/controle.log" || { echo "controle sem marcador de fim"; exit 1; }
  echo "OK controle verde ($(grep -c '^PASS ' "$LOGDIR/controle.log") asserts)"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; alvos="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "FALHA $s: suite ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "FALHA $s: sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
    fi
    faltou=""
    for a in ${alvos//+/ }; do
      grep -qF -- "FAIL $a " "$LOGDIR/$s.log" || faltou="$faltou $a"
    done
    if [ -z "$faltou" ]; then
      echo "OK $s: vermelha em [${alvos//+/, }]"
    else
      echo "FALHA $s: vermelha, mas NAO em [$faltou ] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5812}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-banco-extrato-f1.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

[ -f "$MIG" ] || { echo "FAIL t1_migration_aplica — arquivo ausente: $MIG"; echo "PASS=0 FAIL=1"; exit 1; }
cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrencias; padrao ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY' || exit 2
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  # RLS: a tabela de linhas sem ENABLE (a POS e o assert de RLS tem de acusar)
  sem_rls_linha)        sabotar "ALTER TABLE public.banco_extrato_linha ENABLE ROW LEVEL SECURITY;" "" ;;
  # RLS: a policy de linhas aberta para qualquer autenticado
  policy_linha_aberta)  sabotar "ON public.banco_extrato_linha FOR SELECT TO authenticated USING (public.fin_user_can_access(company));" \
                                "ON public.banco_extrato_linha FOR SELECT TO authenticated USING (true);" ;;
  # seed: le o banco errado -> nenhuma banco_conta
  seed_banco_999)       sabotar "WHERE f.banco = '341' AND f.tipo = 'CC'" "WHERE f.banco = '999' AND f.tipo = 'CC'" ;;
  # seed: so liga a conta com agencia (a Pix Itau fica de fora)
  seed_sem_pix)         sabotar "WHERE l.banco = '341' AND l.ativo IS TRUE" "WHERE l.banco = '341' AND l.ativo IS TRUE AND l.agencia IS NOT NULL" ;;
  # seed: liga tambem a conta inativa
  seed_liga_inativa)    sabotar "WHERE l.banco = '341' AND l.ativo IS TRUE" "WHERE l.banco = '341'" ;;
  # seed: grava a conta como veio (com o hifen) -> CHECK de digitos aborta o seed
  seed_sem_normalizar)  sabotar "regexp_replace(f.numero_conta, '[^0-9]', '', 'g')" "f.numero_conta" ;;
  # identidade da conta unica so dentro da empresa
  unique_por_empresa)   sabotar "UNIQUE (banco_codigo, agencia_digitos, conta_digitos)" "UNIQUE (company, banco_codigo, agencia_digitos, conta_digitos)" ;;
  # privilegio: linhas abertas a escrita direta (TRUNCATE fura RLS)
  grant_linha_aberto)   sabotar "REVOKE ALL ON TABLE public.banco_extrato_linha FROM PUBLIC, anon, authenticated;" \
                                "GRANT ALL ON TABLE public.banco_extrato_linha TO anon, authenticated;" ;;
  # privilegio + policy de INSERT: a escrita direta passa
  insert_aberto)        sabotar "REVOKE ALL ON TABLE public.banco_extrato_linha FROM PUBLIC, anon, authenticated;" \
                                "GRANT ALL ON TABLE public.banco_extrato_linha TO authenticated; CREATE POLICY sabot_ins ON public.banco_extrato_linha FOR INSERT TO authenticated WITH CHECK (true);" ;;
  # storage: a policy deixa de amarrar a 1a pasta do caminho a conta (qualquer conta visivel serve)
  storage_insert_sem_pasta) sabotar "ci.id::text = (storage.foldername(objects.name))[1]" "true" ;;
  storage_select_sem_pasta) sabotar "cs.id::text = (storage.foldername(objects.name))[1]" "true" ;;
  # storage: sem o fin_user_can_access da policy E com banco_conta aberta. So o gate sozinho fica VERDE
  # (a RLS de banco_conta, avaliada como o chamador, ja esconde a conta alheia no EXISTS): camada redundante.
  storage_insert_sem_gate_nem_rls_conta)
    sabotar "public.fin_user_can_access(ci.company)" "true"
    sabotar "ON public.banco_conta FOR SELECT TO authenticated USING (public.fin_user_can_access(company));" \
            "ON public.banco_conta FOR SELECT TO authenticated USING (true);" ;;
  ancora_sem_gate)      sabotar "IF NOT public.fin_user_can_access(v_company) THEN" "IF false THEN" ;;
  ancora_anon)          sabotar "REVOKE ALL ON FUNCTION public.banco_conta_registrar_ancora(uuid, date, bigint) FROM PUBLIC, anon;" \
                                "GRANT EXECUTE ON FUNCTION public.banco_conta_registrar_ancora(uuid, date, bigint) TO anon;" ;;
  ancora_dia_aberto)    sabotar "IF p_data >= v_hoje THEN" "IF p_data > v_hoje THEN" ;;
  ancora_sobrescreve)   sabotar "IF v_saldo IS DISTINCT FROM p_saldo_centavos THEN" "IF false THEN" ;;
  pre_sem_duas_principais) sabotar "HAVING count(DISTINCT" "HAVING 0 * count(DISTINCT" ;;
  tabela_sem_if_not_exists) sabotar "CREATE TABLE IF NOT EXISTS public.banco_extrato_linha" "CREATE TABLE public.banco_extrato_linha" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null || { echo "initdb falhou"; exit 1; }
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null || { echo "pg_ctl falhou"; exit 1; }
DB=prove
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$DB" "$@"; }
Pq() { P -qAt "$@"; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# estado <uid|''> <role> <sql> -> SQLSTATE do comando (00000 = executou). A comparacao com a SQLSTATE ESPERADA e
# exata no eq: qualquer outro erro (inclusive de digitacao no proprio teste) pinta FAIL, nunca verde.
estado() {
  local out
  out=$(P -qAt 2>&1 <<SQL
SET test.uid = '$1';
SET ROLE $2;
DO \$t\$ BEGIN
  EXECUTE \$q\$$3\$q\$;
  RAISE NOTICE 'ESTADO=00000';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'ESTADO=%', SQLSTATE;
END \$t\$;
SQL
)
  printf '%s\n' "$out" | grep -oE 'ESTADO=[0-9A-Z]{5}' | tail -1 | cut -d= -f2
}
# como <uid> <sql> -> ultimo valor, sob SET ROLE authenticated (RLS vale)
como() { Pq -c "SET test.uid = '$1'; SET ROLE authenticated; $2" | tail -1; }

U_SEM=00000000-0000-0000-0000-0000000000a1     # autenticado sem permissao financeira
U_OBEN=00000000-0000-0000-0000-0000000000a2    # fin_permissoes: so oben
U_STAFF=00000000-0000-0000-0000-0000000000a3   # employee: ve todas

echo "=== setup PG17 :$PORT locale=$LOC ==="

# ── ZONA 1: stubs do Supabase + o que a migration LE (fin_contas_correntes, fin_user_can_access, storage) ──
stubs() { # $1 = database
  DB="$1" P -q -f "$REPO_ROOT/db/stubs-supabase.sql" || return 1
  DB="$1" P -q <<'SQL' || return 1
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- espelho do pg_default_acl de prod (postgres -> ALL em tabela nova, EXECUTE em funcao nova)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
CREATE TABLE public.fin_permissoes (user_id uuid PRIMARY KEY, pode_ver_todas_empresas boolean NOT NULL DEFAULT false, empresas text[] NOT NULL DEFAULT '{}');
-- corpo IDENTICO ao de prod (pg_get_functiondef, md5 prosrc 85258e752cb514dd1ddba826ce25a7fb, 2026-11-20)
CREATE OR REPLACE FUNCTION public.fin_user_can_access(check_company text DEFAULT NULL::text)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_perm RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('master','employee')) THEN
    RETURN true;
  END IF;
  SELECT * INTO v_perm FROM fin_permissoes WHERE user_id = auth.uid();
  IF v_perm IS NULL THEN RETURN false; END IF;
  IF check_company IS NULL THEN RETURN true; END IF;
  RETURN v_perm.pode_ver_todas_empresas OR check_company = ANY(v_perm.empresas);
END;
$function$;

-- tipos medidos em prod (information_schema, 2026-11-20)
CREATE TABLE public.fin_contas_correntes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_ncodcc bigint NOT NULL,
  descricao text, banco text, agencia text, numero_conta text, tipo text,
  saldo_data date, saldo_atual numeric, ativo boolean,
  UNIQUE (company, omie_ncodcc)
);

CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
  name text, owner uuid, created_at timestamptz DEFAULT now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;
GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;
-- espelho de storage.foldername do Supabase: as pastas do caminho, sem o arquivo
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql AS $f$
DECLARE _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1:array_length(_parts, 1) - 1];
END $f$;
SQL
}
for d in prove prove_pre; do
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$d" || { echo "createdb $d falhou"; exit 1; }
  stubs "$d" || { echo "stubs $d falharam"; exit 1; }
done

# fixture de contas Omie: colacor = principal + Pix Itau ativa + Pix inativa + outro banco; oben = so a principal;
# colacor_sc = so outro banco (sem Itau -> nenhuma banco_conta, e nenhuma POS deve exigir uma).
P -q <<'SQL' || { echo "fixture falhou"; exit 1; }
INSERT INTO public.fin_contas_correntes (company, omie_ncodcc, descricao, banco, agencia, numero_conta, tipo, ativo) VALUES
  ('colacor',    2001, 'Itau Colacor', '341', '0000', '00000-0', 'CC', true),
  ('colacor',    2002, 'Pix Itau',     '341', NULL,   NULL,      'CC', true),
  ('colacor',    2003, 'Pix Itau',     '341', NULL,   NULL,      'CC', false),
  ('colacor',    2004, 'Outro banco',  '756', '0000', '00000-0', 'CC', true),
  ('oben',       1001, 'Itau Oben',    '341', '0000', '00000-1', 'CC', true),
  ('colacor_sc', 3001, 'Outro banco',  '756', '0000', '00000-1', 'CC', true);
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000000a3', 'employee');
INSERT INTO public.fin_permissoes (user_id, empresas) VALUES ('00000000-0000-0000-0000-0000000000a2', '{oben}');
SQL

# ── ZONA 2: a MIGRATION REAL ──
echo "=== aplica a migration (1a vez) ==="
if P -q -f "$MIG_USADA" > "$(dirname "$DATA")/mig1.log" 2>&1; then
  echo "PASS t1_migration_aplica"; PASS=$((PASS+1))
else
  echo "FAIL t1_migration_aplica — $(head -c 400 "$(dirname "$DATA")/mig1.log")"; FAIL=$((FAIL+1))
fi

ID_OBEN=$(Pq -c "SELECT id FROM public.banco_conta WHERE company='oben'" 2>/dev/null)
ID_COL=$(Pq -c "SELECT id FROM public.banco_conta WHERE company='colacor'" 2>/dev/null)

echo "=== seed ==="
eq "t1_seed_pix_itau_ligada colacor: 1 banco_conta, 2 vinculos (principal + Pix Itau)" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.banco_conta WHERE company='colacor')||'/'||(SELECT string_agg(omie_ncodcc::text, ',' ORDER BY omie_ncodcc) FROM public.banco_conta_omie WHERE company='colacor' AND banco_conta_id = (SELECT id FROM public.banco_conta WHERE company='colacor'))" 2>&1)" "1/2001,2002"
eq "t1_seed_oben_uma_conta_um_vinculo" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.banco_conta WHERE company='oben')||'/'||(SELECT count(*) FROM public.banco_conta_omie WHERE company='oben')" 2>&1)" "1/1"
eq "t1_seed_ignora_inativa a Pix inativa (2003) nao e ligada" \
   "$(Pq -c "SELECT count(*) FROM public.banco_conta_omie WHERE omie_ncodcc = 2003" 2>&1)" "0"
eq "t1_seed_sem_itau_sem_conta colacor_sc (so outro banco) nao ganha banco_conta" \
   "$(Pq -c "SELECT count(*) FROM public.banco_conta WHERE company='colacor_sc'" 2>&1)" "0"
eq "t1_seed_normaliza_digitos oben: banco 341, agencia 0000, conta 000001 (sem hifen), sem formato/estrategia, ativa" \
   "$(Pq -c "SELECT banco_codigo||'|'||agencia_digitos||'|'||conta_digitos||'|'||coalesce(formato,'NULL')||'|'||coalesce(estrategia_chave,'NULL')||'|'||ativo FROM public.banco_conta WHERE company='oben'" 2>&1)" \
   "341|0000|000001|NULL|NULL|true"

echo "=== integridade ==="
eq "t1_unique_conta_global a mesma conta (341/0000/000000) em outra empresa e recusada (23505)" \
   "$(estado '' postgres "INSERT INTO public.banco_conta (company, banco_codigo, agencia_digitos, conta_digitos) VALUES ('oben', '341', '0000', '000000')")" "23505"
eq "t1_check_digitos conta com hifen e recusada (23514)" \
   "$(estado '' postgres "INSERT INTO public.banco_conta (company, banco_codigo, agencia_digitos, conta_digitos) VALUES ('oben', '341', '0000', '00000-9')")" "23514"
eq "t1_vinculo_omie_unico a mesma conta Omie nao entra em 2 contas bancarias (23505)" \
   "$(estado '' postgres "INSERT INTO public.banco_conta (company, banco_codigo, agencia_digitos, conta_digitos) VALUES ('colacor','341','0000','000009'); INSERT INTO public.banco_conta_omie (banco_conta_id, company, omie_ncodcc) SELECT id, 'colacor', 2001 FROM public.banco_conta WHERE conta_digitos='000009'")" "23505"
eq "t1_fk_company_coerente filho com company diferente da conta e recusado (23503)" \
   "$(estado '' postgres "INSERT INTO public.banco_conta_omie (banco_conta_id, company, omie_ncodcc) VALUES ('$ID_OBEN', 'colacor', 9999)")" "23503"
eq "t1_linha_valor_positivo valor 0 e recusado (23514)" \
   "$(estado '' postgres "INSERT INTO public.banco_extrato_arquivo (id, company, banco_conta_id, formato, storage_path, sha256, periodo_inicio, periodo_fim, saldo_final_centavos, qtd_linhas, qtd_linhas_novas, status, enviado_por) VALUES ('00000000-0000-0000-0000-00000000f0f0', 'oben', '$ID_OBEN', 'ofx', '$ID_OBEN/z.ofx', repeat('c', 64), '2026-11-01', '2026-11-01', 0, 1, 0, 'recusado', '$U_STAFF'); INSERT INTO public.banco_extrato_linha (company, banco_conta_id, arquivo_id, data, sentido, valor_centavos, descricao, chave) VALUES ('oben', '$ID_OBEN', '00000000-0000-0000-0000-00000000f0f0', '2026-11-01', 'C', 0, 'x', 'k0')")" "23514"
eq "t1_arquivo_path_da_conta storage_path fora da pasta da conta e recusado (23514)" \
   "$(estado '' postgres "INSERT INTO public.banco_extrato_arquivo (company, banco_conta_id, formato, storage_path, sha256, periodo_inicio, periodo_fim, saldo_final_centavos, qtd_linhas, qtd_linhas_novas, status, enviado_por) VALUES ('oben', '$ID_OBEN', 'ofx', '$ID_COL/z.ofx', repeat('d', 64), '2026-11-01', '2026-11-01', 0, 0, 0, 'recusado', '$U_STAFF')")" "23514"

# ── ZONA 3: fixture de extrato (como postgres) para os asserts de RLS ──
P -q <<SQL || echo "FAIL t1_fixture_extrato — insercao falhou"
INSERT INTO public.banco_extrato_arquivo (id, company, banco_conta_id, formato, storage_path, sha256, periodo_inicio, periodo_fim,
  saldo_inicial_centavos, saldo_final_centavos, qtd_linhas, qtd_linhas_novas, status, enviado_por) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'oben',    '$ID_OBEN', 'ofx', '$ID_OBEN/a.ofx', repeat('a', 64), '2026-11-02', '2026-11-03', 1000, 1500, 2, 2, 'aceito', '$U_STAFF'),
  ('00000000-0000-0000-0000-0000000000f2', 'colacor', '$ID_COL',  'ofx', '$ID_COL/b.ofx',  repeat('b', 64), '2026-11-02', '2026-11-02', 0, 300, 1, 1, 'aceito', '$U_STAFF');
INSERT INTO public.banco_extrato_linha (company, banco_conta_id, arquivo_id, data, sentido, valor_centavos, descricao, chave) VALUES
  ('oben',    '$ID_OBEN', '00000000-0000-0000-0000-0000000000f1', '2026-11-02', 'C', 700, 'deposito', 'k1'),
  ('oben',    '$ID_OBEN', '00000000-0000-0000-0000-0000000000f1', '2026-11-03', 'D', 200, 'tarifa',   'k2'),
  ('colacor', '$ID_COL',  '00000000-0000-0000-0000-0000000000f2', '2026-11-02', 'C', 300, 'pix',      'k1');
INSERT INTO public.banco_conta_ancora (company, banco_conta_id, data, saldo_final_dia_centavos, origem, registrado_por) VALUES
  ('colacor', '$ID_COL', '2026-11-01', 0, 'cnab', '$U_STAFF');
INSERT INTO storage.objects (bucket_id, name) VALUES ('banco-extratos', '$ID_COL/b.ofx');
SQL

echo "=== RLS (SET ROLE authenticated + GUC) ==="
RLS_SEM=$(como "$U_SEM" "SELECT (SELECT count(*) FROM public.banco_extrato_linha)||'/'||(SELECT count(*) FROM public.banco_extrato_arquivo)||'/'||(SELECT count(*) FROM public.banco_conta)||'/'||(SELECT count(*) FROM public.banco_conta_omie)||'/'||(SELECT count(*) FROM public.banco_conta_ancora)" 2>&1)
eq "t1_rls_le_so_empresa_permitida sem permissao: 0 linhas nas 5 tabelas (linha/arquivo/conta/omie/ancora)" "$RLS_SEM" "0/0/0/0/0"
eq "t1_rls_oben_ve_so_oben linhas/arquivos/contas/ancoras da oben" \
   "$(como "$U_OBEN" "SELECT (SELECT count(*) FROM public.banco_extrato_linha)||'/'||(SELECT count(*) FROM public.banco_extrato_arquivo)||'/'||(SELECT string_agg(DISTINCT company, ',') FROM public.banco_conta)||'/'||(SELECT count(*) FROM public.banco_conta_ancora)" 2>&1)" "2/1/oben/0"
eq "t1_rls_staff_ve_todas" \
   "$(como "$U_STAFF" "SELECT (SELECT count(*) FROM public.banco_extrato_linha)||'/'||(SELECT count(*) FROM public.banco_conta)" 2>&1)" "3/2"
eq "t1_rls_anon_sem_select anon nao le banco_extrato_linha (42501)" \
   "$(estado '' anon "SELECT count(*) FROM public.banco_extrato_linha")" "42501"

echo "=== escrita direta / privilegios ==="
eq "t1_insert_direto_negado staff (passa na RLS de leitura) nao insere linha direto (42501)" \
   "$(estado "$U_STAFF" authenticated "INSERT INTO public.banco_extrato_linha (company, banco_conta_id, arquivo_id, data, sentido, valor_centavos, descricao, chave) VALUES ('oben', '$ID_OBEN', '00000000-0000-0000-0000-0000000000f1', '2026-11-02', 'C', 1, 'x', 'k9')")" "42501"
eq "t1_update_direto_negado staff nao altera banco_conta direto (42501)" \
   "$(estado "$U_STAFF" authenticated "UPDATE public.banco_conta SET formato = 'ofx'")" "42501"
eq "t1_delete_direto_negado staff nao apaga arquivo direto (42501)" \
   "$(estado "$U_STAFF" authenticated "DELETE FROM public.banco_extrato_arquivo")" "42501"
eq "t1_truncate_negado nenhum privilegio de escrita/TRUNCATE para anon/authenticated nas 5 tabelas" \
   "$(Pq -c "SELECT count(*) FROM unnest(ARRAY['banco_conta','banco_conta_ancora','banco_conta_omie','banco_extrato_arquivo','banco_extrato_linha']) t,
               unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pr
             WHERE has_table_privilege(r, 'public.'||t, pr)" 2>&1)" "0"
eq "t1_select_concedido authenticated le as 5, anon nenhuma" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE has_table_privilege('authenticated', 'public.'||t, 'SELECT'))||'/'||count(*) FILTER (WHERE has_table_privilege('anon', 'public.'||t, 'SELECT'))
             FROM unnest(ARRAY['banco_conta','banco_conta_ancora','banco_conta_omie','banco_extrato_arquivo','banco_extrato_linha']) t" 2>&1)" "5/0"
eq "t1_policies_so_select cada tabela tem exatamente 1 policy, de SELECT, para authenticated" \
   "$(Pq -c "SELECT count(*)||'/'||count(*) FILTER (WHERE cmd = 'SELECT' AND roles = '{authenticated}') FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'banco\_%'" 2>&1)" "5/5"

echo "=== storage (bucket banco-extratos) ==="
eq "t1_bucket_config privado, 10 MB, 3 mimes" \
   "$(Pq -c "SELECT public||'|'||file_size_limit||'|'||array_to_string(allowed_mime_types, ',') FROM storage.buckets WHERE id='banco-extratos'" 2>&1)" \
   "false|10485760|text/plain,application/x-ofx,application/octet-stream"
eq "t1_storage_outra_empresa_negado usuario oben nao sobe na pasta da conta colacor (42501)" \
   "$(estado "$U_OBEN" authenticated "INSERT INTO storage.objects (bucket_id, name) VALUES ('banco-extratos', '$ID_COL/x.ofx')")" "42501"
eq "t1_storage_conta_inexistente_negado pasta que nao e conta (42501)" \
   "$(estado "$U_STAFF" authenticated "INSERT INTO storage.objects (bucket_id, name) VALUES ('banco-extratos', '00000000-0000-0000-0000-000000000000/x.ofx')")" "42501"
eq "t1_storage_sem_acesso_negado autenticado sem permissao nao sobe nem na pasta oben (42501)" \
   "$(estado "$U_SEM" authenticated "INSERT INTO storage.objects (bucket_id, name) VALUES ('banco-extratos', '$ID_OBEN/x.ofx')")" "42501"
eq "t1_storage_propria_empresa_ok usuario oben sobe na pasta da conta oben" \
   "$(estado "$U_OBEN" authenticated "INSERT INTO storage.objects (bucket_id, name) VALUES ('banco-extratos', '$ID_OBEN/x.ofx')")" "00000"
eq "t1_storage_select_so_propria usuario oben ve so o objeto da oben" \
   "$(como "$U_OBEN" "SELECT count(*)||'/'||count(*) FILTER (WHERE name LIKE '$ID_OBEN/%') FROM storage.objects" 2>&1)" "1/1"
eq "t1_storage_sem_update_delete nenhuma policy de UPDATE/DELETE para o bucket" \
   "$(Pq -c "SELECT count(*)||'/'||count(*) FILTER (WHERE cmd IN ('UPDATE','DELETE','ALL')) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND (coalesce(qual,'')||coalesce(with_check,'')) LIKE '%banco-extratos%'" 2>&1)" "2/0"

echo "=== RPC banco_conta_registrar_ancora ==="
ONTEM="(now() AT TIME ZONE 'America/Sao_Paulo')::date - 1"
HOJE="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
A1=$(Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$ID_OBEN', $ONTEM, 123456)" 2>&1 | tail -1)
eq "t1_ancora_registra manual, autor = auth.uid(), empresa derivada da conta" \
   "$(Pq -c "SELECT origem||'|'||registrado_por||'|'||company||'|'||saldo_final_dia_centavos||'|'||(data = $ONTEM) FROM public.banco_conta_ancora WHERE id = '$A1'" 2>&1)" \
   "manual|$U_OBEN|oben|123456|true"
eq "t1_ancora_idempotente_mesmo_valor mesmo valor devolve o mesmo id" \
   "$(Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$ID_OBEN', $ONTEM, 123456) = '$A1'::uuid" 2>&1 | tail -1)" "t"
eq "t1_ancora_divergente_negada outro valor para a mesma data manual (23505)" \
   "$(estado "$U_OBEN" authenticated "SELECT public.banco_conta_registrar_ancora('$ID_OBEN', $ONTEM, 999)")" "23505"
eq "t1_ancora_divergente_nao_sobrescreve o valor gravado segue o primeiro" \
   "$(Pq -c "SELECT saldo_final_dia_centavos FROM public.banco_conta_ancora WHERE id = '$A1'" 2>&1)" "123456"
eq "t1_ancora_sem_acesso_negado usuario oben na conta colacor (42501)" \
   "$(estado "$U_OBEN" authenticated "SELECT public.banco_conta_registrar_ancora('$ID_COL', $ONTEM, 1)")" "42501"
eq "t1_ancora_sem_usuario_negado sem auth.uid() (42501)" \
   "$(estado '' authenticated "SELECT public.banco_conta_registrar_ancora('$ID_OBEN', $ONTEM - 1, 1)")" "42501"
eq "t1_ancora_dia_aberto_negado o dia corrente (SP) ainda esta aberto (22023)" \
   "$(estado "$U_OBEN" authenticated "SELECT public.banco_conta_registrar_ancora('$ID_OBEN', $HOJE, 1)")" "22023"
eq "t1_ancora_conta_inexistente (P0002)" \
   "$(estado "$U_STAFF" authenticated "SELECT public.banco_conta_registrar_ancora('00000000-0000-0000-0000-000000000000', $ONTEM, 1)")" "P0002"
eq "t1_ancora_nulo_negado saldo NULL nao vira 0 (22004)" \
   "$(estado "$U_OBEN" authenticated "SELECT public.banco_conta_registrar_ancora('$ID_OBEN', $ONTEM - 2, NULL)")" "22004"
eq "t1_ancora_execute_fechado PUBLIC/anon sem EXECUTE; authenticated com; SECURITY DEFINER" \
   "$(Pq -c "SELECT has_function_privilege('public', 'public.banco_conta_registrar_ancora(uuid, date, bigint)', 'EXECUTE')||'|'||has_function_privilege('anon', 'public.banco_conta_registrar_ancora(uuid, date, bigint)', 'EXECUTE')||'|'||has_function_privilege('authenticated', 'public.banco_conta_registrar_ancora(uuid, date, bigint)', 'EXECUTE')||'|'||(SELECT prosecdef FROM pg_proc WHERE oid = 'public.banco_conta_registrar_ancora(uuid, date, bigint)'::regprocedure)" 2>&1)" \
   "false|false|true|true"

echo "=== PRE: duas contas Itau principais distintas na mesma empresa abortam ==="
DB=prove_pre P -q <<'SQL' || echo "fixture prove_pre falhou"
INSERT INTO public.fin_contas_correntes (company, omie_ncodcc, descricao, banco, agencia, numero_conta, tipo, ativo) VALUES
  ('oben', 1001, 'Itau A', '341', '0000', '00000-1', 'CC', true),
  ('oben', 1002, 'Itau B', '341', '0000', '00000-2', 'CC', true);
SQL
if DB=prove_pre P -q -f "$MIG_USADA" > "$(dirname "$DATA")/pre.log" 2>&1; then PRE_RC=0; else PRE_RC=1; fi
eq "t1_pre_duas_principais_aborta exit da migration / sentinela do PRE / nenhuma banco_conta criada" \
   "$PRE_RC/$(grep -c 'PRE FALHOU duas_principais_itau' "$(dirname "$DATA")/pre.log")/$(DB=prove_pre Pq -c "SELECT count(*) FROM pg_class WHERE relname = 'banco_conta' AND relnamespace = 'public'::regnamespace" 2>&1)" \
   "1/1/0"

echo "=== t1_idempotente: 2a aplicacao = mesmo estado, sem erro ==="
SNAP="SELECT md5(string_agg(x, E'\n' ORDER BY x)) FROM (
  SELECT 'bc:'||id||':'||company||':'||banco_codigo||':'||agencia_digitos||':'||conta_digitos||':'||coalesce(descricao,'')||':'||coalesce(formato,'')||':'||ativo FROM public.banco_conta
  UNION ALL SELECT 'bco:'||banco_conta_id||':'||company||':'||omie_ncodcc FROM public.banco_conta_omie
  UNION ALL SELECT 'anc:'||id||':'||saldo_final_dia_centavos FROM public.banco_conta_ancora
  UNION ALL SELECT 'arq:'||count(*) FROM public.banco_extrato_arquivo
  UNION ALL SELECT 'lin:'||count(*) FROM public.banco_extrato_linha
  UNION ALL SELECT 'pol:'||schemaname||'.'||tablename||':'||policyname||':'||cmd||':'||array_to_string(roles, ',')||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies WHERE policyname LIKE 'banco%'
  UNION ALL SELECT 'acl:'||relname||':'||relrowsecurity||':'||coalesce(relacl::text,'') FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'banco\_%'
  UNION ALL SELECT 'bkt:'||id||':'||public||':'||file_size_limit||':'||allowed_mime_types::text FROM storage.buckets
  UNION ALL SELECT 'fn:'||md5(prosrc)||':'||coalesce(proacl::text,'') FROM pg_proc WHERE proname = 'banco_conta_registrar_ancora'
) s(x)"
S1=$(Pq -c "$SNAP" 2>&1)
if P -q -f "$MIG_USADA" > "$(dirname "$DATA")/mig2.log" 2>&1; then RC2=0; else RC2=1; fi
S2=$(Pq -c "$SNAP" 2>&1)
eq "t1_idempotente 2a aplicacao sai 0 e o estado (dados, policies, ACL, bucket, RPC) nao muda" "$RC2/$([ -n "$S1" ] && [ "$S1" = "$S2" ] && echo igual || echo "diferente:$(head -c 300 "$(dirname "$DATA")/mig2.log")")" "0/igual"
eq "t1_rls_apos_reaplicar sem permissao segue lendo 0 linhas" \
   "$(como "$U_SEM" "SELECT count(*) FROM public.banco_extrato_linha" 2>&1)" "0"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK banco-extrato-f1"
