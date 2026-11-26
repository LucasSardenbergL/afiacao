#!/usr/bin/env bash
# PROVA PG17 com FALSIFICAÇÃO — DRE v1.13 (linha `nao_resultado` + mapa próprio por empresa).
#   bash db/test-fin-dre-nao-resultado.sh > /tmp/t.log 2>&1; echo "exit=$?"
# Cobre: supabase/migrations/20261122140000_fin_dre_nao_resultado.sql e
#        db/2026-11-22-fin-dre-mapa-proprio.sql (aplicado como o `db:aplicar`: 1 transação).
# Base: fixture LIDA da prod (mapa vigente + plano de categorias), db/fixtures/fin-dre-mapa-proprio-prod-20261122.sql.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5483}"
SLUG="fin-dre-nao-resultado"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
# locale do CLUSTER parametrizável (igual a db/test-fin-dfc-realizado.sh): `initdb --locale=C` fixo
# prevalecia sobre LC_ALL e a rodada "pt_BR" não provava collation pt_BR. O assert Z0 confere o
# lc_collate efetivo. Rodar nos dois: PG_LOCALE=C e PG_LOCALE=pt_BR.UTF-8 (com LC_ALL igual).
PG_LOCALE="${PG_LOCALE:-C}"
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$PG_LOCALE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20261122140000_fin_dre_nao_resultado.sql"
MAPA="$REPO_ROOT/db/2026-11-22-fin-dre-mapa-proprio.sql"
FIX="$REPO_ROOT/db/fixtures/fin-dre-mapa-proprio-prod-20261122.sql"
TMPD="$(dirname "$DATA")"
for f in "$MIG" "$MAPA" "$FIX"; do [ -f "$f" ] || { echo "FALTA $f"; exit 2; }; done
FONTE="$(sed -n "s/^  v_fonte_esperada  constant text := '\([0-9a-f]\{64\}\)';\$/\1/p" "$MAPA")"
FONTE_SUG="$(sed -n "s/^  v_fonte_sugestor  constant text := '\([0-9a-f]\{64\}\)';\$/\1/p" "$MAPA")"
[ ${#FONTE} -eq 64 ] && [ ${#FONTE_SUG} -eq 64 ] || { echo "fontes esperadas não encontradas no script do mapa"; exit 2; }
echo "═══ setup pronto (PG17 :$PORT, locale $PG_LOCALE) ═══"
eq "Z0 lc_collate do cluster é o pedido" "$(Pq -c "SELECT datcollate FROM pg_database WHERE datname = current_database();")" "$PG_LOCALE"

# ZONA 1 — tabelas como em PROD (psql-ro 2026-11-22: CHECKs da fase 2, UNIQUE, notas/updated_at)
P -q <<'SQL'
CREATE TABLE public.fin_categoria_dre_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc','_default'])),
  omie_codigo text NOT NULL, dre_linha text NOT NULL, notas text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (company, omie_codigo));
ALTER TABLE public.fin_categoria_dre_mapping ADD CONSTRAINT fin_categoria_dre_mapping_dre_linha_check
  CHECK (dre_linha = ANY (ARRAY['receita_bruta','deducoes','cmv','despesas_operacionais','despesas_administrativas',
    'despesas_comerciais','despesas_financeiras','receitas_financeiras','outras_receitas','outras_despesas','impostos',
    'ded_icms','ded_iss','ded_pis','ded_cofins','ded_ipi','das','irpj','csll','fora_dre']));
ALTER TABLE public.fin_categoria_dre_mapping ADD CONSTRAINT fin_categoria_dre_mapping_fora_dre_por_empresa_check
  CHECK (NOT (company = '_default' AND dre_linha = 'fora_dre'));
CREATE TABLE public.fin_categorias (company text, omie_codigo text, descricao text, updated_at timestamptz);
CREATE TABLE public.deploy_atestacoes (request_id text, observado_em timestamptz, edge text, versao text, fonte text, via text);
CREATE FUNCTION public.deploy_atestacoes_janela_viva()
  RETURNS TABLE (request_id text, observado_em timestamptz, edge text, versao text, fonte text, via text)
  LANGUAGE sql AS $f$ SELECT NULL::text, NULL::timestamptz, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $f$;
SQL
P -q -f "$FIX"
BASE_MAPA="$(Pq -c "SELECT count(*) FROM fin_categoria_dre_mapping;")"
eq "Z1 fixture do mapa vigente" "$BASE_MAPA" "157"

snap() { Pq -c "SELECT md5(string_agg(company||'|'||omie_codigo||'|'||dre_linha, ',' ORDER BY company, omie_codigo)) FROM fin_categoria_dre_mapping;"; }
MAPA_VIGENTE="$(snap)"

# ── PARTE 1: migration ──
# F-mig: cópias sabotadas têm de ABORTAR na postcondição e deixar o CHECK antigo intacto.
sab_mig() {
  local f="$TMPD/sab-mig.sql" out
  sed "$2" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "F-mig-$1: sed não aplicou"; return; fi
  if out=$(P -q -f "$f" 2>&1); then bad "F-mig-$1: sabotada PASSOU"; return; fi
  case "$out" in *"postcondicao:"*) ok "F-mig-$1: postcondição abortou" ;; *) bad "F-mig-$1: outro motivo: ${out:0:200}" ;; esac
  eq "F-mig-$1: rollback (CHECK ainda sem nao_resultado)" \
    "$(Pq -c "SELECT position('nao_resultado' IN pg_get_constraintdef(oid))>0 FROM pg_constraint WHERE conname='fin_categoria_dre_mapping_dre_linha_check';")" "f"
}
sab_mig "check-sem-nao_resultado" "s/    'fora_dre', 'nao_resultado'\$/    'fora_dre'/"
sab_mig "default-aceita-nao_resultado" "s/dre_linha IN ('fora_dre', 'nao_resultado')/dre_linha IN ('fora_dre')/"
sab_mig "default-aceita-fora_dre" "s/dre_linha IN ('fora_dre', 'nao_resultado')/dre_linha IN ('nao_resultado')/"

P -q -f "$MIG" && ok "M0 migration real aplicou (controle verde, mesma invocação)"
P -q -f "$MIG" && ok "M0b reaplicação idempotente"
eq "M1 mapa vigente intacto pela migration" "$(snap)" "$MAPA_VIGENTE"
eq "M2 linha de prova não ficou" "$(Pq -c "SELECT count(*) FROM fin_categoria_dre_mapping WHERE omie_codigo LIKE '__postcondicao%';")" "0"
recusa() { # 0 = 23514 · 1 = aceitou · 2 = outro erro
  local out
  out=$(P -tA 2>&1 <<SQL
DO \$t\$ BEGIN
  INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha) VALUES ('$1','9.99.99','$2');
  RAISE NOTICE 'SENTINELA-ACEITOU';
  RAISE EXCEPTION 'desfaz' USING ERRCODE = 'P0099';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'SENTINELA-23514';
          WHEN SQLSTATE 'P0099' THEN NULL;
END \$t\$;
SQL
) || { echo "outro: ${out:0:200}"; return 2; }
  case "$out" in *SENTINELA-23514*) return 0 ;; *SENTINELA-ACEITOU*) return 1 ;; *) return 2 ;; esac
}
rc=0; recusa colacor nao_resultado || rc=$?; eq "M3 colacor aceita nao_resultado" "$rc" "1"
rc=0; recusa _default nao_resultado || rc=$?; eq "M4 _default recusa nao_resultado (23514)" "$rc" "0"
rc=0; recusa _default fora_dre || rc=$?; eq "M5 _default segue recusando fora_dre (23514)" "$rc" "0"
rc=0; recusa oben linha_inventada || rc=$?; eq "M6 linha desconhecida recusada (23514)" "$rc" "0"

# ── PARTE 2: mapa (como o db:aplicar: uma transação) ──
aplica_mapa() { P -q -1 -f "${1:-$MAPA}"; }
# P1: sem atestação da v1.13 a precondição recusa e nada muda
if out=$(aplica_mapa 2>&1); then bad "P1 mapa aplicou SEM edge atestada"; else
  case "$out" in *"precondicao: omie-financeiro servida"*) ok "P1 precondição barra sem atestação" ;; *) bad "P1 outro motivo: ${out:0:200}" ;; esac; fi
eq "P1b mapa intacto" "$(snap)" "$MAPA_VIGENTE"
# P2: atestação mais recente com fonte errada (redeploy de outro bundle) também barra
P -q -c "INSERT INTO deploy_atestacoes VALUES ('r1', now() - interval '2 min', 'omie-financeiro', 'v1.13-dre-nao-resultado', '$FONTE', 'sonda'),
                                              ('r2', now() - interval '1 min', 'omie-financeiro', 'v1.13-dre-nao-resultado', 'outra-fonte', 'sonda');"
if aplica_mapa >/dev/null 2>&1; then bad "P2 aplicou com a observação MAIS RECENTE divergente"; else ok "P2 observação mais recente divergente barra"; fi
P -q -c "INSERT INTO deploy_atestacoes VALUES ('r3', now(), 'omie-financeiro', 'v1.13-dre-nao-resultado', '$FONTE', 'sonda');"
# P3: motor certo mas sugestor v1.1 ainda servido (sugeriria nao_resultado entre empresas) ⇒ barra
P -q -c "INSERT INTO deploy_atestacoes VALUES ('s1', now(), 'fin-suggest-mapping', 'v1.1-gate-auth-canonico', 'velha', 'sonda');"
if out=$(aplica_mapa 2>&1); then bad "P3 aplicou com fin-suggest-mapping v1.1"; else
  case "$out" in *"precondicao: fin-suggest-mapping servida"*) ok "P3 precondição barra sugestor velho" ;; *) bad "P3 outro motivo: ${out:0:200}" ;; esac; fi
eq "P3b mapa intacto" "$(snap)" "$MAPA_VIGENTE"
P -q -c "INSERT INTO deploy_atestacoes VALUES ('s2', now() + interval '1 s', 'fin-suggest-mapping', 'v1.2-nao-resultado-nao-sugerivel', '$FONTE_SUG', 'sonda');"

# F-mapa: postcondição sabotada (contagem) tem de abortar; descrição do Omie renomeada também.
cp "$MAPA" "$TMPD/sab-mapa.sql"
sed -i.bak "s/IF v_ok IS DISTINCT FROM 232 THEN/IF v_ok IS DISTINCT FROM 233 THEN/" "$TMPD/sab-mapa.sql"
if cmp -s "$TMPD/sab-mapa.sql" "$MAPA"; then bad "F-mapa-contagem: sed não aplicou"; else
  if aplica_mapa "$TMPD/sab-mapa.sql" >/dev/null 2>&1; then bad "F-mapa-contagem: sabotada PASSOU"; else ok "F-mapa-contagem: postcondição abortou"; fi; fi
eq "F-mapa-contagem: rollback" "$(snap)" "$MAPA_VIGENTE"

P -q -c "UPDATE fin_categorias SET descricao = 'Conta reaproveitada', updated_at = now() WHERE company='oben' AND omie_codigo='2.05.03';"
if out=$(aplica_mapa 2>&1); then bad "D1 aplicou com descrição do Omie mudada"; else
  case "$out" in *"descricao do Omie mudou"*"oben 2.05.03"*) ok "D1 código reaproveitado aborta (nomeia oben 2.05.03)" ;; *) bad "D1 outro motivo: ${out:0:200}" ;; esac; fi
eq "D1b rollback" "$(snap)" "$MAPA_VIGENTE"
P -q -c "UPDATE fin_categorias SET descricao = 'Pagamento de Empréstimos', updated_at = now() WHERE company='oben' AND omie_codigo='2.05.03';"

# C1: outra mão gravou decisão divergente antes do apply ⇒ aborta (não convive em silêncio)
P -q -c "INSERT INTO fin_categoria_dre_mapping (company, omie_codigo, dre_linha) VALUES ('oben','2.05.03','despesas_operacionais');"
if out=$(aplica_mapa 2>&1); then bad "C1 aplicou sobre decisão divergente"; else
  case "$out" in *"postcondicao: 231 de 232"*) ok "C1 decisão divergente aborta (231 de 232)" ;; *) bad "C1 outro motivo: ${out:0:200}" ;; esac; fi
P -q -c "DELETE FROM fin_categoria_dre_mapping WHERE company='oben' AND omie_codigo='2.05.03';"

# A: o controle verde
aplica_mapa && ok "A0 mapa real aplicou (controle verde, mesma invocação)"
aplica_mapa && ok "A0b reaplicação idempotente"
eq "A1 total de linhas = vigente + 111 novas" "$(Pq -c "SELECT count(*) FROM fin_categoria_dre_mapping;")" "$((BASE_MAPA + 111))"
L() { Pq -c "SELECT dre_linha FROM fin_categoria_dre_mapping WHERE company='$1' AND omie_codigo='$2';"; }
eq "A2 oben empréstimo pago → fora_dre" "$(L oben 2.05.03)" "fora_dre"
eq "A3 oben ICMS → ded_icms" "$(L oben 2.06.01)" "ded_icms"
eq "A3b oben DIFAL → ded_icms" "$(L oben 2.06.96)" "ded_icms"
eq "A4 oben IRPJ → irpj / CSLL → csll" "$(L oben 2.06.05)/$(L oben 2.06.98)" "irpj/csll"
eq "A5 oben aumento de capital → nao_resultado" "$(L oben 1.04.04)" "nao_resultado"
eq "A6 colacor_sc 1.04.04 (empréstimo recebido) → nao_resultado" "$(L colacor_sc 1.04.04)" "nao_resultado"
eq "A7 colacor_sc salários → despesas_administrativas" "$(L colacor_sc 2.03.01)" "despesas_administrativas"
eq "A8 colacor_sc DAS → das" "$(L colacor_sc 2.06.99)" "das"
eq "A9 colacor imobilizado: fora_dre → nao_resultado" "$(L colacor 2.01.99)" "nao_resultado"
eq "A10 colacor empréstimo segue fora_dre (pendente)" "$(L colacor 2.05.03)" "fora_dre"
eq "A11 devolução de compra (CR) → outras_receitas, nunca cmv" "$(L oben 1.03.01)/$(L colacor 1.03.01)" "outras_receitas/outras_receitas"
eq "A12 colacor 'Simples Nacional' histórico → das" "$(L colacor 2.06.99)" "das"
eq "A13 _default intocado e sem patrimonial" "$(Pq -c "SELECT count(*) FILTER (WHERE dre_linha IN ('fora_dre','nao_resultado')) || '/' || count(*) FROM fin_categoria_dre_mapping WHERE company='_default';")" "0/36"
eq "A14 nada mapeado em slot <Disponível>" "$(Pq -c "SELECT count(*) FROM fin_categoria_dre_mapping m JOIN fin_categorias c USING (company, omie_codigo) WHERE c.descricao LIKE '%Dispon%';")" "0"
eq "A15 notas guardam a descrição da decisão" "$(Pq -c "SELECT count(*) FROM fin_categoria_dre_mapping WHERE notas LIKE 'mapa-proprio 2026-11-22 · desc=%';")" "121"

eq "A16 SC INSS/IRRF (retenção no bruto) → nao_resultado" "$(L colacor_sc 2.03.06)/$(L colacor_sc 2.03.08)" "nao_resultado/nao_resultado"
eq "A17 SC FGTS (patronal real) segue despesa" "$(L colacor_sc 2.03.07)" "despesas_administrativas"
eq "A18 colacor venda de bens → fora_dre (ganho não apurado)" "$(L colacor 1.04.06)" "fora_dre"
eq "A19 ambíguos da fase 2 seguem sem decisão (2.03.78/2.06.93/2.06.94/2.01.01)" "$(L colacor 2.03.78)|$(L colacor 2.06.93)|$(L colacor 2.06.94)|$(L colacor 2.01.01)" "|||"

echo "═══ PASS=$PASS FAIL=$FAIL ═══"
[ "$FAIL" -eq 0 ] && echo "PROVA-VERDE-FIM"
[ "$FAIL" -eq 0 ]
