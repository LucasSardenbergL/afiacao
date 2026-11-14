#!/usr/bin/env bash
# Prova PG17 da 20261113213317_venda_sistema_completo (venda R2 · Entrega 4): fila de pares tinta/verniz →
# catalisador/diluente confirmados pelo founder, e o tipo 'sistema' em venda_sugestao.
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  T0  os predecessores recortados das migrations do repo são os vivos em prod (md5 medidos 13/11)
#  C1  venda_sistema_cita: fronteira dos dois lados (DF.4068 ≠ DFA.4068 ≠ DF.40681), sufixo colado, NULL → false
#  F1  fila: só master (42501); candidatos pela coocorrência com corte de ruído (share e juntos), ordem pelo volume da
#      base, teto por base×papel e por empresa; registra o mostrado (pendente) 1 vez; boletim confere/outro/nao_cita
#  D1  decidir: só master; status/par inválidos; trilha append-only; authenticated não escreve direto; decidido sai
#      dos candidatos e entra nos decididos
#  G1  gerador: só par CONFIRMADO (pendente nunca); dois braços entram com o braço do trigger; outra embalagem
#      confirmada já comprada suprime; base fora de base_dias não entra; fora da lista não entra; janela anti-repetição;
#      onda_sistema desligada não gera; idempotente
#  J1  ficha: ondas.sistema; o item 'sistema' com papel/base; o controle não aparece; par rejeitado SOME na hora
#  E1  e-mail: linha "Falta completar o sistema" + id no item; par rejeitado some
#  X1  fechamento: irmão confirmado (outra embalagem) vira pedido; controle nunca mostrado é medido (nao_virou, não
#      nao_exibida); par rejeitado fecha na hora como nao_medivel/par_revogado; aberto na janela fica aberto;
#      complemento não mostrado segue nao_exibida; janela sem 'sistema' → 22023
#  S1  sensor: confirmados ÷ mostrados, completos ÷ elegíveis, sugestões por braço; só master
#  M1  re-apply idempotente; PRE recusa corpo alheio; ACL (PUBLIC/anon fechados; helpers fechados)
#
#   bash db/test-venda-sistema.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-sistema.sh   # mesma prova no outro locale (marcas ASCII)
#   bash db/test-venda-sistema.sh --falsificar               # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261113213317_venda_sistema_completo.sql"
MIG_GERAR="$REPO_ROOT/supabase/migrations/20261107210000_cliente_sucessao_plano_rateio.sql"
MIG_FECHAR="$REPO_ROOT/supabase/migrations/20261021031000_venda_cliente_ondas23.sql"
MIG_E1="$REPO_ROOT/supabase/migrations/20261113110200_venda_resumo_email_controle.sql"
for f in "$MIG" "$MIG_GERAR" "$MIG_FECHAR" "$MIG_E1"; do [ -f "$f" ] || { echo "ausente: $f"; exit 1; }; done

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca exata.
  SABOTAGENS="cita_sem_fronteira:C1a fila_sem_share:F1b fila_sem_gate:F1a fila_sem_teto_bp:F1d decidir_sem_gate:D1a \
gerar_pendente:G1b gerar_sem_par_dias:G1d gerar_sem_base_dias:G1e gerar_sem_cooldown:G1g gerar_sem_onda:G1h \
json_revogado:J1d bloco_revogado:E1c fechar_itt:X1b fechar_revogado:X1c fechar_sem_irmao:X1a \
fechar_janela:X1f fila_anon:POST!P5_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-sistema.XXXXXX")"
  echo "== CONTROLE =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "controle VERMELHO - falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-sistema" "$LOGDIR/controle.log" || { echo "controle sem marcador de fim"; exit 1; }
  echo "OK controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "X $s: suite ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "X $s: sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      *!*) marca="${a#*!}"; marca="${marca//_/ }" ;;
      *)   marca="FAIL $a " ;;
    esac
    if grep -qF -- "$marca" "$LOGDIR/$s.log"; then
      echo "OK $s: vermelha em [$marca]"
    else
      echo "X $s: vermelha, mas NAO no assert esperado [$marca] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5673}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-sistema.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
PRED_SQL="$WORK/pred.sql"
# Saída SÓ é verde se a suíte chegou ao fim: sem o marcador TERMINOU, o trap sai 99 (um `set -u` aborta com rc 0).
TERMINOU=0
cleanup() {
  local rc=$?
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"
  if [ "$TERMINOU" != 1 ] && [ "$rc" -eq 0 ]; then echo "ABORTOU antes do fim (rc mascarado)"; rc=99; fi
  exit "$rc"
}
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
# Os predecessores: o CREATE de cada função recortado da migration que o pôs em prod (o T0 confere o md5).
python3 -I - "$PRED_SQL" "$MIG_GERAR" "$MIG_FECHAR" "$MIG_E1" <<'PY'
import re, sys
dst, mg, mf, me = sys.argv[1:]
def recorta(arq, cabeca):
    s = open(arq, encoding="utf-8").read()
    i = s.index(cabeca)
    m = re.search(r"\nAS (\$[A-Za-z_]*\$)", s[i:])
    tag = m.group(1)
    j = i + m.end()
    k = s.index(tag, j) + len(tag)
    return s[i:k] + ";\n"
out = [recorta(mg, "CREATE OR REPLACE FUNCTION public.venda_gerar_lista"),
       recorta(mf, "CREATE OR REPLACE FUNCTION public.venda_fechar_desfechos"),
       recorta(me, "CREATE OR REPLACE FUNCTION private._venda_sugestoes_json"),
       recorta(me, "CREATE OR REPLACE FUNCTION private.venda_resumo_bloco"),
       recorta(me, "CREATE OR REPLACE FUNCTION private.venda_brl"),
       recorta(me, "CREATE OR REPLACE FUNCTION private.venda_qtd"),
       recorta(me, "CREATE OR REPLACE FUNCTION private.venda_braco_u"),
       recorta(me, "CREATE OR REPLACE FUNCTION private.venda_braco_atribuir"),
       recorta(me, "CREATE OR REPLACE FUNCTION private.venda_sugestao_braco")]
open(dst, "w", encoding="utf-8").write("\n".join(out))
PY

sabotar() { # $1 = de, $2 = para (literal; TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  cita_sem_fronteira) sabotar "('(^|[^A-Z0-9])'" "('(^|)'" ;;
  fila_sem_share)     sabotar "       AND pp.juntos::numeric / bv.ped >= reg.min_share
" "" ;;
  fila_sem_gate)      sabotar "    RAISE EXCEPTION 'venda_sistema_fila: requer master' USING ERRCODE = '42501';" "    NULL;" ;;
  fila_sem_teto_bp)   sabotar "   WHERE c.rn_bp <= reg.por_bp" "   WHERE true" ;;
  decidir_sem_gate)   sabotar "    RAISE EXCEPTION 'venda_sistema_decidir: requer master' USING ERRCODE = '42501';" "    NULL;" ;;
  gerar_pendente)     sabotar "  conf AS (SELECT v.* FROM public.venda_sistema_par v WHERE v.status = 'confirmado'),
  compra AS (" "  conf AS (SELECT v.* FROM public.venda_sistema_par v WHERE v.status IN ('confirmado','pendente')),
  compra AS (" ;;
  gerar_sem_par_dias) sabotar "          AND c.data_pedido >= p_dia - reg.par_dias)" "          AND false)" ;;
  gerar_sem_base_dias) sabotar "     WHERE c.data_pedido >= p_dia - reg.base_dias" "     WHERE true" ;;
  gerar_sem_cooldown) sabotar "                          AND s.dia_referencia < p_dia AND s.dia_referencia > p_dia - jan.dias)" \
                              "                          AND false)" ;;
  gerar_sem_onda)     sabotar "    IF EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_sistema' AND valor = 'true'::jsonb) THEN" \
                              "    IF true THEN" ;;
  json_revogado)      sabotar "       AND (s.tipo <> 'sistema' OR sp.status = 'confirmado')" "" ;;
  bloco_revogado)     sabotar "            JOIN public.venda_sistema_par sp ON sp.id = s.sistema_par_id AND sp.status = 'confirmado'" \
                              "            JOIN public.venda_sistema_par sp ON sp.id = s.sistema_par_id" ;;
  fechar_itt)         sabotar "a.tipo NOT IN ('recompra','sistema') AND a.mostrada_em IS NULL" "a.tipo <> 'recompra' AND a.mostrada_em IS NULL" ;;
  fechar_revogado)    sabotar "    SELECT a.* FROM alvo0 a WHERE a.ate <= p_hoje OR a.revogado" "    SELECT a.* FROM alvo0 a WHERE a.ate <= p_hoje" ;;
  fechar_sem_irmao)   sabotar "        OR (a.tipo = 'sistema' AND oi.omie_codigo_produto = ANY (a.pares))" \
                              "        OR (a.tipo = 'sistema' AND oi.omie_codigo_produto = a.omie_codigo_produto)" ;;
  fechar_janela)      sabotar "    SELECT a.* FROM alvo0 a WHERE a.ate <= p_hoje OR a.revogado" "    SELECT a.* FROM alvo0 a WHERE true" ;;
  fila_anon)          sabotar "REVOKE ALL ON FUNCTION public.venda_sistema_fila(text) FROM PUBLIC, anon;" \
                              "GRANT EXECUTE ON FUNCTION public.venda_sistema_fila(text) TO anon;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
# Corpo sabotado das 4 recriadas = corpo NOVO: reassina o md5 "este" (PRE/PÓS), como faria quem mudasse função e
# arquivo juntos. Sem isso a P1 aborta o apply e o vermelho não chega ao assert de comportamento.
reassinar() {
  python3 -I - "$MIG_USADA" <<'PY2'
import hashlib, re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
for cab in ("CREATE OR REPLACE FUNCTION public.venda_gerar_lista(", "CREATE OR REPLACE FUNCTION public.venda_fechar_desfechos(",
            "CREATE OR REPLACE FUNCTION private._venda_sugestoes_json(", "CREATE OR REPLACE FUNCTION private.venda_resumo_bloco("):
    i = s.index(cab); j = s.index("AS $function$", i) + len("AS $function$"); k = s.index("$function$", j)
    novo = hashlib.md5(s[j:k].encode()).hexdigest()
    pos = s.index("-- ── PÓS")
    alvo = cab.split("FUNCTION ")[1].rstrip("(")
    # o md5 "este" do alvo no PRE e na PÓS: a 1ª string de 32 hex depois do nome do alvo em cada bloco
    for bloco_ini in (s.index("DO $pre$"), pos):
        a = s.index("'" + alvo + "(", bloco_ini)
        m = re.compile(r"'([0-9a-f]{32})'\)").search(s, a)
        s = s[:m.start(1)] + novo + s[m.end(1):]
open(p, "w", encoding="utf-8").write(s)
PY2
}
if [ -n "${SABOTAGEM:-}" ]; then reassinar; echo "SABOTAGEM ATIVA: $SABOTAGEM"; fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
estado() { # SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | sed -n 1p | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
como() { printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"; }
PASS=0; FAIL=0; FAIL_APPLY=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

F1=00000000-0000-0000-0000-0000000000f1; M=00000000-0000-0000-0000-0000000000ee
CF=00000000-0000-0000-0000-00000000c0f0   # comprador "de fundo" da coocorrência (sem braço)
CT=00000000-0000-0000-0000-00000000c001; CC=00000000-0000-0000-0000-00000000c002; CX=00000000-0000-0000-0000-00000000c003
CY=00000000-0000-0000-0000-00000000c004; CW=00000000-0000-0000-0000-00000000c005; CZ=00000000-0000-0000-0000-00000000c006
XT=00000000-0000-0000-0000-00000000c011; XC=00000000-0000-0000-0000-00000000c012; XR=00000000-0000-0000-0000-00000000c013
XO=00000000-0000-0000-0000-00000000c014; XK=00000000-0000-0000-0000-00000000c015

# ── Esquema mínimo com as colunas/constraints de prod (psql-ro, 13/11/2026) ─────────────────────────────────────
P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA private; GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;

CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$\$;
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), user_id uuid, name text, razao_social text, phone text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text, familia text);
CREATE TABLE public.customer_canonical_alias (alias_user_id uuid, canonical_user_id uuid, status text);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, customer_user_id uuid,
  status text, order_date_kpi date, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, omie_codigo_produto bigint,
  quantity numeric, unit_price numeric, desconto_valor numeric);
CREATE TABLE public.kb_product_specs (id uuid DEFAULT gen_random_uuid(), product_code text, product_name text,
  catalisador_codigo text, catalisador_proporcao_pct numeric, diluente_codigo text, approved_at timestamptz);
CREATE TABLE public.cliente_sucessoes (id uuid DEFAULT gen_random_uuid(), evento_id uuid, antigo_documento text,
  declarado_em timestamptz DEFAULT now());
CREATE FUNCTION private.cliente_resolver_documento(p text) RETURNS TABLE (nome text) LANGUAGE sql STABLE
  AS \$\$ SELECT NULL::text WHERE false \$\$;
CREATE TABLE public.venda_recompra (comprador_id uuid, empresa text, omie_codigo_produto bigint, cadencia_dias numeric,
  ultima_compra date, ultimo_preco numeric);
CREATE TABLE public.venda_config (chave text PRIMARY KEY, valor jsonb NOT NULL, atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.venda_gerador_execucao (dia_referencia date NOT NULL, fase text NOT NULL,
  primeira_em timestamptz NOT NULL DEFAULT now(), ultima_em timestamptz NOT NULL DEFAULT now(), linhas int NOT NULL DEFAULT 0,
  PRIMARY KEY (dia_referencia, fase));
CREATE TABLE public.venda_sugestao (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL, fase text NOT NULL CHECK (fase IN ('historico','sombra','ativa')),
  dia_referencia date NOT NULL, gerada_em timestamptz NOT NULL DEFAULT now(),
  farmer_user_id uuid NOT NULL, comprador_id uuid NOT NULL, empresa text NOT NULL,
  omie_codigo_produto bigint, familia text, qtd_ref numeric, valor_ref numeric, preco_alvo numeric,
  motivo_entrada text NOT NULL, mostrada_em timestamptz,
  desfecho text CHECK (desfecho IN ('virou_pedido','nao_virou','nao_medivel')), desfecho_motivo text,
  sales_order_id uuid, valor_realizado numeric, avaliado_em timestamptz, preco_anterior numeric,
  sucessao_origem jsonb, valor_ref_referencia_origem boolean NOT NULL DEFAULT false, braco text,
  CONSTRAINT venda_sugestao_tipo_check CHECK (tipo IN ('recompra','complemento','preco')),
  CONSTRAINT venda_sugestao_alvo_ck CHECK ((tipo IN ('recompra','preco') AND omie_codigo_produto IS NOT NULL)
                                           OR (tipo = 'complemento' AND familia IS NOT NULL)),
  CONSTRAINT venda_sugestao_avaliado_ck CHECK ((desfecho IS NULL) = (avaliado_em IS NULL)),
  CONSTRAINT venda_sugestao_virou_ck CHECK (desfecho IS DISTINCT FROM 'virou_pedido' OR sales_order_id IS NOT NULL),
  CONSTRAINT venda_sugestao_medivel_ck CHECK (desfecho IS DISTINCT FROM 'nao_medivel' OR desfecho_motivo IS NOT NULL),
  CONSTRAINT venda_sugestao_braco_ck CHECK (braco IS NULL OR (fase = 'ativa' AND braco IN ('controle','tratamento'))));
CREATE UNIQUE INDEX venda_sugestao_chave_uq ON public.venda_sugestao
  (dia_referencia, farmer_user_id, comprador_id, tipo, empresa, COALESCE(omie_codigo_produto, 0), COALESCE(familia, ''), fase);
ALTER TABLE public.venda_sugestao ENABLE ROW LEVEL SECURITY;
CREATE POLICY venda_sugestao_select ON public.venda_sugestao FOR SELECT TO authenticated
  USING ((farmer_user_id = auth.uid() AND fase = 'ativa' AND braco IS DISTINCT FROM 'controle') OR public.has_role(auth.uid(), 'master'));
REVOKE ALL ON public.venda_sugestao FROM anon, authenticated; GRANT SELECT ON public.venda_sugestao TO authenticated;
CREATE TABLE public.venda_braco_sorteio (id smallint PRIMARY KEY DEFAULT 1, algoritmo text, semente text, fracao_controle numeric,
  inicio date NOT NULL, realizado_em timestamptz DEFAULT now(), n_inicial int, n_inicial_controle int);
CREATE TABLE public.venda_braco_comprador (comprador_id uuid PRIMARY KEY, braco text NOT NULL, u numeric, origem text,
  atribuido_em timestamptz DEFAULT now());
-- Dependências do gerador/fechamento fora do escopo desta prova: stubs controlados pela prova.
CREATE TABLE public.t_lista (farmer_user_id uuid, comprador_id uuid, empresa text, omie_codigo_produto bigint);
CREATE FUNCTION private.venda_lista_calc_efetiva(p_dia date) RETURNS TABLE (farmer_user_id uuid, comprador_id uuid, empresa text,
  omie_codigo_produto bigint, qtd_ref numeric, valor_ref numeric, motivo_entrada text, sucessao_origem jsonb,
  valor_ref_referencia_origem boolean) LANGUAGE sql STABLE
  AS \$\$ SELECT t.farmer_user_id, t.comprador_id, t.empresa, t.omie_codigo_produto, 1::numeric, 10::numeric,
              'maior atraso da carteira', NULL::jsonb, false FROM public.t_lista t \$\$;
CREATE FUNCTION private.venda_lista_complemento(p_dia date) RETURNS TABLE (farmer_user_id uuid, comprador_id uuid, empresa text,
  familia text) LANGUAGE sql STABLE AS \$\$ SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text WHERE false \$\$;
CREATE FUNCTION private.venda_lista_preco(p_dia date) RETURNS TABLE (farmer_user_id uuid, comprador_id uuid,
  omie_codigo_produto bigint, preco_alvo numeric, preco_anterior numeric) LANGUAGE sql STABLE
  AS \$\$ SELECT NULL::uuid, NULL::uuid, NULL::bigint, NULL::numeric, NULL::numeric WHERE false \$\$;
CREATE FUNCTION private.venda_sugestoes_drenar_reprocesso() RETURNS integer LANGUAGE sql AS \$\$ SELECT 0 \$\$;
CREATE FUNCTION private.venda_sync_dia_coberto(p_empresa text, p_dia date) RETURNS boolean LANGUAGE sql STABLE
  AS \$\$ SELECT p_dia < (now() AT TIME ZONE 'America/Sao_Paulo')::date \$\$;
CREATE FUNCTION private.venda_mes_completo_por_dados(p_empresa text, p_mes date) RETURNS boolean LANGUAGE sql STABLE
  AS \$\$ SELECT true \$\$;

INSERT INTO public.venda_config VALUES
  ('onda_recompra','true'), ('onda_complemento','true'), ('onda_preco','false'),
  ('teto_maiores_atrasos','10'), ('janela_dias','{"recompra":14,"complemento":30,"preco":30}');
INSERT INTO public.user_roles VALUES ('$M','master'), ('$F1','employee');
INSERT INTO public.profiles (user_id, name, phone) VALUES ('$CT','MARCENARIA TRATADA','(11) 4000-0001');
-- Catálogo (oben). 101 = base com boletim; 102 = seladora nitro; 2xx catalisador; 3xx diluente.
INSERT INTO public.omie_products VALUES
  (101,'oben','FUNDO PU FL.6673.00LT','Fundos PU'), (102,'oben','SELADORA NLO.9525.00LT','Seladora Nitrocelulose'),
  (201,'oben','CATALISADOR FC.6975LT','Catalisadores PU'), (202,'oben','CATALISADOR FC.6975QT','Catalisadores PU'),
  (203,'oben','CATALISADOR FC.6902LT','Catalisadores PU'), (204,'oben','CATALISADOR FC.6921QT','Catalisadores PU'),
  (301,'oben','DILUENTE PU DFA.4128LT','Diluente PU'), (302,'oben','THINNER NITRO DN.4260LT','Thinner Nitrocelulose'),
  (999,'oben','DISCO DE LIXA 120','Disco de Lixa');
INSERT INTO public.kb_product_specs (product_code, product_name, catalisador_codigo, catalisador_proporcao_pct, diluente_codigo, approved_at)
VALUES ('FL.6673.00','FUNDO PU 6673','FC.6975',50,'DFA.4128', now()),
       ('NLO.9525.00','SELADORA 9525',NULL,NULL,'DN.4260', now()),
       ('XX.0000.00','NAO APROVADO','FC.6902',50,NULL, NULL);
INSERT INTO public.venda_braco_sorteio (id, algoritmo, semente, fracao_controle, inicio, n_inicial, n_inicial_controle)
VALUES (1, 'md5-32-v1', 'semente-prova', 0.15, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 60, 0, 0);
INSERT INTO public.venda_braco_comprador (comprador_id, braco, u, origem) VALUES
  ('$CT','tratamento',0.9,'t'), ('$CC','controle',0.01,'t'), ('$CX','tratamento',0.9,'t'), ('$CY','tratamento',0.9,'t'),
  ('$CW','tratamento',0.9,'t'), ('$CZ','tratamento',0.9,'t'), ('$XT','tratamento',0.9,'t'), ('$XC','controle',0.01,'t'),
  ('$XR','tratamento',0.9,'t'), ('$XO','tratamento',0.9,'t'), ('$XK','tratamento',0.9,'t');
SQL

# Pedidos: (comprador, dias atrás, lista de "sku:qtd:preço")
pedido() { # $1 comprador  $2 dias atras  $3.. itens sku:preco
  local c="$1" d="$2"; shift 2
  local sql="WITH so AS (INSERT INTO public.sales_orders (account, customer_user_id, status, order_date_kpi)
    VALUES ('oben', '$c', 'faturado', (now() AT TIME ZONE 'America/Sao_Paulo')::date - $d) RETURNING id)
    INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor) "
  local sel="" it sku preco
  for it in "$@"; do
    sku="${it%%:*}"; preco="${it#*:}"
    sel="${sel:+$sel UNION ALL }SELECT so.id, $sku, 1, $preco, 0 FROM so"
  done
  echo "$sql $sel;"
}
{
  for i in $(seq 1 10); do
    if [ "$i" -le 5 ]; then pedido "$CF" $((100+i)) 101:100 201:50 301:30; else pedido "$CF" $((100+i)) 101:100 201:50; fi
  done
  for i in $(seq 1 4); do pedido "$CF" $((120+i)) 101:100 203:50; done
  for i in $(seq 1 6); do pedido "$CF" $((130+i)) 101:100; done
  for i in $(seq 1 100); do
    if [ "$i" -le 3 ]; then pedido "$CF" $((150+i)) 102:10 204:20
    elif [ "$i" -le 13 ]; then pedido "$CF" $((150+i)) 102:10 302:20
    else pedido "$CF" $((150+i)) 102:10; fi
  done
  pedido "$CF" 400 101:100 201:50          # fora dos 12m: não conta
  pedido "$CT" 10 101:100                  # CT comprou a base há 10 dias, sem catalisador
  pedido "$CC" 10 101:100                  # CC idem (controle)
  pedido "$CX" 20 101:100 202:50           # CX levou a OUTRA embalagem do catalisador
  pedido "$CY" 40 101:100                  # CY comprou a base fora de base_dias (30)
  pedido "$CW" 5 101:100                   # CW: já tem sugestão do mesmo par há 5 dias (anti-repetição)
  pedido "$CZ" 3 101:100                   # CZ não está na lista de hoje
} > "$WORK/pedidos.sql"
P -q -f "$WORK/pedidos.sql" > /dev/null

# ── T0: predecessores = prod ────────────────────────────────────────────────────────────────────────────────────
P -q -f "$PRED_SQL" > /dev/null
P -q -c "CREATE TRIGGER venda_sugestao_braco_trg BEFORE INSERT OR UPDATE ON public.venda_sugestao
         FOR EACH ROW EXECUTE FUNCTION private.venda_sugestao_braco()"
md5f() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')"; }
eq "T0a venda_gerar_lista = prod" "$(md5f 'public.venda_gerar_lista(date,text)')" "3b93a5e827ebc78af6dd325c5b5b0c7f"
eq "T0b venda_fechar_desfechos = prod" "$(md5f 'public.venda_fechar_desfechos(date)')" "6c962e84f9b821d5612b555e10489616"
eq "T0c _venda_sugestoes_json = prod" "$(md5f 'private._venda_sugestoes_json(uuid,date)')" "ccc8189a3d2962e073a3d360581efb61"
eq "T0d venda_resumo_bloco = prod" "$(md5f 'private.venda_resumo_bloco(uuid,date,uuid,integer,text,numeric,text)')" "143dc394cd9a2a079c50127da243f1ae"
eq "T0e venda_sugestao_braco = prod" "$(md5f 'private.venda_sugestao_braco()')" "1dfc316560941c454d5202dfc77170ae"

# Uma sugestão de complemento ANTES da migration (regressão do fechamento): não mostrada, janela vencida.
P -q -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, familia, motivo_entrada)
         VALUES ('complemento','ativa',(now() AT TIME ZONE 'America/Sao_Paulo')::date - 31,'$F1','$XK','oben','Fundos PU','x')"

# ── a migration ─────────────────────────────────────────────────────────────────────────────────────────────────
if ! P -q -f "$MIG_USADA" > "$WORK/apply.log" 2>&1; then
  echo "FAIL apply"; FAIL_APPLY=1; grep -E 'ERRO|ERROR|FALHOU' "$WORK/apply.log" | sed -n 1,5p
fi
HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"

# ── C1: venda_sistema_cita ──────────────────────────────────────────────────────────────────────────────────────
cita() { Pq -c "SELECT private.venda_sistema_cita($1, $2)"; }
eq "C1a FA.4068 nao cita DFA.4068 (fronteira a esquerda)" "$(cita "'DILUENTE PU DFA.4068LT'" "'FA.4068'")" "f"
eq "C1b sufixo colado cita" "$(cita "'DILUENTE PU DF.4068LT'" "'DF.4068'")" "t"
eq "C1c digito a mais nao cita" "$(cita "'CATALISADOR FC.69751'" "'FC.6975'")" "f"
eq "C1d NULL e codigo curto = false" "$(cita "NULL" "'FC.6975'") $(cita "'FC.6975'" "'FC'")" "f f"
eq "C1e caixa baixa no texto cita" "$(cita "'catalisador fc.5202.ral5'" "'FC.5202.RA'")" "t"

# ── F1: a fila ──────────────────────────────────────────────────────────────────────────────────────────────────
eq "F1a fila: employee recebe 42501" "$(estado "$(como "$F1" "SELECT public.venda_sistema_fila('oben')")")" "42501"
FILA="$(Pq -c "$(como "$M" "SELECT public.venda_sistema_fila('oben')::text")")"
pj() { printf '%s' "$FILA" | python3 -I -c "import json,sys; j=json.load(sys.stdin); print($1)"; }
eq "F1b candidatos na ordem (volume da base; ruido de share cortado)" \
  "$(pj "[(c['base']['omie_codigo_produto'], c['par']['omie_codigo_produto'], c['papel'], c['juntos']) for c in j['candidatos']]")" \
  "[(101, 201, 'catalisador', 10), (101, 203, 'catalisador', 4), (101, 301, 'diluente', 5), (102, 302, 'diluente', 10)]"
eq "F1c registrou os mostrados como pendente" "$(Pq -c "SELECT count(*), bool_and(status = 'pendente') FROM public.venda_sistema_par")" "4|t"
eq "F1e boletim: confere / outro" \
  "$(pj "[(c['boletim'] or {}).get('situacao') for c in j['candidatos']]")" "['confere', 'outro', 'confere', 'confere']"
eq "F1f boletim do catalisador traz a proporcao" "$(pj "j['candidatos'][0]['boletim']['proporcao_pct']")" "50"
FILA2="$(Pq -c "$(como "$M" "SELECT public.venda_sistema_fila('oben')::text")")"
eq "F1g idempotente (nao duplica nem muda mostrado_em)" \
  "$(Pq -c "SELECT count(*), count(DISTINCT mostrado_em) FROM public.venda_sistema_par") $( [ "$FILA" = "$FILA2" ] && echo igual)" "4|1 igual"
P -q -c "UPDATE public.venda_config SET valor = jsonb_set(valor, '{fila_por_base_papel}', '1') WHERE chave = 'sistema_regras'"
FILA="$(Pq -c "$(como "$M" "SELECT public.venda_sistema_fila('oben')::text")")"
eq "F1d teto por base x papel" "$(pj "[c['par']['omie_codigo_produto'] for c in j['candidatos']]")" "[201, 301, 302]"
P -q -c "UPDATE public.venda_config SET valor = jsonb_set(jsonb_set(valor, '{fila_por_base_papel}', '2'), '{fila_por_empresa}', '2') WHERE chave = 'sistema_regras'"
FILA="$(Pq -c "$(como "$M" "SELECT public.venda_sistema_fila('oben')::text")")"
eq "F1h teto por empresa" "$(pj "len(j['candidatos'])")" "2"
P -q -c "UPDATE public.venda_config SET valor = jsonb_set(valor, '{fila_por_empresa}', '30') WHERE chave = 'sistema_regras'"
eq "F1i empresa invalida = 22023" "$(estado "$(como "$M" "SELECT public.venda_sistema_fila('xyz')")")" "22023"
eq "F1j colacor sem pedido: fila vazia" "$(Pq -c "$(como "$M" "SELECT jsonb_array_length(public.venda_sistema_fila('colacor') -> 'candidatos')")")" "0"

pid() { Pq -c "SELECT id FROM public.venda_sistema_par WHERE base_codigo = $1 AND par_codigo = $2"; }
P_CAT1="$(pid 101 201)"; P_CAT2="$(pid 101 203)"; P_DIL="$(pid 101 301)"; P_THIN="$(pid 102 302)"

# ── D1: decidir ─────────────────────────────────────────────────────────────────────────────────────────────────
dec() { Pq -c "$(como "$M" "SELECT public.venda_sistema_decidir($1, '$2')::text")"; }
eq "D1a decidir: employee recebe 42501" "$(estado "$(como "$F1" "SELECT public.venda_sistema_decidir($P_CAT1, 'confirmado')")")" "42501"
eq "D1b status invalido = 22023" "$(estado "$(como "$M" "SELECT public.venda_sistema_decidir($P_CAT1, 'talvez')")")" "22023"
eq "D1c par inexistente = P0002" "$(estado "$(como "$M" "SELECT public.venda_sistema_decidir(999999, 'confirmado')")")" "P0002"
eq "D1d authenticated nao escreve direto" "$(estado "$(como "$M" "UPDATE public.venda_sistema_par SET status = 'confirmado'")")" "42501"
dec "$P_CAT1" confirmado > /dev/null
dec "$P_CAT2" nao_sei > /dev/null
dec "$P_THIN" confirmado > /dev/null
# A outra embalagem (202) confirmada numa leitura anterior: nunca foi candidata (1 pedido junto), entra pela porta.
P -q -c "INSERT INTO public.venda_sistema_par (empresa, base_codigo, par_codigo, papel, status, evidencia, decidido_por, decidido_em)
         VALUES ('oben', 101, 202, 'catalisador', 'confirmado', '{\"juntos\":1}', '$M', now())"
P_QT="$(pid 101 202)"
eq "D1e trilha gravada com quem decidiu" "$(Pq -c "SELECT count(*), bool_and(decidido_por = '$M') FROM public.venda_sistema_par_decisao")" "3|t"
eq "D1f trilha append-only" "$(estado "DELETE FROM public.venda_sistema_par_decisao")" "55000"
FILA="$(Pq -c "$(como "$M" "SELECT public.venda_sistema_fila('oben')::text")")"
eq "D1g decidido sai dos candidatos; nao_sei vai pro fim" \
  "$(pj "[(c['par']['omie_codigo_produto'], c['status']) for c in j['candidatos']]") $(pj "sorted(d['par']['omie_codigo_produto'] for d in j['decididos'])")" \
  "[(301, 'pendente'), (203, 'nao_sei')] [201, 202, 302]"

# ── G1: gerador ─────────────────────────────────────────────────────────────────────────────────────────────────
P -q -c "INSERT INTO public.t_lista VALUES ('$F1','$CT','oben',999), ('$F1','$CC','oben',999), ('$F1','$CX','oben',999),
                                           ('$F1','$CY','oben',999), ('$F1','$CW','oben',999)"
# CW: sugestão do MESMO par há 5 dias, ainda em medição.
P -q -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, sistema_par_id, motivo_entrada)
         VALUES ('sistema','ativa','$HOJE'::date - 5,'$F1','$CW','oben',201,$P_CAT1,'x')"
P -q -c "UPDATE public.venda_config SET valor = 'false' WHERE chave = 'onda_sistema'"
Pq -c "SELECT public.venda_gerar_lista('$HOJE', 'ativa')" > /dev/null
eq "G1h onda_sistema desligada nao gera" "$(Pq -c "SELECT count(*) FROM public.venda_sugestao WHERE tipo = 'sistema' AND dia_referencia = '$HOJE'")" "0"
P -q -c "UPDATE public.venda_config SET valor = 'true' WHERE chave = 'onda_sistema'"
Pq -c "SELECT public.venda_gerar_lista('$HOJE', 'ativa')" > /dev/null
sis() { Pq -c "SELECT string_agg(comprador_id::text || ':' || omie_codigo_produto || ':' || COALESCE(braco,'-') || ':' || sistema_par_id, ',' ORDER BY comprador_id::text, omie_codigo_produto)
               FROM public.venda_sugestao WHERE tipo = 'sistema' AND dia_referencia = '$HOJE'"; }
G1="$(sis)"
eq "G1a CT e CC recebem o catalisador confirmado de maior evidencia, com o braco" "$G1" "$CT:201:tratamento:$P_CAT1,$CC:201:controle:$P_CAT1"
eq "G1b par pendente (diluente) nunca gera" "$(printf '%s' "$G1" | grep -c ':301:' || true)" "0"
eq "G1d outra embalagem confirmada ja comprada suprime (CX)" "$(printf '%s' "$G1" | grep -c "$CX" || true)" "0"
eq "G1e base fora de base_dias nao entra (CY)" "$(printf '%s' "$G1" | grep -c "$CY" || true)" "0"
eq "G1f fora da lista de hoje nao entra (CZ)" "$(printf '%s' "$G1" | grep -c "$CZ" || true)" "0"
eq "G1g anti-repeticao na janela (CW)" "$(printf '%s' "$G1" | grep -c "$CW" || true)" "0"
eq "G1i motivo legivel" "$(Pq -c "SELECT motivo_entrada FROM public.venda_sugestao WHERE tipo = 'sistema' AND comprador_id = '$CT'")" \
  "comprou FUNDO PU FL.6673.00LT sem o catalisador"
Pq -c "SELECT public.venda_gerar_lista('$HOJE', 'ativa')" > /dev/null
eq "G1j idempotente" "$(sis)" "$G1"
SID_CT="$(Pq -c "SELECT id FROM public.venda_sugestao WHERE tipo = 'sistema' AND comprador_id = '$CT' AND dia_referencia = '$HOJE'")"

# ── J1: ficha (Meu Dia) ─────────────────────────────────────────────────────────────────────────────────────────
JS="$(Pq -c "SELECT private._venda_sugestoes_json('$F1', '$HOJE')::text")"
pjs() { printf '%s' "$JS" | python3 -I -c "import json,sys; j=json.load(sys.stdin); print($1)"; }
eq "J1a ondas.sistema ligada" "$(pjs "j['ondas']['sistema']")" "True"
eq "J1b item sistema de CT com papel e base" \
  "$(pjs "[(s['sistema']['papel'], s['sistema']['base_descricao'], s['descricao']) for c in j['compradores'] if c['comprador_id']=='$CT' for s in c['sugestoes'] if s['tipo']=='sistema']")" \
  "[('catalisador', 'FUNDO PU FL.6673.00LT', 'CATALISADOR FC.6975LT')]"
eq "J1c controle nao aparece (CC)" "$(pjs "len([c for c in j['compradores'] if c['comprador_id']=='$CC'])")" "0"
eq "J1e recompra sem bloco sistema (null)" "$(pjs "set(s['sistema'] for c in j['compradores'] for s in c['sugestoes'] if s['tipo']=='recompra')")" "{None}"

# ── E1: e-mail ──────────────────────────────────────────────────────────────────────────────────────────────────
BL="$(Pq -c "SELECT texto FROM private.venda_resumo_bloco('$F1', '$HOJE', '$CT', 1, 'maior atraso da carteira', 10, 'https://x/l')")"
eq "E1a linha do sistema no e-mail" "$(printf '%s' "$BL" | grep -c 'Falta completar o sistema: CATALISADOR FC.6975LT (catalisador do FUNDO PU FL.6673.00LT)' || true)" "1"
eq "E1b id da sugestao no item do e-mail" "$(Pq -c "SELECT '$SID_CT' = ANY (sugestao_ids) FROM private.venda_resumo_bloco('$F1', '$HOJE', '$CT', 1, 'm', 10, 'l')")" "t"

# Rejeição DEPOIS da confirmação: desliga na hora (ficha e e-mail).
dec "$P_CAT1" rejeitado > /dev/null
JS="$(Pq -c "SELECT private._venda_sugestoes_json('$F1', '$HOJE')::text")"
eq "J1d par rejeitado some da ficha" "$(pjs "len([s for c in j['compradores'] for s in c['sugestoes'] if s['tipo']=='sistema'])")" "0"
BL="$(Pq -c "SELECT texto FROM private.venda_resumo_bloco('$F1', '$HOJE', '$CT', 1, 'maior atraso da carteira', 10, 'https://x/l')")"
eq "E1c par rejeitado some do e-mail" "$(printf '%s' "$BL" | grep -c 'Falta completar o sistema' || true)" "0"
eq "G1k rejeitado nao gera mais (amanha seria 0): lista_sistema vazia para CT" \
  "$(Pq -c "SELECT count(*) FROM private.venda_lista_sistema('$HOJE') WHERE comprador_id = '$CT' AND sistema_par_id = $P_CAT1")" "0"
dec "$P_CAT1" confirmado > /dev/null

# ── X1: fechamento ──────────────────────────────────────────────────────────────────────────────────────────────
D31="$(Pq -c "SELECT '$HOJE'::date - 31")"
P -q -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, sistema_par_id, motivo_entrada, mostrada_em) VALUES
  ('sistema','ativa','$D31','$F1','$XT','oben',201,$P_CAT1,'x', now()),
  ('sistema','ativa','$D31','$F1','$XC','oben',201,$P_CAT1,'x', NULL),
  ('sistema','ativa','$HOJE'::date - 5,'$F1','$XR','oben',302,$P_THIN,'x', now()),
  ('sistema','ativa','$HOJE'::date - 5,'$F1','$XO','oben',201,$P_CAT1,'x', now())"
P -q -f <(pedido "$XT" 28 202:80) > /dev/null       # XT levou a OUTRA embalagem confirmada dentro da janela
P -q -f <(pedido "$XO" 2 201:50) > /dev/null        # XO comprou, mas a janela dele ainda não fechou
dec "$P_THIN" rejeitado > /dev/null                  # o par de XR foi rejeitado com a sugestão aberta
eq "X1g janela sem 'sistema' = 22023" "$(estado "UPDATE public.venda_config SET valor = valor - 'sistema' WHERE chave = 'janela_dias'; SELECT public.venda_fechar_desfechos('$HOJE')")" "22023"
Pq -c "SELECT public.venda_fechar_desfechos('$HOJE')" > /dev/null
des() { Pq -c "SELECT COALESCE(desfecho,'aberta') || ':' || COALESCE(desfecho_motivo,'-') || ':' || COALESCE(valor_realizado::text,'-')
               FROM public.venda_sugestao WHERE comprador_id = '$1' AND tipo = '$2' ORDER BY dia_referencia LIMIT 1"; }
eq "X1a irmao confirmado (outra embalagem) vira pedido" "$(des "$XT" sistema)" "virou_pedido:-:80"
eq "X1b controle nunca mostrado e medido (nao_virou)" "$(des "$XC" sistema)" "nao_virou:-:-"
eq "X1c par rejeitado fecha na hora (par_revogado)" "$(des "$XR" sistema)" "nao_medivel:par_revogado:-"
eq "X1f aberta dentro da janela fica aberta" "$(des "$XO" sistema)" "aberta:-:-"
eq "X1d complemento nao mostrado segue nao_exibida" "$(des "$XK" complemento)" "nao_medivel:nao_exibida:-"

# ── S1: sensor ──────────────────────────────────────────────────────────────────────────────────────────────────
eq "S1a sensor: employee recebe 42501" "$(estado "$(como "$F1" "SELECT public.venda_sistema_sensor('$HOJE'::date - 30, '$HOJE')")")" "42501"
SEN="$(Pq -c "$(como "$M" "SELECT public.venda_sistema_sensor('$HOJE'::date - 365, '$HOJE')::text")")"
psn() { printf '%s' "$SEN" | python3 -I -c "import json,sys; j=json.load(sys.stdin); print($1)"; }
# fila: 4 mostrados + a embalagem 202 = 5; confirmados 201 e 202 (302 foi rejeitado) = 2 → 0.4
eq "S1b confirmados / mostrados" "$(psn "[(f['empresa'], f['mostrados'], f['confirmados'], f['rejeitados'], f['nao_sei'], f['pendentes'], f['taxa_confirmacao']) for f in j['fila']]")" \
  "[('oben', 5, 2, 1, 1, 1, 0.4)]"
# pedidos 12m com a base 101 (sistema catalisador confirmado): 10+4+6 do fundo + CT CC CX CY CW CZ = 26; completos
# (201 ou 202 no MESMO pedido): os 10 do fundo + CX = 11. O pedido de XT (só 202, sem base) não é elegível.
eq "S1c completos / elegiveis (total)" "$(psn "(sum(p['elegiveis'] for p in j['pedidos']), sum(p['completos'] for p in j['pedidos']))")" "(26, 11)"
eq "S1d elegiveis por braco" "$(psn "sorted((p['braco'], p['elegiveis'], p['completos']) for p in j['pedidos'])")" \
  "[('controle', 1, 0), ('sem_braco', 20, 10), ('tratamento', 5, 1)]"
eq "S1e sugestoes por braco (ITT)" "$(psn "sorted((s['braco'], s['geradas'], s['viraram'], s['nao_virou'], s['nao_medivel'], s['abertas']) for s in j['sugestoes'])")" \
  "[('controle', 2, 0, 1, 0, 1), ('tratamento', 5, 1, 0, 1, 3)]"
eq "S1f periodo invalido = 22023" "$(estado "$(como "$M" "SELECT public.venda_sistema_sensor('$HOJE', '$HOJE'::date - 1)")")" "22023"

# ── M1: re-apply, PRE, ACL ──────────────────────────────────────────────────────────────────────────────────────
if P -q -f "$MIG_USADA" > "$WORK/reapply.log" 2>&1; then eq "M1a re-apply idempotente" "ok" "ok"; else
  eq "M1a re-apply idempotente" "$(grep -E 'ERRO|ERROR' "$WORK/reapply.log" | sed -n 1p)" "ok"; fi
eq "M1b re-apply nao mexe nos pares nem na janela" "$(Pq -c "SELECT count(*) FROM public.venda_sistema_par") $(Pq -c "SELECT valor ->> 'sistema' FROM public.venda_config WHERE chave = 'janela_dias'")" "5 30"
P -q -c "CREATE OR REPLACE FUNCTION private.venda_resumo_bloco(p_farmer uuid, p_dia date, p_comprador uuid, p_posicao integer, p_motivo text, p_valor numeric, p_link text)
  RETURNS TABLE(texto text, sugestao_ids uuid[]) LANGUAGE sql STABLE AS \$\$ SELECT 'x'::text, '{}'::uuid[] \$\$"
SAIDA_M1C="$(P -q -f "$MIG_USADA" 2>&1 || true)"
eq "M1c PRE recusa corpo alheio" "$(printf '%s' "$SAIDA_M1C" | grep -c 'PRE FALHOU: private.venda_resumo_bloco')" "1"
eq "M1d anon nao executa a fila" "$(estado "SET ROLE anon; SELECT public.venda_sistema_fila('oben')")" "42501"
eq "M1e authenticated nao executa helper privado" "$(estado "$(como "$M" "SELECT * FROM private.venda_lista_sistema('$HOJE')")")" "42501"
eq "M1f employee nao le os pares (RLS)" "$(Pq -c "$(como "$F1" "SELECT count(*) FROM public.venda_sistema_par")")" "0"

FAIL=$((FAIL + FAIL_APPLY))
TERMINOU=1
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-sistema"
