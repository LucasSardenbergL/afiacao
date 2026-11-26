#!/usr/bin/env bash
# PROVA PG17 — claim do envio CONFERIDO pelos itens (migration 20261126190127_sales_orders_claim_envio_conferido).
# Executa a RPC (PL/pgSQL é late-bound), prova a corrida edição-local × conversão com duas sessões
# reais (a 2ª espera o lock da 1ª — conferido em pg_stat_activity, não por sleep), os grants com o
# DEFAULT PRIVILEGE do Supabase replicado, e FALSIFICA: a versão sem a condição dos itens reprova
# o mesmo assert, e a projeção por texto aborta a própria migration.
# bash db/test-claim-envio-conferido.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="claim-envio-conferido"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

SAB="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$SAB"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG_BASE="$REPO_ROOT/supabase/migrations/20261120230001_sales_orders_claim_envio_omie.sql"
MIG="$REPO_ROOT/supabase/migrations/20261126190127_sales_orders_claim_envio_conferido.sql"
A='00000000-0000-0000-0000-00000000000a'

# Esquema mínimo com o que a PROD tem e importa aqui: items jsonb, updated_at movido por trigger em
# todo UPDATE (update_sales_orders_updated_at) e o UPDATE por coluna do authenticated.
P -q <<'SQL'
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, deleted_at timestamptz,
  status text NOT NULL DEFAULT 'orcamento', omie_pedido_id bigint, items jsonb,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.t_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.t_updated_at();
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.cap_pedido_escrever(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
GRANT USAGE ON SCHEMA private TO authenticated;
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON public.sales_orders TO authenticated;
GRANT ALL ON public.sales_orders TO service_role;
GRANT UPDATE (deleted_at, status, items) ON public.sales_orders TO authenticated;
CREATE POLICY sales_orders_select_t ON public.sales_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY sales_orders_delete_staff ON public.sales_orders FOR DELETE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))) AND omie_pedido_id IS NULL
         AND status IN ('orcamento', 'rascunho'));
SQL
P -q -f "$MIG_BASE" >/dev/null
P -q -f "$MIG" >/dev/null
P -q -f "$MIG" >/dev/null   # idempotente: a 2ª colada não pode falhar
ok "migration aplicada 2× sobre a base (idempotente, postcondição passou)"

VELHOS='[{"omie_codigo_produto":555,"quantidade":2,"valor_unitario":10,"descricao":"Lixa"}]'
NOVOS='[{"omie_codigo_produto":555,"quantidade":3,"valor_unitario":10,"descricao":"Lixa"}]'
DOIS='[{"omie_codigo_produto":1,"quantidade":1,"valor_unitario":5},{"omie_codigo_produto":2,"quantidade":1,"valor_unitario":7}]'
DOIS_TROCADO='[{"omie_codigo_produto":2,"quantidade":1,"valor_unitario":7},{"omie_codigo_produto":1,"quantidade":1,"valor_unitario":5}]'

reset() { # $1 = items da linha (literal SQL) · $2 = deleted_at
  Pq -c "TRUNCATE public.sales_orders; INSERT INTO public.sales_orders(id, items, deleted_at) VALUES ('$A', $1, ${2:-NULL});" >/dev/null
}
claim()   { Pq -c "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$1'::jsonb);"; }
carimbo() { Pq -c "SELECT (envio_omie_reivindicado_em IS NOT NULL)::text FROM public.sales_orders WHERE id='$A';"; }
sqlstate() { # devolve a SQLSTATE do erro (ou "sem_erro") — captura a ESPERADA, não "qualquer erro"
  P -q -tA -c "DO \$\$ BEGIN PERFORM public.sales_order_reivindicar_envio_conferido('$A', '$1'::jsonb); RAISE NOTICE 'sem_erro'; EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'SQLSTATE_22023'; END \$\$;" 2>&1 \
    | grep -oE 'SQLSTATE_22023|sem_erro' | head -1
}

echo "── unitários"
reset "'$VELHOS'"
eq "U1 itens da linha = itens do envio → reivindica" "$(claim "$VELHOS")" "reivindicado"
eq "U1b e carimba" "$(carimbo)" "true"
reset "'$VELHOS'"
eq "U2 mesmo item com número em outro formato e campo extra → reivindica" \
  "$(claim '[{"omie_codigo_produto":"555","quantidade":2.0,"valor_unitario":10.00,"tint_cor_id":"x"}]')" "reivindicado"
reset "'$NOVOS'"
eq "U3 linha editada (quantidade 3) × envio com a foto velha (2) → recusa" "$(claim "$VELHOS")" "itens_divergentes"
eq "U3b e NÃO carimba" "$(carimbo)" "false"
reset "'$DOIS'"
eq "U4 mesma lista em outra ordem → recusa" "$(claim "$DOIS_TROCADO")" "itens_divergentes"
reset "'$DOIS'"
eq "U5 linha com item a mais → recusa" "$(claim '[{"omie_codigo_produto":1,"quantidade":1,"valor_unitario":5}]')" "itens_divergentes"
reset "'[{\"omie_codigo_produto\":555,\"quantidade\":2,\"valor_unitario\":11}]'"
eq "U6 preço diferente → recusa" "$(claim "$VELHOS")" "itens_divergentes"
reset "NULL"
eq "U7 linha sem items → recusa (nunca vale como igual)" "$(claim "$VELHOS")" "itens_divergentes"
reset "'[{\"omie_codigo_produto\":555,\"quantidade\":2}]'"
eq "U8 item da linha sem valor_unitario → recusa" "$(claim '[{"omie_codigo_produto":555,"quantidade":2,"valor_unitario":10}]')" "itens_divergentes"
reset "'$VELHOS'" "now()"
eq "U9 pedido marcado para exclusão → excluido" "$(claim "$VELHOS")" "excluido"
eq "U9b e não carimba" "$(carimbo)" "false"
Pq -c "TRUNCATE public.sales_orders;" >/dev/null
eq "U10 pedido inexistente → ausente" "$(claim "$VELHOS")" "ausente"
reset "'$VELHOS'"
eq "U11 envio com lista vazia → 22023" "$(sqlstate '[]')" "SQLSTATE_22023"
eq "U12 envio com item sem valor → 22023" "$(sqlstate '[{"omie_codigo_produto":555,"quantidade":2}]')" "SQLSTATE_22023"
eq "U13 envio que não é lista → 22023" "$(sqlstate '{"a":1}')" "SQLSTATE_22023"
eq "U13b e nada foi carimbado" "$(carimbo)" "false"

# A outra ordem da corrida: o claim é UPDATE ⇒ o trigger move updated_at ⇒ o salvar local da aba
# aberta antes (UPDATE … WHERE updated_at = <o da abertura>) não casa nenhuma linha.
reset "'$VELHOS'"
V0="$(Pq -c "SELECT updated_at FROM public.sales_orders WHERE id='$A';")"
claim "$VELHOS" >/dev/null
eq "U14 depois do claim, o salvar local com a versão da abertura atinge 0 linhas" \
  "$(Pq -c "WITH u AS (UPDATE public.sales_orders SET items='$NOVOS'::jsonb WHERE id='$A' AND omie_pedido_id IS NULL AND updated_at='$V0' RETURNING 1) SELECT count(*) FROM u;")" "0"

echo "── concorrência (duas sessões reais)"
corrida() { # $1 = SQL da sessão 1 (segura o lock) · $2 = SQL da sessão 2 (espera) · imprime "esperou:resultado"
  local out2; out2="$(mktemp)"
  PGAPPNAME=s1 P -q -tA -c "BEGIN; $1; SELECT pg_sleep(3); COMMIT;" >/dev/null &
  local p1=$!
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='s1' AND wait_event='PgSleep';")" = 1 ] && break; sleep 0.1
  done
  PGAPPNAME=s2 P -q -tA -c "$2" > "$out2" &
  local p2=$!
  local esperou=0
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity b WHERE b.application_name='s2'
        AND (SELECT pid FROM pg_stat_activity WHERE application_name='s1') = ANY (pg_blocking_pids(b.pid));")" = 1 ] && { esperou=1; break; }; sleep 0.05
  done
  wait $p1; wait $p2
  echo "$esperou:$(tr -d '\n' < "$out2")"; rm -f "$out2"
}
SALVA_A="UPDATE public.sales_orders SET items='$NOVOS'::jsonb WHERE id='$A'"
reset "'$VELHOS'"
eq "C1 aba A salva (segura o lock) → o claim da aba B com a foto velha ESPEROU e recusa" \
  "$(corrida "$SALVA_A" "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$VELHOS'::jsonb)")" "1:itens_divergentes"
eq "C1b e não carimbou" "$(carimbo)" "false"
# C2: a ordem inversa — o claim de B segura o lock; o salvar local de A (versão da abertura) ESPERA,
# re-avalia na versão nova (updated_at movido pelo claim) e atinge 0 linhas.
reset "'$VELHOS'"
V0="$(Pq -c "SELECT updated_at FROM public.sales_orders WHERE id='$A';")"
eq "C2 claim de B segura o lock → o salvar local de A ESPEROU e não grava nada" \
  "$(corrida "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$VELHOS'::jsonb)" \
     "WITH u AS (UPDATE public.sales_orders SET items='$NOVOS'::jsonb WHERE id='$A' AND omie_pedido_id IS NULL AND updated_at='$V0' RETURNING 1) SELECT count(*) FROM u")" "1:0"
eq "C2b a linha manteve os itens que foram ao Omie" \
  "$(Pq -c "SELECT (items->0->>'quantidade') FROM public.sales_orders WHERE id='$A';")" "2"
# C3 controle: A salva e COMMITA, depois B envia os itens novos (o checkout grava a linha e chama a edge).
reset "'$VELHOS'"
Pq -c "$SALVA_A" >/dev/null
eq "C3 controle: salvar commitado e envio com os itens novos → reivindica" "$(claim "$NOVOS")" "reivindicado"
# Limite medido (precisão > recall): com o salvar de A AINDA aberto, um envio com os itens NOVOS
# enxerga a versão velha, não casa o WHERE e não espera o lock — recusa. Não há caminho real assim
# (submitOrder commita a linha antes de chamar a edge); fica provado para ninguém ler como bug.
reset "'$VELHOS'"
eq "C4 salvar de A não commitado × envio com os itens novos → recusa sem esperar" \
  "$(corrida "$SALVA_A" "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$NOVOS'::jsonb)")" "0:itens_divergentes"

echo "── grants e compatibilidade"
eq "G1 service_role executa o claim conferido" \
  "$(Pq -c "SELECT has_function_privilege('service_role','public.sales_order_reivindicar_envio_conferido(uuid, jsonb)','EXECUTE');")" "t"
eq "G2 authenticated NÃO executa" \
  "$(Pq -c "SELECT has_function_privilege('authenticated','public.sales_order_reivindicar_envio_conferido(uuid, jsonb)','EXECUTE');")" "f"
eq "G3 anon NÃO executa" \
  "$(Pq -c "SELECT has_function_privilege('anon','public.sales_order_reivindicar_envio_conferido(uuid, jsonb)','EXECUTE');")" "f"
reset "'$NOVOS'"
eq "G4 o claim antigo (edge v1.51 no ar) segue funcionando" \
  "$(Pq -c "SELECT public.sales_order_reivindicar_envio('$A');")" "t"

echo "── falsificação (sabota UMA camada por vez; o controle verde é a bateria acima, nesta invocação)"
[ "$FAIL" = "0" ] || { echo "❌ controle vermelho antes de sabotar — falsificação não vale"; exit 1; }
# F1: sem a condição dos itens o claim volta ao de antes — U3 e C1 têm de ficar VERMELHOS.
sed 's/^     AND public\.sales_order_itens_projecao_envio(items) = v_proj;$/     ;/' "$MIG" > "$SAB/f1.sql"
if cmp -s "$MIG" "$SAB/f1.sql"; then bad "F1 sabotagem não aplicou (sed não casou)"; else
  P -q -f "$SAB/f1.sql" >/dev/null
  reset "'$NOVOS'"
  r="$(claim "$VELHOS")"
  if [ "$r" = "reivindicado" ]; then ok "F1 sem a condição dos itens, a foto velha reivindica (o bug volta — o U3 pega)"; else bad "F1 sabotagem inócua: veio [$r]"; fi
  reset "'$VELHOS'"
  r="$(corrida "$SALVA_A" "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$VELHOS'::jsonb)")"
  if [ "$r" = "1:reivindicado" ]; then ok "F1b e na corrida real também (o C1 pega)"; else bad "F1b sabotagem inócua na corrida: veio [$r]"; fi
fi
# F2: projeção por TEXTO (sem ::numeric) — a postcondição A5 tem de abortar a migration.
sed 's/)::numeric/)/g' "$MIG" > "$SAB/f2.sql"
if cmp -s "$MIG" "$SAB/f2.sql"; then bad "F2 sabotagem não aplicou (sed não casou)"; else
  if P -q -f "$SAB/f2.sql" >/dev/null 2>&1; then bad "F2 projeção por texto passou pela postcondição"
  else ok "F2 projeção por texto aborta a migration (postcondição A5)"; fi
fi
# F3: projeção que ignora a ORDEM (ordena pelo conteúdo, não pela posição) — a A6 tem de abortar.
sed 's/ORDER BY o)/ORDER BY e::text)/' "$MIG" > "$SAB/f3.sql"
if cmp -s "$MIG" "$SAB/f3.sql"; then bad "F3 sabotagem não aplicou (sed não casou)"; else
  if P -q -f "$SAB/f3.sql" >/dev/null 2>&1; then bad "F3 projeção sem ordem passou pela postcondição"
  else ok "F3 projeção que ignora a ordem aborta a migration (postcondição A6)"; fi
fi
# Restaura e prova que fecha de novo.
P -q -f "$MIG" >/dev/null
reset "'$NOVOS'"
eq "F4 migration reaplicada fecha de novo" "$(claim "$VELHOS")" "itens_divergentes"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE — fim"
