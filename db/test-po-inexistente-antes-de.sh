#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — carimbo CAUSAL de existência do PO (money-path)                             ║
# ║  Migration: supabase/migrations/20260814022626_reposicao_po_inexistente_antes_de.sql       ║
# ║  Rode: bash db/test-po-inexistente-antes-de.sh > /tmp/t.log 2>&1; echo $?                  ║
# ║        (NÃO pipe pra tail — engole o exit code)                                            ║
# ║                                                                                            ║
# ║  O QUE PROVA                                                                               ║
# ║   C1  a CORRIDA CAUSAL volta a alertar   ← o P1: prova ANTES do run, UPDATE depois         ║
# ║   C2  PO nascido depois do run some      ← o ganho do #1718, preservado                    ║
# ║   C3  limite NULL segue candidato        ← fail-closed do passivo (94 linhas sem valor)    ║
# ║   C4  limite == finalizado_em segue      ← borda `<=`: dúvida não vira supressão           ║
# ║   C5  PO visto no marcador não é cand.   ← comportamento antigo intacto                    ║
# ║   C6  edge ATRASADA não ressuscita       ← omie_registrado_em saiu MESMO do predicado      ║
# ║   T1  limite nunca REGRIDE (GREATEST)    ← reconciliação/retry não desfaz a prova          ║
# ║   T2  limite nunca no FUTURO (clamp)     ← bound de finitude: sem supressão eterna         ║
# ║   T3  UPDATE com NULL não apaga          ← o UPDATE da reconciliação não zera o limite     ║
# ║   R1  o marco AVANÇA na transação        ← clock_timestamp(), não now() (+ controle R1b)   ║
# ║   R2  authenticated não executa o marco   ← fronteira da RPC nova (service_role executa)   ║
# ║   A   sem marcador válido → VAZIO · D  gate authz (nega/staff/cron)                        ║
# ║   I   re-aplicar a migration é no-op     ← idempotência do SQL Editor                      ║
# ║                                                                                            ║
# ║  FALSIFICA (cada defesa tem de FICAR VERMELHA sabotada)                                    ║
# ║   F1 volta a ler omie_registrado_em → C1 reprova   F5 trigger sem clamp    → T2 reprova    ║
# ║   F2 guard sem o ramo IS NULL       → C3 reprova   F6 marco com now()      → R1 reprova    ║
# ║   F3 `<` no lugar de `<=`           → C4 reprova   F7 troca que não troca  → apply aborta  ║
# ║   F4 trigger sem GREATEST           → T1 reprova   F8 corpo vivo estranho  → apply aborta  ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5481}"
SLUG="po-inexistente-antes-de"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_BASE="$REPO_ROOT/supabase/migrations/20260721190000_reposicao_pos_candidatos.sql"
MIG_1718="$REPO_ROOT/supabase/migrations/20260813195914_reposicao_pos_candidatos_guard_temporal.sql"
MIG="$REPO_ROOT/supabase/migrations/20260814022626_reposicao_po_inexistente_antes_de.sql"
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
# TimeZone FIXO: sem isto o `::text` de um timestamptz sai no fuso do HOST (aqui -03), e os asserts que
# comparam o valor da coluna passariam ou falhariam por acidente de ambiente — a mesma classe do
# `grep -i` sob pt_BR.UTF-8 que o CLAUDE.md registra.
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone TO 'UTC';"
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
# A coluna nova NÃO entra aqui de propósito: quem tem de criá-la é a migration sob teste.
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TABLE public.user_roles       (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $fn$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT public.has_role(_uid,'master') $fn$;
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT COALESCE(public.has_role(_uid,'master'), false) $fn$;

CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  empresa text NOT NULL,                       -- TEXT em prod (não enum)
  status text NOT NULL,
  omie_pedido_compra_id text,
  omie_registrado_em timestamptz,              -- o carimbo ANTIGO: segue existindo, sai do predicado
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
  ('44444444-4444-4444-4444-444444444444');   -- customer (não-staff)
INSERT INTO public.user_roles(user_id, role) VALUES ('33333333-3333-3333-3333-333333333333','master');
SQL

# ── ZONA 2: as migrations REAIS, na ordem de prod ─────────────────────────────────────────────
# A nova recria a função por regexp_replace sobre a definição VIVA, então a do #1718 PRECISA ter
# rodado — é exatamente a sequência que o founder vai colar no SQL Editor.
P -q -f "$MIG_BASE"
P -q -f "$MIG_1718"
P -q -f "$MIG"
echo "migrations: base -> 1718 -> $(basename "$MIG")"

# ── ZONA 3: seeds ─────────────────────────────────────────────────────────────────────────────
# Marcador: run seq=2 fechou 13/08 12:17Z (o run REAL de prod). Um run seq=1 anterior prova que o
# fencing segue escolhendo o maior seq.
RID_ATUAL='ffffffff-ffff-ffff-ffff-ffffffffffff'
RID_VELHO='11111111-1111-1111-1111-111111111111'
P -q <<SQL
INSERT INTO public.reposicao_pedidos_compra_run(run_id,seq,empresa,status,volume_ok,finalizado_em) VALUES
  ('$RID_VELHO',1,'OBEN','ok',true ,'2026-08-12 14:17:00+00'),
  ('$RID_ATUAL',2,'OBEN','ok',true ,'2026-08-13 12:17:00+00');

-- Todos 'disparado', com PO legível e SEM carimbo no marcador atual (exceto o 905).
INSERT INTO public.pedido_compra_sugerido
  (id,empresa,status,omie_pedido_compra_id,omie_registrado_em,omie_po_inexistente_antes_de,data_ciclo,fornecedor_nome,canal_usado,portal_protocolo,status_envio_portal) VALUES
  -- C1 A CORRIDA CAUSAL. O PO existia e foi EXCLUÍDO; o run varreu, não achou, e fechou 12:17:00.
  --    A edge só terminou de gravar 12:17:03 (transporte/retry) — omie_registrado_em POSTERIOR ao
  --    marcador. Mas a prova de existência foi RESERVADA às 12:16:55, ANTES do run fechar: o run
  --    PODIA ter visto este PO, logo o silêncio dele É evidência. Tem de seguir candidato.
  --    Com o guard do #1718 (omie_registrado_em) este alerta VERDADEIRO era suprimido.
  (901,'OBEN','disparado','12160000901','2026-08-13 12:17:03+00','2026-08-13 12:16:55+00','2026-08-13','RENNER SAYERLACK S/A','portal_sayerlack','2120901','sucesso_portal'),
  -- C2 nasceu DEPOIS do marcador (caso real de 13/08, PO 12168090540): o run não testemunha nada.
  (902,'OBEN','disparado','12168090540','2026-08-13 21:15:18+00','2026-08-13 21:15:15+00','2026-08-13','RENNER SAYERLACK S/A','portal_sayerlack','2120226','sucesso_portal'),
  -- C3 sem limite causal (o passivo das 94 linhas) -> fail-closed
  (903,'OBEN','disparado','12160000903','2026-08-11 09:00:00+00',NULL                    ,'2026-08-11','RENNER SAYERLACK S/A','portal_sayerlack','2097910','sucesso_portal'),
  -- C4 limite EXATAMENTE no finalizado_em (borda do <=) -> dúvida, segue candidato
  (904,'OBEN','disparado','12160000904','2026-08-13 12:20:00+00','2026-08-13 12:17:00+00','2026-08-13','RENNER SAYERLACK S/A','portal_sayerlack','2120100','sucesso_portal'),
  -- C5 nasceu antes E foi VISTO no marcador atual -> nunca foi candidato
  (905,'OBEN','disparado','12160000905','2026-08-11 10:00:00+00','2026-08-11 09:59:00+00','2026-08-11','RENNER SAYERLACK S/A','portal_sayerlack','2097999','sucesso_portal'),
  -- C6 EDGE ATRASADA: relógio da edge 3 dias no passado (omie_registrado_em ANTES do marcador), mas o
  --    limite causal do BANCO é depois. Com o guard antigo isto virava candidato falso; agora não é.
  (906,'OBEN','disparado','12160000906','2026-08-10 08:00:00+00','2026-08-13 18:00:00+00','2026-08-13','RENNER SAYERLACK S/A','portal_sayerlack','2120906','sucesso_portal'),
  -- T2 usa um pedido DEDICADO: o clamp empurra o limite para o "agora" (14/08+), que é DEPOIS do
  --    marcador, então o pedido sai da lista de candidatos — e o trigger é monotônico, ou seja, esse
  --    efeito é IRREVERSÍVEL. Reaproveitar um dos pedidos acima envenenaria os asserts seguintes
  --    (foi o que aconteceu na 1ª rodada: D2/D3 e I2 caíram por efeito colateral, não por defeito).
  (907,'OBEN','disparado','12160000907','2026-08-11 08:00:00+00','2026-08-11 07:59:00+00','2026-08-11','RENNER SAYERLACK S/A','portal_sayerlack','2120907','sucesso_portal');

INSERT INTO public.reposicao_po_last_seen(empresa,omie_codigo_pedido,run_id) VALUES
  ('OBEN',12160000905,'$RID_ATUAL');            -- só o C5 carimbado no run atual
SQL

cand() { Pq -c "SELECT coalesce(string_agg(pedido_id::text,',' ORDER BY pedido_id),'') FROM public.reposicao_pos_candidatos('OBEN');"; }
tem()  { Pq -c "SELECT EXISTS(SELECT 1 FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=$1);"; }
lb()   { Pq -c "SELECT coalesce(omie_po_inexistente_antes_de::text,'NULL') FROM public.pedido_compra_sugerido WHERE id=$1;"; }

echo "== C: o guard passa a ler o limite CAUSAL =="
eq "C1 corrida causal (UPDATE tardio) SEGUE candidato" "$(tem 901)" "t"
eq "C2 PO nascido depois do run nao e candidato"       "$(tem 902)" "f"
eq "C3 limite NULL SEGUE candidato"                    "$(tem 903)" "t"
eq "C4 limite NO finalizado_em SEGUE candidato"        "$(tem 904)" "t"
eq "C5 PO visto no marcador atual nao e candidato"     "$(tem 905)" "f"
eq "C6 edge ATRASADA nao ressuscita candidato"         "$(tem 906)" "f"
eq "C7 o pedido do clamp comeca candidato"             "$(tem 907)" "t"

echo "== T: a invariante da coluna (trigger) =="
# T1: o valor NÃO regride. É o que garante que um retry/reconciliação tardio não desfaça a prova.
P -q -c "UPDATE public.pedido_compra_sugerido SET omie_po_inexistente_antes_de='2026-08-01 00:00:00+00' WHERE id=901;"
eq "T1 limite nao REGRIDE (GREATEST)" "$(lb 901)" "2026-08-13 12:16:55+00"
# T3: UPDATE mandando NULL não apaga o limite (o UPDATE da reconciliação não carrega a coluna, mas um
# writer futuro pode mandar NULL explícito — GREATEST ignora NULL).
P -q -c "UPDATE public.pedido_compra_sugerido SET omie_po_inexistente_antes_de=NULL WHERE id=901;"
eq "T3 UPDATE com NULL nao apaga o limite" "$(lb 901)" "2026-08-13 12:16:55+00"
eq "T1b e o pedido segue candidato depois dos dois UPDATEs" "$(tem 901)" "t"
# T2: futuro é CLAMPADO. Sem isto um carimbo em 2999 suprimiria o pedido para sempre — finalizado_em
# nunca o alcança (bound de finitude, money-path.md §2). Note que o clamp NÃO devolve o pedido ao card:
# ele só troca "suprimido para sempre" por "suprimido até o próximo run" — que é o teto que faltava.
P -q -c "UPDATE public.pedido_compra_sugerido SET omie_po_inexistente_antes_de='2999-01-01 00:00:00+00' WHERE id=907;"
eq "T2 limite no FUTURO e clampado para <= agora" \
   "$(Pq -c "SELECT (omie_po_inexistente_antes_de <= clock_timestamp()) AND (omie_po_inexistente_antes_de < '2100-01-01+00') FROM public.pedido_compra_sugerido WHERE id=907;")" "t"
# INSERT também passa pelo clamp (o trigger é BEFORE INSERT OR UPDATE).
P -q -c "INSERT INTO public.pedido_compra_sugerido(id,empresa,status,data_ciclo,omie_po_inexistente_antes_de) VALUES (999,'OBEN','rascunho','2026-08-13','2999-01-01 00:00:00+00');"
eq "T2b INSERT no futuro tambem e clampado" \
   "$(Pq -c "SELECT omie_po_inexistente_antes_de <= clock_timestamp() FROM public.pedido_compra_sugerido WHERE id=999;")" "t"
# T2c O QUE O CLAMP DE FATO COMPRA. Clampado para o "agora", o 907 continua suprimido — o marcador é de
# 13/08. O ganho não é "volta ao card já"; é que a supressão passa a ter TETO: o PRÓXIMO run completo
# alcança o limite e o pedido reaparece. Com '2999' ele nunca reapareceria, e é essa a diferença entre
# um guard e um buraco (money-path.md §2, bound de finitude).
eq "T2c clampado, segue suprimido sob o marcador VELHO" "$(tem 907)" "f"
P -q -c "INSERT INTO public.reposicao_pedidos_compra_run(run_id,seq,empresa,status,volume_ok,finalizado_em) VALUES ('22222222-2222-2222-2222-222222222222',3,'OBEN','ok',true,clock_timestamp());"
eq "T2c2 e VOLTA ao card no run seguinte (a supressao tem teto)" "$(tem 907)" "t"
P -q -c "DELETE FROM public.reposicao_pedidos_compra_run WHERE seq=3;"
eq "T2c3 marcador restaurado" "$(tem 907)" "f"

echo "== R: o marco vem do relogio do BANCO =="
# R1: dentro da MESMA transação o marco AVANÇA — é o que separa clock_timestamp() de now(), e now()
# devolveria o instante do BEGIN (a espera entre BEGIN e leitura é arbitrária).
# ⚠️ `booleano()`, e NÃO `tail -1`: o psql imprime o status de CADA comando (BEGIN/COMMIT/SET/RESET) na
# mesma saída, e a ÚLTIMA linha é "COMMIT", não o resultado. `tail -1` comparava "COMMIT" com "t" e
# reprovava 4 asserts que estavam certos — assert que lê a linha errada mente nas duas direções.
booleano() { command grep -E '^[tf]$' | tail -1; }
eq "R1 o marco AVANCA dentro da transacao (clock, nao now)" "$(Pq <<'SQL' | booleano
BEGIN;
SELECT set_config('test.m1', public.reposicao_marco_pre_omie()::text, true);
SELECT pg_sleep(0.05);
SELECT public.reposicao_marco_pre_omie() > current_setting('test.m1')::timestamptz;
COMMIT;
SQL
)" "t"
# Controle NEGATIVO do R1: se o assert acima passasse também com now(), ele não estaria medindo nada.
eq "R1b controle: now() NAO avanca na mesma transacao" "$(Pq <<'SQL' | booleano
BEGIN;
SELECT set_config('test.n1', now()::text, true);
SELECT pg_sleep(0.05);
SELECT now() > current_setting('test.n1')::timestamptz;
COMMIT;
SQL
)" "f"
# R2: a fronteira da RPC nova. service_role executa; authenticated, não.
R2=$(Pq <<'SQL'
SET ROLE authenticated;
DO $t$
BEGIN
  PERFORM public.reposicao_marco_pre_omie();
  RAISE EXCEPTION 'VAZOU-AUTHENTICATED-EXECUTOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'barrou-como-esperado';
  WHEN OTHERS THEN RAISE;          -- Lei #2: qualquer outro erro RE-LANCA
END $t$;
RESET ROLE;
SELECT 'barrado';
SQL
)
eq "R2 authenticated nao executa o marco" "$(printf '%s' "$R2" | tail -1)" "barrado"
eq "R2b service_role executa o marco" \
   "$(Pq -c "SET ROLE service_role; SELECT public.reposicao_marco_pre_omie() IS NOT NULL; RESET ROLE;" | booleano)" "t"

echo "== A: fail-closed sem marcador valido =="
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=false;"
eq "A1 sem run valido -> VAZIO" "$(cand)" ""
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=true;"

echo "== D: gate de authz (preservado do #1718) =="
D_NEGA=$(Pq <<'SQL'
DO $t$
BEGIN
  PERFORM set_config('test.uid','44444444-4444-4444-4444-444444444444',true);
  PERFORM * FROM public.reposicao_pos_candidatos('OBEN');
  RAISE EXCEPTION 'VAZOU-NAO-BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'barrou-como-esperado';
  WHEN OTHERS THEN RAISE;          -- Lei #2: qualquer outro erro RE-LANCA
END $t$;
SELECT 'barrado';
SQL
)
eq "D1 nao-staff barrado com 42501" "$(printf '%s' "$D_NEGA" | tail -1)" "barrado"
eq "D2 master passa" "$(Pq -c "SELECT set_config('test.uid','33333333-3333-3333-3333-333333333333',true) IS NOT NULL; SELECT count(*)::text FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "3"
eq "D3 uid NULL (cron SQL-local) passa" "$(Pq -c "SELECT set_config('test.uid','',true) IS NOT NULL; SELECT count(*)::text FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "3"

echo "== I: idempotencia (o founder pode re-colar no SQL Editor) =="
if P -q -f "$MIG" >/dev/null 2>&1; then ok "I1 re-aplicar a migration nao falha"
else bad "I1 re-aplicar a migration ABORTOU -- o SQL Editor nao perdoa colar duas vezes"; fi
eq "I2 e o comportamento nao mudou depois do re-apply" "$(tem 901)$(tem 902)$(tem 903)" "tft"

# ══════════════════════════ FALSIFICACAO ══════════════════════════
# Sem isto o teste e teatro: cada assert precisa FICAR VERMELHO com a defesa sabotada.
echo "== FALSIFICACAO =="
# O corpo VIVO (já com o guard causal) é a base das sabotagens do predicado.
Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);" > "$TMP/fn.sql"
[ -s "$TMP/fn.sql" ] || { echo "FATAL: extracao da funcao viva falhou"; exit 1; }
GUARD='AND (p.omie_po_inexistente_antes_de IS NULL OR p.omie_po_inexistente_antes_de <= m.finalizado_em)'
command grep -qF "$GUARD" "$TMP/fn.sql" || { echo "FATAL: guard causal nao encontrado no corpo vivo"; exit 1; }

falsifica() { # $1=nome  $2=sql sabotado  $3=id  $4=resultado ESPERADO SOB SABOTAGEM
  P -q -f "$2"
  local got; got="$(tem "$3")"
  if [ "$got" = "$4" ]; then ok "$1 (sabotado -> $got, o assert teria ficado vermelho)"
  else bad "$1 -- SABOTAGEM NAO MUDOU NADA (veio $got): o assert NAO tem dente"; fi
  P -q -f "$TMP/fn.sql"     # restaura a versao verdadeira
}

# F1: volta a comparar o carimbo da EDGE -> a corrida causal (901) some. É o P1 inteiro num assert.
sed "s|$GUARD|AND (p.omie_registrado_em IS NULL OR p.omie_registrado_em <= m.finalizado_em)|" "$TMP/fn.sql" > "$TMP/f1.sql"
falsifica "F1 volta a ler omie_registrado_em -> C1 reprova" "$TMP/f1.sql" 901 "f"

# F2: guard SEM o ramo IS NULL -> o passivo (903) seria suprimido em SILENCIO (comparacao com NULL)
sed "s|$GUARD|AND p.omie_po_inexistente_antes_de <= m.finalizado_em|" "$TMP/fn.sql" > "$TMP/f2.sql"
falsifica "F2 guard sem IS NULL -> C3 reprova" "$TMP/f2.sql" 903 "f"

# F3: `<` no lugar de `<=` -> a borda exata (904) sumiria: duvida tratada como impossibilidade
sed 's|omie_po_inexistente_antes_de <= m.finalizado_em|omie_po_inexistente_antes_de < m.finalizado_em|' "$TMP/fn.sql" > "$TMP/f3.sql"
falsifica "F3 < no lugar de <= -> C4 reprova" "$TMP/f3.sql" 904 "f"

# F4/F5: sabotar o TRIGGER. Mede o VALOR da coluna, não a lista de candidatos.
# Usa o pedido 999 (status 'rascunho', fora do card): sabotagem de trigger é IRREVERSÍVEL no dado, e
# envenenar um pedido do card faria os asserts seguintes caírem por efeito colateral.
trig_falsifica() { # $1=nome  $2=corpo do trigger sabotado  $3=sql que exercita  $4=expr  $5=esperado SOB SABOTAGEM
  P -q -c "$2"
  P -q -c "$3"
  local got; got="$(Pq -c "$4")"
  if [ "$got" = "$5" ]; then ok "$1 (sabotado -> $got, o assert teria ficado vermelho)"
  else bad "$1 -- SABOTAGEM NAO MUDOU NADA (veio $got): o assert NAO tem dente"; fi
  P -q -f "$MIG" >/dev/null   # restaura (idempotente)
}

# F4: trigger sem GREATEST -> o limite REGRIDE, e uma escrita tardia desfaz a prova conquistada.
P -q -c "UPDATE public.pedido_compra_sugerido SET omie_po_inexistente_antes_de='2026-08-13 12:00:00+00' WHERE id=999;"
trig_falsifica "F4 trigger sem GREATEST -> T1 reprova" \
  "CREATE OR REPLACE FUNCTION public.reposicao__po_inexistente_antes_guard() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$;" \
  "UPDATE public.pedido_compra_sugerido SET omie_po_inexistente_antes_de='2026-08-01 00:00:00+00' WHERE id=999;" \
  "SELECT omie_po_inexistente_antes_de::text FROM public.pedido_compra_sugerido WHERE id=999;" \
  "2026-08-01 00:00:00+00"

# F5: trigger sem o clamp -> o carimbo em 2999 GRAVA, e aí o pedido fica suprimido para sempre.
trig_falsifica "F5 trigger sem clamp -> T2 reprova" \
  "CREATE OR REPLACE FUNCTION public.reposicao__po_inexistente_antes_guard() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN IF TG_OP='UPDATE' THEN NEW.omie_po_inexistente_antes_de := GREATEST(OLD.omie_po_inexistente_antes_de, NEW.omie_po_inexistente_antes_de); END IF; RETURN NEW; END \$f\$;" \
  "UPDATE public.pedido_compra_sugerido SET omie_po_inexistente_antes_de='2999-01-01 00:00:00+00' WHERE id=999;" \
  "SELECT omie_po_inexistente_antes_de > clock_timestamp() FROM public.pedido_compra_sugerido WHERE id=999;" \
  "t"

# F6: o marco com now() -> deixa de avancar dentro da transacao (exatamente o que R1 mede)
P -q -c "CREATE OR REPLACE FUNCTION public.reposicao_marco_pre_omie() RETURNS timestamptz LANGUAGE sql VOLATILE AS \$f\$ SELECT now() \$f\$;"
F6=$(Pq <<'SQL' | booleano
BEGIN;
SELECT set_config('test.m1', public.reposicao_marco_pre_omie()::text, true);
SELECT pg_sleep(0.05);
SELECT public.reposicao_marco_pre_omie() > current_setting('test.m1')::timestamptz;
COMMIT;
SQL
)
if [ "$F6" = "f" ]; then ok "F6 marco com now() -> R1 reprova (sabotado -> f)"
else bad "F6 -- now() ainda avancou ($F6): o assert R1 NAO tem dente"; fi
P -q -f "$MIG" >/dev/null

# F7/F8: falsificacao da PRE/POS-CONDICAO — sabotam o ARQUIVO e exigem que o apply ABORTE.
# ⚠️ Sentinela ASCII, caixa fixa, sem -i: sob pt_BR.UTF-8 o `grep -i` dobra acento e casa o ramo errado
# (CLAUDE.md, #1483) — por isso as sentinelas abaixo evitam as palavras acentuadas das mensagens.
# `command grep`: o `grep` do shell aqui e shim de ugrep.
pos_falsifica() { # $1=nome  $2=sql sabotado  $3=trecho ASCII exclusivo da mensagem esperada
  local out rc=0
  # ⚠️ capturar ANTES de filtrar: sob `set -o pipefail` o psql que aborta derruba o pipeline inteiro e o
  # grep nunca decide nada -- todo ramo cairia no else, mascarando um dente que existia.
  out="$(P -f "$2" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    # NOTICE tambem carrega o prefixo da migration: so o exit!=0 distingue ABORTO de aviso.
    bad "$1 -- a migration APLICOU (exit 0): a defesa nao tem dente"
  elif printf '%s\n' "$out" | command grep -qF "$3"; then
    ok "$1 -> apply abortado com a mensagem certa"
  else
    bad "$1 -- abortou por OUTRO ramo: $(printf '%s\n' "$out" | command grep -F 'ERROR:' | head -1)"
  fi
}

# F7: a "troca" que nao troca (recria a funcao sem aplicar o replace) -> a POS-condicao barra.
# Prova que a pos-condicao mede a definicao FINAL, e nao a INTENCAO da migration.
# Precisa partir do corpo do #1718 (guard antigo vivo), senao o ramo idempotente assume e nada acontece.
sed 's|EXECUTE replace(v_def, c_alvo, c_troca);|EXECUTE v_def;|' "$MIG" > "$TMP/f7.sql"
command grep -qF 'EXECUTE v_def;' "$TMP/f7.sql" || { echo "FATAL: sabotagem F7 nao casou o alvo"; exit 1; }
P -q -f "$MIG_1718" >/dev/null
pos_falsifica "F7 troca que nao troca" "$TMP/f7.sql" "guard CAUSAL NAO entrou"
P -q -f "$MIG" >/dev/null            # restaura: com o corpo do #1718 vivo, a troca acontece de verdade

# F8: corpo vivo INESPERADO (nem o guard do #1718, nem o causal) -> a pre-condicao do replace barra em
# vez de sobrescrever as cegas uma funcao que outra migration reescreveu.
# ⚠️ via ARQUIVO, nunca `-c "$(...)"`: o corpo contem `$function$` e o shell o expandiria como variavel.
sed 's|AND (p.omie_po_inexistente_antes_de IS NULL OR p.omie_po_inexistente_antes_de <= m.finalizado_em)|AND true|' "$TMP/fn.sql" > "$TMP/f8-base.sql"
command grep -qF 'AND true' "$TMP/f8-base.sql" || { echo "FATAL: sabotagem F8 nao casou o alvo"; exit 1; }
P -q -f "$TMP/f8-base.sql" >/dev/null
pos_falsifica "F8 corpo vivo estranho" "$MIG" "esperava 1 ocorr"
P -q -f "$TMP/fn.sql" >/dev/null      # devolve o corpo causal correto

eq "Z1 tudo restaurado apos a falsificacao" "$(tem 901)$(tem 902)$(tem 903)$(tem 904)$(tem 905)$(tem 906)" "tfttff"
eq "Z2 e a migration segue aplicavel sobre o estado restaurado" "$(P -q -f "$MIG" >/dev/null 2>&1 && echo ok)" "ok"

echo
echo "=== RESULTADO: $PASS OK / $FAIL FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
