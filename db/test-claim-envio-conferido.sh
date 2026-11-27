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
BRANCO='[{"omie_codigo_produto":9,"quantidade":1,"valor_unitario":80,"tint_cor_id":"branco"}]'
AZUL='[{"omie_codigo_produto":9,"quantidade":1,"valor_unitario":80,"tint_cor_id":"azul"}]'
ATUAL="(SELECT updated_at FROM public.sales_orders WHERE id='$A')"

reset() { # $1 = items da linha (literal SQL) · $2 = deleted_at
  Pq -c "TRUNCATE public.sales_orders; INSERT INTO public.sales_orders(id, items, deleted_at) VALUES ('$A', $1, ${2:-NULL});" >/dev/null
}
versao()  { Pq -c "SELECT updated_at FROM public.sales_orders WHERE id='$A';"; }
claim()   { # $1 = itens do envio · $2 = versão (literal SQL; default: a ATUAL da linha)
  Pq -c "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$1'::jsonb, ${2:-$ATUAL});"
}
carimbo() { Pq -c "SELECT (envio_omie_reivindicado_em IS NOT NULL)::text FROM public.sales_orders WHERE id='$A';"; }
sqlstate() { # $1 = itens · $2 = versão — devolve a SQLSTATE ESPERADA (22023) ou "sem_erro"; outra re-lança
  P -q -tA -c "DO \$\$ BEGIN PERFORM public.sales_order_reivindicar_envio_conferido('$A', '$1'::jsonb, ${2:-$ATUAL}); RAISE NOTICE 'sem_erro'; EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'SQLSTATE_22023'; END \$\$;" 2>&1 \
    | grep -oE 'SQLSTATE_22023|sem_erro' | head -1
}
salva_a() { Pq -c "UPDATE public.sales_orders SET items='$1'::jsonb WHERE id='$A';" >/dev/null; }

echo "── unitários"
reset "'$VELHOS'"
eq "U1 itens da linha = itens do envio, linha não mudou → reivindica" "$(claim "$VELHOS")" "reivindicado"
eq "U1b e carimba" "$(carimbo)" "true"
reset "'$VELHOS'"
eq "U2 mesmo item com número em outro formato e campo cosmético extra → reivindica" \
  "$(claim '[{"omie_codigo_produto":"555","quantidade":2.0,"valor_unitario":10.00,"descricao":"outra"}]')" "reivindicado"
reset "'$NOVOS'"
eq "U3 linha editada (qtd 3) × envio com a foto velha (2), versão atual → recusa (camada dos itens)" "$(claim "$VELHOS")" "pedido_alterado"
eq "U3b e NÃO carimba" "$(carimbo)" "false"
reset "'$DOIS'"
eq "U4 mesma lista noutra ordem (retry do pedido programado) → reivindica" "$(claim "$DOIS_TROCADO")" "reivindicado"
reset "'$DOIS'"
eq "U5 linha com item a mais → recusa" "$(claim '[{"omie_codigo_produto":1,"quantidade":1,"valor_unitario":5}]')" "pedido_alterado"
reset "'[{\"omie_codigo_produto\":1,\"quantidade\":1,\"valor_unitario\":5},{\"omie_codigo_produto\":1,\"quantidade\":1,\"valor_unitario\":5}]'"
eq "U5b item repetido conta 2× (multiconjunto) → recusa o envio de 1" "$(claim '[{"omie_codigo_produto":1,"quantidade":1,"valor_unitario":5}]')" "pedido_alterado"
reset "'[{\"omie_codigo_produto\":555,\"quantidade\":2,\"valor_unitario\":11}]'"
eq "U6 preço diferente → recusa" "$(claim "$VELHOS")" "pedido_alterado"
reset "'$BRANCO'"
eq "U7 cor da tinta trocada (branco na linha, azul no envio) → recusa" "$(claim "$AZUL")" "pedido_alterado"
reset "NULL"
eq "U8 linha sem items → recusa (nunca vale como igual)" "$(claim "$VELHOS")" "pedido_alterado"
reset "'[{\"omie_codigo_produto\":555,\"quantidade\":2}]'"
eq "U9 item da linha sem valor_unitario → recusa" "$(claim '[{"omie_codigo_produto":555,"quantidade":2,"valor_unitario":10}]')" "pedido_alterado"
reset "'$VELHOS'" "now()"
eq "U10 pedido marcado para exclusão → excluido" "$(claim "$VELHOS")" "excluido"
eq "U10b e não carimba" "$(carimbo)" "false"
Pq -c "TRUNCATE public.sales_orders;" >/dev/null
eq "U11 pedido inexistente → ausente" "$(claim "$VELHOS" "now()")" "ausente"
reset "'$VELHOS'"
eq "U12 envio com lista vazia → 22023" "$(sqlstate '[]')" "SQLSTATE_22023"
eq "U13 envio com item sem valor → 22023" "$(sqlstate '[{"omie_codigo_produto":555,"quantidade":2}]')" "SQLSTATE_22023"
eq "U14 envio que não é lista → 22023" "$(sqlstate '{"a":1}')" "SQLSTATE_22023"
eq "U15 versão ausente → 22023" "$(sqlstate "$VELHOS" "NULL")" "SQLSTATE_22023"
eq "U15b e nada foi carimbado" "$(carimbo)" "false"

echo "── a versão (achado 1 do Codex): a linha mudou e VOLTOU entre a reserva ATP e o claim"
reset "'$VELHOS'"
V0="$(versao)"                       # o que a edge leu ANTES do gate ATP
salva_a "$NOVOS"; salva_a "$VELHOS"  # A muda 2→3 e volta a 2: os itens batem de novo, a versão não
eq "V1 itens iguais aos do envio, mas a linha mudou desde a leitura → recusa (camada da versão)" \
  "$(claim "$VELHOS" "'$V0'")" "pedido_alterado"
eq "V1b e não carimba" "$(carimbo)" "false"
reset "'$VELHOS'"
V0="$(versao)"
claim "$VELHOS" "'$V0'" >/dev/null
eq "V2 depois do claim, o salvar local com a versão da abertura atinge 0 linhas" \
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
V0="$(versao)"
eq "C1 aba A salva (segura o lock) → o claim da aba B (foto velha, versão lida antes) ESPEROU e recusa" \
  "$(corrida "$SALVA_A" "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$VELHOS'::jsonb, '$V0')")" "1:pedido_alterado"
eq "C1b e não carimbou" "$(carimbo)" "false"
reset "'$VELHOS'"
V0="$(versao)"
eq "C2 claim de B segura o lock → o salvar local de A ESPEROU e não grava nada" \
  "$(corrida "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$VELHOS'::jsonb, '$V0')" \
     "WITH u AS (UPDATE public.sales_orders SET items='$NOVOS'::jsonb WHERE id='$A' AND omie_pedido_id IS NULL AND updated_at='$V0' RETURNING 1) SELECT count(*) FROM u")" "1:0"
eq "C2b a linha manteve os itens que foram ao Omie" \
  "$(Pq -c "SELECT (items->0->>'quantidade') FROM public.sales_orders WHERE id='$A';")" "2"
# C3 controle: A salva e COMMITA; a edge lê a linha DEPOIS e envia os itens novos (o checkout grava e chama).
reset "'$VELHOS'"
salva_a "$NOVOS"
eq "C3 controle: salvar commitado, leitura depois, envio com os itens novos → reivindica" "$(claim "$NOVOS")" "reivindicado"
# Limite medido (precisão > recall): com o salvar de A AINDA aberto, o envio enxerga a versão velha,
# não casa o WHERE e não espera o lock — recusa. Sem caminho real (o checkout commita antes).
reset "'$VELHOS'"
V0="$(versao)"
eq "C4 salvar de A não commitado × envio com os itens novos → recusa sem esperar" \
  "$(corrida "$SALVA_A" "SELECT public.sales_order_reivindicar_envio_conferido('$A', '$NOVOS'::jsonb, '$V0')")" "0:pedido_alterado"

echo "── grants e compatibilidade"
FN="public.sales_order_reivindicar_envio_conferido(uuid, jsonb, timestamptz)"
eq "G1 service_role executa o claim conferido" "$(Pq -c "SELECT has_function_privilege('service_role','$FN','EXECUTE');")" "t"
eq "G2 authenticated NÃO executa" "$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")" "f"
eq "G3 anon NÃO executa" "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE');")" "f"
reset "'$NOVOS'"
eq "G4 o claim antigo (edge v1.52 no ar) segue funcionando" "$(Pq -c "SELECT public.sales_order_reivindicar_envio('$A');")" "t"

echo "── falsificação (sabota UMA camada por vez; o controle verde é a bateria acima, nesta invocação)"
[ "$FAIL" = "0" ] || { echo "❌ controle vermelho antes de sabotar — falsificação não vale"; exit 1; }
sabota() { # $1 saída · $2 trecho EXATO a trocar · $3 troca — falha ruidosa se o trecho não existir 1×
  python3 - "$MIG" "$1" "$2" "$3" <<'PY'
import sys
src, out, a, b = sys.argv[1:]
s = open(src, encoding="utf-8").read()
if s.count(a) != 1:
    sys.exit(f"trecho não casou 1x: {a!r}")
open(out, "w", encoding="utf-8").write(s.replace(a, b))
PY
}
# F1: sem a camada dos ITENS — U3 (linha editada antes da leitura) tem de reivindicar.
if sabota "$SAB/f1.sql" "     AND public.sales_order_itens_projecao_envio(items) = v_proj;" "     ;"; then
  P -q -f "$SAB/f1.sql" >/dev/null
  reset "'$NOVOS'"; r="$(claim "$VELHOS")"
  if [ "$r" = "reivindicado" ]; then ok "F1 sem a camada dos itens, a foto velha reivindica (o U3 pega)"; else bad "F1 sabotagem inócua: veio [$r]"; fi
else bad "F1 sabotagem não aplicou"; fi
P -q -f "$MIG" >/dev/null
# F2: sem a camada da VERSÃO — V1 (2→3→2 entre a leitura e o claim) tem de reivindicar.
if sabota "$SAB/f2.sql" "     AND updated_at = p_versao
" ""; then
  P -q -f "$SAB/f2.sql" >/dev/null
  reset "'$VELHOS'"; V0="$(versao)"; salva_a "$NOVOS"; salva_a "$VELHOS"
  r="$(claim "$VELHOS" "'$V0'")"
  if [ "$r" = "reivindicado" ]; then ok "F2 sem a camada da versão, a linha que mudou e voltou reivindica (o V1 pega)"; else bad "F2 sabotagem inócua: veio [$r]"; fi
else bad "F2 sabotagem não aplicou"; fi
P -q -f "$MIG" >/dev/null
# F3: projeção por TEXTO (sem ::numeric) — a postcondição A5 tem de abortar a migration.
sed 's/)::numeric/)/g' "$MIG" > "$SAB/f3.sql"
if cmp -s "$MIG" "$SAB/f3.sql"; then bad "F3 sabotagem não aplicou"; else
  if P -q -f "$SAB/f3.sql" >/dev/null 2>&1; then bad "F3 projeção por texto passou pela postcondição"
  else ok "F3 projeção por texto aborta a migration (postcondição A5)"; fi
fi
# F4: projeção na ordem da LISTA (sem ordenar pelo conteúdo) — a A6 tem de abortar.
if sabota "$SAB/f4.sql" "ORDER BY (e->>'omie_codigo_produto')::numeric, (e->>'quantidade')::numeric,
                        (e->>'valor_unitario')::numeric, e->>'tint_cor_id')" "ORDER BY 1)"; then
  if P -q -f "$SAB/f4.sql" >/dev/null 2>&1; then bad "F4 projeção dependente da ordem passou pela postcondição"
  else ok "F4 projeção dependente da ordem aborta a migration (postcondição A6)"; fi
else bad "F4 sabotagem não aplicou"; fi
# F5: projeção sem a COR — a A7 tem de abortar.
if sabota "$SAB/f5.sql" "                 (e->>'valor_unitario')::numeric,
                 e->>'tint_cor_id')" "                 (e->>'valor_unitario')::numeric)"; then
  if P -q -f "$SAB/f5.sql" >/dev/null 2>&1; then bad "F5 projeção sem a cor passou pela postcondição"
  else ok "F5 projeção sem a cor aborta a migration (postcondição A7)"; fi
else bad "F5 sabotagem não aplicou"; fi
# Restaura e prova que fecha de novo.
P -q -f "$MIG" >/dev/null
reset "'$NOVOS'"
eq "F6 migration reaplicada fecha de novo" "$(claim "$VELHOS")" "pedido_alterado"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE — fim"
