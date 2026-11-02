#!/usr/bin/env bash
# Prova PG17 da fin_saldo_titulos_por_status (plano v4, lote 13 — C6, entrega 1).
#
# A RPC substitui a soma paginada no navegador (somarSaldoPorStatus: `.eq(company).in(status)`
# + `total += saldo ?? 0`). Prova, com a migration REAL e a ACL que o Supabase dá por default:
#   - MESMO universo do código atual (status NULL, caixa, espaço, duplicata, fora do conjunto);
#   - soma EXATA em centavos (string decimal) contra dois oráculos: o decimal exato e o laço
#     float8 em ordem de id que imita o JS — os dois batem nos valores reais; no limite numérico
#     só o exato acerta, e é o que a RPC devolve;
#   - ausente ≠ zero: empresa sem acesso → `sem_acesso`; inexistente → `desconhecida`; saldo
#     NULL contado em `n_saldo_nulo` (o compositor degrada para INDISPONIVEL, nunca 0);
#   - ACL: anon/service_role/PUBLIC sem EXECUTE (privilégio, não só o gate), authenticated com;
#   - tudo sob `SET ROLE authenticated` + identidade por request.jwt.claim.sub, com RLS ligada.
# Sabotagens INLINE (cada uma exige o SEU vermelho, depois de o controle verde rodar nesta mesma
# invocação): sem gate, sem filtro de empresa, anon com EXECUTE, saldo como número, sem
# `desconhecida`, NULL virando 0, e a postcondição da migration recusando a versão sem gate.
#
#   bash db/test-fin-saldo-titulos-por-status.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5473}"
SLUG="fin-saldo-titulos"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -q -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
# Nenhum assert espera vazio: valor vazio = a consulta FALHOU (erro SQL/timeout) e sai marcado 💥, para
# que uma sabotagem nunca conte erro incidental como o vermelho que ela exige (parecer Codex).
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; elif [ -z "$2" ]; then bad "$1 — 💥 consulta sem resultado (erro de execução)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20261101210000_fin_saldo_titulos_por_status.sql"
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

M=11111111-1111-1111-1111-111111111111    # master
E=22222222-2222-2222-2222-222222222222    # employee
P1=33333333-3333-3333-3333-333333333333   # fin_permissoes só da oben
PT=44444444-4444-4444-4444-444444444444   # fin_permissoes pode_ver_todas_empresas
N=55555555-5555-5555-5555-555555555555    # autenticado sem papel nem permissão

# ── base Supabase: roles, auth.uid() como o do Supabase (lê request.jwt.*), ACL default ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
-- O default privilege do Supabase concede EXECUTE de toda função nova do public aos três papéis
-- (além do PUBLIC do Postgres): sem isto o REVOKE da migration não teria o que revogar e o
-- assert de ACL passaria por ausência.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
SQL

# ── pré-requisitos: tabelas e helper de acesso como em PROD (psql-ro, 2026-11-01) ──
# `saldo` aqui é coluna SIMPLES e nullable (em prod é GERADA de valor_documento NOT NULL): o stub é
# um superconjunto dos estados de prod, para provar o tratamento de NULL que prod não produz hoje.
P -q <<'SQL'
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
CREATE TABLE public.fin_permissoes (user_id uuid PRIMARY KEY, empresas text[], pode_ver_todas_empresas boolean DEFAULT false);
CREATE TABLE public.fin_contas_receber (
  id bigserial PRIMARY KEY, company text NOT NULL, status_titulo text DEFAULT 'ABERTO', saldo numeric(15,2));
CREATE TABLE public.fin_contas_pagar (
  id bigserial PRIMARY KEY, company text NOT NULL, status_titulo text DEFAULT 'ABERTO', saldo numeric(15,2));
CREATE INDEX ON public.fin_contas_receber (company, status_titulo);
CREATE INDEX ON public.fin_contas_pagar (company, status_titulo);

-- Verbatim de pg_get_functiondef em prod (2026-11-01).
CREATE OR REPLACE FUNCTION public.fin_user_can_access(check_company text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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

ALTER TABLE public.fin_contas_receber ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_contas_pagar ENABLE ROW LEVEL SECURITY;
CREATE POLICY fin_cr_select ON public.fin_contas_receber FOR SELECT USING (fin_user_can_access(company));
CREATE POLICY fin_cr_service ON public.fin_contas_receber USING (auth.role() = 'service_role');
CREATE POLICY fin_cp_select ON public.fin_contas_pagar FOR SELECT USING (fin_user_can_access(company));
CREATE POLICY fin_cp_service ON public.fin_contas_pagar USING (auth.role() = 'service_role');
SQL

# ── seed (como postgres): cada linha existe para UM caso ──
P -q <<SQL
INSERT INTO public.user_roles VALUES ('$M','master'), ('$E','employee');
INSERT INTO public.fin_permissoes VALUES ('$P1', ARRAY['oben'], false), ('$PT', NULL, true);
INSERT INTO public.fin_contas_receber (company, status_titulo, saldo) VALUES
  ('oben','A VENCER',100.10), ('oben','A VENCER',200.20), ('oben','A VENCER',0.30),
  ('oben','ATRASADO',50.05), ('oben','ATRASADO',-10.00),          -- negativo entra como está
  ('oben','VENCE HOJE',4.40), ('oben','ABERTO',1.11), ('oben','VENCIDO',2.22), ('oben','PARCIAL',3.33),
  ('oben',NULL,999.99),                                            -- status NULL: fora nos dois caminhos
  ('oben','atrasado',7.77), ('oben',' ATRASADO',8.88),             -- caixa/espaço: comparação exata
  ('oben','RECEBIDO',5000.00), ('oben','CANCELADO',300.00),        -- fora do conjunto aberto
  ('colacor','RECEBIDO',10.00),                                    -- existe, mas sem título aberto
  ('colacor_sc','ATRASADO',30.00), ('colacor_sc','ATRASADO',NULL), -- grupo com 1 saldo NULL
  ('colacor_sc','VENCE HOJE',NULL);                                -- grupo só de NULL
INSERT INTO public.fin_contas_pagar (company, status_titulo, saldo) VALUES
  ('oben','A VENCER',1000.00), ('oben','ATRASADO',250.50), ('oben','PAGO',9999.99),
  ('colacor_sc','A VENCER',12.34),
  ('limite','A VENCER',9999999999999.99);                          -- máximo de numeric(15,2)
INSERT INTO public.fin_contas_pagar (company, status_titulo, saldo)
  SELECT 'limite','A VENCER',0.01 FROM generate_series(1,3427);   -- + 3.427 centavos (contraexemplo Codex)
SQL

# ── aplicar a migration REAL (com a postcondição: exige um master no seed) ──
P --single-transaction -q -f "$MIG" 2>"$TMPD/apply.err" || { cat "$TMPD/apply.err"; echo "migration REAL falhou ao aplicar"; exit 1; }
grep -q "fin_saldo_titulos_por_status ok" "$TMPD/apply.err" || { cat "$TMPD/apply.err"; echo "postcondição não emitiu o NOTICE de ok"; exit 1; }
echo "migration aplicada (postcondição ok): $(basename "$MIG")"

# ── utilitários de teste (fora da migration) ──
P -q <<'SQL'
-- Compositor: o que o cliente da entrega 2 fará com o envelope. Empresa não-ok → o estado;
-- algum grupo do conjunto com saldo NULL → INDISPONIVEL; senão soma decimal (sem grupo = 0.00).
CREATE FUNCTION public.t_compor(j jsonb, tab text, co text, sts text[]) RETURNS text LANGUAGE sql AS $f$
  SELECT CASE
    WHEN (SELECT e->>'estado' FROM jsonb_array_elements(j->'empresas') e WHERE e->>'company' = co) IS DISTINCT FROM 'ok'
      THEN coalesce(upper((SELECT e->>'estado' FROM jsonb_array_elements(j->'empresas') e WHERE e->>'company' = co)), 'AUSENTE_DO_ENVELOPE')
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(j->'grupos') g
                  WHERE g->>'tabela' = tab AND g->>'company' = co AND g->>'status_titulo' = ANY(sts)
                    AND (g->>'n_saldo_nulo')::bigint > 0)
      THEN 'INDISPONIVEL'
    ELSE (SELECT coalesce(sum((g->>'saldo')::numeric), 0)::numeric(20,2)::text FROM jsonb_array_elements(j->'grupos') g
           WHERE g->>'tabela' = tab AND g->>'company' = co AND g->>'status_titulo' = ANY(sts))
  END $f$;
-- Oráculo EXATO (como postgres, sem RLS): mesma seleção, soma decimal; NULL presente → INDISPONIVEL.
CREATE FUNCTION public.t_exato(tab text, co text, sts text[]) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  EXECUTE format('SELECT count(*) FILTER (WHERE saldo IS NULL) AS nulos, coalesce(sum(saldo),0)::numeric(20,2)::text AS s
                    FROM public.%I WHERE company = $1 AND status_titulo = ANY($2)', tab) INTO r USING co, sts;
  RETURN CASE WHEN r.nulos > 0 THEN 'INDISPONIVEL' ELSE r.s END;
END $f$;
-- Oráculo LEGADO: o laço do JS (`total += saldo ?? 0` em float8, ordem de id), arredondado ao centavo.
CREATE FUNCTION public.t_legado(tab text, co text, sts text[]) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE t float8 := 0; v numeric;
BEGIN
  FOR v IN EXECUTE format('SELECT saldo FROM public.%I WHERE company = $1 AND status_titulo = ANY($2) ORDER BY id', tab) USING co, sts LOOP
    t := t + coalesce(v, 0)::float8;
  END LOOP;
  RETURN round(t::numeric, 2)::numeric(20,2)::text;
END $f$;
GRANT EXECUTE ON FUNCTION public.t_compor(jsonb, text, text, text[]) TO authenticated;
SQL

ABERTO="ARRAY['A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL']"   # OPEN_TITLE_STATUSES
VENC="ARRAY['ATRASADO']"                                                          # VENCIDO_TITLE_STATUSES
EMP3="ARRAY['oben','colacor','colacor_sc']"

# Executa SQL como `authenticated` com a identidade dada (vazia = sem identidade).
como() { local uid="$1"; shift; Pq -c "SET request.jwt.claim.sub = '$uid'; SET ROLE authenticated; $*"; }
rpc()  { echo "public.fin_saldo_titulos_por_status($1, $2)"; }

# ══ asserts (rodados 1× como CONTROLE com a migration real; cada sabotagem re-roda o seu) ══
a_paridade() {  # A1: master, 3 empresas × 2 tabelas × 2 conjuntos = compositor da RPC == oráculo exato == legado
  local tab co sts nome got exato legado
  for tab in fin_contas_receber fin_contas_pagar; do
    for co in oben colacor colacor_sc; do
      for sts in ABERTO VENC; do
        nome=$([ "$tab" = fin_contas_receber ] && echo receber || echo pagar)
        got=$(como "$M" "SELECT public.t_compor($(rpc "$EMP3" "${!sts}"), '$nome', '$co', ${!sts});")
        exato=$(Pq -c "SELECT public.t_exato('$tab', '$co', ${!sts});")
        eq "A1 $nome/$co/$sts: RPC = oráculo exato" "$got" "$exato"
        if [ "$exato" != "INDISPONIVEL" ]; then
          legado=$(Pq -c "SELECT public.t_legado('$tab', '$co', ${!sts});")
          eq "A1 $nome/$co/$sts: RPC = soma legada do JS (centavo)" "$got" "$legado"
        fi
      done
    done
  done
}
a_valores_fixos() {  # A2: os números esperados escritos à mão (o oráculo não é a própria RPC)
  eq "A2 oben CR aberto"   "$(como "$M" "SELECT public.t_compor($(rpc "$EMP3" "$ABERTO"), 'receber', 'oben', $ABERTO);")" "351.71"
  eq "A2 oben CR vencido"  "$(como "$M" "SELECT public.t_compor($(rpc "$EMP3" "$VENC"), 'receber', 'oben', $VENC);")" "40.05"
  eq "A2 oben CP aberto"   "$(como "$M" "SELECT public.t_compor($(rpc "$EMP3" "$ABERTO"), 'pagar', 'oben', $ABERTO);")" "1250.50"
  eq "A2 colacor CR aberto (ok, sem título aberto = 0 legítimo)" \
     "$(como "$M" "SELECT public.t_compor($(rpc "$EMP3" "$ABERTO"), 'receber', 'colacor', $ABERTO);")" "0.00"
}
a_limite() {  # A3: limite numérico — string decimal exata; o float8 legado erra
  local got legado
  got=$(como "$M" "SELECT public.t_compor($(rpc "ARRAY['limite']" "$ABERTO"), 'pagar', 'limite', $ABERTO);")
  eq "A3 limite: RPC exata" "$got" "10000000000034.26"
  legado=$(Pq -c "SELECT public.t_legado('fin_contas_pagar', 'limite', $ABERTO);")
  if [ "$legado" != "$got" ]; then ok "A3 limite: legado float8 diverge ($legado) — a string decimal é necessária"; else bad "A3 limite: legado devia divergir"; fi
  eq "A3 saldo é STRING no JSON" "$(como "$M" "SELECT jsonb_typeof($(rpc "ARRAY['limite']" "$ABERTO")->'grupos'->0->'saldo');")" "string"
}
a_nulo() {  # A4: saldo NULL nunca vira 0
  eq "A4 colacor_sc CR aberto com saldo NULL → INDISPONIVEL" \
     "$(como "$M" "SELECT public.t_compor($(rpc "$EMP3" "$ABERTO"), 'receber', 'colacor_sc', $ABERTO);")" "INDISPONIVEL"
  eq "A4 grupo ATRASADO: n_saldo_nulo=1, saldo dos não-nulos" \
     "$(como "$M" "SELECT g->>'n_titulos'||'|'||(g->>'n_saldo_nulo')||'|'||coalesce(g->>'saldo','(null)') FROM jsonb_array_elements($(rpc "ARRAY['colacor_sc']" "$VENC")->'grupos') g WHERE g->>'tabela'='receber';")" "2|1|30.00"
  eq "A4 grupo só de NULL: saldo JSON null, não 0" \
     "$(como "$M" "SELECT jsonb_typeof(g->'saldo')||'|'||(g->>'n_saldo_nulo') FROM jsonb_array_elements($(rpc "ARRAY['colacor_sc']" "ARRAY['VENCE HOJE']")->'grupos') g WHERE g->>'tabela'='receber';")" "null|1"
}
a_universo() {  # A5: status NULL/caixa/espaço/fora do conjunto e duplicatas
  eq "A5 statuses de oben CR no envelope = só os exatos do conjunto" \
     "$(como "$M" "SELECT string_agg(g->>'status_titulo', ',' ORDER BY g->>'status_titulo') FROM jsonb_array_elements($(rpc "ARRAY['oben']" "$ABERTO")->'grupos') g WHERE g->>'tabela'='receber';")" \
     "A VENCER,ABERTO,ATRASADO,PARCIAL,VENCE HOJE,VENCIDO"
  eq "A5 empresa e status duplicados não dobram a soma" \
     "$(como "$M" "SELECT public.t_compor($(rpc "ARRAY['oben','oben']" "ARRAY['ATRASADO','ATRASADO']"), 'receber', 'oben', $VENC)||'|'||jsonb_array_length($(rpc "ARRAY['oben','oben']" "$VENC")->'empresas');")" "40.05|1"
}
a_desconhecida() {  # A6: empresa sem nenhum título em nenhum status → desconhecida, nunca 0
  eq "A6 empresa inexistente (employee) → desconhecida" \
     "$(como "$E" "SELECT public.t_compor($(rpc "ARRAY['obne']" "$ABERTO"), 'receber', 'obne', $ABERTO);")" "DESCONHECIDA"
}
a_gate() {  # A7: acesso por empresa (o MESMO predicado da RLS), sem perder o que o usuário PODE ver
  eq "A7 P1 (só oben): estados" \
     "$(como "$P1" "SELECT string_agg(e->>'company'||'='||(e->>'estado'), ',' ORDER BY e->>'company') FROM jsonb_array_elements($(rpc "$EMP3" "$ABERTO")->'empresas') e;")" \
     "colacor=sem_acesso,colacor_sc=sem_acesso,oben=ok"
  eq "A7 P1: oben com a soma certa" "$(como "$P1" "SELECT public.t_compor($(rpc "$EMP3" "$ABERTO"), 'receber', 'oben', $ABERTO);")" "351.71"
  eq "A7 P1: nenhum grupo de empresa sem acesso" \
     "$(como "$P1" "SELECT count(*) FROM jsonb_array_elements($(rpc "$EMP3" "$ABERTO")->'grupos') g WHERE g->>'company' <> 'oben';")" "0"
  eq "A7 P1: colacor_sc sem_acesso (nunca 0.00)" "$(como "$P1" "SELECT public.t_compor($(rpc "$EMP3" "$ABERTO"), 'pagar', 'colacor_sc', $ABERTO);")" "SEM_ACESSO"
  eq "A7 PT (todas): colacor_sc CP" "$(como "$PT" "SELECT public.t_compor($(rpc "$EMP3" "$ABERTO"), 'pagar', 'colacor_sc', $ABERTO);")" "12.34"
  eq "A7 N (sem papel): tudo sem_acesso, zero grupos" \
     "$(como "$N" "SELECT (SELECT count(*) FROM jsonb_array_elements(j->'empresas') e WHERE e->>'estado'='sem_acesso')||'|'||jsonb_array_length(j->'grupos') FROM (SELECT $(rpc "$EMP3" "$ABERTO") j) x;")" "3|0"
  eq "A7 sem identidade: tudo sem_acesso" \
     "$(como "" "SELECT (SELECT count(*) FROM jsonb_array_elements(j->'empresas') e WHERE e->>'estado'='sem_acesso')||'|'||jsonb_array_length(j->'grupos') FROM (SELECT $(rpc "$EMP3" "$ABERTO") j) x;")" "3|0"
}
a_filtro() {  # A8: employee (vê tudo pela RLS) pedindo SÓ oben não recebe as outras empresas
  eq "A8 employee pede só oben: grupos só de oben" \
     "$(como "$E" "SELECT string_agg(DISTINCT g->>'company', ',') FROM jsonb_array_elements($(rpc "ARRAY['oben']" "$ABERTO")->'grupos') g;")" "oben"
}
a_acl() {  # A9: privilégio (não só o gate) — anon/service_role/PUBLIC fora, authenticated dentro
  local f="'public.fin_saldo_titulos_por_status(text[],text[])'"
  eq "A9 has_function_privilege anon|service_role|authenticated" \
     "$(Pq -c "SELECT has_function_privilege('anon',$f,'EXECUTE')||'|'||has_function_privilege('service_role',$f,'EXECUTE')||'|'||has_function_privilege('authenticated',$f,'EXECUTE');")" "false|false|true"
  eq "A9 PUBLIC sem EXECUTE no proacl" \
     "$(Pq -c "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $f::regprocedure AND a.grantee = 0;")" "0"
  local r
  r=$(P -q -tA 2>&1 <<SQL || true
SET ROLE anon;
DO \$\$ BEGIN
  PERFORM $(rpc "$EMP3" "$ABERTO");
  RAISE NOTICE 'SENTINELA_ANON_EXECUTOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_ANON_NEGADO';
          WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
  case "$r" in *SENTINELA_ANON_NEGADO*) ok "A9 anon → 42501 por privilégio";; *) bad "A9 anon devia ser negado — veio [$r]";; esac
}
a_entrada() {  # A10: entrada inválida → 22023 (nunca envelope vazio)
  local caso r
  for caso in "NULL::text[], $ABERTO" "ARRAY[]::text[], $ABERTO" "ARRAY['oben',NULL], $ABERTO" "$EMP3, ARRAY[]::text[]" "$EMP3, ARRAY['ATRASADO',NULL]"; do
    r=$(como "$M" "DO \$\$ BEGIN PERFORM public.fin_saldo_titulos_por_status($caso); RAISE NOTICE 'SENTINELA_ENTRADA_ACEITA'; EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'SENTINELA_ENTRADA_RECUSADA'; WHEN OTHERS THEN RAISE; END \$\$;" 2>&1 || true)
    case "$r" in *SENTINELA_ENTRADA_RECUSADA*) ok "A10 recusa ($caso)";; *) bad "A10 devia recusar ($caso) — veio [$r]";; esac
  done
}
a_catalogo() {  # A11: invoker + search_path restrito
  eq "A11 prosecdef|proconfig" \
     "$(Pq -c "SELECT prosecdef||'|'||array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'public.fin_saldo_titulos_por_status(text[],text[])'::regprocedure;")" \
     "false|search_path=pg_catalog, pg_temp"
}

echo "── CONTROLE: migration real ──"
a_paridade; a_valores_fixos; a_limite; a_nulo; a_universo; a_desconhecida; a_gate; a_filtro; a_acl; a_entrada; a_catalogo
[ "$FAIL" = "0" ] || { echo "RESULTADO: $PASS ok / $FAIL fail"; echo "❌ CONTROLE VERMELHO — sabotagens não rodam"; exit 1; }

# ══ sabotagens: aplica a função SABOTADA (só o CREATE..ACL, sem a postcondição), roda o assert
#    do invariante e EXIGE vermelho; depois reaplica a migration real ══
CORPO="$TMPD/corpo.sql"
awk '/^DO \$post\$/{exit} {print}' "$MIG" > "$CORPO"
grep -q 'CREATE OR REPLACE FUNCTION public.fin_saldo_titulos_por_status' "$CORPO" || { echo "corpo não extraído"; exit 1; }

restaurar() { P --single-transaction -q -f "$MIG" >/dev/null 2>&1 || { echo "restauração falhou"; exit 1; }; }
sabotar() {  # $1 rótulo · $2 expressão sed · $3 função de assert · $4 rótulo do assert que TEM de cair por divergência
  local rot="$1" expr="$2" fn="$3" alvo="$4" sab="$TMPD/sab.sql" antes_pass="$PASS" antes_fail="$FAIL"
  sed -E "$expr" "$CORPO" > "$sab"
  if cmp -s "$CORPO" "$sab"; then bad "S $rot — o sed não mudou nada (sabotagem vazia)"; return; fi
  P --single-transaction -q -f "$sab" >/dev/null 2>&1 || { bad "S $rot — versão sabotada não aplicou"; return; }
  "$fn" > "$TMPD/sab.out" 2>&1 || true
  PASS=$antes_pass; FAIL=$antes_fail
  if grep -qE '💥|ERROR|ERRO' "$TMPD/sab.out"; then
    bad "S $rot — erro de execução no assert (não é o vermelho exigido): $(grep -m1 -E '💥|ERROR|ERRO' "$TMPD/sab.out" | head -c 200)"
  elif grep -F '❌' "$TMPD/sab.out" | grep -qF "$alvo — esperado"; then
    ok "S $rot → vermelho por divergência em [$alvo]"
  else
    bad "S $rot — [$alvo] não caiu por divergência com a sabotagem"
  fi
  restaurar
}
echo "── SABOTAGENS ──"
sabotar "sem gate de acesso"         's/IF public\.fin_user_can_access\(v_company\) IS NOT TRUE THEN/IF false THEN/' a_gate 'A7 P1 (só oben): estados'
sabotar "sem filtro de empresa"      's/cr\.company = ANY\(v_ok\)/true/; s/cp\.company = ANY\(v_ok\)/true/' a_filtro 'A8 employee pede só oben: grupos só de oben'
sabotar "anon com EXECUTE"           's/^REVOKE ALL ON FUNCTION (.*) FROM anon;/GRANT EXECUTE ON FUNCTION \1 TO anon;/' a_acl 'A9 has_function_privilege anon|service_role|authenticated'
sabotar "saldo como número JSON"     "s/'saldo', g\.saldo::text\)/'saldo', g.saldo)/" a_limite 'A3 saldo é STRING no JSON'
sabotar "sem estado desconhecida"    's/ELSIF NOT EXISTS \(SELECT 1 FROM public\.fin_contas_receber cr WHERE cr\.company = v_company\)/ELSIF false AND NOT EXISTS (SELECT 1 FROM public.fin_contas_receber cr WHERE cr.company = v_company)/' a_desconhecida 'A6 empresa inexistente (employee) → desconhecida'
sabotar "saldo NULL vira 0"          's/sum\(cr\.saldo\) AS saldo/coalesce(sum(cr.saldo), 0) AS saldo/; s/count\(\*\) FILTER \(WHERE cr\.saldo IS NULL\) AS n_saldo_nulo/0::bigint AS n_saldo_nulo/' a_nulo 'A4 colacor_sc CR aberto com saldo NULL → INDISPONIVEL'
sabotar "search_path público"        's/SET search_path = pg_catalog, pg_temp/SET search_path = public/' a_catalogo 'A11 prosecdef|proconfig'

# A postcondição da migration também tem dente: a versão sem gate não passa nela.
SABPOST="$TMPD/sabpost.sql"
sed -E 's/IF public\.fin_user_can_access\(v_company\) IS NOT TRUE THEN/IF false THEN/' "$MIG" > "$SABPOST"
if cmp -s "$MIG" "$SABPOST"; then bad "S postcondição — sed vazio"
elif P --single-transaction -q -f "$SABPOST" >"$TMPD/sabpost.out" 2>&1; then bad "S postcondição aceitou a versão sem gate"
elif grep -q 'A5 FALHOU' "$TMPD/sabpost.out"; then ok "S postcondição recusa a versão sem gate (A5)"
else bad "S postcondição falhou por outro motivo: $(head -c 300 "$TMPD/sabpost.out")"; fi

# …e a A6 dela confere o multiconjunto de `empresas`: some com as empresas quando há alguma ok
# (grupos intactos, A5 intacta) e a postcondição tem de recusar por A6 (cenário do parecer Codex).
sed -E "s/'empresas', v_empresas,/'empresas', CASE WHEN cardinality(v_ok) > 0 THEN '[]'::jsonb ELSE v_empresas END,/" "$MIG" > "$SABPOST"
if cmp -s "$MIG" "$SABPOST"; then bad "S postcondição/empresas — sed vazio"
elif P --single-transaction -q -f "$SABPOST" >"$TMPD/sabpost.out" 2>&1; then bad "S postcondição aceitou envelope sem empresas"
elif grep -q 'A6 FALHOU' "$TMPD/sabpost.out"; then ok "S postcondição recusa envelope sem empresas (A6)"
else bad "S postcondição/empresas falhou por outro motivo: $(head -c 300 "$TMPD/sabpost.out")"; fi
restaurar

echo "── pós-sabotagem: a real restaurada segue verde ──"
a_gate; a_acl; a_limite

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
