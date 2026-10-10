#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  FALSIFICAÇÃO — ATP fase 3 + 3.1. Sabota a migration e EXIGE o vermelho do      ║
# ║  assert que aquela sabotagem mira. Sem isto, "N/N verde" não distingue um       ║
# ║  harness com dente de um harness que mede a coisa errada.                       ║
# ║                                                                                ║
# ║  Cada rodada só vale se:                                                        ║
# ║   (a) a sabotagem PROVOU que aplicou (grep do texto sabotado) — senão a rodada  ║
# ║       é INVÁLIDA, não "sem dente" (money-path §"a falsificação mente");         ║
# ║   (b) o assert-alvo aparece entre os ERR — âncora ASCII, caixa fixa, sem -i;    ║
# ║   (c) o total de asserts bate com o BASELINE desta mesma invocação — total      ║
# ║       diferente = o harness morreu antes de medir.                              ║
# ║                                                                                ║
# ║  BASELINE na MESMA invocação (CLAUDE.md: sabotar sem controle verde no mesmo    ║
# ║  laço é teatro — sempre-vermelho aprovaria TUDO). O total sai dele; a          ║
# ║  constante fixa que existia aqui (74) já estava velha (o harness tinha 78).    ║
# ║                                                                                ║
# ║  ⚠️ VERSÃO COBERTA = VERSÃO ENTREGUE: a 3.1 RECRIA o cálculo, o job de TTL e a  ║
# ║  reconciliação. Sabotar essas funções no arquivo da FASE 3 seria inerte (a 3.1  ║
# ║  as sobrescreve com a versão correta) — por isso F1-F6 sabotam o arquivo da     ║
# ║  3.1, que é o corpo que roda em prod. F7 mira atp_resolver_reserva, que só a    ║
# ║  fase 3 define.                                                                 ║
# ║                                                                                ║
# ║  Restauração por BACKUP-CÓPIA (nunca `git checkout --`: a árvore pode estar     ║
# ║  suja e o checkout apagaria trabalho não-commitado do mesmo arquivo).           ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG3="$REPO_ROOT/supabase/migrations/20260808012000_atp_reconciliacao_fase3.sql"
MIG31="$REPO_ROOT/supabase/migrations/20261009120000_atp_fase3_1_elo_pid.sql"
MIG32="$REPO_ROOT/supabase/migrations/20261009233000_atp_fase3_2_corretiva.sql"
MIG33="$REPO_ROOT/supabase/migrations/20261010150000_atp_fase3_3_pv_divergente.sql"
TESTE="$REPO_ROOT/db/test-atp-reconciliacao-fase3.sh"
BAK3="$(mktemp -t atp-fase3-mig.XXXXXX)"
BAK31="$(mktemp -t atp-fase31-mig.XXXXXX)"
BAK32="$(mktemp -t atp-fase32-mig.XXXXXX)"
BAK33="$(mktemp -t atp-fase33-mig.XXXXXX)"
LOGDIR="${LOGDIR:-$REPO_ROOT/logs/atp-fase3}"
mkdir -p "$LOGDIR"

cp "$MIG3" "$BAK3"; cp "$MIG31" "$BAK31"; cp "$MIG32" "$BAK32"; cp "$MIG33" "$BAK33"
# idempotente: o trap dispara depois da restauração explícita do fim do script
restaura() {
  [ -f "$BAK3" ] && cp "$BAK3" "$MIG3"
  [ -f "$BAK31" ] && cp "$BAK31" "$MIG31"
  [ -f "$BAK32" ] && cp "$BAK32" "$MIG32"
  [ -f "$BAK33" ] && cp "$BAK33" "$MIG33"
  return 0
}
trap 'restaura; rm -f "$BAK3" "$BAK31" "$BAK32" "$BAK33"' EXIT

conta() { command grep -c "$1" "$2" || true; }

# ── BASELINE: verde, com contagem, na mesma invocação ──
echo "=== BASELINE (arquivos intactos) ==="
bash "$TESTE" > "$LOGDIR/falsif-baseline.log" 2>&1
RC_BASE=$?
OK_BASE=$(conta '^  OK' "$LOGDIR/falsif-baseline.log")
ERR_BASE=$(conta '^  ERR' "$LOGDIR/falsif-baseline.log")
if [ "$RC_BASE" -ne 0 ] || [ "$ERR_BASE" -ne 0 ] || [ "$OK_BASE" -eq 0 ]; then
  echo "BASELINE NAO ESTA VERDE (exit=$RC_BASE, $OK_BASE OK / $ERR_BASE ERR) — falsificar agora seria teatro"
  exit 1
fi
TOTAL_ESPERADO="$OK_BASE"
if [ -n "${TOTAL_ESPERADO_ENV:-}" ] && [ "$TOTAL_ESPERADO_ENV" != "$TOTAL_ESPERADO" ]; then
  echo "BASELINE com $TOTAL_ESPERADO asserts, mas TOTAL_ESPERADO_ENV=$TOTAL_ESPERADO_ENV — harness mudou?"
  exit 1
fi
echo "baseline verde: $TOTAL_ESPERADO OK / 0 ERR (exit 0)"

VALIDAS=0; INVALIDAS=0; SEM_DENTE=0

# roda uma falsificação:
#   $1 = arquivo-alvo (MIG3|MIG31|MIG32|MIG33)   $2 = id   $3 = descrição
#   $4 = perl (busca)   $5 = perl (troca)   $6 = marca que prova a sabotagem aplicada
#   $7.. = asserts que TÊM de ficar vermelhos
# ⚠️ busca/troca vão para dentro de um s/// do perl: não podem conter $ nem @.
falsifica() {
  local qual="$1" id="$2" desc="$3" busca="$4" troca="$5" marca="$6"; shift 6
  local alvos=("$@") mig bak
  case "$qual" in
    MIG3)  mig="$MIG3";  bak="$BAK3" ;;
    MIG31) mig="$MIG31"; bak="$BAK31" ;;
    MIG32) mig="$MIG32"; bak="$BAK32" ;;
    MIG33) mig="$MIG33"; bak="$BAK33" ;;
    *) echo "alvo desconhecido: $qual"; INVALIDAS=$((INVALIDAS+1)); return ;;
  esac
  echo
  echo "── $id [$qual] — $desc"

  restaura
  if [ "$busca" = "@@FIM@@" ]; then
    printf '\n%s\n' "$troca" >> "$mig"      # sabotagem por ACRÉSCIMO no fim do arquivo
  else
    perl -0pi -e "s/\Q${busca}\E/${troca}/" "$mig"
  fi

  # (a) a sabotagem aplicou? Sem isto, "não reproduziu" e "o padrão não casou" são
  #     o mesmo output — e o segundo convida a enfraquecer o assert.
  if ! command grep -qF -- "$marca" "$mig" || cmp -s "$mig" "$bak"; then
    echo "   INVALIDA: a sabotagem NAO aplicou (marca ausente ou arquivo intacto)"
    INVALIDAS=$((INVALIDAS+1)); return
  fi

  local log="$LOGDIR/falsif-$id.log"
  bash "$TESTE" > "$log" 2>&1
  local rc=$?
  local nok nerr ntot
  nok=$(conta '^  OK' "$log"); nerr=$(conta '^  ERR' "$log")
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

echo
echo "=== FALSIFICACAO ATP fase 3 + 3.1 (baseline: $TOTAL_ESPERADO asserts) ==="

# ════════════════════ FASE 3 (no corpo que a 3.1 entrega) ════════════════════

# F1 — o ramo LEGADO (EXISTS pelo vínculo) inerte no CÁLCULO: a reserva confirmada
#      pelo edge antigo volta a morrer pelo relógio. `B OR false AND EXISTS(...)`
#      desliga só o ramo, sem tirar símbolo nenhum (sintaxe intacta).
falsifica MIG31 F1 "calculo: o ramo legado (vinculo) deixa de isentar PV firme" \
  '        OR r.omie_pedido_id IS NOT NULL
        OR EXISTS (' \
  '        OR r.omie_pedido_id IS NOT NULL
        OR false AND EXISTS (' \
  'OR false AND EXISTS (' \
  "A2 vencida com PV FIRME ainda desconta (janela fechada)"

# F2 — o job de TTL volta a carimbar reserva de PV firme (ramo legado).
#      Aponta o NOT EXISTS para um uuid que não existe → sempre verdadeiro.
falsifica MIG31 F2 "TTL: volta a expirar reserva de PV firme (ramo legado)" \
  '       WHERE so.id = r.sales_order_id
         AND so.omie_pedido_id IS NOT NULL
     );' \
  "       WHERE so.id = '00000000-0000-0000-0000-000000000000'::uuid
         AND so.omie_pedido_id IS NOT NULL
     );" \
  "WHERE so.id = '00000000-0000-0000-0000-000000000000'::uuid" \
  "A3 reserva de PV firme NAO foi carimbada pelo TTL"

# F3 — o achado CENTRAL do challenge da fase 3: ler a linha VINCULADA em vez da
#      canônica. Derruba os DOIS lados do par.
falsifica MIG31 F3 "canonica: passa a ler a linha VINCULADA (push)" \
  '   AND c.hash_payload IS NOT NULL' \
  '   AND c.id = push.id' \
  'AND c.id = push.id' \
  "B1 cancelamento confirmado na canonica -> liberada" \
  "B2 push diz cancelado mas a canonica NAO -> nao libera"

# F4 — deleted_at volta a liberar (liberaria estoque de pedido ainda vivo)
falsifica MIG31 F4 "libera por deleted_at (gravado ANTES da confirmacao do Omie)" \
  "      AND k.status = 'cancelado'" \
  "      AND (k.status = 'cancelado' OR EXISTS (SELECT 1 FROM public.sales_orders d WHERE d.id = r.sales_order_id AND d.deleted_at IS NOT NULL))" \
  'OR EXISTS (SELECT 1 FROM public.sales_orders d WHERE d.id = r.sales_order_id AND d.deleted_at IS NOT NULL)' \
  "B3 mesmo com deleted_at preenchido, segue ativa"

# F5 — o consumo volta a ser automático (o desenho que o challenge derrubou)
falsifica MIG31 F5 "faturado volta a CONSUMIR automaticamente" \
  '       SET faturamento_observado_em = clock_timestamp(),
           atualizado_em = now()' \
  "       SET faturamento_observado_em = clock_timestamp(),
           status = 'consumida',
           atualizado_em = now()" \
  "status = 'consumida'," \
  "B4 faturado NAO consome automaticamente"

# F6 — o rearme do carimbo some (faturamento futuro reusaria observação velha)
falsifica MIG31 F6 "sem rearme do carimbo apos regressao de status" \
  "   WHERE r.status = 'ativa'
     AND r.faturamento_observado_em IS NOT NULL
     AND NOT EXISTS (" \
  "   WHERE r.status = 'ativa'
     AND false
     AND NOT EXISTS (" \
  '     AND false
     AND NOT EXISTS (' \
  "B5 carimbo limpo apos regressao"

# F7 — o guard de ATOR HUMANO some (atp_resolver_reserva: só a fase 3 a define).
#      O cenário roda como service_role de propósito (V3-pre prova que o gate de
#      capability passa), então só este mecanismo pode barrar.
falsifica MIG3 F7 "sem guard de ator humano em atp_resolver_reserva" \
  "  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'resolver reserva exige um ator humano" \
  "  IF false THEN
    RAISE EXCEPTION 'resolver reserva exige um ator humano" \
  '  IF false THEN' \
  "V3 esperava 42501 sem uid"
# ⚠️ âncora = texto do `bad`, não do `ok`: assert `case … ok "X" ;; *) bad "Y"`
# emite mensagens DIFERENTES no verde e no vermelho. Só `eq()` reusa o rótulo.

# ════════════════════ FASE 3.1 — o elo que sobrevive ao DELETE ════════════════

# F8 — o PAR PRÓPRIO inerte no CÁLCULO: com a push apagada (EXISTS falso), só o par
#      segura a reserva. Os seeds legados da fase 3 seguem verdes (EXISTS) — é isso
#      que prova que E3 mede o par e não o vínculo.
falsifica MIG31 F8 "calculo ignora o par proprio" \
  '        OR r.omie_pedido_id IS NOT NULL
        OR EXISTS (' \
  '        OR false AND r.omie_pedido_id IS NOT NULL
        OR EXISTS (' \
  'OR false AND r.omie_pedido_id IS NOT NULL' \
  "E3 push apagada: a reserva SEGUE descontando (elo sobrevive)"

# F9 — o PAR PRÓPRIO inerte no job de TTL (a outra porta da janela)
falsifica MIG31 F9 "TTL ignora o par proprio" \
  '     AND r.omie_pedido_id IS NULL
     AND NOT EXISTS (' \
  '     AND (r.omie_pedido_id IS NULL OR true)
     AND NOT EXISTS (' \
  'AND (r.omie_pedido_id IS NULL OR true)' \
  "E4 push apagada + vencida: o TTL NAO a carimba"

# F10 — a canônica deixa de ser achada pelo par (só pelo vínculo): a desvinculada
#       nunca é liberada, nunca é observada e chega à fila sem status canônico.
falsifica MIG31 F10 "canonica da reserva ignora o par proprio" \
  'COALESCE(r.omie_pedido_id, push.omie_pedido_id)' \
  'COALESCE(NULL::bigint, push.omie_pedido_id)' \
  'COALESCE(NULL::bigint, push.omie_pedido_id)' \
  "E5 a desvinculada aparece na FILA humana, pelo PID proprio" \
  "E6 canonica cancelada: a desvinculada e LIBERADA pelo par proprio" \
  "E7 desvinculada + canonica faturada: carimba a observacao"

# F20 — a POPULAÇÃO da reconciliação volta a exigir o vínculo (camada distinta da
#       F10: a canônica seria achada, mas a reserva nem entra na varredura)
falsifica MIG31 F20 "reconciliacao volta a varrer so reserva vinculada" \
  "      AND (r.sales_order_id IS NOT NULL OR r.omie_pedido_id IS NOT NULL)
      AND k.status = 'cancelado'" \
  "      AND r.sales_order_id IS NOT NULL
      AND k.status = 'cancelado'" \
  "      AND r.sales_order_id IS NOT NULL" \
  "E6 canonica cancelada: a desvinculada e LIBERADA pelo par proprio"

# F11 — a RPC grava o write-back mas NÃO carimba a reserva (o estado intermediário
#       "PV criado + reserva por transicionar" que esta fase elimina)
# F11/F14-F18 miram o atp_confirmar_pv: desde a 3.3 o corpo ENTREGUE é o dela
# (sabotar o da 3.1 faz a PRE da 3.3 abortar no apply — inválida, não medida).
falsifica MIG33 F11 "RPC nao carimba a reserva" \
  "   WHERE r.sales_order_id = p_sales_order_id
     AND r.status = 'ativa';" \
  "   WHERE r.sales_order_id = p_sales_order_id
     AND r.status = 'ativa' AND false;" \
  "AND r.status = 'ativa' AND false;" \
  "E1 RPC confirma e carimba 1 reserva" \
  "E2 a reserva ganhou o PAR PROPRIO"

# F12 — write-once removido no UPDATE: o par pode ser apagado ou trocado
falsifica MIG31 F12 "write-once removido (update)" \
  '  IF OLD.omie_pedido_id IS NOT NULL
' \
  '  IF false AND OLD.omie_pedido_id IS NOT NULL
' \
  'IF false AND OLD.omie_pedido_id IS NOT NULL' \
  "E12 esperava 23514 ao trocar o PID" \
  "E13 esperava 23514 ao apagar o par"

# F13 — write-once removido no INSERT: reserva pode nascer com par (2º writer)
falsifica MIG31 F13 "write-once removido (insert)" \
  '    IF NEW.omie_pedido_id IS NOT NULL OR NEW.omie_account IS NOT NULL THEN' \
  '    IF false AND (NEW.omie_pedido_id IS NOT NULL OR NEW.omie_account IS NOT NULL) THEN' \
  'IF false AND (NEW.omie_pedido_id IS NOT NULL' \
  "E14 esperava 23514 no INSERT com par"

# F14 — o write-back deixa de exigir 1 linha: PV órfão com "sucesso", e a reserva
#       carimbada com uma conta que não é a do pedido
falsifica MIG33 F14 "write-back aceita 0 linhas" \
  '  IF v_n_so <> 1 THEN' \
  '  IF false THEN' \
  '  IF false THEN' \
  "E8 esperava P0002" \
  "E8 nada gravado: a reserva ficou SEM par"

# F15 — sem o lock do SKU (a confirmação pode AUMENTAR o reservado)
falsifica MIG33 F15 "RPC sem lock de SKU" \
  '     ORDER BY x.sku, x.pool
  LOOP' \
  '     ORDER BY x.sku, x.pool LIMIT 0
  LOOP' \
  'ORDER BY x.sku, x.pool LIMIT 0' \
  "E19 a RPC NAO esperou o lock do SKU"

# F16 — sem o lock do checkout
falsifica MIG33 F16 "RPC sem lock de checkout" \
  "FOREACH v_ck IN ARRAY COALESCE(v_cks, '{}'::uuid[])" \
  "FOREACH v_ck IN ARRAY '{}'::uuid[]" \
  "FOREACH v_ck IN ARRAY '{}'::uuid[]" \
  "E19 a RPC NAO esperou o lock do checkout"

# F17 — sem o gate próprio (só o catálogo seguraria — e um GRANT acidental abriria)
falsifica MIG33 F17 "RPC sem gate proprio de service_role" \
  "  IF auth.role() IS DISTINCT FROM 'service_role' THEN" \
  '  IF false THEN' \
  '  IF false THEN' \
  "E17 esperava 42501 do gate proprio"

# F18 — GRANT acidental a authenticated DEPOIS da migration (outra migration, um
#       clique no painel). Acrescentado APÓS a PÓS de propósito: dentro do arquivo a
#       PÓS abortaria o apply (é a P1) — aqui se prova a OUTRA camada, o assert de
#       CATÁLOGO, sozinha (uma camada por vez).
falsifica MIG33 F18 "authenticated ganha EXECUTE na RPC (depois da migration)" \
  '@@FIM@@' \
  'GRANT EXECUTE ON FUNCTION public.atp_confirmar_pv(uuid, text, bigint, text, jsonb, jsonb) TO authenticated;' \
  'GRANT EXECUTE ON FUNCTION public.atp_confirmar_pv(uuid, text, bigint, text, jsonb, jsonb) TO authenticated;' \
  "E15 authenticated sem EXECUTE em atp_confirmar_pv (catalogo)"

# F19 — sem backfill: reserva já confirmada pelo edge antigo nunca ganha o par
falsifica MIG31 F19 "sem backfill do par" \
  '   AND r.omie_pedido_id IS NULL;' \
  '   AND false;' \
  '   AND false;' \
  "E20 backfill deu o par a reserva legada"

# F21 — a MARGEM some: "coletado depois do faturamento" passa a aceitar coleta de
#       ATÉ 1h ANTES — leitura pré-baixa viraria sinal verde para o humano
falsifica MIG32 F21 "sinal da fila sem a margem de 1h (corpo entregue: o da 3.2)" \
  "r.faturamento_observado_em + interval '1 hour'" \
  "r.faturamento_observado_em - interval '1 hour'" \
  "r.faturamento_observado_em - interval '1 hour'" \
  "S2 coletado 30min depois do faturamento: AINDA NAO prova (dentro da margem)"

# F22 — a PÓS perde o check de privilégio: o GRANT acidental DENTRO do arquivo passa
falsifica MIG31 F22 "POS sem o check de privilegio de authenticated" \
  "     OR has_function_privilege('authenticated', v_cpv, 'EXECUTE') THEN" \
  "     OR false THEN" \
  "     OR false THEN" \
  "P1 a POS deixou passar GRANT a authenticated" \
  "P1 e nada ficou concedido (transacao unica voltou inteira)"

# F23 — a PRE aceita qualquer corpo vivo: o apply apaga o que outra sessão aplicou
falsifica MIG31 F23 "PRE anti-deriva aceita qualquer corpo" \
  "    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN" \
  "    IF r.vivo IS NULL OR false THEN" \
  "IF r.vivo IS NULL OR false THEN" \
  "P2 a PRE deixou sobrescrever o corpo de outra sessao" \
  "P2 e o corpo da outra sessao SOBREVIVEU"

# ════════════════════ FASE 3.2 — correções do Codex retroativo ══════════════════

# F24 — a guarda do reservar_estoque some: a substituição volta a soltar reserva firme
falsifica MIG32 F24 "reservar_estoque substitui reserva firme" \
  "  IF EXISTS (
    SELECT 1 FROM public.estoque_reservas r
    WHERE r.checkout_id = p_checkout_id" \
  "  IF false AND EXISTS (
    SELECT 1 FROM public.estoque_reservas r
    WHERE r.checkout_id = p_checkout_id" \
  "IF false AND EXISTS (" \
  "R1 a substituicao soltou a reserva firme pelo par" \
  "R2 a substituicao soltou a reserva firme legada"

# F25 — a guarda só olha o PAR (esquece o firme LEGADO pelo vínculo) — camada distinta
falsifica MIG32 F25 "guarda do reservar ignora o firme legado" \
  "      AND (r.omie_pedido_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM public.sales_orders so" \
  "      AND (r.omie_pedido_id IS NOT NULL
           OR false AND EXISTS (SELECT 1 FROM public.sales_orders so" \
  "OR false AND EXISTS (SELECT 1 FROM public.sales_orders so" \
  "R2 a substituicao soltou a reserva firme legada"

# F26 — o liberar volta a soltar reserva firme
falsifica MIG32 F26 "liberar_reserva_checkout solta reserva firme" \
  "     AND r.omie_pedido_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.sales_orders so
                     WHERE so.id" \
  "     AND (r.omie_pedido_id IS NULL OR true)
     AND NOT EXISTS (SELECT 1 FROM public.sales_orders so
                     WHERE false AND so.id" \
  "WHERE false AND so.id" \
  "L1 liberar checkout firme pelo PAR: 0 liberadas / 1 preservada" \
  "L1 liberar checkout firme LEGADO: 0 liberadas / 1 preservada"

# F27 — o sinal volta a ignorar se o ATP aceita o saldo
falsifica MIG32 F27 "sinal ignora saldo_confiavel (sem tocar o texto que a POS confere)" \
  "             OR d.saldo_confiavel IS DISTINCT FROM true" \
  "             OR d.saldo_confiavel IS DISTINCT FROM true AND false" \
  "OR d.saldo_confiavel IS DISTINCT FROM true AND false" \
  "S4 contas do pool divergentes (o ATP recusa o SKU): o sinal vira NULL"

# F28 — o sinal volta a ignorar a regressão da canônica
falsifica MIG32 F28 "sinal ignora a canonica atual" \
  "             OR k.status IS DISTINCT FROM 'faturado' THEN NULL" \
  "             OR false THEN NULL" \
  "             OR false THEN NULL" \
  "S5 canonica regrediu (carimbo ainda velho): o sinal vira NULL"

# F29 — o CHECK volta à forma da 3.1 (aceita conta com PID nulo)
falsifica MIG32 F29 "CHECK aceita PID nulo (sem tocar o texto que a POS confere)" \
  "    OR (omie_pedido_id IS NOT NULL AND omie_pedido_id > 0" \
  "    OR ((omie_pedido_id IS NOT NULL OR omie_pedido_id > 0)" \
  "OR ((omie_pedido_id IS NOT NULL OR omie_pedido_id > 0)" \
  "C1 o CHECK aceitou conta sem PID"

# ⚠️ F27/F29 são escritas para PASSAR pela PÓS (mantêm o texto que ela confere):
# a versão óbvia (apagar a linha) é pega pela PÓS e aborta o apply — defesa em
# profundidade real, mas aí o assert de COMPORTAMENTO não é medido sozinho.

# F30 — a PRE da 3.2 aceita qualquer corpo/atributo vivo
falsifica MIG32 F30 "PRE da 3.2 aceita qualquer estado vivo" \
  "    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN" \
  "    IF r.vivo IS NULL OR false THEN" \
  "IF r.vivo IS NULL OR false THEN" \
  "P5 a PRE ignorou o atributo trocado (SECURITY INVOKER)"

# F31 — a TRAVA volta a IMPOR a volatilidade (normaliza a deriva antes da PRE)
falsifica MIG32 F31 "TRAVA volta a impor valor fixo por funcao (a da versao anterior)" \
  "CASE f.provolatile WHEN 'v' THEN 'VOLATILE' WHEN 's' THEN 'STABLE' ELSE 'IMMUTABLE' END" \
  "CASE WHEN f.alvo::text LIKE '%pendentes%' THEN 'STABLE' ELSE 'VOLATILE' END" \
  "CASE WHEN f.alvo::text LIKE '%pendentes%'" \
  "P6 a TRAVA normalizou a volatilidade trocada e a PRE aceitou"

# ══ FASE 3.3 — a reserva acompanha o PV reconciliado ════════════════════════
# Toda sabotagem da 3.3 muda o corpo ⇒ T2/P7/P8 (md5) também ficam vermelhos;
# o que valida é o vermelho do assert de COMPORTAMENTO que ela mira.

# F32 — o ajuste ao PV desligado (o write-back segue firmando o carrinho)
falsifica MIG33 F32 "ajuste ao PV reconciliado desligado" \
  "  IF v_pv IS NOT NULL THEN
    BEGIN
      FOR v_aj IN" \
  "  IF false THEN
    BEGIN
      FOR v_aj IN" \
  "IF false THEN" \
  "D1 a reserva virou a do PV (qtd somada, SKU fora liberado, SKU do PV criado e firme)"

# F33 — o código do item deixa de ser conferido: o cast para bigint LANÇA e o
#       write-back de um PV que existe se perde
falsifica MIG33 F33 "item com codigo nao inteiro passa pela leitura" \
  "CASE WHEN COALESCE(e #>> '{produto,codigo_produto}', '') !~" \
  "CASE WHEN false AND '' !~" \
  "CASE WHEN false AND '' !~" \
  "D4 um item ilegivel torna a leitura INTEIRA ilegivel"

# F34 — sem o teto do domínio da reserva: o CHECK estoura e derruba o write-back
falsifica MIG33 F34 "quantidade do PV sem o teto do CHECK" \
  "AND s.qtd <= 1000000" \
  "AND true" \
  "bool_and(s.sku > 0 AND s.qtd > 0 AND true)" \
  "D8 quantidade fora do dominio da reserva (> 1e6): ilegivel, sem violar o CHECK"

# F35 — sem a guarda de "um checkout com reserva viva": fabrica reserva sem checkout
falsifica MIG33 F35 "ajuste sem reserva viva do pedido" \
  "OR COALESCE(array_length(v_cks_sob_lock, 1), 0) <> 1)" \
  "OR false)" \
  "v_cks_sob_lock IS DISTINCT FROM v_cks OR false)" \
  "D11 oben SEM reserva viva: nao FABRICA reserva a partir do PV"

# F36 — o SKU que só o PV tem fica fora do lock
falsifica MIG33 F36 "lock so dos SKUs ja reservados" \
  "FROM jsonb_object_keys(COALESCE(v_pv, '{}'::jsonb)) k) x" \
  "FROM jsonb_object_keys('{}'::jsonb) k) x" \
  "FROM jsonb_object_keys('{}'::jsonb) k) x" \
  "D12 a RPC NAO travou o SKU que so o PV tem"

# F37 — a leitura deixa de ser só do pool oben
falsifica MIG33 F37 "itens lidos em qualquer conta" \
  "IF v_reconciliado AND p_account = 'oben' THEN" \
  "IF v_reconciliado THEN" \
  "IF v_reconciliado THEN" \
  "D10 colacor reconciliado: fora do pool, nada se aplica"

# F38 — todo envio vira "reconciliado"
falsifica MIG33 F38 "envio normal tratado como reconciliado" \
  "v_reconciliado boolean := COALESCE(p_omie_response->>'reconciled', '') = 'true';" \
  "v_reconciliado boolean := true;" \
  "v_reconciliado boolean := true;" \
  "D7 envio normal (sem reconciled): nao le itens, nao ajusta"

# F40 — sem a subtransação: um erro no ajuste derruba o write-back do PV que existe
falsifica MIG33 F40 "ajuste sem subtransacao" \
  "    EXCEPTION WHEN OTHERS THEN
      -- desfaz SÓ o ajuste; a reserva fica a do carrinho e a falha é exposta
      v_ajustes := '[]'::jsonb;
      v_falha := SQLSTATE || ': ' || SQLERRM;
    END;" \
  "    END;" \
  "      END LOOP;
    END;" \
  "D14 esperava false/P0001: D14 sabotagem"

# F41 — sem a releitura sob lock: decide pelo checkout lido ANTES de esperar
falsifica MIG33 F41 "checkout lido antes do lock" \
  "     AND (v_cks_sob_lock IS DISTINCT FROM v_cks OR COALESCE(array_length(v_cks_sob_lock, 1), 0) <> 1) THEN" \
  "     AND (COALESCE(array_length(v_cks, 1), 0) <> 1) THEN" \
  "AND (COALESCE(array_length(v_cks, 1), 0) <> 1) THEN" \
  "D16 substituicao concorrente: a releitura sob lock aborta o ajuste limpo"

# F42 — item que não movimenta estoque volta a ser reservado
falsifica MIG33 F42 "nao_movimentar_estoque ignorado" \
  "WHERE COALESCE(e #>> '{inf_adic,nao_movimentar_estoque}', 'N') <> 'S'" \
  "WHERE true" \
  "               WHERE true" \
  "D15 PV com o 3319 sem movimentar estoque: o 3319 sai da reserva"

# F39 — a PRE da 3.3 aceita qualquer corpo vivo
falsifica MIG33 F39 "PRE da 3.3 aceita qualquer estado vivo" \
  "    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN" \
  "    IF r.vivo IS NULL OR false THEN" \
  "IF r.vivo IS NULL OR false THEN" \
  "P8 a PRE deixou sobrescrever o atp_confirmar_pv de outra sessao"

echo
echo "=== FALSIFICACAO: $VALIDAS validas / $SEM_DENTE sem dente / $INVALIDAS invalidas ==="
restaura
if cmp -s "$MIG3" "$BAK3" && cmp -s "$MIG31" "$BAK31" && cmp -s "$MIG32" "$BAK32" && cmp -s "$MIG33" "$BAK33"; then
  echo "migrations restauradas (byte-a-byte iguais ao backup)"
else
  echo "ERRO: migration NAO restaurada"; exit 1
fi
[ "$SEM_DENTE" -eq 0 ] && [ "$INVALIDAS" -eq 0 ] || exit 1
