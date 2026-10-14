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
  saldo numeric, status_titulo text, numero_documento_fiscal text);
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

  -- Cliente 5 (oben): numero_documento '' (comum em prod). 3 parcelas da MESMA NF + 4 titulos sem NF
  -- (fiscal '' ou NULL) => n_documentos = 1 (NF-X) + 4 (chave por lancamento) = 5.
  INSERT INTO fin_contas_receber (company,omie_codigo_cliente,nome_cliente,omie_codigo_lancamento,numero_documento,
      data_emissao,data_vencimento,valor_documento,saldo,status_titulo,numero_documento_fiscal) VALUES
    ('oben',5,'CLI CINCO',501,'',h-50,h-20,10,0,'RECEBIDO','NF-X'),
    ('oben',5,'CLI CINCO',502,'',h-50,h-20,10,0,'RECEBIDO','NF-X'),
    ('oben',5,'CLI CINCO',503,'',h-50,h-20,10,0,'RECEBIDO','NF-X'),
    ('oben',5,'CLI CINCO',504,'',h-50,h-20,10,0,'RECEBIDO',''),
    ('oben',5,'CLI CINCO',505,'',h-50,h-20,10,0,'RECEBIDO',''),
    ('oben',5,'CLI CINCO',506,'',h-50,h-20,10,0,'RECEBIDO',NULL),
    ('oben',5,'CLI CINCO',507,'',h-50,h-20,10,0,'RECEBIDO',NULL);
  INSERT INTO v_titulo_baixas
    SELECT 'oben',n,'CR',h-15,10,1,35,'titulo' FROM generate_series(501,507) n;
  -- Cliente 6 (oben): A VENCER com vencimento passado (lag de sync) = vencida; VENCE HOJE = nem ambiguo nem vencido.
  INSERT INTO fin_contas_receber VALUES
    ('oben',6,'CLI SEIS',601,'H1',h-35,h-5,25,25,'A VENCER'),
    ('oben',6,'CLI SEIS',602,'H2',h-30,h,10,10,'VENCE HOJE');
  -- Cliente 7 (oben): baixa com prazo NaN / Infinity nao conta como baixa => paga_sem_baixa.
  INSERT INTO fin_contas_receber VALUES
    ('oben',7,'CLI SETE',701,'I1',h-50,h-20,40,0,'RECEBIDO'),
    ('oben',7,'CLI SETE',702,'I2',h-50,h-20,40,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES
    ('oben',701,'CR',h-10,40,1,'NaN','titulo'),
    ('oben',702,'CR',h-10,40,1,'Infinity','titulo');
  -- Cliente 8 (colacor): coorte de um mes fechado (mes de h-200), dia 6 do mes. concedido 30 em todas.
  --   801 paga R$100 prazo real 40 (+10) | 802 paga R$300 prazo real 20 (-10)
  --   803 ATRASADO R$200 saldo 150 | 804 RECEBIDO sem baixa R$50
  INSERT INTO fin_contas_receber VALUES
    ('colacor',8,'CLI OITO',801,'J1',date_trunc('month',h-200)::date+5-30,date_trunc('month',h-200)::date+5,100,0,'RECEBIDO'),
    ('colacor',8,'CLI OITO',802,'J2',date_trunc('month',h-200)::date+5-30,date_trunc('month',h-200)::date+5,300,0,'RECEBIDO'),
    ('colacor',8,'CLI OITO',803,'J3',date_trunc('month',h-200)::date+5-30,date_trunc('month',h-200)::date+5,200,150,'ATRASADO'),
    ('colacor',8,'CLI OITO',804,'J4',date_trunc('month',h-200)::date+5-30,date_trunc('month',h-200)::date+5,50,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES
    ('colacor',801,'CR',h-150,100,1,40,'titulo'),
    ('colacor',802,'CR',h-150,300,1,20,'titulo');
  -- Cliente 9 (oben): extremos da janela. 901 vence EXATAMENTE em h-365; 902 vence ontem.
  INSERT INTO fin_contas_receber VALUES
    ('oben',9,'CLI NOVE',901,'K1',h-395,h-365,10,0,'RECEBIDO'),
    ('oben',9,'CLI NOVE',902,'K2',h-31,h-1,10,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES
    ('oben',901,'CR',h-360,10,1,30,'titulo'),
    ('oben',902,'CR',h-1,10,1,30,'titulo');
END $f$;
SQL
}

# Asserção: SQL → valor esperado (texto exato).
falhas=0
ok() {
  local got; got="$(Pq -c "$1")"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

HOJE="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
MES8="date_trunc('month', $HOJE - 200)::date"

suite() {
  falhas=0
  preparar_banco
  # A migration (ou a sabotagem) TEM de aplicar: erro de SQL nao pode passar por "vermelho".
  P -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }
  # Populações
  ok "SELECT count(*) FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento IN (103,104,105,106,107)" "0" "cancelado/zero/NaN/inf/emissao>venc somem"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=108" "paga_sem_baixa" "recebido sem baixa = paga_sem_baixa"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=202" "vencida_aberta" "vencida aberta de qualquer idade"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=301" "status_ambiguo" "status de fallback = ambiguo"
  ok "SELECT count(*) FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=401" "0" "paga fora da janela de vencimento nao entra"
  ok "SELECT atraso_dias FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=102" "10" "atraso = prazo_real - concedido"
  ok "SELECT dias_vencido FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=202" "120" "dias_vencido"
  ok "SELECT count(*) FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento IN (701,702) AND situacao <> 'paga_sem_baixa'" "0" "prazo NaN ou inf nao conta como baixa"
  ok "SELECT situacao||'|'||dias_vencido FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=601" "vencida_aberta|5" "a vencer com vencimento passado vira vencida"
  ok "SELECT count(*) FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=602" "0" "vence hoje nao e ambiguo nem vencido"
  ok "SELECT n_documentos FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=5" "5" "n_documentos com NF compartilhada e vazios"
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
  # Coorte: valores exatos do mes fechado do cliente 8 (colacor)
  ok "SELECT valor_vencido_no_mes||'|'||valor_pago||'|'||valor_em_aberto FROM v_ciclo_empresa_coorte WHERE company='colacor' AND mes_vencimento=$MES8" "650|450|150" "coorte valores do mes"
  ok "SELECT round(pct_valor_pago,4) FROM v_ciclo_empresa_coorte WHERE company='colacor' AND mes_vencimento=$MES8" "0.6923" "coorte pct pago"
  ok "SELECT round(prazo_concedido_pond,2)||'|'||round(prazo_real_pond_pagas,2)||'|'||round(atraso_pond_pagas,2) FROM v_ciclo_empresa_coorte WHERE company='colacor' AND mes_vencimento=$MES8" "30.00|25.00|-5.00" "coorte ponderados das pagas"
  ok "SELECT mes_parcial FROM v_ciclo_empresa_coorte WHERE company='colacor' AND mes_vencimento=$MES8" "f" "mes fechado nao e parcial"
  # mes_parcial nos dois extremos (esperado derivado da data; vazio se hoje ou h-365 caem no dia 1)
  ok "SELECT coalesce(bool_and(mes_parcial),true) FROM v_ciclo_empresa_coorte WHERE mes_vencimento = date_trunc('month', $HOJE)::date" "t" "mes_parcial no mes corrente"
  ok "SELECT (SELECT mes_parcial FROM v_ciclo_empresa_coorte WHERE company='oben' AND mes_vencimento = date_trunc('month', $HOJE - 365)::date) = (($HOJE - 365) <> date_trunc('month', $HOJE - 365)::date)" "t" "mes_parcial no primeiro mes da janela"
  # Coorte: pct entre 0 e 1
  ok "SELECT count(*) FROM v_ciclo_empresa_coorte WHERE pct_valor_pago < 0 OR pct_valor_pago > 1" "0" "pct pago em [0,1]"
  # Segurança
  ok "SELECT count(*) FROM pg_class WHERE relname LIKE 'v_ciclo_%' AND NOT ('security_invoker=on' = ANY(coalesce(reloptions,'{}')))" "0" "security_invoker em todas"
  ok "SELECT bool_or(has_table_privilege('anon','public.'||relname,'SELECT')) FROM pg_class WHERE relname LIKE 'v_ciclo_%'" "f" "anon sem select"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
if ! suite "$TMPD/mig.sql"; then echo "CONTROLE VERMELHO — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

# 2) FALSIFICAÇÃO — cada sabotagem TEM de ficar vermelha PELA asserção esperada: a cópia aplica (rc=0)
#    e a saída contém "FALHOU: <rótulo>" (ASCII, caixa fixa). Vermelho por erro de sintaxe reprova.
sabotar() { # $1 nome, $2 expressão sed, $3 rótulo da asserção esperada
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local out rc=0
  out="$(suite "$TMPD/sab.sql" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  if [ "$rc" -eq 99 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$out"; then
    echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; exit 1
  fi
  echo "sabotagem vermelha ok: $1"
}
sabotar "filtro de cancelado" "s/r.status_titulo IS DISTINCT FROM 'CANCELADO'/true/" "cancelado/zero/NaN/inf/emissao>venc somem"
sabotar "max(0,.) do excesso" "s/greatest(t.atraso_dias - 3, 0)/(t.atraso_dias - 3)/" "antecipacao nao cancela atraso"
sabotar "sinal do atraso" "s/b.prazo_ponderado_dias - (r.data_vencimento - r.data_emissao)/(r.data_vencimento - r.data_emissao) - b.prazo_ponderado_dias/" "atraso = prazo_real - concedido"
sabotar "status ambiguo" "s/'RECEBIDO','A VENCER','VENCE HOJE','ATRASADO','CANCELADO'/'RECEBIDO','A VENCER','VENCE HOJE','ATRASADO','CANCELADO','VENCIDO'/" "status de fallback = ambiguo"
sabotar "finitude" "s/AND r.valor_documento < 'Infinity'//" "cancelado/zero/NaN/inf/emissao>venc somem"
sabotar "VENCE HOJE fora do vocabulario" "s/'A VENCER','VENCE HOJE','ATRASADO'/'A VENCER','ATRASADO'/" "vence hoje nao e ambiguo nem vencido"
sabotar "lag de sync (A VENCER vencido)" "s/OR (status_titulo IN ('A VENCER','VENCE HOJE') AND data_vencimento < hoje_sp)//" "a vencer com vencimento passado vira vencida"
sabotar "nullif da NF (fiscal)" "s/nullif(btrim(r.numero_documento_fiscal), '')/r.numero_documento_fiscal/" "n_documentos com NF compartilhada e vazios"
sabotar "nullif do numero_documento" "s/nullif(btrim(r.numero_documento), '')/r.numero_documento/" "n_documentos com NF compartilhada e vazios"
sabotar "prazo infinito como baixa" "s/AND b.prazo_ponderado_dias < 'Infinity'//" "prazo NaN ou inf nao conta como baixa"
sabotar "coorte valor_em_aberto" "s/sum(saldo) FILTER (WHERE situacao = 'vencida_aberta')/sum(saldo) FILTER (WHERE situacao = 'paga_sem_baixa')/" "coorte valores do mes"
sabotar "mes_parcial 1o mes da janela" "s/OR (date_trunc('month', data_vencimento)::date = date_trunc('month', h - 365)::date AND (h - 365) <> date_trunc('month', h - 365)::date)//" "mes_parcial no primeiro mes da janela"

echo "PROVA-CICLO-CLIENTE-OK"
