#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — guard temporal do detector de PO excluído (money-path)                  ║
# ║  Migration: supabase/migrations/20260813195914_reposicao_pos_candidatos_guard_temporal ║
# ║  Rode: bash db/test-pos-candidatos-guard-temporal.sh > /tmp/t.log 2>&1; echo $?        ║
# ║        (NÃO pipe pra tail — engole o exit code)                                        ║
# ║                                                                                        ║
# ║  O QUE PROVA                                                                           ║
# ║   G1  PO registrado DEPOIS do marcador não é candidato  ← o bug de 13/08 (4/4 falsos)  ║
# ║   G2  PO registrado ANTES e não-visto SEGUE candidato   ← o sinal real (caso 281/286)  ║
# ║   G3  omie_registrado_em NULL SEGUE candidato           ← fail-closed do NULL          ║
# ║   G4  registrado EXATAMENTE no finalizado_em segue      ← borda `<=`: dúvida não some  ║
# ║   G5  PO visto no marcador atual não é candidato        ← comportamento antigo intacto ║
# ║   A   sem marcador válido → VAZIO                       ← fail-closed preservado       ║
# ║   D   gate authz: não-staff nega, staff passa, cron passa, GERENCIAL nega (master-only)║
# ║                                                                                        ║
# ║  FALSIFICA (o teste tem de FICAR VERMELHO com a migration sabotada)                     ║
# ║   F1  guard removido            → G1 vermelho    F4  gate FU4-G regredido → apply falha ║
# ║   F2  guard sem o ramo IS NULL  → G3 vermelho    F5  sem private.cap_compras_ler → 42883║
# ║   F3  `<` no lugar de `<=`      → G4 vermelho                                          ║
# ║                                                                                        ║
# ║  CONTROLE ≠ MENÇÃO (2026-08-14) — a POS-CONDICAO da migration é regex sobre             ║
# ║  pg_get_functiondef, e regex prova PRESENÇA, nunca que a chamada GOVERNA o ramo. As 3   ║
# ║  sabotagens abaixo fazem os 3 regexes APROVAREM enquanto o comportamento REGRIDE. Cada  ║
# ║  N prova o PAR (textual APROVA + assert comportamental VERMELHO) — é o par, não a       ║
# ║  metade, que mostra por que a defesa tem de ser executada e não lida:                   ║
# ║   N1 gate em ramo MORTO (IF false AND …)    → D1 vermelho (não-staff ENTRA)             ║
# ║   N2 gate novo só em COMENTÁRIO, velho real → D4 vermelho (gerencial não-master ENTRA)  ║
# ║   N3 guard só em COMENTÁRIO (+ AND TRUE)    → G1 vermelho (volta o alerta falso de 13/08)║
# ║  ⚠️ N2/N3 NÃO derrubam D1 (o handoff supunha que sim): o gate velho também barra um      ║
# ║  customer, e o guard temporal não é authz. Cada sabotagem mira o assert que ELA quebra. ║
# ╚══════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="pos-candidatos-guard-temporal"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_BASE="$REPO_ROOT/supabase/migrations/20260721190000_reposicao_pos_candidatos.sql"
MIG="$REPO_ROOT/supabase/migrations/20260813195914_reposicao_pos_candidatos_guard_temporal.sql"
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
# SEM ON_ERROR_STOP: usado só onde o erro é o DADO medido (veredito do gate sob sabotagem). Com
# ON_ERROR_STOP o psql abortaria e o `set -e` derrubaria o harness antes de o assert decidir nada.
# Sem `"$@"` de propósito: os dois chamadores usam heredoc, e aceitar args daria o SC2120 do shellcheck.
Pv() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA; }

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

# ── ZONA 1: schema fiel à PROD (tipos conferidos por psql-ro 13/08) ───────────────────────────
# `omie_registrado_em` e `finalizado_em` são as duas colunas que o guard novo lê. `empresa` de
# pedido_compra_sugerido é TEXT em prod; as demais usam o ENUM — a RPC compara as duas.
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TABLE public.user_roles       (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $fn$;
-- Gate ANTERIOR (a migration-base 20260721190000 ainda o referencia; a nova o substitui).
-- Corpo FIEL ao de prod (20260526040000, movido p/ private pelo FU7-b): master OU employee com papel
-- comercial gerencial/estrategico/super_admin. É essa diferença de POLÍTICA — e não "barra vs não
-- barra" — que a regressão do gate reintroduz: private.cap_compras_ler é MASTER-ONLY de propósito
-- ("compras não é carteira", COMMENT da 20260718190000). Sem modelar o papel gerencial aqui, N2
-- passaria despercebida: o customer é barrado pelos DOIS gates, então D1 não distingue um do outro.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT public.has_role(_uid,'master')
      OR (public.has_role(_uid,'employee')
          AND EXISTS (SELECT 1 FROM public.commercial_roles c
                       WHERE c.user_id = _uid
                         AND c.commercial_role IN ('gerencial','estrategico','super_admin')))
$fn$;
-- Gate VIVO em prod (FU4-G, #1434): master-only e — o ponto — NUNCA devolve NULL (COALESCE).
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT COALESCE(public.has_role(_uid,'master'), false) $fn$;

CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  empresa text NOT NULL,                       -- TEXT em prod (não enum)
  status text NOT NULL,
  omie_pedido_compra_id text,
  omie_registrado_em timestamptz,              -- nullable em prod -> ramo IS NULL do guard
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

-- Veredito do gate lido de uma TABELA, não do texto do psql: a mensagem de erro do servidor pode
-- ecoar o próprio statement, e aí a sentinela apareceria nos DOIS ramos. Gravar decide sem ambiguidade.
CREATE TABLE public._veredito (v text);
SQL

# ── ZONA 2: migrations REAIS, na ordem de prod (base cria os helpers __po_id/__trim) ──────────
P -q -f "$MIG_BASE"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_BASE") -> $(basename "$MIG")"

# ── ZONA 3: seeds ─────────────────────────────────────────────────────────────────────────────
# Marcador: run seq=2 terminou 13/08 12:17Z (o run REAL de prod). Um run seq=1 anterior existe para
# provar que o fencing continua escolhendo o maior seq.
RID_ATUAL='ffffffff-ffff-ffff-ffff-ffffffffffff'
RID_VELHO='11111111-1111-1111-1111-111111111111'
P -q <<SQL
INSERT INTO public.reposicao_pedidos_compra_run(run_id,seq,empresa,status,volume_ok,finalizado_em) VALUES
  ('$RID_VELHO',1,'OBEN','ok',true ,'2026-08-12 14:17:00+00'),
  ('$RID_ATUAL',2,'OBEN','ok',true ,'2026-08-13 12:17:00+00');

-- Os 5 casos do guard. Todos 'disparado' com PO legível e NUNCA carimbados no marcador atual —
-- ou seja: ANTES do fix, TODOS apareceriam como candidatos.
INSERT INTO public.pedido_compra_sugerido
  (id,empresa,status,omie_pedido_compra_id,omie_registrado_em,data_ciclo,fornecedor_nome,canal_usado,portal_protocolo,status_envio_portal) VALUES
  -- G1: nasceu DEPOIS do marcador (o caso real de 13/08: PO 12168090540, R\$21.621,84)
  (901,'OBEN','disparado','12168090540','2026-08-13 21:15:15+00','2026-08-13','RENNER SAYERLACK S/A','portal_sayerlack','2120226','sucesso_portal'),
  -- G2: nasceu ANTES do marcador e segue sem carimbo = o sinal VERDADEIRO (PO sumiu mesmo)
  (902,'OBEN','disparado','12160000001','2026-08-11 09:00:00+00','2026-08-11','RENNER SAYERLACK S/A','portal_sayerlack','2097501','sucesso_portal'),
  -- G3: sem data de registro -> não dá para provar impossibilidade -> fail-closed
  (903,'OBEN','disparado','12160000002',NULL                    ,'2026-08-11','RENNER SAYERLACK S/A','portal_sayerlack','2097910','sucesso_portal'),
  -- G4: registrado EXATAMENTE no instante do finalizado_em (borda do <=) -> dúvida, segue candidato
  (904,'OBEN','disparado','12160000003','2026-08-13 12:17:00+00','2026-08-13','RENNER SAYERLACK S/A','portal_sayerlack','2120100','sucesso_portal'),
  -- G5: nasceu antes E foi VISTO no marcador atual -> nunca foi candidato
  (905,'OBEN','disparado','12160000004','2026-08-11 10:00:00+00','2026-08-11','RENNER SAYERLACK S/A','portal_sayerlack','2097999','sucesso_portal');

INSERT INTO public.reposicao_po_last_seen(empresa,omie_codigo_pedido,run_id) VALUES
  ('OBEN',12160000004,'$RID_ATUAL');            -- só o G5 carimbado no run atual
SQL

# helper: ids devolvidos pela RPC (como service_role/cron: uid NULL passa no gate)
cand() { Pq -c "SELECT coalesce(string_agg(pedido_id::text,',' ORDER BY pedido_id),'') FROM public.reposicao_pos_candidatos('OBEN');"; }
tem()  { Pq -c "SELECT EXISTS(SELECT 1 FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=$1);"; }

echo "== G: guard temporal =="
eq "G1 PO nascido DEPOIS do marcador nao e candidato" "$(tem 901)" "f"
eq "G2 PO nascido ANTES e nao-visto SEGUE candidato"  "$(tem 902)" "t"
eq "G3 omie_registrado_em NULL SEGUE candidato"       "$(tem 903)" "t"
eq "G4 registrado NO finalizado_em SEGUE candidato"   "$(tem 904)" "t"
eq "G5 PO visto no marcador atual nao e candidato"    "$(tem 905)" "f"
eq "G6 conjunto final exato"                          "$(cand)"    "902,903,904"

echo "== A: fail-closed sem marcador valido =="
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=false;"
eq "A1 sem run valido -> VAZIO" "$(cand)" ""
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=true;"
eq "A2 restaurado" "$(cand)" "902,903,904"

echo "== D: gate de authz =="
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
# tail -1: o psql imprime o 'DO' do bloco anonimo antes do SELECT final.
eq "D1 nao-staff barrado com 42501" "$(printf '%s' "$D_NEGA" | tail -1)" "barrado"
eq "D2 master passa" "$(Pq -c "SELECT set_config('test.uid','33333333-3333-3333-3333-333333333333',true) IS NOT NULL; SELECT count(*)::text FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "3"
eq "D3 uid NULL (cron SQL-local) passa" "$(Pq -c "SELECT set_config('test.uid','',true) IS NOT NULL; SELECT count(*)::text FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "3"

# ── veredito EXECUTADO do gate, para qualquer uid ────────────────────────────────────────────────
# 'BARROU'  = a RPC levantou insufficient_privilege (42501)   → o gate governa o ramo
# 'ENTROU'  = a RPC devolveu linhas                            → o gate NÃO governa (ou não existe)
# 'ERRO'    = qualquer outra falha                             → Lei #2: não engolir, o assert falha
# Nenhuma das 3 palavras aparece no corpo da RPC nem na migration (sentinela ASCII exclusiva).
veredito() { # $1 = uid ('' = cron/service_role)
  Pv <<SQL 2>/dev/null | tail -1
TRUNCATE public._veredito;
DO \$v\$
BEGIN
  PERFORM set_config('test.uid','$1',true);
  PERFORM * FROM public.reposicao_pos_candidatos('OBEN');
  INSERT INTO public._veredito VALUES ('ENTROU');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO public._veredito VALUES ('BARROU');
END \$v\$;
SELECT coalesce((SELECT v FROM public._veredito LIMIT 1),'ERRO');
SQL
}

# D4 é o assert que N2 quebra. O gerencial NÃO é master: private.cap_compras_ler o barra de propósito
# ("compras não é carteira"), enquanto pode_ver_carteira_completa — o gate que o FU4-G aposentou — o
# LIBERA. Sem este assert, uma regressão para o gate antigo passaria por D1/D2/D3 inteira.
eq "D4 employee GERENCIAL (nao-master) barrado" "$(veredito 55555555-5555-5555-5555-555555555555)" "BARROU"
eq "D5 veredito() concorda com D1 no nao-staff"  "$(veredito 44444444-4444-4444-4444-444444444444)" "BARROU"
eq "D6 veredito() concorda com D2 no master"     "$(veredito 33333333-3333-3333-3333-333333333333)" "ENTROU"

# ══════════════════════════ FALSIFICACAO ══════════════════════════
# Sem isto o teste e teatro: cada assert acima precisa FICAR VERMELHO com a migration sabotada.
echo "== FALSIFICACAO =="
# Só o CREATE OR REPLACE (sem os blocos DO de pre/pos-condicao, testados em F4/F5).
awk '/^CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos/,/^\$\$;$/' "$MIG" > "$TMP/fn.sql"
[ -s "$TMP/fn.sql" ] || { echo "FATAL: extracao da funcao falhou"; exit 1; }
GUARD='AND (p.omie_registrado_em IS NULL OR p.omie_registrado_em <= m.finalizado_em)'
grep -qF "$GUARD" "$TMP/fn.sql" || { echo "FATAL: guard nao encontrado no corpo extraido"; exit 1; }

falsifica() { # $1=nome  $2=arquivo sql sabotado  $3=id do pedido  $4=resultado ESPERADO SOB SABOTAGEM
  P -q -f "$2"
  local got; got="$(tem "$3")"
  if [ "$got" = "$4" ]; then ok "$1 (sabotado -> $got, assert teria ficado vermelho)"
  else bad "$1 -- SABOTAGEM NAO MUDOU NADA (veio $got): o assert NAO tem dente"; fi
  P -q -f "$TMP/fn.sql"     # restaura a versao verdadeira
}

# F1: guard REMOVIDO -> volta o bug de 13/08 (901 reaparece)
grep -vF "$GUARD" "$TMP/fn.sql" > "$TMP/f1.sql"
falsifica "F1 guard removido -> G1 reprova" "$TMP/f1.sql" 901 "t"

# F2: guard SEM o ramo IS NULL -> 903 (registro desconhecido) seria suprimido em silencio
sed "s|$GUARD|AND p.omie_registrado_em <= m.finalizado_em|" "$TMP/fn.sql" > "$TMP/f2.sql"
falsifica "F2 guard sem IS NULL -> G3 reprova" "$TMP/f2.sql" 903 "f"

# F3: `<` no lugar de `<=` -> a borda exata (904) sumiria: duvida tratada como impossibilidade
sed 's|omie_registrado_em <= m.finalizado_em|omie_registrado_em < m.finalizado_em|' "$TMP/fn.sql" > "$TMP/f3.sql"
falsifica "F3 < no lugar de <= -> G4 reprova" "$TMP/f3.sql" 904 "f"

# Falsificacoes da POS-CONDICAO: sabotam o arquivo INTEIRO e exigem que o apply ABORTE.
# A sentinela e a mensagem EXATA do ramo certo -- ASCII, caixa fixa, sem -i (CLAUDE.md: `grep -i` sob
# pt_BR.UTF-8 dobra acento e casa o ramo errado). `command grep`: o `grep` do shell aqui e shim de ugrep.
pos_falsifica() { # $1=nome  $2=sql sabotado  $3=trecho ASCII exclusivo da mensagem esperada
  local out
  # ⚠️ capturar ANTES de filtrar: sob `set -o pipefail` o psql que aborta (exit!=0) derruba o pipeline
  # inteiro, e o grep nunca decide nada -- todo ramo caia no else, mascarando um dente que existia.
  out="$(P -f "$2" 2>&1 || true)"
  if printf '%s\n' "$out" | command grep -qF 'guard-temporal:'; then
    if printf '%s\n' "$out" | command grep -qF "$3"; then ok "$1 -> apply abortado com a mensagem certa"
    else bad "$1 -- abortou por OUTRO ramo: $(printf '%s\n' "$out" | command grep -F 'guard-temporal:' | head -1)"; fi
  else
    bad "$1 -- a migration NAO abortou pela pos/pre-condicao: a defesa nao tem dente"
  fi
  P -q -f "$MIG" >/dev/null   # restaura a versao verdadeira (idempotente)
}

# F4: gate FU4-G regredido -> pos-condicao barra. (A 1a versao da pos-condicao usava
# position('cap_compras_ler' in def) e passava VERDE aqui: os COMENTARIOS do corpo citam o nome.
# Este assert e o que exigiu trocar a sentinela por regex de CHAMADA.)
sed 's|private\.cap_compras_ler((SELECT auth.uid()))|public.pode_ver_carteira_completa((SELECT auth.uid()))|' "$MIG" > "$TMP/f4.sql"
pos_falsifica "F4 gate regredido" "$TMP/f4.sql" "gate de authz REGREDIU"

# F6: guard temporal ausente no arquivo inteiro -> pos-condicao barra (o fix nao pode sumir em silencio)
grep -vF "$GUARD" "$MIG" > "$TMP/f6.sql"
pos_falsifica "F6 guard ausente" "$TMP/f6.sql" "guard temporal NAO entrou"

eq "F4b restaurado apos falsificacao" "$(cand)" "902,903,904"

# F5: sem private.cap_compras_ler -> a PRE-CONDICAO barra (banco limpo, so os helpers)
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove_f5
Q() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove_f5 -v ON_ERROR_STOP=1 "$@"; }
Q -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null 2>&1
if Q -q -f "$MIG" >/dev/null 2>&1; then
  bad "F5 sem cap_compras_ler -- a migration APLICOU: a pre-condicao nao tem dente"
else
  F5ERR="$(Q -f "$MIG" 2>&1 | grep -c 'cap_compras_ler(uuid) ausente' || true)"
  if [ "$F5ERR" -ge 1 ]; then ok "F5 sem cap_compras_ler -> pre-condicao barrou com a mensagem certa"
  else bad "F5 barrou, mas NAO pela pre-condicao esperada"; fi
fi

# ════════════ FALSIFICACAO DE CONTROLE — "a chamada GOVERNA o ramo?" (2026-08-14) ════════════
# As F* acima provam que os asserts têm dente contra sabotagem do PREDICADO. As N* provam algo
# diferente e mais incômodo: a POS-CONDICAO da própria migration é regex sobre pg_get_functiondef,
# e regex sobre o TEXTO de uma função prova PRESENÇA — nunca que a chamada presente decide alguma
# coisa. Comentário e ramo morto satisfazem qualquer regex de chamada. Cada N mede o PAR:
#   (a) os 3 regexes da pós-condição APROVAM o corpo sabotado  E
#   (b) o assert COMPORTAMENTAL que aquela sabotagem mira fica VERMELHO.
# Só o par demonstra a tese. Provar (b) sozinho não diria nada sobre o regex; provar (a) sozinho
# não diria que houve dano. É por isso que `par()` exige os dois e reprova se faltar um.
echo "== FALSIFICACAO DE CONTROLE (regex APROVA / comportamento REGRIDE) =="

# Os 3 regexes do bloco DO $pos$ da 20260813195914, VERBATIM. 'APROVA' = a migration teria aplicado.
regex_pos() {
  Pv <<'SQL' | tail -1
SELECT CASE
         WHEN d  ~ 'private\.cap_compras_ler\s*\(\s*\(\s*SELECT'
          AND d !~ 'pode_ver_carteira_completa\s*\(\s*\(\s*SELECT'
          AND d  ~ 'AND \(p\.omie_registrado_em IS NULL OR p\.omie_registrado_em <= m\.finalizado_em\)'
         THEN 'APROVA' ELSE 'REPROVA' END
FROM (SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) AS d) s;
SQL
}
# canário: com a função ÍNTEGRA os 3 regexes têm de aprovar — senão as N* estariam medindo APROVA
# por acidente de outra coisa, e o par não provaria nada.
eq "N0 regex da pos-condicao APROVA a funcao integra" "$(regex_pos)" "APROVA"

sabota() { # $1=destino  $2=expressao sed — sed que não casa nada FALHA o harness
  sed "$2" "$TMP/fn.sql" > "$1"
  if cmp -s "$TMP/fn.sql" "$1"; then echo "FATAL: sabotagem nao casou nada -> $2"; exit 1; fi
}
par() { # $1=nome  $2=medido sob sabotagem  $3=esperado sob sabotagem  $4=veredito dos regexes
  if [ "$2" != "$3" ]; then bad "$1 -- a sabotagem NAO mudou o comportamento (veio [$2], esperado [$3])"
  elif [ "$4" != "APROVA" ]; then bad "$1 -- os regexes REPROVARAM ([$4]): este caso nao demonstra a tese"
  else ok "$1 (regex=APROVA, comportamento=[$2] -> o assert comportamental reprova)"; fi
  P -q -f "$TMP/fn.sql"   # restaura a versao verdadeira
}

# N1 — RAMO MORTO. A chamada do gate continua no corpo, negada, com RAISE EXCEPTION no mesmo IF.
# Tudo o que um regex de chamada procura está lá; o `IF false AND` só garante que nada disso executa.
sabota "$TMP/n1.sql" 's|IF (SELECT auth.uid()) IS NOT NULL|IF false AND (SELECT auth.uid()) IS NOT NULL|'
P -q -f "$TMP/n1.sql"
par "N1 gate em ramo MORTO -> D1/D5 reprovam" "$(veredito 44444444-4444-4444-4444-444444444444)" "ENTROU" "$(regex_pos)"

# N2 — a pior das três: a chamada NOVA vira comentário e o gate REAL volta a ser o aposentado.
# `pode_ver_carteira_completa(auth.uid())` — sem o `((SELECT` — escapa do regex c_velho, e o
# comentário satisfaz o c_novo. Autorização regride de MASTER-ONLY para "gerencial também vê", e
# a pós-condição aplica verde. D1 continua verde aqui: um customer é barrado pelos DOIS gates —
# quem distingue é D4.
sabota "$TMP/n2.sql" 's|AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN|AND /* (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE */ public.pode_ver_carteira_completa(auth.uid()) IS NOT TRUE THEN|'
P -q -f "$TMP/n2.sql"
N2_GERENCIAL="$(veredito 55555555-5555-5555-5555-555555555555)"
N2_CUSTOMER="$(veredito 44444444-4444-4444-4444-444444444444)"
N2_REGEX="$(regex_pos)"
par "N2 gate novo so em COMENTARIO -> D4 reprova" "$N2_GERENCIAL" "ENTROU" "$N2_REGEX"
eq  "N2b customer segue barrado (por isso D1 nao basta)" "$N2_CUSTOMER" "BARROU"

# N3 — o guard temporal só em comentário, com `AND TRUE` no lugar. O c_guard casa a prosa e o alerta
# falso de 13/08 (4 de 4 candidatos) volta inteiro.
sabota "$TMP/n3.sql" 's|AND (p.omie_registrado_em IS NULL OR p.omie_registrado_em <= m.finalizado_em)|/* AND (p.omie_registrado_em IS NULL OR p.omie_registrado_em <= m.finalizado_em) */ AND TRUE|'
P -q -f "$TMP/n3.sql"
par "N3 guard so em COMENTARIO -> G1 reprova" "$(tem 901)" "t" "$(regex_pos)"

eq "N4 restaurado apos as falsificacoes de controle" "$(cand)" "902,903,904"
eq "N5 gate integro volta a barrar o gerencial"      "$(veredito 55555555-5555-5555-5555-555555555555)" "BARROU"

echo
echo "=== RESULTADO: $PASS OK / $FAIL FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
