#!/usr/bin/env bash
# Prova PG17 da migration 20261111160000_radar_agregado_visitar: a dimensão "para visitar" no agregado por
# município (mapa, ranking e o número do chip desligado do /radar). Parte dos corpos de PROD (fixture lida via
# psql-ro em 2026-11-09: recálculo, contagem, validade e a regra private.radar_contato_visitar), roda o recálculo
# PREDECESSOR (o agregado de prod sem a dimensão), aplica a migration REAL duas vezes e assevera:
#   A0  a fixture É o corpo de prod (md5 do prosrc = o predecessor que o PRE da migration aceita)
#   A1  apply; A2 re-apply idempotente
#   B1  logo depois do apply (agregado velho, sem a dimensão): p_so_visitar NÃO recorta e diz isso
#       (visitar_contado_em NULL), para_visitar/para_visitar_total NULL — nunca 0
#   B2  o tick do cron (sem forçar, mesmo dia, depois do marco) recalcula porque a dimensão falta
#   B3  o tick seguinte não recalcula
#   B4  contabilidade recalculada depois do agregado → o tick seguinte recalcula; B5 e depois não
#   C   EQUIVALÊNCIA com a regra da fila: em 14 recortes (padrão, UF, região, cidade, status, já-clientes,
#       telefone, contato, CNAE exato/família/secundário, estabelecidas, lote, inéditos) a contagem com
#       p_so_visitar = o oráculo (radar_empresas × private.radar_contato_visitar, linha a linha), o
#       para_visitar por município e o para_visitar_total com o chip DESLIGADO também
#   D1  a correção do vendedor conta: candidato só por correção positiva entra; correção positiva desfeita
#       depois (a mais nova vale) sai
#   E1  caminho VIVO (data mínima) com p_so_visitar: não recorta, visitar_contado_em NULL
#   E2  p_so_agregado num recorte vivo: 0 linhas e 0 leituras de radar_empresas (o chip nunca faz seq scan)
#   E3  o medidor tem dente: sem p_so_agregado o mesmo recorte lê radar_empresas
#   F1  agregado reescrito por código SEM a dimensão (DR do predecessor): a dimensão fica indisponível
#       (NULL), não conta 0; F2 o tick seguinte a recalcula
#   G1  total do recorte inteiro (janela ANTES do LIMIT): p_limit 1 ainda soma as 3 cidades
#   H1  municipio_codigo mal formado grita (P0001), nunca conta zero
#   I1  ACL: anon barrado no EXECUTE (42501); I2 private.radar_agregado_visitar_em fechada a authenticated
#   K1  PRE: recálculo vivo divergente ABORTA a migration e o banco fica como estava
#
#   bash db/test-radar-agregado-visitar.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-agregado-visitar.sh        # tem de ficar VERMELHA
#   bash db/test-radar-agregado-visitar.sh --falsificar             # controle verde + cada sabotagem no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-agregado-visitar.sh # os DOIS locales (CLAUDE.md)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261111160000_radar_agregado_visitar.sql"
PRED="$REPO_ROOT/db/fixtures/radar-agregado-visitar-predecessoras-prod-20261109.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<asserts que TÊM de acusá-la, unidos por ','>; `post:Pn` = a POSTCONDIÇÃO aborta com "Pn FALHOU".
  SABOTAGENS="sem_regra:C01 sem_candidato_correcao:D1a mapa_ignora_visitar:C01,C02 zero_fabricado:B1b nao_ve_contabil:B4a sempre_recalcula:B3,B5 validade_cega:F1 total_depois_do_limit:G1 vivo_le_tabela:E2 pre_cega:K1a acl_aberto:post:P5"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-visitar.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "RADAR_AGREGADO_VISITAR_PROVA_OK" "$LOGDIR/controle.log"; then
    echo "❌ controle sem marcador de fim — falsificação abortada"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; asserts="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    ok=1
    case "$asserts" in
      post:*) grep -q "${asserts#post:} FALHOU" "$LOGDIR/$s.log" || ok=0 ;;
      *) IFS=',' read -r -a lista <<< "$asserts"
         for a in "${lista[@]}"; do grep -q "^FAIL $a " "$LOGDIR/$s.log" || ok=0; done ;;
    esac
    if [ "$ok" -eq 1 ]; then echo "✅ $s → $asserts vermelho"
    else echo "❌ $s: vermelho, mas não em $asserts (log: $LOGDIR/$s.log)"; falhas=$((falhas+1)); fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5497}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-visitar.XXXXXX")"
DATA="$TMPD/data"
MIG_USADA="$TMPD/mig.sql"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
# $1 = de, $2 = para (literal); $3 = quantas vezes tem de ocorrer (default 1).
sabotar() {
  python3 -I - "$MIG_USADA" "$1" "$2" "${3:-1}" <<'PY'
import sys
p, de, para, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
s = open(p, encoding="utf-8").read()
if s.count(de) != n:
    sys.exit("padrao deve ocorrer %d vez(es), ocorre %d: %s" % (n, s.count(de), de))
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Sabotagem de CORPO muda o md5: recalcula e troca as constantes "este" do PRE e da PÓS (P3), para o
# comportamento sabotado chegar aos asserts (as de ACL/PRE mantêm o md5 e caem na própria migration).
remd5() {
  python3 -I - "$MIG_USADA" <<'PY'
import sys, hashlib
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
def md5_corpo(nome):
    i = s.index("CREATE OR REPLACE FUNCTION " + nome + "(")
    a = s.index("$function$", i) + len("$function$")
    return hashlib.md5(s[a:s.index("$function$", a)].encode()).hexdigest()
novo = {"2f226c740ad151ecfd0a2e4d0472c80d": md5_corpo("public.radar_agregado_recalcular"),
        "45e4f7424f2eb6d47e2544dcb58cd2c6": md5_corpo("public.radar_contagem_por_municipio")}
for velho, n in novo.items():
    s = s.replace(velho, n)
open(p, "w", encoding="utf-8").write(s)
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  sem_regra)              sabotar "       AND private.radar_contato_visitar(ev.cnpj, ev.telefone1, ev.telefone2, ev.email, ev.logradouro)" ""; remd5 ;;
  sem_candidato_correcao) sabotar "                       UNION SELECT k.cnpj FROM public.radar_contato_contabil_correcoes k WHERE k.veredito)" ")"; remd5 ;;
  mapa_ignora_visitar)    sabotar "  v_so_vis boolean := COALESCE(p_so_visitar, false) AND v_vis_em IS NOT NULL;" "  v_so_vis boolean := false;"; remd5 ;;
  zero_fabricado)         sabotar "CASE WHEN v_vis_em IS NOT NULL THEN COALESCE(sum(a.n) FILTER (WHERE a.visitar), 0)::bigint END" "COALESCE(sum(a.n) FILTER (WHERE a.visitar), 0)::bigint" 3; remd5 ;;
  nao_ve_contabil)        sabotar "     AND e.visitar_base_contabil IS NOT DISTINCT FROM v_contabil THEN" "     THEN"; remd5 ;;
  sempre_recalcula)       sabotar "     AND e.visitar_calculado_em IS NOT DISTINCT FROM e.calculado_em
" "     AND false
"; remd5 ;;
  validade_cega)          sabotar "     AND e.visitar_calculado_em = e.calculado_em
" "
" ;;
  total_depois_do_limit)  sabotar "(sum(sum(a.pv)) OVER ())::bigint" "sum(a.pv)::bigint" 3; remd5 ;;
  vivo_le_tabela)         sabotar "  IF COALESCE(p_so_agregado, false) THEN
    RETURN;
  END IF;" ""; remd5 ;;
  pre_cega)               sabotar "IF v_rec IS NULL OR v_rec NOT IN ('689efa9f14564f1c8643ebb04b158241', '2f226c740ad151ecfd0a2e4d0472c80d') THEN" "IF false THEN" ;;
  acl_aberto)             sabotar "boolean,text,boolean) FROM PUBLIC, anon;" "boolean,text,boolean) FROM anon;" ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# Erro esperado: devolve o stderr VERBOSE (a SQLSTATE vem antes da mensagem); o assert casa SQLSTATE+marca.
Perro() { if out="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "SEM_ERRO: $out"; else echo "$out"; fi; }

PASS=0; FAIL=0
eq()  { if [ "$2" = "$3" ]; then echo "PASS $1 = [$2]"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
tem() { if grep -qF -- "$3" <<<"$2"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — [$3] ausente em [$2]"; FAIL=$((FAIL+1)); fi; }

# ── Esquema mínimo (colunas de prod que os corpos leem) + stubs ──────────────────────────────────────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privilege do Supabase: função nova NASCE aberta (o REVOKE da migration é o que fecha).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth; CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
CREATE FUNCTION private.cap_radar_prospectar(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION public.radar_lote_publicando() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text NOT NULL, iniciado_em timestamptz NOT NULL);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, cnae_principal text NOT NULL, cnaes_secundarios text[] NOT NULL DEFAULT '{}'::text[],
  data_abertura date, logradouro text, municipio_codigo text, municipio_nome text, uf text,
  telefone1 text, telefone2 text, email text, primeira_vista_em timestamptz NOT NULL,
  ultimo_lote text NOT NULL, lote_anterior text, ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar', updated_at timestamptz NOT NULL);
CREATE INDEX ON public.radar_empresas (cnae_principal);
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text, uf text, lat double precision, lng double precision);
CREATE TABLE public.radar_agregado_estado (id smallint PRIMARY KEY CHECK (id = 1), base_lote text, base_iniciado_em timestamptz,
  calculado_em timestamptz NOT NULL, empresas bigint NOT NULL, grupos integer NOT NULL, corte_estabelecida date,
  cnaes_secundarios_cobertos text[]);
CREATE TABLE public.radar_agregado_cnae (lote text NOT NULL, municipio_codigo text, uf text, municipio_nome text,
  prospeccao_status text NOT NULL, ja_cliente boolean NOT NULL, tem_telefone boolean NOT NULL, tem_contato boolean NOT NULL,
  inedito boolean NOT NULL, cnae_principal text NOT NULL, estabelecida boolean NOT NULL, estabelecida_d1 boolean NOT NULL,
  n bigint NOT NULL CHECK (n > 0));
CREATE TABLE public.radar_agregado_cnae_sec (lote text NOT NULL, municipio_codigo text, uf text, municipio_nome text,
  prospeccao_status text NOT NULL, ja_cliente boolean NOT NULL, tem_telefone boolean NOT NULL, tem_contato boolean NOT NULL,
  inedito boolean NOT NULL, cnae_principal text NOT NULL, cnae_secundario text NOT NULL, estabelecida boolean NOT NULL,
  estabelecida_d1 boolean NOT NULL, n bigint NOT NULL CHECK (n > 0));
CREATE TABLE public.radar_agregado_municipio (lote text NOT NULL, municipio_codigo text, uf text, municipio_nome text,
  prospeccao_status text NOT NULL, ja_cliente boolean NOT NULL, tem_telefone boolean NOT NULL, tem_contato boolean NOT NULL,
  inedito boolean NOT NULL, n bigint NOT NULL CHECK (n > 0));
CREATE TABLE public.radar_contato_contabil (cnpj text NOT NULL, tipo text NOT NULL, valor text NOT NULL, motivos text[],
  grupos integer, corroborado boolean, versao_regra smallint, calculado_em timestamptz, PRIMARY KEY (cnpj, tipo, valor));
CREATE TABLE public.radar_contato_contabil_correcoes (id bigserial PRIMARY KEY, cnpj text NOT NULL, tipo text NOT NULL,
  valor text NOT NULL, campo text, veredito boolean, automatico boolean, substitui_id bigint, autor_user_id uuid,
  criado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_contato_contabil_estado (id boolean PRIMARY KEY DEFAULT true CHECK (id), calculado_em timestamptz NOT NULL);
SQL
P -q -f "$PRED"
# ACL de prod (medido 2026-11-09): contagem para authenticated/service_role; private.* só o owner.
P -q <<'SQL'
REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'private'::regnamespace LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
SQL

# A0: a fixture é o corpo de prod — e o PRE da migration aceita exatamente esse predecessor.
eq "A0a recálculo da fixture = md5 de prod" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.radar_agregado_recalcular(boolean,timestamptz)'::regprocedure")" \
   "689efa9f14564f1c8643ebb04b158241"
eq "A0b contagem da fixture = md5 de prod" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'radar_contagem_por_municipio'")" \
   "f79e5a814b622248b8d2845ef27edb65"

# ── Dados: 60 empresas em 3 cidades, lote 2026-10 vigente ─────────────────────────────────────────────────
#   cidade n%3: 0 → 4123/MG, 1 → 8105/SC, 2 → 7535/PR · CNAE par 4744001, ímpar 3101200 · secundário 3101200 (n%4=0)
#   abertura 2024 (n%5=0) senão 2015 · descartado n%7=0, em_conversa n%7=1 · já cliente n%11=0 · inédito n%6=0
#   saiu do dump (2026-08) n ≥ 59 · sem logradouro n%13=0 · telefone1 exceto n%9=0 · telefone2 n%8=0 · e-mail n%10=0
#   contabilidade: telefone1 dos pares, telefone2 só se n%16=0, e-mail só se n%20=0
P -q <<'SQL'
INSERT INTO public.radar_ingest_state VALUES ('2026-08', 'complete', '2026-08-20 16:00+00'), ('2026-10', 'complete', '2026-10-27 16:20+00');
INSERT INTO public.radar_municipios VALUES ('4123', 'BELO HORIZONTE', 'MG', -19.9, -43.9), ('8105', 'JOINVILLE', 'SC', -26.3, -48.8),
                                           ('7535', 'CURITIBA', 'PR', -25.4, -49.3);
INSERT INTO public.radar_empresas (cnpj, cnae_principal, cnaes_secundarios, data_abertura, logradouro, municipio_codigo,
  municipio_nome, uf, telefone1, telefone2, email, primeira_vista_em, ultimo_lote, ja_cliente, prospeccao_status, updated_at)
SELECT lpad(n::text, 12, '0') || '00',
       CASE WHEN n % 2 = 0 THEN '4744001' ELSE '3101200' END,
       CASE WHEN n % 4 = 0 THEN '{3101200}'::text[] ELSE '{}'::text[] END,
       CASE WHEN n % 5 = 0 THEN DATE '2024-01-01' ELSE DATE '2015-01-01' END,
       CASE WHEN n % 13 = 0 THEN NULL ELSE 'RUA ' || n END,
       (ARRAY['4123', '8105', '7535'])[n % 3 + 1], (ARRAY['BELO HORIZONTE', 'JOINVILLE', 'CURITIBA'])[n % 3 + 1],
       (ARRAY['MG', 'SC', 'PR'])[n % 3 + 1],
       CASE WHEN n % 9 = 0 THEN NULL ELSE '(47) 33' || lpad(n::text, 6, '0') END,
       CASE WHEN n % 8 = 0 THEN '47 99' || lpad(n::text, 6, '0') END,
       CASE WHEN n % 10 = 0 THEN 'E' || n || '@X.COM.BR' END,
       CASE WHEN n % 6 = 0 THEN TIMESTAMPTZ '2026-10-28 00:00+00' ELSE TIMESTAMPTZ '2026-06-01 00:00+00' END,
       CASE WHEN n >= 59 THEN '2026-08' ELSE '2026-10' END,
       n % 11 = 0,
       CASE WHEN n % 7 = 0 THEN 'descartado' WHEN n % 7 = 1 THEN 'em_conversa' ELSE 'a_contatar' END,
       TIMESTAMPTZ '2026-11-01 00:00+00'
  FROM generate_series(1, 60) n;
INSERT INTO public.radar_contato_contabil (cnpj, tipo, valor, motivos, grupos, corroborado, versao_regra, calculado_em)
SELECT e.cnpj, 'telefone', private.radar_tel_valor(e.telefone1), '{x}'::text[], 9, true, 1::smallint, '2026-11-09 06:50+00'::timestamptz
  FROM public.radar_empresas e WHERE substr(e.cnpj, 1, 12)::int % 2 = 0 AND e.telefone1 IS NOT NULL
UNION ALL
SELECT e.cnpj, 'telefone', private.radar_tel_valor(e.telefone2), '{x}'::text[], 9, true, 1::smallint, '2026-11-09 06:50+00'::timestamptz
  FROM public.radar_empresas e WHERE substr(e.cnpj, 1, 12)::int % 16 = 0
UNION ALL
SELECT e.cnpj, 'email', private.radar_email_valor(e.email), '{x}'::text[], 9, true, 1::smallint, '2026-11-09 06:50+00'::timestamptz
  FROM public.radar_empresas e WHERE substr(e.cnpj, 1, 12)::int % 20 = 0;
-- Correções do vendedor: n=25 (ímpar, só telefone1, fora da contabilidade) marcado "é da contabilidade" → visitar;
-- n=28 (par, telefone1 da contabilidade) marcado "é" e DEPOIS "não é" → a mais nova vale → não visitar;
-- n=37 marcado "é" e depois desfeito (NULL = volta ao automático, que diz "não é") → não visitar.
INSERT INTO public.radar_contato_contabil_correcoes (cnpj, tipo, valor, campo, veredito)
SELECT e.cnpj, 'telefone', private.radar_tel_valor(e.telefone1), 'telefone1', v.veredito
  FROM (VALUES (25, true, 1), (28, true, 1), (28, false, 2), (37, true, 1), (37, NULL::boolean, 2)) AS v(n, veredito, ordem)
  JOIN public.radar_empresas e ON e.cnpj = lpad(v.n::text, 12, '0') || '00'
 ORDER BY v.ordem, v.n;
INSERT INTO public.radar_contato_contabil_estado (id, calculado_em) VALUES (true, '2026-11-09 06:50+00');
SQL

# O agregado de prod hoje: o predecessor calculou às 06:35 (sem a dimensão).
Pq -c "SELECT public.radar_agregado_recalcular(true, '2026-11-09 06:35+00')" >/dev/null

# ── K: PRE anti-deriva (antes do apply real): recálculo vivo diferente do revisado aborta, banco intacto ─────
P -q <<'SQL'
DO $$ DECLARE d text := pg_get_functiondef('public.radar_agregado_recalcular(boolean,timestamptz)'::regprocedure);
BEGIN EXECUTE replace(d, '-- Um cálculo por vez', '-- (deriva de outra sessão) Um cálculo por vez'); END $$;
SQL
k_out="$(P -q -f "$MIG_USADA" 2>&1 || true)"
tem "K1a recálculo vivo divergente → PRE FALHOU" "$k_out" "PRE FALHOU: radar_agregado_recalcular vivo"
eq "K1b o abort não deixou nada (sem coluna visitar, contagem velha de pé)" \
   "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name = 'radar_agregado_municipio' AND column_name = 'visitar'")|$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname = 'radar_contagem_por_municipio' AND pronargs = 14")" \
   "0|1"
# restaura o predecessor de prod (só o recálculo) para o apply real
python3 -I - "$PRED" > "$TMPD/rec.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.radar_agregado_recalcular(")
j = s.index("$function$", s.index("$function$", i) + 10) + len("$function$")
print(s[i:j] + ";")
PY
P -q -f "$TMPD/rec.sql"

# ── A: apply (2×) ───────────────────────────────────────────────────────────────────────────────────────
P -q -f "$MIG_USADA" > "$TMPD/apply1.log" 2>&1 || { cat "$TMPD/apply1.log"; echo "FAIL A1 apply abortou"; exit 1; }
echo "PASS A1 migration aplica (postcondição verde)"; PASS=$((PASS+1))
P -q -f "$MIG_USADA" > "$TMPD/apply2.log" 2>&1 || { cat "$TMPD/apply2.log"; echo "FAIL A2 re-apply abortou"; exit 1; }
echo "PASS A2 re-apply idempotente"; PASS=$((PASS+1))

# Contagem → "cod:total:para_visitar:contado?" por cidade (como authenticated, o papel da tela).
cont() { # $1 = args nomeados extras (SQL), ex.: "p_uf => 'MG'"
  Pq -c "SET ROLE authenticated; SELECT COALESCE(string_agg(municipio_codigo || ':' || total || ':' || COALESCE(para_visitar::text, 'null') || ':' || COALESCE(para_visitar_total::text, 'null') || ':' || (visitar_contado_em IS NOT NULL), ',' ORDER BY municipio_codigo), '-') FROM public.radar_contagem_por_municipio(p_lote => '2026-10'${1:+, $1});" | tail -1
}
so_total() { # o mesmo, só "cod:total" (para comparar recortes)
  Pq -c "SET ROLE authenticated; SELECT COALESCE(string_agg(municipio_codigo || ':' || total, ',' ORDER BY municipio_codigo), '-') FROM public.radar_contagem_por_municipio(p_lote => '2026-10'${1:+, $1});" | tail -1
}
recalc() { Pq -c "SELECT public.radar_agregado_recalcular(false, '$1')->>'recalculou'"; }

# ── B: depois do apply, antes do tick ──────────────────────────────────────────────────────────────────────
eq "B1a p_so_visitar sem a dimensão NÃO recorta (mesmos totais do recorte sem o chip)" \
   "$(so_total "p_so_visitar => true")" "$(so_total "")"
eq "B1b sem a dimensão: para_visitar e total NULL e contado_em NULL — nunca 0" \
   "$(cont "p_so_visitar => true" | tr ',' '\n' | cut -d: -f3- | sort -u | tr '\n' ' ')" "null:null:false "
eq "B2 tick das 07:35 (mesmo dia, depois do marco) recalcula: a dimensão falta" "$(recalc '2026-11-09 07:35+00')" "true"
eq "B3 tick das 08:35 não recalcula" "$(recalc '2026-11-09 08:35+00')" "false"
P -q -c "UPDATE public.radar_contato_contabil_estado SET calculado_em = '2026-11-09 08:50+00'"
eq "B4a contabilidade recalculada depois → o tick das 09:35 recalcula" "$(recalc '2026-11-09 09:35+00')" "true"
eq "B4b o estado guarda a contabilidade lida" \
   "$(Pq -c "SELECT visitar_base_contabil = '2026-11-09 08:50+00' AND visitar_calculado_em = calculado_em FROM public.radar_agregado_estado")" "t"
eq "B5 e o das 10:35 não" "$(recalc '2026-11-09 10:35+00')" "false"

# ── C: equivalência com a regra da fila, linha a linha ───────────────────────────────────────────────────────
P -q <<'SQL'
CREATE FUNCTION public.oraculo(p_uf text, p_ufs text[], p_mc text, p_status text, p_jc boolean, p_tel boolean, p_cont boolean,
                               p_cx text, p_cp text, p_cs text, p_dmax date, p_pv timestamptz)
RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(mc || ':' || n, ',' ORDER BY mc), '-') FROM (
    SELECT re.municipio_codigo AS mc, count(*) AS n
      FROM public.radar_empresas re
     WHERE re.ultimo_lote = '2026-10'
       AND (p_uf IS NULL OR re.uf = p_uf) AND (p_uf IS NOT NULL OR p_ufs IS NULL OR re.uf = ANY (p_ufs))
       AND (p_mc IS NULL OR re.municipio_codigo = p_mc)
       AND ((p_status IS NOT NULL AND re.prospeccao_status = p_status) OR (p_status IS NULL AND re.prospeccao_status <> 'descartado'))
       AND (p_jc OR NOT re.ja_cliente)
       AND (NOT p_tel OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)
       AND (NOT p_cont OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL)
       AND (p_cx IS NULL OR re.cnae_principal = p_cx) AND (p_cp IS NULL OR starts_with(re.cnae_principal, p_cp))
       AND (p_cs IS NULL OR re.cnaes_secundarios @> ARRAY[p_cs])
       AND (p_dmax IS NULL OR re.data_abertura <= p_dmax)
       AND (p_pv IS NULL OR re.primeira_vista_em >= p_pv)
       AND private.radar_contato_visitar(re.cnpj, re.telefone1, re.telefone2, re.email, re.logradouro)
     GROUP BY 1) x
$$;
SQL
CORTE="$(Pq -c "SELECT corte_estabelecida FROM public.radar_agregado_estado")"
# id | args da contagem | args do oráculo (uf, ufs, mc, status, jc, tel, cont, cx, cp, cs, dmax, pv)
while IFS='|' read -r id args orac; do
  [ -n "$id" ] || continue
  visitar="$(so_total "p_so_visitar => true${args:+, $args}")"
  esperado="$(Pq -c "SELECT public.oraculo($orac)")"
  eq "C$id p_so_visitar = regra da fila [$args]" "$visitar" "$esperado"
  # chip DESLIGADO: para_visitar por cidade (só as que têm) e o total do recorte batem com o oráculo
  desligado="$(Pq -c "SET ROLE authenticated; SELECT COALESCE(string_agg(municipio_codigo || ':' || para_visitar, ',' ORDER BY municipio_codigo) FILTER (WHERE para_visitar > 0), '-') || '|' || COALESCE(max(para_visitar_total)::text, 'null') FROM public.radar_contagem_por_municipio(p_lote => '2026-10'${args:+, $args});" | tail -1)"
  soma="$(Pq -c "SELECT COALESCE(sum(split_part(x, ':', 2)::int), 0) FROM unnest(string_to_array(NULLIF(public.oraculo($orac), '-'), ',')) x")"
  eq "C${id}d chip desligado: para_visitar por cidade e total [$args]" "$desligado" "$esperado|$soma"
done <<EOF
01||NULL, NULL, NULL, NULL, false, false, false, NULL, NULL, NULL, NULL, NULL
02|p_uf => 'SC'|'SC', NULL, NULL, NULL, false, false, false, NULL, NULL, NULL, NULL, NULL
03|p_ufs => ARRAY['MG','PR']|NULL, ARRAY['MG','PR'], NULL, NULL, false, false, false, NULL, NULL, NULL, NULL, NULL
04|p_municipio_codigo => '7535'|NULL, NULL, '7535', NULL, false, false, false, NULL, NULL, NULL, NULL, NULL
05|p_status => 'em_conversa'|NULL, NULL, NULL, 'em_conversa', false, false, false, NULL, NULL, NULL, NULL, NULL
06|p_incluir_ja_clientes => true|NULL, NULL, NULL, NULL, true, false, false, NULL, NULL, NULL, NULL, NULL
07|p_com_telefone => true|NULL, NULL, NULL, NULL, false, true, false, NULL, NULL, NULL, NULL, NULL
08|p_com_contato => true|NULL, NULL, NULL, NULL, false, false, true, NULL, NULL, NULL, NULL, NULL
09|p_cnae_exato => '4744001'|NULL, NULL, NULL, NULL, false, false, false, '4744001', NULL, NULL, NULL, NULL
10|p_cnae_prefix => '47', p_uf => 'MG'|'MG', NULL, NULL, NULL, false, false, false, NULL, '47', NULL, NULL, NULL
11|p_cnae_secundario => '3101200'|NULL, NULL, NULL, NULL, false, false, false, NULL, NULL, '3101200', NULL, NULL
12|p_data_abertura_max => '$CORTE'|NULL, NULL, NULL, NULL, false, false, false, NULL, NULL, NULL, '$CORTE', NULL
13|p_primeira_vista_min => '2026-10-27 16:20+00'|NULL, NULL, NULL, NULL, false, false, false, NULL, NULL, NULL, NULL, '2026-10-27 16:20+00'
14|p_cnae_secundario => '3101200', p_municipio_codigo => '4123'|NULL, NULL, '4123', NULL, false, false, false, NULL, NULL, '3101200', NULL, NULL
EOF
eq "C00 o recorte padrão tem para-visitar de verdade (o oráculo não é vazio)" \
   "$(Pq -c "SELECT public.oraculo(NULL, NULL, NULL, NULL, false, false, false, NULL, NULL, NULL, NULL, NULL) <> '-'")" "t"
eq "C0c com a dimensão, contado_em = calculado_em do agregado em todas as linhas" \
   "$(Pq -c "SET ROLE authenticated; SELECT bool_and(visitar_contado_em = '2026-11-09 09:35+00') FROM public.radar_contagem_por_municipio(p_lote => '2026-10', p_so_visitar => true)" | tail -1)" "t"

# ── D: a correção do vendedor ──────────────────────────────────────────────────────────────────────────────
TOTAL_REGRA="$(Pq -c "SELECT count(*) FROM public.radar_empresas re WHERE private.radar_contato_visitar(re.cnpj, re.telefone1, re.telefone2, re.email, re.logradouro)")"
eq "D1a n=25 (só a correção positiva o põe entre os candidatos) é para visitar, e o agregado conta todos os da regra" \
   "$(Pq -c "SELECT private.radar_contato_visitar(cnpj, telefone1, telefone2, email, logradouro) FROM public.radar_empresas WHERE cnpj = '00000000002500'")|$(Pq -c "SELECT COALESCE(sum(n) FILTER (WHERE visitar), 0) FROM public.radar_agregado_municipio")" \
   "t|$TOTAL_REGRA"
eq "D1b n=28 e n=37 (correção positiva desfeita depois — a mais nova vale) não são para visitar" \
   "$(Pq -c "SELECT string_agg(private.radar_contato_visitar(cnpj, telefone1, telefone2, email, logradouro)::text, ',' ORDER BY cnpj) FROM public.radar_empresas WHERE cnpj IN ('00000000002800', '00000000003700')")" "false,false"

# ── E: caminho VIVO ────────────────────────────────────────────────────────────────────────────────────────
eq "E1 data mínima (vivo) com p_so_visitar: não recorta e diz (contado_em NULL)" \
   "$(cont "p_so_visitar => true, p_data_abertura_min => '2000-01-01'" | tr ',' '\n' | cut -d: -f3- | sort -u | tr '\n' ' ')|$(so_total "p_so_visitar => true, p_data_abertura_min => '2000-01-01'")" \
   "null:null:false |$(so_total "p_data_abertura_min => '2000-01-01'")"
leituras() { # $1 = args; devolve "linhas leituras_de_radar_empresas" na MESMA transação
  Pq <<SQL | tail -1
BEGIN;
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE r AS SELECT * FROM public.radar_contagem_por_municipio(p_lote => '2026-10', $1);
RESET ROLE;
SELECT (SELECT count(*) FROM r) || ' ' || (SELECT coalesce(sum(seq_scan + coalesce(idx_scan, 0)), 0) FROM pg_stat_xact_user_tables WHERE relname = 'radar_empresas');
ROLLBACK;
SQL
}
eq "E2 p_so_agregado num recorte vivo: 0 linhas e 0 leituras de radar_empresas" \
   "$(leituras "p_data_abertura_min => '2000-01-01', p_so_agregado => true, p_limit => 1")" "0 0"
eq "E3 o medidor tem dente: sem p_so_agregado o mesmo recorte lê radar_empresas" \
   "$(leituras "p_data_abertura_min => '2000-01-01', p_limit => 1" | awk '{print ($1 > 0 && $2 > 0)}')" "1"

# ── F: agregado reescrito por código SEM a dimensão (o predecessor de prod reaplicado, DR) ────────────────────
python3 -I - "$PRED" > "$TMPD/velho.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.radar_agregado_recalcular(")
j = s.index("$function$", s.index("$function$", i) + 10) + len("$function$")
print(s[i:j].replace("public.radar_agregado_recalcular(", "public.radar_agregado_recalcular_velho(", 1) + ";")
PY
P -q -f "$TMPD/velho.sql"
Pq -c "SELECT public.radar_agregado_recalcular_velho(true, '2026-11-09 11:00+00')" >/dev/null
eq "F1 depois do código velho: a dimensão fica indisponível (NULL), não conta 0" \
   "$(cont "p_so_visitar => true" | tr ',' '\n' | cut -d: -f3- | sort -u | tr '\n' ' ')" "null:null:false "
eq "F2 o tick seguinte a recalcula" "$(recalc '2026-11-09 11:35+00')" "true"

# ── G: o total do recorte inteiro sai antes do LIMIT ────────────────────────────────────────────────────────
eq "G1 p_limit 1: para_visitar_total ainda soma as 3 cidades" \
   "$(Pq -c "SET ROLE authenticated; SELECT para_visitar_total FROM public.radar_contagem_por_municipio(p_lote => '2026-10', p_limit => 1, p_so_agregado => true)" | tail -1)" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas re WHERE ultimo_lote = '2026-10' AND prospeccao_status <> 'descartado' AND NOT ja_cliente AND private.radar_contato_visitar(re.cnpj, re.telefone1, re.telefone2, re.email, re.logradouro)")"

# ── H/I: entrada mal formada e ACL ───────────────────────────────────────────────────────────────────────────
h="$(Perro "SET ROLE authenticated; SELECT * FROM public.radar_contagem_por_municipio(p_municipio_codigo => '81')")"
tem "H1 municipio_codigo mal formado: P0001 + marca" "$h" "P0001"
tem "H1b … com a mensagem" "$h" "municipio_codigo inv"
i1="$(Perro "SET ROLE anon; SELECT * FROM public.radar_contagem_por_municipio()")"
tem "I1 anon barrado no EXECUTE da contagem (42501)" "$i1" "42501"
eq "I2 private.radar_agregado_visitar_em fechada a authenticated" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', 'private.radar_agregado_visitar_em()', 'EXECUTE')")" "f"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "RADAR_AGREGADO_VISITAR_PROVA_OK"
