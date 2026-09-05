#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260905090000_sayerlack_custo_portal_cas.sql                     ║
# ║  RPC sayerlack_aplicar_custo_portal: CAS (omie IS NULL + sucesso_portal) no     ║
# ║  próprio UPDATE, itens tudo-ou-nada (ROW_COUNT == n ⇒ senão CP004 + ROLLBACK),  ║
# ║  guards de finitude (CP001), EXECUTE só de service_role, corrida com o PO Omie.  ║
# ║  Rode: bash db/test-sayerlack-custo-portal-cas.sh > /tmp/t.log 2>&1; echo $?    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="sayerlack-custo-cas"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migration LÊ/ALTERA mas não cria) — stub mínimo, colunas de prod
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  omie_pedido_compra_numero text,
  status_envio_portal text NOT NULL DEFAULT 'nao_aplicavel',
  valor_total numeric DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public.pedido_compra_item (
  id bigint PRIMARY KEY,
  pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  preco_unitario numeric,
  valor_linha numeric
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260905090000_sayerlack_custo_portal_cas.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (re-semeável: cada bloco de assert parte do MESMO estado)
# ══════════════════════════════════════════════════════════════════════════════
# 100 = elegível (omie NULL, sucesso_portal), 3 itens com custo antigo 10/20/30.
# 200 = já tem PO Omie.   300 = ainda enviando_portal.   400 = outro pedido elegível (dono do item 401).
seed() {
P -q <<'SQL'
TRUNCATE public.pedido_compra_item, public.pedido_compra_sugerido;
INSERT INTO public.pedido_compra_sugerido (id, omie_pedido_compra_numero, status_envio_portal, valor_total) VALUES
  (100, NULL,   'sucesso_portal',   0),
  (200, '7788', 'sucesso_portal',   0),
  (300, NULL,   'enviando_portal',  0),
  (400, NULL,   'sucesso_portal',   0);
INSERT INTO public.pedido_compra_item (id, pedido_id, preco_unitario, valor_linha) VALUES
  (101, 100, 10, 100), (102, 100, 20, 200), (103, 100, 30, 300),
  (201, 200, 10, 100),
  (301, 300, 10, 100),
  (401, 400, 10, 100);
SQL
}
seed
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
-- 2222… é customer (não-staff) — o gate de papel deve barrar quando o uid vem preenchido.
INSERT INTO public.user_roles (user_id, role) VALUES ('22222222-2222-2222-2222-222222222222', 'customer');
SQL

# Chama a RPC e devolve UMA sentinela: RPC_OK_<n> ou RPC_ERR_<SQLSTATE real>.
# A sentinela é MINHA (não é texto que o código emite) e carrega a SQLSTATE exata — qualquer erro
# diferente do esperado vira string diferente e o `eq` fica vermelho (Lei #2: casa a MARCA, não "lançou algo").
rpc() { # $1 = argumentos SQL da chamada · $2 = preâmbulo opcional (SET ROLE / GUC)
  P -tA 2>&1 <<SQL | grep -o 'RPC_[A-Z]*_[A-Za-z0-9]*' | head -1
${2:-}
DO \$\$ DECLARE n int; BEGIN
  n := public.sayerlack_aplicar_custo_portal($1);
  RAISE NOTICE 'RPC_OK_%', n;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RPC_ERR_%', SQLSTATE; END \$\$;
SQL
}
# Estado observável de um pedido: "preco/valor dos itens|valor_total" (comparar antes/depois).
estado() { Pq -c "SELECT string_agg(i.id||':'||i.preco_unitario||'/'||i.valor_linha, ',' ORDER BY i.id)||'|'||p.valor_total FROM public.pedido_compra_sugerido p JOIN public.pedido_compra_item i ON i.pedido_id=p.id WHERE p.id=$1 GROUP BY p.valor_total;"; }
ITENS_100='[{"item_id":101,"preco_unitario":12.5,"valor_linha":125},{"item_id":102,"preco_unitario":22.25,"valor_linha":222.5}]'
INTACTO_100='101:10/100,102:20/200,103:30/300|0'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
# A1 caminho feliz: 2 dos 3 itens no array (o 3º é 'sem_mudanca') → retorna 2, grava os 2, total provado; o 3º intacto.
seed
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5"); eq "A1 elegível: retorna o nº de itens gravados" "$R" "RPC_OK_2"
eq "A1 itens 101/102 gravados, 103 intacto, valor_total = total provado" "$(estado 100)" "101:12.5/125,102:22.25/222.5,103:30/300|347.5"

# A2 idempotência de estado: 2ª chamada com o mesmo payload é aceita (omie ainda NULL) e não muda nada.
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5"); eq "A2 re-chamada com omie ainda NULL é aceita" "$R" "RPC_OK_2"

# N1 CP002 — PO Omie já existe: recusa e NÃO toca em nada.
seed
R=$(rpc "200, '[{\"item_id\":201,\"preco_unitario\":99,\"valor_linha\":990}]'::jsonb, 990"); eq "N1 PO Omie existente → CP002" "$R" "RPC_ERR_CP002"
eq "N1 pedido 200 intacto" "$(estado 200)" "201:10/100|0"

# N2 CP003 — status ≠ sucesso_portal: recusa e não toca.
R=$(rpc "300, '[{\"item_id\":301,\"preco_unitario\":99,\"valor_linha\":990}]'::jsonb, 990"); eq "N2 enviando_portal → CP003" "$R" "RPC_ERR_CP003"
eq "N2 pedido 300 intacto" "$(estado 300)" "301:10/100|0"

# N3 CP003 — pedido inexistente.
R=$(rpc "999, '[{\"item_id\":1,\"preco_unitario\":1,\"valor_linha\":1}]'::jsonb, 1"); eq "N3 pedido inexistente → CP003" "$R" "RPC_ERR_CP003"

# N4 CP004 + ROLLBACK (a prova central do tudo-ou-nada): item 401 é de OUTRO pedido, no mesmo array que o 101 legítimo.
# Sem a transação, o 101 e o valor_total ficariam gravados (custo MISTO) — aqui NADA pode ter mudado.
seed
R=$(rpc "100, '[{\"item_id\":101,\"preco_unitario\":12.5,\"valor_linha\":125},{\"item_id\":401,\"preco_unitario\":5,\"valor_linha\":50}]'::jsonb, 175"); eq "N4 item de outro pedido → CP004" "$R" "RPC_ERR_CP004"
eq "N4 ROLLBACK: item legítimo 101 e valor_total do 100 NÃO mudaram" "$(estado 100)" "$INTACTO_100"
eq "N4 item 401 (do pedido 400) intacto" "$(estado 400)" "401:10/100|0"

# N5 CP004 — id inexistente.
R=$(rpc "100, '[{\"item_id\":101,\"preco_unitario\":12.5,\"valor_linha\":125},{\"item_id\":9999,\"preco_unitario\":5,\"valor_linha\":50}]'::jsonb, 175"); eq "N5 id inexistente → CP004" "$R" "RPC_ERR_CP004"
eq "N5 nada gravado" "$(estado 100)" "$INTACTO_100"

# N6 CP004 — id repetido no array.
R=$(rpc "100, '[{\"item_id\":101,\"preco_unitario\":12.5,\"valor_linha\":125},{\"item_id\":101,\"preco_unitario\":13,\"valor_linha\":130}]'::jsonb, 255"); eq "N6 id repetido → CP004" "$R" "RPC_ERR_CP004"
eq "N6 nada gravado" "$(estado 100)" "$INTACTO_100"

# N7 CP001 — payload: vazio, não-array, preço 0, preço NaN, valor Infinity, total NaN, total Infinity, total 0, item_id não-inteiro.
for caso in \
  "vazio|100, '[]'::jsonb, 10" \
  "nao_array|100, '{\"item_id\":101}'::jsonb, 10" \
  "preco_zero|100, '[{\"item_id\":101,\"preco_unitario\":0,\"valor_linha\":1}]'::jsonb, 10" \
  "preco_nan|100, '[{\"item_id\":101,\"preco_unitario\":\"NaN\",\"valor_linha\":1}]'::jsonb, 10" \
  "valor_inf|100, '[{\"item_id\":101,\"preco_unitario\":1,\"valor_linha\":\"Infinity\"}]'::jsonb, 10" \
  "total_nan|100, '$ITENS_100'::jsonb, 'NaN'::numeric" \
  "total_inf|100, '$ITENS_100'::jsonb, 'Infinity'::numeric" \
  "total_zero|100, '$ITENS_100'::jsonb, 0" \
  "id_texto|100, '[{\"item_id\":\"abc\",\"preco_unitario\":1,\"valor_linha\":1}]'::jsonb, 10" ; do
  nome="${caso%%|*}"; args="${caso#*|}"
  R=$(rpc "$args"); eq "N7 payload $nome → CP001" "$R" "RPC_ERR_CP001"
done
eq "N7 nada gravado em nenhum caso" "$(estado 100)" "$INTACTO_100"

# P1/P2 privilégio — anon e authenticated NÃO executam (42501 = insufficient_privilege, o fecho REAL).
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5" "SET ROLE authenticated;"); eq "P1 authenticated sem EXECUTE → 42501" "$R" "RPC_ERR_42501"
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5" "SET ROLE anon;"); eq "P2 anon sem EXECUTE → 42501" "$R" "RPC_ERR_42501"
eq "P1/P2 nada gravado" "$(estado 100)" "$INTACTO_100"
# P3 service_role executa (uid NULL ⇒ gate de papel libera) — é o caminho da edge.
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5" "SET ROLE service_role;"); eq "P3 service_role executa" "$R" "RPC_OK_2"
# P4 gate de papel em profundidade: uid de CUSTOMER preenchido, mesmo como postgres (privilégio ok) → 42501.
seed
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5" "SET test.uid='22222222-2222-2222-2222-222222222222';"); eq "P4 uid customer → 42501 (gate no corpo)" "$R" "RPC_ERR_42501"
eq "P4 nada gravado" "$(estado 100)" "$INTACTO_100"

# C1 CORRIDA (o risco do Codex): sessão A segura o row-lock do pedido 100 gravando o nº do PO Omie e só
# commita depois; a RPC chega no meio, BLOQUEIA no UPDATE, re-avalia o predicado após o commit
# (READ COMMITTED) e vê omie NOT NULL → CP002. Um SELECT prévio em memória teria dito "NULL" e gravado.
seed
P -q -c "BEGIN; UPDATE public.pedido_compra_sugerido SET omie_pedido_compra_numero='PO-CORRIDA' WHERE id=100; SELECT pg_sleep(1.5); COMMIT;" &
A_PID=$!
sleep 0.4
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5"); wait "$A_PID"
eq "C1 corrida com o PO Omie → CP002 (CAS re-avaliado após o commit concorrente)" "$R" "RPC_ERR_CP002"
eq "C1 custo NÃO trocou depois de o PO existir" "$(estado 100)" "101:10/100,102:20/200,103:30/300|0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): uma defesa por vez → exija VERMELHO → restaura com a migration REAL
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
SAB="$(mktemp /tmp/sab-custo-cas.XXXXXX.sql)"
# sabota(<padrão sed>) — gera a migration FURADA a partir da real; aborta se o padrão não casou (no-op = teatro).
sabota() {
  sed -e "$1" "$MIG" > "$SAB"
  if cmp -s "$MIG" "$SAB"; then echo "  ❌ sabotagem NÃO casou o padrão ($1) — falsificação seria teatro"; FAIL=$((FAIL+1)); return 1; fi
  P -q -f "$SAB"
}
restaura() { P -q -f "$MIG"; seed; }

# F1 — sem o CAS de omie: N1 tem de virar verde-falso (RPC passa com PO existente).
seed; sabota 's/AND p\.omie_pedido_compra_numero IS NULL/AND true/'
R=$(rpc "200, '[{\"item_id\":201,\"preco_unitario\":99,\"valor_linha\":990}]'::jsonb, 990")
if [ "$R" = "RPC_OK_1" ]; then ok "F1 sem CAS de omie, o custo troca com PO existente (N1/C1 têm dente)"; else bad "F1 sabotei o CAS e N1 não mudou ($R) → assert fraco"; fi
restaura

# F2 — sem a contagem ROW_COUNT == n: N4 tem de virar escrita PARCIAL persistida.
sabota 's/IF v_afetadas <> v_n THEN/IF false THEN/'
R=$(rpc "100, '[{\"item_id\":101,\"preco_unitario\":12.5,\"valor_linha\":125},{\"item_id\":401,\"preco_unitario\":5,\"valor_linha\":50}]'::jsonb, 175")
if [ "$R" = "RPC_OK_1" ] && [ "$(estado 100)" = "101:12.5/125,102:20/200,103:30/300|175" ]; then ok "F2 sem a contagem, custo MISTO persiste (N4 tem dente)"; else bad "F2 sabotei a contagem e N4 não mudou ($R / $(estado 100))"; fi
restaura

# F3 — sem o CAS de status: N2 tem de passar.
sabota "s/AND p\.status_envio_portal = 'sucesso_portal'/AND true/"
R=$(rpc "300, '[{\"item_id\":301,\"preco_unitario\":99,\"valor_linha\":990}]'::jsonb, 990")
if [ "$R" = "RPC_OK_1" ]; then ok "F3 sem CAS de status, grava em enviando_portal (N2 tem dente)"; else bad "F3 sabotei o status e N2 não mudou ($R)"; fi
restaura

# F4 — REVOKE trocado por GRANT a authenticated: P1 tem de passar (privilégio é a tranca real).
sabota 's/REVOKE EXECUTE ON FUNCTION public\.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM anon, authenticated;/GRANT EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) TO authenticated;/; /POST FALHOU: anon\/authenticated ainda executam/s/RAISE EXCEPTION/RAISE NOTICE/'
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5" "SET ROLE authenticated;")
if [ "$R" = "RPC_OK_2" ]; then ok "F4 com GRANT a authenticated a RPC abre (P1 tem dente)"; else bad "F4 sabotei o REVOKE e P1 não mudou ($R)"; fi
restaura
# F4b — a postcondição embutida também acusa (sem o RAISE NOTICE acima o apply sabotado ABORTA):
sed -e 's/REVOKE EXECUTE ON FUNCTION public\.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM anon, authenticated;/GRANT EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) TO authenticated;/' "$MIG" > "$SAB"
if P -q -f "$SAB" >/dev/null 2>&1; then bad "F4b postcondição NÃO abortou com authenticated executando"; else ok "F4b postcondição aborta o apply com authenticated executando"; fi
restaura

# F5 — sem a finitude do total: 'Infinity' tem de passar.
sabota "s/AND p_valor_total < 'Infinity'::numeric/AND true/"
R=$(rpc "100, '$ITENS_100'::jsonb, 'Infinity'::numeric")
if [ "$R" = "RPC_OK_2" ]; then ok "F5 sem finitude do total, Infinity vira valor_total (N7 total_inf tem dente)"; else bad "F5 sabotei a finitude e N7 não mudou ($R)"; fi
restaura

# F6 — sem os guards de preço do item: preço NaN tem de passar.
sabota "s/OR (e->>'preco_unitario')::numeric = 'NaN'::numeric OR (e->>'valor_linha')::numeric = 'NaN'::numeric/OR false/; s/OR NOT ((e->>'preco_unitario')::numeric > 0 AND (e->>'preco_unitario')::numeric < 'Infinity'::numeric)/OR false/"
R=$(rpc "100, '[{\"item_id\":101,\"preco_unitario\":\"NaN\",\"valor_linha\":1}]'::jsonb, 10")
if [ "$R" = "RPC_OK_1" ]; then ok "F6 sem guard de preço, NaN vira preco_unitario (N7 preco_nan tem dente)"; else bad "F6 sabotei o guard de preço e N7 não mudou ($R)"; fi
restaura

# F7 — sem o gate de papel: P4 (uid customer, privilégio ok) tem de passar.
sabota 's/IF auth\.uid() IS NOT NULL$/IF false/'
R=$(rpc "100, '$ITENS_100'::jsonb, 347.5" "SET test.uid='22222222-2222-2222-2222-222222222222';")
if [ "$R" = "RPC_OK_2" ]; then ok "F7 sem gate de papel, customer com privilégio grava (P4 tem dente)"; else bad "F7 sabotei o gate e P4 não mudou ($R)"; fi
restaura

# Controle: a migration REAL re-aplicada continua verde no assert central (restaura não deixou sabotagem).
R=$(rpc "100, '[{\"item_id\":101,\"preco_unitario\":12.5,\"valor_linha\":125},{\"item_id\":401,\"preco_unitario\":5,\"valor_linha\":50}]'::jsonb, 175")
eq "F8 controle: após restaurar, N4 volta a CP004" "$R" "RPC_ERR_CP004"
eq "F8 controle: nada gravado" "$(estado 100)" "$INTACTO_100"
rm -f "$SAB"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
