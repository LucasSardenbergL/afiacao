#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261014120000_fin_ciclo_cliente_views                       ║
# ║  v_ciclo_cr_titulos / v_ciclo_cliente_resumo / v_ciclo_empresa_coorte      ║
# ║      bash db/test-fin-ciclo-cliente.sh > logs/t.log 2>&1; echo "exit=$?"    ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-cliente.sh  (2º ambiente)        ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocação + 1 sabotagem por invariante de dinheiro, sobre CÓPIA da
# migration (o repo nunca é tocado). Asserções em ASCII, caixa fixa.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5473}"
SLUG="fin-ciclo-cliente"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
CREATE TABLE public.fin_contas_receber (
  company text, omie_codigo_cliente bigint, nome_cliente text, omie_codigo_lancamento bigint,
  numero_documento text, data_emissao date, data_vencimento date, valor_documento numeric,
  saldo numeric, status_titulo text);
-- v_titulo_baixas é VIEW em prod; aqui basta uma tabela com as mesmas colunas/tipos.
CREATE TABLE public.v_titulo_baixas (
  company text, omie_codigo_lancamento bigint, tipo text, data_baixa_final date,
  valor_baixado numeric, n_movimentos integer, prazo_ponderado_dias numeric, origem_baixa text);
SQL
  # Fixtures relativas a hoje_sp (mesma expressão da view).
  P <<'SQL'
DO $f$
DECLARE h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  -- Cliente 1 (oben): 2 docs pagos — antecipou 5d (R$100) e atrasou 10d (R$300).
  INSERT INTO fin_contas_receber VALUES
    ('oben',1,'CLI UM',101,'D1',h-60,h-30,100,0,'RECEBIDO'),
    ('oben',1,'CLI UM',102,'D2',h-50,h-20,300,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES
    ('oben',101,'CR',h-35,100,1,25,'titulo'),   -- prazo real 25, concedido 30 → atraso −5
    ('oben',102,'CR',h-10,300,1,40,'titulo');   -- prazo real 40, concedido 30 → atraso +10
  -- Cliente 1: cancelado (deve sumir) e valor 0 / NaN / Infinity (devem sumir).
  INSERT INTO fin_contas_receber VALUES
    ('oben',1,'CLI UM',103,'D3',h-50,h-20,999,0,'CANCELADO'),
    ('oben',1,'CLI UM',104,'D4',h-50,h-20,0,0,'RECEBIDO'),
    ('oben',1,'CLI UM',105,'D5',h-50,h-20,'NaN',0,'RECEBIDO'),
    ('oben',1,'CLI UM',106,'D6',h-50,h-20,'Infinity',0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES
    ('oben',103,'CR',h-10,999,1,40,'titulo'),
    ('oben',104,'CR',h-10,0,1,40,'titulo'),
    ('oben',105,'CR',h-10,1,1,40,'titulo'),
    ('oben',106,'CR',h-10,1,1,40,'titulo');
  -- Cliente 1: emissão > vencimento (inválido, some).
  INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',107,'D7',h-10,h-20,50,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES ('oben',107,'CR',h-5,50,1,5,'titulo');
  -- Cliente 1: RECEBIDO sem baixa derivada dentro da janela → paga_sem_baixa (cobertura).
  INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',108,'D8',h-40,h-15,70,0,'RECEBIDO');
  -- Cliente 2 (oben): SÓ vencidas abertas — 10d (R$40) e 120d (R$60). Nenhuma paga.
  INSERT INTO fin_contas_receber VALUES
    ('oben',2,'CLI DOIS',201,'E1',h-40,h-10,40,40,'ATRASADO'),
    ('oben',2,'CLI DOIS',202,'E2',h-150,h-120,60,60,'ATRASADO');
  -- Cliente 3 (colacor): status ambíguo (fallback do ingest).
  INSERT INTO fin_contas_receber VALUES ('colacor',3,'CLI TRES',301,'F1',h-40,h-10,80,80,'VENCIDO');
  -- Cliente 4 (oben): paga mas vencimento fora da janela (400d) → não é 'paga'.
  INSERT INTO fin_contas_receber VALUES ('oben',4,'CLI QUATRO',401,'G1',h-430,h-400,500,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES ('oben',401,'CR',h-395,500,1,35,'titulo');
END $f$;
SQL
}

# Asserção: SQL → valor esperado (texto exato).
falhas=0
ok() {
  local got; got="$(Pq -c "$1")"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

suite() {
  falhas=0
  preparar_banco
  P -f "$1"
  # Populações
  ok "SELECT count(*) FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento IN (103,104,105,106,107)" "0" "cancelado/zero/NaN/inf/emissao>venc somem"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=108" "paga_sem_baixa" "recebido sem baixa = paga_sem_baixa"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=202" "vencida_aberta" "vencida aberta de qualquer idade"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=301" "status_ambiguo" "status de fallback = ambiguo"
  ok "SELECT count(*) FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=401" "0" "paga fora da janela de vencimento nao entra"
  ok "SELECT atraso_dias FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=102" "10" "atraso = prazo_real - concedido"
  ok "SELECT dias_vencido FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=202" "120" "dias_vencido"
  # Resumo cliente 1: pond atraso = (100*-5 + 300*10)/400 = 6.25; excesso = (100*0 + 300*7)/400 = 5.25
  ok "SELECT round(atraso_pond,2) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "6.25" "atraso ponderado"
  ok "SELECT round(excesso_carencia_pond,2) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "5.25" "antecipacao nao cancela atraso"
  ok "SELECT n_documentos FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "2" "documentos independentes"
  ok "SELECT round(valor_pago,0) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "400" "valor pago so validos"
  ok "SELECT round(valor_pago_sem_baixa,0) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "70" "cobertura sem baixa"
  ok "SELECT round(atraso_p80_valor,0) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "10" "p80 por valor"
  ok "SELECT round(pct_valor_atrasado,2) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "0.75" "pct valor atrasado"
  # Cliente 2: existe no resumo só com vencidas
  ok "SELECT n_vencidas||'|'||round(saldo_vencido,0)||'|'||round(saldo_vencido_90,0)||'|'||coalesce(n_parcelas::text,'null') FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=2" "2|100|60|null" "cliente so-vencido aparece"
  ok "SELECT n_status_ambiguo FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=3" "1" "ambiguo contado"
  # Volume emitido 12m (cliente 1): docs validos não cancelados emitidos na janela: 100+300+70 = 470 (107 inválido)
  ok "SELECT round(volume_emitido_12m,0) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "470" "volume por emissao"
  # Coorte: mês das vencidas/pagas existe e pct entre 0 e 1
  ok "SELECT count(*) FROM v_ciclo_empresa_coorte WHERE pct_valor_pago < 0 OR pct_valor_pago > 1" "0" "pct pago em [0,1]"
  ok "SELECT bool_or(mes_parcial) FROM v_ciclo_empresa_coorte" "t" "mes corrente marcado parcial"
  # Segurança
  ok "SELECT count(*) FROM pg_class WHERE relname LIKE 'v_ciclo_%' AND NOT ('security_invoker=on' = ANY(coalesce(reloptions,'{}')))" "0" "security_invoker em todas"
  ok "SELECT bool_or(has_table_privilege('anon','public.'||relname,'SELECT')) FROM pg_class WHERE relname LIKE 'v_ciclo_%'" "f" "anon sem select"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
if ! suite "$TMPD/mig.sql"; then echo "CONTROLE VERMELHO — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

# 2) FALSIFICAÇÃO — cada sabotagem TEM de ficar vermelha.
sabotar() { # $1 nome, $2 expressão sed
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  if suite "$TMPD/sab.sql" >/dev/null 2>&1; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  echo "sabotagem vermelha ok: $1"
}
sabotar "filtro de cancelado" "s/r.status_titulo IS DISTINCT FROM 'CANCELADO'/true/"
sabotar "max(0,.) do excesso" "s/greatest(t.atraso_dias - 3, 0)/(t.atraso_dias - 3)/"
sabotar "sinal do atraso" "s/b.prazo_ponderado_dias - (r.data_vencimento - r.data_emissao)/(r.data_vencimento - r.data_emissao) - b.prazo_ponderado_dias/"
sabotar "status ambiguo" "s/'RECEBIDO','A VENCER','ATRASADO','CANCELADO'/'RECEBIDO','A VENCER','ATRASADO','CANCELADO','VENCIDO'/"
sabotar "finitude" "s/AND r.valor_documento < 'Infinity'//"

echo "PROVA-CICLO-CLIENTE-OK"
