#!/usr/bin/env bash
# Prova PG17 da migration 20261120140000_radar_agregado_incremental_corte: o recálculo diário do agregado do Radar
# ajusta só as empresas que cruzam o corte de "estabelecida" quando nada mais mudou. Parte do estado de PROD
# (fixture das predecessoras de 2026-11-09 + a migration 20261111160000, cujo recálculo tem o md5 vivo de prod
# lido via psql-ro em 2026-11-20), aplica a migration REAL duas vezes e assevera:
#   A0  o recálculo antes do apply É o de prod (md5 do prosrc), e a regra "para visitar" da fixture também
#   A1  apply; A2 re-apply idempotente; A3 o completo NOVO = o predecessor no mesmo instante (dump das 3 tabelas)
#   S1  semente: sem escrita depois do último completo, completo_em = calculado_em e impressão gravada
#   B   EQUIVALÊNCIA: em cada tick diário incremental (5 seguidos, com um salto de 2 dias, e mais 7 depois de
#       completos), modo incremental, grupos alterados > 0 e o agregado (fino, _sec, município, estado) IGUAL ao
#       recálculo completo no mesmo instante; B1h o tick seguinte não recalcula; Bv quem tem "para visitar"
#       muda de grupo
#   R   rede: o completo com 6 d 12 h ou mais → completo (motivo rede); o dia seguinte volta a ser incremental
#   C   escrita → completo: C1 updated_at novo, C2 já-cliente sem bump, C3 correção do vendedor, C4 exclusão de
#       escopo contato (2 dias seguidos: a impressão igual não basta), C5 contabilidade, C6 lote novo, C7 corte
#       gravado à frente do de hoje (guarda: só p_forcar com p_agora futuro o produz)
#   D   D1 agregado incoerente (grupo apagado) → CHECK (n > 0) → completo (delta_inconsistente), igual ao completo;
#       D2 escrita que commita DURANTE o delta → volta atrás → completo (escrita_durante_delta); D2c a escrita
#       feita durante o completo é vista no dia seguinte (a impressão é lida ANTES)
#   E   E1 o incremental faz 0 seq scans em radar_empresas (pg_stat_xact); E2 o completo lê (o medidor tem dente)
#   G   ACL: anon/authenticated sem EXECUTE no recálculo, no delta e na impressão
#   K   K1 PRE: recálculo vivo divergente ABORTA e o banco fica como estava; K2 semente NÃO grava com escrita
#       depois do último completo
#
#   bash db/test-radar-agregado-incremental.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-agregado-incremental.sh        # tem de ficar VERMELHA
#   bash db/test-radar-agregado-incremental.sh --falsificar             # controle verde + cada sabotagem no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-agregado-incremental.sh # os DOIS locales (CLAUDE.md)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261120140000_radar_agregado_incremental_corte.sql"
MIG_VISITAR="$REPO_ROOT/supabase/migrations/20261111160000_radar_agregado_visitar.sql"
PRED="$REPO_ROOT/db/fixtures/radar-agregado-visitar-predecessoras-prod-20261109.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<asserts que TÊM de acusá-la, unidos por ','>; `post:Pn` = a POSTCONDIÇÃO aborta com "Pn FALHOU".
  SABOTAGENS="est1_parado:B1e faixa_curta:B1e sem_sec:B1e gate_sem_impressao:C1a impressao_sem_jc:C2a impressao_sem_correcoes:C3a sem_exclusao_contato:C4b sem_rede:R1 sem_fallback:D1a sem_recheck:D2a corte_volta:C7a semente_cega:K2 pre_cega:K1a sempre_completo:B1m,E1 acl_aberto:post:P4"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-incremental.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "RADAR_AGREGADO_INCREMENTAL_PROVA_OK" "$LOGDIR/controle.log"; then
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
PORT="${PGPORT_TEST:-5498}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-incremental.XXXXXX")"
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
# Sabotagem de CORPO muda o md5: recalcula e troca as constantes "este" do PRE e da PÓS (P2), para o
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
novo = {"209066abac30ebc4cb8b54c1e55346c3": md5_corpo("public.radar_agregado_recalcular"),
        "bc0a659e2ee76728a47f737ee9aae162": md5_corpo("private.radar_agregado_delta_corte"),
        "570f951899fcf167f6902cef8e2ded79": md5_corpo("private.radar_agregado_impressao")}
for velho, n in novo.items():
    s = s.replace(velho, n)
open(p, "w", encoding="utf-8").write(s)
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  est1_parado)            sabotar "re.data_abertura <= p_para + 1 AS est1_n" "re.data_abertura <= p_de + 1 AS est1_n"; remd5 ;;
  faixa_curta)            sabotar "     WHERE re.data_abertura > p_de AND re.data_abertura <= p_para + 1" "     WHERE re.data_abertura > p_de AND re.data_abertura <= p_para"; remd5 ;;
  sem_sec)                sabotar "SELECT DISTINCT x.cs FROM unnest(m.mcss) AS x(cs) WHERE x.cs = ANY (p_cobertos)" "SELECT DISTINCT x.cs FROM unnest(m.mcss) AS x(cs) WHERE false"; remd5 ;;
  gate_sem_impressao)     sabotar "    WHEN e.impressao IS DISTINCT FROM v_impressao THEN 'escrita'
" ""; remd5 ;;
  impressao_sem_jc)       sabotar "    'ja_clientes',    (SELECT count(*) FROM public.radar_empresas re WHERE re.ja_cliente)," ""; remd5 ;;
  impressao_sem_correcoes) sabotar "    'correcoes',      (SELECT count(*) || ':' || COALESCE(max(k.id)::text, '-') FROM public.radar_contato_contabil_correcoes k)," ""; remd5 ;;
  sem_exclusao_contato)   sabotar "    WHEN EXISTS (SELECT 1 FROM public.radar_exclusoes_titular x WHERE x.escopo = 'contato') THEN 'exclusao_contato'
" ""; remd5 ;;
  sem_rede)               sabotar "    WHEN e.completo_em <= p_agora - interval '6 days 12 hours' THEN 'rede'
" ""; remd5 ;;
  sem_fallback)           sabotar "      WHEN check_violation THEN v_motivo := 'delta_inconsistente';
" ""; remd5 ;;
  sem_recheck)            sabotar "      IF private.radar_agregado_impressao() IS DISTINCT FROM v_impressao THEN
        RAISE EXCEPTION 'impressao mudou durante o delta' USING ERRCODE = 'RA001';
      END IF;" ""; remd5 ;;
  corte_volta)            sabotar "    WHEN e.corte_estabelecida IS NULL OR v_corte < e.corte_estabelecida THEN 'corte'
" ""; remd5 ;;
  semente_cega)           sabotar "   AND COALESCE((SELECT max(re.updated_at) FROM public.radar_empresas re) <= e.calculado_em, true)
" "" ;;
  pre_cega)               sabotar "IF v_rec IS NULL OR v_rec NOT IN ('2f226c740ad151ecfd0a2e4d0472c80d', '209066abac30ebc4cb8b54c1e55346c3') THEN" "IF false THEN" ;;
  sempre_completo)        sabotar "  IF v_motivo IS NULL THEN
    BEGIN" "  IF false THEN
    BEGIN"; remd5 ;;
  acl_aberto)             sabotar "REVOKE ALL ON FUNCTION private.radar_agregado_delta_corte(date, date, timestamptz, text[]) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION private.radar_agregado_delta_corte(date, date, timestamptz, text[]) FROM anon;" ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

PASS=0; FAIL=0
eq()  { if [ "$2" = "$3" ]; then echo "PASS $1 = [$2]"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
tem() { if grep -qF -- "$3" <<<"$2"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — [$3] ausente em [$2]"; FAIL=$((FAIL+1)); fi; }
dif() { if [ "$2" != "$3" ]; then echo "PASS $1 (mudou)"; PASS=$((PASS+1)); else echo "FAIL $1 — não mudou [$2]"; FAIL=$((FAIL+1)); fi; }

# ── Esquema mínimo (colunas e índices de prod que os corpos leem) + stubs ────────────────────────────────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
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
CREATE INDEX idx_radar_empresas_cnae ON public.radar_empresas (cnae_principal);
CREATE INDEX idx_radar_empresas_fila ON public.radar_empresas (ultimo_lote, prospeccao_status, data_abertura DESC);
CREATE INDEX idx_radar_empresas_updated_at ON public.radar_empresas (updated_at);
CREATE INDEX idx_radar_empresas_ja_cliente ON public.radar_empresas (municipio_codigo, uf) WHERE ja_cliente;
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
CREATE TABLE public.radar_exclusoes_titular (raiz text PRIMARY KEY, escopo text NOT NULL CHECK (escopo IN ('qsa', 'contato')),
  finalidade text NOT NULL DEFAULT 'pedido do titular (teste)', registrado_em timestamptz NOT NULL DEFAULT now());
SQL
P -q -f "$PRED"
P -q -f "$MIG_VISITAR" > "$TMPD/visitar.log" 2>&1 || { cat "$TMPD/visitar.log"; echo "FAIL A0 estado de prod (20261111160000) não montou"; exit 1; }
P -q <<'SQL'
REVOKE ALL ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'private'::regnamespace LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
SQL

eq "A0 recálculo antes do apply = md5 vivo de prod (2026-11-20)" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.radar_agregado_recalcular(boolean,timestamptz)'::regprocedure")" \
   "2f226c740ad151ecfd0a2e4d0472c80d"

# ── Dados ───────────────────────────────────────────────────────────────────────────────────────────────────
# Corte de 11/11/2026 (SP) = 2021-11-11. Enchimento: 20 mil empresas que nunca cruzam (2010, 2024 ou sem data), em 2
# lotes e 4 status, para o planejador usar os índices como em prod. Cruzam: 4 por dia de abertura entre 2021-11-08 e
# 2021-12-07, variando cidade (inclusive NULL), status, já-cliente, inédito, telefone/e-mail, CNAE e secundários
# cobertos (com código repetido no array) e "para visitar" (telefone1 da contabilidade nos m%4 = 0).
P -q <<'SQL'
INSERT INTO public.radar_ingest_state VALUES ('2026-08', 'complete', '2026-08-20 16:00+00'), ('2026-10', 'complete', '2026-10-27 16:20+00');
INSERT INTO public.radar_municipios VALUES ('4123', 'BELO HORIZONTE', 'MG', -19.9, -43.9), ('8105', 'JOINVILLE', 'SC', -26.3, -48.8);
INSERT INTO public.radar_empresas (cnpj, cnae_principal, cnaes_secundarios, data_abertura, logradouro, municipio_codigo,
  municipio_nome, uf, telefone1, telefone2, email, primeira_vista_em, ultimo_lote, ja_cliente, prospeccao_status, updated_at)
SELECT 'F' || lpad(n::text, 13, '0'),
       CASE WHEN n % 2 = 0 THEN '4744001' ELSE '3101200' END,
       CASE WHEN n % 5 = 0 THEN '{3101200}'::text[] ELSE '{}'::text[] END,
       CASE n % 3 WHEN 0 THEN DATE '2010-05-05' WHEN 1 THEN DATE '2024-03-03' END,
       'RUA ' || n, (ARRAY['4123', '8105'])[n % 2 + 1], (ARRAY['BELO HORIZONTE', 'JOINVILLE'])[n % 2 + 1], (ARRAY['MG', 'SC'])[n % 2 + 1],
       CASE WHEN n % 4 = 0 THEN NULL ELSE '(47) 30' || lpad(n::text, 6, '0') END, NULL, NULL,
       TIMESTAMPTZ '2026-06-01 00:00+00', CASE WHEN n % 9 = 0 THEN '2026-08' ELSE '2026-10' END, n % 97 = 0,
       (ARRAY['a_contatar', 'descartado', 'em_conversa', 'contatado_sem_resposta'])[n % 4 + 1],
       TIMESTAMPTZ '2026-11-01 00:00+00'
  FROM generate_series(1, 20000) n;
INSERT INTO public.radar_empresas (cnpj, cnae_principal, cnaes_secundarios, data_abertura, logradouro, municipio_codigo,
  municipio_nome, uf, telefone1, telefone2, email, primeira_vista_em, ultimo_lote, ja_cliente, prospeccao_status, updated_at)
SELECT 'C' || lpad(m::text, 13, '0'),
       CASE WHEN m % 2 = 0 THEN '4744001' ELSE '3101200' END,
       CASE m % 3 WHEN 0 THEN '{3101200,3101200}'::text[] WHEN 1 THEN '{4744001,9999999}'::text[] ELSE '{}'::text[] END,
       DATE '2021-11-08' + (m / 4),
       CASE WHEN m % 7 = 3 THEN NULL ELSE 'AV ' || m END,
       CASE WHEN m % 11 = 5 THEN NULL ELSE (ARRAY['4123', '8105'])[m % 2 + 1] END,
       CASE WHEN m % 11 = 5 THEN NULL ELSE (ARRAY['BELO HORIZONTE', 'JOINVILLE'])[m % 2 + 1] END,
       CASE WHEN m % 11 = 5 THEN NULL ELSE (ARRAY['MG', 'SC'])[m % 2 + 1] END,
       CASE WHEN m % 5 = 4 THEN NULL ELSE '(47) 31' || lpad(m::text, 6, '0') END,
       CASE WHEN m % 6 = 0 THEN '47 98' || lpad(m::text, 6, '0') END,
       CASE WHEN m % 3 = 2 THEN 'C' || m || '@X.COM.BR' END,
       CASE WHEN m % 4 = 1 THEN TIMESTAMPTZ '2026-10-28 00:00+00' ELSE TIMESTAMPTZ '2026-06-01 00:00+00' END,
       CASE WHEN m % 8 = 7 THEN '2026-08' ELSE '2026-10' END,
       m % 13 = 0,
       (ARRAY['a_contatar', 'descartado', 'em_conversa'])[m % 3 + 1],
       TIMESTAMPTZ '2026-11-01 00:00+00'
  FROM generate_series(0, 119) m;
-- "Para visitar" verdadeiro: telefone1 da contabilidade (m%4 = 0, com logradouro e sem outro contato fora dela).
INSERT INTO public.radar_contato_contabil (cnpj, tipo, valor, motivos, grupos, corroborado, versao_regra, calculado_em)
SELECT e.cnpj, 'telefone', private.radar_tel_valor(e.telefone1), '{x}'::text[], 9, true, 1::smallint, '2026-11-09 06:50+00'::timestamptz
  FROM public.radar_empresas e
 WHERE e.cnpj LIKE 'C%' AND substr(e.cnpj, 2)::int % 4 = 0 AND e.telefone1 IS NOT NULL;
-- C…0042: candidato por um sinal antigo (outro telefone) e escrito DEPOIS do cálculo da contabilidade — "não sei".
INSERT INTO public.radar_contato_contabil (cnpj, tipo, valor, motivos, grupos, corroborado, versao_regra, calculado_em)
VALUES ('C0000000000042', 'telefone', '4700000000', '{x}', 9, true, 1, '2026-11-09 06:50+00') ON CONFLICT DO NOTHING;
UPDATE public.radar_empresas SET updated_at = '2026-11-09 12:00+00' WHERE cnpj = 'C0000000000042';
INSERT INTO public.radar_contato_contabil_estado (id, calculado_em) VALUES (true, '2026-11-09 06:50+00');
ANALYZE;
SQL

eq "A0b a regra \"para visitar\" da fixture = md5 vivo de prod (avaliar, visitar, e-mail, telefone)" \
   "$(Pq -c "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('radar_contato_contabil_avaliar', 'radar_contato_visitar', 'radar_tel_valor', 'radar_email_valor')")" \
   "9d21d6edae10cb972feb756465104eb1,9a355f404f263144e2bf9d49d4aa3db3,8b5ff168a311e6c09f2c12bdc0ab5b1b,8022a3be3226d0e8ee9c062ee52a5bfe"
eq "Bv0 a regra devolve true e false entre quem cruza (nunca NULL: bool_and de IS TRUE)" \
   "$(Pq -c "SELECT string_agg(DISTINCT COALESCE(private.radar_contato_visitar(cnpj, telefone1, telefone2, email, logradouro)::text, 'null'), ',') FROM public.radar_empresas WHERE cnpj LIKE 'C%'")" \
   "false,true"

# dump do agregado inteiro: as 3 tabelas como multiconjunto + o estado que a tela lê
DUMP_SQL="SELECT (SELECT count(*) || ':' || md5(string_agg(t::text, '|' ORDER BY t::text)) FROM public.radar_agregado_cnae t)
  || '/' || (SELECT count(*) || ':' || md5(string_agg(t::text, '|' ORDER BY t::text)) FROM public.radar_agregado_cnae_sec t)
  || '/' || (SELECT count(*) || ':' || md5(string_agg(t::text, '|' ORDER BY t::text)) FROM public.radar_agregado_municipio t)
  || '/' || (SELECT empresas || ':' || grupos || ':' || corte_estabelecida || ':' || cnaes_secundarios_cobertos::text
               FROM public.radar_agregado_estado)"
dump() { Pq -c "$DUMP_SQL"; }
# o recálculo COMPLETO no instante $1, numa transação desfeita: o oráculo da equivalência
completo_em_rollback() { Pq <<SQL | tail -1
BEGIN;
SELECT public.radar_agregado_recalcular(true, '$1') IS NOT NULL;
$DUMP_SQL;
ROLLBACK;
SQL
}
# tick do cron no instante $1 → "recalculou:modo:motivo|grupos_alterados"
tick() { Pq -c "SELECT (j->>'recalculou') || ':' || COALESCE(j->>'modo', '-') || ':' || COALESCE(j->>'motivo', '-') || '|' || COALESCE(j->>'grupos_alterados', '-') FROM (SELECT public.radar_agregado_recalcular(false, '$1') AS j) x"; }
modo() { cut -d'|' -f1 <<<"$1"; }
positivo() { if [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -gt 0 ]; then echo "PASS $1 = [$2]"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado > 0"; FAIL=$((FAIL+1)); fi; }

# O agregado de prod hoje: o predecessor calculou às 06:35 de 10/11 (depois da última escrita, 09/11 12:00).
Pq -c "SELECT public.radar_agregado_recalcular(true, '2026-11-10 06:35+00')" >/dev/null
PRED_COMPLETO="$(completo_em_rollback '2026-11-13 06:35+00')"

# ── K: PRE anti-deriva e semente negativa (antes do apply real) ─────────────────────────────────────────────────
P -q <<'SQL'
DO $$ DECLARE d text := pg_get_functiondef('public.radar_agregado_recalcular(boolean,timestamptz)'::regprocedure);
BEGIN EXECUTE replace(d, '-- Um cálculo por vez', '-- (deriva de outra sessão) Um cálculo por vez'); END $$;
SQL
k_out="$(P -q -c "BEGIN" -f "$MIG_USADA" -c "COMMIT" 2>&1 || true)"
tem "K1a recálculo vivo divergente → PRE FALHOU" "$k_out" "PRE FALHOU: radar_agregado_recalcular vivo"
eq "K1b o abort não deixou nada (sem completo_em, sem o delta)" \
   "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name = 'radar_agregado_estado' AND column_name = 'completo_em'")|$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname = 'radar_agregado_delta_corte'")" \
   "0|0"
# restaura o recálculo de prod (só ele) para o apply real
python3 -I - "$MIG_VISITAR" > "$TMPD/rec.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.radar_agregado_recalcular(")
j = s.index("$function$", s.index("$function$", i) + 10) + len("$function$")
print(s[i:j] + ";")
PY
P -q -f "$TMPD/rec.sql"
eq "K1c recálculo de prod restaurado" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.radar_agregado_recalcular(boolean,timestamptz)'::regprocedure")" \
   "2f226c740ad151ecfd0a2e4d0472c80d"
k2="$(Pq <<SQL | tail -1
BEGIN;
UPDATE public.radar_empresas SET updated_at = '2026-11-10 09:00+00' WHERE cnpj = 'F0000000000001';
\i $MIG_USADA
SELECT COALESCE(completo_em::text, 'null') || '|' || COALESCE(impressao::text, 'null') FROM public.radar_agregado_estado;
ROLLBACK;
SQL
)"
eq "K2 escrita depois do último completo → semente NÃO grava (o 1º tick será completo)" "$k2" "null|null"

# ── A: apply (2×) ───────────────────────────────────────────────────────────────────────────────────────────
P -q -c "BEGIN" -f "$MIG_USADA" -c "COMMIT" > "$TMPD/apply1.log" 2>&1 || { cat "$TMPD/apply1.log"; echo "FAIL A1 apply abortou"; exit 1; }
echo "PASS A1 migration aplica (postcondição verde)"; PASS=$((PASS+1))
P -q -c "BEGIN" -f "$MIG_USADA" -c "COMMIT" > "$TMPD/apply2.log" 2>&1 || { cat "$TMPD/apply2.log"; echo "FAIL A2 re-apply abortou"; exit 1; }
echo "PASS A2 re-apply idempotente"; PASS=$((PASS+1))
eq "A3 o completo novo = o predecessor de prod no mesmo instante" "$(completo_em_rollback '2026-11-13 06:35+00')" "$PRED_COMPLETO"

eq "S1 semente: completo_em = calculado_em (10/11 06:35) e impressão = a de agora" \
   "$(Pq -c "SELECT completo_em = '2026-11-10 06:35+00' AND calculado_em = completo_em AND impressao = private.radar_agregado_impressao() FROM public.radar_agregado_estado")" "t"

# ── B: ticks diários incrementais, cada um IGUAL ao completo no mesmo instante ────────────────────────────────────
dia_incremental() { # $1 = id, $2 = instante
  local antes r depois
  antes="$(dump)"
  r="$(tick "$2")"
  eq "${1}m modo incremental [$2]" "$(modo "$r")" "true:incremental:-"
  positivo "${1}g grupos alterados > 0 [$2]" "$(cut -d'|' -f2 <<<"$r")"
  depois="$(dump)"
  dif "${1}d o agregado mudou [$2]" "$depois" "$antes"
  eq "${1}e EQUIVALÊNCIA com o completo [$2]" "$depois" "$(completo_em_rollback "$2")"
}
dia_incremental B1 '2026-11-11 06:35+00'
eq "B1h o tick das 07:35 não recalcula" "$(modo "$(tick '2026-11-11 07:35+00')")" "false:-:-"
dia_incremental B2 '2026-11-12 06:35+00'
dia_incremental B3 '2026-11-13 06:35+00'
dia_incremental B4 '2026-11-15 06:35+00'    # salto de 2 dias (ticks perdidos): a faixa cobre os dois
dia_incremental B5 '2026-11-16 06:35+00'

# ── R: rede de 6 d 12 h ───────────────────────────────────────────────────────────────────────────────────────
eq "R1 completo de 10/11 06:35, tick de 17/11 06:35 (7 d) → completo pela rede" "$(modo "$(tick '2026-11-17 06:35+00')")" "true:completo:rede"
dia_incremental R2 '2026-11-18 06:35+00'
eq "Bv1 quem tem \"para visitar\" está dos dois lados do corte (o fino tem visitar=true em est e não-est)" \
   "$(Pq -c "SELECT count(DISTINCT estabelecida) FROM public.radar_agregado_cnae WHERE visitar AND lote = '2026-10'")" "2"

# ── C: escrita → completo ─────────────────────────────────────────────────────────────────────────────────────
P -q -c "UPDATE public.radar_empresas SET prospeccao_status = 'em_conversa', updated_at = '2026-11-18 10:00+00' WHERE cnpj = 'C0000000000060'"
eq "C1a updated_at novo → completo (escrita)" "$(modo "$(tick '2026-11-19 06:35+00')")" "true:completo:escrita"
dia_incremental C1b '2026-11-20 06:35+00'
P -q -c "UPDATE public.radar_empresas SET ja_cliente = true WHERE cnpj = 'F0000000000003'"
eq "C2a já-cliente sem bump de updated_at → completo (escrita)" "$(modo "$(tick '2026-11-21 06:35+00')")" "true:completo:escrita"
P -q -c "INSERT INTO public.radar_contato_contabil_correcoes (cnpj, tipo, valor, campo, veredito) SELECT cnpj, 'telefone', private.radar_tel_valor(telefone1), 'telefone1', true FROM public.radar_empresas WHERE cnpj = 'C0000000000065'"
eq "C3a correção do vendedor → completo (escrita)" "$(modo "$(tick '2026-11-22 06:35+00')")" "true:completo:escrita"
dia_incremental C3b '2026-11-23 06:35+00'
P -q -c "INSERT INTO public.radar_exclusoes_titular (raiz, escopo) VALUES ('C0000000', 'contato')"
eq "C4a exclusão de escopo contato → completo" "$(modo "$(tick '2026-11-24 06:35+00')")" "true:completo:exclusao_contato"
eq "C4b … e no dia seguinte, com a impressão igual, continua completo" "$(modo "$(tick '2026-11-25 06:35+00')")" "true:completo:exclusao_contato"
P -q -c "UPDATE public.radar_exclusoes_titular SET escopo = 'qsa'"
eq "C4c exclusão só de QSA: a impressão mudou → completo (escrita)" "$(modo "$(tick '2026-11-26 06:35+00')")" "true:completo:escrita"
dia_incremental C4d '2026-11-27 06:35+00'
P -q -c "UPDATE public.radar_contato_contabil_estado SET calculado_em = '2026-11-27 06:50+00'"
eq "C5a contabilidade recalculada depois → o tick das 07:35 recalcula completo" "$(modo "$(tick '2026-11-27 07:35+00')")" "true:completo:contabilidade"
dia_incremental C5b '2026-11-28 06:35+00'
P -q -c "INSERT INTO public.radar_ingest_state VALUES ('2026-11', 'complete', '2026-11-28 16:00+00')"
eq "C6a lote novo → completo (lote)" "$(modo "$(tick '2026-11-28 16:35+00')")" "true:completo:lote"
P -q -c "UPDATE public.radar_agregado_estado SET corte_estabelecida = corte_estabelecida + 5"
eq "C7a corte gravado à frente do de hoje → completo (corte)" "$(modo "$(tick '2026-11-29 06:35+00')")" "true:completo:corte"
eq "C7b … e o agregado é o completo daquele instante" "$(dump)" "$(completo_em_rollback '2026-11-29 06:35+00')"

# ── D: delta incoerente e escrita durante o delta ─────────────────────────────────────────────────────────────
dia_incremental D0 '2026-11-30 06:35+00'
# apaga do fino o grupo de quem cruza amanhã → o saldo −1 não tem linha → CHECK (n > 0)
P -q <<'SQL'
DELETE FROM public.radar_agregado_cnae t
 USING private.radar_agregado_delta_corte((SELECT corte_estabelecida FROM public.radar_agregado_estado),
                                          DATE '2021-12-01', '2026-11-28 16:00+00',
                                          (SELECT cnaes_secundarios_cobertos FROM public.radar_agregado_estado)) d
 WHERE d.cnae_secundario IS NULL AND d.dn < 0
   AND t.lote = d.lote AND t.prospeccao_status = d.prospeccao_status AND t.cnae_principal = d.cnae_principal
   AND t.estabelecida = d.estabelecida AND t.estabelecida_d1 = d.estabelecida_d1 AND t.ja_cliente = d.ja_cliente
   AND t.tem_telefone = d.tem_telefone AND t.tem_contato = d.tem_contato AND t.inedito = d.inedito
   AND t.visitar IS NOT DISTINCT FROM d.visitar AND t.municipio_codigo IS NOT DISTINCT FROM d.municipio_codigo;
SQL
eq "D1a grupo apagado → o incremental volta atrás e recalcula completo (delta_inconsistente)" \
   "$(modo "$(tick '2026-12-01 06:35+00')")" "true:completo:delta_inconsistente"
eq "D1b … e o agregado é o completo" "$(dump)" "$(completo_em_rollback '2026-12-01 06:35+00')"
# escrita que commita DURANTE o delta: um gatilho de teste no fino insere uma correção no meio do MERGE
P -q <<'SQL'
CREATE FUNCTION public.t_escreve_no_meio() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.radar_contato_contabil_correcoes (cnpj, tipo, valor, campo, veredito)
  VALUES ('F0000000000002', 'email', 'x@y', 'email', false);
  RETURN NULL;
END $$;
CREATE TRIGGER t_meio AFTER INSERT OR UPDATE OR DELETE ON public.radar_agregado_cnae FOR EACH STATEMENT EXECUTE FUNCTION public.t_escreve_no_meio();
SQL
d2="$(tick '2026-12-02 06:35+00')"
P -q -c "DROP TRIGGER t_meio ON public.radar_agregado_cnae"
eq "D2a impressão mudou durante o delta → volta atrás → completo (escrita_durante_delta)" "$(modo "$d2")" "true:completo:escrita_durante_delta"
eq "D2b … e o agregado é o completo" "$(dump)" "$(completo_em_rollback '2026-12-02 06:35+00')"
eq "D2c a correção que o gatilho gravou DURANTE o completo aparece no dia seguinte (impressão lida antes)" \
   "$(modo "$(tick '2026-12-03 06:35+00')")" "true:completo:escrita"

# ── E: leituras de radar_empresas ─────────────────────────────────────────────────────────────────────────────
leituras() { # $1 = instante, $2 = forçar; "modo seq_scans" na MESMA transação (desfeita)
  Pq <<SQL | tail -1
BEGIN;
CREATE TEMP TABLE r AS SELECT public.radar_agregado_recalcular($2, '$1') AS j;
SELECT (SELECT j->>'modo' FROM r) || ' ' || (SELECT coalesce(sum(seq_scan), 0) FROM pg_stat_xact_user_tables WHERE relname = 'radar_empresas');
ROLLBACK;
SQL
}
eq "E1 o incremental faz 0 seq scans em radar_empresas" "$(leituras '2026-12-04 06:35+00' false)" "incremental 0"
eq "E2 o medidor tem dente: o completo lê radar_empresas" "$(leituras '2026-12-04 06:35+00' true | awk '{print $1, ($2 > 0)}')" "completo 1"

# ── G: ACL ────────────────────────────────────────────────────────────────────────────────────────────────────
eq "G1 anon/authenticated sem EXECUTE no recálculo, no delta e na impressão" \
   "$(Pq -c "SELECT bool_or(has_function_privilege(r, f, 'EXECUTE')) FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['public.radar_agregado_recalcular(boolean,timestamptz)', 'private.radar_agregado_delta_corte(date,date,timestamptz,text[])', 'private.radar_agregado_impressao()']) f")" \
   "f"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "RADAR_AGREGADO_INCREMENTAL_PROVA_OK"
