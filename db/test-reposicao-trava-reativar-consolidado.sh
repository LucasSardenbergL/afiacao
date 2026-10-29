#!/usr/bin/env bash
# Prova PG17 da trava `sku_parametros_trava_reativar_consolidado` [money-path].
# Migration: supabase/migrations/20261029165429_reposicao_trava_reativar_sku_consolidado.sql
#
# Incidente: o DFA.4128LT (11892839175) foi consolidado em 12101724100 em 05/07/2026,
# religado pela UI depois, e o motor voltou a comprá-lo (7 pedidos disparados).
# A trava barra a TRANSIÇÃO de um SKU antigo de mapa ativo para o estado que o
# motor compra, venha de qual escritor vier.
#
# Carrega o SCHEMA REAL (schema-snapshot.sql), aplica a migration e roda os
# asserts. O CONTROLE (migration real) roda na MESMA invocação das sabotagens
# e aborta antes delas se não for verde. Cada sabotagem é aplicada a uma CÓPIA
# da migration em tmpdir (nunca em supabase/migrations/) e tem de dar vermelho
# EXATO nos asserts que ela deveria derrubar.
#
# Uso: bash db/test-reposicao-trava-reativar-consolidado.sh [--falsificar]
#      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-…   (rodar nos dois locales)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=db/lib/pg-harness.sh
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5481}}"
MODO=normal
case "${1:-}" in
  --falsificar) MODO=falsificar ;;
  "") ;;
  *) echo "uso: $0 [--falsificar]"; exit 2 ;;
esac
LOC="${HARNESS_LOCALE:-C}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-trava-consol.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
MIG="$REPO_ROOT/supabase/migrations/20261029165429_reposicao_trava_reativar_sku_consolidado.sql"
export LC_ALL=C LANG=C

[ -f "$SNAP" ] || { echo "INFRA: snapshot ausente: $SNAP"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
PA() { PGOPTIONS="-c client_min_messages=warning" "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -v ON_ERROR_STOP=1 "$@"; }
echo "PG: $("$PGBIN/postgres" --version) · locale=$LOC"

# ── template com o schema real de prod ──
PA -q -d postgres -c "CREATE DATABASE tpl0" >/dev/null
T0() { PA -d tpl0 "$@"; }
T0 -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
T0 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" \
  | grep -vE '^\\(un)?restrict |^SET transaction_timeout' > "$TMP/snap.sql"
T0 -q --single-transaction -f "$TMP/snap.sql" >/dev/null
T0 -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
-- Escritor que ESCREVE em sku_parametros mas NÃO enxerga sku_substituicao (RLS sem policy
-- para ele): é o cenário em que uma trava SECURITY INVOKER ficaria cega e falharia aberta.
CREATE ROLE tester NOLOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO tester;
GRANT SELECT, INSERT, UPDATE ON public.sku_parametros TO tester;
GRANT SELECT ON public.sku_substituicao TO tester;
CREATE POLICY t_tester_all ON public.sku_parametros TO tester USING (true) WITH CHECK (true);

CREATE TABLE _t_res (ord serial, nome text NOT NULL, ok boolean NOT NULL, detalhe text);
GRANT ALL ON _t_res TO PUBLIC;
GRANT ALL ON SEQUENCE _t_res_ord_seq TO PUBLIC;
CREATE FUNCTION _t_assert(p_nome text, p_ok boolean, p_detalhe text DEFAULT '')
RETURNS void LANGUAGE sql AS $$ INSERT INTO _t_res (nome, ok, detalhe) VALUES (p_nome, COALESCE(p_ok, false), p_detalhe) $$;
-- 'OK' ou a SQLSTATE da trava (ZR006); qualquer OUTRA exceção sobe e o cenário vira EXEC vermelho.
CREATE FUNCTION _t_tenta(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN SQLSTATE 'ZR006' THEN RETURN 'ZR006';
END $$;
GRANT EXECUTE ON FUNCTION _t_assert(text, boolean, text), _t_tenta(text) TO PUBLIC;
SQL

# ── asserts (rodam depois da migration, num banco copiado do template) ──
cat > "$TMP/asserts.sql" <<'SQL'
-- Linha 600 entra ATIVA antes do mapa dela: o estado contraditório que já existe em prod.
INSERT INTO sku_parametros (empresa, sku_codigo_omie, tipo_reposicao, habilitado_reposicao_automatica) VALUES
  ('OBEN', 200, 'automatica',    true),   -- destino
  ('OBEN', 600, 'automatica',    true);
INSERT INTO sku_parametros (empresa, sku_codigo_omie, tipo_reposicao, habilitado_reposicao_automatica) VALUES
  ('OBEN', 100, 'descontinuado', false),  -- antigo, mapa ativo
  ('OBEN', 110, 'automatica',    false),  -- antigo, só o flag desligado
  ('OBEN', 120, 'descontinuado', true),   -- antigo, só o tipo desligado
  ('OBEN', 130, 'descontinuado', false),  -- antigo: muda o tipo mas segue fora do motor
  ('OBEN', 300, 'descontinuado', false),  -- sem mapa
  ('OBEN', 400, 'descontinuado', false),  -- mapa pendente
  ('OBEN', 500, 'descontinuado', false),  -- mapa de outra ação
  ('OBEN', 700, 'descontinuado', false),  -- mapa com empresa minúscula
  ('OBEN', 800, 'descontinuado', false);  -- escritor sem visão de sku_substituicao
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status, data_substituicao) VALUES
  ('OBEN', '100', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE),
  ('OBEN', '110', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE),
  ('OBEN', '120', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE),
  ('OBEN', '130', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE),
  ('OBEN', '400', '200', 'consolidar_demanda', 'pendente', CURRENT_DATE),
  ('OBEN', '500', '200', 'transferir',         'aplicada', CURRENT_DATE),
  ('OBEN', '600', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE),
  ('oben', '700', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE),
  ('OBEN', '800', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE),
  ('OBEN', '900', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE);

-- Payload do botão "Reativar" (src/lib/reposicao/sku-param.ts reativarPayload).
SELECT _t_assert('A01_reativar_antigo_barrado',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 100$q$) = 'ZR006');
-- Payload do "Manter em estoque" do Baixo Giro, em lote com um SKU legítimo: o lote inteiro cai.
SELECT _t_assert('A02_baixo_giro_lote_barrado',
  _t_tenta($q$UPDATE sku_parametros SET estoque_minimo = 1, ponto_pedido = 2, estoque_maximo = 3,
                     habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie IN (100, 300)$q$) = 'ZR006');
SELECT _t_assert('A03_lote_atomico',
  (SELECT tipo_reposicao FROM sku_parametros WHERE empresa = 'OBEN' AND sku_codigo_omie = 300) = 'descontinuado');
SELECT _t_assert('A04_sem_mapa_reativa',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 300$q$) = 'OK');
SELECT _t_assert('A05_mapa_pendente_reativa',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 400$q$) = 'OK');
SELECT _t_assert('A06_mapa_transferir_reativa',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 500$q$) = 'OK');
-- Linha já contraditória: reescrever o MESMO estado não é reativação (não derruba lote noturno).
SELECT _t_assert('A07_ja_ativo_nao_e_transicao',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica', ponto_pedido = 9
              WHERE empresa = 'OBEN' AND sku_codigo_omie IN (600, 200)$q$) = 'OK');
SELECT _t_assert('A08_empresa_caixa_diferente_barrada',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 700$q$) = 'ZR006');
SELECT _t_assert('A09_descontinuar_passa',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = false, tipo_reposicao = 'descontinuado'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 600$q$) = 'OK');
SELECT _t_assert('A10_redescontinuado_nao_volta',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 600$q$) = 'ZR006');
SELECT _t_assert('A11_insert_ativo_barrado',
  _t_tenta($q$INSERT INTO sku_parametros (empresa, sku_codigo_omie, tipo_reposicao, habilitado_reposicao_automatica)
              VALUES ('OBEN', 900, 'automatica', true)$q$) = 'ZR006');
SELECT _t_assert('A12_so_flag_barrado',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 110$q$) = 'ZR006');
SELECT _t_assert('A13_so_tipo_barrado',
  _t_tenta($q$UPDATE sku_parametros SET tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 120$q$) = 'ZR006');
SELECT _t_assert('A14_tipo_sem_flag_fica_fora_e_passa',
  _t_tenta($q$UPDATE sku_parametros SET tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 130$q$) = 'OK');
SELECT _t_assert('A15_acl_fechada',
  NOT has_function_privilege('authenticated', 'public.trg_sku_parametros_trava_reativar_consolidado()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.trg_sku_parametros_trava_reativar_consolidado()', 'EXECUTE'));

SET ROLE tester;
-- Pré-condição do A17: o escritor de fato NÃO vê os mapas (senão o A17 não teria dente).
SELECT _t_assert('A16_tester_cego_para_mapas', (SELECT count(*) FROM sku_substituicao) = 0);
SELECT _t_assert('A17_escritor_sem_rls_barrado',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 800$q$) = 'ZR006');
RESET ROLE;
SQL
NESP="$(grep -c "_t_assert('A" "$TMP/asserts.sql")"

# suite <migration> <banco> → linhas RES|nome|t/f|detalhe (roda em $(…): o nome vem de fora)
suite() {
  local mig=$1 db="s_$2"
  PA -q -d postgres -c "CREATE DATABASE $db TEMPLATE tpl0" >/dev/null
  if ! PA -q -d "$db" -f "$mig" >/dev/null 2>"$TMP/$db.mig.err"; then
    echo "RES|MIGRATION|f|$(head -c 300 "$TMP/$db.mig.err" | tr '\n' ' ')"
    return 0
  fi
  PA -q -d "$db" -f "$TMP/asserts.sql" >/dev/null 2>"$TMP/$db.err" \
    || echo "RES|EXEC|f|$(head -c 300 "$TMP/$db.err" | tr '\n' ' ')"
  PA -d "$db" -tA -c "SELECT 'RES|' || nome || '|' || CASE WHEN ok THEN 't' ELSE 'f' END || '|' || COALESCE(detalhe, '') FROM _t_res ORDER BY ord" 2>/dev/null || true
}
falhas_de() { grep '^RES|' | awk -F'|' '$3 != "t" {print $2}' | sort | tr '\n' ' ' | sed 's/ $//'; }

# ═════════════════════════════ CONTROLE (migration real) ══════════════════
echo "════ CONTROLE — migration real ════"
CTRL="$(suite "$MIG" controle)"
printf '%s\n' "$CTRL" | grep '^RES|' | awk -F'|' '{ printf "  %s %s%s\n", ($3=="t"?"✓":"✗"), $2, ($3=="t"?"":"  ["$4"]") }'
NTOT="$(printf '%s\n' "$CTRL" | grep -c '^RES|' || true)"
FCTRL="$(printf '%s\n' "$CTRL" | falhas_de)"
NFCTRL="$(printf '%s\n' "$CTRL" | grep '^RES|' | awk -F'|' '$3 != "t"' | wc -l | tr -d ' ')"
echo "PASS=$((NTOT - NFCTRL))  FAIL=$NFCTRL"
if [ -n "$FCTRL" ] || [ "$NTOT" -ne "$NESP" ]; then
  echo "✗ CONTROLE NÃO-VERDE (falhas: [${FCTRL}] · asserts: $NTOT de $NESP) — abortando ANTES das falsificações"
  exit 1
fi
if [ "$MODO" = normal ]; then
  echo "✅ CONTROLE OK — $NTOT asserts · locale=$LOC (falsificação: --falsificar)"
  exit 0
fi

# ═════════════════════════════ FALSIFICAÇÕES ══════════════════════════════
FALSOS=0
VERM=0
fals() {
  local nome=$1 esperado=$2 copia got
  shift 2
  copia="$TMP/sab_$nome.sql"
  sed -E "$@" "$MIG" > "$copia"
  if cmp -s "$MIG" "$copia"; then
    echo "  ✗ $nome: o sed não mudou nada — sabotagem inerte"
    FALSOS=$((FALSOS + 1)); return
  fi
  got="$(suite "$copia" "$nome" | falhas_de)"
  if [ "$got" = "$esperado" ]; then
    echo "  ✓ $nome: vermelho EXATO [$got]"
    VERM=$((VERM + 1))
  else
    echo "  ✗ $nome: esperado [$esperado], veio [$got]"
    FALSOS=$((FALSOS + 1))
  fi
}
echo "════ FALSIFICAÇÕES ════"
# Camada 1 — a postcondição: sabotar só o DEFINER / só o REVOKE aborta a migration.
fals pos_definer     "MIGRATION"  -e 's/^SECURITY DEFINER$/SECURITY INVOKER/'
fals pos_revoke      "MIGRATION"  -e 's/^REVOKE ALL ON FUNCTION.*$/-- revoke sabotado/'
# Camada 2 — os asserts, com a postcondição neutralizada junto (uma camada por vez).
fals sem_definer     "A17_escritor_sem_rls_barrado" \
  -e 's/^SECURITY DEFINER$/SECURITY INVOKER/' -e 's/AND p\.prosecdef/AND true/'
fals sem_revoke      "A15_acl_fechada" \
  -e 's/^REVOKE ALL ON FUNCTION.*$/-- revoke sabotado/' -e "s/RAISE EXCEPTION 'A2 FALHOU/RAISE NOTICE 'A2 FALHOU/"
fals sem_old         "A07_ja_ativo_nao_e_transicao"         -e 's/RETURN NEW;   -- já estava no motor/NULL;   -- já estava no motor/'
fals sem_upper       "A08_empresa_caixa_diferente_barrada"  -e 's/WHERE upper\(s\.empresa\) = upper\(NEW\.empresa\)/WHERE s.empresa = NEW.empresa/'
fals sem_status      "A05_mapa_pendente_reativa"            -e "s/AND s\.status = 'aplicada'/AND true/"
fals sem_acao        "A06_mapa_transferir_reativa"          -e "s/AND s\.acao_parametros = 'consolidar_demanda'/AND true/"
fals so_tipo         "A14_tipo_sem_flag_fica_fora_e_passa"  -e 's/IF NOT \(COALESCE\(NEW\.habilitado_reposicao_automatica, false\)/IF NOT (true/'
fals colunas_erradas "A01_reativar_antigo_barrado A08_empresa_caixa_diferente_barrada A10_redescontinuado_nao_volta A12_so_flag_barrado A13_so_tipo_barrado A17_escritor_sem_rls_barrado" \
  -e 's/UPDATE OF habilitado_reposicao_automatica, tipo_reposicao ON/UPDATE OF ponto_pedido ON/'
echo "VERMELHOS=$VERM  SEM_DENTE=$FALSOS"
[ "$FALSOS" -eq 0 ] || { echo "✗ falsificação sem dente"; exit 1; }
echo "✅ CONTROLE verde ($NTOT asserts) + $VERM falsificações com vermelho exato · locale=$LOC"
