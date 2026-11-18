#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Prova PG17 da Etapa 2 do calendário (20261120090000_calendario_demanda_sombra.sql) — MONEY-PATH (o motor decide
# compra). Spec §6.4/§7-E2: docs/superpowers/specs/2026-11-18-calendario-operacao-design.md.
#
#   bash db/test-calendario-demanda.sh               → suíte (exige FIM-OK + total de PASS fixo)
#   bash db/test-calendario-demanda.sh --falsificar  → controle verde + cada sabotagem acusada pelo SEU assert
#
# Esquema: stubs → prelude → schema-snapshot (tipos da prod) → relógio controlado (test.agora) → predecessoras
# EXATAS da prod (fixture, md5 conferido = P1/P2) → calendário (20261119100000) → a migration (2×: idempotência).
# Relógio: test.agora fixa o "hoje SP" das duas views recriadas; as demais views do snapshot leem o relógio de
# parede, mas são as MESMAS nos dois modos — os asserts comparam modo × modo e predecessora × nova no mesmo instante.
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5671}"
SLUG="calendario-demanda"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL="${LC_ALL:-C}"
MIG="$REPO_ROOT/supabase/migrations/20261120090000_calendario_demanda_sombra.sql"
MIG_CAL="$REPO_ROOT/supabase/migrations/20261119100000_calendario_operacao.sql"
FIX="$REPO_ROOT/db/fixtures/calendario-demanda-predecessoras-prod-20261118.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=34

# ── MODO --falsificar ────────────────────────────────────────────────────────────────────────────────────────────
# Cada sabotagem declara o ÚNICO assert que a acusa (POS!<marca> = a postcondição da migration, `+` = espaço).
# Controle verde PRIMEIRO, na mesma invocação. Sabotagem que muda o TEXTO de uma view também desliga a trava de texto
# (md5 na PRE e na PÓS) — senão a camada externa a barra e o assert comportamental nunca é exercido (uma camada por vez;
# a própria trava de texto é falsificada à parte por pre_frouxa).
SABOTAGENS="
guarda_06:F05
teto:F04
pendente_conta:F06
meia_equipe_zero:F07
tudo_fechado_zera:F08
neutro_aritmetica:V01
sombra_alimenta:POS!em+sombra
chave_ignorada:V04
guc_lixo_vale:V06
colacor_ajusta:V07
anon_executa:POS!calendario_fator_demanda+executavel+por+anon
job_guc_vaza:S03
pre_frouxa:M2
"
if [ "${1:-}" = "--falsificar" ]; then
  LOGD="$(mktemp -d "${TMPDIR:-/tmp}/falsif-${SLUG}.XXXXXX")"
  if ! SABOTAGEM="" PGPORT_TEST="$PORT" bash "$0" >"$LOGD/controle.log" 2>&1 || ! grep -q "^FIM-OK ${SLUG}" "$LOGD/controle.log"; then
    echo "❌ CONTROLE não ficou verde — falsificação sem linha de base"; tail -20 "$LOGD/controle.log"; exit 1
  fi
  echo "✅ controle verde ($(grep -c ' OK — ' "$LOGD/controle.log") PASS)"
  vermelhas=0; falhas=0; i=0
  for par in $SABOTAGENS; do
    i=$((i+1)); s="${par%%:*}"; alvo="${par##*:}"
    log="$LOGD/$s.log"
    SABOTAGEM="$s" PGPORT_TEST=$((PORT + i)) bash "$0" >"$log" 2>&1 && rc=0 || rc=$?
    nfalhas=$(grep -cE ' (FALHOU|ERRO_DE_EXECUCAO) — ' "$log" || true)
    case "$alvo" in
      POS!*) marca="${alvo#POS!}"; marca="${marca//+/ }"; acusou=0; grep -q "POS FALHOU: ${marca}" "$log" && acusou=1; nfalhas=1 ;;
      *)     acusou=0; grep -q "❌ ${alvo} FALHOU — " "$log" && acusou=1 ;;
    esac
    if [ "$rc" -ne 0 ] && grep -q "SABOTAGEM ATIVA: $s" "$log" && [ "$acusou" -eq 1 ] && [ "$nfalhas" -eq 1 ]; then
      vermelhas=$((vermelhas+1)); echo "  🔴 $s → $alvo (dente)"
    else
      falhas=$((falhas+1)); echo "  ⚠️  $s: esperado só ${alvo} FALHOU; rc=$rc, falhas=$nfalhas"; grep -E ' (FALHOU|ERRO_DE_EXECUCAO) — |INFRA' "$log" | head -5
    fi
  done
  echo "SABOTAGENS: $vermelhas vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] || exit 1
  exit 0
fi

SABOTAGEM="${SABOTAGEM:-}"
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

sabotar_em() {   # <arquivo> <de> <para> — substituição literal; o padrão TEM de existir
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
f, de, para = sys.argv[1:4]
t = open(f).read()
if de not in t:
    sys.exit("SABOTAGEM INVALIDA: padrao ausente: " + de[:80])
open(f, "w").write(t.replace(de, para, 1))
PY
}
MIG_USADA="$TMPD/mig.sql"; cp "$MIG" "$MIG_USADA"
MIG_PRE="$TMPD/mig-pre.sql"; cp "$MIG" "$MIG_PRE"   # o M2 ensaia a PRE do arquivo do repo (só pre_frouxa a sabota)
sem_trava_de_texto() {
  sabotar_em "$MIG_USADA" "IF v_par NOT IN (" "IF false AND v_par NOT IN ("
  sabotar_em "$MIG_USADA" "IF v_est NOT IN (" "IF false AND v_est NOT IN ("
  sabotar_em "$MIG_USADA" "  IF md5(pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true)) IS DISTINCT FROM" "  IF false AND md5(pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true)) IS DISTINCT FROM"
}
if [ -n "$SABOTAGEM" ]; then
  echo "SABOTAGEM ATIVA: $SABOTAGEM"
  case "$SABOTAGEM" in
    guarda_06)         sabotar_em "$MIG_USADA" "a.w::numeric / a.u < 0.6 THEN 1::numeric" "a.w::numeric / a.u < 0.5 THEN 1::numeric" ;;
    teto)              sabotar_em "$MIG_USADA" "LEAST(a.u::numeric / a.w, 1.35)" "LEAST(a.u::numeric / a.w, 1.5)" ;;
    pendente_conta)    sabotar_em "$MIG_USADA" "WHERE c.status IS DISTINCT FROM 'pendente_dado')" "WHERE true)" ;;
    meia_equipe_zero)  sabotar_em "$MIG_USADA" "IN ('aberto', 'meia_equipe')" "IN ('aberto')" ;;
    tudo_fechado_zera) sabotar_em "$MIG_USADA" "WHEN a.u = 0 OR a.w::numeric / a.u < 0.6 THEN 1::numeric" "WHEN a.u = 0 THEN 1::numeric WHEN a.w = 0 THEN 0::numeric WHEN a.w::numeric / a.u < 0.6 THEN 1::numeric" ;;
    neutro_aritmetica) sabotar_em "$MIG_USADA" "AND fcal.fator <> 1::numeric THEN round(c.demanda_media_diaria * fcal.fator, 4)" "THEN round(c.demanda_media_diaria * fcal.fator, 4) + CASE WHEN fcal.fator = 1::numeric THEN 0.0001 ELSE 0::numeric END" ; sem_trava_de_texto ;;
    sombra_alimenta)   sabotar_em "$MIG_USADA" "WHEN cch.modo = 'valendo'::text AND fcal.fator IS NOT NULL" "WHEN fcal.fator IS NOT NULL" ; sem_trava_de_texto ;;
    chave_ignorada)    sabotar_em "$MIG_USADA" "WHERE cc.key = 'reposicao_demanda_calendario_oben_ativa'::text" "WHERE cc.key = 'reposicao_demanda_calendario_oben_ativa_x'::text" ; sem_trava_de_texto ;;
    guc_lixo_vale)     sabotar_em "$MIG_USADA" "= ANY (ARRAY['sombra'::text, 'valendo'::text])" "= ANY (ARRAY['sombra'::text, 'valendo'::text, 'xyz'::text])" ; sem_trava_de_texto ;;
    colacor_ajusta)    sabotar_em "$MIG_USADA" "LEFT JOIN calendario_fator fcal ON fcal.empresa_cal = c.empresa" "LEFT JOIN calendario_fator fcal ON true" ; sem_trava_de_texto ;;
    anon_executa)      sabotar_em "$MIG_USADA" "GRANT EXECUTE ON FUNCTION public.calendario_fator_demanda(text, date) TO authenticated, service_role;" "GRANT EXECUTE ON FUNCTION public.calendario_fator_demanda(text, date) TO authenticated, service_role, anon;" ;;
    job_guc_vaza)      sabotar_em "$MIG_USADA" "SET \"reposicao.demanda_calendario_forcar\" = ''" "" ; sabotar_em "$MIG_USADA" "  PERFORM pg_catalog.set_config('reposicao.demanda_calendario_forcar', '', true);
  IF to_regclass" "  IF to_regclass" ;;
    pre_frouxa)        sabotar_em "$MIG_PRE" "IF v_est NOT IN ('f05c5621d0254b746c6ada8cb0c9d22a'" "IF false AND v_est NOT IN ('f05c5621d0254b746c6ada8cb0c9d22a'" ;;
    *) echo "SABOTAGEM DESCONHECIDA: $SABOTAGEM"; exit 2 ;;
  esac
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# Leitura com relógio e GUCs montados na conexão; o erro vira o VALOR lido.
Ler() {   # <test.agora> <sql> [opções -c extras]
  local agora="$1" sql="$2"; shift 2
  PGOPTIONS="-c search_path=public,pg_catalog -c test.agora=$agora $*" Pq -q -c "$sql" 2>&1 || true
}

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
invalido() { case "$1" in ""|*ERROR:*|*ERRO:*|*FATAL:*|*TRIPWIRE*|*psql:*) return 0 ;; *) return 1 ;; esac; }
eq() {   # <id> <descrição> <obtido> <esperado>
  if invalido "$3"; then erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 240)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi
}

# ── ZONA 1: schema de prod ───────────────────────────────────────────────────────────────────────────────────────
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE plpgsql STABLE AS $f$
DECLARE v text := nullif(pg_catalog.current_setting('test.agora', true), '');
BEGIN
  IF v IS NULL THEN RAISE EXCEPTION 'TRIPWIRE: now() lido sem test.agora' USING ERRCODE = 'Z9T01'; END IF;
  RETURN v::timestamptz;
END $f$;
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN CREATE ROLE claude_ro NOLOGIN; END IF;
END $r$;
SQL
PGOPTIONS="-c search_path=public,pg_catalog" P -q -f "$FIX" >/dev/null
PGOPTIONS="-c search_path=public,pg_catalog -c test.agora=2027-01-20T15:00:00Z" P -q --single-transaction -f "$MIG_CAL" >/dev/null 2>"$TMPD/cal.err" \
  || { echo "INFRA: 20261119100000 não aplicou"; tail -5 "$TMPD/cal.err"; exit 1; }

echo "═══ setup pronto (PG17 :$PORT, lc_messages=$HARNESS_LC, LC_ALL=$LC_ALL) ═══"

# P1/P2: a predecessora local é a da PROD (o predicado da PRE é ensaiado contra o texto real).
eq P1 "md5 v_sku_parametros_sugeridos predecessora = prod" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT md5(pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true))")" cb7f8b8b2286ca815c0a76ea8aa412de
eq P2 "md5 v_sku_demanda_estatisticas predecessora = prod" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT md5(pg_get_viewdef('public.v_sku_demanda_estatisticas'::regclass, true))")" f05c5621d0254b746c6ada8cb0c9d22a

# ── Sementes ─────────────────────────────────────────────────────────────────────────────────────────────────────
# OBEN 1001: SKU completo (LT, fornecedor habilitado, cmc) ⇒ status OK e PP. OBEN 1002: só vendas.
# COLACOR 2001: só vendas. Vendas: 1 NF por dia útil de 2026-05-04 a 2027-01-20, ZERO no recesso 18/12–01/01.
PGOPTIONS="-c test.agora=2027-01-20T15:00:00Z" P -q <<'SQL'
SET session_replication_role = replica;  -- semente direta, sem triggers de sync
INSERT INTO public.venda_items_history (empresa, data_emissao, sku_codigo_omie, quantidade, valor_unitario, valor_total,
                                        nfe_chave_acesso, sku_descricao, sku_unidade)
SELECT e.empresa, d::date, e.sku, (1 + (extract(doy FROM d)::int % 4))::numeric, 10, 10 * (1 + (extract(doy FROM d)::int % 4)),
       e.empresa || '-' || e.sku || '-' || to_char(d, 'YYYYMMDD'), 'SKU ' || e.sku, 'UN'
  FROM generate_series('2026-05-04'::date, '2027-01-20'::date, interval '1 day') d
 CROSS JOIN (VALUES ('OBEN', 1001::bigint), ('OBEN', 1002::bigint), ('COLACOR', 2001::bigint)) e(empresa, sku)
 WHERE extract(isodow FROM d) < 6 AND NOT (d BETWEEN '2026-12-18' AND '2027-01-01');
INSERT INTO public.empresa_configuracao_custos (empresa, selic_anual, spread_oportunidade, armazenagem_fisica, custo_pedido_manual, custo_pedido_api)
VALUES ('OBEN', 13.75, 3, 2, 50, 10) ON CONFLICT DO NOTHING;
INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, fornecedor_nome) VALUES ('OBEN', 1001, 'FORN TESTE');
INSERT INTO public.sku_grupo_producao (empresa, sku_codigo_omie, grupo_codigo) VALUES ('OBEN', '1001', 'G1');
INSERT INTO public.fornecedor_grupo_producao (id, empresa, fornecedor_nome, grupo_codigo, lt_producao_dias, lt_producao_unidade)
VALUES (1, 'OBEN', 'FORN TESTE', 'G1', 10, 'uteis');
INSERT INTO public.fornecedor_habilitado_reposicao (id, empresa, fornecedor_nome, habilitado) VALUES (1, 'OBEN', 'FORN TESTE', true);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc) VALUES (1001, 'vendas', 50);
-- Calendário (só exceções): recesso 18/12/2026–01/01/2027 fechado (11 dias úteis); um SÁBADO "aberto" na janela
-- (fora de U e W por construção). Janelas de prova das guardas em 2024–2025, longe das vendas.
INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem)
SELECT d::date, 'OBEN', 'fechado', 0, 'recesso teste', 'manual'
  FROM generate_series('2026-12-18'::date, '2027-01-01'::date, interval '1 day') d WHERE extract(isodow FROM d) < 6;
INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem)
VALUES ('2027-01-09', 'OBEN', 'aberto', 1, 'sabado aberto', 'manual');
SQL

# Fecha os k primeiros dias úteis da janela que termina em $1, com status $3.
fechar() {   # <data_fim> <k> <status>
  local peso=0; [ "$3" = "fechado" ] || peso=1
  PGOPTIONS="-c test.agora=2027-01-20T15:00:00Z" P -q -c "INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem)
    SELECT dia, 'OBEN', '$3', $peso, 'prova', 'manual' FROM (
      SELECT g::date dia FROM generate_series(('$1'::date - 90)::timestamp, '$1'::timestamp, interval '1 day') g
       WHERE extract(isodow FROM g) < 6 ORDER BY 1 LIMIT $2) x
    ON CONFLICT (data, empresa) DO UPDATE SET status = EXCLUDED.status, peso = EXCLUDED.peso;" >/dev/null
}
fechar 2024-03-29 20 fechado      # W/U = 45/65  → fator bruto 1,444 → teto 1,35
fechar 2024-07-31 27 fechado      # W/U = 38/65 < 0,6 → guarda
fechar 2024-11-29 26 fechado      # W/U = 39/65 = 0,6 exato → NÃO é guarda (borda), teto 1,35
fechar 2025-03-31 65 fechado      # janela inteira fechada
fechar 2025-07-31 5 pendente_dado # 5 pendentes …
PGOPTIONS="-c test.agora=2027-01-20T15:00:00Z" P -q -c "INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem)
  SELECT g::date, 'OBEN', 'fechado', 0, 'prova', 'manual' FROM generate_series('2025-07-01'::timestamp, '2025-07-31'::timestamp, interval '1 day') g
   WHERE extract(isodow FROM g) < 6 ORDER BY 1 LIMIT 5;" >/dev/null   # … + 5 fechados (julho, fora dos pendentes de maio)
fechar 2025-11-28 5 meia_equipe   # meia equipe = peso 1 nesta entrega

# Leitura das views ANTES da migration (predecessora), nas duas datas-base, só com as colunas antigas.
COLS="empresa, sku_codigo_omie, demanda_media_diaria, demanda_sigma_diario, status_sugestao, estoque_minimo_sugerido, ponto_pedido_sugerido, qtde_compra_ciclo_sugerida, estoque_maximo_sugerido, cobertura_alvo_dias, estoque_seguranca_sugerido"
digital() { echo "SELECT count(*) || ':' || md5(string_agg(t::text, '|' ORDER BY t::text)) FROM (SELECT $COLS FROM public.v_sku_parametros_sugeridos) t"; }
ANTES_REC="$(Ler 2027-01-20T15:00:00Z "$(digital)")"
ANTES_NEU="$(Ler 2026-09-04T15:00:00Z "$(digital)")"
ANTES_EST="$(Ler 2027-01-20T15:00:00Z "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM (SELECT empresa, sku_codigo_omie, demanda_total_90d, demanda_media_diaria, valor_total_90d FROM public.v_sku_demanda_estatisticas) t")"

# ── A migration (2×: idempotência) ───────────────────────────────────────────────────────────────────────────────
aplicar() { PGOPTIONS="-c search_path=public,pg_catalog -c test.agora=2027-01-20T15:00:00Z" P -q --single-transaction -f "$1" 2>&1; }
SAIDA1="$(aplicar "$MIG_USADA" || true)"
SAIDA2="$(aplicar "$MIG_USADA" || true)"
case "$SAIDA1$SAIDA2" in *ERROR:*|*ERRO:*) echo "INFRA: migration falhou: $(printf '%s' "$SAIDA1$SAIDA2" | grep -m3 -E "ERROR:|ERRO:")"; exit 1 ;; esac
eq M1 "migration 2× com postcondição" "$(printf '%s\n%s' "$SAIDA1" "$SAIDA2" | grep -c 'POST calendario demanda OK')" 2

# M2: a PRE recusa uma view viva que não é a predecessora nem a nova (estatisticas com 5 casas).
PRE_TESTE="$TMPD/pre.sql"
python3 -I - "$MIG_PRE" "$PRE_TESTE" <<'PY2'
import sys
src, dst = sys.argv[1:3]
m = open(src).read()
i = m.index("CREATE OR REPLACE VIEW public.v_sku_demanda_estatisticas")
j = m.index(";\n", i) + 2
alheia = m[i:j].replace("90.0, 4) AS demanda_media_diaria", "90.0, 5) AS demanda_media_diaria")
assert alheia != m[i:j], "variante alheia igual a nova"
open(dst, "w").write(alheia + "\n" + m)
PY2
R="$(PGOPTIONS="-c search_path=public,pg_catalog -c test.agora=2027-01-20T15:00:00Z" P -q --single-transaction -f "$PRE_TESTE" 2>&1 || true)"
case "$R" in *"PRE FALHOU: v_sku_"*) eq M2 "PRE aborta view alheia" recusou recusou ;; *) eq M2 "PRE aborta view alheia" "aplicou" recusou ;; esac

# ── F: a função do fator ─────────────────────────────────────────────────────────────────────────────────────────
F() { Ler 2027-01-20T15:00:00Z "SELECT dias_base||'|'||dias_efetivos||'|'||dias_pendentes||'|'||coalesce(round(fator_bruto,4)::text,'NULL')||'|'||round(fator,4)||'|'||baixa_confianca FROM public.calendario_fator_demanda('OBEN', '$1')"; }
eq F01 "janela limpa: fator 1 exato"          "$(Ler 2027-01-20T15:00:00Z "SELECT fator = 1 AND fator_bruto = 1 AND NOT baixa_confianca FROM public.calendario_fator_demanda('OBEN', '2026-09-04')")" t
eq F02 "recesso 11/65 (sábado aberto fora)"   "$(F 2027-01-20)" "65|54|0|1.2037|1.2037|false"
eq F03 "janela [hoje−90, hoje] = numerador"   "$(Ler 2027-01-20T15:00:00Z "SELECT janela_inicio||'|'||janela_fim FROM public.calendario_fator_demanda('OBEN', '2027-01-20')")" "2026-10-22|2027-01-20"
eq F04 "teto 1,35 (W/U 45/65) e borda 0,6"     "$(F 2024-03-29)/$(F 2024-11-29)" "65|45|0|1.4444|1.3500|false/65|39|0|1.6667|1.3500|false"
eq F05 "guarda W/U 38/65 < 0,6 ⇒ fator 1"      "$(F 2024-07-31)" "65|38|0|1.7105|1.0000|true"
eq F06 "pendente_dado sai de U e W"            "$(F 2025-07-31)" "60|55|5|1.0909|1.0909|false"
eq F07 "meia_equipe = peso 1"                  "$(F 2025-11-28)" "65|65|0|1.0000|1.0000|false"
eq F08 "janela toda fechada: nem zero nem explode" "$(F 2025-03-31)" "65|0|0|NULL|1.0000|true"
eq F09 "data NULL ⇒ nenhuma linha (STRICT)"    "$(Ler 2027-01-20T15:00:00Z "SELECT count(*) FROM public.calendario_fator_demanda('OBEN', NULL)")" 0

# ── V: as views ──────────────────────────────────────────────────────────────────────────────────────────────────
LIGA="INSERT INTO public.company_config (key, value) VALUES ('reposicao_demanda_calendario_oben_ativa', 'true') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
DESLIGA="DELETE FROM public.company_config WHERE key = 'reposicao_demanda_calendario_oben_ativa'"
D1001="SELECT demanda_media_diaria||'|'||demanda_media_diaria_legado||'|'||demanda_media_diaria_calendario||'|'||calendario_modo FROM public.v_sku_parametros_sugeridos WHERE empresa='OBEN' AND sku_codigo_omie=1001"
Ler 2027-01-20T15:00:00Z "$LIGA" >/dev/null
eq V01 "janela limpa + chave LIGADA: colunas antigas idênticas à predecessora" "$(Ler 2026-09-04T15:00:00Z "$(digital)")" "$ANTES_NEU"
Ler 2027-01-20T15:00:00Z "$DESLIGA" >/dev/null
eq V02 "recesso + chave DESLIGADA (sombra): idêntico à predecessora" "$(Ler 2027-01-20T15:00:00Z "$(digital)")" "$ANTES_REC"
eq V03 "status OK com PP na semente (o V01/V02 enxergam PP)" "$(Ler 2027-01-20T15:00:00Z "SELECT status_sugestao||'|'||(ponto_pedido_sugerido > 0) FROM public.v_sku_parametros_sugeridos WHERE empresa='OBEN' AND sku_codigo_omie=1001")" "OK|true"
Ler 2027-01-20T15:00:00Z "$LIGA" >/dev/null
eq V04 "chave LIGADA: d = round(legado × 65/54, 4), modo valendo" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT (demanda_media_diaria = round(demanda_media_diaria_legado * 65 / 54.0, 4)) || '|' || (demanda_media_diaria > demanda_media_diaria_legado) || '|' || calendario_modo FROM public.v_sku_parametros_sugeridos WHERE empresa='OBEN' AND sku_codigo_omie=1001")" "true|true|valendo"
PP1001="SELECT ponto_pedido_sugerido FROM public.v_sku_parametros_sugeridos WHERE empresa='OBEN' AND sku_codigo_omie=1001"
PPV="$(Ler 2027-01-20T15:00:00Z "$PP1001" -c reposicao.demanda_calendario_forcar=valendo)"
PPS="$(Ler 2027-01-20T15:00:00Z "$PP1001" -c reposicao.demanda_calendario_forcar=sombra)"
eq V05 "modo valendo sobe o PP do SKU OK (mesma fórmula, d maior)" "$(Ler 2027-01-20T15:00:00Z "SELECT ('${PPV}'::numeric > '${PPS}'::numeric)::text")" true
Ler 2027-01-20T15:00:00Z "$DESLIGA" >/dev/null
eq V06 "GUC lixo ('xyz') com chave desligada ⇒ sombra" "$(Ler 2027-01-20T15:00:00Z "$D1001" -c reposicao.demanda_calendario_forcar=xyz | cut -d'|' -f4)" sombra
eq V07 "COLACOR: fator NULL e d intocado mesmo forçado" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT coalesce(fator_calendario::text,'NULL')||'|'||(demanda_media_diaria = demanda_media_diaria_legado)||'|'||coalesce(calendario_modo,'NULL') FROM public.v_sku_parametros_sugeridos WHERE empresa='COLACOR' AND sku_codigo_omie=2001" -c reposicao.demanda_calendario_forcar=valendo)" "NULL|true|NULL"
eq V08 "GUC 'valendo' força sem a chave (é como o job lê)" "$(Ler 2027-01-20T15:00:00Z "$D1001" -c reposicao.demanda_calendario_forcar=valendo | cut -d'|' -f4)" valendo
eq V09 "estatisticas crua: colunas antigas idênticas, fator só OBEN" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM (SELECT empresa, sku_codigo_omie, demanda_total_90d, demanda_media_diaria, valor_total_90d FROM public.v_sku_demanda_estatisticas) t")|$(Ler 2027-01-20T15:00:00Z "SELECT string_agg(empresa||'='||coalesce(round(fator_calendario,4)::text,'NULL'), ',' ORDER BY empresa, sku_codigo_omie) FROM public.v_sku_demanda_estatisticas")" \
  "$ANTES_EST|COLACOR=NULL,OBEN=1.2037,OBEN=1.2037"
eq V10 "o d ajustado nunca é NULL nem zero onde o legado não é" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT count(*) FROM public.v_sku_parametros_sugeridos WHERE demanda_media_diaria_legado > 0 AND NOT (demanda_media_diaria_calendario > 0)" -c reposicao.demanda_calendario_forcar=valendo)" 0

# ── A: autorização ───────────────────────────────────────────────────────────────────────────────────────────────
eq A01 "anon sem EXECUTE (catálogo) e PUBLIC fora" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT has_function_privilege('anon', 'public.calendario_fator_demanda(text, date)', 'EXECUTE')::text || '|' || NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'public.calendario_fator_demanda(text, date)'::regprocedure AND a.grantee = 0)")" "false|true"
eq A02 "authenticated, service_role e claude_ro com EXECUTE (a view não quebra para eles)" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT bool_and(has_function_privilege(r, 'public.calendario_fator_demanda(text, date)', 'EXECUTE')) FROM unnest(ARRAY['authenticated','service_role','claude_ro']) r")" t
eq A03 "anon chamando a função ⇒ 42501" \
  "$(Ler 2027-01-20T15:00:00Z "DO \$x\$ BEGIN SET LOCAL ROLE anon; PERFORM public.calendario_fator_demanda('OBEN', '2027-01-20'); RAISE NOTICE 'X-PASSOU'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'X-NEGOU'; END \$x\$" | grep -o 'X-[A-Z]*')" X-NEGOU
eq A04 "job da sombra: ninguém além do owner executa" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT bool_or(has_function_privilege(r, 'public.reposicao_demanda_calendario_sombra_registrar(text)', 'EXECUTE')) FROM unnest(ARRAY['anon','authenticated','service_role']) r")" f
eq A05 "RLS ligada na tabela da sombra; customer não lê" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.reposicao_demanda_calendario_sombra'::regclass")" t
eq A06 "views com security_invoker=on" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT count(*) FROM pg_class WHERE relname IN ('v_sku_parametros_sugeridos','v_sku_demanda_estatisticas') AND 'security_invoker=on' = ANY (reloptions)")" 2

eq A07 "customer (sem papel) não enxerga o calendário: fator 1, sem erro e sem zero" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT dias_base||'|'||dias_efetivos||'|'||round(fator,4) FROM public.calendario_fator_demanda('OBEN', '2027-01-20')" -c role=authenticated -c test.uid=00000000-0000-0000-0000-0000000000c1)" "65|65|1.0000"

# ── S: o job da sombra ───────────────────────────────────────────────────────────────────────────────────────────
JOB="SELECT public.reposicao_demanda_calendario_sombra_registrar('OBEN')"
eq S01 "job grava 1 linha por SKU OBEN e é idempotente (2×)" "$(Ler 2027-01-20T15:00:00Z "$JOB")|$(Ler 2027-01-20T15:00:00Z "$JOB")|$(Ler 2027-01-20T15:00:00Z "SELECT count(*) FROM public.reposicao_demanda_calendario_sombra")" "2|2|2"
eq S02 "sombra guarda os dois modos (d e PP do 1001) com a chave DESLIGADA" \
  "$(Ler 2027-01-20T15:00:00Z "SELECT (demanda_calendario = round(demanda_legado * 65 / 54.0, 4)) || '|' || (pp_calendario > pp_legado) || '|' || (max_calendario >= max_legado) || '|' || data_ref FROM public.reposicao_demanda_calendario_sombra WHERE sku_codigo_omie = 1001")" "true|true|true|2027-01-20"
eq S03 "o job não deixa a GUC 'valendo' viva na sessão" \
  "$(Ler 2027-01-20T15:00:00Z "BEGIN; $JOB; SELECT 'G=' || coalesce(nullif(current_setting('reposicao.demanda_calendario_forcar', true), ''), 'vazia'); ROLLBACK;" | grep -o 'G=.*')" G=vazia
eq S04 "job recusa COLACOR com 22023" \
  "$(Ler 2027-01-20T15:00:00Z "DO \$x\$ BEGIN PERFORM public.reposicao_demanda_calendario_sombra_registrar('COLACOR'); RAISE NOTICE 'X-PASSOU'; EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'X-NEGOU'; END \$x\$" | grep -o 'X-[A-Z]*')" X-NEGOU

echo
echo "TOTAL: $PASS PASS / $FAIL FALHAS (esperado $TOTAL_ESPERADO PASS)"
[ "$FAIL" -eq 0 ] && [ "$PASS" -eq "$TOTAL_ESPERADO" ] || exit 1
echo "FIM-OK ${SLUG}"
