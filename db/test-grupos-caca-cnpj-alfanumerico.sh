#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — grupos de clientes / Caça aceitam CNPJ ALFANUMÉRICO                            ║
# ║  (migration 20261020130000_grupos_caca_cnpj_alfanumerico — follow-up 3 do #3180)               ║
# ║   bash db/test-grupos-caca-cnpj-alfanumerico.sh               (controle)                       ║
# ║   bash db/test-grupos-caca-cnpj-alfanumerico.sh --falsificar  (controle + 5 sabotagens, cada    ║
# ║                                    uma com CONTROLE VERDE antes, VERMELHO durante, VERDE depois)║
# ║                                                                                                ║
# ║  Mundo: stubs + prelude + schema-snapshot (tabelas e as 6 views da prod) + fixture              ║
# ║  db/fixtures/grupos-caca-predecessoras-prod-20261020.sql (as 2 funções do #3195 e as 6 views   ║
# ║  VERBATIM da prod, md5 conferido) → dados de prova → a migration sob prova.                     ║
# ║   P   predecessoras: md5(prosrc) das 2 funções e md5(viewdef) das 6 views = prod; CHECK antigo  ║
# ║   O   ORÁCULO numérico: 2 grupos numéricos com pedidos/títulos/contatos — foto das 6 views      ║
# ║       ANTES da migration (as v_grupo_* não-vazias; a Caça com o alfanumérico AUSENTE)           ║
# ║   A0  aplica · re-aplicar é no-op (PRE aceita "este"; md5/ACL/reloptions iguais)                ║
# ║   A1  numérico BYTE-IDÊNTICO: v_grupo_* iguais à foto; Caça: EXCEPT ALL bidirecional — só os     ║
# ║       alfanuméricos entraram, nenhuma linha saiu                                               ║
# ║   A2  CHECK executando como `authenticated` (staff): exemplo oficial da RFB entra; DV errado,   ║
# ║       minúscula, máscara, 10 dígitos → 23514 nomeando a constraint; duplicata → 23505;          ║
# ║       UPDATE idem; CPF/CNPJ numéricos seguem entrando                                           ║
# ║   A3  as 6 views casam o alfanumérico (contatos, comercial, contas a receber, por_doc, Caça) e   ║
# ║       AEG12345678909 (alnum válido) NÃO contamina o CPF 12345678909 (mesma mutilação) — grupos   ║
# ║       distintos, contagens separadas                                                           ║
# ║   A4  papéis: anon 0 linhas (sem 42501), customer sem fin_permissoes 0, staff lê, service_role lê ║
# ║   A5  custo: 50k linhas sintéticas, normalizar_documento vs regexp_replace (informativo)        ║
# ║   F1-F5 (--falsificar): CHECK antigo · view contatos predecessora · REVOKE do helper ·          ║
# ║       DV removido (e a PRE da migration pega a deriva) · view Caça predecessora                 ║
# ║  Locale: cluster initdb --locale=C; asserts por SQLSTATE, nunca por texto de erro.              ║
# ╚═══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"; SLUG="grupos-caca-alnum"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"; DATA="$TMPD/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20261020130000_grupos_caca_cnpj_alfanumerico.sql"
FIX="$REPO_ROOT/db/fixtures/grupos-caca-predecessoras-prod-20261020.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
FALSIFICAR=0; [ "${1:-}" = "--falsificar" ] && FALSIFICAR=1
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
[ -f "$FIX" ] || { echo "fixture ausente: $FIX"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"; cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# a migration roda sob `public, pg_catalog` (como a fixture): é o search_path em que a deparse foi medida
PM() { PGOPTIONS="-c search_path=public,pg_catalog" P "$@"; }
PASS=0; FAIL=0; SAB_V=0; SAB_F=0
ok(){ PASS=$((PASS+1)); echo "  ✅ $1"; }; bad(){ FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq(){ if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# estado "<prelúdio de papel>" "<sql>" → OK ou a SQLSTATE (5 chars) do erro; o nome da constraint vai em $ULTIMO_ERRO
# (o último erro vai para arquivo — $(estado …) roda em subshell, variável não voltaria)
estado() {
  local err; err="$(P -v VERBOSITY=verbose -q -c "BEGIN;" -c "$1" -c "$2" -c "ROLLBACK;" 2>&1 >/dev/null)" && { : > "$TMPD/ultimo.err"; echo "OK"; return; }
  printf '%s' "$err" > "$TMPD/ultimo.err"; echo "$err" | sed -nE 's/^ERROR:  ([0-9A-Z]{5}):.*/\1/p' | head -1
}
# conta "<prelúdio>" "<from>" → count(*) ou DENIED/ERRO
conta() {
  local out; out="$(P -q -tA -c "BEGIN;" -c "$1" -c "SELECT count(*) FROM $2;" -c "ROLLBACK;" 2>&1)" || { echo "$out" | grep -q "permission denied" && echo DENIED || echo ERRO; return; }
  echo "$out" | tail -1
}
COMO_STAFF="SET LOCAL ROLE authenticated; SET LOCAL test.uid TO '00000000-0000-4000-8000-0000000000e5'; SET LOCAL test.role TO 'authenticated';"
COMO_CUST="SET LOCAL ROLE authenticated; SET LOCAL test.uid TO '00000000-0000-4000-8000-0000000000a1'; SET LOCAL test.role TO 'authenticated';"
COMO_ANON="SET LOCAL ROLE anon; SET LOCAL test.role TO 'anon';"
COMO_SVC="SET LOCAL ROLE service_role; SET LOCAL test.role TO 'service_role';"
VIEWS="v_grupo_comercial v_grupo_contatos v_grupo_contas_receber v_grupo_contas_receber_por_doc v_caca_compradores v_caca_candidatos"
md5_view() { Pq -c "SELECT md5(pg_get_viewdef('public.$1'::regclass, true));"; }
md5_saida() { Pq -c "SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.$1 t ${2:-};"; }
# o oráculo numérico olha só o que NÃO colide: G1 (CNPJ numérico puro) e, na Caça, fora dos 3 documentos em jogo
SO_G1="WHERE grupo_id='00000000-0000-4000-8000-00000000c001'"
FORA_COLISAO="WHERE documento NOT IN ('12345678909','AEG12345678909','12ABC34501DE35')"
echo "═══ setup (PG17 :$PORT) ═══"

# ════════════════════════════════════════════════════════
# ZONA 1 — schema de prod: stubs + prelude + snapshot (transação única)
# ════════════════════════════════════════════════════════
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$TMPD/snap.sql"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
SQL
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$TMPD/snap.sql" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
# grants fiéis à prod (o snapshot vem SEM privilégios): quem barra anon é o RLS, não a ausência de grant
P -q <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.cliente_grupos, public.cliente_grupo_membros TO authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
SQL

# ════════════════════════════════════════════════════════
# ZONA 2 — as PREDECESSORAS verbatim da prod (P1-P9: é o ensaio do predicado da PRE)
# ════════════════════════════════════════════════════════
echo "═══ P. predecessoras = prod ═══"
PGOPTIONS="-c search_path=public,pg_catalog" P -q -f "$FIX"
eq "P1 md5(prosrc) cnpj_alfanumerico_valido = prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.cnpj_alfanumerico_valido(text)'::regprocedure")" "b27b482a550084775b12ef78f03e29c4"
eq "P2 md5(prosrc) normalizar_documento = prod"     "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.normalizar_documento(text)'::regprocedure")"     "b7659502c90df3ff483c576cf56d559d"
eq "P3 md5 v_grupo_comercial = prod"              "$(md5_view v_grupo_comercial)"              "636aee1851fb145c2da6084e681bbdbf"
eq "P4 md5 v_grupo_contatos = prod"               "$(md5_view v_grupo_contatos)"               "b1b75f0163b75f0906f56f9053374969"
eq "P5 md5 v_grupo_contas_receber = prod"         "$(md5_view v_grupo_contas_receber)"         "b05ddadaa94d946e3e84184cee2b97ed"
eq "P6 md5 v_grupo_contas_receber_por_doc = prod" "$(md5_view v_grupo_contas_receber_por_doc)" "ab437b5db3d7f3f914c7d31c0783133f"
eq "P7 md5 v_caca_compradores = prod"             "$(md5_view v_caca_compradores)"             "8a5cb6e0b81e3b0024a9909d2d87b4ee"
eq "P8 md5 v_caca_candidatos = prod"              "$(md5_view v_caca_candidatos)"              "f7538335d873138f190f6c60a74b6ffa"
eq "P9 CHECK vivo é o só-dígitos de 20260615120000" "$(Pq -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.cliente_grupo_membros'::regclass AND conname='cliente_grupo_membros_documento_digits'")" "CHECK (((documento ~ '^[0-9]+\$'::text) AND (char_length(documento) = ANY (ARRAY[11, 14]))))"
eq "P10 helpers FECHADOS a authenticated antes (o 42501 que a migration conserta)" "$(Pq -c "SELECT has_function_privilege('authenticated','public.normalizar_documento(text)','EXECUTE')")" "f"
eq "P11 AEG12345678909 é CNPJ alfanumérico VÁLIDO (DV confere) e sua mutilação é o CPF 12345678909" "$(Pq -c "SELECT public.cnpj_alfanumerico_valido('AEG12345678909')::text || regexp_replace('AEG12345678909','\D','','g')")" "true12345678909"

# ════════════════════════════════════════════════════════
# ZONA 3 — dados: 4 clientes (2 numéricos, 2 alfanuméricos), staff, pedidos, títulos; 2 grupos numéricos
# ════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a1','u1@t.local'), ('00000000-0000-4000-8000-0000000000a2','u2@t.local'),
  ('00000000-0000-4000-8000-0000000000a3','u3@t.local'), ('00000000-0000-4000-8000-0000000000a4','u4@t.local'),
  ('00000000-0000-4000-8000-0000000000a6','u6@t.local'), ('00000000-0000-4000-8000-0000000000e5','staff@t.local');
INSERT INTO public.profiles (user_id, name, document, cnpj, phone, cnae, is_employee) VALUES
  ('00000000-0000-4000-8000-0000000000a1','U1 CNPJ numérico', '12.345.678/0001-90', NULL, '11999990001', '4741-5/00', false),
  ('00000000-0000-4000-8000-0000000000a2','U2 CPF numérico',  '123.456.789-09',     NULL, '11999990002', NULL, false),
  ('00000000-0000-4000-8000-0000000000a3','U3 CNPJ alfanumérico (máscara+minúscula na fonte)', '12.abc.345/01de-35', NULL, '11999990003', '4741-5/00', false),
  ('00000000-0000-4000-8000-0000000000a4','U4 alnum que mutila no CPF de U2', 'AEG12345678909', NULL, '11999990004', NULL, false),
  ('00000000-0000-4000-8000-0000000000a6','U6 só coluna cnpj', NULL, '98.765.432/0001-00', '11999990006', NULL, false),
  ('00000000-0000-4000-8000-0000000000e5','Staff', NULL, NULL, NULL, NULL, true);
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-4000-8000-0000000000e5', 'employee') ON CONFLICT DO NOTHING;  -- o trigger auto_assign_user_role (AFTER INSERT em profiles) já pode ter criado a linha
-- pedidos: todos faturados; U3 comprou na oben há 10 dias e na colacor há 7 meses (→ candidata na colacor, não na oben)
INSERT INTO public.sales_orders (customer_user_id, created_by, account, status, total, order_date_kpi) VALUES
  ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000e5','oben','faturado',100,current_date-10),
  ('00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000e5','oben','faturado',200,current_date-10),
  ('00000000-0000-4000-8000-0000000000a3','00000000-0000-4000-8000-0000000000e5','oben','faturado',300,current_date-10),
  ('00000000-0000-4000-8000-0000000000a3','00000000-0000-4000-8000-0000000000e5','colacor','faturado',30,current_date-210),
  ('00000000-0000-4000-8000-0000000000a4','00000000-0000-4000-8000-0000000000e5','oben','faturado',400,current_date-10),
  ('00000000-0000-4000-8000-0000000000a6','00000000-0000-4000-8000-0000000000e5','oben','faturado',600,current_date-10);
INSERT INTO public.fin_contas_receber (company, omie_codigo_lancamento, cnpj_cpf, nome_cliente, valor_documento, data_vencimento, status_titulo) VALUES  -- saldo é gerado (valor_documento - valor_recebido)
  ('oben', 1, '12345678000190',      'U1', 10, current_date+10, 'ABERTO'),
  ('oben', 2, '123.456.789-09',      'U2', 20, current_date+10, 'ABERTO'),
  ('oben', 3, '12.ABC.345/01DE-35',  'U3', 30, current_date+10, 'ABERTO'),
  ('oben', 4, 'AEG12345678909',      'U4', 40, current_date+10, 'ABERTO'),
  ('oben', 5, NULL,                  'sem doc', 99, current_date+10, 'ABERTO');
INSERT INTO public.cliente_grupos (id, nome) VALUES
  ('00000000-0000-4000-8000-00000000c001','G1 numérico CNPJ'), ('00000000-0000-4000-8000-00000000c002','G2 numérico CPF'),
  ('00000000-0000-4000-8000-00000000c003','G3 alnum oficial'),  ('00000000-0000-4000-8000-00000000c004','G4 alnum que mutila');
INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES
  ('00000000-0000-4000-8000-00000000c001','12345678000190'), ('00000000-0000-4000-8000-00000000c002','12345678909');
SQL
echo "═══ O. oráculo numérico ANTES da migration ═══"
eq "O1 CHECK antigo RECUSA o exemplo oficial da RFB (o buraco)" "$(estado "$COMO_SVC" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ('00000000-0000-4000-8000-00000000c003','12ABC34501DE35')")" "23514"
eq "O2 v_grupo_contatos não-vazia: G1=1 contato" "$(Pq -c "SELECT count(*) FROM public.v_grupo_contatos $SO_G1")" "1"
eq "O2b A CONTAMINAÇÃO de hoje: G2 (CPF 12345678909) ganha 2 contatos — U4 (AEG12345678909) mutilado vira o CPF de U2" "$(Pq -c "SELECT count(*) FROM public.v_grupo_contatos WHERE grupo_id='00000000-0000-4000-8000-00000000c002'")" "2"
eq "O3 A CONTAMINAÇÃO de hoje: G2 total_aberto=60 (20 do CPF + 40 do título AEG… mutilado)" "$(Pq -c "SELECT total_aberto FROM public.v_grupo_contas_receber WHERE grupo_id='00000000-0000-4000-8000-00000000c002'")" "60.00"
eq "O3b A CONTAMINAÇÃO na Caça: 12345678909 soma U2+U4 (600) e AEG… não existe" "$(Pq -c "SELECT volume FROM public.v_caca_compradores WHERE documento='12345678909' AND empresa='oben'")" "600"
eq "O4 Caça ANTES: U3 e U4 AUSENTES de v_caca_compradores (documento virava NULL)" "$(Pq -c "SELECT count(*) FROM public.v_caca_compradores WHERE documento IN ('12ABC34501DE35','AEG12345678909')")" "0"
eq "O5 Caça ANTES: U1, U2 e U6 (coluna cnpj) PRESENTES" "$(Pq -c "SELECT count(DISTINCT documento) FROM public.v_caca_compradores WHERE documento IN ('12345678000190','12345678909','98765432000100')")" "3"
for v in v_grupo_comercial v_grupo_contatos v_grupo_contas_receber v_grupo_contas_receber_por_doc; do eval "ANTES_$v=\"$(md5_saida "$v" "$SO_G1")\""; done   # bash 3.2 do macOS: sem declare -A
P -q -c "CREATE SCHEMA teste; CREATE TABLE teste.comp_antes AS SELECT * FROM public.v_caca_compradores $FORA_COLISAO; CREATE TABLE teste.cand_antes AS SELECT * FROM public.v_caca_candidatos $FORA_COLISAO;"
FOTO_ACL="$(Pq -c "SELECT string_agg(relname||':'||coalesce(reloptions::text,'')||':'||coalesce(relacl::text,''), ';' ORDER BY relname) FROM pg_class WHERE relname IN ('v_grupo_comercial','v_grupo_contatos','v_grupo_contas_receber','v_grupo_contas_receber_por_doc','v_caca_compradores','v_caca_candidatos')")"

# ════════════════════════════════════════════════════════
# ZONA 4 — A0: aplica, re-aplica
# ════════════════════════════════════════════════════════
echo "═══ A0. migration ═══"
if PM -q -f "$MIG" >"$TMPD/mig1.log" 2>&1; then ok "A0.1 migration aplica (PRE aceitou o predecessor; PÓS executou)"; else bad "A0.1 migration FALHOU"; tail -5 "$TMPD/mig1.log"; fi
eq "A0.2 CHECK vivo = formato (11|14 dígitos|alnum válido), validado" "$(Pq -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.cliente_grupo_membros'::regclass AND conname='cliente_grupo_membros_documento_formato' AND convalidated")" "CHECK (((documento ~ '^[0-9]{11}\$'::text) OR (documento ~ '^[0-9]{14}\$'::text) OR cnpj_alfanumerico_valido(documento)))"
eq "A0.3 CHECK antigo removido" "$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conrelid='public.cliente_grupo_membros'::regclass AND conname='cliente_grupo_membros_documento_digits'")" "0"
eq "A0.4 helpers EXECUTE para anon+authenticated+service_role" "$(Pq -c "SELECT bool_and(has_function_privilege(r,'public.cnpj_alfanumerico_valido(text)','EXECUTE') AND has_function_privilege(r,'public.normalizar_documento(text)','EXECUTE')) FROM unnest(ARRAY['anon','authenticated','service_role']) r")" "t"
eq "A0.5 reloptions+ACL das 6 views INALTERADOS (literais on/true preservados)" "$(Pq -c "SELECT string_agg(relname||':'||coalesce(reloptions::text,'')||':'||coalesce(relacl::text,''), ';' ORDER BY relname) FROM pg_class WHERE relname IN ('v_grupo_comercial','v_grupo_contatos','v_grupo_contas_receber','v_grupo_contas_receber_por_doc','v_caca_compradores','v_caca_candidatos')")" "$FOTO_ACL"
for v in $VIEWS; do eval "ESTE_$v=\"$(md5_view "$v")\""; done
if PM -q -f "$MIG" >"$TMPD/mig2.log" 2>&1; then ok "A0.6 re-aplicar é no-op (PRE aceita 'este')"; else bad "A0.6 re-aplicar FALHOU"; tail -5 "$TMPD/mig2.log"; fi
for v in $VIEWS; do n="ESTE_$v"; eq "A0.7 $v: md5 idêntico após re-aplicar" "$(md5_view "$v")" "${!n}"; done
eq "A0.8 nenhuma das 6 views ficou sem normalizar_documento" "$(Pq -c "SELECT count(*) FROM pg_class WHERE relname IN ('v_grupo_comercial','v_grupo_contatos','v_grupo_contas_receber','v_grupo_contas_receber_por_doc','v_caca_compradores','v_caca_candidatos') AND pg_get_viewdef(oid,true) ~ 'normalizar_documento\('")" "6"
eq "A0.9 nenhuma delas perdeu o regexp_replace de TELEFONE (candidatos: 3)" "$(Pq -c "SELECT (regexp_matches(pg_get_viewdef('public.v_caca_candidatos'::regclass,true), 'regexp_replace\(COALESCE\((cv\.phone|wc\.phone_e164)', 'g')) IS NOT NULL" | grep -c t)" "3"

# ════════════════════════════════════════════════════════
# ZONA 5 — A1: numérico BYTE-IDÊNTICO; Caça só GANHOU os alfanuméricos
# ════════════════════════════════════════════════════════
echo "═══ A1. numérico byte-idêntico ═══"
for v in v_grupo_comercial v_grupo_contatos v_grupo_contas_receber v_grupo_contas_receber_por_doc; do n="ANTES_$v"; eq "A1 $v: G1 (numérico sem colisão) IDÊNTICO à foto de antes" "$(md5_saida "$v" "$SO_G1")" "${!n}"; done
eq "A1.5 v_caca_compradores fora da colisão: nenhuma linha SAIU" "$(Pq -c "SELECT count(*) FROM (SELECT * FROM teste.comp_antes EXCEPT ALL SELECT * FROM public.v_caca_compradores $FORA_COLISAO) x")" "0"
eq "A1.6 v_caca_compradores fora da colisão: nenhuma linha ENTROU" "$(Pq -c "SELECT count(*) FROM (SELECT * FROM public.v_caca_compradores $FORA_COLISAO EXCEPT ALL SELECT * FROM teste.comp_antes) x")" "0"
eq "A1.7 v_caca_candidatos fora da colisão: nenhuma linha SAIU" "$(Pq -c "SELECT count(*) FROM (SELECT * FROM teste.cand_antes EXCEPT ALL SELECT * FROM public.v_caca_candidatos $FORA_COLISAO) x")" "0"
eq "A1.8 v_caca_candidatos fora da colisão: nenhuma linha ENTROU" "$(Pq -c "SELECT count(*) FROM (SELECT * FROM public.v_caca_candidatos $FORA_COLISAO EXCEPT ALL SELECT * FROM teste.cand_antes) x")" "0"
eq "A1.8b a Caça tem linhas fora da colisão (o oráculo não compara vazio com vazio)" "$(Pq -c "SELECT count(*) > 0 FROM teste.comp_antes")" "t"
eq "A1.9 identidade da chave numérica com máscara/prefixo/NULL (normalizar = regexp_replace)" "$(Pq -c "SELECT bool_and(public.normalizar_documento(x) IS NOT DISTINCT FROM regexp_replace(x,'\D','','g')) FROM unnest(ARRAY['12.345.678/0001-90','CNPJ: 12345678000190','123.456.789-09','00012345678909','',' 12345678000190 ','aeg-123.456.789-09','aeg 123.456.789-09','12.ABC.345/01DE-36',NULL]) x")" "t"

# ════════════════════════════════════════════════════════
# ZONA 6 — A2: o CHECK executando como authenticated (staff)
# ════════════════════════════════════════════════════════
echo "═══ A2. CHECK como authenticated ═══"
G3="'00000000-0000-4000-8000-00000000c003'"; G4="'00000000-0000-4000-8000-00000000c004'"
eq "A2.1 staff insere o exemplo oficial da RFB (12ABC34501DE35)" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'12ABC34501DE35')")" "OK"
eq "A2.2 DV errado (12ABC34501DE36) → 23514" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'12ABC34501DE36')")" "23514"
eq "A2.2b … e o erro NOMEIA a constraint nova" "$(grep -q cliente_grupo_membros_documento_formato "$TMPD/ultimo.err" && echo nomeia || echo nao)" "nomeia"
eq "A2.3 minúscula (12abc34501de35) → 23514 (quem normaliza é o front)" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'12abc34501de35')")" "23514"
eq "A2.4 com máscara → 23514" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'12.ABC.345/01DE-35')")" "23514"
eq "A2.5 10 dígitos → 23514" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'1234567890')")" "23514"
eq "A2.6 AEG12345678908 (DV errado do contraexemplo do Codex) → 23514" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G4,'AEG12345678908')")" "23514"
eq "A2.7 CPF numérico (11) segue entrando" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'98765432100')")" "OK"
eq "A2.8 CNPJ numérico (14) segue entrando" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'98765432000100')")" "OK"
eq "A2.9 12 dígitos → 23514 (numérico continua 11|14)" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'123456789012')")" "23514"
eq "A2.10 customer SEM fin_permissoes não insere (RLS, 42501)" "$(estado "$COMO_CUST" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'12ABC34501DE35')")" "42501"
# agora os membros alfanuméricos DE VERDADE (como staff, commitado)
P -q -c "$COMO_STAFF" -c "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G3,'12ABC34501DE35'), ($G4,'AEG12345678909');"
eq "A2.11 duplicata do alfanumérico noutro grupo → 23505" "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ($G4,'12ABC34501DE35')")" "23505"
eq "A2.12 UPDATE para alfanumérico válido → OK" "$(estado "$COMO_STAFF" "UPDATE public.cliente_grupo_membros SET documento='12ABC34501DE35' WHERE documento='12345678000190'")" "23505"
eq "A2.13 UPDATE para DV errado → 23514" "$(estado "$COMO_STAFF" "UPDATE public.cliente_grupo_membros SET documento='12ABC34501DE36' WHERE documento='12345678000190'")" "23514"
eq "A2.14 UPDATE para outro alnum válido (12ABC34501DE35 com DV recalculado? não: AEG12345678909 já existe → 23505)" "$(estado "$COMO_STAFF" "UPDATE public.cliente_grupo_membros SET documento='AEG12345678909' WHERE documento='12345678000190'")" "23505"

# ════════════════════════════════════════════════════════
# ZONA 7 — A3: as 6 views casam o alfanumérico; a mutilação não contamina
# ════════════════════════════════════════════════════════
echo "═══ A3. views ═══"
eq "A3.1 v_grupo_contatos: G3 casa U3 (fonte com máscara+minúscula → chave maiúscula)" "$(Pq -c "SELECT string_agg(nome||'|'||documento, ',') FROM public.v_grupo_contatos WHERE grupo_id=$G3")" "U3 CNPJ alfanumérico (máscara+minúscula na fonte)|12ABC34501DE35"
eq "A3.2 v_grupo_contatos: G4 casa SÓ U4 (AEG12345678909), não o CPF de U2" "$(Pq -c "SELECT string_agg(user_id::text, ',') FROM public.v_grupo_contatos WHERE grupo_id=$G4")" "00000000-0000-4000-8000-0000000000a4"
eq "A3.3 v_grupo_contatos: G2 (CPF 12345678909) continua SÓ U2 — U4 não vazou para cá" "$(Pq -c "SELECT string_agg(user_id::text, ',') FROM public.v_grupo_contatos WHERE grupo_id='00000000-0000-4000-8000-00000000c002'")" "00000000-0000-4000-8000-0000000000a2"
eq "A3.4 v_grupo_comercial: G3 → 1 documento com compra, 2 pedidos, 330" "$(Pq -c "SELECT documentos_com_compra||'|'||qtd_pedidos||'|'||faturamento_total FROM public.v_grupo_comercial WHERE grupo_id=$G3")" "1|2|330"
eq "A3.5 v_grupo_comercial: G4 → 1|1|400 ; G2 → 1|1|200 (separados)" "$(Pq -c "SELECT string_agg(documentos_com_compra||'|'||qtd_pedidos||'|'||faturamento_total, ' ; ' ORDER BY grupo_id) FROM public.v_grupo_comercial WHERE grupo_id IN ($G4,'00000000-0000-4000-8000-00000000c002')")" "1|1|200 ; 1|1|400"
eq "A3.6 v_grupo_contas_receber: G3 total_aberto=30 (título com máscara maiúscula na fonte)" "$(Pq -c "SELECT documentos_com_titulo||'|'||total_aberto FROM public.v_grupo_contas_receber WHERE grupo_id=$G3")" "1|30.00"
eq "A3.7 v_grupo_contas_receber: G4=40 e G2=20 — o título AEG… não soma no CPF" "$(Pq -c "SELECT string_agg(total_aberto::text, ' ; ' ORDER BY grupo_id) FROM public.v_grupo_contas_receber WHERE grupo_id IN ('00000000-0000-4000-8000-00000000c002',$G4)")" "20.00 ; 40.00"
eq "A3.8 v_grupo_contas_receber_por_doc: linha do alfanumérico" "$(Pq -c "SELECT documento||'|'||company||'|'||total_aberto FROM public.v_grupo_contas_receber_por_doc WHERE grupo_id=$G3")" "12ABC34501DE35|oben|30.00"
eq "A3.9 v_caca_compradores: U3 na oben (1 pedido, 300) e na colacor (1, 30)" "$(Pq -c "SELECT string_agg(empresa||'|'||n_pedidos||'|'||volume, ' ; ' ORDER BY empresa) FROM public.v_caca_compradores WHERE documento='12ABC34501DE35'")" "colacor|1|30 ; oben|1|300"
eq "A3.10 v_caca_compradores: AEG12345678909 e 12345678909 são linhas DISTINTAS (400 vs 200)" "$(Pq -c "SELECT string_agg(documento||'|'||volume, ' ; ' ORDER BY documento) FROM public.v_caca_compradores WHERE documento IN ('AEG12345678909','12345678909') AND empresa='oben'")" "12345678909|200 ; AEG12345678909|400"
eq "A3.11 v_caca_candidatos: U3 é candidata na colacor (última compra há 7 meses), NÃO na oben (ativa)" "$(Pq -c "SELECT string_agg(empresa_alvo, ',' ORDER BY empresa_alvo) FROM public.v_caca_candidatos WHERE documento='12ABC34501DE35'")" "colacor"
eq "A3.12 v_caca_candidatos: compra_em_outra_empresa=true para U3/colacor" "$(Pq -c "SELECT compra_em_outra_empresa FROM public.v_caca_candidatos WHERE documento='12ABC34501DE35' AND empresa_alvo='colacor'")" "t"
eq "A3.13 U6 (só coluna cnpj) continua na Caça (ramo cnpj da CASE preservado)" "$(Pq -c "SELECT count(*) FROM public.v_caca_compradores WHERE documento='98765432000100'")" "1"

# ════════════════════════════════════════════════════════
# ZONA 8 — A4: papéis reais contra as views (security_invoker + RLS + EXECUTE)
# ════════════════════════════════════════════════════════
echo "═══ A4. papéis ═══"
eq "A4.1 anon: v_grupo_contas_receber 0 linhas, SEM 42501" "$(conta "$COMO_ANON" "public.v_grupo_contas_receber")" "0"
eq "A4.2 anon: v_grupo_contatos 0 linhas" "$(conta "$COMO_ANON" "public.v_grupo_contatos")" "0"
eq "A4.3 customer sem fin_permissoes: v_grupo_contas_receber 0" "$(conta "$COMO_CUST" "public.v_grupo_contas_receber")" "0"
eq "A4.4 staff: v_grupo_contatos 4 linhas (G1, G2 só U2, G3, G4)" "$(conta "$COMO_STAFF" "public.v_grupo_contatos")" "4"
eq "A4.5 staff: v_grupo_contas_receber 4 grupos" "$(conta "$COMO_STAFF" "public.v_grupo_contas_receber")" "4"
eq "A4.6 staff: v_caca_compradores lê o alfanumérico" "$(conta "$COMO_STAFF" "public.v_caca_compradores WHERE documento='12ABC34501DE35'")" "2"
eq "A4.7 staff: v_caca_candidatos lê" "$(conta "$COMO_STAFF" "public.v_caca_candidatos WHERE documento='12ABC34501DE35'")" "1"
eq "A4.8 service_role: v_grupo_comercial 4 grupos" "$(conta "$COMO_SVC" "public.v_grupo_comercial")" "4"
eq "A4.9 staff: v_grupo_contas_receber_por_doc alfanumérico" "$(conta "$COMO_STAFF" "public.v_grupo_contas_receber_por_doc WHERE documento='12ABC34501DE35'")" "1"

# ════════════════════════════════════════════════════════
# ZONA 9 — A5: custo (informativo — a função não inlina por ter SET search_path)
# ════════════════════════════════════════════════════════
echo "═══ A5. custo em 50k linhas sintéticas ═══"
P -q -c "CREATE TABLE teste.docs AS SELECT CASE WHEN i%3=0 THEN lpad(i::text,14,'0') WHEN i%3=1 THEN '12.'||lpad((i%1000)::text,3,'0')||'.678/0001-'||lpad((i%100)::text,2,'0') ELSE lpad((i%100000000000)::text,11,'0') END AS d FROM generate_series(1,50000) i;"
T_RE="$(Pq -c "EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) SELECT sum(length(regexp_replace(d,'\D','','g'))) FROM teste.docs" | sed -nE 's/.*"Execution Time": ([0-9.]+).*/\1/p' | head -1)"
T_ND="$(Pq -c "EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) SELECT sum(length(public.normalizar_documento(d))) FROM teste.docs" | sed -nE 's/.*"Execution Time": ([0-9.]+).*/\1/p' | head -1)"
T_GD="$(Pq -c "EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) SELECT sum(length(CASE WHEN d ~ '[A-Za-z]' THEN public.normalizar_documento(d) ELSE regexp_replace(d,'\\D','','g') END)) FROM teste.docs" | sed -nE 's/.*"Execution Time": ([0-9.]+).*/\1/p' | head -1)"
echo "  ℹ️  50k linhas numéricas: regexp_replace=${T_RE} ms · normalizar_documento=${T_ND} ms · guard das views=${T_GD} ms"
eq "A5.1 o guard das views custa menos de 2x o regexp_replace puro (numérico não paga a função)" "$(Pq -c "SELECT ${T_GD:-99999} < 2 * ${T_RE:-1}")" "t"
eq "A5.2 guard ≡ normalizar_documento em todas as 50k linhas + casos com letra" "$(Pq -c "SELECT bool_and((CASE WHEN d ~ '[A-Za-z]' THEN public.normalizar_documento(d) ELSE regexp_replace(d,'\\D','','g') END) IS NOT DISTINCT FROM public.normalizar_documento(d)) FROM (SELECT d FROM teste.docs UNION ALL SELECT unnest(ARRAY['12.abc.345/01de-35','AEG12345678909','AEG12345678908','aeg-123.456.789-09','CNPJ: 12345678000190',NULL,''])) s")" "t"

# ════════════════════════════════════════════════════════
# ZONA 10 — FALSIFICAÇÃO (--falsificar): sabotar UMA camada por vez, com controle verde na MESMA invocação
# ════════════════════════════════════════════════════════
if [ "$FALSIFICAR" = 1 ]; then
  echo "═══ F. falsificação ═══"
  # cada sonda devolve VERDE/VERMELHO pela MESMA asserção funcional usada acima
  sonda_check()  { [ "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ('00000000-0000-4000-8000-00000000c001','12ABC34501DE37')")" = "23514" ] && echo VERDE || echo VERMELHO; }   # DV errado recusado
  sonda_entra()  { [ "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ('00000000-0000-4000-8000-00000000c001','12ABC34501DE35X')")" = "23514" ] && [ "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ('00000000-0000-4000-8000-00000000c001','AB2ABC34501DE2')")" = "23514" ] && echo VERDE || echo VERMELHO; }
  sonda_alnum()  { [ "$(estado "$COMO_STAFF" "INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ('00000000-0000-4000-8000-00000000c001','12ABC34501DE35')")" = "23505" ] && echo VERDE || echo VERMELHO; }   # 23505 = passou no CHECK e bateu no UNIQUE
  sonda_cont()   { [ "$(Pq -c "SELECT count(*) FROM public.v_grupo_contatos WHERE grupo_id=$G3")" = "1" ] && echo VERDE || echo VERMELHO; }
  sonda_caca()   { [ "$(Pq -c "SELECT count(*) FROM public.v_caca_compradores WHERE documento='12ABC34501DE35'")" = "2" ] && echo VERDE || echo VERMELHO; }
  sonda_grant()  { [ "$(estado "$COMO_STAFF" "SELECT count(*) FROM public.v_grupo_contatos")" = "OK" ] && echo VERDE || echo VERMELHO; }
  # o CHECK só pode ser restaurado EXPLICITAMENTE: a PRE da migration recusa (certo) um CHECK que não é o antigo nem o dela
  RESTAURA_CHECK="ALTER TABLE public.cliente_grupo_membros DROP CONSTRAINT IF EXISTS cliente_grupo_membros_documento_digits; ALTER TABLE public.cliente_grupo_membros DROP CONSTRAINT IF EXISTS cliente_grupo_membros_documento_formato; ALTER TABLE public.cliente_grupo_membros ADD CONSTRAINT cliente_grupo_membros_documento_formato CHECK (documento ~ '^[0-9]{11}$' OR documento ~ '^[0-9]{14}$' OR public.cnpj_alfanumerico_valido(documento));"
  rodada() { # $1 nome · $2 sonda · $3 sabotagem SQL · $4 restauração (comando shell) — cada rodada termina com a migration re-aplicada LIMPA
    local antes; antes="$($2)"
    if [ "$antes" != "VERDE" ]; then SAB_F=$((SAB_F+1)); bad "$1: CONTROLE já estava $antes — sabotagem não prova nada"; return; fi
    P -q -c "$3" >"$TMPD/sab.log" 2>&1 || { SAB_F=$((SAB_F+1)); bad "$1: a SABOTAGEM não aplicou: $(tail -1 "$TMPD/sab.log" | cut -c1-140)"; return; }
    local durante; durante="$($2)"
    eval "$4" >"$TMPD/rest.log" 2>&1 || true
    if ! PM -q -f "$MIG" >"$TMPD/rest2.log" 2>&1; then SAB_F=$((SAB_F+1)); bad "$1: migration NÃO re-aplica após restaurar: $(grep -m1 ERROR "$TMPD/rest2.log" | cut -c1-160)"; return; fi
    local depois; depois="$($2)"
    if [ "$durante" = "VERMELHO" ] && [ "$depois" = "VERDE" ]; then SAB_V=$((SAB_V+1)); ok "$1: controle VERDE → sabotado VERMELHO → restaurado VERDE"; else SAB_F=$((SAB_F+1)); bad "$1: controle=$antes sabotado=$durante restaurado=$depois (a sonda não alcança a camada) · rest: $(grep -m1 ERROR "$TMPD/rest.log" | cut -c1-120)"; fi
  }
  rodada "F1 CHECK antigo (só-dígitos) de volta → alfanumérico barrado" sonda_alnum \
    "ALTER TABLE public.cliente_grupo_membros DROP CONSTRAINT cliente_grupo_membros_documento_formato; ALTER TABLE public.cliente_grupo_membros ADD CONSTRAINT cliente_grupo_membros_documento_digits CHECK (documento ~ '^[0-9]+$' AND char_length(documento) IN (11,14)) NOT VALID;" \
    "P -q -c \"$RESTAURA_CHECK\""
  rodada "F2 v_grupo_contatos predecessora (regexp_replace) → alnum não casa" sonda_cont \
    "CREATE OR REPLACE VIEW public.v_grupo_contatos WITH (security_invoker = true) AS $(sed -n '/^CREATE OR REPLACE VIEW public.v_grupo_contatos /,/;$/p' "$FIX" | sed '1d')" \
    "PM -q -f '$MIG'"
  rodada "F3 REVOKE EXECUTE do helper a authenticated → staff recebe 42501 na view" sonda_grant \
    "REVOKE EXECUTE ON FUNCTION public.normalizar_documento(text) FROM authenticated;" \
    "PM -q -f '$MIG'"
  rodada "F4 DV removido do validador (só formato) → DV errado ENTRA" sonda_check \
    "CREATE OR REPLACE FUNCTION public.cnpj_alfanumerico_valido(p_doc text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS \$s\$ SELECT p_doc ~ '^[0-9A-Z]{12}[0-9]{2}\$' \$s\$;" \
    "PGOPTIONS='-c search_path=public,pg_catalog' P -q -f '$FIX'; PM -q -f '$MIG'"
  # F4b: com o helper sabotado a PRE da migration tem de ABORTAR (deriva de prosrc) — e não aprovar
  P -q -c "CREATE OR REPLACE FUNCTION public.cnpj_alfanumerico_valido(p_doc text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS \$s\$ SELECT p_doc ~ '^[0-9A-Z]{12}[0-9]{2}\$' \$s\$;" >/dev/null
  if PM -q -f "$MIG" >"$TMPD/mig-f4.log" 2>&1; then SAB_F=$((SAB_F+1)); bad "F4b a migration APROVOU com o helper derivado"; else
    if grep -q "PRE FALHOU: public.cnpj_alfanumerico_valido(text) deriva" "$TMPD/mig-f4.log"; then SAB_V=$((SAB_V+1)); ok "F4b PRE abortou pela deriva do helper (md5 prosrc)"; else SAB_F=$((SAB_F+1)); bad "F4b abortou por outro motivo: $(tail -2 "$TMPD/mig-f4.log" | cut -c1-160)"; fi
  fi
  PGOPTIONS="-c search_path=public,pg_catalog" P -q -f "$FIX" >/dev/null; PM -q -f "$MIG" >"$TMPD/f4c.log" 2>&1 || bad "F4c migration não re-aplicou: $(grep -m1 ERROR "$TMPD/f4c.log" | cut -c1-140)"
  eq "F4c restaurado: helper = prod e migration vale de novo" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.cnpj_alfanumerico_valido(text)'::regprocedure")" "b27b482a550084775b12ef78f03e29c4"
  rodada "F5 v_caca_compradores predecessora → alnum some da Caça" sonda_caca \
    "CREATE OR REPLACE VIEW public.v_caca_compradores WITH (security_invoker = on) AS $(sed -n '/^CREATE OR REPLACE VIEW public.v_caca_compradores /,/;$/p' "$FIX" | sed '1d')" \
    "PM -q -f '$MIG'"
  rodada "F6 formato aceito sem exigir 14 posições → lixo alfanumérico entra" sonda_entra \
    "ALTER TABLE public.cliente_grupo_membros DROP CONSTRAINT cliente_grupo_membros_documento_formato; ALTER TABLE public.cliente_grupo_membros ADD CONSTRAINT cliente_grupo_membros_documento_formato CHECK (documento ~ '^[0-9A-Z]+$');" \
    "P -q -c \"$RESTAURA_CHECK\""
fi

echo "═══ resultado: $PASS ok · $FAIL falhas ═══"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FALSIFICAR" = 1 ] && echo "SABOTAGENS: $SAB_V vermelhas / $SAB_F falhas"   # recibo exigido por db/roda-nucleo-ci.sh (só no modo --falsificar)
[ "$FAIL" -eq 0 ] && echo "HARNESS_GRUPOS_CACA_ALNUM_FIM_OK" || { echo "HARNESS_GRUPOS_CACA_ALNUM_FIM_FALHOU"; exit 1; }
