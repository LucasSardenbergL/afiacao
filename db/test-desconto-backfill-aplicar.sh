#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — desconto_backfill_aplicar (a escrita do backfill)                     ║
# ║ Rode: bash db/test-desconto-backfill-aplicar.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ╚═══════════════════════════════════════════════════════════════════════════════════╝
#
# O QUE ESTA PROVA EXISTE PARA PEGAR: o plano de apuração é montado a partir de uma leitura que
# aconteceu ANTES da escrita. Nesse intervalo o sync, uma edição ou a reconciliação podem ter
# mudado o preço ou a quantidade da linha. Escrever o desconto sobre a base nova é o MESMO erro
# que a conciliação por trio existe para evitar — entrando pela porta dos fundos, e sem produzir
# erro nenhum: a linha fica com um desconto plausível que ninguém apurou para aquela base.
#
# A defesa é a precondição por linha, dentro da MESMA transação da escrita. Ela é NULL-safe de
# propósito: `unit_price` é nullable desde 2026-09-05, e um `coalesce(...,0)` nos dois lados
# casaria "preço desconhecido" com "preço zero" — que é a fabricação canônica deste repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="desconto-backfill-aplicar"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
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
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# `desconto_valor` NULLABLE e SEM DEFAULT, como em produção. Um default aqui faria os asserts de
# NULL passarem por acidente do stub.
P -q <<'SQL'
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint, quantity numeric, unit_price numeric, desconto_valor numeric);
SQL

MIG="$(ls "$REPO_ROOT"/supabase/migrations/*_desconto_backfill_aplicar.sql | tail -1)"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

L1="bbbbbbbb-0000-0000-0000-000000000001"  # base bate
L2="bbbbbbbb-0000-0000-0000-000000000002"  # quantidade mudou
L3="bbbbbbbb-0000-0000-0000-000000000003"  # preço mudou
L4="bbbbbbbb-0000-0000-0000-000000000004"  # preço NULL dos dois lados
L5="bbbbbbbb-0000-0000-0000-000000000005"  # plano manda null
P -q <<SQL
INSERT INTO public.order_items(id, omie_codigo_produto, quantity, unit_price, desconto_valor) VALUES
 ('$L1', 555, 2, 100, NULL),
 ('$L2', 555, 5, 100, NULL),
 ('$L3', 555, 2, 120, NULL),
 ('$L4', 555, 2, NULL, NULL),
 ('$L5', 555, 1, 10,  NULL);
SQL

echo "═══ F · a escrita e sua precondição ═══"

R=$(Pq -c "SELECT public.desconto_backfill_aplicar('[
  {\"id\":\"$L1\",\"desconto_valor\":10,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555},
  {\"id\":\"$L2\",\"desconto_valor\":20,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555},
  {\"id\":\"$L3\",\"desconto_valor\":30,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555},
  {\"id\":\"$L4\",\"desconto_valor\":40,\"base_quantity\":2,\"base_unit_price\":null,\"base_sku\":555},
  {\"id\":\"$L5\",\"desconto_valor\":null,\"base_quantity\":1,\"base_unit_price\":10,\"base_sku\":555}
]'::jsonb);")
F1=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE id='$L1';")
eq "F1 base idêntica → escreve" "$F1" "10"
F2=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE id='$L2';")
eq "F2 quantidade mudou desde a leitura → NÃO escreve" "$F2" "t"
F3=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE id='$L3';")
eq "F3 preço mudou desde a leitura → NÃO escreve" "$F3" "t"
# O assert NULL-safe: sem `IS NOT DISTINCT FROM`, `NULL = NULL` é NULL (falso) e esta linha nunca
# seria apurada — o backfill deixaria de fora todo item de preço desconhecido, em silêncio.
F4=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE id='$L4';")
eq "F4 preço NULL dos DOIS lados casa (IS NOT DISTINCT FROM), não é descartado" "$F4" "40"
F5=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE id='$L5';")
eq "F5 plano com desconto null NÃO escreve (não apaga apuração alheia)" "$F5" "t"
F6=$(echo "$R" | tr -d ' ')
eq "F6 contagens: 5 pedidas, 2 aplicadas, 3 recusadas" "$F6" '{"pedidas":5,"aplicadas":2,"recusadas":3}'

# Idempotência: reaplicar o MESMO plano não acumula nem alterna.
Pq -c "SELECT public.desconto_backfill_aplicar('[{\"id\":\"$L1\",\"desconto_valor\":10,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555}]'::jsonb);" >/dev/null
F7=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE id='$L1';")
eq "F7 reaplicar o mesmo plano é idempotente" "$F7" "10"

echo "═══ G · ACL: escrita de money-path fechada na fronteira ═══"
G1=$(Pq -c "SELECT has_function_privilege('anon','public.desconto_backfill_aplicar(jsonb)','EXECUTE');")
eq "G1 anon NÃO executa" "$G1" "f"
G2=$(Pq -c "SELECT has_function_privilege('authenticated','public.desconto_backfill_aplicar(jsonb)','EXECUTE');")
eq "G2 authenticated NÃO executa" "$G2" "f"
G3=$(Pq -c "SELECT has_function_privilege('public','public.desconto_backfill_aplicar(jsonb)','EXECUTE');")
eq "G3 PUBLIC NÃO executa (a OUTRA ponta do REVOKE)" "$G3" "f"
G4=$(Pq -c "SELECT has_function_privilege('service_role','public.desconto_backfill_aplicar(jsonb)','EXECUTE');")
eq "G4 service_role executa (senão a edge não escreveria)" "$G4" "t"

echo "═══ H · FALSIFICAÇÃO: sabota → exige VERMELHO → restaura ═══"

# H1 — a precondição some. Se F2/F3 não ficarem vermelhos aqui, eles estavam passando por outro
# motivo e a linha desatualizada seria escrita em produção sem que nada acusasse.
SAB="/tmp/sabotado-${SLUG}.sql"
sed -e 's/       AND oi.quantity            IS NOT DISTINCT FROM pl.base_quantity/       AND true/' \
    -e 's/       AND oi.unit_price          IS NOT DISTINCT FROM pl.base_unit_price/       AND true/' "$MIG" > "$SAB"
if [ "$(grep -c 'AND true' "$SAB")" -ne 2 ]; then
  bad "H0 a sabotagem NÃO alterou o arquivo — a falsificação seria teatro (sempre-verde)"
else
  ok "H0 (controle da sabotagem) as duas precondições foram removidas de fato"
  P -q -f "$SAB" >/dev/null
  P -q -c "UPDATE public.order_items SET desconto_valor = NULL;" >/dev/null
  Pq -c "SELECT public.desconto_backfill_aplicar('[{\"id\":\"$L2\",\"desconto_valor\":20,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555}]'::jsonb);" >/dev/null
  H1=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE id='$L2';")
  if [ "$H1" = "20" ]; then ok "H1 sem a precondição, a linha DESATUALIZADA é escrita — F2 tem dente"; PASS=$((PASS+1));
  else bad "H1 sem a precondição a linha não foi escrita (veio [$H1]) — F2 pode passar por inércia"; fi
  P -q -f "$MIG" >/dev/null
fi

# H2 — o `coalesce(...,0)` na comparação de preço: "desconhecido" passa a casar com "zero".
# Este é o defeito que o `IS NOT DISTINCT FROM` existe para impedir, e ele é invisível: a linha
# de preço NULL simplesmente deixa de casar com o plano que a descreve corretamente.
SAB2="/tmp/sabotado2-${SLUG}.sql"
sed 's/       AND oi.unit_price          IS NOT DISTINCT FROM pl.base_unit_price/       AND coalesce(oi.unit_price, 0) = coalesce(pl.base_unit_price, 0)/' "$MIG" > "$SAB2"
if ! grep -q "coalesce(oi.unit_price, 0)" "$SAB2"; then
  bad "H2.0 a sabotagem do NULL-safe NÃO alterou o arquivo — assert seria teatro"
else
  ok "H2.0 (controle da sabotagem) a comparação NULL-safe virou coalesce de fato"
  P -q -f "$SAB2" >/dev/null
  P -q -c "UPDATE public.order_items SET desconto_valor = NULL;" >/dev/null
  # Linha de preço 0 REAL, e plano que descreve preço DESCONHECIDO: com coalesce os dois viram 0
  # e a linha errada é escrita. É o "ausente = zero" com outra roupa.
  P -q -c "INSERT INTO public.order_items(id, omie_codigo_produto, quantity, unit_price) VALUES ('bbbbbbbb-0000-0000-0000-000000000006', 555, 2, 0);" >/dev/null
  Pq -c "SELECT public.desconto_backfill_aplicar('[{\"id\":\"bbbbbbbb-0000-0000-0000-000000000006\",\"desconto_valor\":77,\"base_quantity\":2,\"base_unit_price\":null,\"base_sku\":555}]'::jsonb);" >/dev/null
  H2=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE id='bbbbbbbb-0000-0000-0000-000000000006';")
  if [ "$H2" = "77" ]; then ok "H2 com coalesce, preço ZERO casa com preço DESCONHECIDO — o NULL-safe tem dente"; PASS=$((PASS+1));
  else bad "H2 o coalesce não produziu o casamento errado (veio [$H2]) — a sabotagem não exercitou o eixo"; fi
  P -q -f "$MIG" >/dev/null
fi

# H3 — o guard do plano-null some: um bug do chamador passaria a APAGAR apuração em massa.
SAB3="/tmp/sabotado3-${SLUG}.sql"
sed 's/       AND pl.desconto_valor IS NOT NULL/       AND true/' "$MIG" > "$SAB3"
if ! grep -q "AND true" "$SAB3"; then
  bad "H3.0 a sabotagem do guard de null NÃO alterou o arquivo — assert seria teatro"
else
  ok "H3.0 (controle da sabotagem) o guard de plano-null foi removido de fato"
  P -q -f "$SAB3" >/dev/null
  P -q -c "UPDATE public.order_items SET desconto_valor = 99 WHERE id='$L1';" >/dev/null
  Pq -c "SELECT public.desconto_backfill_aplicar('[{\"id\":\"$L1\",\"desconto_valor\":null,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555}]'::jsonb);" >/dev/null
  H3=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE id='$L1';")
  if [ "$H3" = "t" ]; then ok "H3 sem o guard, um plano com null APAGA apuração existente — F5 tem dente"; PASS=$((PASS+1));
  else bad "H3 sem o guard a apuração não foi apagada (IS NULL=[$H3]) — F5 pode passar por inércia"; fi
  P -q -f "$MIG" >/dev/null
fi

echo "═══ RESULTADO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ]
