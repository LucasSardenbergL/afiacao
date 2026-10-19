#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Radar: CNPJ ALFANUMÉRICO (migration 20261019110000_radar_cnpj_alfanumerico)  ║
# ║   bash db/test-radar-cnpj-alfanumerico.sh                 (controle)                        ║
# ║   bash db/test-radar-cnpj-alfanumerico.sh --falsificar    (controle + sabotagens em espelho) ║
# ║                                                                                              ║
# ║  Mundo: stubs de prod + 20260610200000_radar_fundacao (função PREDECESSORA: a PRE da migration ║
# ║  exige md5(prosrc) = o de PROD, lido por psql-ro em 2026-10-19 — se o repo divergir de prod,  ║
# ║  a prova fica vermelha aqui, não na mão do founder) → a migration sob prova → asserts:        ║
# ║   A0 aplica; re-aplicar é no-op (PRE aceita "este"; CHECK não é recriado)                     ║
# ║   A1 CHECK: alfanumérico maiúsculo entra; minúscula, 13 posições, DV com letra → 23514        ║
# ║      (radar_empresas E radar_contatos)                                                        ║
# ║   A2 recruza: numérico com máscara / cru / com prefixo de letras (acervo) + alfanumérico       ║
# ║      minúsculo com máscara (profiles) + alfanumérico cru (omie) marcam; lead livre e           ║
# ║      "anotação + CPF" (AEG12345678909) não — letra nunca é apagada do documento              ║
# ║   A3 ACL: anon/authenticated sem EXECUTE; service_role com                                    ║
# ║  FALSIFICAÇÃO (espelhos em tmpdir, após CONTROLE verde na MESMA invocação; uma camada por vez):║
# ║   F1 CHECK afrouxado p/ minúscula → A1 vermelho                                               ║
# ║   F2 sem upper() no doc (md5 neutralizado) → A2 vermelho (minúsculo com máscara não marca)    ║
# ║   F3 caminho alnum vira só-dígitos (md5 neutralizado) → A2 vermelho (alfanumérico não marca) ║
# ║   F4 corpo sabotado SEM neutralizar o md5 → A0 vermelho (a PÓS morde)                         ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."

MODO="${1:-}"
PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado — brew install postgresql@17"; exit 1; }
DB_DIR="$(mktemp -d "/tmp/pgtest-radar-alnum.XXXXXX")"; PORT="${PGPORT_TEST:-55437}"
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
MIG="supabase/migrations/20261019110000_radar_cnpj_alfanumerico.sql"
FUND="supabase/migrations/20260610200000_radar_fundacao.sql"
MD5_PROD="27ccab8ed049e4403a9e4232507915a4"   # md5(prosrc) de radar_recruzar_ja_cliente() em PROD, psql-ro 2026-10-19

P()  { "$PGBIN/psql" -X -h "$DB_DIR" -p "$PORT" -U postgres -d prova -v ON_ERROR_STOP=1 -q "$@"; }
Pq() { P -tA "$@"; }
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# SQLSTATE esperado de um INSERT que deve falhar: 23514 = check_violation. Qualquer outro desfecho
# (sucesso, FK 23503, erro de sintaxe) é vermelho — "falhou com algo" não prova o CHECK.
sqlstate_de() { P -c "$1" 2>&1 >/dev/null | grep -oE 'SQLSTATE[^)]*|ERROR:.*' | head -1; }

# Mundo novo por rodada: DROP/CREATE DATABASE, stubs, fundação, seeds de cliente.
preparar_mundo() {
  "$PGBIN/psql" -X -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS prova" -c "CREATE DATABASE prova"
  P <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, document text);
CREATE TABLE public.omie_clientes_nao_vinculados (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj_cpf text);
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
SQL
  P -f "$FUND" >/dev/null
  P <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
-- Documentos de cliente como humanos/ERP os gravam:
INSERT INTO public.profiles VALUES
  ('00000000-0000-0000-0000-000000000001', '11.222.333/0001-81'),        -- numérico com máscara (acervo)
  ('00000000-0000-0000-0000-000000000002', 'CNPJ: 22.333.444/0001-81'),  -- numérico com PREFIXO de letras (acervo: só-dígitos casa)
  ('00000000-0000-0000-0000-000000000003', '12.abc.345/01de-35'),        -- alfanumérico MINÚSCULO com máscara (exemplo oficial RFB)
  ('00000000-0000-0000-0000-000000000004', 'aeg 123.456.789-09');       -- CPF com ANOTAÇÃO (contraexemplo Codex): NÃO pode virar chave AEG12345678909
INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf) VALUES
  ('55666777000181'),   -- numérico cru (acervo)
  ('A1B2C3D4E5F668');   -- alfanumérico cru maiúsculo
SQL
}

# Roda as asserções contra UMA migration (a real ou um espelho sabotado), em mundo novo.
provar() {
  local mig="$1"
  preparar_mundo
  eq "A0 predecessor local = PROD (md5 prosrc)" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.radar_recruzar_ja_cliente()')")" "$MD5_PROD"
  if P -f "$mig" >"$DB_DIR/apply.log" 2>&1; then ok "A0 migration aplica"; else bad "A0 migration abortou: $(grep -m1 -E 'ERROR|ERRO' "$DB_DIR/apply.log" | cut -c1-160)"; fi
  if P -f "$mig" >"$DB_DIR/apply2.log" 2>&1; then ok "A0 re-aplicar é no-op (PRE aceita 'este')"; else bad "A0 re-aplicar abortou: $(grep -m1 -E 'ERROR|ERRO' "$DB_DIR/apply2.log" | cut -c1-160)"; fi
  eq "A0 CHECK de radar_empresas é o alfanumérico" "$(Pq -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.radar_empresas'::regclass AND conname='radar_empresas_cnpj_check'")" "CHECK ((cnpj ~ '^[0-9A-Z]{12}[0-9]{2}\$'::text))"

  echo "── A1 CHECK"
  if P -c "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social) VALUES ('12ABC34501DE35','3101200','2026-10','ALNUM OK')" >/dev/null 2>&1; then ok "A1 alfanumérico maiúsculo entra"; else bad "A1 alfanumérico maiúsculo rejeitado"; fi
  eq "A1 minúscula → 23514" "$(sqlstate_de "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('12abc34501DE35','3101200','2026-10')" | grep -o 'violates check constraint "radar_empresas_cnpj_check"' || true)" 'violates check constraint "radar_empresas_cnpj_check"'
  eq "A1 13 posições → 23514" "$(sqlstate_de "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('12ABC34501DE3','3101200','2026-10')" | grep -o 'violates check constraint "radar_empresas_cnpj_check"' || true)" 'violates check constraint "radar_empresas_cnpj_check"'
  eq "A1 DV com letra → 23514" "$(sqlstate_de "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('12ABC34501DE3A','3101200','2026-10')" | grep -o 'violates check constraint "radar_empresas_cnpj_check"' || true)" 'violates check constraint "radar_empresas_cnpj_check"'
  eq "A1 radar_contatos: minúscula → CHECK próprio (antes da FK)" "$(sqlstate_de "INSERT INTO public.radar_contatos (cnpj, acao, criado_por) VALUES ('12abc34501DE35','a_contatar','00000000-0000-0000-0000-00000000aaaa')" | grep -o 'violates check constraint "radar_contatos_cnpj_check"' || true)" 'violates check constraint "radar_contatos_cnpj_check"'
  if P -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por) VALUES ('12ABC34501DE35','a_contatar','00000000-0000-0000-0000-00000000aaaa')" >/dev/null 2>&1; then ok "A1 radar_contatos aceita alfanumérico do pai"; else bad "A1 radar_contatos rejeitou alfanumérico válido"; fi

  echo "── A2 recruza"
  P -c "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social) VALUES
    ('11222333000181','3101200','2026-10','NUM VIA PROFILE MASCARA'),
    ('22333444000181','3101200','2026-10','NUM VIA PROFILE COM PREFIXO'),
    ('55666777000181','3101200','2026-10','NUM VIA OMIE CRU'),
    ('A1B2C3D4E5F668','3101200','2026-10','ALNUM VIA OMIE CRU'),
    ('99888777000100','3101200','2026-10','LEAD LIVRE'),
    ('AEG12345678909','3101200','2026-10','LEAD QUE COINCIDE COM ANOTACAO+CPF')" >/dev/null
  eq "A2 marcados (5 clientes; 12ABC34501DE35 já está no radar via A1)" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente()")" "5"
  eq "A2 numérico com máscara marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='11222333000181'")" "t"
  eq "A2 numérico com prefixo de letras marcou (acervo intocado)" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='22333444000181'")" "t"
  eq "A2 numérico cru (omie) marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='55666777000181'")" "t"
  eq "A2 alfanumérico MINÚSCULO com máscara (profile) marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='12ABC34501DE35'")" "t"
  eq "A2 alfanumérico cru (omie) marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='A1B2C3D4E5F668'")" "t"
  eq "A2 lead livre NÃO marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='99888777000100'")" "f"
  eq "A2 anotação+CPF NÃO vira chave alfanumérica (letra nunca é apagada)" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='AEG12345678909'")" "f"
  eq "A2 2ª passada marca 0 (idempotente)" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente()")" "0"

  echo "── A3 ACL"
  eq "A3 anon sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('anon','public.radar_recruzar_ja_cliente()','EXECUTE')")" "f"
  eq "A3 authenticated sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('authenticated','public.radar_recruzar_ja_cliente()','EXECUTE')")" "f"
  eq "A3 PUBLIC sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('public','public.radar_recruzar_ja_cliente()','EXECUTE')")" "f"
  eq "A3 service_role com EXECUTE" "$(Pq -c "SELECT has_function_privilege('service_role','public.radar_recruzar_ja_cliente()','EXECUTE')")" "t"
}

echo "═══ CONTROLE — migration real"
provar "$MIG"
CONTROLE_FAIL=$FAIL
[ "$CONTROLE_FAIL" -eq 0 ] || { echo "PASS=$PASS  FAIL=$FAIL"; echo "controle vermelho — falsificação não roda"; exit 1; }

if [ "$MODO" = "--falsificar" ]; then
  echo "═══ FALSIFICAÇÃO (espelhos em $DB_DIR; supabase/migrations/ intocado)"
  TOTAL=0; FALHAS=0
  # Neutraliza a régua de md5 da PRE/PÓS: o literal 'este' vira o próprio md5 vivo — assim a
  # sabotagem SEMÂNTICA chega aos asserts em vez de morrer na PÓS (que F4 prova separadamente).
  ESTE_MD5="$(grep -oE "IS DISTINCT FROM '[0-9a-f]{32}'" "$MIG" | grep -oE '[0-9a-f]{32}' | head -1)"
  NEUTRO="s/'$ESTE_MD5'/(SELECT md5(q.prosrc) FROM pg_catalog.pg_proc q WHERE q.oid = to_regprocedure('public.radar_recruzar_ja_cliente()'))/g"
  falsificar() {
    local nome="$1" sed_expr="$2" espelho="$DB_DIR/$1.sql" antes_pass=$PASS antes_fail=$FAIL
    TOTAL=$((TOTAL+1))
    sed -E "$sed_expr" "$MIG" > "$espelho"
    if cmp -s "$MIG" "$espelho"; then bad "$nome: sed não alterou nada (sabotagem vazia)"; FALHAS=$((FALHAS+1)); return; fi
    provar "$espelho" >"$DB_DIR/$nome.log" 2>&1 || true
    local novos_fail=$((FAIL - antes_fail))
    PASS=$antes_pass; FAIL=$antes_fail
    if [ "$novos_fail" -gt 0 ]; then ok "$nome ficou VERMELHO ($novos_fail assert(s)): $(grep -m1 '❌' "$DB_DIR/$nome.log" | cut -c1-110)"; else bad "$nome passou VERDE — a prova não morde"; FALHAS=$((FALHAS+1)); fi
  }
  falsificar F1-check-aceita-minuscula 's/(cnpj ~ '\'''\''?)\^\[0-9A-Z\]\{12\}/\1^[0-9A-Za-z]{12}/g'
  falsificar F2-sem-upper "s/upper\(bruto\)/bruto/; $NEUTRO"
  falsificar F3-alnum-vira-so-digitos "s/'\[-\.\/\]'/'[^0-9]'/; $NEUTRO"
  falsificar F4-corpo-sabotado-md5-intacto 's/upper\(bruto\)/bruto/'
  echo "SABOTAGENS: $((TOTAL - FALHAS)) vermelhas / $FALHAS falhas"
fi

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-radar-cnpj-alfanumerico: todos os asserts passaram"
[ "$FAIL" -eq 0 ]
