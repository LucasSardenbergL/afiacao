#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261101120000_fin_ciclo_coorte_maturacao                                ║
# ║  v_ciclo_empresa_coorte_maturacao + fin_ciclo_empresa_coorte_maturacao() (gate master)  ║
# ║      bash db/test-fin-ciclo-coorte-maturacao.sh > logs/t.log 2>&1; echo "exit=$?"      ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-coorte-maturacao.sh  (2º ambiente)          ║
# ╚══════════════════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocação + sabotagens sobre CÓPIA da migration (o repo nunca é tocado).
# Asserções em ASCII, caixa fixa, sem -i.
#
# ⏰ RELÓGIO CONTROLADO (padrão de db/test-hoje-sp-views-defaults.sh): `public.now()` lê a GUC `test.agora`
# e é TRIPWIRE sem ela; as views (v_ciclo_cr_titulos e a desta migration) são criadas com
# `search_path=public,pg_catalog`, então o `now()` delas amarra no controlado. Fixture em datas ABSOLUTAS,
# "hoje" = 2026-11-16 (SP) salvo onde a asserção muda o relógio — é o que prova as BORDAS sem depender do
# dia em que a prova roda (achado Codex, 2026-11-01):
#  - mês MADURO jul/2026: 9 títulos no universo cobrindo as 5 massas + 2 fora do universo (cancelado, sem cliente).
#  - mês MEIO set/2026: fim 30/09 → D+15/D+30 maduros, D+60 (29/11) imaturo.
#  - mês BORDA out/2026: fim 31/10 + 15 = 15/11 → maduro em 16/11 e NÃO em 15/11 (inclusive 23:59:59 SP);
#    um título pago em D+15 exato (conta, `<=`) e outro em D+16 (não conta).
#  - mês JOVEM nov/2026 (corrente): imaturo + mes_parcial.
#  - nov/2025: começo da janela de 365 d (16/11/2025) → mes_parcial; vencida aberta de jun/2025 fica fora.
# Limite conhecido: a tabela-stub de v_titulo_baixas não reproduz a restrição da view real (só CR
# RECEBIDO/LIQUIDADO emitem baixa) — a fixture não depende disso (ATRASADO nunca recebe linha de baixa).
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
# Criação de objetos que leem now(): public antes de pg_catalog, para amarrar no relógio controlado.
Pc() { PGOPTIONS="-c search_path=public,pg_catalog" P "$@"; }
AGORA="2026-11-16T15:00:00Z"   # 12:00 de 16/11/2026 em SP
# Leitura sob o relógio: $1 = test.agora, $2 = SQL (como postgres).
Ler() { PGOPTIONS="-c test.agora=$1" P -tA -c "$2"; }

U_MASTER="11111111-1111-1111-1111-111111111111"
U_EMPLOYEE="22222222-2222-2222-2222-222222222222"
U_MASTER_SO_OBEN="33333333-3333-3333-3333-333333333333"

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
-- Relógio controlado: criado ANTES das views (elas amarram o now() no CREATE pelo search_path de quem cria).
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE plpgsql STABLE AS $f$
DECLARE v text := nullif(pg_catalog.current_setting('test.agora', true), '');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'TRIPWIRE: now() lido sem test.agora — a prova escapou do relógio controlado'
      USING ERRCODE = 'Z9T01';
  END IF;
  RETURN v::timestamptz;
END $f$;

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
-- com linha = só as empresas listadas (prova que a RPC APLICA o predicado; a função real de prod é outra).
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

-- Como o Supabase: privilégios por default para as 3 roles (a migration precisa fechar as duas pontas).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated, service_role;
GRANT SELECT ON public.fin_contas_receber, public.v_titulo_baixas, public.user_roles, public.fin_permissoes_stub TO authenticated;

INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');
INSERT INTO public.fin_permissoes_stub VALUES ('33333333-3333-3333-3333-333333333333', ARRAY['oben']);

-- ── Fixture em datas ABSOLUTAS (hoje = 2026-11-16 SP) ─────────────────────────────────────────────
-- Mes MADURO jul/2026: vencimento 10/07, emissao 10/06 em todos.
INSERT INTO fin_contas_receber VALUES
  ('oben',1,'CLI UM',101,'A','2026-06-10','2026-07-10',100,0,'RECEBIDO'),     -- baixa 05/07 → antecipado 5 d
  ('oben',1,'CLI UM',102,'B','2026-06-10','2026-07-10',200,0,'RECEBIDO'),     -- baixa 20/07 → D+15 (atraso 10)
  ('oben',1,'CLI UM',103,'C','2026-06-10','2026-07-10',300,0,'RECEBIDO'),     -- baixa 30/07 → D+30 (atraso 20)
  ('oben',1,'CLI UM',104,'D','2026-06-10','2026-07-10',400,0,'RECEBIDO'),     -- baixa 24/08 → D+60 (atraso 45)
  ('oben',1,'CLI UM',105,'E','2026-06-10','2026-07-10',500,0,'RECEBIDO'),     -- baixa 18/09 → fora (atraso 70)
  ('oben',2,'CLI DOIS',106,'F','2026-06-10','2026-07-10',100,60,'ATRASADO'),  -- vencida aberta, saldo 60
  ('oben',2,'CLI DOIS',107,'G','2026-06-10','2026-07-10',50,0,'RECEBIDO'),    -- RECEBIDO sem baixa → paga_sem_baixa
  ('oben',2,'CLI DOIS',108,'H','2026-06-10','2026-07-10',70,0,'RECEBIDO'),    -- baixa com data NULL → paga sem data
  ('oben',2,'CLI DOIS',111,'I','2026-06-10','2026-07-10',80,0,'RECEBIDO'),    -- baixa = vencimento → no dia
  ('oben',1,'CLI UM',109,'X','2026-06-10','2026-07-10',999,0,'CANCELADO'),    -- fora do universo
  ('oben',NULL,'SEM CLI',110,'Y','2026-06-10','2026-07-10',10,0,'RECEBIDO');  -- fora do universo (sem cliente)
INSERT INTO v_titulo_baixas VALUES
  ('oben',101,'CR','2026-07-05',100,1,25,'titulo'),
  ('oben',102,'CR','2026-07-20',200,1,40,'titulo'),
  ('oben',103,'CR','2026-07-30',300,1,50,'titulo'),
  ('oben',104,'CR','2026-08-24',400,1,75,'titulo'),
  ('oben',105,'CR','2026-09-18',500,1,100,'titulo'),
  ('oben',108,'CR',NULL,70,1,30,'titulo'),
  ('oben',111,'CR','2026-07-10',80,1,30,'titulo'),
  ('oben',109,'CR','2026-07-11',999,1,31,'titulo'),
  ('oben',110,'CR','2026-07-11',10,1,31,'titulo');
-- Mes MEIO set/2026: vencido 20/09, pago 26/09 (D+6).
INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',301,'K','2026-08-21','2026-09-20',100,0,'RECEBIDO');
INSERT INTO v_titulo_baixas VALUES ('oben',301,'CR','2026-09-26',100,1,36,'titulo');
-- Mes BORDA out/2026: dois titulos vencidos 31/10 — um pago em D+15 exato (15/11), outro em D+16 (16/11).
INSERT INTO fin_contas_receber VALUES
  ('oben',1,'CLI UM',311,'P','2026-10-01','2026-10-31',100,0,'RECEBIDO'),
  ('oben',1,'CLI UM',312,'Q','2026-10-01','2026-10-31',100,0,'RECEBIDO');
INSERT INTO v_titulo_baixas VALUES
  ('oben',311,'CR','2026-11-15',100,1,45,'titulo'),
  ('oben',312,'CR','2026-11-16',100,1,46,'titulo');
-- Mes JOVEM nov/2026 (corrente): vencido 15/11, pago 15/11.
INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',201,'J','2026-10-16','2026-11-15',100,0,'RECEBIDO');
INSERT INTO v_titulo_baixas VALUES ('oben',201,'CR','2026-11-15',100,1,30,'titulo');
-- nov/2025: a janela de 365 d comeca em 16/11/2025 → 401 (venc 20/11) entra, 402 (venc 10/11) fica fora
-- ja na v_ciclo_cr_titulos; a coorte nov/2025 e um RECORTE do mes (mes_parcial).
INSERT INTO fin_contas_receber VALUES
  ('oben',1,'CLI UM',401,'L','2025-10-21','2025-11-20',100,0,'RECEBIDO'),
  ('oben',1,'CLI UM',402,'M','2025-10-11','2025-11-10',100,0,'RECEBIDO');
INSERT INTO v_titulo_baixas VALUES
  ('oben',401,'CR','2025-11-25',100,1,35,'titulo'),
  ('oben',402,'CR','2025-11-15',100,1,35,'titulo');
-- Vencida aberta ANTIGA (oben, jun/2025): entra na v_ciclo_cr_titulos (sem janela la), a coorte corta.
INSERT INTO fin_contas_receber VALUES ('oben',2,'CLI DOIS',403,'N','2025-05-11','2025-06-10',30,30,'ATRASADO');
-- colacor: 1 titulo em jul/2026 (gate 2) + vencida aberta antiga (jan/2024, fora da janela).
INSERT INTO fin_contas_receber VALUES
  ('colacor',3,'CLI TRES',501,'R','2026-06-10','2026-07-10',200,0,'RECEBIDO'),
  ('colacor',3,'CLI TRES',601,'S','2023-12-11','2024-01-10',50,50,'ATRASADO');
INSERT INTO v_titulo_baixas VALUES ('colacor',501,'CR','2026-07-15',200,1,35,'titulo');
SQL
  Pc -f "$MIG_VIEWS"
  Pc -f "$MIG_RPCS"
}

# Sessão simulada sob o relógio: $1 = uuid do usuário ('' = sem claims), $2 = SQL. Roda como authenticated.
sess() {
  {
    echo "BEGIN;"
    echo "SET LOCAL ROLE authenticated;"
    if [ -n "$1" ]; then
      echo "SELECT set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true) AS c \\gset"
    fi
    echo "$2;"
    echo "COMMIT;"
  } | PGOPTIONS="-c test.agora=$AGORA" P -tA
}

falhas=0; asserts=0
# $1 = uuid, $2 = SQL, $3 = esperado, $4 = rótulo. Erro de psql vira valor distinto (nunca mascara).
oks() {
  asserts=$((asserts+1))
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}
# Como postgres, sob o relógio padrão.
okp() { okt "$AGORA" "$1" "$2" "$3"; }
# Como postgres, sob um relógio dado: $1 = test.agora, $2 = SQL, $3 = esperado, $4 = rótulo.
okt() {
  asserts=$((asserts+1))
  local got; got="$(Ler "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}

V="public.v_ciclo_empresa_coorte_maturacao"
RPC="public.fin_ciclo_empresa_coorte_maturacao()"
BARRADO="42501|CICLO_SO_MASTER"

suite() {
  falhas=0; asserts=0
  preparar_banco
  # A migration (ou a sabotagem) TEM de aplicar: erro de SQL nao pode passar por "vermelho".
  Pc -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }

  # Relógio controlado de fato: ler a fonte sem test.agora TEM de disparar o tripwire (senão as bordas abaixo
  # seriam lidas no relógio de parede e a prova nada diria).
  local trip; trip="$(P -tA -c "SELECT count(*) FROM public.v_ciclo_cr_titulos" 2>&1 || true)"
  case "$trip" in *TRIPWIRE*) ;; *) echo "FALHOU: relogio controlado nao amarrou (leu sem test.agora: $trip) |"; falhas=$((falhas+1)) ;; esac

  # Fixture nao pode ser vacua: 15 titulos oben no universo (402 fora pela janela da v_ciclo_cr_titulos; 109/110 fora).
  okp "SELECT count(*) FROM public.v_ciclo_cr_titulos WHERE company='oben'" "15" "fixture: 15 titulos oben no universo"

  # (a) coortes: 5 da oben (nov/25, jul, set, out, nov/26) + 1 colacor; vencidas abertas antigas fora.
  okp "SELECT string_agg(mes_vencimento::text, ',' ORDER BY mes_vencimento) FROM $V WHERE company='oben'" \
    "2025-11-01,2026-07-01,2026-09-01,2026-10-01,2026-11-01" "a janela: 5 coortes oben"
  okp "SELECT count(*) FROM $V WHERE company='colacor'" "1" "a colacor: 1 coorte"

  # (b) mes MADURO jul/2026: universo, massas e maturacao.
  local W="FROM $V WHERE company='oben' AND mes_vencimento = '2026-07-01'"
  okp "SELECT titulos||'|'||valor_vencido_no_mes $W" "9|1800" "b universo: 9 titulos somam 1800 (cancelado e sem cliente fora)"
  okp "SELECT valor_antecipado||'|'||valor_pago_no_dia||'|'||valor_pago_com_atraso $W" "100|80|1400" "b massas: antecipado, no dia, com atraso"
  okp "SELECT valor_pago_sem_data $W" "120" "b massa: pago sem data (sem baixa 50 + baixa sem data 70)"
  okp "SELECT valor_em_aberto $W" "60" "b massa: em aberto = saldo"
  okp "SELECT round(dias_antecipacao_pond, 2)||'|'||round(dias_atraso_pond, 2) $W" "5.00|43.57" "b dias ponderados por valor, cada um na sua massa"
  okp "SELECT maduro_d15||'|'||maduro_d30||'|'||maduro_d60||'|'||mes_parcial $W" "true|true|true|false" "b coorte madura nas 3 janelas e mes inteiro"
  okp "SELECT pct_pago_d15||'|'||pct_pago_d30||'|'||pct_pago_d60 $W" "0.2111|0.3778|0.6000" "b maturacao D+15/30/60 pelo VENCIMENTO"

  # (c) mes JOVEM nov/2026 (corrente): imaturo nas 3 janelas → pct NULL (nunca numero parcial); mes_parcial.
  local J="FROM $V WHERE company='oben' AND mes_vencimento = '2026-11-01'"
  okp "SELECT maduro_d15||'|'||maduro_d30||'|'||maduro_d60||'|'||mes_parcial $J" "false|false|false|true" "c coorte jovem: imatura nas 3 janelas, mes parcial"
  okp "SELECT (pct_pago_d15 IS NULL)||'|'||(pct_pago_d30 IS NULL)||'|'||(pct_pago_d60 IS NULL) $J" "true|true|true" "c coorte jovem: pct_pago_d15 nulo"
  okp "SELECT valor_pago_no_dia||'|'||valor_vencido_no_mes $J" "100|100" "c coorte jovem: massas preenchidas"

  # (d) mes MEIO set/2026: D+15 e D+30 maduros (fim 30/09 + 30 = 30/10 < 16/11), D+60 (29/11) imaturo.
  local M="FROM $V WHERE company='oben' AND mes_vencimento = '2026-09-01'"
  okp "SELECT maduro_d15||'|'||maduro_d30||'|'||maduro_d60||'|'||pct_pago_d15||'|'||pct_pago_d30||'|'||coalesce(pct_pago_d60::text,'null') $M" \
    "true|true|false|1.0000|1.0000|null" "d meio: D+15 e D+30 publicam, D+60 nao"

  # (e) BORDA out/2026 (fim 31/10 + 15 = 15/11): madura em 16/11, imatura em 15/11 — inclusive 23:59:59 de SP.
  #     Pago em D+15 exato conta (<=), em D+16 nao: 100 de 200.
  local B="FROM $V WHERE company='oben' AND mes_vencimento = '2026-10-01'"
  okp "SELECT maduro_d15||'|'||pct_pago_d15||'|'||maduro_d30 $B" "true|0.5000|false" "e borda: D+15 publica em 16/11 e conta so o pago em D+15 exato"
  okt "2026-11-15T15:00:00Z" "SELECT maduro_d15||'|'||coalesce(pct_pago_d15::text,'null') $B" "false|null" "e borda: dia anterior nulo"
  okt "2026-11-16T02:59:59Z" "SELECT maduro_d15||'|'||coalesce(pct_pago_d15::text,'null') $B" "false|null" "e borda: 23:59:59 de SP ainda e 15/11"
  okt "2026-11-16T03:00:00Z" "SELECT maduro_d15||'|'||pct_pago_d15 $B" "true|0.5000" "e borda: 00:00:00 de SP vira 16/11"

  # (f) nov/2025: comeco da janela (16/11/2025) → so o titulo de 20/11; mes_parcial; madura.
  local N="FROM $V WHERE company='oben' AND mes_vencimento = '2025-11-01'"
  okp "SELECT titulos||'|'||mes_parcial||'|'||pct_pago_d15 $N" "1|true|1.0000" "f mes cortado pela janela marcado como parcial"

  # (g) RPC como master = view lida como postgres; ordem estavel.
  oks "$U_MASTER" "SELECT count(*) FROM $RPC" "6" "g master ve as 6 coortes"
  oks "$U_MASTER" "SELECT string_agg(company||':'||mes_vencimento, ',' ORDER BY company, mes_vencimento) FROM $RPC" \
    "$(Ler "$AGORA" "SELECT string_agg(company||':'||mes_vencimento, ',' ORDER BY company, mes_vencimento) FROM $V")" "g RPC = view, ordenada"
  oks "$U_MASTER" "SELECT pct_pago_d60 FROM $RPC WHERE company='oben' AND mes_vencimento = '2026-07-01'" "0.6000" "g RPC traz a maturacao"

  # (h) gate 1: employee e sem claims barrados.
  oks "$U_EMPLOYEE" "SELECT public.t_lanca('SELECT * FROM $RPC')" "$BARRADO" "h employee barrado"
  oks "" "SELECT public.t_lanca('SELECT * FROM $RPC')" "$BARRADO" "h sem claims barrado"

  # (i) gate 2: master sem acesso a colacor so recebe oben.
  oks "$U_MASTER_SO_OBEN" "SELECT count(*) || '|' || string_agg(DISTINCT company, ',') FROM $RPC" "5|oben" "i gate2 so oben"

  # (j) ACL e invoker.
  okp "SELECT has_function_privilege('anon','$RPC','EXECUTE')" "f" "j anon sem EXECUTE"
  okp "SELECT has_function_privilege('authenticated','$RPC','EXECUTE')" "t" "j authenticated com EXECUTE"
  okp "SELECT has_table_privilege('anon','$V','SELECT')" "f" "j anon sem SELECT na view"
  okp "SELECT 'security_invoker=on' = ANY (coalesce(c.reloptions,'{}')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='v_ciclo_empresa_coorte_maturacao'" "t" "j view com security_invoker"
  echo "PASS=$((asserts-falhas)) FAIL=$falhas"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
rc=0; out="$(suite "$TMPD/mig.sql" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "$out"; echo "CONTROLE VERMELHO (rc=$rc) — abortando antes de falsificar"; exit 1; fi
grep -E '^PASS=[0-9]+ FAIL=0$' <<<"$out" || { echo "CONTROLE SEM CONTAGEM"; exit 1; }
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
  "a janela: 5 coortes oben"
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
  "d meio: D+15 e D+30 publicam, D+60 nao"
# Bordas (relógio controlado): maturidade um dia cedo (<= em vez de <) e pagamento em D+N exato excluido.
sabotar "9 maturidade publica um dia cedo (<= em vez de <)" \
  "s/(m.fim_mes + 15 < m.h) AS maduro_d15/(m.fim_mes + 15 <= m.h) AS maduro_d15/; s/CASE WHEN m.fim_mes + 15 < m.h THEN/CASE WHEN m.fim_mes + 15 <= m.h THEN/" \
  "e borda: dia anterior nulo"
sabotar "10 pago em D+15 exato nao conta (< em vez de <=)" \
  "s/AND data_baixa <= data_vencimento + 15/AND data_baixa < data_vencimento + 15/" \
  "e borda: D+15 publica em 16/11 e conta so o pago em D+15 exato"
sabotar "11 mes cortado pela janela sem marca" \
  "s/        OR (m.mes_vencimento = date_trunc('month', m.h - 365)::date AND (m.h - 365) <> date_trunc('month', m.h - 365)::date)) AS mes_parcial/        OR false) AS mes_parcial/" \
  "f mes cortado pela janela marcado como parcial"

# 12) view sem security_invoker: a postcondição aborta; 12b neutraliza a postcondição → asserção (j) vermelha.
sabotar_post "12 view sem security_invoker" \
  "s/WITH (security_invoker=on) AS/AS/" \
  "postcondicao: view sem security_invoker"
sabotar "12b view sem security_invoker, postcondicao neutralizada" \
  "s/WITH (security_invoker=on) AS/AS/; s/IF v_ok IS DISTINCT FROM true THEN/IF false THEN/" \
  "j view com security_invoker"

# 13) RPC sem gate master: idem em 2 camadas (a postcondição lê o corpo da função).
NEUTRA_GATE="s/IF v_def NOT LIKE '%_fin_ciclo_gate_master()%' OR v_def NOT LIKE '%fin_user_can_access(v.company)%' THEN/IF false THEN/"
sabotar_post "13 RPC sem gate master" \
  "/PERFORM public._fin_ciclo_gate_master();/d" \
  "postcondicao: RPC sem gate"
sabotar "13b RPC sem gate master, postcondicao neutralizada" \
  "/PERFORM public._fin_ciclo_gate_master();/d; $NEUTRA_GATE" \
  "h employee barrado"
sabotar "14 RPC sem fin_user_can_access, postcondicao neutralizada" \
  "s/    WHERE public.fin_user_can_access(v.company)//; $NEUTRA_GATE" \
  "i gate2 so oben"

# 15) anon fora do REVOKE da RPC: postcondição aborta; 15b neutralizada → asserção (j) vermelha.
sabotar_post "15 anon fora do REVOKE da RPC" \
  "s/REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC;/" \
  "postcondicao: anon executa"
sabotar "15b anon fora do REVOKE da RPC, postcondicao neutralizada" \
  "s/REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC;/; s/IF has_function_privilege('anon', 'public.fin_ciclo_empresa_coorte_maturacao()', 'EXECUTE') THEN/IF false THEN/" \
  "j anon sem EXECUTE"
sabotar "16 anon fora do REVOKE da view, postcondicao neutralizada" \
  "s/REVOKE ALL ON public.v_ciclo_empresa_coorte_maturacao FROM PUBLIC, anon;/REVOKE ALL ON public.v_ciclo_empresa_coorte_maturacao FROM PUBLIC;/; s/IF has_table_privilege('anon', 'public.v_ciclo_empresa_coorte_maturacao', 'SELECT') THEN/IF false THEN/" \
  "j anon sem SELECT na view"

echo "PROVA-CICLO-COORTE-MATURACAO-OK"
