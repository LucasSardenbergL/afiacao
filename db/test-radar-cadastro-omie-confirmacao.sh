#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Radar: `radar_registrar_cadastro_omie` só marca `ja_cliente` com CONFIRMAÇÃO    ║
# ║  DO SERVIDOR (migration 20261021120000 — achado ALTO preexistente do Codex, 2026-10-20)         ║
# ║   bash db/test-radar-cadastro-omie-confirmacao.sh               (controle)                      ║
# ║   bash db/test-radar-cadastro-omie-confirmacao.sh --falsificar  (controle + sabotagens)         ║
# ║                                                                                                ║
# ║  Mundo: stubs de prod (radar_*, tarefas, gate de gestor, default privileges de prod: arwdDxtm a  ║
# ║  anon/authenticated/service_role, INSERT ao sandbox_exec, SELECT ao claude_ro) → predecessoras   ║
# ║  reais até a 20261019225545 (md5 = PROD, psql-ro 2026-10-21) → esta migration.                 ║
# ║   A0  PRE recusa ledger preexistente na 1ª instalação · aplica · no-op · atributos             ║
# ║   A1  sem confirmação / código nulo, vazio, divergente / documento divergente → RAISE           ║
# ║       'RADAR_SEM_CONFIRMACAO_OMIE' e NADA muda; confirmação válida → vira cliente; repetição    ║
# ║       dedupa; a nota vem do ledger (o p_ja_existia do front não decide); zero à esquerda        ║
# ║   A2  ledger append-only: authenticated/anon/sandbox_exec não escrevem; service_role só INSERT  ║
# ║       (UPDATE/DELETE/TRUNCATE negados); CHECK barra conta ≠ oben e CPF                          ║
# ║   A3  gate de gestor na frente; ACL da função                                                   ║
# ║   A4  re-aplicação: forma divergente ABORTA; privilégio a mais é REPARADO                       ║
# ║   A6  anti-deriva de atributo do predecessor (PRE/TRAVA)                                        ║
# ║  FALSIFICAÇÃO: uma camada por vez; a régua de md5 "este" é neutralizada nas sabotagens          ║
# ║  SEMÂNTICAS (senão todo mutante morreria na PÓS sem exercitar o assert funcional).              ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261021120000_radar_cadastro_omie_confirmacao_servidor.sql"
ALNUM="$REPO_ROOT/supabase/migrations/20261019225545_radar_rpcs_cnpj_alfanumerico.sql"
CONTATO="$REPO_ROOT/supabase/migrations/20260612130000_radar_rpcs_contato.sql"
FATIA3="$REPO_ROOT/supabase/migrations/20260613190000_radar_fatia3.sql"
HOJE_SP="$REPO_ROOT/supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql"
MD5_PROD_CADASTRO="46717b268a9c44abaf09024de816c72b"   # psql-ro 2026-10-21 (= "este" da 20261019225545)

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="sem_exigencia:A1a sem_filtro_codigo:A1d sem_filtro_documento:A1e nota_do_front:A1h sem_idempotencia:A1g acl_sem_revoke_loop:A0a pre_adota_tabela:A0q pos_sem_forma:A4a corpo_sabotado_md5:A0a pre_sem_atributos:A6a trava_sem_volatilidade:A6c"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-cadastro-conf.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
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
    if grep -q "^FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho: $(grep -m1 "^FAIL $a " "$LOGDIR/$s.log" | cut -c1-120)"
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
PORT="${PGPORT_TEST:-5513}"
TMPD="$(mktemp -d "/tmp/pgtest-radar-cadastro-conf.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
MIG_USADA="$TMPD/mig.sql"
TAREFA_VIVA="$TMPD/tarefa-viva.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

for f in "$MIG" "$ALNUM" "$CONTATO" "$FATIA3" "$HOJE_SP"; do [ -f "$f" ] || { echo "migration nao encontrada: $f"; exit 1; }; done
cp "$MIG" "$MIG_USADA"
python3 -I - "$HOJE_SP" "$TAREFA_VIVA" <<'PY'
import sys
src, dst = sys.argv[1:]
s = open(src, encoding="utf-8").read()
ini = s.index("CREATE OR REPLACE FUNCTION public.radar_atribuir_tarefa(")
fim = s.index("$function$;", ini) + len("$function$;")
open(dst, "w", encoding="utf-8").write(s[ini:fim] + "\n")
PY

# sabotar ARQ DE PARA: troca literal (o padrão TEM de existir).
sabotar() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
s = s.replace(de, para)
open(p, "w", encoding="utf-8").write(s)
PY
}
ESTE="$(grep -oE "'[0-9a-f]{32}' /\* este:radar_registrar_cadastro_omie \*/" "$MIG" | grep -oE '[0-9a-f]{32}' | head -1)"
neutralizar() {
  sabotar "$MIG_USADA" "'$ESTE' /* este:radar_registrar_cadastro_omie */" "(SELECT md5(q.prosrc) FROM pg_catalog.pg_proc q WHERE q.oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)'))"
}
EXIGE_POS="IF position('FROM public.omie_cliente_confirmacoes c' IN r.prosrc) = 0
     OR position('IF v_criado_por_nos IS NULL THEN' IN r.prosrc) = 0 THEN"
case "${SABOTAGEM:-}" in
  "") ;;
  sem_exigencia)        sabotar "$MIG_USADA" "  IF v_criado_por_nos IS NULL THEN
    RAISE" "  IF false THEN
    RAISE"
                        sabotar "$MIG_USADA" "$EXIGE_POS" "IF false THEN"; neutralizar ;;
  sem_filtro_codigo)    sabotar "$MIG_USADA" " AND c.codigo_cliente = v_codigo;" ";"; neutralizar ;;
  sem_filtro_documento) sabotar "$MIG_USADA" " AND c.documento = p_cnpj" ""; neutralizar ;;
  nota_do_front)        sabotar "$MIG_USADA" "CASE WHEN v_criado_por_nos" "CASE WHEN NOT p_ja_existia"; neutralizar ;;
  sem_idempotencia)     sabotar "$MIG_USADA" "IF v_ja_cliente AND v_codigo_atual = v_codigo AND v_status_atual = 'virou_cliente' THEN" "IF false THEN"; neutralizar ;;
  acl_sem_revoke_loop)  sabotar "$MIG_USADA" "    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.omie_cliente_confirmacoes FROM %s', r.papel);" "    NULL;" ;;
  pre_adota_tabela)     sabotar "$MIG_USADA" "IF v_vivo = '$MD5_PROD_CADASTRO' AND to_regclass('public.omie_cliente_confirmacoes') IS NOT NULL THEN" "IF false THEN" ;;
  pos_sem_forma)        sabotar "$MIG_USADA" "     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = v_tab) THEN
    RAISE EXCEPTION 'POS FALHOU: omie_cliente_confirmacoes não tem a forma revisada" "     OR true IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: omie_cliente_confirmacoes não tem a forma revisada"
                        sabotar "$MIG_USADA" "  IF (SELECT string_agg(a.attname" "  IF false AND (SELECT string_agg(a.attname" ;;
  corpo_sabotado_md5)   sabotar "$MIG_USADA" "'empresa não encontrada: %', p_cnpj; END IF;

  -- Ausente" "'empresa nao encontrada: %', p_cnpj; END IF;

  -- Ausente" ;;
  pre_sem_atributos)    sabotar "$MIG_USADA" "IF NOT v_secdef OR v_config IS DISTINCT FROM ARRAY['search_path=public'] THEN" "IF false THEN" ;;
  trava_sem_volatilidade) sabotar "$MIG_USADA" "IF v_vol <> 'v' THEN" "IF false THEN" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prova
P()  { "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d prova -v ON_ERROR_STOP=1 -q "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1 $2"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1 $2"; }
eq()  { if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi; }
GESTOR='00000000-0000-0000-0000-0000000000a1'
VENDEDOR='00000000-0000-0000-0000-0000000000b2'
# chamada UID 'SELECT public.rpc(...)' → MARCADOR: PASSOU · SEM_CONFIRMACAO · GUARD · FORBIDDEN · NAO_ENCONTRADA.
# Qualquer OUTRO erro relança (WHEN OTHERS 'OK' é teatro).
chamada() {
  Pq -c "SET test.uid = '$1'; DELETE FROM public.test_res;
DO \$x\$ BEGIN
  PERFORM $2;
  INSERT INTO public.test_res VALUES ('PASSOU');
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'RADAR_SEM_CONFIRMACAO_OMIE:%' THEN INSERT INTO public.test_res VALUES ('SEM_CONFIRMACAO');
  ELSIF SQLERRM = 'cnpj inválido' THEN INSERT INTO public.test_res VALUES ('GUARD');
  ELSIF SQLERRM LIKE 'empresa não encontrada%' THEN INSERT INTO public.test_res VALUES ('NAO_ENCONTRADA');
  ELSIF SQLERRM LIKE 'forbidden%' THEN INSERT INTO public.test_res VALUES ('FORBIDDEN');
  ELSE RAISE; END IF;
END \$x\$;
SELECT k FROM public.test_res;"
}
# como PAPEL 'SQL' → OK · NEGADO (só SQLSTATE 42501) · CHECK (só 23514). Outro erro relança.
como() {
  Pq -c "DELETE FROM public.test_res;
SET ROLE $1;
DO \$x\$ BEGIN
  $2;
  INSERT INTO public.test_res VALUES ('OK');
EXCEPTION WHEN insufficient_privilege THEN INSERT INTO public.test_res VALUES ('NEGADO');
          WHEN check_violation THEN INSERT INTO public.test_res VALUES ('CHECK');
END \$x\$;
RESET ROLE;
SELECT k FROM public.test_res;"
}
md5_de() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.$1')"; }
empresa() { Pq -c "SELECT ja_cliente||'/'||COALESCE(omie_codigo_cliente,'∅')||'/'||prospeccao_status||'/'||(SELECT count(*) FROM public.radar_contatos k WHERE k.cnpj=e.cnpj AND k.acao='virou_cliente') FROM public.radar_empresas e WHERE cnpj='$1'"; }
confirma() { # documento codigo origem — grava como o service_role (o escritor de prod)
  Pq -c "SET ROLE service_role; INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','$1','$2','$3'); RESET ROLE;" >/dev/null
}

P <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN CREATE ROLE sandbox_exec NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claude_ro') THEN CREATE ROLE claude_ro NOLOGIN; END IF;
END $$;
-- Default privileges de PROD (pg_default_acl do postgres em public, psql-ro 2026-10-21).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO sandbox_exec;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social text, nome_fantasia text,
  cnae_principal text NOT NULL,
  data_abertura date,
  municipio_codigo text, municipio_nome text, uf text,
  telefone1 text, telefone2 text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  prospeccao_atualizado_em timestamptz, descarte_motivo text,
  ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL,
  omie_codigo_cliente text, omie_cadastrado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_municipios (
  codigo text PRIMARY KEY, nome text NOT NULL, uf text NOT NULL,
  lat double precision, lng double precision);
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'), acao text NOT NULL, nota text,
  criado_por uuid NOT NULL, status_anterior text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY, status text NOT NULL, novos integer);
CREATE TABLE public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  descricao text NOT NULL, categoria text NOT NULL, customer_user_id uuid,
  assigned_to uuid NOT NULL, created_by uuid NOT NULL, empresa text NOT NULL,
  modo text NOT NULL, due_date date, interacao_tipo text,
  auto_satisfy_mode text NOT NULL DEFAULT 'off', status text NOT NULL DEFAULT 'aberta',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE TABLE public.test_res (k text);
GRANT ALL ON public.test_res TO PUBLIC;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role, sandbox_exec, claude_ro;
SQL
P -f "$CONTATO" >/dev/null
P -f "$FATIA3" >/dev/null
P -f "$TAREFA_VIVA" >/dev/null
P <<'SQL'
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_atribuir_tarefa(text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) TO service_role;
SQL
P -f "$ALNUM" >/dev/null
P <<'SQL'
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, prospeccao_status) VALUES
  ('12ABC34501DE35', 'ALFANUMERICA LTDA', '3101200', '2026-10', 'em_conversa'),
  ('00123456000191', 'ZERO A ESQUERDA LTDA', '3101200', '2026-10', 'a_contatar'),
  ('11111111000111', 'NUMERICA LTDA', '3101200', '2026-10', 'a_contatar');
SQL

echo "── A0 aplicação"
eq A0p "predecessor radar_registrar_cadastro_omie (20261019225545) = PROD" "$(md5_de 'radar_registrar_cadastro_omie(text,text,boolean)')" "$MD5_PROD_CADASTRO"
# 1ª instalação com um ledger de procedência desconhecida já criado → PRE aborta e nada muda.
P -c "CREATE TABLE public.omie_cliente_confirmacoes (id int)"
if P -f "$MIG_USADA" > "$TMPD/pre.log" 2>&1; then bad A0q "PRE ADOTOU ledger preexistente na 1ª instalação";
elif grep -q "PRE FALHOU: omie_cliente_confirmacoes já existe antes da 1ª instalação" "$TMPD/pre.log"; then ok A0q "PRE recusa ledger preexistente na 1ª instalação";
else bad A0q "abortou fora do esperado: $(grep -m1 ERROR "$TMPD/pre.log" | cut -c1-140)"; fi
P -c "DROP TABLE public.omie_cliente_confirmacoes"
eq A0q2 "o aborto não mexeu na RPC (segue o predecessor)" "$(md5_de 'radar_registrar_cadastro_omie(text,text,boolean)')" "$MD5_PROD_CADASTRO"
if P -f "$MIG_USADA" >"$TMPD/apply.log" 2>&1; then ok A0a "migration aplica (TRAVA → PRE → CREATE → PÓS)"; else bad A0a "migration abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply.log" | cut -c1-200)"; fi
if P -f "$MIG_USADA" >"$TMPD/apply2.log" 2>&1; then ok A0b "re-aplicar é no-op (PRE aceita 'este')"; else bad A0b "re-aplicar abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply2.log" | cut -c1-200)"; fi
eq A0c "RPC segue SECURITY DEFINER + search_path=public + VOLATILE" \
  "$(Pq -c "SELECT prosecdef||':'||proconfig[1]||':'||provolatile::text FROM pg_proc WHERE oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)')")" "true:search_path=public:v"
eq A0d "ledger com RLS ligada" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.omie_cliente_confirmacoes'::regclass")" "t"

echo "── A1 confirmação do servidor"
eq A1a "SEM confirmação → RAISE RADAR_SEM_CONFIRMACAO_OMIE" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('12ABC34501DE35','4242',false)")" "SEM_CONFIRMACAO"
eq A1a2 "e o lead fica na fila (nada muda)" "$(empresa 12ABC34501DE35)" "false/∅/em_conversa/0"
eq A1b "código NULL → RAISE" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('12ABC34501DE35',NULL,false)")" "SEM_CONFIRMACAO"
eq A1b2 "código vazio → RAISE" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('12ABC34501DE35','  ',false)")" "SEM_CONFIRMACAO"
confirma 12ABC34501DE35 4242 incluir
confirma 11111111000111 5151 lookup
eq A1d "confirmação de OUTRO código → RAISE" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('12ABC34501DE35','9999',false)")" "SEM_CONFIRMACAO"
eq A1e "código confirmado para OUTRO documento → RAISE" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('12ABC34501DE35','5151',true)")" "SEM_CONFIRMACAO"
eq A1e2 "após as recusas o lead segue intocado" "$(empresa 12ABC34501DE35)" "false/∅/em_conversa/0"
eq A1f "confirmação válida (oben + CNPJ + código) → vira cliente" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('12ABC34501DE35',' 4242 ',true)")" "PASSOU"
eq A1f2 "ja_cliente, código (sem espaço), status e 1 contato" "$(empresa 12ABC34501DE35)" "true/4242/virou_cliente/1"
eq A1h "nota vem do LEDGER ('incluir' → Cadastrado), não do p_ja_existia=true do front" \
  "$(Pq -c "SELECT nota FROM public.radar_contatos WHERE cnpj='12ABC34501DE35' AND acao='virou_cliente'")" "Cadastrado no Omie/Oben (cód. 4242)"
eq A1g "repetição com o mesmo código → deduped, sem novo contato" \
  "$(Pq -c "SET test.uid='$GESTOR'; SELECT (public.radar_registrar_cadastro_omie('12ABC34501DE35','4242',false))->>'deduped'")/$(empresa 12ABC34501DE35)" "true/true/4242/virou_cliente/1"
confirma 00123456000191 77 lookup
eq A1i "CNPJ com zero à esquerda + só lookup → vira cliente" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('00123456000191','77',false)")" "PASSOU"
eq A1i2 "nota 'Já cadastrado' (lookup), com o p_ja_existia=false do front ignorado" \
  "$(Pq -c "SELECT nota FROM public.radar_contatos WHERE cnpj='00123456000191' AND acao='virou_cliente'")" "Já cadastrado no Omie/Oben (cód. 77)"
eq A1j "documento sem os zeros à esquerda NÃO casa" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('11111111000111','77',false)")" "SEM_CONFIRMACAO"

echo "── A2 ledger append-only"
eq A2a "authenticated não INSERE" "$(como authenticated "INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','11111111000111','1','incluir')")" "NEGADO"
eq A2b "anon não INSERE" "$(como anon "INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','11111111000111','1','incluir')")" "NEGADO"
eq A2c "authenticated não LÊ" "$(como authenticated "PERFORM count(*) FROM public.omie_cliente_confirmacoes")" "NEGADO"
eq A2d "sandbox_exec (default 'ar') não INSERE" "$(como sandbox_exec "INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','11111111000111','1','incluir')")" "NEGADO"
eq A2e "claude_ro segue lendo (sentinela '0 objetos sem SELECT')" "$(como claude_ro "PERFORM count(*) FROM public.omie_cliente_confirmacoes")" "OK"
eq A2f "service_role não faz UPDATE" "$(como service_role "UPDATE public.omie_cliente_confirmacoes SET codigo_cliente='1'")" "NEGADO"
eq A2g "service_role não faz DELETE" "$(como service_role "DELETE FROM public.omie_cliente_confirmacoes")" "NEGADO"
eq A2h "service_role não faz TRUNCATE" "$(como service_role "TRUNCATE public.omie_cliente_confirmacoes")" "NEGADO"
eq A2i "CHECK barra conta ≠ oben" "$(como service_role "INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('colacor','11111111000111','1','incluir')")" "CHECK"
eq A2j "CHECK barra CPF (11 dígitos)" "$(como service_role "INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','12345678909','1','incluir')")" "CHECK"
eq A2k "CHECK barra código não numérico" "$(como service_role "INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','11111111000111','abc','incluir')")" "CHECK"
eq A2l "service_role INSERE (o escritor de prod)" "$(como service_role "INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','11111111000111','6262','incluir')")" "OK"

echo "── A3 gate e ACL da função"
eq A3a "não-gestor → forbidden mesmo com confirmação válida" "$(chamada "$VENDEDOR" "public.radar_registrar_cadastro_omie('11111111000111','5151',false)")" "FORBIDDEN"
eq A3b "ACL da função: anon/PUBLIC sem, authenticated/service_role com" \
  "$(Pq -c "SELECT has_function_privilege('anon', p.oid, 'EXECUTE')||':'||has_function_privilege('public', p.oid, 'EXECUTE')||':'||has_function_privilege('authenticated', p.oid, 'EXECUTE')||':'||has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)')")" "false:false:true:true"

echo "── A4 re-aplicação confere a tabela que o IF NOT EXISTS deixou passar"
aborta_em() {
  if P -f "$MIG_USADA" > "$TMPD/re.log" 2>&1; then bad "$1" "$2 — re-aplicar PASSOU";
  elif grep -q "$3" "$TMPD/re.log"; then ok "$1" "$2";
  else bad "$1" "$2 — abortou fora do esperado: $(grep -m1 ERROR "$TMPD/re.log" | cut -c1-140)"; fi
}
P -c "ALTER TABLE public.omie_cliente_confirmacoes ADD COLUMN extra text"
aborta_em A4a "coluna a mais → PÓS aborta (forma revisada)" "POS FALHOU: omie_cliente_confirmacoes não tem a forma revisada"
P -c "ALTER TABLE public.omie_cliente_confirmacoes DROP COLUMN extra"
P -c "CREATE POLICY abre ON public.omie_cliente_confirmacoes FOR SELECT TO authenticated USING (true)"
aborta_em A4b "policy criada à mão → PÓS aborta" "POS FALHOU: omie_cliente_confirmacoes não tem a forma revisada"
P -c "DROP POLICY abre ON public.omie_cliente_confirmacoes"
P -c "GRANT UPDATE, DELETE ON public.omie_cliente_confirmacoes TO service_role, sandbox_exec"
if P -f "$MIG_USADA" >"$TMPD/repara.log" 2>&1; then ok A4c "privilégio a mais concedido à mão → re-aplicar REPARA"; else bad A4c "re-aplicar abortou: $(grep -m1 ERROR "$TMPD/repara.log" | cut -c1-140)"; fi
eq A4d "após o reparo ninguém além do dono escreve fora do INSERT do service_role" \
  "$(Pq -c "SELECT has_table_privilege('service_role','public.omie_cliente_confirmacoes','UPDATE')||':'||has_table_privilege('sandbox_exec','public.omie_cliente_confirmacoes','DELETE')")" "false:false"

echo "── A6 anti-deriva de atributo do predecessor"
P -c "ALTER FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) SECURITY INVOKER"
aborta_em A6a "SECURITY INVOKER → PRE FALHOU" "PRE FALHOU: radar_registrar_cadastro_omie vivo mudou SECURITY"
P -c "ALTER FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) SECURITY DEFINER"
P -c "ALTER FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) STABLE"
aborta_em A6c "STABLE → TRAVA FALHOU (conferida antes do ALTER)" "TRAVA FALHOU: radar_registrar_cadastro_omie(text,text,boolean) não é VOLATILE"
P -c "ALTER FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) VOLATILE"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-radar-cadastro-omie-confirmacao: todos os asserts passaram"
[ "$FAIL" -eq 0 ]
