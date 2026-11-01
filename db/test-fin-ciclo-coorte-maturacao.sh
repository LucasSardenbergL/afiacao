#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261101120000_fin_ciclo_coorte_maturacao                                ║
# ║  v_ciclo_empresa_coorte_maturacao + fin_ciclo_empresa_coorte_maturacao() (gate master)  ║
# ║      bash db/test-fin-ciclo-coorte-maturacao.sh > logs/t.log 2>&1; echo "exit=$?"      ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-coorte-maturacao.sh  (2º ambiente)          ║
# ╚══════════════════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocação + sabotagens sobre CÓPIA da migration (o repo nunca é tocado).
# Asserções em ASCII, caixa fixa, sem -i. Fixture relativa a hoje_sp (a view lê `now()` em SP):
#  - mês MADURO (mês de h-120: o último dia + 60 já passou): 8 títulos no universo cobrindo as 5 massas
#    (antecipado, no dia, com atraso em 4 degraus de janela, sem data de baixa ×2, vencida aberta com
#    saldo parcial) + 2 fora do universo (cancelado e sem cliente — filtro da v_ciclo_cr_titulos).
#  - mês JOVEM (mês de h-1): nenhuma janela madura → pct NULL, flags false, massas preenchidas.
#  - mês MEIO (mês de h-46): D+15 maduro e D+60 imaturo por construção (fim do mês entre h-46 e h-16);
#    D+30 é ambíguo pelo calendário → prova-se só a COERÊNCIA (pct nulo ⇔ não maduro).
#  - fora da janela de 365 d (vencido h-400, pago) e vencida aberta antiga (h-900): não viram coorte.
# Sabotagens com postcondição embutida (invoker, gate, anon): a 1ª camada aborta o apply (rc=99 + mensagem
# da postcondição); a camada "b" neutraliza a postcondição e exige que a ASSERÇÃO fique vermelha.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5490}"
SLUG="fin-ciclo-coorte-maturacao"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG_VIEWS="$REPO_ROOT/supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql"
MIG_RPCS="$REPO_ROOT/supabase/migrations/20261015003200_fin_ciclo_rpcs_gate.sql"
MIG="$REPO_ROOT/supabase/migrations/20261101120000_fin_ciclo_coorte_maturacao.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

U_MASTER="11111111-1111-1111-1111-111111111111"
U_EMPLOYEE="22222222-2222-2222-2222-222222222222"
U_MASTER_SO_OBEN="33333333-3333-3333-3333-333333333333"

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
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.fin_permissoes_stub (user_id uuid, empresas text[]);

-- Stub de fin_user_can_access (como em test-fin-ciclo-rpc.sh): master/employee sem linha no stub = tudo;
-- com linha = só as empresas listadas (é o que prova o gate 2).
CREATE FUNCTION public.fin_user_can_access(check_company text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p
                  WHERE p.user_id = auth.uid() AND check_company = ANY (p.empresas))
      OR (EXISTS (SELECT 1 FROM public.user_roles r
                   WHERE r.user_id = auth.uid() AND r.role IN ('master','employee'))
          AND NOT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p WHERE p.user_id = auth.uid()))
$$;

-- Captura SO a SQLSTATE 42501 (o resto propaga e derruba a prova). Roda como o chamador (INVOKER).
CREATE FUNCTION public.t_lanca(q text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN 'NAO-LANCOU';
EXCEPTION WHEN SQLSTATE '42501' THEN
  RETURN '42501|' || SQLERRM;
END $$;

-- Como o Supabase: EXECUTE por default para as 3 roles (a migration precisa fechar as duas pontas).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated, service_role;
GRANT SELECT ON public.fin_contas_receber, public.v_titulo_baixas, public.user_roles, public.fin_permissoes_stub TO authenticated;

INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');
INSERT INTO public.fin_permissoes_stub VALUES ('33333333-3333-3333-3333-333333333333', ARRAY['oben']);

DO $f$
DECLARE
  h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v date := date_trunc('month', h - 120)::date + 10;  -- vencimento no mes MADURO
BEGIN
  -- Mes MADURO (oben): emissao = v-30 em todos.
  INSERT INTO fin_contas_receber VALUES
    ('oben',1,'CLI UM',101,'A',v-30,v,100,0,'RECEBIDO'),     -- baixa v-5  → antecipado 5 d
    ('oben',1,'CLI UM',102,'B',v-30,v,200,0,'RECEBIDO'),     -- baixa v+10 → D+15
    ('oben',1,'CLI UM',103,'C',v-30,v,300,0,'RECEBIDO'),     -- baixa v+20 → D+30
    ('oben',1,'CLI UM',104,'D',v-30,v,400,0,'RECEBIDO'),     -- baixa v+45 → D+60
    ('oben',1,'CLI UM',105,'E',v-30,v,500,0,'RECEBIDO'),     -- baixa v+70 → fora das 3 janelas
    ('oben',2,'CLI DOIS',106,'F',v-30,v,100,60,'ATRASADO'),  -- vencida aberta, saldo 60
    ('oben',2,'CLI DOIS',107,'G',v-30,v,50,0,'RECEBIDO'),    -- RECEBIDO sem baixa → paga_sem_baixa
    ('oben',2,'CLI DOIS',108,'H',v-30,v,70,0,'RECEBIDO'),    -- baixa com data NULL → paga sem data
    ('oben',2,'CLI DOIS',111,'I',v-30,v,80,0,'RECEBIDO'),    -- baixa = v → no dia
    ('oben',1,'CLI UM',109,'X',v-30,v,999,0,'CANCELADO'),    -- fora do universo
    ('oben',NULL,'SEM CLI',110,'Y',v-30,v,10,0,'RECEBIDO');  -- fora do universo (sem cliente)
  INSERT INTO v_titulo_baixas VALUES
    ('oben',101,'CR',v-5,100,1,25,'titulo'),
    ('oben',102,'CR',v+10,200,1,40,'titulo'),
    ('oben',103,'CR',v+20,300,1,50,'titulo'),
    ('oben',104,'CR',v+45,400,1,75,'titulo'),
    ('oben',105,'CR',v+70,500,1,100,'titulo'),
    ('oben',108,'CR',NULL,70,1,30,'titulo'),
    ('oben',111,'CR',v,80,1,30,'titulo'),
    ('oben',109,'CR',v+1,999,1,31,'titulo'),
    ('oben',110,'CR',v+1,10,1,31,'titulo');
  -- Mes JOVEM (oben): vencido ontem, pago ontem.
  INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',201,'J',h-31,h-1,100,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES ('oben',201,'CR',h-1,100,1,30,'titulo');
  -- Mes MEIO (oben): vencido h-46, pago h-40.
  INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',301,'K',h-76,h-46,100,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES ('oben',301,'CR',h-40,100,1,36,'titulo');
  -- Fora da janela de 365 d (oben): pago, mas vencido ha 400 d.
  INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',401,'L',h-430,h-400,100,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES ('oben',401,'CR',h-390,100,1,40,'titulo');
  -- Vencida aberta ANTIGA (oben, h-900): entra na v_ciclo_cr_titulos (sem janela la), a coorte corta.
  INSERT INTO fin_contas_receber VALUES ('oben',2,'CLI DOIS',402,'O',h-930,h-900,30,30,'ATRASADO');
  -- colacor: 1 titulo no mes maduro (gate 2) + vencida aberta ANTIGA (h-900, fora da janela).
  INSERT INTO fin_contas_receber VALUES
    ('colacor',3,'CLI TRES',501,'M',v-30,v,200,0,'RECEBIDO'),
    ('colacor',3,'CLI TRES',601,'N',h-930,h-900,50,50,'ATRASADO');
  INSERT INTO v_titulo_baixas VALUES ('colacor',501,'CR',v+5,200,1,35,'titulo');
END $f$;
SQL
  P -f "$MIG_VIEWS"
  P -f "$MIG_RPCS"
}

# Sessão simulada: $1 = uuid do usuário ('' = sem claims), $2 = SQL (uma consulta). Roda como authenticated.
sess() {
  {
    echo "BEGIN;"
    echo "SET LOCAL ROLE authenticated;"
    if [ -n "$1" ]; then
      echo "SELECT set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true) AS c \\gset"
    fi
    echo "$2;"
    echo "COMMIT;"
  } | Pq
}

falhas=0
# $1 = uuid, $2 = SQL, $3 = esperado, $4 = rótulo. Erro de psql vira valor distinto (nunca mascara).
oks() {
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}
okp() { # como postgres
  local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

V="public.v_ciclo_empresa_coorte_maturacao"
RPC="public.fin_ciclo_empresa_coorte_maturacao()"
BARRADO="42501|CICLO_SO_MASTER"
MADURO="date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 120)::date"
JOVEM="date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1)::date"
MEIO="date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 46)::date"

suite() {
  falhas=0
  preparar_banco
  # A migration (ou a sabotagem) TEM de aplicar: erro de SQL nao pode passar por "vermelho".
  P -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }

  # Fixture nao pode ser vacua (401, pago ha 400 d, ja fica fora na v_ciclo_cr_titulos; 402 entra e a coorte corta).
  okp "SELECT count(*) FROM public.v_ciclo_cr_titulos WHERE company='oben'" "12" "fixture: 12 titulos oben no universo"

  # (a) coortes: 3 da oben (maduro, meio, jovem) + 1 colacor; janela de 365 d e vencida antiga fora.
  okp "SELECT count(*) FROM $V WHERE company='oben'" "3" "a janela: 3 coortes oben"
  okp "SELECT count(*) FROM $V WHERE company='colacor'" "1" "a colacor: 1 coorte"
  okp "SELECT count(*) FROM $V WHERE company='oben' AND mes_vencimento = $MADURO" "1" "a coorte madura existe"

  # (b) mes MADURO: universo, massas e maturacao.
  local W="FROM $V WHERE company='oben' AND mes_vencimento = $MADURO"
  okp "SELECT titulos||'|'||valor_vencido_no_mes $W" "9|1800" "b universo: 9 titulos somam 1800 (cancelado e sem cliente fora)"
  okp "SELECT valor_antecipado||'|'||valor_pago_no_dia||'|'||valor_pago_com_atraso $W" "100|80|1400" "b massas: antecipado, no dia, com atraso"
  okp "SELECT valor_pago_sem_data $W" "120" "b massa: pago sem data (sem baixa 50 + baixa sem data 70)"
  okp "SELECT valor_em_aberto $W" "60" "b massa: em aberto = saldo"
  okp "SELECT round(dias_antecipacao_pond, 2)||'|'||round(dias_atraso_pond, 2) $W" "5.00|43.57" "b dias ponderados por valor, cada um na sua massa"
  okp "SELECT maduro_d15||'|'||maduro_d30||'|'||maduro_d60 $W" "true|true|true" "b coorte madura nas 3 janelas"
  okp "SELECT pct_pago_d15||'|'||pct_pago_d30||'|'||pct_pago_d60 $W" "0.2111|0.3778|0.6000" "b maturacao D+15/30/60 pelo VENCIMENTO"

  # (c) mes JOVEM: imaturo nas 3 janelas → pct NULL (nunca numero parcial), massas preenchidas.
  local J="FROM $V WHERE company='oben' AND mes_vencimento = $JOVEM"
  okp "SELECT maduro_d15||'|'||maduro_d30||'|'||maduro_d60 $J" "false|false|false" "c coorte jovem: imatura nas 3 janelas"
  okp "SELECT (pct_pago_d15 IS NULL)||'|'||(pct_pago_d30 IS NULL)||'|'||(pct_pago_d60 IS NULL) $J" "true|true|true" "c coorte jovem: pct_pago_d15 nulo"
  okp "SELECT valor_pago_no_dia||'|'||valor_vencido_no_mes $J" "100|100" "c coorte jovem: massas preenchidas"

  # (d) mes MEIO: D+15 maduro e D+60 imaturo por construcao; D+30 coerente com a flag.
  local M="FROM $V WHERE company='oben' AND mes_vencimento = $MEIO"
  okp "SELECT maduro_d15||'|'||maduro_d60||'|'||pct_pago_d15||'|'||coalesce(pct_pago_d60::text,'null') $M" "true|false|1.0000|null" "d meio: D+15 publica, D+60 nao"
  okp "SELECT (pct_pago_d30 IS NULL) = (NOT maduro_d30) $M" "t" "d meio: D+30 nulo sse imaturo"

  # (e) RPC como master = view lida como postgres; ordem estavel.
  oks "$U_MASTER" "SELECT count(*) FROM $RPC" "4" "e master ve as 4 coortes"
  oks "$U_MASTER" "SELECT string_agg(company||':'||mes_vencimento, ',' ORDER BY company, mes_vencimento) FROM $RPC" \
    "$(Pq -c "SELECT string_agg(company||':'||mes_vencimento, ',' ORDER BY company, mes_vencimento) FROM $V")" "e RPC = view, ordenada"
  oks "$U_MASTER" "SELECT pct_pago_d60 FROM $RPC WHERE company='oben' AND mes_vencimento = $MADURO" "0.6000" "e RPC traz a maturacao"

  # (f) gate 1: employee e sem claims barrados.
  oks "$U_EMPLOYEE" "SELECT public.t_lanca('SELECT * FROM $RPC')" "$BARRADO" "f employee barrado"
  oks "" "SELECT public.t_lanca('SELECT * FROM $RPC')" "$BARRADO" "f sem claims barrado"

  # (g) gate 2: master sem acesso a colacor so recebe oben.
  oks "$U_MASTER_SO_OBEN" "SELECT count(*) || '|' || string_agg(DISTINCT company, ',') FROM $RPC" "3|oben" "g gate2 so oben"

  # (h) ACL e invoker.
  okp "SELECT has_function_privilege('anon','$RPC','EXECUTE')" "f" "h anon sem EXECUTE"
  okp "SELECT has_function_privilege('authenticated','$RPC','EXECUTE')" "t" "h authenticated com EXECUTE"
  okp "SELECT has_table_privilege('anon','$V','SELECT')" "f" "h anon sem SELECT na view"
  okp "SELECT 'security_invoker=on' = ANY (coalesce(c.reloptions,'{}')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='v_ciclo_empresa_coorte_maturacao'" "t" "h view com security_invoker"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
rc=0; out="$(suite "$TMPD/mig.sql" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "$out"; echo "CONTROLE VERMELHO (rc=$rc) — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

# 2) FALSIFICAÇÃO — uma sabotagem por vez, vermelha PELA asserção esperada.
sabotar() { # $1 nome, $2 expressão sed, $3 rótulo esperado (FALHOU: <rotulo> |)
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  if [ "$r" -eq 99 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; echo "$o"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$o"; then
    echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; echo "$o"; exit 1
  fi
  echo "sabotagem vermelha ok: $1"
}
# Camada 1 das sabotagens com postcondição: o apply TEM de abortar (rc=99) pela mensagem da postcondição.
sabotar_post() { # $1 nome, $2 expressão sed, $3 mensagem da postcondição
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -ne 99 ] || ! grep -qF "$3" <<<"$o"; then
    echo "SABOTAGEM NAO ABORTOU PELA POSTCONDICAO: $1 (rc=$r, esperava '$3')"; echo "$o"; exit 1
  fi
  echo "sabotagem vermelha ok: $1 (postcondicao aborta o apply)"
}

sabotar "1 antecipacao somada ao atraso" \
  "s/AND data_baixa > data_vencimento), 0) AS valor_pago_com_atraso/AND data_baixa <> data_vencimento), 0) AS valor_pago_com_atraso/" \
  "b massas: antecipado, no dia, com atraso"
sabotar "2 coorte imatura publica numero" \
  "s/CASE WHEN m.fim_mes + 15 < m.h THEN round(m.pago_d15 \/ nullif(m.valor_vencido_no_mes, 0), 4) END AS pct_pago_d15/round(m.pago_d15 \/ nullif(m.valor_vencido_no_mes, 0), 4) AS pct_pago_d15/" \
  "c coorte jovem: pct_pago_d15 nulo"
sabotar "3 D+30 pela emissao em vez do vencimento" \
  "s/AND data_baixa <= data_vencimento + 30/AND data_baixa <= data_emissao + 30/" \
  "b maturacao D+15/30/60 pelo VENCIMENTO"
sabotar "4 janela de 365 d aberta" \
  "s/    AND v.data_vencimento >= hoje.h - 365//" \
  "a janela: 3 coortes oben"
sabotar "5 pago sem data de baixa contado como se tivesse data" \
  "s/ OR (situacao = 'paga' AND data_baixa IS NULL)//" \
  "b massa: pago sem data (sem baixa 50 + baixa sem data 70)"
sabotar "6 em aberto pelo documento em vez do saldo" \
  "s/coalesce(sum(saldo) FILTER (WHERE situacao = 'vencida_aberta'), 0)/coalesce(sum(valor_documento) FILTER (WHERE situacao = 'vencida_aberta'), 0)/" \
  "b massa: em aberto = saldo"
sabotar "7 dias de atraso sem ponderar por valor" \
  "s/sum(valor_documento \* (data_baixa - data_vencimento)) FILTER/sum((data_baixa - data_vencimento)) FILTER/" \
  "b dias ponderados por valor, cada um na sua massa"
sabotar "8 maturidade D+60 pela flag de D+15" \
  "s/(m.fim_mes + 60 < m.h) AS maduro_d60/(m.fim_mes + 15 < m.h) AS maduro_d60/" \
  "d meio: D+15 publica, D+60 nao"

# 9) view sem security_invoker: a postcondição aborta; 9b neutraliza a postcondição → asserção (h) vermelha.
sabotar_post "9 view sem security_invoker" \
  "s/WITH (security_invoker=on) AS/AS/" \
  "postcondicao: view sem security_invoker"
sabotar "9b view sem security_invoker, postcondicao neutralizada" \
  "s/WITH (security_invoker=on) AS/AS/; s/IF v_ok IS DISTINCT FROM true THEN/IF false THEN/" \
  "h view com security_invoker"

# 10) RPC sem gate master: idem em 2 camadas (a postcondição lê o corpo da função).
NEUTRA_GATE="s/IF v_def NOT LIKE '%_fin_ciclo_gate_master()%' OR v_def NOT LIKE '%fin_user_can_access(v.company)%' THEN/IF false THEN/"
sabotar_post "10 RPC sem gate master" \
  "/PERFORM public._fin_ciclo_gate_master();/d" \
  "postcondicao: RPC sem gate"
sabotar "10b RPC sem gate master, postcondicao neutralizada" \
  "/PERFORM public._fin_ciclo_gate_master();/d; $NEUTRA_GATE" \
  "f employee barrado"
sabotar "11 RPC sem fin_user_can_access, postcondicao neutralizada" \
  "s/    WHERE public.fin_user_can_access(v.company)//; $NEUTRA_GATE" \
  "g gate2 so oben"

# 12) anon fora do REVOKE da RPC: postcondição aborta; 12b neutralizada → asserção (h) vermelha.
sabotar_post "12 anon fora do REVOKE da RPC" \
  "s/REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC;/" \
  "postcondicao: anon executa"
sabotar "12b anon fora do REVOKE da RPC, postcondicao neutralizada" \
  "s/REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC;/; s/IF has_function_privilege('anon', 'public.fin_ciclo_empresa_coorte_maturacao()', 'EXECUTE') THEN/IF false THEN/" \
  "h anon sem EXECUTE"
sabotar "13 anon fora do REVOKE da view, postcondicao neutralizada" \
  "s/REVOKE ALL ON public.v_ciclo_empresa_coorte_maturacao FROM PUBLIC, anon;/REVOKE ALL ON public.v_ciclo_empresa_coorte_maturacao FROM PUBLIC;/; s/IF has_table_privilege('anon', 'public.v_ciclo_empresa_coorte_maturacao', 'SELECT') THEN/IF false THEN/" \
  "h anon sem SELECT na view"

echo "PROVA-CICLO-COORTE-MATURACAO-OK"
