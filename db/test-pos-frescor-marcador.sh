#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — frescor do marcador do detector de PO excluído (money-path)              ║
# ║  Migration: supabase/migrations/20260814000125_reposicao_pos_frescor_marcador.sql      ║
# ║  Rode: bash db/test-pos-frescor-marcador.sh > /tmp/t.log 2>&1; echo $?                 ║
# ║        (NÃO pipe pra tail — engole o exit code)                                        ║
# ║                                                                                        ║
# ║  IRMÃ de db/test-pos-candidatos-guard-temporal.sh, não substituta: aquele prova o       ║
# ║  GUARD do #1718 contra a migration do #1718. Este prova o que a exposição do frescor    ║
# ║  acrescenta — e, principalmente, o que ela NÃO pode ter mudado.                         ║
# ║                                                                                        ║
# ║  O QUE PROVA                                                                           ║
# ║   C1-C3  contrato: as 21 colunas antigas ficam na MESMA ordem e as 2 novas vão ao FIM  ║
# ║          (a lista "antiga" é LIDA da função pós-#1718, não escrita à mão)               ║
# ║   R1-R4  regressão zero: mesmos candidatos, mesmo marcador, fail-closed intacto        ║
# ║   F1-F4  frescor: o carimbo volta, é o do marcador que gerou a linha, e a idade sai do ║
# ║          relógio do BANCO (apurado_em) — dá para dizer "cego há Xh"                     ║
# ║   M1-M6  a RPC irmã: SEMPRE 1 linha, NULLs sem marcador, e MESMA definição de marcador ║
# ║   N1-N5  o congelamento NÃO é absorvente: marcador novo faz o pedido voltar            ║
# ║   P1-P6  ACL: sem anon/PUBLIC (falha ABERTA), com authenticated E service_role         ║
# ║   D1-D8  authz comportamental nas DUAS: não-staff 42501, master passa, cron passa; e   ║
# ║          D7/D8 o employee GERENCIAL barrado — o único assert que separa os 2 gates     ║
# ║                                                                                        ║
# ║  FALSIFICA (o teste tem de FICAR VERMELHO com a migration sabotada)                     ║
# ║   X1  coluna nova removida        → F1 vermelho (roda a MESMA query do assert)          ║
# ║   X2  as 2 novas trocadas de ordem → pós-condição aborta (valores trocados em silêncio) ║
# ║   X3  coluna nova no MEIO         → pós-condição aborta (deslocaria o cliente)          ║
# ║   X4  REVOKE removido             → pós-condição aborta (DEFAULT ACL devolve anon)      ║
# ║   X5  irmã devolvendo 0 linhas    → M2 vermelho (volta o silêncio que o PR ataca)       ║
# ║   X6  gate da irmã removido       → D4 vermelho (RPC de money-path aberta)              ║
# ║   X6b/c gate da irmã REGRIDE ao velho → D7 vermelho; o customer fica barrado (D4 é cego)║
# ║   X7  corpo VIVO alheio           → pré-condição barra (md5), que as 3 regex não pegam  ║
# ╚════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5481}"
SLUG="pos-frescor-marcador"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_BASE="$REPO_ROOT/supabase/migrations/20260721190000_reposicao_pos_candidatos.sql"
MIG_GUARD="$REPO_ROOT/supabase/migrations/20260813195914_reposicao_pos_candidatos_guard_temporal.sql"
MIG="$REPO_ROOT/supabase/migrations/20260814000125_reposicao_pos_frescor_marcador.sql"
TMP="$(mktemp -d "/tmp/pgtest-${SLUG}-sql.XXXXXX")"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$TMP"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

echo "=== setup (PG17 :$PORT) ==="

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

# ── ZONA 1: schema fiel à PROD (tipos conferidos por psql-ro 14/08) ───────────────────────────
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TABLE public.user_roles       (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $fn$;
-- Gate ANTERIOR ao FU4-G. Corpo FIEL ao de prod (20260526040000): master OU employee com papel
-- comercial gerencial/estrategico/super_admin. Modelá-lo de verdade é o que dá DENTE ao bloco D:
-- até 14/08 este stub era `SELECT has_role(_uid,'master')` — idêntico ao gate NOVO —, e com os dois
-- gates colapsados o harness não conseguia ver a única diferença que importa. O customer (4444) é
-- barrado pelos DOIS, então D4 sozinho não distingue `cap_compras_ler` de `pode_ver_carteira_completa`:
-- uma regressão de gate passaria com 42 OK. O discriminante é o employee GERENCIAL — ver D7/D8 e X6b.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT public.has_role(_uid,'master')
      OR (public.has_role(_uid,'employee')
          AND EXISTS (SELECT 1 FROM public.commercial_roles c
                       WHERE c.user_id = _uid
                         AND c.commercial_role IN ('gerencial','estrategico','super_admin')))
$fn$;
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT COALESCE(public.has_role(_uid,'master'), false) $fn$;

CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  empresa text NOT NULL,
  status text NOT NULL,
  omie_pedido_compra_id text,
  omie_registrado_em timestamptz,
  data_ciclo date NOT NULL,
  fornecedor_nome text,
  canal_usado text,
  portal_protocolo text,
  status_envio_portal text,
  resposta_canal jsonb
);
CREATE TABLE public.pedido_compra_item (pedido_id bigint, sku_codigo_omie text, valor_linha numeric);
CREATE TABLE public.purchase_orders_tracking (
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL
);
CREATE TABLE public.reposicao_pedidos_compra_run (
  run_id uuid PRIMARY KEY, seq bigint NOT NULL UNIQUE,
  empresa public.empresa_reposicao NOT NULL,
  status text NOT NULL DEFAULT 'ok', volume_ok boolean,
  finalizado_em timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.reposicao_po_last_seen (
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  run_id uuid NOT NULL,
  PRIMARY KEY (empresa, omie_codigo_pedido)
);
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),   -- master (staff)
  ('44444444-4444-4444-4444-444444444444'),   -- customer (não-staff)
  ('55555555-5555-5555-5555-555555555555');   -- employee GERENCIAL: passa no gate VELHO, barrado no NOVO
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('55555555-5555-5555-5555-555555555555','employee');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('55555555-5555-5555-5555-555555555555','gerencial');

-- ⚠️ REPRODUZ A PROD: este projeto tem DEFAULT ACL de funções do owner `postgres` concedendo
-- EXECUTE a anon (pg_default_acl, conferido por psql-ro 14/08). Sem isto no banco de teste, a
-- falsificação X4 (REVOKE removido) passaria VERDE por acidente de ambiente — o banco limpo não
-- tem de onde tirar o anon. É a lição do #1483: falsificar em UM ambiente não prova a asserção.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
SQL

# ── ZONA 2: migrations REAIS, na ordem de prod ────────────────────────────────────────────────
P -q -f "$MIG_BASE"
P -q -f "$MIG_GUARD"

# As colunas de saída ANTES desta migration — LIDAS da função real pós-#1718, não escritas à mão.
# Uma lista escrita à mão prova só que eu sei copiar; esta prova que nada deslocou de verdade.
colunas() { Pq -c "SELECT array_to_string((SELECT array_agg(n ORDER BY i) FROM unnest(p.proargnames) WITH ORDINALITY t(n,i) WHERE i > 1), ',') FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname='reposicao_pos_candidatos';"; }
COLS_ANTES="$(colunas)"

P -q -f "$MIG"
echo "migrations aplicadas: base -> guard-temporal -> frescor-marcador"

# ── ZONA 3: seeds RELATIVOS ao relógio ────────────────────────────────────────────────────────
# Datas fixas envelheceriam: um assert de "marcador com 40h" escrito com timestamp de agosto/2026
# vira "marcador com 3.000h" em novembro e o teste passa a medir o calendário em vez do desenho.
# Tudo aqui é ancorado em now(), então o teste é o mesmo em qualquer dia.
#
# Cenário: o run completo PAROU. O último marcador válido fechou há 40h (a cadência real de prod é
# 22,0h — 30 gaps medidos, máx = média = p95 = 22,0h; 40h é um ciclo inteiro perdido).
RID_ATUAL='ffffffff-ffff-ffff-ffff-ffffffffffff'
RID_VELHO='11111111-1111-1111-1111-111111111111'
RID_NOVO='22222222-2222-2222-2222-222222222222'
RID_VOLUME='55555555-5555-5555-5555-555555555555'
RID_ERRO='66666666-6666-6666-6666-666666666666'
P -q <<SQL
INSERT INTO public.reposicao_pedidos_compra_run(run_id,seq,empresa,status,volume_ok,finalizado_em) VALUES
  ('$RID_VELHO',1,'OBEN','ok',true , now() - interval '62 hours'),
  ('$RID_ATUAL',2,'OBEN','ok',true , now() - interval '40 hours'),
  -- ⚠️ DOIS runs com seq MAIOR e INVÁLIDOS, um por cada filtro. Sem eles o M5 seria teatro: com
  -- todos os runs válidos, uma irmã que ignorasse o volume_ok ou o status escolheria
  -- o MESMO marcador e o assert passaria verde afirmando uma equivalência que não testou.
  -- (Sem crase neste comentário: ele vive num heredoc NÃO-citado, onde o shell executaria o
  --  conteúdo entre crases como comando — o shellcheck pegou isso como SC2006/SC2034.)
  -- São também o cenário REAL do P1: o run mais recente falhou, e é por isso que o marcador congela.
  ('$RID_VOLUME',4,'OBEN','ok'  ,false, now() - interval '2 hours'),
  ('$RID_ERRO'  ,5,'OBEN','erro',true , now() - interval '1 hours');

INSERT INTO public.pedido_compra_sugerido
  (id,empresa,status,omie_pedido_compra_id,omie_registrado_em,data_ciclo,fornecedor_nome,canal_usado,portal_protocolo,status_envio_portal) VALUES
  -- 801: nasceu DEPOIS do marcador congelado -> o guard do #1718 o esconde. É O PEDIDO DO P1:
  -- enquanto o marcador não avançar, ele fica invisível INDEFINIDAMENTE.
  (801,'OBEN','disparado','12168090540', now() - interval '20 hours', now()::date - 1,'RENNER SAYERLACK S/A','portal_sayerlack','2120226','sucesso_portal'),
  -- 802: nasceu ANTES do marcador e segue sem carimbo = o sinal VERDADEIRO (PO sumiu mesmo)
  (802,'OBEN','disparado','12160000001', now() - interval '50 hours', now()::date - 2,'RENNER SAYERLACK S/A','portal_sayerlack','2097501','sucesso_portal');

INSERT INTO public.pedido_compra_item(pedido_id,sku_codigo_omie,valor_linha) VALUES
  (801,'X',21621.84),(802,'Y',3060.00);
SQL

# helpers (como service_role/cron: uid NULL passa no gate)
cand() { Pq -c "SELECT coalesce(string_agg(pedido_id::text,',' ORDER BY pedido_id),'') FROM public.reposicao_pos_candidatos('OBEN');"; }
marc() { Pq -c "SELECT count(*)::text FROM public.reposicao_pos_marcador('$1');"; }

echo "== C: contrato da assinatura =="
COLS_DEPOIS="$(colunas)"
eq "C1 as 21 colunas antigas mantêm a ORDEM exata" "${COLS_DEPOIS%,marcador_finalizado_em,apurado_em}" "$COLS_ANTES"
eq "C2 as 2 novas foram acrescentadas no FIM" "${COLS_DEPOIS#"$COLS_ANTES"}" ",marcador_finalizado_em,apurado_em"
eq "C3 a irmã expõe o marcador completo" \
   "$(Pq -c "SELECT pg_get_function_result('public.reposicao_pos_marcador(text)'::regprocedure);")" \
   "TABLE(marcador_run_id uuid, marcador_seq bigint, marcador_finalizado_em timestamp with time zone, apurado_em timestamp with time zone)"

echo "== R: regressão zero (nenhum predicado mudou) =="
eq "R1 o guard do #1718 segue escondendo o PO pós-marcador" "$(cand)" "802"
eq "R2 marcador do seq 2 (o maior VÁLIDO), não o seq 5 (maior de todos)" \
   "$(Pq -c "SELECT marcador_seq FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=802;")" "2"
# `WHERE seq IN (1,2)` e não um UPDATE geral: os runs 4 e 5 precisam continuar inválidos, senão o
# restore os promoveria a válidos e todo o cenário seguinte mudaria em silêncio.
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=false WHERE seq IN (1,2);"
eq "R3 sem marcador válido -> VAZIO (fail-closed intacto)" "$(cand)" ""
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=true WHERE seq IN (1,2);"
eq "R4 restaurado" "$(cand)" "802"

echo "== F: frescor exposto na lista =="
# `f1()` é helper e não query inline PORQUE a falsificação X1 chama EXATAMENTE esta função. Assert e
# falsificação compartilhando a query é o que faz X1 provar "F1 reprova" em vez de apenas "a
# sabotagem entrou" — a diferença que separa falsificação de teatro.
# O `|| true` NAO e frouxidao: sob a sabotagem X1 esta query TEM de falhar (a coluna nao existe), e
# `X=$(f1)` herda o exit status do command substitution -- com `set -e`, isso MATAVA o script no
# inicio da falsificacao, com 34 OK/0 FAIL e exit 1, parecendo sucesso truncado. O assert compara o
# VALOR ("t" ou nao), entao engolir o status aqui e o que permite a falsificacao acontecer.
f1() { Pq -c "SELECT (marcador_finalizado_em IS NOT NULL) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=802;" 2>/dev/null || true; }
eq "F1 a linha carrega o carimbo do marcador" "$(f1)" "t"
eq "F2 o carimbo é o do marcador que GEROU a linha (seq 2, não o 1/4/5)" \
   "$(Pq -c "SELECT (c.marcador_finalizado_em = r.finalizado_em AND c.marcador_run_id = r.run_id) FROM public.reposicao_pos_candidatos('OBEN') c JOIN public.reposicao_pedidos_compra_run r ON r.seq=2 WHERE c.pedido_id=802;")" "t"
# A idade sai da subtração DENTRO do banco: os dois lados no mesmo relógio. 40h semeadas -> a conta
# tem de cair na casa das 40h (janela larga porque o teste leva segundos, não horas).
eq "F3 idade calculável e ~40h (relógio do BANCO nos dois lados)" \
   "$(Pq -c "SELECT (extract(epoch from (apurado_em - marcador_finalizado_em))/3600 BETWEEN 39.9 AND 40.1) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=802;")" "t"
eq "F4 apurado_em é o AGORA do banco, não um valor parado" \
   "$(Pq -c "SELECT (abs(extract(epoch from (now() - apurado_em))) < 5) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=802;")" "t"

echo "== M: a RPC irmã (o caso VAZIO, que é o P1) =="
eq "M1 devolve exatamente 1 linha quando HÁ marcador" "$(marc OBEN)" "1"
# COLACOR não tem run nenhum: é o "detector nunca teve base". ZERO linhas aqui recriaria o silêncio
# dentro da própria correção — o consumidor não distinguiria "não há marcador" de "não voltou".
eq "M2 devolve 1 linha mesmo SEM marcador (não zero!)" "$(marc COLACOR)" "1"
eq "M3 sem marcador, os campos vêm NULL (resposta explícita)" \
   "$(Pq -c "SELECT (marcador_run_id IS NULL AND marcador_seq IS NULL AND marcador_finalizado_em IS NULL) FROM public.reposicao_pos_marcador('COLACOR');")" "t"
eq "M4 mesmo sem marcador, apurado_em vem preenchido (a chamada respondeu)" \
   "$(Pq -c "SELECT (apurado_em IS NOT NULL) FROM public.reposicao_pos_marcador('COLACOR');")" "t"
# O risco de duplicar a definição de marcador é DIVERGIR. Este assert é o que a torna segura — e ele
# só tem dente porque existem os runs 4 (volume_ok=false) e 5 (status='erro') com seq MAIOR: uma
# irmã que esquecesse qualquer um dos dois filtros escolheria outro marcador e cairia aqui.
eq "M5 a irmã e a lista concordam sobre QUAL é o marcador" \
   "$(Pq -c "SELECT (m.marcador_run_id = c.marcador_run_id AND m.marcador_seq = c.marcador_seq AND m.marcador_finalizado_em = c.marcador_finalizado_em) FROM public.reposicao_pos_marcador('OBEN') m, public.reposicao_pos_candidatos('OBEN') c WHERE c.pedido_id=802;")" "t"
eq "M6 a irmã ignora run inválido de seq maior (não pega o 4 nem o 5)" \
   "$(Pq -c "SELECT marcador_seq FROM public.reposicao_pos_marcador('OBEN');")" "2"

echo "== N: o congelamento NÃO é absorvente =="
# Enquanto o marcador não avança, 801 continua invisível — por muitas chamadas que se faça. É o
# comportamento que a UI vai REVELAR (não corrigir): o guard esconde, o frescor denuncia.
eq "N1 marcador parado: 801 segue invisível na 2a chamada" "$(cand)" "802"
eq "N2 marcador parado: 801 segue invisível na 3a chamada" "$(cand)" "802"
P -q -c "INSERT INTO public.reposicao_pedidos_compra_run(run_id,seq,empresa,status,volume_ok,finalizado_em) VALUES ('$RID_NOVO',3,'OBEN','ok',true, now());"
eq "N3 marcador NOVO -> 801 volta a ser candidato (não é estado absorvente)" "$(cand)" "801,802"
eq "N4 e o carimbo acompanha o marcador novo" \
   "$(Pq -c "SELECT (marcador_seq = 3) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=801;")" "t"
eq "N5 a idade despenca junto (o detector voltou a ser fresco)" \
   "$(Pq -c "SELECT (extract(epoch from (apurado_em - marcador_finalizado_em))/3600 < 0.1) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=801;")" "t"
P -q -c "DELETE FROM public.reposicao_pedidos_compra_run WHERE seq=3;"

echo "== P: ACL (a falha ABERTA que o DROP+CREATE pode abrir) =="
acl() { Pq -c "SELECT coalesce(array_to_string(p.proacl,' '),'(NULL=PUBLIC)') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$1';"; }
eq "P1 candidatos: sem anon e sem PUBLIC" \
   "$(printf '%s' "$(acl reposicao_pos_candidatos)" | command grep -cE '(^|[[:space:]])(=|anon=)' || true)" "0"
eq "P2 irmã: sem anon e sem PUBLIC" \
   "$(printf '%s' "$(acl reposicao_pos_marcador)" | command grep -cE '(^|[[:space:]])(=|anon=)' || true)" "0"
eq "P3 candidatos: authenticated mantém EXECUTE" \
   "$(printf '%s' "$(acl reposicao_pos_candidatos)" | command grep -c 'authenticated=' || true)" "1"
eq "P4 irmã: authenticated mantém EXECUTE" \
   "$(printf '%s' "$(acl reposicao_pos_marcador)" | command grep -c 'authenticated=' || true)" "1"
# `service_role` é o caminho de edge/cron. Sem estes dois, perder o grant deixaria migration E suíte
# verdes e quebraria só o lado servidor — em producao, calado.
eq "P5 candidatos: service_role mantém EXECUTE" \
   "$(printf '%s' "$(acl reposicao_pos_candidatos)" | command grep -c 'service_role=' || true)" "1"
eq "P6 irmã: service_role mantém EXECUTE" \
   "$(printf '%s' "$(acl reposicao_pos_marcador)" | command grep -c 'service_role=' || true)" "1"

echo "== D: gate de authz (COMPORTAMENTAL: executa e exige 42501) =="
U_CUSTOMER=44444444-4444-4444-4444-444444444444
U_GERENCIAL=55555555-5555-5555-5555-555555555555
nega() { # $1 = nome da função   $2 = uid que TEM de ser barrado
Pq <<SQL
DO \$t\$
BEGIN
  PERFORM set_config('test.uid','$2',true);
  PERFORM * FROM public.$1('OBEN');
  RAISE EXCEPTION 'VAZOU-NAO-BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'barrou-como-esperado';
  WHEN OTHERS THEN RAISE;          -- Lei #2: qualquer outro erro RE-LANCA
END \$t\$;
SELECT 'barrado';
SQL
}
# tail -1: o psql imprime o 'DO' do bloco anonimo antes do SELECT final.
eq "D1 candidatos: nao-staff barrado com 42501" "$(nega reposicao_pos_candidatos "$U_CUSTOMER" | tail -1)" "barrado"
eq "D2 candidatos: master passa" "$(Pq -c "SELECT set_config('test.uid','33333333-3333-3333-3333-333333333333',true) IS NOT NULL; SELECT count(*)::text FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "1"
eq "D3 candidatos: uid NULL (cron SQL-local) passa" "$(Pq -c "SELECT set_config('test.uid','',true) IS NOT NULL; SELECT count(*)::text FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "1"
eq "D4 irmã: nao-staff barrado com 42501" "$(nega reposicao_pos_marcador "$U_CUSTOMER" | tail -1)" "barrado"
eq "D5 irmã: master passa" "$(Pq -c "SELECT set_config('test.uid','33333333-3333-3333-3333-333333333333',true) IS NOT NULL; SELECT count(*)::text FROM public.reposicao_pos_marcador('OBEN');" | tail -1)" "1"
eq "D6 irmã: uid NULL (cron SQL-local) passa" "$(Pq -c "SELECT set_config('test.uid','',true) IS NOT NULL; SELECT count(*)::text FROM public.reposicao_pos_marcador('OBEN');" | tail -1)" "1"

# D7 é o assert que X6b quebra, e o único do bloco D que distingue os DOIS gates. O gerencial NÃO é
# master: `private.cap_compras_ler` o barra DE PROPÓSITO ("compras não é carteira", COMMENT da
# 20260718190000). D1-D6 usam customer e master, que os dois gates classificam IGUAL — trocar o gate
# novo pelo velho passaria por eles sem um vermelho. Molde: D4 de db/test-pos-candidatos-guard-temporal.sh.
eq "D7 irmã: employee GERENCIAL (nao-master) barrado" "$(nega reposicao_pos_marcador "$U_GERENCIAL" | tail -1)" "barrado"
# CONTRAPROVA — sem ela D7 passaria por VACUIDADE: um uid com seed errado (sem role, ou sem linha em
# commercial_roles) é barrado por QUALQUER gate, e D7 ficaria verde provando nada. Isto exige que as
# duas políticas DIVERGAM exatamente nesta persona: velho deixa ENTRAR (t), novo BARRA (f).
# `boolean::text` devolve 'true'/'false' — o 't'/'f' e so o formato de EXIBICAO do psql, e casar por
# ele deixaria o assert vermelho sem que nada estivesse errado (foi o que aconteceu na 1a rodada).
eq "D8 gerencial DIVERGE entre os 2 gates (velho deixa entrar, novo barra)" \
   "$(Pq -c "SELECT public.pode_ver_carteira_completa('$U_GERENCIAL')::text || '/' || private.cap_compras_ler('$U_GERENCIAL')::text;" | tail -1)" "true/false"

# ══════════════════════════ FALSIFICACAO ══════════════════════════
# Sem isto o teste e teatro: cada assert acima precisa FICAR VERMELHO com a migration sabotada.
echo "== FALSIFICACAO =="

# Arquivo SEM os blocos de pre/pos-condicao: e nele que se sabota o COMPORTAMENTO, para o assert
# falhar por si — e nao porque a pos-condicao abortou o apply.
perl -0777 -pe 's/DO \$pre\$.*?\$pre\$;//s; s/DO \$pos\$.*?\$pos\$;//s' "$MIG" > "$TMP/sem-guardas.sql"
# `[$]` em vez de `\$`: o cifrao aqui e LITERAL, e escapa-lo dentro de aspas simples dispara SC2016
# sem ganhar nada. A classe de um caractere diz a mesma coisa sem ambiguidade.
# (E o comentario acima NAO comeca com a palavra-chave do linter: linha iniciada por "# shell"+"check"
#  vira DIRETIVA e o parser reprova o arquivo inteiro com SC1073. Ja custou uma rodada aqui.)
command grep -q 'DO [$]pos[$]' "$TMP/sem-guardas.sql" && { echo "FALSIFICACAO QUEBRADA: pos-condicao nao foi removida"; exit 2; }

# `restaura`: o `>/dev/null 2>&1` da 1a versao ENGOLIA o erro do restore, e um restore que falha com
# `set -e` mata o script no meio da falsificacao sem dizer por que (foi o que aconteceu: o teste
# morreu antes do X6 e o log so mostrava silencio). Agora o erro aparece e vira FAIL, nao mistério.
# `return 0` SEMPRE: `restaura` e chamado como comando solo, e sob `set -e` um retorno nao-zero
# mataria o script no meio da falsificacao. A falha ja virou FAIL contado — nao precisa tambem
# derrubar a suite e esconder os asserts seguintes.
restaura() {
  # ⚠️ NORMALIZAR ANTES DE RESTAURAR. A pre-condicao do MIG recusa corpo VIVO desconhecido (o pin de
  # md5), e TODA sabotagem que mexe no corpo deixa exatamente isso para tras -- entao rodar o MIG
  # direto falharia na PRE-condicao, nao na pos, e os asserts X2/X3/X4 reportariam o erro errado.
  # Nao e a protecao atrapalhando o teste: e ela tendo dente (o X7 prova). O restore respeita a
  # regra em vez de contorna-la: primeiro repoe o corpo BOM via `sem-guardas.sql` (mesmo corpo do
  # MIG, md5 conhecido), depois aplica o MIG completo, que agora encontra o que espera.
  P -q -c "DROP FUNCTION IF EXISTS public.reposicao_pos_candidatos(text);" >/dev/null 2>&1 || true
  P -q -f "$TMP/sem-guardas.sql" >/dev/null 2>&1 || true
  if ! P -q -f "$MIG" > "$TMP/restore.log" 2>&1; then
    bad "restaura -- reaplicar a migration limpa FALHOU: $(head -c 200 "$TMP/restore.log" | tr '\n' ' ')"
  fi
  return 0
}

# X1: coluna nova REMOVIDA -> F1 tem de reprovar. O assert roda a MESMA `f1()` do bloco F, entao ele
# prova que a assercao anunciada fica vermelha -- e nao apenas que a sabotagem entrou no arquivo.
perl -0777 -pe 's/^\s*marcador_finalizado_em timestamptz,\n//m; s/^\s*b\.marcador_finalizado_em,\n//m; s/^\s*m\.finalizado_em AS marcador_finalizado_em,\n//m' \
  "$TMP/sem-guardas.sql" > "$TMP/x1.sql"
if P -q -f "$TMP/x1.sql" >/dev/null 2>&1; then
  X1="$(f1)"                       # sem a coluna, a query de F1 nem compila -> vazio, nunca "t"
  if [ "$X1" = "t" ]; then bad "X1 coluna removida -> F1 deveria reprovar, mas passou"
  else ok "X1 coluna removida -> F1 reprova (f1 devolveu [$X1], nao [t])"; fi
else
  bad "X1 coluna removida -> o apply sabotado deveria RODAR (sem as guardas) e nao rodou"
fi
restaura

# X2/X3/X4: sabotagens que a POS-CONDICAO tem de barrar. Sentinela = string EXCLUSIVA do ramo certo,
# ASCII, caixa fixa, sem -i (CLAUDE.md: `grep -i` sob pt_BR.UTF-8 dobra acento e casa o ramo errado).
# `command grep`: o `grep` do shell aqui e shim de ugrep.
barra() { # $1=nome  $2=arquivo sabotado  $3=trecho EXATO esperado no erro
  if P -q -f "$2" > "$TMP/out.log" 2>&1; then
    bad "$1 -- o apply sabotado PASSOU (a pos-condicao nao tem dente)"
  elif command grep -q "$3" "$TMP/out.log"; then
    ok "$1"
  else
    bad "$1 -- abortou, mas por outro motivo: $(head -c 200 "$TMP/out.log" | tr '\n' ' ')"
  fi
  restaura
}

# X2: as duas novas TROCADAS entre si. Mesmo tipo (timestamptz) nos dois lados, entao o PG aceita e
# os VALORES trocam em silencio: o cliente leria "apurado_em" como o carimbo do marcador e vice-versa.
# So a assinatura POSICIONAL exata pega isto.
perl -0777 -pe 's/  marcador_finalizado_em timestamptz,\n  apurado_em timestamptz\n/  apurado_em timestamptz,\n  marcador_finalizado_em timestamptz\n/' "$MIG" > "$TMP/x2.sql"
command grep -q '  apurado_em timestamptz,' "$TMP/x2.sql" || { echo "FALSIFICACAO X2 NAO APLICOU"; exit 2; }
barra "X2 colunas trocadas de ordem -> pos-condicao aborta" "$TMP/x2.sql" "assinatura de reposicao_pos_candidatos DIVERGE"

# X3: coluna nova no MEIO (antes de marcador_run_id) -> deslocaria TODAS as posteriores.
perl -0777 -pe 's/  marcador_run_id uuid,\n/  marcador_finalizado_em timestamptz,\n  marcador_run_id uuid,\n/; s/  marcador_seq bigint,\n  -- .*\n  -- .*\n  marcador_finalizado_em timestamptz,\n/  marcador_seq bigint,\n/' "$MIG" > "$TMP/x3.sql"
barra "X3 coluna nova no MEIO -> pos-condicao aborta" "$TMP/x3.sql" "assinatura de reposicao_pos_candidatos DIVERGE"

# X4: REVOKE removido -> o DEFAULT ACL (reproduzido na ZONA 1, como em prod) devolve anon=X e a RPC
# de money-path nasce executavel por ANONIMO. Falha ABERTA: muda autorizacao, nao comportamento.
perl -0777 -pe 's/^REVOKE ALL ON FUNCTION public\.reposicao_pos_candidatos\(text\) FROM PUBLIC, anon;\n//m' "$MIG" > "$TMP/x4.sql"
command grep -q 'REVOKE ALL ON FUNCTION public\.reposicao_pos_candidatos' "$TMP/x4.sql" && { echo "FALSIFICACAO X4 NAO APLICOU"; exit 2; }
# Sentinela ASCII e EXCLUSIVA do ramo certo. A 1a versao usava "executavel por anon/PUBLIC" e
# reprovou: a mensagem real diz "executável", com acento. Casar trecho acentuado aqui e frágil por
# duas razoes somadas (o locale dobra o acento, e o `grep` do shell e shim de ugrep), entao a
# sentinela e o pedaco 100% ASCII da MESMA frase.
barra "X4 REVOKE removido -> pos-condicao aborta (anon executaria)" "$TMP/x4.sql" "o DROP restaurou o DEFAULT ACL"

# X5: a irma devolvendo ZERO linhas sem marcador -> volta o silencio que este PR ataca.
perl -0777 -pe 's/  FROM \(SELECT 1\) AS sempre\n  LEFT JOIN LATERAL \(/  FROM (SELECT 1) AS sempre\n  JOIN LATERAL (/' "$TMP/sem-guardas.sql" > "$TMP/x5.sql"
command grep -q '  JOIN LATERAL (' "$TMP/x5.sql" || { echo "FALSIFICACAO X5 NAO APLICOU"; exit 2; }
if P -q -f "$TMP/x5.sql" >/dev/null 2>&1; then
  eq "X5 irma sem LEFT JOIN -> M2 reprova (volta a 0 linhas)" "$(marc COLACOR)" "0"
else
  bad "X5 -- o apply sabotado nao rodou"
fi
restaura

# X6: gate da irma removido -> D4 reprova (RPC de money-path aberta a qualquer autenticado).
perl -0777 -pe "s/    RAISE EXCEPTION 'reposicao_pos_marcador: acesso negado' USING ERRCODE = '42501';/    NULL;/" "$TMP/sem-guardas.sql" > "$TMP/x6.sql"
command grep -q "reposicao_pos_marcador: acesso negado" "$TMP/x6.sql" && { echo "FALSIFICACAO X6 NAO APLICOU"; exit 2; }
if P -q -f "$TMP/x6.sql" >/dev/null 2>&1; then
  # Mesma armadilha do X1, agravada por `pipefail`: sob a sabotagem o gate NAO barra, o bloco DO
  # levanta 'VAZOU-NAO-BARROU' e o psql sai != 0 -> a atribuicao herda o status e `set -e` mataria
  # o script exatamente no assert que deveria REPROVAR.
  X6=$(nega reposicao_pos_marcador "$U_CUSTOMER" 2>&1 | tail -1 || true)
  if [ "$X6" = "barrado" ]; then bad "X6 gate removido -> D4 deveria reprovar, mas passou"; else ok "X6 gate removido -> D4 reprova (=$(printf '%.40s' "$X6"))"; fi
else
  bad "X6 -- o apply sabotado nao rodou"
fi
restaura

# X6b: o gate da irma REGRIDE para o anterior ao FU4-G (`pode_ver_carteira_completa`) em vez de
# sumir. E a sabotagem que X6 NAO cobre e que D1-D6 NAO pegam: customer e master sao classificados
# IGUAL pelos dois gates, entao a autorizacao cai de master-only para "gerencial tambem ve" e o
# harness inteiro segue verde. So D7 fica vermelho. Analoga ao N2 de test-pos-candidatos-guard-temporal.sh.
# O regex casa o PAR gate+RAISE-DESTA-funcao (o RAISE cita o nome), para nao tocar a irma candidatos.
perl -0777 -pe "s/(AND \(SELECT )private\.cap_compras_ler(\(\(SELECT auth\.uid\(\)\)\)\) IS NOT TRUE THEN\n    RAISE EXCEPTION 'reposicao_pos_marcador)/\${1}public.pode_ver_carteira_completa\${2}/" \
  "$TMP/sem-guardas.sql" > "$TMP/x6b.sql"
command grep -qF "pode_ver_carteira_completa((SELECT auth.uid()" "$TMP/x6b.sql" || { echo "FALSIFICACAO X6b NAO APLICOU"; exit 2; }
# a irma NAO pode ter sido tocada: se o regex vazasse para ela, o vermelho viria da funcao errada.
[ "$(command grep -cF 'private.cap_compras_ler((SELECT auth.uid()' "$TMP/x6b.sql")" = "1" ] \
  || { echo "FALSIFICACAO X6b VAZOU para a irma (ou nao sobrou o gate dela)"; exit 2; }
if P -q -f "$TMP/x6b.sql" >/dev/null 2>&1; then
  # mesma armadilha do X6: sob a sabotagem o gerencial ENTRA, o bloco DO levanta VAZOU-NAO-BARROU e
  # o psql sai != 0 -> sem `|| true` o `set -e` mataria o script no assert que deve REPROVAR.
  X6B=$(nega reposicao_pos_marcador "$U_GERENCIAL" 2>&1 | tail -1 || true)
  if [ "$X6B" = "barrado" ]; then bad "X6b gate velho -> D7 deveria reprovar, mas passou"
  else ok "X6b gate velho -> D7 reprova, o gerencial ENTRA (=$(printf '%.40s' "$X6B"))"; fi
  # E o customer segue barrado pelos DOIS gates — a prova de que D4 e cego a esta regressao, que e
  # a razao de D7 existir. Sem este assert, X6b nao mostraria que a cegueira e da PERSONA.
  eq "X6c sob o gate velho o customer SEGUE barrado (por isso D4 nao pega)" \
     "$(nega reposicao_pos_marcador "$U_CUSTOMER" 2>&1 | tail -1 || true)" "barrado"
else
  bad "X6b -- o apply sabotado nao rodou"
fi
restaura


# X7: a PRE-condicao so aceita dois corpos conhecidos (o do #1718 e o que esta migration escreve).
# Um corpo VIVO diferente = alguem alterou a RPC fora deste repo, e sobrescrever apagaria a mudanca.
# As 3 sentinelas de regex NAO pegariam isto: elas casam gate+guard, que a sabotagem abaixo preserva.
# O DROP e obrigatorio ate para SABOTAR: trocar o RETURNS TABLE nao passa em CREATE OR REPLACE
# (42P13) -- a mesma restricao que obriga a migration a usar DROP+CREATE.
P -q -c "DROP FUNCTION IF EXISTS public.reposicao_pos_candidatos(text);" >/dev/null
P -q -c "CREATE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
RETURNS TABLE(pedido_id bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS \$f\$ BEGIN
  -- corpo alheio que PRESERVA as 3 sentinelas de regex, e por isso passaria por elas:
  --   (SELECT private.cap_compras_ler((SELECT auth.uid())))
  --   AND (p.omie_registrado_em IS NULL OR p.omie_registrado_em <= m.finalizado_em)
  RETURN QUERY SELECT 1::bigint; END \$f\$;" >/dev/null
if P -q -f "$MIG" > "$TMP/x7.log" 2>&1; then
  bad "X7 corpo VIVO alheio -> a pre-condicao deveria BARRAR, mas aplicou por cima"
elif command grep -q "corpo VIVO desconhecido" "$TMP/x7.log"; then
  ok "X7 corpo VIVO alheio -> pre-condicao barra (md5 desconhecido)"
else
  bad "X7 -- abortou por outro motivo: $(head -c 200 "$TMP/x7.log" | tr '\n' ' ')"
fi
# `restaura` ja normaliza o corpo antes de aplicar o MIG (ver a funcao) -- aqui e o mesmo caminho.
restaura
eq "X7b apos restaurar, a RPC volta a funcionar" "$(cand)" "802"

echo
echo "==================== RESULTADO ===================="
echo "  OK: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "  prova COMPLETA (asserts + falsificacao)"
