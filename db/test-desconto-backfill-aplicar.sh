#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════════════
# PROVA PG17 — desconto_backfill_aplicar (a escrita do backfill)
#
#     bash db/test-desconto-backfill-aplicar.sh > /tmp/t.log 2>&1; echo $?
# (NÃO pipe pra tail — engole o exit≠0.) Dois locales (lição #1483):
#     HARNESS_LC=pt_BR.UTF-8 bash db/test-desconto-backfill-aplicar.sh
#
#  F  escrita e precondição por linha — base que mudou não é escrita; comparação NULL-safe
#  I  concorrência — linha JÁ apurada por outro writer não é sobrescrita
#  J  `ja_apuradas` conta o que JÁ estava preenchido, não o que a própria chamada escreveu.
#     J3 é a LINHA DE BASE do defeito: o corpo VELHO real devolve 3 no cenário em que o
#     novo devolve 1. Sem J3, J1 verde não prova nada — o cenário poderia nem exercitar o
#     defeito.
#  P  paridade — o arquivo do `db:aplicar` instala o MESMO corpo da migration de DR
#  G  ACL — escrita de money-path fechada na fronteira
#  H  falsificação — sabota cada guard, exige VERMELHO, restaura
# ══════════════════════════════════════════════════════════════════════════════════════
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
#
# E o que a função DEVOLVE também é contrato: `ja_apuradas` separa, dentro de `recusadas`,
# "corrida perdida" de "base mudou". Até 2026-09-10 ele era contado depois do UPDATE e somava as
# linhas que a própria chamada tinha escrito (grupo J) — e o F6 desta prova CONFIRMAVA o número
# errado, porque o esperado tinha sido transcrito da saída em vez de derivado da regra.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5474}"
SLUG="desconto-backfill-aplicar"
# Os três arquivos são NOMEADOS, não achados por glob — a prova diz o que testa: a migration de
# DR vigente; a anterior, cujo corpo é o que a PROD rodava até esta correção (md5 do `prosrc`
# conferido via psql-ro em 2026-09-10); e o arquivo que o `db:aplicar` de fato manda para a PROD.
MIG="$REPO_ROOT/supabase/migrations/20260910214850_desconto_backfill_aplicar_ja_apuradas.sql"
MIG_VELHA="$REPO_ROOT/supabase/migrations/20260908220625_desconto_backfill_aplicar.sql"
DBF="$REPO_ROOT/db/aplicar-desconto-backfill-rpc.sql"
for f in "$MIG" "$MIG_VELHA" "$DBF"; do
  [ -f "$f" ] || { echo "INFRA: arquivo ausente: $f — a prova testaria o NADA"; exit 1; }
done

# Tudo o que a execução gera (cluster, log, cópias sabotadas) mora num diretório SÓ DELA: as
# duas rodadas de locale podem correr em paralelo sem uma sobrescrever a sabotagem da outra.
WORK="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$WORK/data"
export LC_ALL=C LANG=C

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
# O SERVIDOR sempre arranca sob LC_ALL=C (no macOS, sem isso o postmaster aborta). O eixo que a
# lição #1483 manda variar é a LÍNGUA DAS MENSAGENS do servidor, e essa é GUC do BANCO.
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponível neste servidor"; exit 1; }

P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# Controle do próprio eixo de locale: provoca um erro do SERVIDOR e mostra em que língua vem.
AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "═══ setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ═══"
echo "═══ controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# `desconto_valor` NULLABLE e SEM DEFAULT, como em produção. Um default aqui faria os asserts de
# NULL passarem por acidente do stub.
P -q <<'SQL'
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint, quantity numeric, unit_price numeric, desconto_valor numeric);
SQL

md5_corpo() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.desconto_backfill_aplicar(jsonb)');"; }

P -q -f "$MIG"
MD5_NOVO="$(md5_corpo)"
echo "migration aplicada: $(basename "$MIG") (md5 do corpo ${MD5_NOVO:0:12})"

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
# Nenhuma das 5 linhas tinha desconto ANTES da chamada ⇒ ja_apuradas=0. Até 2026-09-10 este
# assert esperava 2 — o número que o corpo defeituoso devolve (L1 e L4, escritas por ESTA
# chamada), transcrito da saída em vez de derivado da regra.
F6=$(echo "$R" | tr -d ' ')
eq "F6 contagens: 5 pedidas, 2 aplicadas, 3 recusadas, 0 já apuradas" "$F6" '{"pedidas":5,"aplicadas":2,"recusadas":3,"ja_apuradas":0}'

# Idempotência: reaplicar o MESMO plano não acumula nem alterna — e o reenvio é contado como o
# que é: linha que já tinha desconto quando a chamada começou.
R7=$(Pq -c "SELECT public.desconto_backfill_aplicar('[{\"id\":\"$L1\",\"desconto_valor\":10,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555}]'::jsonb);")
F7=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE id='$L1';")
eq "F7 reaplicar o mesmo plano é idempotente" "$F7" "10"
F8=$(echo "$R7" | tr -d ' ')
eq "F8 o reenvio conta como JÁ APURADA, não como base mudou" "$F8" '{"pedidas":1,"aplicadas":0,"recusadas":1,"ja_apuradas":1}'

echo "═══ I · concorrência: linha JÁ APURADA não é sobrescrita ═══"

# Achado da 2ª opinião (Codex), confirmado no código: o UPDATE comparava SKU/qtd/preço mas não
# exigia `desconto_valor IS NULL`. Um writer que preenchesse a linha entre a leitura que montou o
# plano e esta escrita seria sobrescrito — SEM divergência visível, porque o trio continua batendo.
P -q -c "UPDATE public.order_items SET desconto_valor = 55 WHERE id='$L1';" >/dev/null
RJ=$(Pq -c "SELECT public.desconto_backfill_aplicar('[{\"id\":\"$L1\",\"desconto_valor\":10,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555}]'::jsonb);")
I1=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE id='$L1';")
eq "I1 linha já apurada por outro writer NÃO é sobrescrita" "$I1" "55"
I2=$(echo "$RJ" | tr -d ' ')
eq "I2 e o motivo vem SEPARADO de 'base mudou'" "$I2" '{"pedidas":1,"aplicadas":0,"recusadas":1,"ja_apuradas":1}'
P -q -c "UPDATE public.order_items SET desconto_valor = NULL WHERE id='$L1';" >/dev/null

# Falsificação: sem o guard, a sobrescrita acontece — é o dano que I1 barra.
SABI="$WORK/sabotado-concorrencia.sql"
sed 's/       AND oi.desconto_valor IS NULL/       AND true/' "$MIG" > "$SABI"
if ! grep -q "AND true" "$SABI"; then
  bad "I3.0 a sabotagem do guard de concorrência NÃO alterou o arquivo — assert seria teatro"
else
  ok "I3.0 (controle da sabotagem) o guard de concorrência foi removido de fato"
  P -q -f "$SABI" >/dev/null
  P -q -c "UPDATE public.order_items SET desconto_valor = 55 WHERE id='$L1';" >/dev/null
  Pq -c "SELECT public.desconto_backfill_aplicar('[{\"id\":\"$L1\",\"desconto_valor\":10,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555}]'::jsonb);" >/dev/null
  I3=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE id='$L1';")
  if [ "$I3" = "10" ]; then ok "I3 sem o guard, a apuração de outro writer é SOBRESCRITA — I1 tem dente"
  else bad "I3 sem o guard não houve sobrescrita (veio [$I3]) — I1 pode passar por inércia"; fi
  P -q -f "$MIG" >/dev/null
  P -q -c "UPDATE public.order_items SET desconto_valor = NULL WHERE id='$L1';" >/dev/null
fi

echo "═══ J · ja_apuradas conta o que JÁ estava preenchido — não o que a chamada escreveu ═══"

# O cenário do achado de 2026-09-10: 3 linhas no plano, 1 já preenchida por outro writer (com a
# base batendo, para ser recusada SÓ pelo guard de concorrência), 2 aplicáveis.
J_A="cccccccc-0000-0000-0000-000000000001"  # outro writer já gravou 55
J_B="cccccccc-0000-0000-0000-000000000002"  # aplicável
J_C="cccccccc-0000-0000-0000-000000000003"  # aplicável
PLANO_J="[
  {\"id\":\"$J_A\",\"desconto_valor\":5,\"base_quantity\":1,\"base_unit_price\":50,\"base_sku\":777},
  {\"id\":\"$J_B\",\"desconto_valor\":6,\"base_quantity\":2,\"base_unit_price\":50,\"base_sku\":777},
  {\"id\":\"$J_C\",\"desconto_valor\":7,\"base_quantity\":3,\"base_unit_price\":50,\"base_sku\":777}
]"
semeia_j() {
  P -q -c "DELETE FROM public.order_items WHERE id IN ('$J_A','$J_B','$J_C');" >/dev/null
  P -q -c "INSERT INTO public.order_items(id, omie_codigo_produto, quantity, unit_price, desconto_valor) VALUES
    ('$J_A', 777, 1, 50, 55), ('$J_B', 777, 2, 50, NULL), ('$J_C', 777, 3, 50, NULL);" >/dev/null
}
chama_j() { Pq -c "SELECT public.desconto_backfill_aplicar('$PLANO_J'::jsonb);" | tr -d ' '; }

semeia_j
J1=$(chama_j)
eq "J1 cenário misto (1 já preenchida + 2 aplicáveis) → ja_apuradas=1" "$J1" '{"pedidas":3,"aplicadas":2,"recusadas":1,"ja_apuradas":1}'
J2=$(Pq -c "SELECT string_agg(coalesce(desconto_valor::text,'NULL'), ',' ORDER BY id) FROM public.order_items WHERE id IN ('$J_A','$J_B','$J_C');")
eq "J2 a escrita segue a de sempre: o 55 do outro writer fica, as 2 aplicáveis recebem o plano" "$J2" "55,6,7"

# Id REPETIDO no plano (mesmo valor, base batendo). É o caso que separa "contar antes" de
# "subtrair depois": o UPDATE escreve a linha UMA vez e o RETURNING devolve UMA linha.
J_D="cccccccc-0000-0000-0000-000000000004"
PLANO_DUP="[
  {\"id\":\"$J_D\",\"desconto_valor\":8,\"base_quantity\":4,\"base_unit_price\":50,\"base_sku\":777},
  {\"id\":\"$J_D\",\"desconto_valor\":8,\"base_quantity\":4,\"base_unit_price\":50,\"base_sku\":777}
]"
semeia_dup() {
  P -q -c "DELETE FROM public.order_items WHERE id='$J_D';" >/dev/null
  P -q -c "INSERT INTO public.order_items(id, omie_codigo_produto, quantity, unit_price, desconto_valor) VALUES ('$J_D', 777, 4, 50, NULL);" >/dev/null
}
chama_dup() { Pq -c "SELECT public.desconto_backfill_aplicar('$PLANO_DUP'::jsonb);" | tr -d ' '; }

semeia_dup
J3D=$(chama_dup)
eq "J3 id repetido, aplicado por ESTA chamada, NÃO é 'já apurado'" "$J3D" '{"pedidas":2,"aplicadas":1,"recusadas":1,"ja_apuradas":0}'

# LINHA DE BASE DO DEFEITO — o corpo VELHO real (a migration anterior, byte a byte o que a PROD
# rodava) nos MESMOS cenários. Ele TEM de devolver os números errados: é isso que mostra que os
# cenários exercitam o defeito. Se devolvesse os certos, J1/J3 verdes seriam inércia.
P -q -f "$MIG_VELHA" >/dev/null
MD5_VELHO="$(md5_corpo)"
semeia_j
J4=$(chama_j)
eq "J4 (linha de base) o corpo VELHO conta as próprias escritas: 3 onde o certo é 1" "$J4" '{"pedidas":3,"aplicadas":2,"recusadas":1,"ja_apuradas":3}'
semeia_dup
J5D=$(chama_dup)
# O corpo velho conta DEPOIS do UPDATE, então o `ja_apuradas` dele É o "preenchidas_depois". A
# alternativa `preenchidas_depois - aplicadas` sai daqui sem reimplementar nada.
SUBTRACAO=$(Pq -c "SELECT ('$J5D'::jsonb->>'ja_apuradas')::int - ('$J5D'::jsonb->>'aplicadas')::int;")
eq "J5 (contrafactual) a subtração preenchidas_depois − aplicadas daria 1 onde o certo é 0 — não é equivalente" "$SUBTRACAO" "1"

P -q -f "$MIG" >/dev/null
J6=$(md5_corpo)
eq "J6 restauração: o corpo voltou a ser o da migration nova" "$J6" "$MD5_NOVO"
if [ -n "$MD5_VELHO" ] && [ "$MD5_VELHO" != "$MD5_NOVO" ]; then
  ok "J7 (controle) os corpos velho e novo DIFEREM — J6 e P1 não passam por md5 constante"
else
  bad "J7 os corpos velho e novo têm o MESMO md5 [$MD5_VELHO] — J6/P1 seriam verdes por construção"
fi

echo "═══ P · paridade: o arquivo do db:aplicar instala o MESMO corpo da migration de DR ═══"

# Tudo acima testa a MIGRATION; quem vai para a PROD é o arquivo do `db:aplicar`. Sem esta
# paridade a prova certificaria um arquivo que ninguém aplica. Parte do corpo VELHO, para P1
# medir uma TROCA e não inércia. `-1` = uma transação só, como o executor (o arquivo não traz
# BEGIN/COMMIT — o `db:aplicar` o recusaria se trouxesse).
P -q -f "$MIG_VELHA" >/dev/null
P -q -1 -f "$DBF" >/dev/null
P1=$(md5_corpo)
eq "P1 o arquivo do db:aplicar instala o corpo da migration nova (md5)" "$P1" "$MD5_NOVO"

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
SAB="$WORK/sabotado-precondicao.sql"
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
  if [ "$H1" = "20" ]; then ok "H1 sem a precondição, a linha DESATUALIZADA é escrita — F2 tem dente"
  else bad "H1 sem a precondição a linha não foi escrita (veio [$H1]) — F2 pode passar por inércia"; fi
  P -q -f "$MIG" >/dev/null
fi

# H2 — o `coalesce(...,0)` na comparação de preço: "desconhecido" passa a casar com "zero".
# Este é o defeito que o `IS NOT DISTINCT FROM` existe para impedir, e ele é invisível: a linha
# de preço NULL simplesmente deixa de casar com o plano que a descreve corretamente.
SAB2="$WORK/sabotado-null-safe.sql"
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
  if [ "$H2" = "77" ]; then ok "H2 com coalesce, preço ZERO casa com preço DESCONHECIDO — o NULL-safe tem dente"
  else bad "H2 o coalesce não produziu o casamento errado (veio [$H2]) — a sabotagem não exercitou o eixo"; fi
  P -q -f "$MIG" >/dev/null
fi

# H3 — o guard do plano-null some: um bug do chamador passaria a APAGAR apuração em massa.
SAB3="$WORK/sabotado-plano-null.sql"
sed -e 's/       AND pl.desconto_valor IS NOT NULL/       AND true/' \
    -e 's/       AND oi.desconto_valor IS NULL/       AND true/' "$MIG" > "$SAB3"
# DOIS guards protegem este eixo desde o achado de concorrência (Codex): `pl...IS NOT NULL` barra
# o plano que manda null, e `oi...IS NULL` barra o UPDATE de linha já apurada. Sabotar UM só deixa
# o outro segurando — e o assert leria "não houve dano" como "o guard tem dente", que é o inverso.
# Por isso a sabotagem remove os dois: o que se mede é se ALGUÉM ainda protege o eixo.
if [ "$(grep -c 'AND true' "$SAB3")" -ne 2 ]; then
  bad "H3.0 a sabotagem NÃO removeu os DOIS guards — com um de pé o assert mediria o guard errado"
else
  ok "H3.0 (controle da sabotagem) os dois guards do eixo foram removidos de fato"
  P -q -f "$SAB3" >/dev/null
  P -q -c "UPDATE public.order_items SET desconto_valor = 99 WHERE id='$L1';" >/dev/null
  Pq -c "SELECT public.desconto_backfill_aplicar('[{\"id\":\"$L1\",\"desconto_valor\":null,\"base_quantity\":2,\"base_unit_price\":100,\"base_sku\":555}]'::jsonb);" >/dev/null
  H3=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE id='$L1';")
  if [ "$H3" = "t" ]; then ok "H3 sem o guard, um plano com null APAGA apuração existente — F5 tem dente"
  else bad "H3 sem o guard a apuração não foi apagada (IS NULL=[$H3]) — F5 pode passar por inércia"; fi
  P -q -f "$MIG" >/dev/null
fi

# O formato da linha abaixo é o que `db/roda-nucleo-ci.sh` extrai — `<pass> ok / <fail> fail`.
echo "═══ RESULTADO: $PASS ok / $FAIL fail ═══"
[ "$FAIL" -eq 0 ]
