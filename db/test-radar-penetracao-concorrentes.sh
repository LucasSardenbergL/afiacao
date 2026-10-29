#!/usr/bin/env bash
# Prova PG17 da migration 20261029170140 (Radar, frente 4 — mapa): penetração por município e camada de
# concorrentes. Aplica a migration REAL duas vezes (idempotência) num esquema mínimo e assevera,
# chamando as RPCs como `authenticated` com o GUC do JWT (o caminho de prod):
#   A1  penetração = clientes / empresas do LOTE VIGENTE; cliente de lote velho não conta; descartado
#       entra no denominador (é mercado); município com denominador e 0 clientes = 0, não NULL
#   A2  ordem por mercado (empresas do lote) · p_uf · p_limit
#   A3  concorrentes: NULL sem publicação do lote (ausente ≠ zero); 0 onde o lote foi publicado e o
#       município não tem revenda; município só-de-concorrente sai com penetração NULL (sem denominador)
#   A4  lote ausente/mal formado → 'lote inválido' (SQLSTATE P0001 casada; o resto re-lança)
#   A5  gate: sem `private.cap_radar_prospectar` → 'forbidden: radar'
#   A6  RLS sob SET ROLE authenticated + GUC: com o gate lê, sem o gate 0 linhas; anon 42501; INSERT 42501
#   A7  publicar: reconcilia soma × total, recusa total 0 e CNAE fora da lista, re-publicar substitui
#       (sem duplicar), falha no meio deixa a publicação anterior intacta; authenticated sem EXECUTE
#   A8  PRE: gate ausente aborta a migration inteira; corpo vivo divergente aborta e fica intacto
#
#   bash db/test-radar-penetracao-concorrentes.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-penetracao-concorrentes.sh   # tem de ficar VERMELHA
#   bash db/test-radar-penetracao-concorrentes.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261029170140_radar_penetracao_e_concorrentes.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS — asserts (unidos por ',') que TÊM de ficar vermelhos; ou `APPLY!MARCA` quando a
  # postcondição/PRE da própria migration TEM de abortar o apply com aquela marca (`_` vira espaço).
  # As variantes `_sem_post` cegam essa camada para provar que o assert da suíte pega sozinho.
  SABOTAGENS="sem_recorte_lote:A1a,A1b denominador_sem_descartado:A1a ordem_invertida:A2a sem_filtro_uf:A2b concorrente_zero_inventado:A3a penetracao_zero_inventada:A3c sem_validacao_lote:A4a,A4b gate_aberto:A5 policy_aberta:APPLY!P8_FALHOU policy_aberta_sem_post:A6b sem_reconciliacao:A7a aceita_total_zero:A7b aceita_cnae_fora:A7c publicar_duplica:A7d publicar_aberto:APPLY!P5_FALHOU publicar_aberto_sem_post:A7f pre_sem_gate:A8a pre_cega:A8b,A8c corpo_divergente:APPLY!P2_FALHOU"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-penetracao.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  SAB_V=0; SAB_F=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; verm="${par#*:}"
    log="$LOGDIR/$s.log"
    if SABOTAGEM="$s" bash "$0" > "$log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; SAB_F=$((SAB_F+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; SAB_F=$((SAB_F+1)); continue
    fi
    case "$verm" in
      APPLY!*)
        marca="${verm#APPLY!}"; marca="${marca//_/ }"
        if grep -qF "$marca" "$log"; then
          SAB_V=$((SAB_V+1)); echo "✅ $s → apply abortou com '$marca'"
        else
          SAB_F=$((SAB_F+1)); echo "❌ $s: vermelho, mas o apply não abortou com '$marca' (log: $log)"
        fi ;;
      *)
        faltou=""
        for id in ${verm//,/ }; do
          grep -q "^FAIL $id " "$log" || faltou="$faltou $id"
        done
        if [ -z "$faltou" ]; then
          SAB_V=$((SAB_V+1)); echo "✅ $s → {$verm} vermelho"
        else
          SAB_F=$((SAB_F+1)); echo "❌ $s: declarado {$verm}, faltou:$faltou (log: $log)"
        fi ;;
    esac
  done
  echo "SABOTAGENS: $SAB_V vermelhas / $SAB_F falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$SAB_F" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5571}"
DATA="$(mktemp -d "/tmp/pgtest-radar-penetracao.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"

sabotar() { # $1 = de, $2 = para (literal)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Sabotagem no CORPO muda o prosrc → o md5 da PÓS pegaria antes da suíte. Para provar que o assert
# da suíte tem dente sozinho, cega o md5 junto (a PRE só compara no 2º apply, cegada também).
cegar_md5() {
  sabotar "  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_pen) <> '" "  IF false AND (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_pen) <> '"
  sabotar "  IF v_pen IS NOT NULL AND v_pen <> '" "  IF false AND v_pen <> '"
  sabotar "  IF v_pub IS NOT NULL AND v_pub <> '" "  IF false AND v_pub <> '"
}
case "${SABOTAGEM:-}" in
  "") ;;
  sem_recorte_lote)  cegar_md5; sabotar "     WHERE re.ultimo_lote = p_lote" "     WHERE true" ;;
  denominador_sem_descartado) cegar_md5; sabotar "     WHERE re.ultimo_lote = p_lote" "     WHERE re.ultimo_lote = p_lote AND re.prospeccao_status <> 'descartado'" ;;
  ordem_invertida)   cegar_md5; sabotar "   ORDER BY me.t DESC NULLS LAST" "   ORDER BY me.t ASC NULLS LAST" ;;
  sem_filtro_uf)     cegar_md5; sabotar $'       AND (p_uf IS NULL OR re.uf = p_uf)\n' $'\n' ;;
  concorrente_zero_inventado) cegar_md5; sabotar "CASE WHEN v_concorrentes_carregados THEN COALESCE(co.q, 0) END" "COALESCE(co.q, 0)" ;;
  penetracao_zero_inventada)  cegar_md5; sabotar "CASE WHEN me.t > 0 THEN round(me.c::numeric / me.t, 4) END" "COALESCE(round(me.c::numeric / NULLIF(me.t, 0), 4), 0)" ;;
  sem_validacao_lote) cegar_md5; sabotar "  IF p_lote IS NULL OR p_lote !~ '^[0-9]{4}-[0-9]{2}\$' THEN RAISE EXCEPTION 'lote inválido'; END IF;
  IF p_uf" "  IF p_uf" ;;
  gate_aberto)       cegar_md5; sabotar "  IF NOT COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false) THEN" "  IF false THEN" ;;
  policy_aberta)     sabotar "CREATE POLICY radar_concorrentes_municipio_select_prospectar ON public.radar_concorrentes_municipio
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));" "CREATE POLICY radar_concorrentes_municipio_select_prospectar ON public.radar_concorrentes_municipio
  FOR SELECT TO authenticated
  USING (true);" ;;
  policy_aberta_sem_post)
                     sabotar "CREATE POLICY radar_concorrentes_municipio_select_prospectar ON public.radar_concorrentes_municipio
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));" "CREATE POLICY radar_concorrentes_municipio_select_prospectar ON public.radar_concorrentes_municipio
  FOR SELECT TO authenticated
  USING (true);"
                     sabotar "    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol" "    IF false AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol"
                     sabotar "       OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol
                   WHERE pol.polrelid = v_tab::regclass
                     AND pg_get_expr" "       OR false AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol
                   WHERE pol.polrelid = v_tab::regclass
                     AND pg_get_expr" ;;
  sem_reconciliacao) cegar_md5; sabotar "  IF COALESCE(v_soma, 0) <> p_estabelecimentos THEN" "  IF false THEN" ;;
  aceita_total_zero) cegar_md5; sabotar "  IF p_estabelecimentos IS NULL OR p_estabelecimentos <= 0 THEN" "  IF p_estabelecimentos IS NULL OR p_estabelecimentos < 0 THEN"
                     sabotar "  IF COALESCE(v_soma, 0) <> p_estabelecimentos THEN" "  IF COALESCE(v_soma, 0) <> p_estabelecimentos AND p_estabelecimentos > 0 THEN" ;;
  aceita_cnae_fora)  cegar_md5; sabotar "                             OR x.cnae IS NULL OR NOT (x.cnae = ANY (p_cnaes))" "                             OR x.cnae IS NULL" ;;
  publicar_duplica)  cegar_md5; sabotar "  DELETE FROM public.radar_concorrentes_municipio cm WHERE cm.lote = p_lote;
  INSERT INTO public.radar_concorrentes_municipio (lote, municipio_codigo, uf, cnae, quantidade)
  SELECT p_lote, x.municipio_codigo, x.uf, x.cnae, x.quantidade
    FROM jsonb_to_recordset(p_linhas) AS x(municipio_codigo text, uf text, cnae text, quantidade integer);" "  INSERT INTO public.radar_concorrentes_municipio (lote, municipio_codigo, uf, cnae, quantidade)
  SELECT p_lote, x.municipio_codigo, x.uf, x.cnae, x.quantidade
    FROM jsonb_to_recordset(p_linhas) AS x(municipio_codigo text, uf text, cnae text, quantidade integer)
  ON CONFLICT (lote, municipio_codigo, cnae) DO UPDATE SET quantidade = radar_concorrentes_municipio.quantidade + EXCLUDED.quantidade;" ;;
  publicar_aberto)   sabotar "FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_concorrentes_publicar" "FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_concorrentes_publicar" ;;
  publicar_aberto_sem_post)
                     sabotar "FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_concorrentes_publicar" "FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_concorrentes_publicar"
                     sabotar "     OR has_function_privilege('authenticated', v_pub, 'EXECUTE')" "     OR false" ;;
  pre_sem_gate)      sabotar "  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL THEN" "  IF false THEN" ;;
  pre_cega)          sabotar "  IF v_pen IS NOT NULL AND v_pen <> '" "  IF false AND v_pen <> '" ;;
  corpo_divergente)  sabotar "  -- Sem lote não há denominador: penetração" "  -- Sem lote  não há denominador: penetração" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
PD() { local db="$1"; shift; "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$db" "$@"; }
P()  { PD base "$@"; }
Pq() { P -qAt "$@"; }

PD postgres -q -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;" -c "CREATE DATABASE base;"

GESTOR='00000000-0000-0000-0000-0000000000a1'
OUTRO='00000000-0000-0000-0000-0000000000b2'

P -q <<SQL
CREATE SCHEMA auth;
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA auth, private TO authenticated, anon, service_role;
-- auth.uid() como no Supabase: lê o sub do JWT do GUC request.jwt.claims.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid \$\$;
-- Gate da frente 2 (stub): só o GESTOR pode prospectar.
CREATE FUNCTION private.cap_radar_prospectar(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS \$\$
  SELECT COALESCE(_uid = '$GESTOR'::uuid, false) \$\$;
REVOKE ALL ON FUNCTION private.cap_radar_prospectar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_radar_prospectar(uuid) TO authenticated, service_role;
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text, uf text, lat double precision, lng double precision);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, municipio_codigo text, municipio_nome text, uf text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar', ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL);
INSERT INTO public.radar_municipios VALUES
  ('M1','CIDADE UM','SC',-27.1,-48.6), ('M2','CIDADE DOIS','MG',-19.9,-43.9), ('M3','CIDADE TRES','SC',-26.3,-48.8);
-- M1: 4 no lote vigente (2026-10): 2 leads, 1 descartado (é mercado), 1 cliente → 1/4 = 0.2500.
--     + 2 clientes de lote velho (saíram do dump): não contam em nada.
-- M2: 2 no vigente, nenhum cliente → 0.0000 (zero COM denominador) · + 5 de lote velho.
-- M3: só lote velho (1 cliente) → fora do mercado vigente; aparece só como concorrente.
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, municipio_nome, uf, prospeccao_status, ja_cliente, ultimo_lote) VALUES
  ('M1A','M1','CIDADE UM','SC','a_contatar',false,'2026-10'),
  ('M1B','M1','CIDADE UM','SC','a_contatar',false,'2026-10'),
  ('M1D','M1','CIDADE UM','SC','descartado',false,'2026-10'),
  ('M1C','M1','CIDADE UM','SC','a_contatar',true, '2026-10'),
  ('M1V1','M1','CIDADE UM','SC','a_contatar',true,'2026-08'),
  ('M1V2','M1','CIDADE UM','SC','a_contatar',true,'2026-08'),
  ('M2A','M2','CIDADE DOIS','MG','a_contatar',false,'2026-10'),
  ('M2B','M2','CIDADE DOIS','MG','a_contatar',false,'2026-10'),
  ('M3V','M3','CIDADE TRES','SC','a_contatar',true,'2026-08');
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, municipio_nome, uf, ultimo_lote)
  SELECT 'M2V' || g, 'M2', 'CIDADE DOIS', 'MG', '2026-08' FROM generate_series(1, 5) g;
SQL

# Bancos para a PRE, clonados ANTES do apply: sem o gate, e com um corpo vivo divergente.
PD postgres -q -c "CREATE DATABASE sem_gate TEMPLATE base;" -c "CREATE DATABASE divergente TEMPLATE base;"
PD sem_gate -q -c "DROP FUNCTION private.cap_radar_prospectar(uuid);"
PD divergente -q -c "CREATE FUNCTION public.radar_penetracao_por_municipio(p_lote text, p_uf text DEFAULT NULL, p_limit integer DEFAULT 500)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, empresas_lote bigint, clientes bigint, penetracao numeric, concorrentes bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT 'OUTRA'::text, 'SESSAO'::text, 'XX'::text, NULL::float8, NULL::float8, 1::bigint, 0::bigint, 0::numeric, 0::bigint \$f\$;"

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente: o 2º apply passa a PRE pelo md5 "este"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# Roda SQL como `authenticated` com o JWT de $1 (o caminho do PostgREST).
como() { local uid="$1"; shift
  Pq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = '{\"sub\":\"$uid\"}';
$1
COMMIT;"; }
# Foto: "codigo=empresas/clientes/penetracao/concorrentes" na ordem devolvida; ∅ = NULL.
foto() { como "$GESTOR" "SELECT coalesce(string_agg(t.municipio_codigo||'='||coalesce(t.empresas_lote::text,'∅')||'/'||coalesce(t.clientes::text,'∅')
  ||'/'||coalesce(t.penetracao::text,'∅')||'/'||coalesce(t.concorrentes::text,'∅'), ' ' ORDER BY o), '(vazio)')
  FROM public.radar_penetracao_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, empresas_lote, clientes, penetracao, concorrentes, o);"; }
# Erro casado: devolve RECUSOU:<msg> só para P0001 com a mensagem esperada; outra SQLSTATE re-lança.
recusa() { # $1 = sql que deve falhar, $2 = mensagem (prefixo) esperada, $3 = uid
  como "${3:-$GESTOR}" "DO \$t\$ BEGIN
  PERFORM * FROM ($1) s;
  RAISE NOTICE 'R:ACEITOU';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE '$2%' THEN RAISE NOTICE 'R:RECUSOU'; ELSE RAISE; END IF;
END \$t\$;" 2>&1 | grep -o 'R:[A-Z]*' || true; }
publicar() { Pq -c "SELECT public.radar_concorrentes_publicar('2026-10', ARRAY['4679601','4741500'], '$1'::jsonb, $2);"; }
LINHAS_OK='[{"municipio_codigo":"M1","uf":"SC","cnae":"4741500","quantidade":3},{"municipio_codigo":"M1","uf":"SC","cnae":"4679601","quantidade":1},{"municipio_codigo":"M3","uf":"SC","cnae":"4741500","quantidade":2}]'

# A1/A2 — penetração com denominador, antes de qualquer publicação de concorrentes.
eq "A1a penetração do lote vigente (sem concorrentes publicados)" "$(foto "'2026-10'")" "M1=4/1/0.2500/∅ M2=2/0/0.0000/∅"
eq "A1b lote velho é outra foto (não vaza para o vigente)"        "$(foto "'2026-08'")" "M2=5/0/0.0000/∅ M1=2/2/1.0000/∅ M3=1/1/1.0000/∅"
eq "A2a p_limit corta pelo mercado"                              "$(foto "'2026-10', p_limit => 1")" "M1=4/1/0.2500/∅"
eq "A2b p_uf"                                                    "$(foto "'2026-10', p_uf => 'MG'")" "M2=2/0/0.0000/∅"

# A3 — concorrentes: publicados, viram número (0 onde o lote tem publicação e o município não).
eq "A3pre publicação aceita" "$(publicar "$LINHAS_OK" 6)" '{"lote": "2026-10", "linhas": 3, "municipios": 2, "estabelecimentos": 6}'
eq "A3a com publicação: 0 é zero de verdade; M3 só-concorrente" "$(foto "'2026-10'")" "M1=4/1/0.2500/4 M2=2/0/0.0000/0 M3=∅/∅/∅/2"
eq "A3b lote sem publicação segue NULL"                         "$(foto "'2026-08', p_uf => 'MG'")" "M2=5/0/0.0000/∅"
eq "A3c sem denominador a penetração é NULL"                    "$(como "$GESTOR" "SELECT coalesce(penetracao::text,'∅')||'/'||coalesce(empresas_lote::text,'∅') FROM public.radar_penetracao_por_municipio('2026-10') WHERE municipio_codigo='M3';")" "∅/∅"

# A4 — lote ausente ou mal formado grita.
eq "A4a lote NULL recusado"      "$(recusa "SELECT * FROM public.radar_penetracao_por_municipio(NULL)" 'lote inválido')" "R:RECUSOU"
eq "A4b lote '2026-8' recusado"  "$(recusa "SELECT * FROM public.radar_penetracao_por_municipio('2026-8')" 'lote inválido')" "R:RECUSOU"
eq "A4c lote '2026-10' aceito"   "$(recusa "SELECT * FROM public.radar_penetracao_por_municipio('2026-10')" 'lote inválido')" "R:ACEITOU"

# A5 — gate da RPC.
eq "A5 sem cap_radar_prospectar: forbidden" "$(recusa "SELECT * FROM public.radar_penetracao_por_municipio('2026-10')" 'forbidden: radar' "$OUTRO")" "R:RECUSOU"

# A6 — RLS das tabelas novas sob SET ROLE authenticated + GUC.
eq "A6a gestor lê as linhas publicadas"  "$(como "$GESTOR" "SELECT count(*) FROM public.radar_concorrentes_municipio;")" "3"
eq "A6b sem o gate: 0 linhas"            "$(como "$OUTRO" "SELECT count(*)||'/'||(SELECT count(*) FROM public.radar_concorrentes_lote) FROM public.radar_concorrentes_municipio;")" "0/0"
eq "A6c anon: permissão negada (42501)" \
   "$(Pq -c "DO \$t\$ BEGIN SET LOCAL ROLE anon; PERFORM count(*) FROM public.radar_concorrentes_municipio; RAISE NOTICE 'R:LEU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'R:NEGADO'; END \$t\$;" 2>&1 | grep -o 'R:[A-Z]*' || true)" "R:NEGADO"
eq "A6d authenticated não escreve (42501)" \
   "$(como "$GESTOR" "DO \$t\$ BEGIN INSERT INTO public.radar_concorrentes_municipio VALUES ('2026-10','M2','MG','4741500',9); RAISE NOTICE 'R:ESCREVEU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'R:NEGADO'; END \$t\$;" 2>&1 | grep -o 'R:[A-Z]*' || true)" "R:NEGADO"

# A7 — porta de escrita.
pub_recusa() { Pq -c "DO \$t\$ BEGIN
  PERFORM public.radar_concorrentes_publicar('2026-10', ARRAY['4679601','4741500'], '$1'::jsonb, $2);
  RAISE NOTICE 'R:ACEITOU';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE '$3%' THEN RAISE NOTICE 'R:RECUSOU'; ELSE RAISE; END IF;
END \$t\$;" 2>&1 | grep -o 'R:[A-Z]*' || true; }
eq "A7a soma ≠ total: recusa"            "$(pub_recusa "$LINHAS_OK" 7 'reconciliação falhou')" "R:RECUSOU"
eq "A7b total 0 com recorte vazio: recusa" "$(pub_recusa '[]' 0 'total de estabelecimentos inválido')" "R:RECUSOU"
eq "A7c CNAE fora da lista: recusa"      "$(pub_recusa '[{"municipio_codigo":"M1","uf":"SC","cnae":"4744005","quantidade":6}]' 6 'linhas inválidas')" "R:RECUSOU"
eq "A7e falhas não tocaram a publicação anterior" "$(foto "'2026-10'")" "M1=4/1/0.2500/4 M2=2/0/0.0000/0 M3=∅/∅/∅/2"
publicar "$LINHAS_OK" 6 >/dev/null
eq "A7d re-publicar substitui, não soma" "$(Pq -c "SELECT sum(quantidade)||'/'||count(*)||'/'||(SELECT estabelecimentos FROM public.radar_concorrentes_lote WHERE lote='2026-10') FROM public.radar_concorrentes_municipio WHERE lote='2026-10';")" "6/3/6"
eq "A7f authenticated não executa publicar" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', 'public.radar_concorrentes_publicar(text,text[],jsonb,integer)', 'EXECUTE')||'/'||has_function_privilege('anon', 'public.radar_concorrentes_publicar(text,text[],jsonb,integer)', 'EXECUTE')||'/'||has_function_privilege('service_role', 'public.radar_concorrentes_publicar(text,text[],jsonb,integer)', 'EXECUTE');")" "false/false/true"
eq "A7g ACL da penetração (public/anon/authenticated/service_role)" \
   "$(Pq -c "SELECT string_agg(has_function_privilege(r, 'public.radar_penetracao_por_municipio(text,text,integer)', 'EXECUTE')::text, ' ' ORDER BY o) FROM unnest(ARRAY['public','anon','authenticated','service_role']) WITH ORDINALITY AS x(r, o);")" "false false true true"

# A8 — PRE.
SAIDA_SG="$(PD sem_gate -q -f "$MIG_USADA" 2>&1 || true)"
eq "A8a gate ausente: a migration aborta inteira" \
   "$(printf '%s' "$SAIDA_SG" | grep -o 'PRE FALHOU: private.cap_radar_prospectar(uuid) ausente' | head -1)/$(PD sem_gate -qAt -c "SELECT count(*) FROM pg_class WHERE relname LIKE 'radar_concorrentes%';")" \
   "PRE FALHOU: private.cap_radar_prospectar(uuid) ausente/0"
SAIDA_DIV="$(PD divergente -q -f "$MIG_USADA" 2>&1 || true)"
eq "A8b corpo vivo divergente: aborta" "$(printf '%s' "$SAIDA_DIV" | grep -o 'PRE FALHOU: radar_penetracao_por_municipio viva' | head -1)" "PRE FALHOU: radar_penetracao_por_municipio viva"
eq "A8c a divergente segue intacta" "$(PD divergente -qAt -c "SELECT municipio_codigo FROM public.radar_penetracao_por_municipio('2026-10');")" "OUTRA"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_PENETRACAO_CONCORRENTES_PROVA_OK"
[ "$FAIL" -eq 0 ]
