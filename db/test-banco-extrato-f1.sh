#!/usr/bin/env bash
# Prova PG17 — F1 do extrato bancario Itau. Task 1: esquema, RLS, privilegios, bucket, ancora manual e seed.
# Task 2: banco_extrato_registrar (ordem de decisao 0-9), marcar_conferido, resumo_dia, concorrencia (2 psql).
# Fix da Task 2: vespera obrigatoria sem inicial (Ruling 5), gerado_em (Ruling 6), ancora x arquivo (Ruling 7), banco 0341.
# Plano: docs/superpowers/plans/2026-11-20-f1-extrato-bancario-itau.md (Tasks 1 e 2).
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
    tabela_sem_if_not_exists:t1_idempotente
    t2_sem_lock:t2_concorrencia
    t2_sobreposicao_subconjunto:t2_sobreposicao_divergente_nao_grava_linha+t2_sobreposicao_divergente_compensada
    t2_resumo_coalesce:t2_resumo_dia_sem_cobertura_null
    t2_continuidade_so_vespera:t2_fora_de_ordem_dia2_confere_dia3
    t2_reavalia_preso:t2_reavalia_recusado_dia_corrente+t2_reavalia_pendente_quando_ancora_chega
    t2_company_do_payload:t2_company_do_payload_ignorada
    t2_registrar_aberto:t2_rpc_fechada_para_authenticated+t1_migration_aplica
    t2_conferido_sem_gate:t2_conferido_exige_acesso
    t2_dia_corrente_aberto:t2_dia_corrente
    t2_sem_fechamento:t2_nao_fecha_diferenca_1_centavo
    t2_sem_exigir_ancora:t2_sem_saldo_inicial_sem_ancora
    t2_ignora_banco:t2_outro_banco_mesmos_digitos
    t2_chave_repetida_aceita:t2_chave_repetida_no_arquivo
    t2_ancora_qualquer_dia:t2_sem_saldo_inicial_ancora_no_meio_nao_ancora+t2_sem_saldo_inicial_so_sucessor_nao_ancora
    t2_gerado_em_ignorado:t2_dia_nao_fechado_na_geracao+t2_gerado_em_fuso_sp
    t2_gerado_em_utc:t2_gerado_em_fuso_sp
    t2_gerado_em_opcional:t2_gerado_em_ausente+t2_gerado_em_sem_fuso
    t2_ancora_sem_conferir_arquivo:t2_ancora_diverge_do_arquivo+t2_ancora_diverge_da_vespera_do_arquivo
    t2_banco_sem_normalizar:t2_banco_zero_a_esquerda+t2_banco_so_zeros_incompleto
    t2_gerado_em_futuro_aceito:t2_gerado_em_no_futuro"
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
  # ── Task 2 ──
  # sem a trava da conta: a 2a sessao nao espera, colide no UNIQUE (23505) em vez de ja_importado
  t2_sem_lock)          sabotar "  PERFORM pg_advisory_xact_lock(hashtext(v_conta_id::text));" "" ;;
  # passo 7 por SUBCONJUNTO (gravadas contidas no arquivo): o lancamento a mais passa
  t2_sobreposicao_subconjunto) sabotar "AND (EXISTS (SELECT x.chave, x.sentido, x.valor_centavos" "AND (false AND EXISTS (SELECT x.chave, x.sentido, x.valor_centavos" ;;
  # resumo fabrica 0 em dia sem cobertura
  t2_resumo_coalesce)   sabotar "CASE WHEN c.coberto THEN coalesce(m.cred, 0) END" "coalesce(m.cred, 0)" ;;
  # passo 8 so olha a vespera (o sucessor/dias comuns somem)
  t2_continuidade_so_vespera) sabotar "banco_extrato_saldos_conhecidos(v_conta_id, v_ini - 1, v_fim) s) k" "banco_extrato_saldos_conhecidos(v_conta_id, v_ini - 1, v_ini - 1) s) k" ;;
  # passo 1 trata QUALQUER status como ja_importado (recusado/pendente ficam presos)
  t2_reavalia_preso)    sabotar "IF v_status_ant = 'aceito' THEN" "IF v_status_ant IS NOT NULL THEN" ;;
  # company lida do payload
  t2_company_do_payload) sabotar "  -- contrato do payload
" "  v_company := coalesce(p->>'company', v_company);
  -- contrato do payload
" ;;
  t2_registrar_aberto)  sabotar "REVOKE ALL ON FUNCTION public.banco_extrato_registrar(jsonb) FROM PUBLIC, anon, authenticated;" \
                                "GRANT EXECUTE ON FUNCTION public.banco_extrato_registrar(jsonb) TO authenticated;" ;;
  t2_conferido_sem_gate) sabotar "IF NOT public.fin_user_can_access(v_company) THEN
    RAISE EXCEPTION 'banco_extrato_marcar_conferido" "IF false THEN
    RAISE EXCEPTION 'banco_extrato_marcar_conferido" ;;
  t2_dia_corrente_aberto) sabotar "IF v_fim >= v_hoje THEN" "IF v_fim > v_hoje THEN" ;;
  t2_sem_fechamento)    sabotar "IF v_inicial IS NOT NULL AND v_inicial + v_soma <> v_final THEN" "IF false THEN" ;;
  # sem saldo inicial e sem nenhum S(d): o arquivo se ancora nele mesmo (tautologia) e passaria
  t2_sem_exigir_ancora) sabotar "IF v_inicial IS NULL AND NOT EXISTS" "IF false AND NOT EXISTS" ;;
  t2_ignora_banco)      sabotar "IF v_banco <> ltrim(v_c_banco, '0') OR v_agencia <> v_c_agencia" "IF v_agencia <> v_c_agencia" ;;
  t2_chave_repetida_aceita) sabotar "GROUP BY x.chave HAVING count(*) > 1" "GROUP BY x.chave HAVING count(*) > 99" ;;
  # C1/Ruling 5: sem inicial, volta a aceitar QUALQUER S(d) do intervalo como ancora (nao so a vespera)
  t2_ancora_qualquer_dia) sabotar "banco_extrato_saldos_conhecidos(v_conta_id, v_ini - 1, v_ini - 1)) THEN" \
                                  "banco_extrato_saldos_conhecidos(v_conta_id, v_ini - 1, v_fim)) THEN" ;;
  # I1/Ruling 6: o passo 3b some (so o dia do upload conta)
  t2_gerado_em_ignorado) sabotar "IF v_fim >= v_gerado_sp THEN" "IF false THEN" ;;
  # I1: o dia da geracao medido em UTC, nao em SP
  t2_gerado_em_utc)     sabotar "(v_gerado_em AT TIME ZONE 'America/Sao_Paulo')::date" "(v_gerado_em AT TIME ZONE 'UTC')::date" ;;
  # I1: gerado_em deixa de ser obrigatorio/com fuso (a validacao de contrato some)
  t2_gerado_em_opcional)
    sabotar "IF jsonb_typeof(p->'gerado_em') IS DISTINCT FROM 'string'" "IF false AND jsonb_typeof(p->'gerado_em') IS DISTINCT FROM 'string'"
    sabotar ")?)\$' THEN" ")?)\$' AND false THEN" ;;
  # I2/Ruling 7: a ancora nao e conferida contra o arquivo aceito
  t2_ancora_sem_conferir_arquivo) sabotar "  IF v_saldo IS NOT NULL THEN
    RAISE EXCEPTION 'banco_conta_registrar_ancora: ANCORA_DIVERGE" "  IF false THEN
    RAISE EXCEPTION 'banco_conta_registrar_ancora: ANCORA_DIVERGE" ;;
  # Ruling 8: gerado_em adiantado deixa de ser recusado
  t2_gerado_em_futuro_aceito) sabotar "IF v_gerado_em > now() + interval '10 minutes' THEN" "IF false THEN" ;;
  # Minor (a): codigo do banco comparado sem normalizar zeros a esquerda
  t2_banco_sem_normalizar) sabotar "ltrim(regexp_replace(coalesce(v_ext->>'banco', ''), '[^0-9]', '', 'g'), '0')" \
                                   "regexp_replace(coalesce(v_ext->>'banco', ''), '[^0-9]', '', 'g')" ;;
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
# estado_marca <uid> <role> <sql> <MARCA> -> "SQLSTATE|marca_presente" — casa a SQLSTATE E a marca ASCII do ramo
# na mensagem (23514 tambem sai de um CHECK qualquer; so a marca prova que foi ESTE ramo).
estado_marca() {
  local out
  out=$(P -qAt 2>&1 <<SQL
SET test.uid = '$1';
SET ROLE $2;
DO \$t\$ BEGIN
  EXECUTE \$q\$$3\$q\$;
  RAISE NOTICE 'ESTADO=00000|f';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'ESTADO=%|%', SQLSTATE, strpos(SQLERRM, '$4') > 0;
END \$t\$;
SQL
)
  printf '%s\n' "$out" | grep -oE 'ESTADO=[0-9A-Z]{5}\|[tf]' | tail -1 | cut -d= -f2
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
   "$(estado '' postgres "INSERT INTO public.banco_extrato_arquivo (id, company, banco_conta_id, formato, storage_path, sha256, periodo_inicio, periodo_fim, saldo_final_centavos, qtd_linhas, qtd_linhas_novas, status, enviado_por, gerado_em) VALUES ('00000000-0000-0000-0000-00000000f0f0', 'oben', '$ID_OBEN', 'ofx', '$ID_OBEN/z.ofx', repeat('c', 64), '2026-11-01', '2026-11-01', 0, 1, 0, 'recusado', '$U_STAFF', now()); INSERT INTO public.banco_extrato_linha (company, banco_conta_id, arquivo_id, data, sentido, valor_centavos, descricao, chave) VALUES ('oben', '$ID_OBEN', '00000000-0000-0000-0000-00000000f0f0', '2026-11-01', 'C', 0, 'x', 'k0')")" "23514"
eq "t1_arquivo_path_da_conta storage_path fora da pasta da conta e recusado (23514)" \
   "$(estado '' postgres "INSERT INTO public.banco_extrato_arquivo (company, banco_conta_id, formato, storage_path, sha256, periodo_inicio, periodo_fim, saldo_final_centavos, qtd_linhas, qtd_linhas_novas, status, enviado_por, gerado_em) VALUES ('oben', '$ID_OBEN', 'ofx', '$ID_COL/z.ofx', repeat('d', 64), '2026-11-01', '2026-11-01', 0, 0, 0, 'recusado', '$U_STAFF', now())")" "23514"

# ── ZONA 3: fixture de extrato (como postgres) para os asserts de RLS ──
P -q <<SQL || echo "FAIL t1_fixture_extrato — insercao falhou"
INSERT INTO public.banco_extrato_arquivo (id, company, banco_conta_id, formato, storage_path, sha256, periodo_inicio, periodo_fim,
  saldo_inicial_centavos, saldo_final_centavos, saldo_abertura_centavos, qtd_linhas, qtd_linhas_novas, status, enviado_por, gerado_em) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'oben',    '$ID_OBEN', 'ofx', '$ID_OBEN/a.ofx', repeat('a', 64), '2026-11-02', '2026-11-03', 1000, 1500, 1000, 2, 2, 'aceito', '$U_STAFF', now()),
  ('00000000-0000-0000-0000-0000000000f2', 'colacor', '$ID_COL',  'ofx', '$ID_COL/b.ofx',  repeat('b', 64), '2026-11-02', '2026-11-02', 0, 300, 0, 1, 1, 'aceito', '$U_STAFF', now());
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
  UNION ALL SELECT 'fn:'||proname||':'||md5(prosrc)||':'||prosecdef||':'||coalesce(proacl::text,'') FROM pg_proc WHERE proname LIKE 'banco\_%'
) s(x)"
S1=$(Pq -c "$SNAP" 2>&1)
if P -q -f "$MIG_USADA" > "$(dirname "$DATA")/mig2.log" 2>&1; then RC2=0; else RC2=1; fi
S2=$(Pq -c "$SNAP" 2>&1)
eq "t1_idempotente 2a aplicacao sai 0 e o estado (dados, policies, ACL, bucket, RPC) nao muda" "$RC2/$([ -n "$S1" ] && [ "$S1" = "$S2" ] && echo igual || echo "diferente:$(head -c 300 "$(dirname "$DATA")/mig2.log")")" "0/igual"
eq "t1_rls_apos_reaplicar sem permissao segue lendo 0 linhas" \
   "$(como "$U_SEM" "SELECT count(*) FROM public.banco_extrato_linha" 2>&1)" "0"

# ══ TASK 2: banco_extrato_registrar / marcar_conferido / resumo_dia ══════════════════════════════════════
# Cada caso usa a SUA conta (oben, 341/0000/2000NN), para um nao contaminar a cobertura/saldo do outro.
# Datas em outubro/2026; `hoje` vem no payload (a RPC nao usa now() para o dia corrente).
echo "=== T2: RPCs do extrato ==="
conta_nova() { # $1 = sufixo NN -> id da conta 341/0000/2000NN (oben)
  Pq -c "INSERT INTO public.banco_conta (company, banco_codigo, agencia_digitos, conta_digitos, descricao) VALUES ('oben', '341', '0000', '2000$1', 't2') RETURNING id" 2>&1 | head -1
}
sha() { printf '%064x' "$1"; }
# lin <data> <C|D> <valor> [ordinal] [documento] -> linha com chave tupla data|sentido|valor|documento|ordinal
lin() {
  printf '{"data":"%s","sentido":"%s","valor_centavos":%s,"descricao":"lanc %s","documento":%s,"id_bancario":null,"chave":"%s|%s|%s|%s|%s"}' \
    "$1" "$2" "$3" "$3" "$([ -n "${5:-}" ] && printf '"%s"' "$5" || printf 'null')" "$1" "$2" "$3" "${5:-}" "${4:-1}"
}
# pay <shaN> <conta_id> <NN> <ini> <fim> <inicial|null> <final> <linhas>
#   (env: FORMATO ESTR HOJE_P GERADO_P SEM_GERADO=1 BANCO AG CC_P EXTRA)
pay() {
  local cc="2000$3" gj
  if [ "${SEM_GERADO:-}" = 1 ]; then gj=''; else gj=",\"gerado_em\":\"${GERADO_P:-2026-11-19T12:00:00-03:00}\""; fi
  printf '{"banco_conta_id":"%s","formato":"%s","estrategia_chave":"%s","storage_path":"%s/%s.ofx","sha256":"%s","enviado_por":"%s","hoje":"%s"%s%s,"extrato":{"banco":"%s","agencia":"%s","conta":"%s","periodo_inicio":"%s","periodo_fim":"%s","saldo_inicial_centavos":%s,"saldo_final_centavos":%s,"linhas":[%s]}}' \
    "$2" "${FORMATO:-ofx}" "${ESTR:-tupla}" "$2" "$(sha "$1")" "$(sha "$1")" "$U_STAFF" "${HOJE_P:-2026-11-20}" "$gj" "${EXTRA:-}" \
    "${BANCO:-341}" "${AG-0000}" "${CC_P:-${cc:0:5}-${cc:5}}" "$4" "$5" "$6" "$7" "$8"
}
RES_PADRAO="r->>'status'||'|'||coalesce(r->>'motivo','-')"
# reg <json> [expr sobre r] -> chama a RPC como service_role (o unico papel com EXECUTE)
reg() { Pq -c "SET ROLE service_role; SELECT ${2:-$RES_PADRAO} FROM (SELECT public.banco_extrato_registrar(\$j\$$1\$j\$::jsonb) r) s" 2>&1 | tail -1; }
nlin() { Pq -c "SELECT count(*) FROM public.banco_extrato_linha WHERE banco_conta_id = '$1'" 2>&1; }
narq() { Pq -c "SELECT count(*) FROM public.banco_extrato_arquivo WHERE banco_conta_id = '$1'" 2>&1; }
arq_id() { Pq -c "SELECT id FROM public.banco_extrato_arquivo WHERE banco_conta_id = '$1' AND sha256 = '$(sha "$2")'" 2>&1; }
D1=2026-10-01; D2=2026-10-02; D3=2026-10-03; D0=2026-09-30

# ── aceite, fechamento e idempotencia ──
C01=$(conta_nova 01)
J=$(pay 101 "$C01" 01 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")
eq "t2_aceita_e_fecha status/qtd_novas | linhas gravadas | formato e estrategia fixados | company | abertura" \
   "$(reg "$J" "r->>'status'||'|'||coalesce(r->>'motivo','-')||'|'||(r->>'qtd_linhas_novas')")/$(nlin "$C01")/$(Pq -c "SELECT formato||'|'||estrategia_chave FROM public.banco_conta WHERE id='$C01'")/$(Pq -c "SELECT company||'|'||saldo_abertura_centavos||'|'||status FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C01'")" \
   "aceito|-|2/2/ofx|tupla/oben|1000|aceito"
ID01=$(arq_id "$C01" 101)
eq "t2_reimport_mesmo_hash_ja_importado mesmo arquivo_id, 0 novas, nada duplicado" \
   "$(reg "$J" "r->>'status'||'|'||(r->>'arquivo_id')||'|'||(r->>'qtd_linhas_novas')")/$(narq "$C01")/$(nlin "$C01")" \
   "ja_importado|$ID01|0/1/2"

C02=$(conta_nova 02)
J=$(EXTRA=',"company":"colacor"' pay 102 "$C02" 02 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_company_do_payload_ignorada company do arquivo e das linhas = a da conta (oben)" \
   "$(reg "$J")/$(Pq -c "SELECT string_agg(DISTINCT company, ',') FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C02'")/$(Pq -c "SELECT string_agg(DISTINCT company, ',') FROM public.banco_extrato_linha WHERE banco_conta_id='$C02'")" \
   "aceito|-/oben/oben"

# ── identidade ──
C03=$(conta_nova 03)
J=$(CC_P='99999-9' pay 103 "$C03" 03 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_conta_divergente arquivo de outra conta (que fecha) e recusado, grava o arquivo e nenhuma linha" \
   "$(reg "$J")/$(nlin "$C03")/$(Pq -c "SELECT status||'|'||motivo||'|'||qtd_linhas_novas||'|'||(saldo_abertura_centavos IS NULL) FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C03'")" \
   "recusado|conta_divergente/0/recusado|conta_divergente|0|true"
ID03=$(arq_id "$C03" 103)
C04=$(conta_nova 04)
J=$(BANCO=756 pay 104 "$C04" 04 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_outro_banco_mesmos_digitos mesma agencia/conta em outro banco = conta_divergente" "$(reg "$J")/$(nlin "$C04")" "recusado|conta_divergente/0"
J=$(AG='' pay 105 "$C04" 04 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_identidade_incompleta agencia ausente" "$(reg "$J")" "recusado|identidade_incompleta"
J=$(BANCO=000 pay 143 "$C04" 04 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_banco_so_zeros_incompleto codigo '000' (vazio apos tirar zeros) = identidade_incompleta" "$(reg "$J")" "recusado|identidade_incompleta"
C25=$(conta_nova 25)
J=$(BANCO=0341 pay 144 "$C25" 25 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_banco_zero_a_esquerda BANKID 0341 casa com a conta 341" "$(reg "$J")/$(nlin "$C25")" "aceito|-/1"
J=$(pay 106 00000000-0000-0000-0000-00000000dead 99 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_conta_desconhecida sem arquivo gravado (arquivo_id nulo)" \
   "$(reg "$J" "r->>'status'||'|'||(r->>'motivo')||'|'||coalesce(r->>'arquivo_id','NULL')")" "recusado|conta_desconhecida|NULL"

# ── dia corrente e reavaliacao do mesmo hash ──
C05=$(conta_nova 05)
J=$(HOJE_P=$D2 pay 107 "$C05" 05 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")
eq "t2_dia_corrente periodo_fim = hoje (SP, do payload) e recusado" "$(reg "$J")/$(nlin "$C05")" "recusado|periodo_inclui_dia_corrente/0"
ID05=$(arq_id "$C05" 107)
J=$(HOJE_P=$D3 pay 107 "$C05" 05 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")
eq "t2_reavalia_recusado_dia_corrente o mesmo hash, amanha, e aceito na MESMA linha (count de arquivos nao muda)" \
   "$(reg "$J" "r->>'status'||'|'||(r->>'arquivo_id')")/$(narq "$C05")/$(nlin "$C05")/$(Pq -c "SELECT coalesce(motivo,'-')||'|'||saldo_abertura_centavos FROM public.banco_extrato_arquivo WHERE id='$ID05'")" \
   "aceito|$ID05/1/2/-|1000"

# ── Ruling 6: o dia so esta fechado se o BANCO gerou o arquivo depois dele (gerado_em, em SP) ──
C24=$(conta_nova 24)
J=$(GERADO_P='2026-10-02T10:00:00-03:00' HOJE_P=$D3 pay 145 "$C24" 24 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")
eq "t2_dia_nao_fechado_na_geracao baixado as 10h do dia 2, enviado no dia 3, fim = dia 2: recusado, nenhuma linha, gerado_em gravado" \
   "$(reg "$J" "r->>'status'||'|'||(r->>'motivo')||'|'||(r->>'detalhe')")/$(nlin "$C24")/$(Pq -c "SELECT gerado_em = '2026-10-02T10:00:00-03:00'::timestamptz FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C24' AND sha256='$(sha 145)'")" \
   "recusado|dia_nao_fechado_na_geracao|periodo_fim=2026-10-02 gerado_em_sp=2026-10-02/0/t"
J=$(GERADO_P='2026-10-03T01:00:00Z' HOJE_P=$D3 pay 146 "$C24" 24 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")
eq "t2_gerado_em_fuso_sp 01:00 UTC do dia 3 = 22:00 do dia 2 em SP: o dia 2 ainda estava aberto" \
   "$(reg "$J")/$(nlin "$C24")" "recusado|dia_nao_fechado_na_geracao/0"
J=$(GERADO_P='2026-10-03T03:00:00Z' HOJE_P=$D3 pay 147 "$C24" 24 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")
eq "t2_gerado_em_meia_noite_sp_aceita controle: 03:00 UTC do dia 3 = 00:00 do dia 3 em SP -> aceito, gerado_em gravado" \
   "$(reg "$J")/$(nlin "$C24")/$(Pq -c "SELECT gerado_em = '2026-10-03T03:00:00Z'::timestamptz FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C24' AND sha256='$(sha 147)'")" \
   "aceito|-/2/t"
# Ruling 8: gerado_em adiantado (> now() + 10 min) e recusado; dentro da tolerancia segue para as demais regras
C28=$(conta_nova 28)
ISO_MAIS() { Pq -c "SELECT to_char((now() + interval '$1') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')" 2>&1; }
J=$(GERADO_P="$(ISO_MAIS '1 day')" pay 151 "$C28" 28 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_gerado_em_no_futuro gerado_em = now() + 1 dia: recusado, nenhuma linha" \
   "$(reg "$J")/$(nlin "$C28")" "recusado|gerado_em_no_futuro/0"
J=$(GERADO_P="$(ISO_MAIS '5 minutes')" pay 152 "$C28" 28 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_gerado_em_tolerancia_5min controle: now() + 5 min segue para as demais regras (aceito)" \
   "$(reg "$J")/$(nlin "$C28")" "aceito|-/1"
C27=$(conta_nova 27)
J=$(SEM_GERADO=1 pay 148 "$C27" 27 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_gerado_em_ausente contrato quebrado = 22023, nada gravado" \
   "$(estado '' service_role "SELECT public.banco_extrato_registrar(\$j\$$J\$j\$::jsonb)")/$(narq "$C27")" "22023/0"
J=$(GERADO_P='2026-10-03T10:00:00' pay 149 "$C27" 27 $D1 $D1 1000 1500 "$(lin $D1 C 500)")
eq "t2_gerado_em_sem_fuso sem fuso explicito (dependeria do TimeZone da sessao) = 22023, nada gravado" \
   "$(estado '' service_role "SELECT public.banco_extrato_registrar(\$j\$$J\$j\$::jsonb)")/$(narq "$C27")" "22023/0"

# ── linhas e fechamento ──
C06=$(conta_nova 06)
J=$(pay 108 "$C06" 06 $D1 $D1 1000 1499 "$(lin $D1 C 500)")
eq "t2_nao_fecha_diferenca_1_centavo recusado, o detalhe traz a diferenca, nenhuma linha" \
   "$(reg "$J" "r->>'status'||'|'||(r->>'motivo')||'|'||(r->>'detalhe')")/$(nlin "$C06")" \
   "recusado|nao_fecha|diferenca_centavos=1 calculado=1500 informado=1499/0"
J=$(pay 109 "$C06" 06 $D1 $D1 1000 1500 "$(lin $D1 C 300),$(lin $D3 C 200)")
eq "t2_linha_fora_do_periodo" "$(reg "$J" "r->>'motivo'||'|'||(r->>'detalhe')")" "linha_invalida|linha 2: data 2026-10-03 fora do periodo"
J=$(pay 110 "$C06" 06 $D1 $D1 1000 1600 "$(lin $D1 C 100 7),$(lin $D1 C 400),$(lin $D1 C 100 7)")
eq "t2_chave_repetida_no_arquivo" "$(reg "$J" "r->>'motivo'||'|'||(r->>'detalhe')")/$(nlin "$C06")" "linha_invalida|chave repetida no arquivo: 2026-10-01|C|100||7/0"
J=$(pay 111 "$C06" 06 $D1 $D1 1000 1000 '{"data":"2026-10-01","sentido":"C","valor_centavos":12.5,"descricao":"x","documento":null,"id_bancario":null,"chave":"k"}')
eq "t2_valor_nao_inteiro e linha_invalida (nao erro, nao arredonda)" "$(reg "$J" "r->>'motivo'||'|'||(r->>'detalhe')")" "linha_invalida|linha 1: valor_centavos invalido"
eq "t2_payload_sem_saldo_final contrato quebrado = 22023, nada gravado" \
   "$(estado '' service_role "SELECT public.banco_extrato_registrar('{\"banco_conta_id\":\"$C06\",\"formato\":\"ofx\",\"estrategia_chave\":\"tupla\",\"storage_path\":\"$C06/x.ofx\",\"sha256\":\"$(sha 112)\",\"enviado_por\":\"$U_STAFF\",\"hoje\":\"2026-11-20\",\"gerado_em\":\"2026-11-19T12:00:00-03:00\",\"extrato\":{\"banco\":\"341\",\"agencia\":\"0000\",\"conta\":\"20000-6\",\"periodo_inicio\":\"2026-10-01\",\"periodo_fim\":\"2026-10-01\",\"saldo_inicial_centavos\":0,\"linhas\":[]}}'::jsonb)")/$(narq "$C06")" \
   "22023/4"

# ── formato / estrategia ──
C07=$(conta_nova 07)
J=$(pay 113 "$C07" 07 $D1 $D1 1000 1100 "$(lin $D1 C 100)")
R1=$(reg "$J")
J=$(FORMATO=cnab240 pay 114 "$C07" 07 $D2 $D2 1100 1050 "$(lin $D2 D 50)")
J2=$(ESTR=id_bancario pay 115 "$C07" 07 $D2 $D2 1100 1050 "$(lin $D2 D 50)")
eq "t2_formato_diferente cnab240 (e estrategia id_bancario) numa conta fixada em ofx/tupla: pendente, sem linha" \
   "$R1/$(reg "$J")/$(reg "$J2")/$(nlin "$C07")" "aceito|-/pendente_revisao|formato_diferente/pendente_revisao|formato_diferente/1"

# ── sobreposicao ──
C08=$(conta_nova 08)
R1=$(reg "$(pay 116 "$C08" 08 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")")
J=$(pay 117 "$C08" 08 $D2 $D3 1500 1400 "$(lin $D2 D 200),$(lin $D3 C 100)")
eq "t2_sobreposicao_igual_acrescenta_so_dias_novos o dia 2 (igual) nao regrava; so o dia 3 entra" \
   "$R1/$(reg "$J" "r->>'status'||'|'||(r->>'qtd_linhas_novas')")/$(nlin "$C08")/$(Pq -c "SELECT count(*) FROM public.banco_extrato_linha WHERE banco_conta_id='$C08' AND data='$D2'")" \
   "aceito|-/aceito|1/3/1"

C09=$(conta_nova 09)
R1=$(reg "$(pay 118 "$C09" 09 $D1 $D1 1000 700 "$(lin $D1 D 150 1),$(lin $D1 D 150 2)")" "r->>'status'||'|'||(r->>'qtd_linhas_novas')")
J=$(pay 119 "$C09" 09 $D1 $D1 1000 700 "$(lin $D1 D 150 2),$(lin $D1 D 150 1)")
eq "t2_tarifas_identicas_duas_linhas 2 tarifas iguais = 2 linhas (ordinal 1 e 2); reexportado com a ordem trocada acrescenta 0" \
   "$R1/$(reg "$J" "r->>'status'||'|'||(r->>'qtd_linhas_novas')")/$(nlin "$C09")" "aceito|2/aceito|0/2"

C10=$(conta_nova 10)
R1=$(reg "$(pay 120 "$C10" 10 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")")
J=$(pay 121 "$C10" 10 $D1 $D3 1000 1700 "$(lin $D1 C 500),$(lin $D2 D 200),$(lin $D2 C 300),$(lin $D3 C 100)")
eq "t2_sobreposicao_divergente_nao_grava_linha um lancamento a mais num dia ja importado: pendente, nem o dia novo entra" \
   "$R1/$(reg "$J" "r->>'status'||'|'||(r->>'motivo')||'|'||(r->>'detalhe')")/$(nlin "$C10")" \
   "aceito|-/pendente_revisao|sobreposicao_divergente|data=2026-10-02/2"
C19=$(conta_nova 19)
R1=$(reg "$(pay 122 "$C19" 19 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200)")")
J=$(pay 123 "$C19" 19 $D1 $D2 1000 1300 "$(lin $D1 C 500),$(lin $D2 D 200),$(lin $D2 C 300),$(lin $D2 D 300)")
eq "t2_sobreposicao_divergente_compensada par C/D a mais (saldo igual) so o passo 7 pega" \
   "$R1/$(reg "$J")/$(nlin "$C19")" "aceito|-/pendente_revisao|sobreposicao_divergente/2"

# ── continuidade ──
C11=$(conta_nova 11)
R1=$(reg "$(pay 124 "$C11" 11 $D1 $D1 1000 1500 "$(lin $D1 C 500)")")
J=$(pay 125 "$C11" 11 $D2 $D2 1600 1500 "$(lin $D2 D 100)")
eq "t2_descontinuidade_saldo abertura do dia 2 != fechamento do dia 1: pendente, data e diferenca no detalhe" \
   "$R1/$(reg "$J" "r->>'status'||'|'||(r->>'motivo')||'|'||(r->>'detalhe')")/$(nlin "$C11")" \
   "aceito|-/pendente_revisao|descontinuidade_saldo|data=2026-10-01 diferenca_centavos=100 arquivo=1600 conhecido=1500 fonte=arquivo/1"

C12=$(conta_nova 12)
J=$(pay 126 "$C12" 12 $D2 $D3 null 600 "$(lin $D2 C 100)")
eq "t2_sem_saldo_inicial_sem_ancora pendente, nenhuma linha, saldo inicial segue NULL (nunca 0)" \
   "$(reg "$J")/$(nlin "$C12")/$(Pq -c "SELECT (saldo_inicial_centavos IS NULL)||'|'||(saldo_abertura_centavos IS NULL) FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C12'")" \
   "pendente_revisao|sem_saldo_inicial/0/true|true"
ID12=$(arq_id "$C12" 126)
Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$C12', '$D1', 500)" >/dev/null 2>&1
eq "t2_reavalia_pendente_quando_ancora_chega com a ancora do dia 1, o mesmo hash e aceito na MESMA linha" \
   "$(reg "$J" "r->>'status'||'|'||(r->>'arquivo_id')")/$(narq "$C12")/$(nlin "$C12")/$(Pq -c "SELECT saldo_abertura_centavos FROM public.banco_extrato_arquivo WHERE id='$ID12'")" \
   "aceito|$ID12/1/1/500"

C13=$(conta_nova 13)
Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$C13', '$D0', 1900)" >/dev/null 2>&1
J=$(pay 127 "$C13" 13 $D1 $D3 null 1950 "$(lin $D1 C 100),$(lin $D3 D 50)")
eq "t2_sem_saldo_inicial_com_ancora_aceita ancora na VESPERA (ini-1) ancora o arquivo; abertura derivada" \
   "$(reg "$J")/$(Pq -c "SELECT saldo_abertura_centavos||'|'||(saldo_inicial_centavos IS NULL) FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C13'")" \
   "aceito|-/1900|true"
# Ruling 5: sem inicial, S(d) no MEIO do periodo nao ancora (as linhas ate d nao seriam conferidas)
C22=$(conta_nova 22)
Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$C22', '$D2', 2000)" >/dev/null 2>&1
J=$(pay 139 "$C22" 22 $D1 $D3 null 1950 "$(lin $D1 C 100),$(lin $D3 D 50)")
eq "t2_sem_saldo_inicial_ancora_no_meio_nao_ancora ancora no dia 2 de um arquivo 1-3 sem inicial: pendente, nenhuma linha" \
   "$(reg "$J" "r->>'status'||'|'||(r->>'motivo')||'|'||(r->>'detalhe')")/$(nlin "$C22")" \
   "pendente_revisao|sem_saldo_inicial|nenhum saldo conhecido na vespera 2026-09-30 (arquivo aceito ou ancora)/0"
# O cenario do parecer (C1): dia 3 aceito com inicial 1000 da S(2)=1000. Um OFX do dia 2 SEM inicial, final 1000 e
# so +500 (falta o -200 que o banco lancou) teria abertura fabricada 500 e seria aceito. Agora: pendente. Depois o
# dia 1 correto (final 700) entra limpo, e a reavaliacao do OFX ruim acusa a descontinuidade no lugar certo.
C23=$(conta_nova 23)
R3=$(reg "$(pay 140 "$C23" 23 $D3 $D3 1000 1050 "$(lin $D3 C 50)")")
J=$(pay 141 "$C23" 23 $D2 $D2 null 1000 "$(lin $D2 C 500)")
R2=$(reg "$J")
R1=$(reg "$(pay 142 "$C23" 23 $D1 $D1 500 700 "$(lin $D1 C 200)")")
eq "t2_sem_saldo_inicial_so_sucessor_nao_ancora dia3 aceito | dia2 sem inicial so com S(fim) = pendente | dia1 correto aceito | dia2 reavaliado = descontinuidade | linhas" \
   "$R3/$R2/$R1/$(reg "$J" "r->>'status'||'|'||(r->>'motivo')||'|'||(r->>'detalhe')")/$(nlin "$C23")" \
   "aceito|-/pendente_revisao|sem_saldo_inicial/aceito|-/pendente_revisao|descontinuidade_saldo|data=2026-10-01 diferenca_centavos=-200 arquivo=500 conhecido=700 fonte=arquivo/2"

C14=$(conta_nova 14)
Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$C14', '$D0', 5000)" >/dev/null 2>&1
J=$(pay 128 "$C14" 14 $D1 $D2 null 5100 "$(lin $D1 C 100)")
eq "t2_ancora_manual_aceita_primeiro_ofx 1o OFX (sem saldo inicial) da conta, ancorado na vespera pela ancora manual" \
   "$(reg "$J")/$(Pq -c "SELECT saldo_abertura_centavos FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C14'")/$(Pq -c "SELECT formato FROM public.banco_conta WHERE id='$C14'")" \
   "aceito|-/5000/ofx"
C20=$(conta_nova 20)
Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$C20', '$D0', 5000)" >/dev/null 2>&1
J=$(pay 129 "$C20" 20 $D1 $D1 null 5200 "$(lin $D1 C 100)")
eq "t2_ancora_divergente arquivo sem inicial que nao bate com a ancora: descontinuidade" \
   "$(reg "$J" "r->>'motivo'||'|'||(r->>'detalhe')")/$(nlin "$C20")" \
   "descontinuidade_saldo|data=2026-09-30 diferenca_centavos=100 arquivo=5100 conhecido=5000 fonte=ancora_manual/0"

# ── Ruling 7: a ancora manual e conferida contra o S(d) de arquivo ACEITO do mesmo dia ──
C26=$(conta_nova 26)
R1=$(reg "$(pay 150 "$C26" 26 $D1 $D1 1000 1500 "$(lin $D1 C 500)")")
nanc() { Pq -c "SELECT count(*) FROM public.banco_conta_ancora WHERE banco_conta_id = '$1'" 2>&1; }
eq "t2_ancora_diverge_do_arquivo dia 1 aceito (S=1500), ancora 1400: 23514 com a marca, nada gravado" \
   "$R1/$(estado_marca "$U_OBEN" authenticated "SELECT public.banco_conta_registrar_ancora('$C26', '$D1', 1400)" ANCORA_DIVERGE_DO_ARQUIVO)/$(nanc "$C26")" \
   "aceito|-/23514|t/0"
eq "t2_ancora_diverge_da_vespera_do_arquivo vespera do aceito (S(ini-1)=1000), ancora 999: 23514 com a marca, nada gravado" \
   "$(estado_marca "$U_OBEN" authenticated "SELECT public.banco_conta_registrar_ancora('$C26', '$D0', 999)" ANCORA_DIVERGE_DO_ARQUIVO)/$(nanc "$C26")" \
   "23514|t/0"
AI1=$(Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$C26', '$D1', 1500)" 2>&1 | tail -1)
eq "t2_ancora_igual_ao_arquivo_ok mesmo valor do arquivo grava; repetir devolve o mesmo id (idempotente)" \
   "$(Pq -c "SET test.uid = '$U_OBEN'; SET ROLE authenticated; SELECT public.banco_conta_registrar_ancora('$C26', '$D1', 1500) = '$AI1'::uuid" 2>&1 | tail -1)/$(nanc "$C26")" \
   "t/1"

# fora de ordem: dias 1 e 3 aceitos, depois o dia 2 (as DUAS fronteiras)
C15=$(conta_nova 15)
R1=$(reg "$(pay 130 "$C15" 15 $D1 $D1 1000 1100 "$(lin $D1 C 100)")")
R3=$(reg "$(pay 131 "$C15" 15 $D3 $D3 1300 1350 "$(lin $D3 C 50)")")
J=$(pay 132 "$C15" 15 $D2 $D2 1100 1200 "$(lin $D2 C 100)")
eq "t2_fora_de_ordem_dia2_confere_dia3 o dia 2 fecha com o dia 1 mas nao com a abertura do dia 3" \
   "$R1/$R3/$(reg "$J" "r->>'status'||'|'||(r->>'motivo')||'|'||(r->>'detalhe')")/$(nlin "$C15")" \
   "aceito|-/aceito|-/pendente_revisao|descontinuidade_saldo|data=2026-10-02 diferenca_centavos=-100 arquivo=1200 conhecido=1300 fonte=arquivo/2"
J=$(pay 133 "$C15" 15 $D2 $D2 1100 1300 "$(lin $D2 C 200)")
eq "t2_fora_de_ordem_dia2_fecha_as_duas controle: o dia 2 que fecha com o 1 e com o 3 e aceito" "$(reg "$J")/$(nlin "$C15")" "aceito|-/3"

C16=$(conta_nova 16)
R1=$(reg "$(pay 134 "$C16" 16 $D1 $D1 1000 1100 "$(lin $D1 C 100)")")
R3=$(reg "$(pay 135 "$C16" 16 $D3 $D3 1300 1350 "$(lin $D3 C 50)")")
J=$(pay 136 "$C16" 16 $D2 $D2 null 1300 "$(lin $D2 C 200)")
eq "t2_fora_de_ordem_sem_saldo_inicial OFX do dia 2 sem inicial, ancorado pelo dia 1, confere com o dia 3" \
   "$R1/$R3/$(reg "$J")/$(Pq -c "SELECT saldo_abertura_centavos FROM public.banco_extrato_arquivo WHERE banco_conta_id='$C16' AND sha256='$(sha 136)'")" \
   "aceito|-/aceito|-/aceito|-/1100"

# ── resumo por dia (SECURITY INVOKER, sob RLS) ──
RESUMO_FMT="string_agg(to_char(data, 'YYYY-MM-DD')||':'||coberto||':'||coalesce(creditos_centavos::text, 'NULL')||':'||coalesce(debitos_centavos::text, 'NULL')||':'||coalesce(saldo_final_dia_centavos::text, 'NULL'), ' ' ORDER BY data)"
eq "t2_resumo_dia_sem_cobertura_null dia fora da cobertura: coberto=false e creditos/debitos/saldo NULL (nao 0)" \
   "$(como "$U_OBEN" "SELECT coberto||'|'||(creditos_centavos IS NULL)||'|'||(debitos_centavos IS NULL)||'|'||(saldo_final_dia_centavos IS NULL) FROM public.banco_extrato_resumo_dia('$C08', '$D0', '$D0')" 2>&1)" \
   "false|true|true|true"
eq "t2_resumo_dia_valores conta com 2 arquivos sobrepostos: cada linha conta uma vez, saldo ancorado na abertura" \
   "$(como "$U_OBEN" "SELECT $RESUMO_FMT FROM public.banco_extrato_resumo_dia('$C08', '$D0', '2026-10-04')" 2>&1)" \
   "2026-09-30:false:NULL:NULL:NULL 2026-10-01:true:500:0:1500 2026-10-02:true:0:200:1300 2026-10-03:true:100:0:1400 2026-10-04:false:NULL:NULL:NULL"
C18=$(conta_nova 18)
R1=$(reg "$(pay 137 "$C18" 18 $D1 $D3 1000 1100 "$(lin $D1 C 100)")")
eq "t2_resumo_dia_coberto_sem_movimento_zero dia coberto sem lancamento: 0, 0 e o saldo" \
   "$R1/$(como "$U_OBEN" "SELECT $RESUMO_FMT FROM public.banco_extrato_resumo_dia('$C18', '$D2', '$D2')" 2>&1)" \
   "aceito|-/2026-10-02:true:0:0:1100"
eq "t2_resumo_dia_rls sem permissao: nada coberto, tudo NULL" \
   "$(como "$U_SEM" "SELECT $RESUMO_FMT FROM public.banco_extrato_resumo_dia('$C08', '$D1', '$D1')" 2>&1)" "2026-10-01:false:NULL:NULL:NULL"
eq "t2_resumo_dia_anon_negado (42501)" \
   "$(estado '' anon "SELECT * FROM public.banco_extrato_resumo_dia('$C08', '$D1', '$D1')")" "42501"

# ── marcar conferido ──
eq "t2_conferido_exige_acesso sem permissao financeira (42501)" \
   "$(estado "$U_SEM" authenticated "SELECT public.banco_extrato_marcar_conferido('$ID01')")/$(Pq -c "SELECT conferido_por IS NULL FROM public.banco_extrato_arquivo WHERE id='$ID01'")" "42501/t"
eq "t2_conferido_sem_usuario (42501)" "$(estado '' authenticated "SELECT public.banco_extrato_marcar_conferido('$ID01')")" "42501"
eq "t2_conferido_grava autor = auth.uid(), com data" \
   "$(estado "$U_OBEN" authenticated "SELECT public.banco_extrato_marcar_conferido('$ID01')")/$(Pq -c "SELECT conferido_por||'|'||(conferido_em IS NOT NULL) FROM public.banco_extrato_arquivo WHERE id='$ID01'")" \
   "00000/$U_OBEN|true"
eq "t2_conferido_idempotente 2a conferencia (outro usuario) mantem o 1o autor" \
   "$(estado "$U_STAFF" authenticated "SELECT public.banco_extrato_marcar_conferido('$ID01')")/$(Pq -c "SELECT conferido_por FROM public.banco_extrato_arquivo WHERE id='$ID01'")" \
   "00000/$U_OBEN"
eq "t2_conferido_so_aceito arquivo recusado nao e conferido (22023)" \
   "$(estado "$U_OBEN" authenticated "SELECT public.banco_extrato_marcar_conferido('$ID03')")/$(Pq -c "SELECT conferido_por IS NULL FROM public.banco_extrato_arquivo WHERE id='$ID03'")" "22023/t"
eq "t2_conferido_inexistente (P0002)" \
   "$(estado "$U_STAFF" authenticated "SELECT public.banco_extrato_marcar_conferido('00000000-0000-0000-0000-000000000000')")" "P0002"

# ── ACL ──
eq "t2_rpc_fechada_para_authenticated registrar: PUBLIC|anon|authenticated sem EXECUTE, service_role com, SECDEF" \
   "$(Pq -c "SELECT has_function_privilege('public', 'public.banco_extrato_registrar(jsonb)', 'EXECUTE')||'|'||has_function_privilege('anon', 'public.banco_extrato_registrar(jsonb)', 'EXECUTE')||'|'||has_function_privilege('authenticated', 'public.banco_extrato_registrar(jsonb)', 'EXECUTE')||'|'||has_function_privilege('service_role', 'public.banco_extrato_registrar(jsonb)', 'EXECUTE')||'|'||(SELECT prosecdef FROM pg_proc WHERE oid = 'public.banco_extrato_registrar(jsonb)'::regprocedure)" 2>&1)" \
   "false|false|false|true|true"
eq "t2_rpc_authenticated_chamando_negado staff autenticado nao chama o registrar (42501)" \
   "$(estado "$U_STAFF" authenticated "SELECT public.banco_extrato_registrar('{}'::jsonb)")" "42501"
eq "t2_conferido_acl marcar_conferido: anon nao, authenticated sim, SECDEF; resumo INVOKER" \
   "$(Pq -c "SELECT has_function_privilege('anon', 'public.banco_extrato_marcar_conferido(uuid)', 'EXECUTE')||'|'||has_function_privilege('authenticated', 'public.banco_extrato_marcar_conferido(uuid)', 'EXECUTE')||'|'||(SELECT prosecdef FROM pg_proc WHERE oid = 'public.banco_extrato_marcar_conferido(uuid)'::regprocedure)||'|'||(SELECT prosecdef FROM pg_proc WHERE oid = 'public.banco_extrato_resumo_dia(uuid,date,date)'::regprocedure)" 2>&1)" \
   "false|true|true|false"

# ── concorrencia: duas sessoes psql reais com o MESMO payload ──
# A sessao 1 registra e segura a transacao 2s; a sessao 2 comeca 0.5s depois. ANTES=0 na sessao 2 prova que
# ela comecou com a 1 ainda aberta (nao viu o arquivo). Sem a trava, a 2 colide no UNIQUE (23505).
C17=$(conta_nova 17)
JC=$(pay 138 "$C17" 17 $D1 $D1 1000 1300 "$(lin $D1 C 500),$(lin $D1 D 100 1),$(lin $D1 D 100 2)")
TMPC="$(dirname "$DATA")"
sess() { # $1 = segundos segurando a transacao
  P -qAt 2>&1 <<SQL
SELECT 'ANTES='||count(*) FROM public.banco_extrato_arquivo WHERE banco_conta_id = '$C17';
BEGIN;
SET LOCAL ROLE service_role;
SELECT 'R='||(r->>'status')||'|'||(r->>'arquivo_id') FROM (SELECT public.banco_extrato_registrar(\$j\$$JC\$j\$::jsonb) r) s;
SELECT pg_sleep($1);
COMMIT;
SQL
}
sess 2 > "$TMPC/conc1.log" & PID1=$!
sleep 0.5
sess 0 > "$TMPC/conc2.log" & PID2=$!
wait "$PID1"; wait "$PID2"
R_1=$(grep -o '^R=.*' "$TMPC/conc1.log" | cut -d= -f2-)
R_2=$(grep -o '^R=.*' "$TMPC/conc2.log" | cut -d= -f2-)
ID17=$(arq_id "$C17" 138)
eq "t2_concorrencia 1 aceito + 1 ja_importado com o MESMO arquivo_id; 1 arquivo; linhas = as do arquivo; a 2a comecou com a 1a aberta" \
   "${R_1:-ERRO:$(head -c 200 "$TMPC/conc1.log")}/${R_2:-ERRO:$(head -c 200 "$TMPC/conc2.log")}/$(narq "$C17")/$(nlin "$C17")/$(grep -o '^ANTES=.*' "$TMPC/conc2.log")" \
   "aceito|$ID17/ja_importado|$ID17/1/3/ANTES=0"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK banco-extrato-f1"
