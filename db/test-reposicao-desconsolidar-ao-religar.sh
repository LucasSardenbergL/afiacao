#!/usr/bin/env bash
# Prova PG17 do trigger `sku_parametros_desconsolidar_ao_religar` [money-path].
# Migration: supabase/migrations/20261029165429_reposicao_desconsolidar_ao_religar_sku.sql
#
# Incidente: o DFA.4128LT (11892839175) foi consolidado em 12101724100 em 05/07/2026,
# religado pela UI depois, e o motor voltou a comprá-lo (7 pedidos disparados) com a
# venda dele contada também no destino. Decisão do founder (opção B): religar um
# antigo DESFAZ o mapa (→ 'revertida'), venha de qual escritor vier; a migration
# também desfaz os mapas que já violam o invariante.
#
# Carrega o SCHEMA REAL (schema-snapshot.sql), aplica a migration e roda os
# asserts. O CONTROLE (migration real) roda na MESMA invocação das sabotagens
# e aborta antes delas se não for verde. Cada sabotagem é aplicada a uma CÓPIA
# da migration em tmpdir (nunca em supabase/migrations/) e tem de dar vermelho
# EXATO nos asserts que ela deveria derrubar.
#
# Uso: bash db/test-reposicao-desconsolidar-ao-religar.sh [--falsificar]
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
MIG="$REPO_ROOT/supabase/migrations/20261029165429_reposicao_desconsolidar_ao_religar_sku.sql"
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
GRANT USAGE ON SCHEMA public, auth TO tester;   -- como o authenticated de prod (auth.uid())
GRANT SELECT, INSERT, UPDATE ON public.sku_parametros TO tester;
GRANT ALL ON public.sku_substituicao TO tester;   -- como o authenticated de prod: só a RLS esconde
CREATE POLICY t_tester_all ON public.sku_parametros TO tester USING (true) WITH CHECK (true);

CREATE TABLE _t_res (ord serial, nome text NOT NULL, ok boolean NOT NULL, detalhe text);
GRANT ALL ON _t_res TO PUBLIC;
GRANT ALL ON SEQUENCE _t_res_ord_seq TO PUBLIC;
CREATE FUNCTION _t_assert(p_nome text, p_ok boolean, p_detalhe text DEFAULT '')
RETURNS void LANGUAGE sql AS $$ INSERT INTO _t_res (nome, ok, detalhe) VALUES (p_nome, COALESCE(p_ok, false), p_detalhe) $$;
-- 'OK', 23505 (colisão no UNIQUE do mapa) ou ZR006 (guarda do mapa); qualquer OUTRA exceção sobe e o cenário vira EXEC vermelho.
CREATE FUNCTION _t_tenta(VARIADIC p_sqls text[]) RETURNS text LANGUAGE plpgsql AS $$
DECLARE q text;
BEGIN
  FOREACH q IN ARRAY p_sqls LOOP EXECUTE q; END LOOP;
  RETURN 'OK';
EXCEPTION
  WHEN unique_violation THEN RETURN '23505';
  WHEN SQLSTATE 'ZR006' THEN RETURN 'ZR006';
END $$;
GRANT EXECUTE ON FUNCTION _t_assert(text, boolean, text), _t_tenta(text[]) TO PUBLIC;
SQL

# ── sementes: entram ANTES da migration (o 600 é o estado contraditório que já existe em prod) ──
cat > "$TMP/sementes.sql" <<'SQL'
INSERT INTO sku_parametros (empresa, sku_codigo_omie, tipo_reposicao, habilitado_reposicao_automatica) VALUES
  ('OBEN', 200, 'automatica',    true),   -- destino
  ('OBEN', 600, 'automatica',    true),   -- antigo JÁ religado (o 4128 de prod)
  ('OBEN', 610, 'automatica',    true),   -- idem, e já desfeito uma vez antes
  ('OBEN', 620, 'automatica',    true),   -- ativo (A07: mapa só dentro de subtransação)
  ('OBEN', 625, 'automatica',    true),   -- ativo; consolidado pelo fluxo da consolidar_demanda_sku
  ('OBEN', 630, 'automatica',    true),   -- ativo; mapa por INSERT direto (tem de ser recusado)
  ('OBEN', 100, 'descontinuado', false),  -- antigo, mapa ativo
  ('OBEN', 101, 'descontinuado', false),  -- antigo, religado em lote
  ('OBEN', 110, 'automatica',    false),  -- antigo, só o flag desligado
  ('OBEN', 120, 'descontinuado', true),   -- antigo, só o tipo desligado
  ('OBEN', 130, 'descontinuado', false),  -- antigo: muda o tipo mas segue fora do motor
  ('OBEN', 300, 'descontinuado', false),  -- sem mapa
  ('OBEN', 400, 'descontinuado', false),  -- mapa pendente
  ('OBEN', 500, 'descontinuado', false),  -- mapa de outra ação
  ('OBEN', 700, 'descontinuado', false),  -- mapa com empresa minúscula
  ('OBEN', 800, 'descontinuado', false),  -- escritor sem visão de sku_substituicao
  ('OBEN', 950, 'descontinuado', false);  -- já desfeito uma vez e consolidado de novo
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status, data_substituicao) VALUES
  ('OBEN', '100', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '101', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '110', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '120', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '130', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '400', '200', 'consolidar_demanda', 'pendente',  CURRENT_DATE),
  ('OBEN', '500', '200', 'transferir',         'aplicada',  CURRENT_DATE),
  ('OBEN', '600', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '610', '200', 'consolidar_demanda', 'revertida', CURRENT_DATE),
  ('OBEN', '610', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('oben', '700', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '800', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '900', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE),
  ('OBEN', '950', '200', 'consolidar_demanda', 'revertida', CURRENT_DATE),
  ('OBEN', '950', '200', 'consolidar_demanda', 'aplicada',  CURRENT_DATE);
SQL

# ── asserts (depois da migration) ──
cat > "$TMP/asserts.sql" <<'SQL'
CREATE FUNCTION _t_st(p_antigo text) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(status, ',' ORDER BY status) FROM sku_substituicao WHERE sku_codigo_antigo = p_antigo $$;
GRANT EXECUTE ON FUNCTION _t_st(text) TO PUBLIC;

-- A migration desfaz o mapa que JÁ viola o invariante (o 4128 de prod).
SELECT _t_assert('B01_backfill_desfez_o_ja_religado', _t_st('600') = 'revertida');
SELECT _t_assert('B02_backfill_anota_o_motivo',
  (SELECT observacoes FROM sku_substituicao WHERE sku_codigo_antigo = '600') LIKE '%opção B%');
SELECT _t_assert('B04_backfill_preserva_o_desfazer_anterior', _t_st('610') LIKE 'revertida,revertida:%');
SELECT _t_assert('B03_backfill_nao_toca_os_demais',
  _t_st('100') = 'aplicada' AND _t_st('900') = 'aplicada' AND _t_st('500') = 'aplicada');

-- Payload do botão "Reativar" (src/lib/reposicao/sku-param.ts reativarPayload).
SELECT _t_assert('A01_reativar_desconsolida',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 100$q$) = 'OK' AND _t_st('100') = 'revertida');
SELECT _t_assert('A02_reativar_anota_quem_e_quando',
  (SELECT observacoes FROM sku_substituicao WHERE sku_codigo_antigo = '100') LIKE 'desconsolidado em %religado%');
-- Payload do "Manter em estoque" do Baixo Giro, em lote com um SKU sem mapa.
SELECT _t_assert('A03_baixo_giro_lote_desconsolida',
  _t_tenta($q$UPDATE sku_parametros SET estoque_minimo = 1, ponto_pedido = 2, estoque_maximo = 3,
                     habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie IN (101, 300)$q$) = 'OK'
  AND _t_st('101') = 'revertida');
-- Statement PRÓPRIO: no mesmo SELECT do _t_tenta, a subconsulta viraria InitPlan e leria o antes.
SELECT _t_assert('A06_lote_religa_o_sem_mapa',
  (SELECT tipo_reposicao FROM sku_parametros WHERE sku_codigo_omie = 300) = 'automatica');
SELECT _t_assert('A04_mapa_pendente_intocado',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 400$q$) = 'OK' AND _t_st('400') = 'pendente');
SELECT _t_assert('A05_mapa_transferir_intocado',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 500$q$) = 'OK' AND _t_st('500') = 'aplicada');
-- Já estava no motor: reescrever o mesmo estado (lote noturno, edição de PP) não é religação.
-- O estado "antigo no motor + mapa ativo" só existe dentro de uma transação (a guarda deferred
-- o recusa no COMMIT): monta-se numa subtransação que é desfeita depois de ler o resultado.
DO $$
DECLARE v text;
BEGIN
  BEGIN
    INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status, data_substituicao)
      VALUES ('OBEN', '620', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE);
    UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica', ponto_pedido = 9
     WHERE empresa = 'OBEN' AND sku_codigo_omie IN (620, 200);
    v := _t_st('620');
    RAISE EXCEPTION 'desfaz' USING ERRCODE = 'ZT999';
  EXCEPTION
    WHEN SQLSTATE 'ZT999' THEN NULL;
    WHEN SQLSTATE 'ZR006' THEN v := 'guarda do mapa imediata';   -- deferred sabotado
  END;
  PERFORM _t_assert('A07_ja_ativo_nao_e_transicao', v = 'aplicada', v);
END $$;
-- A outra ponta: mapa novo sobre SKU no motor é recusado no COMMIT (aqui, forçado com IMMEDIATE)...
SELECT _t_assert('C01_mapa_sobre_sku_no_motor_recusado',
  _t_tenta($q$INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status, data_substituicao)
              VALUES ('OBEN', '630', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE)$q$,
           'SET CONSTRAINTS ALL IMMEDIATE') = 'ZR006');
SELECT _t_assert('C01b_recusa_nao_deixa_mapa', _t_st('630') IS NULL);
-- ...mas o fluxo da consolidar_demanda_sku (grava o mapa, DEPOIS descontinua, mesma transação) passa.
SELECT _t_assert('C02_fluxo_consolidar_passa',
  _t_tenta($q$INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status, data_substituicao)
              VALUES ('OBEN', '625', '200', 'consolidar_demanda', 'aplicada', CURRENT_DATE)$q$,
           $q$UPDATE sku_parametros SET tipo_reposicao = 'descontinuado', habilitado_reposicao_automatica = false
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 625$q$,
           'SET CONSTRAINTS ALL IMMEDIATE') = 'OK' AND _t_st('625') = 'aplicada');
SELECT _t_assert('A08_empresa_caixa_diferente_desconsolida',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 700$q$) = 'OK' AND _t_st('700') = 'revertida');
SELECT _t_assert('A11_insert_ativo_desconsolida',
  _t_tenta($q$INSERT INTO sku_parametros (empresa, sku_codigo_omie, tipo_reposicao, habilitado_reposicao_automatica)
              VALUES ('OBEN', 900, 'automatica', true)$q$) = 'OK' AND _t_st('900') = 'revertida');
SELECT _t_assert('A12_so_flag_desconsolida',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 110$q$) = 'OK' AND _t_st('110') = 'revertida');
SELECT _t_assert('A13_so_tipo_desconsolida',
  _t_tenta($q$UPDATE sku_parametros SET tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 120$q$) = 'OK' AND _t_st('120') = 'revertida');
SELECT _t_assert('A14_tipo_sem_flag_fica_fora_e_intocado',
  _t_tenta($q$UPDATE sku_parametros SET tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 130$q$) = 'OK' AND _t_st('130') = 'aplicada');
SELECT _t_assert('A15_acl_fechada',
  NOT has_function_privilege('authenticated', 'public.trg_sku_parametros_desconsolidar_ao_religar()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.trg_sku_parametros_desconsolidar_ao_religar()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.trg_sku_substituicao_exige_antigo_fora_do_motor()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.trg_sku_substituicao_exige_antigo_fora_do_motor()', 'EXECUTE'));
-- Re-consolidado depois de um desfazer: o 'revertida' velho não pode travar a religação (23505).
SELECT _t_assert('A18_reconsolidado_religa_sem_colisao',
  _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 950$q$) = 'OK' AND _t_st('950') LIKE 'revertida,revertida:%');

SET ROLE tester;
-- Pré-condição do A17: o escritor de fato NÃO vê os mapas (senão o A17 não teria dente).
SELECT _t_assert('A16_tester_cego_para_mapas', (SELECT count(*) FROM sku_substituicao) = 0);
SELECT _tenta_tester FROM (SELECT _t_tenta($q$UPDATE sku_parametros SET habilitado_reposicao_automatica = true, tipo_reposicao = 'automatica'
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 800$q$) AS _tenta_tester) x;
RESET ROLE;
SELECT _t_assert('A17_escritor_sem_rls_desconsolida', _t_st('800') = 'revertida');
-- O invariante, em toda a tabela, ao fim de tudo.
SELECT _t_assert('A19_invariante_global',
  NOT EXISTS (SELECT 1 FROM sku_substituicao s JOIN sku_parametros p
                ON upper(p.empresa) = upper(s.empresa) AND p.sku_codigo_omie::text = s.sku_codigo_antigo
               WHERE s.status = 'aplicada' AND s.acao_parametros = 'consolidar_demanda'
                 AND p.habilitado_reposicao_automatica AND COALESCE(p.tipo_reposicao, 'automatica') = 'automatica'));
SQL
NESP="$(grep -c "_t_assert('[ABC]" "$TMP/asserts.sql")"

# suite <migration> <banco> → linhas RES|nome|t/f|detalhe (roda em $(…): o nome vem de fora)
suite() {
  local mig=$1 db="s_$2"
  PA -q -d postgres -c "CREATE DATABASE $db TEMPLATE tpl0" >/dev/null
  PA -q -d "$db" -f "$TMP/sementes.sql" >/dev/null
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
# Camada 1 — a postcondição: cada sabotagem SOZINHA aborta a migration.
fals pos_definer       "MIGRATION"  -e 's/^SECURITY DEFINER$/SECURITY INVOKER/'
fals pos_revoke        "MIGRATION"  -e 's/^REVOKE ALL ON FUNCTION.*$/-- revoke sabotado/'
fals pos_backfill      "MIGRATION"  -e "s/^   AND COALESCE\(p\.tipo_reposicao, .automatica.\) = .automatica.;$/   AND false;/"
fals pos_deferred      "MIGRATION"  -e 's/^  DEFERRABLE INITIALLY DEFERRED$/  NOT DEFERRABLE/'
fals pos_renomear_bkp  "MIGRATION"  -e "s/^   SET status = 'revertida:' \|\| r\.id$/   SET status = r.status/"
# Camada 2 — os asserts, com a postcondição neutralizada junto (uma camada por vez).
fals sem_definer       "A17_escritor_sem_rls_desconsolida" \
  -e 's/^SECURITY DEFINER$/SECURITY INVOKER/' -e 's/AND p\.prosecdef AND/AND true AND/'
fals sem_revoke        "A15_acl_fechada" \
  -e 's/^REVOKE ALL ON FUNCTION.*$/-- revoke sabotado/' -e "s/RAISE EXCEPTION 'A2 FALHOU/RAISE NOTICE 'A2 FALHOU/"
fals sem_backfill      "A19_invariante_global B01_backfill_desfez_o_ja_religado B02_backfill_anota_o_motivo B04_backfill_preserva_o_desfazer_anterior" \
  -e "s/^   AND COALESCE\(p\.tipo_reposicao, .automatica.\) = .automatica.;$/   AND false;/" -e "s/RAISE EXCEPTION 'A3 FALHOU/RAISE NOTICE 'A3 FALHOU/"
fals sem_nota_backfill "B02_backfill_anota_o_motivo"              -e 's/decisão do founder, opção B/sem nota/'
fals imediato          "A07_ja_ativo_nao_e_transicao C02_fluxo_consolidar_passa" \
  -e 's/^  DEFERRABLE INITIALLY DEFERRED$/  NOT DEFERRABLE/' -e 's/AND t\.tgdeferrable AND t\.tginitdeferred/AND true/'
fals sem_guarda_mapa   "A19_invariante_global C01_mapa_sobre_sku_no_motor_recusado C01b_recusa_nao_deixa_mapa" \
  -e "s/RAISE EXCEPTION 'consolidação: o SKU antigo/RAISE NOTICE 'consolidação: o SKU antigo/"
fals sem_old           "A07_ja_ativo_nao_e_transicao"             -e 's/RETURN NULL;   -- já estava no motor/NULL;   -- já estava no motor/'
fals sem_upper         "A08_empresa_caixa_diferente_desconsolida A19_invariante_global" \
  -e 's/^   WHERE upper\(s\.empresa\) = upper\(NEW\.empresa\)$/   WHERE s.empresa = NEW.empresa/'
fals sem_status        "A04_mapa_pendente_intocado A18_reconsolidado_religa_sem_colisao"               -e "s/^     AND s\.status = 'aplicada'$/     AND true/"
fals sem_acao          "A05_mapa_transferir_intocado"             -e "s/^     AND s\.acao_parametros = 'consolidar_demanda';$/     AND true;/"
fals so_tipo           "A14_tipo_sem_flag_fica_fora_e_intocado"   -e 's/IF NOT \(COALESCE\(NEW\.habilitado_reposicao_automatica, false\)/IF NOT (true/'
fals sem_renomear      "A18_reconsolidado_religa_sem_colisao"     -e "s/^     SET status = 'revertida:' \|\| r\.id$/     SET status = r.status/"
# Só INSERT e UPDATE que escreve PP disparam: os religamentos puros (flag/tipo) não desfazem; A19 cai junto.
fals colunas_erradas   "A01_reativar_desconsolida A02_reativar_anota_quem_e_quando A08_empresa_caixa_diferente_desconsolida A12_so_flag_desconsolida A13_so_tipo_desconsolida A17_escritor_sem_rls_desconsolida A18_reconsolidado_religa_sem_colisao A19_invariante_global" \
  -e 's/UPDATE OF habilitado_reposicao_automatica, tipo_reposicao ON/UPDATE OF ponto_pedido ON/'
echo "VERMELHOS=$VERM  SEM_DENTE=$FALSOS"
[ "$FALSOS" -eq 0 ] || { echo "✗ falsificação sem dente"; exit 1; }
echo "✅ CONTROLE verde ($NTOT asserts) + $VERM falsificações com vermelho exato · locale=$LOC"
