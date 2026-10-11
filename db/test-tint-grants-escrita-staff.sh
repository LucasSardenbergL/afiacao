#!/usr/bin/env bash
# PROVA — 20261011120000_tint_grants_escrita_staff.sql [money-path]
#
# O que prova: staff autenticado (PostgREST) não consegue mais mexer no piso do tint_gate_revalida
# pelas tabelas do catálogo — e o que o app usa de verdade continua funcionando.
#
# Pilha = a de PROD: schema-snapshot (09/10: view da Fase 5 + gate com preco_piso_legado + CHECK do
# carimbo) + 20261010120000 (#2915, triggers do tombstone) + a migration sob teste. ACL espelhando o
# relacl de prod (medido 2026-10-11): anon/authenticated = arwdDxtm nas 5 tabelas.
#
# Sondas — cada uma numa transação com ROLLBACK: o DML como staff e, NA MESMA transação, o GATE REAL
# (tint_gate_revalida como service_role) para o item manual que o ataque quer destravar. O veredito
# é "<dml>/<gate>" — o dinheiro é medido no gate, não nas colunas da view (achado do Codex no #2915).
#   M1    P1-b do Codex: INSERT de linha ATIVA na subcoleção '1' em K31 (chave SEM legado), preço 50
#         → manual 80 em K31 (piso hoje = calc 102.5)
#   M1API o mesmo M1 conectado como authenticator (o caminho real do PostgREST)
#   M2    P1-a, lado receita: tint_formula_itens.qtd_ml 10→1 na SL de K1 → manual 101 em K1
#   M3    P1-a, lado corante: tint_corantes.volume_total_ml 810→8100 → manual 101 em K1
#   D1    DELETE da fórmula SL de K31
#   TR    TRUNCATE de tint_formula_itens (TRUNCATE não passa por RLS: apagaria TODA receita)
#   L1    legítimo — TintMapping:411 grava tint_corantes.omie_product_id (TEM de seguir passando)
#   L2    legítimo — TintPricing grava tint_skus.margem_pct (TEM de seguir passando)
#   S1    leitura de staff segue (K31 tem 2 linhas visíveis)
#   GK31/GK1  controle sem DML: os manuais 80 e 101 são BARRADOS sem ataque (prova que o gate morde)
#
# Cenários (todos na MESMA invocação — o controle verde vem antes de qualquer sabotagem):
#   B0  baseline SEM a migration: M1/M1API/M2/M3 = PASSOU/aceito (o furo reproduzido), D1/TR passam
#   T0  migration REAL: aplica com o marcador; M*/D1/TR = NEGADO, L1/L2 passam, gate barra
#   T1-T5  CAMADA 1 (o detector): migration sabotada por sed tem de ABORTAR na pós-condição —
#          T1 esquece tint_formulas · T2 tira o GRANT da coluna do TintMapping · T3 revoga UPDATE
#          de tint_skus (quebraria o TintPricing) · T4 esquece anon · T5 tira o SELECT (balcão vazio)
#   F1-F5  CAMADA 2 (as sondas): sobre a migration real, devolve UM privilégio e exige que caia
#          EXATAMENTE a sonda daquele privilégio (contada contra o contrato do T0)
#
# Uso: db/test-tint-grants-escrita-staff.sh   (PGBIN_OVERRIDE=<dir>; PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5451}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-tintgrants.XXXXXX")"
DATA="$TMP/data"
MIG_TOMB="$REPO_ROOT/supabase/migrations/20261010120000_tint_formulas_tombstone_fase5_imutavel.sql"
MIG="$REPO_ROOT/supabase/migrations/20261011120000_tint_grants_escrita_staff.sql"
export LC_ALL=C LANG=C

for f in "$MIG_TOMB" "$MIG"; do [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }; done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c lc_messages=C" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }
PU() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U authenticator -v ON_ERROR_STOP=1 "$@"; }  # como o PostgREST

# ── template: stubs + prelude + snapshot + ACL de prod + seed + #2915 ─────────────────────────────
PA -q -d postgres -c "CREATE DATABASE tpl_base" >/dev/null
T() { PA -d tpl_base "$@"; }
T -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T -q --single-transaction -f "$TMP/snap.sql" >/dev/null

# Pré-condição: o snapshot é a pilha de prod que esta migration pressupõe.
PRE="$(T -tA -c "SELECT (position('fase5_geracao_legada' in pg_get_viewdef('public.v_tint_formula_canonica'::regclass)) > 0)::text
                 || '/' || (position('preco_piso_legado' in pg_get_functiondef('public.tint_gate_revalida'::regproc)) > 0)::text
                 || '/' || (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tint_formulas'::regclass AND NOT tgisinternal)::text")"
[ "$PRE" = "true/true/0" ] || { echo "✗ pré-condição: snapshot sem a view da Fase 5 / gate sem o piso / já com trigger ($PRE)"; exit 1; }

T -q <<'SQL' >/dev/null
-- relacl de PROD (psql-ro 2026-10-11): anon/authenticated = arwdDxtm nas 5 tabelas do catálogo.
-- O snapshot não carrega GRANTs.
GRANT ALL ON public.tint_formulas, public.tint_formula_itens, public.tint_subcolecoes,
             public.tint_corantes, public.tint_skus TO anon, authenticated;
GRANT SELECT ON public.user_roles, public.omie_products, public.sales_orders,
                public.tint_produtos, public.tint_bases, public.tint_embalagens TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;   -- o gate roda como service_role
ALTER ROLE service_role BYPASSRLS;
-- O PostgREST conecta como authenticator e troca de papel.
ALTER ROLE authenticator LOGIN NOINHERIT;
GRANT authenticated, service_role TO authenticator;

INSERT INTO auth.users (id) VALUES
  ('5aff0000-0000-0000-0000-000000000001'),   -- staff (employee) que faz o PATCH
  ('33333333-3333-3333-3333-333333333333');   -- cliente do pedido
INSERT INTO public.user_roles (user_id, role) VALUES
  ('5aff0000-0000-0000-0000-000000000001','employee'),
  ('33333333-3333-3333-3333-333333333333','customer');

INSERT INTO public.tint_subcolecoes (id, account, id_subcolecao_sayersystem, descricao) VALUES
  ('5c000000-0000-0000-0000-000000000001','oben','SL','SL'),
  ('0d000000-0000-0000-0000-000000000001','oben','1','SAYERLACK');
INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, valor_unitario, ativo, account, is_tintometric, tint_type) VALUES
  ('0b000000-0000-0000-0000-00000000ba5e', 900001,'BASE-OK','Base OK',   100, true, 'oben', true, 'base'),
  ('0c000000-0000-0000-0000-0000000c0c01', 900003,'COR-OK','Corante OK', 200, true, 'oben', true, 'corante');
INSERT INTO public.tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','oben','WPOK','Corante OK', 810, '0c000000-0000-0000-0000-0000000c0c01');
INSERT INTO public.tint_produtos   (id, account, cod_produto, descricao) VALUES ('a0000000-0000-0000-0000-000000000001','oben','P1','Produto 1');
INSERT INTO public.tint_bases      (id, account, id_base_sayersystem, descricao) VALUES ('a0000000-0000-0000-0000-000000000002','oben','B1','Base 1');
INSERT INTO public.tint_embalagens (id, account, id_embalagem_sayersystem, descricao, volume_ml) VALUES ('a0000000-0000-0000-0000-0000000000e1','oben','E900A','Galao 900A',900);
INSERT INTO public.tint_skus (id, account, produto_id, base_id, embalagem_id, omie_product_id) VALUES
  ('50000000-0000-0000-0000-00000000000a','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0b000000-0000-0000-0000-00000000ba5e');

-- K1: SL válida (calc 100 + 10ml×200/810 = 102.469 → ceil10 102.5) × geração '1' CSV 150, que a
--     Fase 5 carimba logo abaixo (piso = LEAST(102.5, 150) = 102.5).
-- K31: SL válida × personalizada 70 × SEM geração '1' (NULL-preserving: piso = calc 102.5).
INSERT INTO public.tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id, preco_final_sayersystem) VALUES
  ('f1000000-0000-0000-0000-00000000005a','oben','K1','AZUL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f1000000-0000-0000-0000-000000000019','oben','K1','AZUL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',150),
  ('f0310000-0000-0000-0000-00000000005a','oben','K31','PISONULL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0310000-0000-0000-0000-0000000000e0','oben','K31','PISONULL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1',NULL,'50000000-0000-0000-0000-00000000000a',70);
INSERT INTO public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml) VALUES
  ('f1000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f1000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0310000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10);
-- Fase 5: carimba a geração '1' de K1 (antes do #2915, que congela o carimbo).
UPDATE public.tint_formulas SET desativada_em = now() - interval '1 day', desativada_motivo = 'fase5_geracao_legada'
 WHERE id = 'f1000000-0000-0000-0000-000000000019';
INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, omie_pedido_id, created_at, subtotal, total, items) VALUES
  ('a5000000-0000-0000-0000-000000000012','33333333-3333-3333-3333-333333333333','5aff0000-0000-0000-0000-000000000001','oben','rascunho', NULL, now(), 0, 0, '[]'::jsonb);
SQL

T -q -f "$MIG_TOMB" >/dev/null || { echo "✗ setup: a migration do #2915 não aplicou sobre o snapshot"; exit 1; }

SEED="$(T -tA -c "SELECT (SELECT id::text FROM v_tint_formula_canonica WHERE cor_id='K1')
                 || '/' || COALESCE((SELECT preco_csv_legado::text FROM v_tint_formula_canonica WHERE cor_id='K1'),'∅')
                 || '/' || COALESCE((SELECT preco_csv_legado::text FROM v_tint_formula_canonica WHERE cor_id='K31'),'∅')
                 || '/' || (ceil(((public.get_tint_price('f1000000-0000-0000-0000-00000000005a'))->>'precoFinal')::float8 * 10) / 10)::text")"
[ "$SEED" = "f1000000-0000-0000-0000-00000000005a/150/∅/102.5" ] \
  || { echo "✗ seed: esperado canônica SL de K1, csv K1=150, csv K31=∅, calc K1=102.5 — veio $SEED"; exit 1; }

FALHAS=0; PASSOU=0
ok()  { echo "  ✓ $*"; PASSOU=$((PASSOU + 1)); }
bad() { echo "  ✗ $*"; FALHAS=$((FALHAS + 1)); }
novo_db() { PA -q -d postgres -c "DROP DATABASE IF EXISTS $2" -c "CREATE DATABASE $2 TEMPLATE $1" >/dev/null; }

CLIENTE='33333333-3333-3333-3333-333333333333'
SO_EMPTY='a5000000-0000-0000-0000-000000000012'
ITEM_K31='[{"omie_codigo_produto":900001,"tint_cor_id":"K31","valor_unitario":80,"tint_price_source":"manual"}]'
ITEM_K1='[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":101,"tint_price_source":"manual"}]'

# Uma sonda: $1 db · $2 rótulo · $3 quem (staff|api) · $4 tipo (dml|trunc|select) · $5 SQL · $6 item
# do gate ('-' = sem gate). Imprime "<rótulo>=<dml>/<gate>", com dml ∈ PASSOU (≥1 linha) · ZERO ·
# NEGADO (42501 de PRIVILÉGIO) · BLOQ_TRIGGER (o 42501 do #2915) · ERRO:<sqlstate> · <contagem>
# (select). O gate roda como service_role na MESMA transação, depois do DML. Sempre ROLLBACK.
sonda() {
  local db="$1" rot="$2" quem="$3" tipo="$4" sql="$5" item="$6" run=PA pre="" corpo gate out dml g
  [ "$quem" = "api" ] && run=PU
  [ "$quem" = "staff" ] && pre="SET LOCAL lc_messages = 'C';"
  case "$tipo" in
    select) corpo="SELECT count(*) INTO n FROM ($sql) q; RAISE NOTICE 'DML=%', n;" ;;
    trunc)  corpo="$sql; RAISE NOTICE 'DML=PASSOU';" ;;
    *)      corpo="$sql; GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'DML=%', CASE WHEN n > 0 THEN 'PASSOU' ELSE 'ZERO' END;" ;;
  esac
  if [ "$item" = "-" ]; then
    gate="SELECT 'GATE=-';"
  else
    gate="SELECT 'GATE=' || CASE WHEN (public.tint_gate_revalida('oben', '$CLIENTE', '$SO_EMPTY', 'criacao', '$item'::jsonb)->>'ok')::boolean THEN 'aceito' ELSE 'barrado' END;"
  fi
  out="$("$run" -d "$db" -tA 2>&1 <<SQL || true
BEGIN;
$pre
SET LOCAL request.jwt.claim.sub = '5aff0000-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
DO \$s\$
DECLARE n bigint := 0;
BEGIN
  $corpo
EXCEPTION
  WHEN insufficient_privilege THEN
    IF SQLERRM LIKE 'tint_tombstone_fase5_imutavel:%' THEN RAISE NOTICE 'DML=BLOQ_TRIGGER';
    ELSIF SQLERRM LIKE 'permission denied for %' THEN RAISE NOTICE 'DML=NEGADO';
    ELSE RAISE NOTICE 'DML=ERRO:42501:%', left(SQLERRM, 60); END IF;
  WHEN OTHERS THEN RAISE NOTICE 'DML=ERRO:%', SQLSTATE;
END \$s\$;
RESET ROLE;
SET LOCAL ROLE service_role;
$gate
ROLLBACK;
SQL
)"
  dml="$(printf '%s\n' "$out" | sed -n 's/^\(NOTICE:  \)\{0,1\}DML=//p' | head -1 | tr ' ' '_')"
  g="$(printf '%s\n' "$out" | sed -n 's/^GATE=//p' | head -1)"
  echo "$rot=${dml:-SEM_SAIDA}/${g:-SEM_SAIDA}"
}

INS_1="INSERT INTO public.tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id, preco_final_sayersystem) VALUES ('f0310000-0000-0000-0000-0000000000a1', 'oben', 'K31', 'PISONULL', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-0000000000e1', '0d000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000a', 50)"

roda_sondas() {
  local db="$1"
  sonda "$db" GK31  staff dml   "PERFORM 1"  "$ITEM_K31"
  sonda "$db" GK1   staff dml   "PERFORM 1"  "$ITEM_K1"
  sonda "$db" S1    staff select "SELECT 1 FROM public.tint_formulas WHERE cor_id = 'K31'" -
  sonda "$db" M1    staff dml   "$INS_1"     "$ITEM_K31"
  sonda "$db" M1API api   dml   "$INS_1"     "$ITEM_K31"
  sonda "$db" M2    staff dml   "UPDATE public.tint_formula_itens SET qtd_ml = 1 WHERE formula_id = 'f1000000-0000-0000-0000-00000000005a'" "$ITEM_K1"
  sonda "$db" M3    staff dml   "UPDATE public.tint_corantes SET volume_total_ml = 8100 WHERE id = 'c0000000-0000-0000-0000-000000000001'" "$ITEM_K1"
  sonda "$db" D1    staff dml   "DELETE FROM public.tint_formulas WHERE id = 'f0310000-0000-0000-0000-00000000005a'" -
  sonda "$db" TR    staff trunc "TRUNCATE public.tint_formula_itens" -
  sonda "$db" L1    staff dml   "UPDATE public.tint_corantes SET omie_product_id = omie_product_id WHERE id = 'c0000000-0000-0000-0000-000000000001'" -
  sonda "$db" L2    staff dml   "UPDATE public.tint_skus SET margem_pct = margem_pct WHERE id = '50000000-0000-0000-0000-00000000000a'" -
}

# Contratos (rótulo=veredito). O do T0 é o contrato PROTEGIDO, contra o qual F1-F5 são contados.
ESP_B0="GK31=PASSOU/barrado GK1=PASSOU/barrado S1=2/- M1=PASSOU/aceito M1API=PASSOU/aceito M2=PASSOU/aceito M3=PASSOU/aceito D1=PASSOU/- TR=PASSOU/- L1=PASSOU/- L2=PASSOU/-"
ESP_T0="GK31=PASSOU/barrado GK1=PASSOU/barrado S1=2/- M1=NEGADO/barrado M1API=NEGADO/barrado M2=NEGADO/barrado M3=NEGADO/barrado D1=NEGADO/- TR=NEGADO/- L1=PASSOU/- L2=PASSOU/-"
# ⚠️ "PERFORM 1" afeta 1 linha (ROW_COUNT=1) ⇒ PASSOU — é só o veículo do gate sem DML.

# Rótulos cujo veredito difere do contrato $2, na saída $1 (ordenados, separados por vírgula).
diverge() {
  local saida="$1" esp="$2" par rot val lin res=""
  for par in $esp; do
    rot="${par%%=*}"; val="${par#*=}"
    lin="$(printf '%s\n' "$saida" | grep -E "^$rot=" | head -1)"
    [ "${lin#*=}" = "$val" ] || res="$res,$rot"
  done
  echo "${res#,}"
}

echo "▶ B0 — baseline SEM a migration (o furo reproduzido)"
novo_db tpl_base b0
S_B0="$(roda_sondas b0)"
D="$(diverge "$S_B0" "$ESP_B0")"
if [ -z "$D" ]; then ok "sem a migration: staff destrava o manual barrado por INSERT ativo na '1' (M1/M1API), por qtd_ml (M2) e por volume (M3); DELETE e TRUNCATE passam"
else bad "baseline inesperado em [$D]:"; printf '%s\n' "$S_B0" | sed 's/^/      /'; fi

echo "▶ T0 — migration REAL"
novo_db tpl_base t0
OUT_T0="$(PA -d t0 -tA -f "$MIG" 2>&1)" && RC=0 || RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT_T0" | grep -q 'TINT_GRANTS_ESCRITA_STAFF_OK'; then ok "aplica com o marcador de fim (exit 0)"
else bad "migration real não aplicou (rc=$RC): $(printf '%s' "$OUT_T0" | tail -3)"; fi
S_T0="$(roda_sondas t0)"
D="$(diverge "$S_T0" "$ESP_T0")"
if [ -z "$D" ]; then ok "com a migration: os 4 ataques e D1/TR dão 42501 de privilégio, o gate segue barrando, L1/L2 (TintMapping/TintPricing) e a leitura seguem"
else bad "contrato protegido falhou em [$D]:"; printf '%s\n' "$S_T0" | sed 's/^/      /'; fi
OUT_RE="$(PA -d t0 -tA -f "$MIG" 2>&1)" && RC=0 || RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT_RE" | grep -q 'TINT_GRANTS_ESCRITA_STAFF_OK'; then ok "idempotente: re-aplicar passa de novo"
else bad "re-apply falhou (rc=$RC)"; fi
PA -q -d postgres -c "CREATE DATABASE tpl_mig TEMPLATE t0" >/dev/null

# Só roda as sabotagens se o controle (T0) ficou verde NESTA invocação — senão vermelho não prova nada.
if [ "$FALHAS" -gt 0 ]; then
  echo "✗ controle não está verde — falsificações NÃO rodadas"; echo "RESULTADO: $PASSOU ok / $FALHAS fail"; exit 1
fi

echo "▶ T1-T5 — CAMADA 1: a pós-condição tem de ABORTAR a migration sabotada"
# $1 rótulo · $2 expressão sed · $3 trecho que a pós-condição tem de citar
detector() {
  local rot="$1" expr="$2" cita="$3" sab="$TMP/sab-$1.sql" out rc
  sed -E "$expr" "$MIG" > "$sab"
  if cmp -s "$MIG" "$sab"; then bad "$rot: o sed não mudou nada — sabotagem inerte"; return; fi
  novo_db tpl_base "d_$(echo "$rot" | tr '[:upper:]' '[:lower:]')"
  out="$(PA -d "d_$(echo "$rot" | tr '[:upper:]' '[:lower:]')" -tA -f "$sab" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'pós-condição tint_grants_escrita_staff:' \
     && printf '%s' "$out" | grep -qF "$cita" && ! printf '%s' "$out" | grep -q 'TINT_GRANTS_ESCRITA_STAFF_OK'; then
    ok "$rot: abortou citando \"$cita\""
  else bad "$rot: esperava abortar citando \"$cita\" (rc=$rc): $(printf '%s' "$out" | grep -E 'ERROR|ERRO' | head -2)"; fi
}
detector T1 's/^REVOKE ALL ON TABLE public\.tint_formulas, /REVOKE ALL ON TABLE /' 'em public.tint_formulas'
detector T2 '/^GRANT UPDATE \(omie_product_id\)/d' 'PERDEU UPDATE de tint_corantes.omie_product_id'
detector T3 's/^REVOKE TRUNCATE, TRIGGER ON public\.tint_skus FROM/REVOKE TRUNCATE, TRIGGER, UPDATE ON public.tint_skus FROM/' 'PERDEU UPDATE em public.tint_skus'
detector T4 's/^  FROM PUBLIC, anon, authenticated;/  FROM PUBLIC, authenticated;/' 'anon ainda tem'
detector T5 '/^GRANT SELECT ON TABLE public\.tint_formulas/,/TO authenticated;/d' 'authenticated PERDEU SELECT'

echo "▶ F1-F5 — CAMADA 2: devolver UM privilégio derruba EXATAMENTE a sonda dele"
# $1 rótulo · $2 GRANT que reabre · $3 rótulos que têm de divergir do contrato T0 (ordem do roda_sondas)
falsifica() {
  local rot="$1" grant="$2" esperado="$3" db s d
  db="f_$(echo "$rot" | tr '[:upper:]' '[:lower:]')"
  novo_db tpl_mig "$db"
  PA -q -d "$db" -c "$grant" >/dev/null
  s="$(roda_sondas "$db")"
  d="$(diverge "$s" "$ESP_T0")"
  if [ "$d" = "$esperado" ]; then ok "$rot ($grant) → derruba exatamente {$d}"
  else bad "$rot ($grant): esperava derrubar {$esperado}, derrubou {${d:-nada}}"; printf '%s\n' "$s" | sed 's/^/      /'; fi
}
falsifica F1 "GRANT INSERT ON public.tint_formulas TO authenticated"                   "M1,M1API"
falsifica F2 "GRANT UPDATE ON public.tint_formula_itens TO authenticated"              "M2"
falsifica F3 "GRANT UPDATE (volume_total_ml) ON public.tint_corantes TO authenticated" "M3"
falsifica F4 "GRANT DELETE ON public.tint_formulas TO authenticated"                   "D1"
falsifica F5 "GRANT TRUNCATE ON public.tint_formula_itens TO authenticated"            "TR"

echo
echo "RESULTADO: $PASSOU ok / $FALHAS fail"
[ "$FALHAS" -eq 0 ] || exit 1
echo "TINT_GRANTS_ESCRITA_STAFF_PROVA_OK"
