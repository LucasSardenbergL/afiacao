#!/usr/bin/env bash
# Harness de PARIDADE TS×SQL do farmer scoring — o baseline da §5.1 do spec
# `docs/superpowers/specs/2026-07-20-fechamento-custo-farmer-scoring-design.md`:
# "mesma cesta de clientes, margem pelo TS e pela RPC, exigindo a mesma faixa".
#
# O #1543 foi entregue com a divergência DECLARADA (comentário no hook) em vez de MEDIDA.
# Este harness mede, cliente a cliente: faixa, health score, healthClass e composição da agenda.
#
# ── POR QUE NÃO É UM PG17 LOCAL (a skill prove-sql-money-path) ────────────────────────────────
# A skill existe para provar que uma migration NOVA funciona antes de tocar prod. Aqui não há
# migration nova: `private.margem_cliente_agregada()` e `public.get_carteira_margem_faixa()` JÁ
# estão em produção, e a pergunta não é "a função está correta?" e sim "QUAL o delta REAL que
# ela produz sobre o dado REAL?". Esse número só existe em prod — um PG17 semeado responderia
# sobre dados inventados. Logo: leitura read-only de prod (`~/.config/afiacao/psql-ro`, role
# `claude_ro`, sem DDL/DML) + falsificação do próprio harness (bloco FALSIFICAÇÃO no fim).
#
# ⚠️ `claude_ro` NÃO tem EXECUTE em `private.margem_cliente_agregada()` (medido:
# has_function_privilege = false; a função é SECURITY DEFINER com GRANT só para service_role).
# Por isso o lado SQL abaixo REPLICA o corpo — copiado VERBATIM do `pg_get_functiondef()` da
# PRODUÇÃO, não do repo (§ "apply manual diverge do repo" do CLAUDE.md). O bloco FIDELIDADE
# confere que a réplica ainda casa com a função viva; se prod mudar, o teste fica VERMELHO.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL="$HOME/.config/afiacao/psql-ro"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/paridade-farmer.XXXXXX")"
# Evidência que vou CITAR fica no worktree (logs/ é gitignorado), não no scratchpad de /tmp —
# ele já sumiu no meio de uma sessão antes (money-path.md § "O LOG mente 2").
OUT="$REPO_ROOT/logs/paridade-fu4f"
mkdir -p "$OUT"
# A cópia sabotada mora em scripts/ (e NÃO em $WORK) porque o script importa `../src/…` por
# caminho relativo — de fora de scripts/ o import não resolve e a sabotagem falharia por MOTIVO
# ERRADO, que se lê como "o assert não tem dente" (money-path.md § sabotagem que não compila).
# Cópia separada em vez de sabotar o original in-place: se o trap falhar, perde-se um arquivo
# descartável em vez de corromper o script real.
SAB="$REPO_ROOT/scripts/paridade-sabotado-tmp.ts"
cleanup() { rm -rf "$WORK"; rm -f "$SAB"; }
trap cleanup EXIT

[ -x "$PSQL" ] || { echo "FAIL: $PSQL ausente (acesso read-only de prod)"; exit 1; }

Q() { "$PSQL" -v ON_ERROR_STOP=1 -q "$@"; }

echo "→ 0. relógio fixo do corpus…"
# Recência/SLA dependem do relógio. Fixar o instante impede que a diferença entre as duas
# passagens do motor vire "delta" — seria delta de wall-clock, não da mudança de fonte.
Q -t -A -c "SELECT (extract(epoch FROM now())*1000)::bigint;" | tr -d ' ' > "$WORK/agora.txt"

echo "→ 1. extraindo corpus de PROD (read-only)…"
# `status IN ('confirmado','faturado','entregue')` = allowlist VERBATIM de useFarmerScoring.ts.
# O hook não filtra deleted_at (medido: 0 linhas deletadas em toda a tabela — delta inerte hoje,
# preservado assim mesmo para que o corpus reproduza o hook REAL, não o desejável).
Q -c "\copy (SELECT so.id, so.customer_user_id, COALESCE(so.items,'[]'::jsonb) AS items, COALESCE(so.total,0) AS total, so.created_at, so.order_date_kpi FROM public.sales_orders so WHERE so.status IN ('confirmado','faturado','entregue') AND so.customer_user_id IS NOT NULL ORDER BY so.id) TO '$WORK/pedidos.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
Q -c "\copy (SELECT op.id, op.omie_codigo_produto FROM public.omie_products op WHERE op.omie_codigo_produto IS NOT NULL ORDER BY op.id) TO '$WORK/produtos.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
Q -c "\copy (SELECT pc.product_id, pc.cost_price, pc.cost_final FROM public.product_costs pc ORDER BY pc.product_id) TO '$WORK/custos.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
Q -c "\copy (SELECT cc.user_id FROM public.cliente_classificacao cc WHERE cc.excluir_da_carteira IS TRUE ORDER BY cc.user_id) TO '$WORK/excluidos.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
Q -c "\copy (SELECT p.user_id, p.name, p.phone FROM public.profiles p ORDER BY p.user_id) TO '$WORK/profiles.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
Q -c "\copy (SELECT fc.farmer_id, fc.customer_user_id, fc.call_result, fc.is_whatsapp, fc.whatsapp_replied, fc.created_at FROM public.farmer_calls fc WHERE fc.customer_user_id IS NOT NULL ORDER BY fc.farmer_id, fc.created_at) TO '$WORK/calls.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
Q -c "\copy (SELECT c.key, c.value FROM public.farmer_algorithm_config c ORDER BY c.key) TO '$WORK/config.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
Q -c "\copy (SELECT a.owner_user_id, a.customer_user_id, a.eligible FROM public.carteira_assignments a ORDER BY a.owner_user_id, a.customer_user_id) TO '$WORK/carteiras.csv' WITH (FORMAT csv, HEADER true)" >/dev/null

echo "→ 2. personas REAIS (não hipotéticas)…"
# `cap_carteira_ler` = master OU employee com commercial_role gerencial/estrategico/super_admin.
# Medido: 3 donos de carteira em prod — 1 master e 2 farmers. O delta de ESCOPO só existe para
# quem NÃO tem cap_carteira_ler; incluir o master é o controle que isola os outros deltas.
Q -t -A -c "SELECT json_agg(json_build_object(
     'id', d.owner_user_id,
     'rotulo', COALESCE(cr.commercial_role::text,'(sem commercial_role)'),
     'capTodo', COALESCE(private_cap.ok,false)))
   FROM (SELECT DISTINCT owner_user_id FROM public.carteira_assignments) d
   LEFT JOIN public.commercial_roles cr ON cr.user_id = d.owner_user_id
   LEFT JOIN LATERAL (
     SELECT (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=d.owner_user_id AND ur.role='master')
          OR EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.commercial_roles c2 ON c2.user_id=ur.user_id
                      WHERE ur.user_id=d.owner_user_id AND ur.role='employee'
                        AND c2.commercial_role IN ('gerencial','estrategico','super_admin'))) AS ok
   ) private_cap ON true;" > "$WORK/personas.json"

echo "→ 3. lado SQL — réplica VERBATIM de margem_cliente_agregada + a régua da RPC…"
# Corpo copiado do pg_get_functiondef() de PROD (conferido no bloco FIDELIDADE abaixo).
# A régua p10/p90 é calculada sobre a POPULAÇÃO INTEIRA, ANTES do filtro de escopo — igual à
# RPC ("o filtro vem DEPOIS da régua, de propósito"). O escopo por persona é aplicado no lado TS
# a partir de carteiras.csv, porque `auth.uid()` não existe numa sessão psql.
Q -c "\copy (
WITH custo AS (
  SELECT op.omie_codigo_produto AS cod,
         COALESCE(
           CASE WHEN pc.cost_final > 0 AND pc.cost_final < 'Infinity'::numeric THEN pc.cost_final END,
           CASE WHEN pc.cost_price > 0 AND pc.cost_price < 'Infinity'::numeric THEN pc.cost_price END
         ) AS custo_unit
    FROM public.omie_products op
    JOIN public.product_costs pc ON pc.product_id = op.id
   WHERE op.omie_codigo_produto IS NOT NULL
),
itens AS (
  SELECT oi.customer_user_id AS cid, oi.quantity::numeric AS qtd,
         oi.unit_price::numeric AS preco_unit, cu.custo_unit
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN custo cu ON cu.cod = oi.omie_codigo_produto
   WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
     AND so.deleted_at IS NULL
     AND oi.customer_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc
                      WHERE cc.user_id = oi.customer_user_id AND cc.excluir_da_carteira IS TRUE)
),
norm AS (
  SELECT i.cid, i.qtd, i.preco_unit, i.custo_unit,
         ( i.qtd IS NOT NULL AND i.qtd > 0 AND i.qtd < 'Infinity'::numeric
       AND i.preco_unit IS NOT NULL AND i.preco_unit >= 0 AND i.preco_unit < 'Infinity'::numeric
       AND i.custo_unit IS NOT NULL ) AS computavel
    FROM itens i
),
agg AS (
  SELECT n.cid AS customer_user_id,
         CASE WHEN COALESCE(sum(n.preco_unit*n.qtd) FILTER (WHERE n.computavel),0) > 0
              THEN round((sum(n.preco_unit*n.qtd) FILTER (WHERE n.computavel)
                        - sum(n.custo_unit*n.qtd) FILTER (WHERE n.computavel))
                        / sum(n.preco_unit*n.qtd) FILTER (WHERE n.computavel) * 100, 2)
              ELSE NULL END AS pct
    FROM norm n GROUP BY n.cid
),
regua AS (
  SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY a.pct/100.0)::numeric AS p10,
         percentile_cont(0.90) WITHIN GROUP (ORDER BY a.pct/100.0)::numeric AS p90
    FROM agg a WHERE a.pct IS NOT NULL
)
SELECT a.customer_user_id,
       CASE WHEN a.pct IS NULL THEN 'neutro'
            WHEN a.pct < 0 THEN 'vermelho'
            WHEN a.pct < COALESCE((SELECT max(c.value::numeric) FROM public.farmer_algorithm_config c
                                    WHERE c.key='margem_faixa_piso_pct'),30) THEN 'amarelo'
            ELSE 'verde' END AS faixa,
       CASE WHEN a.pct IS NULL THEN NULL
            ELSE greatest(0::numeric, least(1::numeric,
                   (a.pct/100.0 - r.p10) / greatest(r.p90 - r.p10, 0.01::numeric))) END AS g,
       a.pct AS margem_pct
  FROM agg a CROSS JOIN regua r
 ORDER BY a.customer_user_id
) TO '$WORK/sql-faixa.csv' WITH (FORMAT csv, HEADER true)" >/dev/null

echo "→ 4. FIDELIDADE — a réplica ainda casa com a função VIVA em prod?"
# Sem isto o harness vira ficção no dia em que prod mudar: mediria a réplica contra si mesma.
# Ancorado em trechos ASCII exclusivos do corpo real (nada de acento — §"acento é armadilha").
FN_MARGEM="$($PSQL -t -A -c "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='margem_cliente_agregada';" 2>/dev/null)"
FN_FAIXA="$($PSQL -t -A -c "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_carteira_margem_faixa';" 2>/dev/null)"
falha_fid=0
for marca in \
  "NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')" \
  "deleted_at IS NULL" \
  "cu.cod = oi.omie_codigo_produto" \
  "round(" ; do
  printf '%s' "$FN_MARGEM" | command grep -qF "$marca" || { echo "   FAIL fidelidade(margem): prod nao contem <$marca>"; falha_fid=1; }
done
for marca in \
  "percentile_cont(0.10)" \
  "percentile_cont(0.90)" \
  "greatest(r.p90 - r.p10, 0.01" \
  "cap_carteira_ler" ; do
  printf '%s' "$FN_FAIXA" | command grep -qF "$marca" || { echo "   FAIL fidelidade(faixa): prod nao contem <$marca>"; falha_fid=1; }
done
if [ "$falha_fid" -ne 0 ]; then
  echo "FAIL: a funcao em PROD divergiu da replica deste harness — atualize a replica antes de confiar no numero"
  exit 1
fi
echo "   ✓ replica casa com as duas funcoes vivas em prod"

echo "→ 5. FIDELIDADE do lado TS — as copias verbatim ainda casam com o hook?"
# `percentile`, `classifyHealth` e os laços da agenda vivem INLINE no hook (sem export) e estão
# copiados no script. Se o hook mudar e a cópia não, o harness compara contra um motor fantasma.
HOOK="$REPO_ROOT/src/hooks/useFarmerScoring.ts"
SCRIPT="$REPO_ROOT/scripts/paridade-farmer-scoring.ts"
falha_ts=0
for marca in \
  "const idx = (p / 100) * (sorted.length - 1);" \
  "if (score >= 80) return 'saudavel';" \
  "const riscoSlots = Math.round(totalSlots * config.agenda_pct_risco);" ; do
  command grep -qF "$marca" "$HOOK" || { echo "   FAIL: o HOOK nao contem mais <$marca>"; falha_ts=1; }
done
# a mesma regra, na forma que o script usa (config→cfg)
for marca in \
  "const idx = (p / 100) * (sorted.length - 1);" \
  "if (score >= 80) return 'saudavel';" \
  "const riscoSlots = Math.round(totalSlots * cfg.agenda_pct_risco);" ; do
  command grep -qF "$marca" "$SCRIPT" || { echo "   FAIL: o SCRIPT nao contem mais <$marca>"; falha_ts=1; }
done
# a allowlist do hook é o universo do lado TS — se ela mudar, o corpus deste harness ficou velho
command grep -qF "'confirmado', 'faturado', 'entregue'" "$HOOK" || {
  echo "   FAIL: a allowlist de status do hook MUDOU — o corpus deste harness nao representa mais o hook"; falha_ts=1; }
[ "$falha_ts" -eq 0 ] || { echo "FAIL: copias verbatim divergiram do hook"; exit 1; }
echo "   ✓ copias verbatim casam com o hook"

echo "→ 6. rodando o motor (TS real de src/) sobre o corpus…"
( cd "$REPO_ROOT" && bun scripts/paridade-farmer-scoring.ts "$WORK" "$OUT/relatorio.json" ) > "$OUT/relatorio.txt" 2>&1 || {
  echo "FAIL: o lado TS abortou"; tail -30 "$OUT/relatorio.txt"; exit 1; }
cp "$WORK"/*.csv "$OUT/" 2>/dev/null || true
cp "$WORK/agora.txt" "$WORK/personas.json" "$OUT/" 2>/dev/null || true
echo "   ✓ relatorio em logs/paridade-fu4f/relatorio.json"

# ─── FALSIFICAÇÃO ─────────────────────────────────────────────────────────────────────────────
# Sem isto o harness é teatro: um comparador MORTO reportaria "agenda idêntica, zero mudanças" —
# que é exatamente o resultado que se espera da agenda. "Ausência de sinal não é aprovação."
# As sabotagens rodam sobre uma CÓPIA do script em $WORK; nem `src/` nem `scripts/` são tocados
# (money-path.md: sabotar in-place deixa o repo sujo e um `git add -A` commitaria a sabotagem).
echo ""
echo "→ 7. FALSIFICAÇÃO — os asserts têm dente?"
falsif_ok=1

# baseline explícito (a Lei #3 exige verde ANTES, com o denominador à vista)
BASE_FAIXA=$(bun -e "const r=require('$OUT/relatorio.json');console.log(r.personas.map(p=>p.mudou_faixa).join(','))")
BASE_AGENDA=$(bun -e "const r=require('$OUT/relatorio.json');console.log(r.personas.map(p=>p.agenda_identica).join(','))")
echo "   baseline: mudou_faixa=[$BASE_FAIXA] agenda_identica=[$BASE_AGENDA]"

# F1 — o comparador de FAIXA tem dente? Força a faixa do lado SQL a 'verde' para todos.
#      Se `mudou_faixa` NÃO subir, o comparador não está comparando nada.
cp "$SCRIPT" "$SAB"
perl -0pi -e "s/faixaSQL: noEscopo \? \(linha\?\.faixa \?\? 'neutro'\) : 'neutro',/faixaSQL: 'verde',/" "$SAB"
command grep -qF "faixaSQL: 'verde'," "$SAB" || { echo "   F1 INVALIDA: a sabotagem nao aplicou"; falsif_ok=0; }
if [ "$falsif_ok" -eq 1 ]; then
  ( cd "$REPO_ROOT" && bun "$SAB" "$WORK" "$WORK/f1.json" ) >/dev/null 2>&1 || { echo "   F1 INVALIDA: script sabotado nao compila/roda"; falsif_ok=0; }
fi
if [ "$falsif_ok" -eq 1 ]; then
  F1=$(bun -e "const r=require('$WORK/f1.json');console.log(r.personas.map(p=>p.mudou_faixa).join(','))")
  if [ "$F1" = "$BASE_FAIXA" ]; then echo "   ✗ F1 SEM DENTE: mudou_faixa igual ao baseline ($F1)"; falsif_ok=0
  else echo "   ✓ F1: comparador de faixa reage (baseline=[$BASE_FAIXA] → sabotado=[$F1])"; fi
fi

# F2 — o comparador de HEALTH/CLASSE tem dente? Desloca o `g` do lado SQL em +0,5.
cp "$SCRIPT" "$SAB"
perl -0pi -e "s/const gSQL = linha\?\.g \?\? null;/const gSQL = linha?.g == null ? null : Math.min(1, Number(linha.g) + 0.5);/" "$SAB"
command grep -qF "Number(linha.g) + 0.5" "$SAB" || { echo "   F2 INVALIDA: a sabotagem nao aplicou"; falsif_ok=0; }
if [ "$falsif_ok" -eq 1 ]; then
  ( cd "$REPO_ROOT" && bun "$SAB" "$WORK" "$WORK/f2.json" ) >/dev/null 2>&1 || { echo "   F2 INVALIDA: script sabotado nao roda"; falsif_ok=0; }
  BASE_CLASSE=$(bun -e "const r=require('$OUT/relatorio.json');console.log(r.personas.map(p=>p.mudou_classe).join(','))")
  F2=$(bun -e "const r=require('$WORK/f2.json');console.log(r.personas.map(p=>p.mudou_classe).join(','))")
  if [ "$F2" = "$BASE_CLASSE" ]; then echo "   ✗ F2 SEM DENTE: mudou_classe igual ao baseline ($F2)"; falsif_ok=0
  else echo "   ✓ F2: comparador de health/classe reage (baseline=[$BASE_CLASSE] → sabotado=[$F2])"; fi
fi

# F3 — O MAIS IMPORTANTE. A agenda deve sair IDÊNTICA no baseline (nenhuma dimensão de prioridade
#      lê `g`). Um comparador quebrado diria o mesmo. Aqui a prioridade do lado SQL é perturbada:
#      se `agenda_identica` continuar true, a comparação de agenda é VÁCUA e o "zero" não vale.
cp "$SCRIPT" "$SAB"
perl -0pi -e "s/const scoresSQL = \[\.\.\.scores\]\.sort\(\(a, b\) => b\.priorityScore - a\.priorityScore\);/const scoresSQL = [...scores].map((s,i) => i % 3 === 0 ? {...s, churnRisk: s.churnRisk + 50, priorityScore: s.priorityScore + 50} : s).sort((a, b) => b.priorityScore - a.priorityScore);/" "$SAB"
command grep -qF "churnRisk: s.churnRisk + 50" "$SAB" || { echo "   F3 INVALIDA: a sabotagem nao aplicou"; falsif_ok=0; }
if [ "$falsif_ok" -eq 1 ]; then
  ( cd "$REPO_ROOT" && bun "$SAB" "$WORK" "$WORK/f3.json" ) >/dev/null 2>&1 || { echo "   F3 INVALIDA: script sabotado nao roda"; falsif_ok=0; }
  F3=$(bun -e "const r=require('$WORK/f3.json');console.log(r.personas.map(p=>p.agenda_identica).join(','))")
  if command grep -q "true" <<<"$F3"; then echo "   ✗ F3 SEM DENTE: agenda_identica segue true com a prioridade perturbada ($F3)"; falsif_ok=0
  else echo "   ✓ F3: comparador de agenda reage (baseline=[$BASE_AGENDA] → sabotado=[$F3])"; fi
fi

echo ""
if [ "$falsif_ok" -ne 1 ]; then
  echo "❌ FALSIFICACAO REPROVADA — algum comparador nao tem dente; o numero deste harness NAO vale"
  exit 1
fi

# ─── CENÁRIO C — o CUSTO DE PRODUTO de alinhar a allowlist do hook ────────────────────────────
# A correção "óbvia" (trocar a allowlist do hook pela denylist do helper) NÃO é neutra: ela muda
# o universo de `sales_orders` que alimenta TODAS as dimensões — recência, frequência, spend e
# mix — e não só a margem. Medir aqui é o que separa uma proposta com número de uma com adjetivo.
echo "→ 8. CENARIO C — e se a allowlist do hook fosse alinhada a denylist?"
Q -c "\copy (SELECT so.id, so.customer_user_id, COALESCE(so.items,'[]'::jsonb) AS items, COALESCE(so.total,0) AS total, so.created_at, so.order_date_kpi FROM public.sales_orders so WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL AND so.customer_user_id IS NOT NULL ORDER BY so.id) TO '$WORK/pedidos-denylist.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
( cd "$REPO_ROOT" && bun scripts/paridade-farmer-scoring.ts "$WORK" "$OUT/relatorio-denylist.json" pedidos-denylist.csv ) > "$OUT/relatorio-denylist.txt" 2>&1 || {
  echo "FAIL: cenario C abortou"; tail -20 "$OUT/relatorio-denylist.txt"; exit 1; }
cp "$WORK/pedidos-denylist.csv" "$OUT/" 2>/dev/null || true

bun -e '
const a = require("'"$OUT"'/relatorio.json"), b = require("'"$OUT"'/relatorio-denylist.json");
console.log("   pedidos  " + a.corpus.pedidos + " → " + b.corpus.pedidos);
console.log("   clientes pontuados " + a.corpus.clientes_pontuados + " → " + b.corpus.clientes_pontuados);
for (let i = 0; i < a.personas.length; i++) {
  const pa = a.personas[i], pb = b.personas.find(x => x.id === pa.id);
  const setA = new Set(pa.agenda_lista.map(s => s.split(":")[1]));
  const setB = new Set(pb.agenda_lista.map(s => s.split(":")[1]));
  const saiu = [...setA].filter(c => !setB.has(c)).length;
  const entrou = [...setB].filter(c => !setA.has(c)).length;
  console.log("   " + pa.rotulo + " " + pa.id.slice(0,8) +
    " | agenda troca " + saiu + " de " + pa.agenda_lista.length + " slots" +
    " | clientes sem margem no SQL: " + (pa.clientes - pa.margem_nos_dois - pa.margem_so_no_sql) +
    " → " + (pb.clientes - pb.margem_nos_dois - pb.margem_so_no_sql));
  if (saiu !== entrou) console.log("      (assimetria saiu/entrou: " + saiu + "/" + entrou + ")");
}
'
# ─── CENÁRIO D — o eixo ESCOPO: e se a tela do farmer listasse só a carteira dele? ────────────
# É o eixo DOMINANTE do delta (472/379 clientes perdendo o sinal de margem), e ele não se
# conserta mexendo em filtro de status. Aqui a TELA é alinhada à RPC. ⚠️ Isso muda a POPULAÇÃO
# do cálculo, e a população é o denominador de `m` (p95 de spend) e da régua de `g` (p10/p90) —
# ou seja, mexe em dimensões que a agenda LÊ. Diferente do cenário A, aqui a agenda pode mudar.
echo "→ 9. CENARIO D — tela do farmer restrita a carteira (eixo ESCOPO)"
( cd "$REPO_ROOT" && bun scripts/paridade-farmer-scoring.ts "$WORK" "$OUT/relatorio-escopo.json" pedidos.csv escopo-carteira ) > "$OUT/relatorio-escopo.txt" 2>&1 || {
  echo "FAIL: cenario D abortou"; tail -20 "$OUT/relatorio-escopo.txt"; exit 1; }

bun -e '
const a = require("'"$OUT"'/relatorio.json"), d = require("'"$OUT"'/relatorio-escopo.json");
for (let i = 0; i < a.personas.length; i++) {
  const pa = a.personas[i], pd = d.personas.find(x => x.id === pa.id);
  const setA = new Set(pa.agenda_lista.map(s => s.split(":")[1]));
  const setD = new Set(pd.agenda_lista.map(s => s.split(":")[1]));
  const trocou = [...setA].filter(c => !setD.has(c)).length;
  const semMargemA = pa.clientes - pa.margem_nos_dois - pa.margem_so_no_sql;
  const semMargemD = pd.clientes - pd.margem_nos_dois - pd.margem_so_no_sql;
  console.log("   " + pd.rotulo + " " + pd.id.slice(0,8) + (pd.capTodo ? " [controle: cap_carteira_ler]" : ""));
  console.log("      clientes na tela  " + pa.clientes + " → " + pd.clientes);
  console.log("      muda de faixa     " + pa.mudou_faixa + " (" + pa.mudou_faixa_pct + "%) → " +
              pd.mudou_faixa + " (" + pd.mudou_faixa_pct + "%)");
  console.log("      muda de classe    " + pa.mudou_classe + " (" + pa.mudou_classe_pct + "%) → " +
              pd.mudou_classe + " (" + pd.mudou_classe_pct + "%)");
  console.log("      sem margem no SQL " + semMargemA + " → " + semMargemD);
  console.log("      agenda troca      " + trocou + " de " + pa.agenda_lista.length + " slots");
}
'
echo ""
echo "✅ paridade TS×SQL medida + 3 falsificacoes com dente + cenarios C e D quantificados"
echo "   numeros: logs/paridade-fu4f/relatorio{,-denylist,-escopo}.json"
