#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — a exclusão NOMINAL do total líquido: os DOIS applies, EXECUTADOS              ║
# ║   bash db/test-pedido-total-liquido-excecao.sh               > "$LOG" 2>&1                 ║
# ║   bash db/test-pedido-total-liquido-excecao.sh --falsificar  > "$LOG" 2>&1                 ║
# ╚════════════════════════════════════════════════════════════════════════════════════════════╝
# POR QUE ESTE HARNESS EXISTE (e não bastava o ensaio em produção):
# o apply 2 (a conversão) NÃO PODE ser ensaiado em prod — `db:aplicar --ensaio` faz ROLLBACK, então
# no ensaio a tabela de exceção nem existe e o pré-voo recusa (corretamente). A única forma de ver o
# par inteiro rodar antes de valer dinheiro é aqui: PG17 local, migrations reais, os dois .sql
# EXECUTADOS na ordem. PL/pgSQL é late-bound — CREATE passa, o erro mora no runtime.
#
# O que este harness afirma, e o ensaio em prod não podia:
#   · o pré-voo do apply 2 RECUSA sem o apply 1, e recusa PELO MOTIVO CERTO (A1/A1b);
#   · a substituição programática (pg_get_functiondef + replace ancorado) produz corpo que EXECUTA;
#   · a guarda de 48h mantém o pedido EM VOO fora da lista — e o mês dele continua BLOQUEADO
#     (fail-closed custa: é o lado certo de errar, e aqui o custo fica VISÍVEL, não suposto);
#   · o apply 2 converte só o mês destravado, e nenhum excluído recebe número (`ausente ≠ zero`);
#   · reaplicar o apply 1 é idempotente; reaplicar o apply 2 FALHA em vez de escrever de novo.
#
# `--falsificar` usa o idioma SABOTAGENS: cada entrada DECLARA o assert que tem de acusá-la, o laço
# re-invoca a suíte INTEIRA com `SABOTAGEM=<nome>` e só conta a rodada se (a) o controle ficou verde
# ANTES, (b) a sabotagem APLICOU de verdade (a marca `SABOTAGEM ativa:`) e (c) o assert DECLARADO
# virou vermelho. Veredito por exit code aceitaria vermelho de ambiente — e aí a suíte aprova tudo.
set -euo pipefail

MODO="normal"
case "${1:-}" in
  "") ;;
  --falsificar) MODO="falsificar" ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5489}"
SABOTAGEM="${SABOTAGEM:-}"
SLUG="pedido-total-liquido-excecao"

# ════════════════════════════════════ modo --falsificar ══════════════════════════════════════
# A3 fica de fora das declarações de propósito: é o sensor do cupom ANTES de qualquer apply, e
# nenhuma sabotagem dos applies pode movê-lo. Declarar A3 seria declarar o que não depende delas.
if [ "$MODO" = "falsificar" ]; then
  SABOTAGENS="guarda48_fora:A4
              ancora_adulterada:A4
              filtro_neutralizado:A4
              prevoo_tabela_cego:A1b
              duas_camadas_fora:A6,A7
              canonica_corpo_1token:C2,C3
              canonica_sem_guardas_sem_not_exists:C3,C5
              canonica_pre_errada:C2
              canonica_grant_auth:C2
              canonica_tabela_sem_check:C2
              canonica_tabela_check_fraco:C2
              canonica_grant_maintain:C2"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar: sempre-vermelha aprova qualquer sabotagem"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; verm="${item#*:}"
    porta=$((porta + 1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte VERDE com a sabotagem ativa: o assert NÃO tem dente"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO aplicou: quebrou outra coisa"
      grep -E 'FALHOU|ERROR' "$log" | head -3 | sed 's/^/       /'; falhas=$((falhas+1)); continue
    fi
    faltou=""
    for x in ${verm//,/ }; do grep -Eq "❌ ${x} " "$log" || faltou="$faltou $x"; done
    if [ -z "$faltou" ]; then
      echo "  ✅ $sab — vermelha em [$verm]: $(grep -m1 -oE 'ERROR:.{0,80}' "$log" || echo 'sem ERROR (assert puro)')"
    else
      echo "  ❌ $sab — devia ficar vermelha em:$faltou"; falhas=$((falhas+1))
    fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens no assert DECLARADO ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ FALSIFICAÇÃO FALHOU: $falhas ═══"; exit 1
fi

# ═════════════════════════════════════ a suíte ═══════════════════════════════════════════════
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/prova-${SLUG}.XXXXXX")"
# shellcheck disable=SC2329  # `cleanup` é invocada indiretamente, pelo `trap` (o shellcheck não vê).
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")" "$TMPD"
}
trap cleanup EXIT

MIG1="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_total_liquido_acervo.sql" | sort | tail -1)"
MIG2="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_total_liquido_acervo_mes_entre_contas.sql" | sort | tail -1)"
COER="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_venda_coerencia_agregado.sql" | sort | tail -1)"
DBF="$REPO_ROOT/db/aplicar-pedido-total-liquido-rpc.sql"
A1_SRC="$REPO_ROOT/db/2026-10-05-pedido-total-liquido-excecao.sql"
A2_SRC="$REPO_ROOT/db/2026-10-05-pedido-total-liquido-converter-acervo.sql"
CANON_SRC="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_total_liquido_converter_canonica_*.sql" | sort | tail -1)"
for f in "$MIG1" "$MIG2" "$COER" "$DBF" "$A1_SRC" "$A2_SRC" "$CANON_SRC"; do
  if [ -z "$f" ] || [ ! -f "$f" ]; then echo "FALTA ARQUIVO [$f] — o harness testaria o NADA"; exit 1; fi
done

# ── A sabotagem, quando houver: cópia em $TMPD, NUNCA os .sql de db/ ─────────────────────────
# Cada `sed` é conferido com `cmp`: âncora que morreu deixaria a rodada VERDE por não sabotar nada,
# e o laço leria isso como "o assert não tem dente" — vermelho pelo motivo errado.
A1="$A1_SRC"; A2="$A2_SRC"
sabotar() {   # sabotar <destino> <fonte> <sed...>
  local dst="$1" src="$2"; shift 2
  sed "$@" "$src" > "$dst"
  if cmp -s "$src" "$dst"; then echo "SABOTAGEM INERTE: o sed não mudou nada em $src"; exit 1; fi
}
sabotar_perl() {   # sabotar_perl <destino> <fonte> <programa perl -0pe> — sabotagem multi-linha (blocos DO)
  local dst="$1" src="$2" prog="$3"
  perl -0pe "$prog" "$src" > "$dst"
  if cmp -s "$src" "$dst"; then echo "SABOTAGEM INERTE: o perl não mudou nada em $src"; exit 1; fi
}
# O passo 2 do apply 1 usa `p.updated_at <`; a postcondição (c) usa `so.updated_at >=`. São âncoras
# distintas DE PROPÓSITO: dá para derrubar a guarda sem tocar seu verificador, que é o único jeito de
# saber qual camada pega o quê (money-path.md: sabote UMA por vez; a que fica verde é redundante).
S_GUARDA=(-e "s/p\.updated_at < now() - interval '48 hours'/p.updated_at < now() - interval '0 hours'/")
S_VERIF=(-e "s/so\.updated_at >= now() - interval '48 hours'/so.updated_at >= now() + interval '1 hour'/")
# shellcheck disable=SC2016  # as sabotagens canonica_* são programas perl: o $ é do perl, não do shell
case "$SABOTAGEM" in
  "") ;;
  guarda48_fora)       sabotar "$TMPD/a1.sql" "$A1_SRC" "${S_GUARDA[@]}"; A1="$TMPD/a1.sql" ;;
  duas_camadas_fora)   sabotar "$TMPD/a1.sql" "$A1_SRC" "${S_GUARDA[@]}" "${S_VERIF[@]}"; A1="$TMPD/a1.sql" ;;
  ancora_adulterada)   sabotar "$TMPD/a1.sql" "$A1_SRC" \
                         -e "s/WITH c AS MATERIALIZED (/WITH c AS MATERIALIZED ( --x/"; A1="$TMPD/a1.sql" ;;
  filtro_neutralizado) sabotar "$TMPD/a1.sql" "$A1_SRC" \
                         -e "s/WHERE x.sales_order_id = z.sales_order_id/WHERE x.sales_order_id = z.sales_order_id AND false/"
                       A1="$TMPD/a1.sql" ;;
  prevoo_tabela_cego)  sabotar "$TMPD/a2.sql" "$A2_SRC" \
                         -e "s/to_regclass('public.pedido_total_liquido_excecao') IS NULL/false/"; A2="$TMPD/a2.sql" ;;
  # ── a canônica (seção C): integridade (a migration ABORTA) × comportamento (guardas fora, o assert acusa)
  canonica_corpo_1token)   sabotar_perl "$TMPD/canon.sql" "$CANON_SRC" \
                             's/WHERE NOT EXISTS \(SELECT 1/WHERE NOT EXISTS (SELECT 2/'; CANON="$TMPD/canon.sql" ;;
  canonica_sem_guardas_sem_not_exists)
                           sabotar_perl "$TMPD/canon.sql" "$CANON_SRC" \
                             's/WHERE x\.sales_order_id = z\.sales_order_id\)/WHERE x.sales_order_id = z.sales_order_id AND false)/; s/DO \$pre\$.*?\$pre\$;//s; s/DO \$pos\$.*?\$pos\$;//s'
                           CANON="$TMPD/canon.sql" ;;
  canonica_pre_errada)     sabotar_perl "$TMPD/canon.sql" "$CANON_SRC" \
                             "s/'0cdb517ed0e81b65e1330d815fde6784'/'00000000000000000000000000000000'/"; CANON="$TMPD/canon.sql" ;;
  canonica_grant_auth)     sabotar_perl "$TMPD/canon.sql" "$CANON_SRC" \
                             's/(GRANT EXECUTE ON FUNCTION public\.pedido_total_liquido_converter\([^)]*\) TO service_role;)/$1\nGRANT EXECUTE ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamp with time zone, text[], date, date, integer, boolean) TO authenticated;/'
                           CANON="$TMPD/canon.sql" ;;
  canonica_tabela_sem_check)
                           sabotar_perl "$TMPD/canon.sql" "$CANON_SRC" \
                             's/ CHECK \(length\(btrim\(evidencia\)\) > 0\)//'; CANON="$TMPD/canon.sql" ;;
  canonica_tabela_check_fraco)
                           sabotar_perl "$TMPD/canon.sql" "$CANON_SRC" \
                             's/CHECK \(length\(btrim\(evidencia\)\) > 0\)/CHECK (length(btrim(evidencia)) >= 0)/'; CANON="$TMPD/canon.sql" ;;
  canonica_grant_maintain) sabotar_perl "$TMPD/canon.sql" "$CANON_SRC" \
                             's/(GRANT SELECT ON public\.pedido_total_liquido_excecao TO service_role;)/$1\nGRANT MAINTAIN ON public.pedido_total_liquido_excecao TO authenticated;/'; CANON="$TMPD/canon.sql" ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "$SABOTAGEM" ] || echo "SABOTAGEM ativa: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
nok() { FAIL=$((FAIL+1)); printf '  ❌ %s\n' "$1"; }
# asserta <id> <esperado> <obtido> <descrição>
asserta() { if [ "$2" = "$3" ]; then ok "$1 OK — $4"; else nok "$1 FALHOU — $4: esperado '$2', obtido '$3'"; fi; }

SCHEMA="$TMPD/schema.sql"
cat > "$SCHEMA" <<'SQL'
ALTER ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho',
  omie_pedido_id bigint, account text NOT NULL DEFAULT 'oben', hash_payload text,
  order_date_kpi date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
-- `desconto_valor` como em prod: numeric, NULLABLE, SEM DEFAULT — um DEFAULT 0 faria todo
-- "não apurado" passar por acidente do stub, e era justo o eixo desta prova.
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric DEFAULT 0,
  desconto_valor numeric,
  created_at timestamptz DEFAULT now());
CREATE INDEX idx_order_items_sales_order ON public.order_items (sales_order_id);
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;
CREATE TRIGGER update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
SQL

FIXT="$TMPD/fixtures.sql"
cat > "$FIXT" <<'SQL'
CREATE OR REPLACE FUNCTION public.t_pedido(
  p_id uuid, p_conta text, p_dia date, p_total numeric, p_linhas jsonb,
  p_atualizado timestamptz DEFAULT '2026-09-01 12:00:00+00')
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.sales_orders (id, customer_user_id, created_by, items, subtotal, discount, total,
                                   status, omie_pedido_id, account, hash_payload, order_date_kpi,
                                   created_at, updated_at)
  VALUES (p_id, '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
          (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'omie_codigo_produto', (l->>'sku')::bigint, 'quantidade', (l->>'q')::numeric,
                    'valor_unitario', (l->>'p')::numeric, 'desconto', 0)), '[]'::jsonb)
             FROM jsonb_array_elements(p_linhas) l),
          p_total, 0, p_total, 'importado', abs(hashtext(p_id::text))::bigint,
          p_conta, 'omie_' || p_conta || '_' || p_id::text, p_dia, p_atualizado, p_atualizado);
  INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto,
                                  quantity, unit_price, discount, desconto_valor)
  SELECT p_id, '11111111-1111-1111-1111-111111111111', (l->>'sku')::bigint, (l->>'q')::numeric,
         (l->>'p')::numeric, 0, (l->>'d')::numeric   -- sem "d" na linha => desconto_valor NULL
    FROM jsonb_array_elements(p_linhas) l;
$f$;

-- JULHO/2026 — destrava pela exclusão: 1 convertível + 2 bloqueadores PARADOS
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d1', 'oben', '2026-07-05', 100,
  '[{"sku":1001,"q":1,"p":100,"d":10}]');                      -- convertível: líquido 90
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d2', 'oben', '2026-07-06', 50,
  '[{"sku":1002,"q":1,"p":50}]');                              -- sem_apuracao (toda linha NULL)
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d3', 'oben', '2026-07-07', 100,
  '[{"sku":1003,"q":1,"p":40,"d":4},{"sku":1004,"q":1,"p":60}]'); -- apuracao_parcial

-- JUNHO/2026 — NÃO destrava: o bloqueador está EM VOO (a guarda de 48h o deixa fora da lista)
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d4', 'oben', '2026-06-05', 200,
  '[{"sku":2001,"q":1,"p":200,"d":20}]');                      -- convertível, mas o mês fica preso
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d5', 'oben', '2026-06-06', 30,
  '[{"sku":2002,"q":1,"p":30}]', now() - interval '1 hour');   -- EM VOO: churn de reprocesso
SQL

P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q -f "$SCHEMA"
P -q -f "$COER"
P -q -f "$MIG1"
P -q -f "$MIG2"
P -q -1 -f "$DBF"
P -q -f "$FIXT"
echo "=== setup pronto (PG17 :$PORT) ==="

# Roda um apply como o envelope roda: UMA transação (-1) e marcador positivo de fim. Ecoa "ok", ou a
# 1ª linha de ERROR — o veredito é o MARCADOR, nunca o exit (o `-1` sai 0 com ERROR em alguns casos).
# O ERROR vai para ARQUIVO, não para variável: todo chamador usa `$(aplicar …)`, que é SUBSHELL —
# variável setada lá dentro não volta, e o A1b lia vazio em silêncio (medido, 2026-10-06).
APPLY_ERR_F="$TMPD/apply.err"
: > "$APPLY_ERR_F"
aplicar() {
  local sql="$1" out="$TMPD/apply.out" rc=0 err=""
  : > "$APPLY_ERR_F"
  P -1 -f "$sql" > "$out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'FIM_APLICACAO_OK' "$out"; then echo "ok"; return 0; fi
  err="$(grep -m1 -o 'ERROR:.*' "$out" || true)"
  printf '%s' "$err" > "$APPLY_ERR_F"
  if [ -n "$err" ]; then printf '%s\n' "$err" | cut -c1-150
  else echo "rc=$rc sem ERROR e sem marcador — o apply saiu 0 calado"; fi
  return 1
}
# O sensor do cupom: a query que mede o que o CLIENTE vê (pedidos cujo cabeçalho segue bruto).
sensor() {
  Pq -c "SELECT count(*) FROM (SELECT oi.sales_order_id, sum(oi.quantity*oi.unit_price) bruto,
                                      sum(oi.desconto_valor) desc_
                                 FROM public.order_items oi GROUP BY 1
                                HAVING count(*) FILTER (WHERE oi.desconto_valor > 0) > 0) l
           JOIN public.sales_orders so ON so.id = l.sales_order_id
          WHERE round(l.bruto - l.desc_, 2) <> round(so.total, 2);"
}
elegiveis() {
  Pq -c "SELECT (public.pedido_total_liquido_converter(false, '2026-09-14 20:09:13+00', NULL,
                   '2025-09-01', '2026-10-01')->>'elegiveis')::int;" 2>/dev/null || echo "erro"
}
total_de() { Pq -c "SELECT round(total,2)::text FROM public.sales_orders WHERE id = '$1';"; }
na_lista() {
  Pq -c "SELECT count(*) FROM public.pedido_total_liquido_excecao WHERE sales_order_id = '$1';" \
    2>/dev/null || echo "erro"
}

echo "── A prova negativa: o apply 2 sem o apply 1 ──"
r="$(aplicar "$A2" || true)"
if [ "$r" = "ok" ]; then nok "A1 FALHOU — o pré-voo do apply 2 deixou passar sem a tabela de exceção"
else ok "A1 OK — o apply 2 recusa sem o apply 1"; fi
# A1b: a recusa tem de vir do pré-voo da TABELA, não de outro ramo. Sem casar a MARCA, cegar o 1º
# cinto do pré-voo passaria invisível — o 2º cinto recusaria igual e a suíte ficaria verde.
case "$(cat "$APPLY_ERR_F")" in
  *"a tabela pedido_total_liquido_excecao NAO existe"*) ok "A1b OK — a recusa é do pré-voo da TABELA" ;;
  *) nok "A1b FALHOU — a recusa não é do pré-voo da tabela: [$(cut -c1-90 "$APPLY_ERR_F")]" ;;
esac

echo "── O estado ANTES: o gate prende os dois meses ──"
asserta A2 "0" "$(elegiveis)" "elegíveis antes do apply 1"
asserta A3 "3" "$(sensor)"    "sensor do cupom antes (os 2 convertíveis + o parcial)"

echo "── Apply 1: instala a exceção e patcheia o conversor ──"
asserta A4 "ok" "$(aplicar "$A1" || true)" "o apply 1 roda inteiro e deixa o marcador"
asserta A5 "t" "$(Pq -c "SELECT relrowsecurity FROM pg_class
                          WHERE oid='public.pedido_total_liquido_excecao'::regclass;" 2>/dev/null || echo erro)" \
  "RLS ligada na tabela de exceção"
asserta A6 "2" "$(Pq -c "SELECT count(*) FROM public.pedido_total_liquido_excecao;" 2>/dev/null || echo erro)" \
  "a lista tem exatamente os 2 bloqueadores PARADOS"
asserta A7 "0" "$(na_lista '00000000-0000-0000-0000-00000000c0d5')" \
  "a guarda de 48h deixou o pedido EM VOO fora da lista"
asserta A8 "apuracao_parcial,sem_apuracao" \
  "$(Pq -c "SELECT string_agg(motivo, ',' ORDER BY motivo) FROM public.pedido_total_liquido_excecao;" \
      2>/dev/null || echo erro)" "motivos classificados por medição local"
asserta A9 "1" "$(Pq -c "SELECT (length(d)-length(replace(d,'pedido_total_liquido_excecao x',''))) /
                                length('pedido_total_liquido_excecao x')
                           FROM pg_get_functiondef('public.pedido_total_liquido_converter(boolean,timestamptz,text[],date,date,integer,boolean)'::regprocedure) d;" \
                   2>/dev/null || echo erro)" "o corpo vivo passou a ler a tabela (o patch pegou, 1×)"

echo "── Idempotência: reaplicar o apply 1 não duplica nada ──"
asserta A10 "ok" "$(aplicar "$A1" || true)" "o apply 1 roda de novo"
asserta A11 "2" "$(Pq -c "SELECT count(*) FROM public.pedido_total_liquido_excecao;" 2>/dev/null || echo erro)" \
  "a lista segue com 2 depois da 2ª passada"

echo "── O destravamento é NOMINAL: julho sai, junho fica ──"
asserta A12 "1" "$(elegiveis)" "elegíveis depois do apply 1 (só o convertível de julho)"

echo "── Apply 2: a conversão ──"
asserta A13 "ok" "$(aplicar "$A2" || true)" "o apply 2 roda inteiro e deixa o marcador"
asserta A14 "90.00"  "$(total_de '00000000-0000-0000-0000-00000000c0d1')" "o convertível virou LÍQUIDO"
asserta A15 "200.00" "$(total_de '00000000-0000-0000-0000-00000000c0d4')" "junho intacto — segue preso pelo em voo"
asserta A16 "50.00"  "$(total_de '00000000-0000-0000-0000-00000000c0d2')" "excluído segue com cabeçalho BRUTO (ausente != zero)"
asserta A17 "100.00" "$(total_de '00000000-0000-0000-0000-00000000c0d3')" "excluído parcial segue com cabeçalho BRUTO"
asserta A18 "30.00"  "$(total_de '00000000-0000-0000-0000-00000000c0d5')" "o pedido em voo ficou intocado"
asserta A19 "2" "$(sensor)" "o sensor do cupom caiu exatamente 1 (3 -> 2)"

echo "── Reaplicar o apply 2 FALHA em vez de escrever de novo ──"
r2="$(aplicar "$A2" || true)"
if [ "$r2" = "ok" ]; then nok "A20 FALHOU — o apply 2 rodou 2× sem reclamar: dupla escrita silenciosa"
else ok "A20 OK — o apply 2 recusa a 2ª passada"; fi

# ═══════════════════════════════════════════════════════════════════════════════════════════
# C · I2 (plano v2, item 5): a migration CANÔNICA reproduz o corpo da PROD byte a byte — e EXECUTA
# ═══════════════════════════════════════════════════════════════════════════════════════════
# O apply 1 deixou em prod um conversor (e uma tabela) que nenhuma migration explicava. A canônica
# (20261019120100_pedido_total_liquido_converter_canonica_*) copia o corpo do hex da prod e declara a
# tabela. Dois caminhos, o MESMO md5(prosrc): cadeia + apply 1 (`prove`) e cadeia + canônica
# (`prove_c`, o restore só de migrations). Sobre a canônica: a exceção nominal destrava o mês, o não
# listado segue bloqueando, o excluído nunca converte (apply 2 real), reaplicar sobre o corpo da prod
# é no-op, e a PRE recusa corpo estranho.
echo "── C · a canônica (I2): mesmo corpo da prod, pelo caminho do restore ──"
CANON_B="$CANON_SRC"
CANON="${CANON:-$CANON_B}"   # uma sabotagem canonica_* troca o arquivo aqui
MD5_PRED_B="0cdb517ed0e81b65e1330d815fde6784"   # md5(prosrc) que a 20260914193000 (e o DBF) deixam
MD5_PROD_B="4d88eebd9dea026346d706befca0fced"   # md5(prosrc) da PROD em 2026-10-19 (= depois do apply 1)
CONV_ID="public.pedido_total_liquido_converter(boolean,timestamptz,text[],date,date,integer,boolean)"
PC()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove_c -v ON_ERROR_STOP=1 "$@"; }
PCq() { PC -tA "$@"; }
md5_conv()   { "$1" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$CONV_ID')"; }
elegiveis_c() {
  PCq -c "SELECT (public.pedido_total_liquido_converter(false, '2026-09-14 20:09:13+00', NULL,
                   '2025-09-01', '2026-10-01')->>'elegiveis')::int;" 2>/dev/null || echo "erro"
}
excecoes_c() {
  PCq -c "SELECT public.pedido_total_liquido_converter(false, '2026-09-14 20:09:13+00', NULL,
                   '2025-09-01', '2026-10-01') #>> '{escopo,excecoes_ativas}';" 2>/dev/null || echo "erro"
}
total_c() { PCq -c "SELECT round(total,2)::text FROM public.sales_orders WHERE id = '$1';"; }
aplicar_c() {
  local sql="$1" out="$TMPD/apply-c.out" rc=0
  PC -1 -f "$sql" > "$out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'FIM_APLICACAO_OK' "$out"; then echo "ok"; return 0; fi
  grep -m1 -o 'ERROR:.*' "$out" | cut -c1-150 || echo "rc=$rc sem ERROR"
  return 1
}
asserta C0 "$MD5_PROD_B" "$(md5_conv Pq)" "(controle) o apply 1 deixou em prove EXATAMENTE o corpo da PROD"
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove_c
PC -q -f "$REPO_ROOT/db/stubs-supabase.sql"
PC -q -f "$SCHEMA"
PC -q -f "$COER"
PC -q -f "$MIG1"
PC -q -f "$MIG2"
PC -q -1 -f "$DBF"
PC -q -f "$FIXT"
asserta C1 "$MD5_PRED_B" "$(md5_conv PCq)" "antes da canônica o corpo é o predecessor revisado (a cadeia aqui é a de prod)"
asserta C1b "false" "$(PCq -c "SELECT (to_regclass('public.pedido_total_liquido_excecao') IS NOT NULL)::text")" "e a tabela de exceção NÃO existe (só o envelope a criava)"
OUT_C="$(PC -q -f "$CANON" 2>&1 || true)"
asserta C2 "nao" "$(if grep -q 'ERROR' <<<"$OUT_C"; then echo sim; else echo nao; fi)" "a canônica roda inteira sobre o predecessor (tabela + TRAVA → PRE → CREATE → PÓS)"
asserta C3 "$MD5_PROD_B" "$(md5_conv PCq)" "e deixa o corpo da PROD, byte a byte (= apply 1 = prod)"
asserta C3b 'false/v/search_path=public, pg_temp/p_aplicar boolean, p_corte timestamp with time zone, p_contas text[] DEFAULT NULL::text[], p_mes_de date DEFAULT NULL::date, p_mes_ate date DEFAULT NULL::date, p_limite integer DEFAULT 5000, p_exigir_mes_completo boolean DEFAULT true' \
  "$(PCq -c "SELECT prosecdef::text || '/' || provolatile::text || '/' || coalesce(array_to_string(proconfig, ';'), '-') || '/' || pg_get_function_arguments(oid) FROM pg_proc WHERE oid = to_regprocedure('$CONV_ID')")" \
  "contrato fora do prosrc: INVOKER, VOLATILE, search_path, assinatura COM defaults"
asserta C3c "f/f/t" \
  "$(PCq -c "SELECT concat_ws('/', has_function_privilege('anon', o, 'EXECUTE'), has_function_privilege('authenticated', o, 'EXECUTE'), has_function_privilege('service_role', o, 'EXECUTE')) FROM to_regprocedure('$CONV_ID') o")" \
  "ACL da função: EXECUTE só para service_role entre as roles da API"
asserta C3d "true/0/-/-/true" \
  "$(PCq -c "SELECT relrowsecurity::text || '/' || (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) || '/'
                   || coalesce((SELECT string_agg(pr, ',') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr WHERE has_table_privilege('anon', c.oid, pr)), '-') || '/'
                   || coalesce((SELECT string_agg(pr, ',') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr WHERE has_table_privilege('authenticated', c.oid, pr)), '-') || '/'
                   || has_table_privilege('service_role', c.oid, 'SELECT')::text
              FROM pg_class c WHERE c.oid = 'public.pedido_total_liquido_excecao'::regclass")" \
  "tabela: RLS ligada, zero policies, NADA para anon/authenticated (nem TRUNCATE, nem MAINTAIN), SELECT para service_role"
asserta C4 "0" "$(elegiveis_c)" "sem exceção listada o gate prende os dois meses (fail-closed por omissão)"
PC -q -c "INSERT INTO public.pedido_total_liquido_excecao (sales_order_id, motivo, evidencia, criado_por, revisar_em) VALUES
  ('00000000-0000-0000-0000-00000000c0d2', 'sem_apuracao',     'prova C: nenhuma linha apurada', 'db/test', '2026-12-31'),
  ('00000000-0000-0000-0000-00000000c0d3', 'apuracao_parcial', 'prova C: linha apurada + linha NULL', 'db/test', '2026-12-31');" \
  || echo "  (C5) o INSERT na tabela de exceção falhou — nesta rodada a canônica não a deixou"
asserta C5 "1/2" "$(elegiveis_c)/$(excecoes_c)" "a exceção NOMINAL destrava julho, junho (em voo, não listado) segue preso — e o retorno publica escopo.excecoes_ativas"
# Isolar "excluído NUNCA converte" (parecer Codex de código, P2): os 2 excluídos acima já não converteriam
# por falta de apuração; só um CONVERTÍVEL listado prova que a lista manda mais que a classe.
PC -q -c "INSERT INTO public.pedido_total_liquido_excecao (sales_order_id, motivo, evidencia, criado_por, revisar_em) VALUES
  ('00000000-0000-0000-0000-00000000c0d1', 'apuracao_parcial', 'prova C5b: convertível listado de propósito', 'db/test', '2026-12-31');" \
  || echo "  (C5b) o INSERT falhou — nesta rodada a canônica não deixou a tabela"
asserta C5b "0/3" "$(elegiveis_c)/$(excecoes_c)" "o convertível LISTADO sai do universo (0 elegíveis, 3 exceções): a lista manda mais que a classe"
PC -q -c "DELETE FROM public.pedido_total_liquido_excecao WHERE sales_order_id = '00000000-0000-0000-0000-00000000c0d1';" || true
asserta C5c "1/2" "$(elegiveis_c)/$(excecoes_c)" "e removido da lista volta a ser elegível (a exclusão é só nominal)"
asserta C6 "ok" "$(aplicar_c "$A2_SRC" || true)" "o apply 2 (conversão REAL) roda sobre o corpo da canônica"
asserta C6b "90.00/200.00/50.00/100.00/30.00" \
  "$(total_c 00000000-0000-0000-0000-00000000c0d1)/$(total_c 00000000-0000-0000-0000-00000000c0d4)/$(total_c 00000000-0000-0000-0000-00000000c0d2)/$(total_c 00000000-0000-0000-0000-00000000c0d3)/$(total_c 00000000-0000-0000-0000-00000000c0d5)" \
  "convertível LÍQUIDO; junho intacto; os 2 excluídos NUNCA convertem (ausente != zero); o em voo intocado"
OUT_NEG="$(PCq -c "SET ROLE authenticated; SELECT public.pedido_total_liquido_converter(false, now())" 2>&1 || true)"
asserta C7 "sim" "$(if grep -q 'permission denied for function pedido_total_liquido_converter' <<<"$OUT_NEG"; then echo sim; else echo nao; fi)" "authenticated EXECUTANDO leva permission denied"
OUT_C2="$(P -q -f "$CANON" 2>&1 || true)"
asserta C8 "nao/$MD5_PROD_B" "$(if grep -q 'ERROR' <<<"$OUT_C2"; then echo sim; else echo nao; fi)/$(md5_conv Pq)" "reaplicar POR CIMA do corpo da prod (o que o founder cola) passa na PRE por 'este' e é no-op"
asserta C8b "2" "$(Pq -c "SELECT count(*) FROM public.pedido_total_liquido_excecao;")" "e a lista nominal de prove segue com as 2 (IF NOT EXISTS não recria)"
PCq -c "SELECT pg_get_functiondef(to_regprocedure('$CONV_ID'))" > "$TMPD/c8.sql"   # corpo da prod, para devolver depois do C9
perl -0pe 's/\nDECLARE\n/\nDECLARE\n  -- outra entrega mexeu aqui\n/' "$TMPD/c8.sql" > "$TMPD/c9.sql"
PC -q -f "$TMPD/c9.sql"
MD5_OUTRO_B="$(md5_conv PCq)"
OUT_C9="$(PC -q -f "$CANON" 2>&1 || true)"
asserta C9 "sim/intacto" \
  "$(if grep -q 'PRE FALHOU' <<<"$OUT_C9"; then echo sim; else echo nao; fi)/$(if [ "$MD5_OUTRO_B" != "$MD5_PROD_B" ] && [ "$(md5_conv PCq)" = "$MD5_OUTRO_B" ]; then echo intacto; fi)" \
  "a PRE recusa corpo estranho e o deixa intacto (nada de 'última a recriar vence')"
PC -q -f "$TMPD/c8.sql"   # devolve o corpo da prod (C9 o deixou "estranho" de propósito): uma camada por vez
asserta C9b "$MD5_PROD_B" "$(md5_conv PCq)" "prove_c de volta ao corpo da prod antes de sabotar atributos (senão a PRE aborta pelo md5, não pelo atributo)"
# A PRE pina o que o md5 do corpo NÃO vê (parecer Codex de código, P1): default, ACL e volatilidade
# mudados à mão com o MESMO corpo têm de abortar — o CREATE/REVOKE/GRANT os normalizaria em silêncio.
perl -0pe 's/p_limite integer DEFAULT 5000/p_limite integer DEFAULT 100/' "$TMPD/c8.sql" > "$TMPD/c10.sql"
PC -q -f "$TMPD/c10.sql"
OUT_C10="$(PC -q -f "$CANON" 2>&1 || true)"
asserta C10 "sim/$MD5_PROD_B/100" \
  "$(if grep -q 'PRE FALHOU: atributos vivos' <<<"$OUT_C10"; then echo sim; else echo nao; fi)/$(md5_conv PCq)/$(PCq -c "SELECT substring(pg_get_function_arguments(oid) from 'p_limite integer DEFAULT ([0-9]+)') FROM pg_proc WHERE oid = to_regprocedure('$CONV_ID')")" \
  "default de p_limite mudado à mão (md5 igual): a PRE aborta e o default fica como estava"
perl -0pe 's/p_limite integer DEFAULT 100/p_limite integer DEFAULT 5000/' "$TMPD/c10.sql" > "$TMPD/c11.sql"
PC -q -f "$TMPD/c11.sql"   # devolve o default: uma camada por vez (a PRE confere atributos ANTES da ACL)
PC -q -c "REVOKE EXECUTE ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamp with time zone, text[], date, date, integer, boolean) FROM service_role"
OUT_C11="$(PC -q -f "$CANON" 2>&1 || true)"
asserta C11 "sim/f/f/f" \
  "$(if grep -q 'PRE FALHOU: ACL viva' <<<"$OUT_C11"; then echo sim; else echo nao; fi)/$(PCq -c "SELECT concat_ws('/', has_function_privilege('anon', o, 'EXECUTE'), has_function_privilege('authenticated', o, 'EXECUTE'), has_function_privilege('service_role', o, 'EXECUTE')) FROM to_regprocedure('$CONV_ID') o")" \
  "EXECUTE revogado de service_role à mão (emergência): a PRE aborta e a revogação fica"
PC -q -c "GRANT EXECUTE ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamp with time zone, text[], date, date, integer, boolean) TO service_role; ALTER FUNCTION public.pedido_total_liquido_converter(boolean, timestamp with time zone, text[], date, date, integer, boolean) STABLE"
OUT_C12="$(PC -q -f "$CANON" 2>&1 || true)"
asserta C12 "sim/s" \
  "$(if grep -q 'não é VOLATILE' <<<"$OUT_C12"; then echo sim; else echo nao; fi)/$(PCq -c "SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('$CONV_ID')")" \
  "volatilidade mudada à mão: a TRAVA confere ANTES de normalizar e aborta"

echo "═══ $PASS ok / $FAIL fail ═══"
if [ "$FAIL" -eq 0 ]; then echo "FIM_PROVA_OK"; exit 0; fi
exit 1
