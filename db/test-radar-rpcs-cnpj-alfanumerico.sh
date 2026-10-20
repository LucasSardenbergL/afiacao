#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Radar: as 3 RPCs de prospecção aceitam CNPJ ALFANUMÉRICO                      ║
# ║  (migration 20261019225545_radar_rpcs_cnpj_alfanumerico — follow-up do #3175/#3192)           ║
# ║   bash db/test-radar-rpcs-cnpj-alfanumerico.sh                 (controle)                     ║
# ║   bash db/test-radar-rpcs-cnpj-alfanumerico.sh --falsificar    (controle + sabotagens, cada   ║
# ║                                                                 uma numa rodada própria)      ║
# ║                                                                                                ║
# ║  Mundo: stubs de prod (radar_* com o CHECK alfanumérico vivo, tarefas, gate de gestor) →        ║
# ║  PREDECESSORAS reais: 20260612130000 (registrar_contato_radar), 20260613190000 (fatia3:        ║
# ║  radar_registrar_cadastro_omie + atribuir v1) e o bloco de radar_atribuir_tarefa extraído da    ║
# ║  20260929001651 (a definição viva). A0p exige md5(prosrc) = PROD (psql-ro 2026-10-19) — contato: ║
# ║  = repo, e a PRE lista os dois md5 (PROD perdeu só comentários) — repo ≠ prod fica vermelho AQUI. Depois a migration (A0a), re-aplicar    ║
# ║  (A0b, a PRE aceita "este") e os asserts:                                                      ║
# ║   A0  aplica · no-op · SECURITY DEFINER + search_path=public preservados nas 3                 ║
# ║   A1  registrar_contato_radar: alfanumérico passa e grava; minúscula/13 posições/NULL → RAISE  ║
# ║       'cnpj inválido'; numérico antigo intocado; alnum válido fora do radar cai no lookup      ║
# ║   A2  radar_atribuir_tarefa: alfanumérico cria a tarefa (descrição com o CNPJ), 2ª chamada     ║
# ║       dedupa; minúscula → RAISE; numérico intocado                                             ║
# ║   A3  radar_registrar_cadastro_omie: alfanumérico vira cliente (código, status, contato);      ║
# ║       minúscula → RAISE; numérico intocado                                                     ║
# ║   A4  ACL: anon/PUBLIC sem EXECUTE; authenticated/service_role com — nas 3                     ║
# ║   A5  gate de gestor continua na frente do guard (não-gestor → forbidden)                      ║
# ║  FALSIFICAÇÃO (idioma limpo do fiscal `falsificar-exige-assert-gate`: o vermelho que conta é   ║
# ║  o do assert DECLARADO em SABOTAGENS, nunca "a rodada saiu ≠0"), uma camada por vez:          ║
# ║   guard_numerico_contato    contato volta a ^[0-9]{14}$ (md5 neutralizado) → A1a               ║
# ║   guard_numerico_tarefa     tarefa idem → A2a                                                  ║
# ║   guard_numerico_cadastro   cadastro idem → A3a                                                ║
# ║   guard_aceita_minuscula    as 3 aceitam [a-z] (md5 neutralizado) → A1c                        ║
# ║   sem_search_path           tarefa perde o SET search_path (md5 neutralizado) → A0a (PÓS)      ║
# ║   corpo_sabotado_md5        corpo mexido SEM neutralizar o md5 → A0a (a PÓS morde)             ║
# ║  A régua de md5 "este" é neutralizada (literal → md5 vivo) nas sabotagens SEMÂNTICAS, senão     ║
# ║  todo mutante morreria na PÓS sem exercitar o assert funcional.                                ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261019225545_radar_rpcs_cnpj_alfanumerico.sql"
CONTATO="$REPO_ROOT/supabase/migrations/20260612130000_radar_rpcs_contato.sql"
FATIA3="$REPO_ROOT/supabase/migrations/20260613190000_radar_fatia3.sql"
HOJE_SP="$REPO_ROOT/supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql"
# md5(prosrc) de PROD, psql-ro 2026-10-19 (os mesmos "predecessor" da PRE da migration)
MD5_PROD_CONTATO="efdd73b69bd3d1ef23d2353ec2de3c3e"   # PROD perdeu os comentários `--` do repo; a PRE aceita os dois
MD5_REPO_CONTATO="41eb0fddbbaa50bb9b0e813779d5e54b"   # 20260612130000 tal como está no repo (diff = só comentários, 2026-10-20)
MD5_PROD_TAREFA="2cec8056bf553b87d6329394c1f30779"
MD5_PROD_CADASTRO="1ad5c63172e48b51931a910922974f75"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="guard_numerico_contato:A1a guard_numerico_tarefa:A2a guard_numerico_cadastro:A3a guard_aceita_minuscula:A1c sem_search_path:A0a corpo_sabotado_md5:A0a"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-rpcs-alnum.XXXXXX")"
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
PORT="${PGPORT_TEST:-5512}"
TMPD="$(mktemp -d "/tmp/pgtest-radar-rpcs-alnum.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
MIG_USADA="$TMPD/mig.sql"
TAREFA_VIVA="$TMPD/tarefa-viva.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

for f in "$MIG" "$CONTATO" "$FATIA3" "$HOJE_SP"; do [ -f "$f" ] || { echo "migration nao encontrada: $f"; exit 1; }; done
cp "$MIG" "$MIG_USADA"
# A definição VIVA de radar_atribuir_tarefa é o bloco da 20260929001651 (que recria 7 funções com PRE
# própria): extrai só o CREATE dela, do cabeçalho até o `$function$;` que o fecha.
python3 -I - "$HOJE_SP" "$TAREFA_VIVA" <<'PY'
import sys
src, dst = sys.argv[1:]
s = open(src, encoding="utf-8").read()
ini = s.index("CREATE OR REPLACE FUNCTION public.radar_atribuir_tarefa(")
fim = s.index("$function$;", ini) + len("$function$;")
open(dst, "w", encoding="utf-8").write(s[ini:fim] + "\n")
PY

# sabotar ARQ DE PARA [FUNCAO]: troca literal; com FUNCAO, só dentro do CREATE dessa função.
sabotar() {
  python3 -I - "$1" "$2" "$3" "${4:-}" <<'PY'
import sys
p, de, para, fn = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if fn:
    ini = s.index(f"CREATE OR REPLACE FUNCTION public.{fn}(")
    fim = s.index("$function$;", ini)
    bloco = s[ini:fim]
    if de not in bloco:
        sys.exit(f"padrao ausente em {fn}: {de}")
    s = s[:ini] + bloco.replace(de, para) + s[fim:]
else:
    if de not in s:
        sys.exit("padrao ausente: " + de)
    s = s.replace(de, para)
open(p, "w", encoding="utf-8").write(s)
PY
}
# Régua de md5 "este" de cada função (literal marcado com `-- este:<nome>` na PRE e na PÓS) → md5 vivo.
este_de() { grep -oE "'[0-9a-f]{32}' /\* este:$1 \*/" "$MIG" | grep -oE '[0-9a-f]{32}' | head -1; }
neutralizar() { # $1 = nome, $2 = identidade
  sabotar "$MIG_USADA" "'$(este_de "$1")'" "(SELECT md5(q.prosrc) FROM pg_catalog.pg_proc q WHERE q.oid = to_regprocedure('public.$2'))"
}
GUARD_NOVO="p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}\$'"
case "${SABOTAGEM:-}" in
  "") ;;
  guard_numerico_contato)  sabotar "$MIG_USADA" "$GUARD_NOVO" "p_cnpj !~ '^[0-9]{14}\$'" registrar_contato_radar
                           sabotar "$MIG_USADA" "OR position(\$guard\$p_cnpj !~ '^[0-9]{14}\$'\$guard\$ IN r.prosrc) > 0" "OR false"
                           sabotar "$MIG_USADA" "IF position(\$guard\$p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}\$'\$guard\$ IN r.prosrc) = 0" "IF false"
                           neutralizar registrar_contato_radar 'registrar_contato_radar(text,text,text)' ;;
  guard_numerico_tarefa)   sabotar "$MIG_USADA" "$GUARD_NOVO" "p_cnpj !~ '^[0-9]{14}\$'" radar_atribuir_tarefa
                           sabotar "$MIG_USADA" "OR position(\$guard\$p_cnpj !~ '^[0-9]{14}\$'\$guard\$ IN r.prosrc) > 0" "OR false"
                           sabotar "$MIG_USADA" "IF position(\$guard\$p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}\$'\$guard\$ IN r.prosrc) = 0" "IF false"
                           neutralizar radar_atribuir_tarefa 'radar_atribuir_tarefa(text,integer)' ;;
  guard_numerico_cadastro) sabotar "$MIG_USADA" "$GUARD_NOVO" "p_cnpj !~ '^[0-9]{14}\$'" radar_registrar_cadastro_omie
                           sabotar "$MIG_USADA" "OR position(\$guard\$p_cnpj !~ '^[0-9]{14}\$'\$guard\$ IN r.prosrc) > 0" "OR false"
                           sabotar "$MIG_USADA" "IF position(\$guard\$p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}\$'\$guard\$ IN r.prosrc) = 0" "IF false"
                           neutralizar radar_registrar_cadastro_omie 'radar_registrar_cadastro_omie(text,text,boolean)' ;;
  guard_aceita_minuscula)  for fn in registrar_contato_radar radar_atribuir_tarefa radar_registrar_cadastro_omie; do
                             sabotar "$MIG_USADA" "$GUARD_NOVO" "p_cnpj !~ '^[0-9A-Za-z]{12}[0-9]{2}\$'" "$fn"
                           done
                           sabotar "$MIG_USADA" "IF position(\$guard\$p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}\$'\$guard\$ IN r.prosrc) = 0" "IF false"
                           neutralizar registrar_contato_radar 'registrar_contato_radar(text,text,text)'
                           neutralizar radar_atribuir_tarefa 'radar_atribuir_tarefa(text,integer)'
                           neutralizar radar_registrar_cadastro_omie 'radar_registrar_cadastro_omie(text,text,boolean)' ;;
  sem_search_path)         sabotar "$MIG_USADA" " SET search_path TO 'public'
AS \$function\$" "
AS \$function\$" radar_atribuir_tarefa
                           neutralizar radar_atribuir_tarefa 'radar_atribuir_tarefa(text,integer)' ;;
  corpo_sabotado_md5)      sabotar "$MIG_USADA" "'cnpj inválido'" "'cnpj invalido'" registrar_contato_radar ;;
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
# eq ID descrição valor esperado
eq()  { if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi; }
GESTOR='00000000-0000-0000-0000-0000000000a1'
VENDEDOR='00000000-0000-0000-0000-0000000000b2'
# chamada UID 'SELECT public.rpc(...)': o que a RPC fez com o CNPJ, como MARCADOR (sentinela que o código
# nunca emite): PASSOU · GUARD (RAISE 'cnpj inválido', SQLSTATE P0001) · NAO_ENCONTRADA (passou o guard e
# caiu no lookup) · FORBIDDEN (gate de gestor). Qualquer OUTRO erro relança — WHEN OTHERS 'OK' é teatro.
chamada() {
  Pq -c "SET test.uid = '$1'; DELETE FROM public.test_res;
DO \$x\$ BEGIN
  PERFORM $2;
  INSERT INTO public.test_res VALUES ('PASSOU');
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'cnpj inválido' THEN INSERT INTO public.test_res VALUES ('GUARD');
  ELSIF SQLERRM LIKE 'empresa não encontrada%' THEN INSERT INTO public.test_res VALUES ('NAO_ENCONTRADA');
  ELSIF SQLERRM LIKE 'forbidden%' THEN INSERT INTO public.test_res VALUES ('FORBIDDEN');
  ELSE RAISE; END IF;
END \$x\$;
SELECT k FROM public.test_res;"
}
md5_de() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.$1')"; }

P <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
-- radar_empresas com o CHECK VIVO de prod (20261019110000): o alfanumérico já entra na tabela.
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
-- tarefas: réplica mínima com os CHECKs que a RPC precisa satisfazer.
CREATE TABLE public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  descricao text NOT NULL,
  categoria text NOT NULL CHECK (categoria IN ('ligar','oferecer','preco','whatsapp','outro')),
  customer_user_id uuid,
  assigned_to uuid NOT NULL, created_by uuid NOT NULL,
  empresa text NOT NULL,
  modo text NOT NULL CHECK (modo IN ('data','interacao')),
  due_date date, interacao_tipo text CHECK (interacao_tipo IN ('ligacao','visita','entrega')),
  auto_satisfy_mode text NOT NULL DEFAULT 'off' CHECK (auto_satisfy_mode IN ('off','interacao','conteudo')),
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','concluida','cancelada')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tarefas_modo_coerencia_chk CHECK (
    (modo='data' AND due_date IS NOT NULL AND interacao_tipo IS NULL)
    OR (modo='interacao' AND interacao_tipo IS NOT NULL AND due_date IS NULL)));
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE TABLE public.test_res (k text);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
SQL
P -f "$CONTATO" >/dev/null
P -f "$FATIA3" >/dev/null
P -f "$TAREFA_VIVA" >/dev/null
P <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_empresas (cnpj, razao_social, nome_fantasia, cnae_principal, municipio_nome, uf, telefone1, ultimo_lote) VALUES
  ('11111111000111', 'NUMERICA LTDA', 'NUMERICA', '3101200', 'BELO HORIZONTE', 'MG', '3133334444', '2026-10'),
  ('12ABC34501DE35', 'ALFANUMERICA LTDA', 'ALFA', '3101200', 'CONTAGEM', 'MG', NULL, '2026-10');
SQL

echo "── A0 aplicação"
eq A0p1 "predecessor registrar_contato_radar (20260612130000) = repo (PROD difere só em comentários; a PRE aceita os dois)" "$(md5_de 'registrar_contato_radar(text,text,text)')" "$MD5_REPO_CONTATO"
eq A0p1b "a PRE lista o md5 de PROD E o do repo para registrar_contato_radar" "$(grep -c "ARRAY\['$MD5_PROD_CONTATO','$MD5_REPO_CONTATO'\]" "$MIG")" "1"
eq A0p2 "predecessor radar_atribuir_tarefa (bloco da 20260929001651) = PROD" "$(md5_de 'radar_atribuir_tarefa(text,integer)')" "$MD5_PROD_TAREFA"
eq A0p3 "predecessor radar_registrar_cadastro_omie (20260613190000) = PROD" "$(md5_de 'radar_registrar_cadastro_omie(text,text,boolean)')" "$MD5_PROD_CADASTRO"
if P -f "$MIG_USADA" >"$TMPD/apply.log" 2>&1; then ok A0a "migration aplica (TRAVA → PRE → CREATE → PÓS)"; else bad A0a "migration abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply.log" | cut -c1-160)"; fi
if P -f "$MIG_USADA" >"$TMPD/apply2.log" 2>&1; then ok A0b "re-aplicar é no-op (PRE aceita 'este')"; else bad A0b "re-aplicar abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply2.log" | cut -c1-160)"; fi
eq A0c "as 3 seguem SECURITY DEFINER + search_path=public + VOLATILE" \
  "$(Pq -c "SELECT string_agg(proname||':'||prosecdef||':'||proconfig[1]||':'||provolatile::text, ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('registrar_contato_radar','radar_atribuir_tarefa','radar_registrar_cadastro_omie')")" \
  "radar_atribuir_tarefa:true:search_path=public:v,radar_registrar_cadastro_omie:true:search_path=public:v,registrar_contato_radar:true:search_path=public:v"

echo "── A1 registrar_contato_radar"
eq A1a "alfanumérico válido PASSA o guard e grava" "$(chamada "$GESTOR" "public.registrar_contato_radar('12ABC34501DE35','em_conversa','ligou')")" "PASSOU"
eq A1b "contato gravado + status da empresa atualizado" "$(Pq -c "SELECT (SELECT count(*) FROM public.radar_contatos WHERE cnpj='12ABC34501DE35' AND acao='em_conversa')||'/'||(SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='12ABC34501DE35')")" "1/em_conversa"
eq A1c "minúscula → RAISE 'cnpj inválido' (fail-closed, como o CHECK)" "$(chamada "$GESTOR" "public.registrar_contato_radar('12abc34501DE35','em_conversa',NULL)")" "GUARD"
eq A1d "13 posições → RAISE" "$(chamada "$GESTOR" "public.registrar_contato_radar('12ABC34501DE3','em_conversa',NULL)")" "GUARD"
eq A1e "NULL → RAISE" "$(chamada "$GESTOR" "public.registrar_contato_radar(NULL,'em_conversa',NULL)")" "GUARD"
eq A1f "numérico antigo intocado (passa e grava)" "$(chamada "$GESTOR" "public.registrar_contato_radar('11111111000111','a_contatar',NULL)")" "PASSOU"
eq A1g "alfanumérico válido FORA do radar passa o guard e cai no lookup" "$(chamada "$GESTOR" "public.registrar_contato_radar('A1B2C3D4E5F668','em_conversa',NULL)")" "NAO_ENCONTRADA"

echo "── A2 radar_atribuir_tarefa"
eq A2a "alfanumérico válido PASSA e cria a tarefa" "$(chamada "$GESTOR" "public.radar_atribuir_tarefa('12ABC34501DE35', 7)")" "PASSOU"
eq A2b "tarefa com o CNPJ alfanumérico na descrição (1, do gestor)" "$(Pq -c "SELECT count(*)||'/'||max(assigned_to::text) FROM public.tarefas WHERE descricao LIKE '%CNPJ 12ABC34501DE35' AND status='aberta'")" "1/$GESTOR"
eq A2c "2ª chamada em 2 min dedupa (o LIKE do dedupe serve o alfanumérico)" "$(Pq -c "SET test.uid='$GESTOR'; SELECT (public.radar_atribuir_tarefa('12ABC34501DE35', 7))->>'deduped'")" "true"
eq A2d "minúscula → RAISE" "$(chamada "$GESTOR" "public.radar_atribuir_tarefa('12abc34501DE35', 7)")" "GUARD"
eq A2e "numérico antigo intocado" "$(chamada "$GESTOR" "public.radar_atribuir_tarefa('11111111000111', 7)")" "PASSOU"

echo "── A3 radar_registrar_cadastro_omie"
eq A3a "alfanumérico válido PASSA e registra o cadastro" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('12ABC34501DE35','4242',false)")" "PASSOU"
eq A3b "empresa virou cliente com o código Omie" "$(Pq -c "SELECT ja_cliente||'/'||omie_codigo_cliente||'/'||prospeccao_status FROM public.radar_empresas WHERE cnpj='12ABC34501DE35'")" "true/4242/virou_cliente"
eq A3c "contato 'virou_cliente' gravado com o status anterior" "$(Pq -c "SELECT count(*)||'/'||max(status_anterior) FROM public.radar_contatos WHERE cnpj='12ABC34501DE35' AND acao='virou_cliente'")" "1/em_conversa"
eq A3d "minúscula → RAISE" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('12abc34501DE35','4242',false)")" "GUARD"
eq A3e "numérico antigo intocado" "$(chamada "$GESTOR" "public.radar_registrar_cadastro_omie('11111111000111','4343',true)")" "PASSOU"

echo "── A4 ACL (REPLACE preserva; o REVOKE/GRANT reemite nomeando as roles)"
for r in anon public; do
  eq "A4_$r" "$r sem EXECUTE nas 3" "$(Pq -c "SELECT bool_or(has_function_privilege('$r', p.oid, 'EXECUTE')) FROM pg_proc p WHERE proname IN ('registrar_contato_radar','radar_atribuir_tarefa','radar_registrar_cadastro_omie')")" "f"
done
for r in authenticated service_role; do
  eq "A4_$r" "$r com EXECUTE nas 3" "$(Pq -c "SELECT bool_and(has_function_privilege('$r', p.oid, 'EXECUTE')) FROM pg_proc p WHERE proname IN ('registrar_contato_radar','radar_atribuir_tarefa','radar_registrar_cadastro_omie')")" "t"
done

echo "── A5 gate de gestor"
eq A5a "não-gestor → forbidden ANTES do guard (mesmo com CNPJ alfanumérico válido)" "$(chamada "$VENDEDOR" "public.registrar_contato_radar('12ABC34501DE35','em_conversa',NULL)")" "FORBIDDEN"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-radar-rpcs-cnpj-alfanumerico: todos os asserts passaram"
[ "$FAIL" -eq 0 ]
