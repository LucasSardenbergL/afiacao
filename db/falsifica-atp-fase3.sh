#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  FALSIFICAÇÃO — ATP fase 3. Sabota a migration e EXIGE o vermelho do assert     ║
# ║  que aquela sabotagem mira. Sem isto, "74/74 verde" não distingue um harness    ║
# ║  com dente de um harness que mede a coisa errada.                              ║
# ║                                                                                ║
# ║  Cada rodada só vale se:                                                        ║
# ║   (a) a sabotagem PROVOU que aplicou (grep do texto sabotado) — senão a rodada  ║
# ║       é INVÁLIDA, não "sem dente" (money-path §"a falsificação mente");         ║
# ║   (b) o assert-alvo aparece entre os ERR — âncora ASCII, caixa fixa, sem -i;    ║
# ║   (c) o total de asserts bate com o baseline — total diferente = não rodou tudo.║
# ║                                                                                ║
# ║  Restauração por BACKUP-CÓPIA (nunca `git checkout --`: a árvore está suja e o  ║
# ║  checkout apagaria trabalho não-commitado do mesmo arquivo).                    ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20260808012000_atp_reconciliacao_fase3.sql"
BAK="$(mktemp -t atp-fase3-mig.XXXXXX)"
LOGDIR="$REPO_ROOT/logs/atp-fase3"
TOTAL_ESPERADO="${TOTAL_ESPERADO:-74}"
mkdir -p "$LOGDIR"

cp "$MIG" "$BAK"
# idempotente: o trap dispara depois da restauração explícita do fim do script
restaura() { [ -f "$BAK" ] && cp "$BAK" "$MIG"; return 0; }
trap 'restaura; rm -f "$BAK"' EXIT

VALIDAS=0; INVALIDAS=0; SEM_DENTE=0

# roda uma falsificação:
#   $1 = id   $2 = descrição   $3 = perl (busca)   $4 = perl (troca)
#   $5 = marca que prova a sabotagem aplicada   $6.. = asserts que TÊM de ficar vermelhos
falsifica() {
  local id="$1" desc="$2" busca="$3" troca="$4" marca="$5"; shift 5
  local alvos=("$@")
  echo
  echo "── $id — $desc"

  cp "$BAK" "$MIG"
  perl -0pi -e "s/\Q${busca}\E/${troca}/" "$MIG"

  # (a) a sabotagem aplicou? Sem isto, "não reproduziu" e "o padrão não casou" são
  #     o mesmo output — e o segundo convida a enfraquecer o assert.
  if ! command grep -qF "$marca" "$MIG"; then
    echo "   INVALIDA: a sabotagem NAO aplicou (marca ausente no arquivo)"
    INVALIDAS=$((INVALIDAS+1)); return
  fi

  local log="$LOGDIR/falsif-$id.log"
  bash "$REPO_ROOT/db/test-atp-reconciliacao-fase3.sh" > "$log" 2>&1
  local rc=$?
  local nok nerr ntot
  nok=$(command grep -c '^  OK' "$log"); nerr=$(command grep -c '^  ERR' "$log")
  ntot=$((nok + nerr))

  # (c) o denominador é o tell de "não rodou nada" (money-path §"o exit code mente")
  if [ "$ntot" -ne "$TOTAL_ESPERADO" ]; then
    echo "   INVALIDA: total de asserts $ntot != baseline $TOTAL_ESPERADO (o harness morreu antes de medir)"
    echo "   ultima linha: $(tail -1 "$log")"
    INVALIDAS=$((INVALIDAS+1)); return
  fi
  if [ "$rc" -eq 0 ]; then
    echo "   SEM DENTE: a sabotagem entrou e o harness ficou VERDE ($nok/$ntot)"
    SEM_DENTE=$((SEM_DENTE+1)); return
  fi

  # (b) o vermelho é O DELA? Âncora ASCII exclusiva do ramo, caixa fixa, sem -i.
  local faltando=0 a
  for a in "${alvos[@]}"; do
    if command grep -qF -- "  ERR $a" "$log"; then
      echo "   vermelho esperado presente: $a"
    else
      echo "   FALTOU o vermelho de: $a"; faltando=1
    fi
  done
  if [ "$faltando" -eq 1 ]; then
    echo "   INVALIDA: falhou ($nerr ERR), mas nao no assert que esta sabotagem mira"
    INVALIDAS=$((INVALIDAS+1)); return
  fi
  echo "   OK — $nerr vermelho(s) de $ntot, incluindo o alvo"
  VALIDAS=$((VALIDAS+1))
}

echo "=== FALSIFICACAO ATP fase 3 (baseline esperado: $TOTAL_ESPERADO asserts) ==="

# F1 — M1 inerte: a reserva de PV firme volta a morrer pelo relógio no CÁLCULO.
#      `A OR false AND EXISTS(...)` = `A` (AND liga mais forte) — desliga o ramo
#      sem remover a leitura de nenhum símbolo, que é o jeito de sabotar um
#      predicado sem quebrar a sintaxe.
falsifica F1 "M1: o calculo volta a expirar reserva de PV firme" \
  'r.expira_em > now()
        OR EXISTS (' \
  'r.expira_em > now()
        OR false AND EXISTS (' \
  'OR false AND EXISTS (' \
  "A2 vencida com PV FIRME ainda desconta (janela fechada)"

# F2 — M2 inerte: o job de TTL volta a carimbar a reserva de PV firme.
#      Aponta o NOT EXISTS para um uuid que não existe → ele é sempre verdadeiro.
falsifica F2 "M2: o job de TTL volta a expirar reserva de PV firme" \
  '       WHERE so.id = r.sales_order_id
         AND so.omie_pedido_id IS NOT NULL
     );' \
  "       WHERE so.id = '00000000-0000-0000-0000-000000000000'::uuid
         AND so.omie_pedido_id IS NOT NULL
     );" \
  "WHERE so.id = '00000000-0000-0000-0000-000000000000'::uuid" \
  "A3 reserva de PV firme NAO foi carimbada pelo TTL"

# F3 — o achado CENTRAL do challenge: ler a linha VINCULADA em vez da canônica.
#      Tem de derrubar os DOIS lados do par — sem liberar o cancelado de verdade
#      e liberando o falso. Um lado sozinho não distinguiria a direção da leitura.
falsifica F3 "canonica: passa a ler a linha VINCULADA (push) — o bug que o challenge achou" \
  '   AND c.hash_payload IS NOT NULL' \
  '   AND c.id = push.id' \
  'AND c.id = push.id' \
  "B1 cancelamento confirmado na canonica -> liberada" \
  "B2 push diz cancelado mas a canonica NAO -> nao libera"

# F4 — deleted_at volta a liberar (liberaria estoque de pedido ainda vivo)
falsifica F4 "libera por deleted_at (gravado ANTES da confirmacao do Omie)" \
  "      AND k.status = 'cancelado'" \
  "      AND (k.status = 'cancelado' OR EXISTS (SELECT 1 FROM public.sales_orders d WHERE d.id = r.sales_order_id AND d.deleted_at IS NOT NULL))" \
  'OR EXISTS (SELECT 1 FROM public.sales_orders d WHERE d.id = r.sales_order_id AND d.deleted_at IS NOT NULL)' \
  "B3 mesmo com deleted_at preenchido, segue ativa"

# F5 — o consumo volta a ser automático (o desenho que o challenge derrubou)
falsifica F5 "faturado volta a CONSUMIR automaticamente" \
  '       SET faturamento_observado_em = clock_timestamp(),
           atualizado_em = now()' \
  "       SET faturamento_observado_em = clock_timestamp(),
           status = 'consumida',
           atualizado_em = now()" \
  "status = 'consumida'," \
  "B4 faturado NAO consome automaticamente"

# F6 — o rearme do carimbo some (faturamento futuro reusaria observacao velha)
falsifica F6 "sem rearme do carimbo apos regressao de status" \
  "   WHERE r.status = 'ativa'
     AND r.faturamento_observado_em IS NOT NULL
     AND NOT EXISTS (" \
  "   WHERE r.status = 'ativa'
     AND false
     AND NOT EXISTS (" \
  '     AND false
     AND NOT EXISTS (' \
  "B5 carimbo limpo apos regressao"

# F7 — o guard de ATOR HUMANO some. ⚠️ Este é o que ficaria INERTE se o cenário
#      rodasse como 'authenticated': ali o 42501 viria do gate cap_estoque_reservar,
#      não deste guard. O cenário roda como service_role de propósito (V3-pre prova
#      que o gate passa), então só este mecanismo pode barrar.
falsifica F7 "sem guard de ator humano em atp_resolver_reserva" \
  "  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'resolver reserva exige um ator humano" \
  "  IF false THEN
    RAISE EXCEPTION 'resolver reserva exige um ator humano" \
  '  IF false THEN' \
  "V3 esperava 42501 sem uid"
# ⚠️ a âncora acima é o texto do `bad`, não o do `ok`. Assert escrito com
# `case … ok "X" ;; *) bad "Y"` emite mensagens DIFERENTES no verde e no vermelho —
# ancorar no texto do verde faz a falsificação reportar "faltou o vermelho" quando
# ele estava lá (mordido nesta entrega). Só `eq()` reusa o mesmo rótulo nos dois.

echo
echo "=== FALSIFICACAO: $VALIDAS validas / $SEM_DENTE sem dente / $INVALIDAS invalidas ==="
restaura
command grep -qF 'AND so.omie_pedido_id IS NOT NULL' "$MIG" && echo "migration restaurada (marca original presente)"
[ "$SEM_DENTE" -eq 0 ] && [ "$INVALIDAS" -eq 0 ] || exit 1
