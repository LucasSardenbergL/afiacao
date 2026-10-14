# Ciclo financeiro — cockpit + cliente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aba "Ciclo" (master-only) em `/financeiro/capital-giro` com cockpit PME/PMR/PMP por empresa e fila de clientes com perfil de pagamento, alavanca sugerida e cenários em R$ rotulados.

**Architecture:** 3 views SQL de FATOS (`security_invoker=on`) sobre `fin_contas_receber` ⋈ `v_titulo_baixas`; regra (confiança, perfil, alavanca, cenários, desconto) num helper TS puro testado em vitest; hooks react-query + componentes shadcn. Sem edge nova. Deploy = 1 migration + Publish.

**Tech Stack:** Postgres 17 (prova PG17 `db/lib/pg-harness.sh`), React 18 + TS strict, @tanstack/react-query, shadcn/ui, recharts, vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-ciclo-financeiro-cockpit-cliente-design.md` (v2, challenge Codex adotado). Leia a spec ANTES de cada task.

## Global Constraints

- Respostas/comentários/commits em pt-BR; commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nunca editar migration existente em `supabase/migrations/` — só criar o arquivo novo desta entrega.
- Toda view: `WITH (security_invoker=on)`; `REVOKE ALL ... FROM PUBLIC, anon`; `GRANT SELECT ... TO authenticated, service_role`.
- Data de negócio: `(now() AT TIME ZONE 'America/Sao_Paulo')::date` — nunca `current_date`.
- Predicado numérico money-path fecha 3 lados: `IS NOT NULL`, `<> 'NaN'`, `< 'Infinity'`.
- Ausente ≠ zero: helper devolve `null` + motivo, nunca `0` fabricado. `Number(null)` proibido.
- Leitura PostgREST de lista potencialmente > 1.000 linhas: `fetchAllPages` de `@/lib/postgrest` com `.order` estável.
- `error` de leitura → lança (react-query `error`) → UI de erro explícita; lista vazia com sucesso → `<EmptyState tone="operational">`.
- UI: `text-status-*` (nunca `text-red-600`), `<PageSkeleton>`, toasts só `sonner`, filtros com `useUrlState`, `track('financeiro.ciclo_*')`.
- Gate: aba renderizada só se `useAuth().isMaster`.
- Constantes da spec (verbatim): carência 3d; perfil `folga ≤ −3`, `pontual (−3,0]`, `atraso_leve (0,7]`, `atraso_cronico > 7`; confiança `media` = `n_documentos ≥ 6` e `ultima_baixa ≥ hoje_sp − 90`; degraus `[90, 75, 60, 56, 45, 42, 35, 30, 28, 21, 14, 7]`, sem 7→0; `d_max = 1 − (1+c)^(−N/30)`.
- Caveat fixo (verbatim): "Direcional. Prazo concedido = vencimento − emissão de cada parcela (vencimento vigente; renegociação apaga o original). Todo R$ é cenário, não previsão — não há piloto medido."
- Rodar testes com prefixo `heavy` (RAM M2 8GB): `heavy bun run test -- <arquivo>`.

## Review Focus

1. **Cliente só com vencidas abertas (sem nenhuma paga)** — deve aparecer na fila, no topo da cobrança, com perfil `sem_dado` e sem cenário recorrente. Teste no Task 1 (SQL: linha existe no resumo) e Task 2 (helper: alavanca `recuperar_vencido`).
2. **Custo do dinheiro digitado com vírgula/vazio/"abc"/negativo** (`"2,5"`, `""`, `"-1"`) — input BR com vírgula deve funcionar; o resto fail-closed com mensagem, nunca "0%". Teste no Task 2 (`parseCustoMensal`).
3. **Cliente com `volume_emitido_12m` NULL (nada emitido em 12m, só pagamentos de dívida antiga)** — cenário `null` com motivo "sem volume na janela", nunca R$ 0. Teste no Task 2.
4. **Nome de cliente NULL ou cliente com mesmo nome em 2 empresas** — chave é `(company, omie_codigo_cliente)`; React key e drill usam a chave composta. Teste no Task 4 (render com nomes duplicados).
5. **Engine de caixa falha para UMA empresa** — os cards daquela empresa mostram "—" + motivo; as outras e a fila seguem. Teste no Task 4.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql` (criar) | 3 views + grants + postcondição |
| `db/test-fin-ciclo-cliente.sh` (criar) | Prova PG17 com controle verde + falsificação |
| `src/lib/financeiro/ciclo-cliente-helpers.ts` (criar) | Regra pura: num, confiança, perfil, degrau, alavanca, cenários, desconto |
| `src/lib/financeiro/__tests__/ciclo-cliente-helpers.test.ts` (criar) | vitest do helper |
| `src/hooks/useFinanceiroCiclo.ts` (criar) | Leituras react-query (resumo paginado, coorte, receita TTM, títulos do cliente) |
| `src/components/financeiro/cashflow/ciclo/CicloTab.tsx` (criar) | Composição da aba + caveat + sensor |
| `src/components/financeiro/cashflow/ciclo/CicloEmpresaCards.tsx` (criar) | Faixa por empresa (engine + coorte + R$/dia) |
| `src/components/financeiro/cashflow/ciclo/CicloTendencia.tsx` (criar) | Gráfico por coorte de vencimento |
| `src/components/financeiro/cashflow/ciclo/CicloClientesTabela.tsx` (criar) | Fila de clientes + filtros |
| `src/components/financeiro/cashflow/ciclo/CicloClienteDrill.tsx` (criar) | Sheet com parcelas do cliente |
| `src/components/financeiro/cashflow/ciclo/CicloDescontoPainel.tsx` (criar) | Input `c` + tabela N→d_max |
| `src/components/financeiro/cashflow/ciclo/__tests__/CicloTab.test.tsx` (criar) | Componente: gate, erro≠vazio, chave composta, engine parcial |
| `src/pages/FinanceiroCapitalGiro.tsx` (modificar) | Registrar aba master-only |
| `docs/agent/financeiro.md` (modificar) | Lição: prazo concedido por parcela, censura, fórmula do desconto |

Manifesto: todos os arquivos caem nos globs já existentes do módulo `financeiro` (`src/lib/financeiro/**`, `src/components/financeiro/**`, `src/hooks/useFinanceiro*.ts`, `src/pages/Financeiro*.tsx`) — **não** editar `manifesto.ts`. Confirmar no Task 5 com `bun run test -- src/lib/modulos` (o gate de manifesto).

---

### Task 1: Migration das 3 views + prova PG17

**Files:**
- Create: `supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql`
- Create: `db/test-fin-ciclo-cliente.sh`

**Interfaces:**
- Consumes: `public.fin_contas_receber(company text, omie_codigo_cliente bigint, nome_cliente text, omie_codigo_lancamento bigint, numero_documento text, data_emissao date, data_vencimento date, valor_documento numeric, saldo numeric, status_titulo text)`; `public.v_titulo_baixas(company text, omie_codigo_lancamento bigint, tipo text, data_baixa_final date, valor_baixado numeric, n_movimentos int, prazo_ponderado_dias numeric, origem_baixa text)` — tipos medidos em prod 2026-10-14.
- Produces (colunas exatas que o Task 3 lê):
  - `v_ciclo_cr_titulos`: `company, omie_codigo_cliente, nome_cliente, omie_codigo_lancamento, numero_documento, data_emissao, data_vencimento, data_baixa, valor_documento, saldo, situacao ('paga'|'paga_sem_baixa'|'vencida_aberta'|'status_ambiguo'), prazo_concedido_dias int, prazo_real_dias numeric, atraso_dias numeric, dias_vencido int`
  - `v_ciclo_cliente_resumo`: `company, omie_codigo_cliente, nome_cliente, n_parcelas, n_documentos, valor_pago, valor_pago_sem_baixa, prazo_concedido_pond, prazo_real_pond, atraso_pond, atraso_p50, atraso_p80, atraso_p80_valor, atraso_max_observado, excesso_carencia_pond, pct_valor_atrasado, ultima_baixa, n_vencidas, saldo_vencido, saldo_vencido_90, dias_vencido_max, volume_emitido_12m, primeira_emissao, n_status_ambiguo`
  - `v_ciclo_empresa_coorte`: `company, mes_vencimento date, valor_vencido_no_mes, valor_pago, valor_em_aberto, pct_valor_pago, prazo_concedido_pond, prazo_real_pond_pagas, atraso_pond_pagas, mes_parcial bool`

- [ ] **Step 1: Escrever a prova (falha: migration não existe)**

Criar `db/test-fin-ciclo-cliente.sh` (modelo: `db/test-fin-encargos-titulo.sh`, mesmo harness):

```bash
#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261014120000_fin_ciclo_cliente_views                       ║
# ║  v_ciclo_cr_titulos / v_ciclo_cliente_resumo / v_ciclo_empresa_coorte      ║
# ║      bash db/test-fin-ciclo-cliente.sh > logs/t.log 2>&1; echo "exit=$?"    ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-cliente.sh  (2º ambiente)        ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocação + 1 sabotagem por invariante de dinheiro, sobre CÓPIA da
# migration (o repo nunca é tocado). Asserções em ASCII, caixa fixa.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5473}"
SLUG="fin-ciclo-cliente"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
CREATE TABLE public.fin_contas_receber (
  company text, omie_codigo_cliente bigint, nome_cliente text, omie_codigo_lancamento bigint,
  numero_documento text, data_emissao date, data_vencimento date, valor_documento numeric,
  saldo numeric, status_titulo text);
-- v_titulo_baixas é VIEW em prod; aqui basta uma tabela com as mesmas colunas/tipos.
CREATE TABLE public.v_titulo_baixas (
  company text, omie_codigo_lancamento bigint, tipo text, data_baixa_final date,
  valor_baixado numeric, n_movimentos integer, prazo_ponderado_dias numeric, origem_baixa text);
SQL
  # Fixtures relativas a hoje_sp (mesma expressão da view).
  P <<'SQL'
DO $f$
DECLARE h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  -- Cliente 1 (oben): 2 docs pagos — antecipou 5d (R$100) e atrasou 10d (R$300).
  INSERT INTO fin_contas_receber VALUES
    ('oben',1,'CLI UM',101,'D1',h-60,h-30,100,0,'RECEBIDO'),
    ('oben',1,'CLI UM',102,'D2',h-50,h-20,300,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES
    ('oben',101,'CR',h-35,100,1,25,'titulo'),   -- prazo real 25, concedido 30 → atraso −5
    ('oben',102,'CR',h-10,300,1,40,'titulo');   -- prazo real 40, concedido 30 → atraso +10
  -- Cliente 1: cancelado (deve sumir) e valor 0 / NaN / Infinity (devem sumir).
  INSERT INTO fin_contas_receber VALUES
    ('oben',1,'CLI UM',103,'D3',h-50,h-20,999,0,'CANCELADO'),
    ('oben',1,'CLI UM',104,'D4',h-50,h-20,0,0,'RECEBIDO'),
    ('oben',1,'CLI UM',105,'D5',h-50,h-20,'NaN',0,'RECEBIDO'),
    ('oben',1,'CLI UM',106,'D6',h-50,h-20,'Infinity',0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES
    ('oben',103,'CR',h-10,999,1,40,'titulo'),
    ('oben',104,'CR',h-10,0,1,40,'titulo'),
    ('oben',105,'CR',h-10,1,1,40,'titulo'),
    ('oben',106,'CR',h-10,1,1,40,'titulo');
  -- Cliente 1: emissão > vencimento (inválido, some).
  INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',107,'D7',h-10,h-20,50,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES ('oben',107,'CR',h-5,50,1,5,'titulo');
  -- Cliente 1: RECEBIDO sem baixa derivada dentro da janela → paga_sem_baixa (cobertura).
  INSERT INTO fin_contas_receber VALUES ('oben',1,'CLI UM',108,'D8',h-40,h-15,70,0,'RECEBIDO');
  -- Cliente 2 (oben): SÓ vencidas abertas — 10d (R$40) e 120d (R$60). Nenhuma paga.
  INSERT INTO fin_contas_receber VALUES
    ('oben',2,'CLI DOIS',201,'E1',h-40,h-10,40,40,'ATRASADO'),
    ('oben',2,'CLI DOIS',202,'E2',h-150,h-120,60,60,'ATRASADO');
  -- Cliente 3 (colacor): status ambíguo (fallback do ingest).
  INSERT INTO fin_contas_receber VALUES ('colacor',3,'CLI TRES',301,'F1',h-40,h-10,80,80,'VENCIDO');
  -- Cliente 4 (oben): paga mas vencimento fora da janela (400d) → não é 'paga'.
  INSERT INTO fin_contas_receber VALUES ('oben',4,'CLI QUATRO',401,'G1',h-430,h-400,500,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES ('oben',401,'CR',h-395,500,1,35,'titulo');
END $f$;
SQL
}

# Asserção: SQL → valor esperado (texto exato).
falhas=0
ok() {
  local got; got="$(Pq -c "$1")"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

suite() {
  falhas=0
  preparar_banco
  P -f "$1"
  # Populações
  ok "SELECT count(*) FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento IN (103,104,105,106,107)" "0" "cancelado/zero/NaN/inf/emissao>venc somem"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=108" "paga_sem_baixa" "recebido sem baixa = paga_sem_baixa"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=202" "vencida_aberta" "vencida aberta de qualquer idade"
  ok "SELECT situacao FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=301" "status_ambiguo" "status de fallback = ambiguo"
  ok "SELECT count(*) FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=401" "0" "paga fora da janela de vencimento nao entra"
  ok "SELECT atraso_dias FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=102" "10" "atraso = prazo_real - concedido"
  ok "SELECT dias_vencido FROM v_ciclo_cr_titulos WHERE omie_codigo_lancamento=202" "120" "dias_vencido"
  # Resumo cliente 1: pond atraso = (100*-5 + 300*10)/400 = 6.25; excesso = (100*0 + 300*7)/400 = 5.25
  ok "SELECT round(atraso_pond,2) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "6.25" "atraso ponderado"
  ok "SELECT round(excesso_carencia_pond,2) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "5.25" "antecipacao nao cancela atraso"
  ok "SELECT n_documentos FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "2" "documentos independentes"
  ok "SELECT round(valor_pago,0) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "400" "valor pago so validos"
  ok "SELECT round(valor_pago_sem_baixa,0) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "70" "cobertura sem baixa"
  ok "SELECT round(atraso_p80_valor,0) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "10" "p80 por valor"
  ok "SELECT round(pct_valor_atrasado,2) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "0.75" "pct valor atrasado"
  # Cliente 2: existe no resumo só com vencidas
  ok "SELECT n_vencidas||'|'||round(saldo_vencido,0)||'|'||round(saldo_vencido_90,0)||'|'||coalesce(n_parcelas::text,'null') FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=2" "2|100|60|null" "cliente so-vencido aparece"
  ok "SELECT n_status_ambiguo FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=3" "1" "ambiguo contado"
  # Volume emitido 12m (cliente 1): docs validos não cancelados emitidos na janela: 100+300+70 = 470 (107 inválido)
  ok "SELECT round(volume_emitido_12m,0) FROM v_ciclo_cliente_resumo WHERE omie_codigo_cliente=1" "470" "volume por emissao"
  # Coorte: mês das vencidas/pagas existe e pct entre 0 e 1
  ok "SELECT count(*) FROM v_ciclo_empresa_coorte WHERE pct_valor_pago < 0 OR pct_valor_pago > 1" "0" "pct pago em [0,1]"
  ok "SELECT bool_or(mes_parcial) FROM v_ciclo_empresa_coorte" "t" "mes corrente marcado parcial"
  # Segurança
  ok "SELECT count(*) FROM pg_class WHERE relname LIKE 'v_ciclo_%' AND NOT ('security_invoker=on' = ANY(coalesce(reloptions,'{}')))" "0" "security_invoker em todas"
  ok "SELECT bool_or(has_table_privilege('anon','public.'||relname,'SELECT')) FROM pg_class WHERE relname LIKE 'v_ciclo_%'" "f" "anon sem select"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
if ! suite "$TMPD/mig.sql"; then echo "CONTROLE VERMELHO — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

# 2) FALSIFICAÇÃO — cada sabotagem TEM de ficar vermelha.
sabotar() { # $1 nome, $2 expressão sed
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  if suite "$TMPD/sab.sql" >/dev/null 2>&1; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  echo "sabotagem vermelha ok: $1"
}
sabotar "filtro de cancelado" "s/r.status_titulo IS DISTINCT FROM 'CANCELADO'/true/"
sabotar "max(0,.) do excesso" "s/greatest(t.atraso_dias - 3, 0)/(t.atraso_dias - 3)/"
sabotar "sinal do atraso" "s/b.prazo_ponderado_dias - (r.data_vencimento - r.data_emissao)/(r.data_vencimento - r.data_emissao) - b.prazo_ponderado_dias/"
sabotar "status ambiguo" "s/'RECEBIDO','A VENCER','ATRASADO','CANCELADO'/'RECEBIDO','A VENCER','ATRASADO','CANCELADO','VENCIDO'/"
sabotar "finitude" "s/AND r.valor_documento < 'Infinity'//"

echo "PROVA-CICLO-CLIENTE-OK"
```

`chmod +x db/test-fin-ciclo-cliente.sh`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `bash db/test-fin-ciclo-cliente.sh > $TMPDIR/t.log 2>&1; rc=$?; tail -c 800 $TMPDIR/t.log; [ $rc -ne 0 ]`
Expected: falha no `cp` (migration inexistente) — exit ≠ 0.

- [ ] **Step 3: Escrever a migration**

Criar `supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql`:

```sql
-- Ciclo financeiro — fatos por parcela/cliente/coorte (frente 1+2).
-- Spec: docs/superpowers/specs/2026-10-14-ciclo-financeiro-cockpit-cliente-design.md (v2).
-- Views de FATOS: a regra (perfil, alavanca, cenário) vive em src/lib/financeiro/ciclo-cliente-helpers.ts.
-- Prova: db/test-fin-ciclo-cliente.sh (controle verde + falsificação).

BEGIN;

-- ── 1. Por parcela ───────────────────────────────────────────────────────────
-- 'paga'           : baixa derivada + vencimento em [hoje_sp−365, hoje_sp) (coorte por VENCIMENTO).
-- 'paga_sem_baixa' : RECEBIDO na janela sem baixa derivada — só cobertura, nunca média.
-- 'vencida_aberta' : ATRASADO com saldo, QUALQUER idade (envelhecimento em dias_vencido).
-- 'status_ambiguo' : status fora do vocabulário nativo (fallback do ingest) — só contado.
-- prazo_real = v_titulo_baixas.prazo_ponderado_dias (média dos movimentos; cobre parcial).
CREATE OR REPLACE VIEW public.v_ciclo_cr_titulos WITH (security_invoker=on) AS
WITH base AS (
  SELECT r.company, r.omie_codigo_cliente, r.nome_cliente, r.omie_codigo_lancamento,
         r.numero_documento, r.data_emissao, r.data_vencimento, r.valor_documento, r.saldo,
         r.status_titulo, b.data_baixa_final,
         b.prazo_ponderado_dias - (r.data_vencimento - r.data_emissao) AS atraso_calc,
         b.prazo_ponderado_dias,
         (b.omie_codigo_lancamento IS NOT NULL AND b.prazo_ponderado_dias IS NOT NULL) AS tem_baixa,
         (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje_sp
  FROM public.fin_contas_receber r
  LEFT JOIN public.v_titulo_baixas b
    ON b.company = r.company AND b.omie_codigo_lancamento = r.omie_codigo_lancamento AND b.tipo = 'CR'
  WHERE r.status_titulo IS DISTINCT FROM 'CANCELADO'
    AND r.valor_documento IS NOT NULL AND r.valor_documento <> 'NaN'
    AND r.valor_documento < 'Infinity' AND r.valor_documento > 0
    AND r.data_emissao IS NOT NULL AND r.data_vencimento IS NOT NULL
    AND r.data_vencimento >= r.data_emissao
    AND r.omie_codigo_cliente IS NOT NULL
), classif AS (
  SELECT base.*,
    CASE
      WHEN status_titulo IS NULL
        OR status_titulo NOT IN ('RECEBIDO','A VENCER','ATRASADO','CANCELADO') THEN 'status_ambiguo'
      WHEN tem_baixa AND data_vencimento >= hoje_sp - 365 AND data_vencimento < hoje_sp THEN 'paga'
      WHEN NOT tem_baixa AND status_titulo = 'RECEBIDO'
        AND data_vencimento >= hoje_sp - 365 AND data_vencimento < hoje_sp THEN 'paga_sem_baixa'
      WHEN NOT tem_baixa AND status_titulo = 'ATRASADO'
        AND saldo IS NOT NULL AND saldo <> 'NaN' AND saldo < 'Infinity' AND saldo > 0 THEN 'vencida_aberta'
    END AS situacao
  FROM base
)
SELECT company, omie_codigo_cliente, nome_cliente, omie_codigo_lancamento, numero_documento,
       data_emissao, data_vencimento,
       CASE WHEN situacao = 'paga' THEN data_baixa_final END AS data_baixa,
       valor_documento, saldo, situacao,
       (data_vencimento - data_emissao) AS prazo_concedido_dias,
       CASE WHEN situacao = 'paga' THEN prazo_ponderado_dias END AS prazo_real_dias,
       CASE WHEN situacao = 'paga' THEN atraso_calc END AS atraso_dias,
       CASE WHEN situacao = 'vencida_aberta' THEN hoje_sp - data_vencimento END AS dias_vencido
FROM classif
WHERE situacao IS NOT NULL;
```

> ⚠️ A sabotagem "sinal do atraso" do Step 1 faz `sed` sobre o texto `b.prazo_ponderado_dias - (r.data_vencimento - r.data_emissao)` — mantenha essa grafia exata na linha `atraso_calc`. O mesmo vale para `r.status_titulo IS DISTINCT FROM 'CANCELADO'`, `AND r.valor_documento < 'Infinity'`, `'RECEBIDO','A VENCER','ATRASADO','CANCELADO'` e `greatest(t.atraso_dias - 3, 0)`.

Continuar no mesmo arquivo:

```sql
-- ── 2. Por cliente ───────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_ciclo_cliente_resumo WITH (security_invoker=on) AS
WITH t AS (SELECT * FROM public.v_ciclo_cr_titulos),
hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS h),
pagas AS (
  SELECT t.company, t.omie_codigo_cliente,
         count(*)::int AS n_parcelas,
         count(DISTINCT coalesce(t.numero_documento, t.omie_codigo_lancamento::text))::int AS n_documentos,
         sum(t.valor_documento) AS valor_pago,
         sum(t.valor_documento * t.prazo_concedido_dias) / sum(t.valor_documento) AS prazo_concedido_pond,
         sum(t.valor_documento * t.prazo_real_dias) / sum(t.valor_documento) AS prazo_real_pond,
         sum(t.valor_documento * t.atraso_dias) / sum(t.valor_documento) AS atraso_pond,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY t.atraso_dias) AS atraso_p50,
         percentile_cont(0.8) WITHIN GROUP (ORDER BY t.atraso_dias) AS atraso_p80,
         max(t.atraso_dias) AS atraso_max_observado,
         sum(t.valor_documento * greatest(t.atraso_dias - 3, 0)) / sum(t.valor_documento) AS excesso_carencia_pond,
         coalesce(sum(t.valor_documento) FILTER (WHERE t.atraso_dias > 0), 0) / sum(t.valor_documento) AS pct_valor_atrasado,
         max(t.data_baixa) AS ultima_baixa
  FROM t WHERE t.situacao = 'paga'
  GROUP BY t.company, t.omie_codigo_cliente
),
p80v AS ( -- percentil 80 ponderado por R$: menor atraso cujo acumulado de valor alcança 80%
  SELECT company, omie_codigo_cliente, min(atraso_dias) AS atraso_p80_valor
  FROM (
    SELECT company, omie_codigo_cliente, atraso_dias,
           sum(valor_documento) OVER (PARTITION BY company, omie_codigo_cliente
                                      ORDER BY atraso_dias, omie_codigo_lancamento)
           / sum(valor_documento) OVER (PARTITION BY company, omie_codigo_cliente) AS acum
    FROM t WHERE situacao = 'paga'
  ) x
  WHERE acum >= 0.8
  GROUP BY company, omie_codigo_cliente
),
sem_baixa AS (
  SELECT company, omie_codigo_cliente, sum(valor_documento) AS valor_pago_sem_baixa
  FROM t WHERE situacao = 'paga_sem_baixa' GROUP BY 1, 2
),
vencidas AS (
  SELECT company, omie_codigo_cliente,
         count(*)::int AS n_vencidas, sum(saldo) AS saldo_vencido,
         coalesce(sum(saldo) FILTER (WHERE dias_vencido > 90), 0) AS saldo_vencido_90,
         max(dias_vencido) AS dias_vencido_max
  FROM t WHERE situacao = 'vencida_aberta' GROUP BY 1, 2
),
ambiguos AS (
  SELECT company, omie_codigo_cliente, count(*)::int AS n_status_ambiguo
  FROM t WHERE situacao = 'status_ambiguo' GROUP BY 1, 2
),
volume AS ( -- competência por EMISSÃO (não recebimento), mesma base válida de v_ciclo_cr_titulos
  SELECT r.company, r.omie_codigo_cliente,
         sum(r.valor_documento) AS volume_emitido_12m, min(r.data_emissao) AS primeira_emissao
  FROM public.fin_contas_receber r, hoje
  WHERE r.status_titulo IS DISTINCT FROM 'CANCELADO'
    AND r.valor_documento IS NOT NULL AND r.valor_documento <> 'NaN'
    AND r.valor_documento < 'Infinity' AND r.valor_documento > 0
    AND r.data_emissao IS NOT NULL AND r.data_vencimento IS NOT NULL
    AND r.data_vencimento >= r.data_emissao AND r.omie_codigo_cliente IS NOT NULL
    AND r.data_emissao >= hoje.h - 365 AND r.data_emissao < hoje.h
  GROUP BY 1, 2
),
chaves AS (
  SELECT company, omie_codigo_cliente FROM pagas
  UNION SELECT company, omie_codigo_cliente FROM vencidas
  UNION SELECT company, omie_codigo_cliente FROM sem_baixa
  UNION SELECT company, omie_codigo_cliente FROM ambiguos
),
nomes AS (
  SELECT company, omie_codigo_cliente, max(nome_cliente) AS nome_cliente FROM t GROUP BY 1, 2
)
SELECT k.company, k.omie_codigo_cliente, n.nome_cliente,
       p.n_parcelas, p.n_documentos, p.valor_pago, sb.valor_pago_sem_baixa,
       p.prazo_concedido_pond, p.prazo_real_pond, p.atraso_pond,
       p.atraso_p50, p.atraso_p80, pv.atraso_p80_valor, p.atraso_max_observado,
       p.excesso_carencia_pond, p.pct_valor_atrasado, p.ultima_baixa,
       v.n_vencidas, v.saldo_vencido, v.saldo_vencido_90, v.dias_vencido_max,
       vol.volume_emitido_12m, vol.primeira_emissao,
       a.n_status_ambiguo
FROM chaves k
LEFT JOIN nomes n     USING (company, omie_codigo_cliente)
LEFT JOIN pagas p     USING (company, omie_codigo_cliente)
LEFT JOIN p80v pv     USING (company, omie_codigo_cliente)
LEFT JOIN sem_baixa sb USING (company, omie_codigo_cliente)
LEFT JOIN vencidas v  USING (company, omie_codigo_cliente)
LEFT JOIN ambiguos a  USING (company, omie_codigo_cliente)
LEFT JOIN volume vol  USING (company, omie_codigo_cliente);

-- ── 3. Por empresa × mês de VENCIMENTO (coorte com censura) ─────────────────
CREATE OR REPLACE VIEW public.v_ciclo_empresa_coorte WITH (security_invoker=on) AS
WITH t AS (
  SELECT * FROM public.v_ciclo_cr_titulos
  WHERE situacao IN ('paga','paga_sem_baixa','vencida_aberta')
    AND data_vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 365
    AND data_vencimento <  (now() AT TIME ZONE 'America/Sao_Paulo')::date
)
SELECT company,
       date_trunc('month', data_vencimento)::date AS mes_vencimento,
       sum(valor_documento) AS valor_vencido_no_mes,
       coalesce(sum(valor_documento) FILTER (WHERE situacao IN ('paga','paga_sem_baixa')), 0) AS valor_pago,
       coalesce(sum(saldo) FILTER (WHERE situacao = 'vencida_aberta'), 0) AS valor_em_aberto,
       coalesce(sum(valor_documento) FILTER (WHERE situacao IN ('paga','paga_sem_baixa')), 0)
         / sum(valor_documento) AS pct_valor_pago,
       sum(valor_documento * prazo_concedido_dias) FILTER (WHERE situacao = 'paga')
         / nullif(sum(valor_documento) FILTER (WHERE situacao = 'paga'), 0) AS prazo_concedido_pond,
       sum(valor_documento * prazo_real_dias) FILTER (WHERE situacao = 'paga')
         / nullif(sum(valor_documento) FILTER (WHERE situacao = 'paga'), 0) AS prazo_real_pond_pagas,
       sum(valor_documento * atraso_dias) FILTER (WHERE situacao = 'paga')
         / nullif(sum(valor_documento) FILTER (WHERE situacao = 'paga'), 0) AS atraso_pond_pagas,
       date_trunc('month', data_vencimento)::date
         = date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')::date)::date AS mes_parcial
FROM t
GROUP BY company, date_trunc('month', data_vencimento);

-- ── 4. Grants (anon fora; RLS das bases via security_invoker) ───────────────
REVOKE ALL ON public.v_ciclo_cr_titulos, public.v_ciclo_cliente_resumo, public.v_ciclo_empresa_coorte FROM PUBLIC, anon;
GRANT SELECT ON public.v_ciclo_cr_titulos, public.v_ciclo_cliente_resumo, public.v_ciclo_empresa_coorte TO authenticated, service_role;

-- ── 5. Postcondição embutida ────────────────────────────────────────────────
DO $post$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_ciclo_cr_titulos','v_ciclo_cliente_resumo','v_ciclo_empresa_coorte'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = v AND c.relkind = 'v'
                     AND 'security_invoker=on' = ANY(coalesce(c.reloptions, '{}'))) THEN
      RAISE EXCEPTION 'postcondicao: view % ausente ou sem security_invoker', v;
    END IF;
    IF has_table_privilege('anon', 'public.' || v, 'SELECT') THEN
      RAISE EXCEPTION 'postcondicao: anon le %', v;
    END IF;
  END LOOP;
  RAISE NOTICE 'CICLO-CLIENTE-VIEWS-OK';
END
$post$;

COMMIT;
```

- [ ] **Step 4: Rodar a prova nos 2 locales**

Run: `bash db/test-fin-ciclo-cliente.sh > $TMPDIR/t1.log 2>&1; rc1=$?; LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-cliente.sh > $TMPDIR/t2.log 2>&1; rc2=$?; tail -c 600 $TMPDIR/t1.log; tail -c 600 $TMPDIR/t2.log; [ $rc1 -eq 0 ] && [ $rc2 -eq 0 ]`
Expected: as duas saídas terminam em `PROVA-CICLO-CLIENTE-OK`, 5 linhas `sabotagem vermelha ok`, exit 0. Se `pt_BR.UTF-8` não existir no `initdb` local, registrar a saída do erro e rodar com `LOCALE=en_US.UTF-8` (2º ambiente não-C).

- [ ] **Step 5: shellcheck + commit**

Run: `bun run lint:shell > $TMPDIR/sc.log 2>&1; rc=$?; tail -c 600 $TMPDIR/sc.log; [ $rc -eq 0 ]`

```bash
git add supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql db/test-fin-ciclo-cliente.sh
git commit -m "feat(financeiro): views de fatos do ciclo por parcela/cliente/coorte + prova PG17 [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Pré-voo contra prod (read-only)**

Rodar o `SELECT` das 3 views como CTE ad-hoc via `~/.config/afiacao/psql-ro` (copiar o corpo das views para `WITH v_ciclo_cr_titulos AS (...)`) e conferir que bate com a spec §2: oben `count(DISTINCT cliente) WHERE n_vencidas>0` ≈ 116, `sum(saldo_vencido)` ≈ R$268k; `atraso_pond` agregado oben ≈ +3,5d. Divergência > 10% → parar e investigar antes do PR.

---

### Task 2: Helper puro `ciclo-cliente-helpers.ts`

**Files:**
- Create: `src/lib/financeiro/ciclo-cliente-helpers.ts`
- Test: `src/lib/financeiro/__tests__/ciclo-cliente-helpers.test.ts`

**Interfaces:**
- Consumes: linha de `v_ciclo_cliente_resumo` (Task 1) como `ResumoClienteRow` (valores podem vir `number | string | null` do PostgREST).
- Produces:
  - `num(x: unknown): number | null`
  - `CARENCIA_DIAS = 3`, `DEGRAUS_PRAZO: readonly number[]`
  - `type Perfil = 'folga' | 'pontual' | 'atraso_leve' | 'atraso_cronico' | 'misto' | 'sem_dado'`
  - `perfilPorP80(p80: number | null): Exclude<Perfil, 'misto'>`
  - `perfilCliente(r: ResumoCliente): { perfil: Perfil; perfilQtd: Perfil; perfilValor: Perfil }`
  - `type Confianca = 'media' | 'baixa'`; `confiancaCliente(r: ResumoCliente, hojeSp: string): Confianca`
  - `degrauAbaixo(prazo: number): number | null`
  - `type Alavanca = 'recuperar_vencido' | 'cobrar_atraso' | 'degrau_prazo' | 'nenhuma'`
  - `type Cenario = { reais: number | null; motivo: string; rotulo: string }`
  - `type SugestaoCliente = { alavanca: Alavanca; texto: string; cenario: Cenario | null; descontoCandidato: boolean; degrau: { de: number; para: number } | null }`
  - `sugerirAlavanca(r: ResumoCliente, hojeSp: string): SugestaoCliente`
  - `type ResultadoDesconto = { ok: true; dMax: number } | { ok: false; motivo: 'custo_ausente' | 'custo_invalido' | 'dias_invalidos' }`
  - `descontoMaximo(custoMensal: number | null, dias: number): ResultadoDesconto`
  - `parseCustoMensal(texto: string): { ok: true; c: number } | { ok: false; motivo: 'custo_ausente' | 'custo_invalido' }` — `"2,5"` → `0.025`
  - `normalizarResumo(row: ResumoClienteRow): ResumoCliente`

- [ ] **Step 1: Escrever os testes**

```ts
// src/lib/financeiro/__tests__/ciclo-cliente-helpers.test.ts
import { describe, expect, it } from 'vitest';
import {
  num, perfilPorP80, perfilCliente, confiancaCliente, degrauAbaixo, sugerirAlavanca,
  descontoMaximo, parseCustoMensal, normalizarResumo, type ResumoCliente,
} from '@/lib/financeiro/ciclo-cliente-helpers';

const HOJE = '2026-10-14';
const base = (o: Partial<ResumoCliente> = {}): ResumoCliente => ({
  company: 'oben', omieCodigoCliente: 1, nomeCliente: 'CLI',
  nParcelas: 8, nDocumentos: 8, valorPago: 36500, valorPagoSemBaixa: null,
  prazoConcedidoPond: 30, prazoRealPond: 30, atrasoPond: 0,
  atrasoP50: 0, atrasoP80: 0, atrasoP80Valor: 0, atrasoMaxObservado: 0,
  excessoCarenciaPond: 0, pctValorAtrasado: 0, ultimaBaixa: '2026-10-01',
  nVencidas: null, saldoVencido: null, saldoVencido90: null, diasVencidoMax: null,
  volumeEmitido12m: 36500, primeiraEmissao: '2025-10-20', nStatusAmbiguo: null, ...o,
});

describe('num', () => {
  it('aceita number e string numérica', () => { expect(num(2)).toBe(2); expect(num('2.5')).toBe(2.5); });
  it('ausente/inválido vira null, nunca 0', () => {
    for (const x of [null, undefined, '', 'abc', NaN, Infinity, -Infinity]) expect(num(x)).toBeNull();
  });
});

describe('perfilPorP80 — fronteiras', () => {
  it.each([
    [-3, 'folga'], [-2.99, 'pontual'], [0, 'pontual'], [0.01, 'atraso_leve'],
    [7, 'atraso_leve'], [7.01, 'atraso_cronico'], [null, 'sem_dado'],
  ] as const)('p80=%s → %s', (p80, esperado) => { expect(perfilPorP80(p80)).toBe(esperado); });
});

describe('perfilCliente', () => {
  it('leituras divergentes → misto', () => {
    expect(perfilCliente(base({ atrasoP80: 0, atrasoP80Valor: 10 })).perfil).toBe('misto');
  });
  it('leituras iguais → o perfil', () => {
    expect(perfilCliente(base({ atrasoP80: 10, atrasoP80Valor: 12 })).perfil).toBe('atraso_cronico');
  });
});

describe('confiancaCliente', () => {
  it('6 documentos e baixa há 90d → media', () => {
    expect(confiancaCliente(base({ nDocumentos: 6, ultimaBaixa: '2026-07-16' }), HOJE)).toBe('media');
  });
  it('5 documentos → baixa', () => { expect(confiancaCliente(base({ nDocumentos: 5 }), HOJE)).toBe('baixa'); });
  it('baixa há 91d → baixa', () => {
    expect(confiancaCliente(base({ ultimaBaixa: '2026-07-15' }), HOJE)).toBe('baixa');
  });
  it('sem nenhuma paga → baixa', () => {
    expect(confiancaCliente(base({ nDocumentos: null, ultimaBaixa: null }), HOJE)).toBe('baixa');
  });
});

describe('degrauAbaixo', () => {
  it.each([[30, 28], [31, 30], [28, 21], [8, 7], [7, null], [3, null], [120, 90]] as const)(
    '%s → %s', (de, para) => { expect(degrauAbaixo(de)).toBe(para); });
});

describe('sugerirAlavanca', () => {
  it('vencida aberta vence tudo, e não soma ao recorrente', () => {
    const s = sugerirAlavanca(base({ saldoVencido: 1000, saldoVencido90: 600, atrasoP80: 10, atrasoP80Valor: 10, excessoCarenciaPond: 5 }), HOJE);
    expect(s.alavanca).toBe('recuperar_vencido');
    expect(s.cenario?.reais).toBe(1000);
    expect(s.cenario?.rotulo).toMatch(/estoque vencido/);
  });
  it('cliente só-vencido (sem pagas) → recuperar_vencido', () => {
    const s = sugerirAlavanca(base({ nParcelas: null, nDocumentos: null, valorPago: null, atrasoP80: null, atrasoP80Valor: null, ultimaBaixa: null, saldoVencido: 100 }), HOJE);
    expect(s.alavanca).toBe('recuperar_vencido');
  });
  it('atraso crônico → cenário = excesso × volume/365', () => {
    const s = sugerirAlavanca(base({ atrasoP80: 10, atrasoP80Valor: 10, excessoCarenciaPond: 5, volumeEmitido12m: 36500 }), HOJE);
    expect(s.alavanca).toBe('cobrar_atraso');
    expect(s.cenario?.reais).toBeCloseTo(500, 6);
    expect(s.descontoCandidato).toBe(false);
  });
  it('atraso leve → cobrar + candidato a desconto', () => {
    const s = sugerirAlavanca(base({ atrasoP80: 4, atrasoP80Valor: 4, excessoCarenciaPond: 1 }), HOJE);
    expect(s.alavanca).toBe('cobrar_atraso');
    expect(s.descontoCandidato).toBe(true);
  });
  it('volume ausente → cenário null com motivo, nunca 0', () => {
    const s = sugerirAlavanca(base({ atrasoP80: 10, atrasoP80Valor: 10, excessoCarenciaPond: 5, volumeEmitido12m: null }), HOJE);
    expect(s.cenario?.reais).toBeNull();
    expect(s.cenario?.motivo).toBe('sem volume na janela');
  });
  it('pontual → degrau 30→28 com cenário 2 × volume/365', () => {
    const s = sugerirAlavanca(base(), HOJE);
    expect(s.alavanca).toBe('degrau_prazo');
    expect(s.degrau).toEqual({ de: 30, para: 28 });
    expect(s.cenario?.reais).toBeCloseTo(200, 6);
    expect(s.cenario?.rotulo).toMatch(/se continuar pagando no vencimento/);
  });
  it('folga → degrau sem R$', () => {
    const s = sugerirAlavanca(base({ atrasoP80: -5, atrasoP80Valor: -5 }), HOJE);
    expect(s.alavanca).toBe('degrau_prazo');
    expect(s.cenario?.reais).toBeNull();
    expect(s.cenario?.motivo).toBe('benefício depende de piloto');
  });
  it('baixa confiança → nenhuma (sem vencida)', () => {
    expect(sugerirAlavanca(base({ nDocumentos: 3 }), HOJE).alavanca).toBe('nenhuma');
  });
  it('misto → nenhuma', () => {
    expect(sugerirAlavanca(base({ atrasoP80: 0, atrasoP80Valor: 10 }), HOJE).alavanca).toBe('nenhuma');
  });
  it('prazo 7 pontual → sem degrau (nunca 7→0)', () => {
    const s = sugerirAlavanca(base({ prazoConcedidoPond: 7 }), HOJE);
    expect(s.alavanca).toBe('nenhuma');
    expect(s.degrau).toBeNull();
  });
});

describe('descontoMaximo — d = 1 − (1+c)^(−N/30)', () => {
  it('c=2%, N=30 → 1,9608%', () => {
    const r = descontoMaximo(0.02, 30);
    expect(r.ok && r.dMax).toBeCloseTo(0.0196078, 6);
  });
  it('custo ausente → marca custo_ausente', () => {
    expect(descontoMaximo(null, 30)).toEqual({ ok: false, motivo: 'custo_ausente' });
  });
  it.each([0, -0.01, NaN, Infinity])('custo %s → custo_invalido (nunca 0%%)', (c) => {
    expect(descontoMaximo(c, 30)).toEqual({ ok: false, motivo: 'custo_invalido' });
  });
  it.each([0, -1, NaN])('N=%s → dias_invalidos', (n) => {
    expect(descontoMaximo(0.02, n)).toEqual({ ok: false, motivo: 'dias_invalidos' });
  });
});

describe('parseCustoMensal (input BR)', () => {
  it('"2,5" → 0.025 e "2.5" → 0.025', () => {
    expect(parseCustoMensal('2,5')).toEqual({ ok: true, c: 0.025 });
    expect(parseCustoMensal(' 2.5 ')).toEqual({ ok: true, c: 0.025 });
  });
  it('vazio → custo_ausente', () => { expect(parseCustoMensal('  ')).toEqual({ ok: false, motivo: 'custo_ausente' }); });
  it.each(['abc', '-1', '0', '1e999'])('"%s" → custo_invalido', (t) => {
    expect(parseCustoMensal(t)).toEqual({ ok: false, motivo: 'custo_invalido' });
  });
});

describe('normalizarResumo', () => {
  it('converte strings numéricas e preserva null', () => {
    const r = normalizarResumo({ company: 'oben', omie_codigo_cliente: 7, nome_cliente: null, n_documentos: '6', atraso_p80: null, volume_emitido_12m: '100.5' });
    expect(r.nDocumentos).toBe(6);
    expect(r.atrasoP80).toBeNull();
    expect(r.volumeEmitido12m).toBe(100.5);
    expect(r.nomeCliente).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- src/lib/financeiro/__tests__/ciclo-cliente-helpers.test.ts > $TMPDIR/h.log 2>&1; rc=$?; tail -c 800 $TMPDIR/h.log; [ $rc -ne 0 ]`
Expected: FAIL — módulo `@/lib/financeiro/ciclo-cliente-helpers` não existe.

- [ ] **Step 3: Implementar**

```ts
// src/lib/financeiro/ciclo-cliente-helpers.ts
// Ciclo financeiro por cliente — regra PURA sobre os fatos de v_ciclo_cliente_resumo.
// Spec: docs/superpowers/specs/2026-10-14-ciclo-financeiro-cockpit-cliente-design.md (v2, §4–§5).
// Princípios: ausente ≠ zero (null + motivo); todo R$ é CENÁRIO rotulado, nunca previsão;
// estoque vencido nunca soma ao recorrente; desconto só com custo do dinheiro informado.

export const CARENCIA_DIAS = 3;
export const LIMITE_ATRASO_LEVE = 7;
export const LIMITE_FOLGA = -3;
export const MIN_DOCUMENTOS = 6;
export const RECENCIA_MAX_DIAS = 90;
export const DEGRAUS_PRAZO: readonly number[] = [90, 75, 60, 56, 45, 42, 35, 30, 28, 21, 14, 7];

export type Perfil = 'folga' | 'pontual' | 'atraso_leve' | 'atraso_cronico' | 'misto' | 'sem_dado';
export type Confianca = 'media' | 'baixa';
export type Alavanca = 'recuperar_vencido' | 'cobrar_atraso' | 'degrau_prazo' | 'nenhuma';
export type Cenario = { reais: number | null; motivo: string; rotulo: string };
export type SugestaoCliente = {
  alavanca: Alavanca;
  texto: string;
  cenario: Cenario | null;
  descontoCandidato: boolean;
  degrau: { de: number; para: number } | null;
};

export type ResumoClienteRow = Record<string, unknown>;

export type ResumoCliente = {
  company: string; omieCodigoCliente: number; nomeCliente: string | null;
  nParcelas: number | null; nDocumentos: number | null; valorPago: number | null; valorPagoSemBaixa: number | null;
  prazoConcedidoPond: number | null; prazoRealPond: number | null; atrasoPond: number | null;
  atrasoP50: number | null; atrasoP80: number | null; atrasoP80Valor: number | null; atrasoMaxObservado: number | null;
  excessoCarenciaPond: number | null; pctValorAtrasado: number | null; ultimaBaixa: string | null;
  nVencidas: number | null; saldoVencido: number | null; saldoVencido90: number | null; diasVencidoMax: number | null;
  volumeEmitido12m: number | null; primeiraEmissao: string | null; nStatusAmbiguo: number | null;
};

/** Número finito ou null. Nunca `Number(null) === 0`. */
export function num(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}

const txt = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);

export function normalizarResumo(row: ResumoClienteRow): ResumoCliente {
  return {
    company: String(row.company),
    omieCodigoCliente: num(row.omie_codigo_cliente) ?? -1,
    nomeCliente: txt(row.nome_cliente),
    nParcelas: num(row.n_parcelas), nDocumentos: num(row.n_documentos),
    valorPago: num(row.valor_pago), valorPagoSemBaixa: num(row.valor_pago_sem_baixa),
    prazoConcedidoPond: num(row.prazo_concedido_pond), prazoRealPond: num(row.prazo_real_pond),
    atrasoPond: num(row.atraso_pond), atrasoP50: num(row.atraso_p50), atrasoP80: num(row.atraso_p80),
    atrasoP80Valor: num(row.atraso_p80_valor), atrasoMaxObservado: num(row.atraso_max_observado),
    excessoCarenciaPond: num(row.excesso_carencia_pond), pctValorAtrasado: num(row.pct_valor_atrasado),
    ultimaBaixa: txt(row.ultima_baixa),
    nVencidas: num(row.n_vencidas), saldoVencido: num(row.saldo_vencido),
    saldoVencido90: num(row.saldo_vencido_90), diasVencidoMax: num(row.dias_vencido_max),
    volumeEmitido12m: num(row.volume_emitido_12m), primeiraEmissao: txt(row.primeira_emissao),
    nStatusAmbiguo: num(row.n_status_ambiguo),
  };
}

export function perfilPorP80(p80: number | null): Exclude<Perfil, 'misto'> {
  if (p80 === null) return 'sem_dado';
  if (p80 <= LIMITE_FOLGA) return 'folga';
  if (p80 <= 0) return 'pontual';
  if (p80 <= LIMITE_ATRASO_LEVE) return 'atraso_leve';
  return 'atraso_cronico';
}

export function perfilCliente(r: ResumoCliente): { perfil: Perfil; perfilQtd: Perfil; perfilValor: Perfil } {
  const perfilQtd = perfilPorP80(r.atrasoP80);
  const perfilValor = perfilPorP80(r.atrasoP80Valor);
  return { perfil: perfilQtd === perfilValor ? perfilQtd : 'misto', perfilQtd, perfilValor };
}

function diasEntre(deIso: string, ateIso: string): number {
  return Math.round((Date.parse(`${ateIso}T00:00:00Z`) - Date.parse(`${deIso}T00:00:00Z`)) / 86_400_000);
}

export function confiancaCliente(r: ResumoCliente, hojeSp: string): Confianca {
  if (r.nDocumentos === null || r.nDocumentos < MIN_DOCUMENTOS || r.ultimaBaixa === null) return 'baixa';
  return diasEntre(r.ultimaBaixa, hojeSp) <= RECENCIA_MAX_DIAS ? 'media' : 'baixa';
}

/** Próximo degrau usual ESTRITAMENTE abaixo do prazo (arredondado). Sem 7→0. */
export function degrauAbaixo(prazo: number): number | null {
  const p = Math.round(prazo);
  for (const d of DEGRAUS_PRAZO) if (d < p) return d;
  return null;
}

function porDia(volume: number | null): number | null {
  return volume === null || volume <= 0 ? null : volume / 365;
}

export function sugerirAlavanca(r: ResumoCliente, hojeSp: string): SugestaoCliente {
  const nada: SugestaoCliente = { alavanca: 'nenhuma', texto: '', cenario: null, descontoCandidato: false, degrau: null };

  // (0) Estoque vencido — qualquer perfil/confiança; nunca somado ao recorrente.
  if (r.saldoVencido !== null && r.saldoVencido > 0) {
    const acima90 = r.saldoVencido90 ?? 0;
    return {
      ...nada,
      alavanca: 'recuperar_vencido',
      texto: acima90 > 0 ? 'Recuperar vencidos — parte há mais de 90 dias' : 'Recuperar vencidos',
      cenario: { reais: r.saldoVencido, motivo: 'saldo vencido em aberto', rotulo: 'estoque vencido a recuperar (não é recorrente nem lucro)' },
    };
  }

  if (confiancaCliente(r, hojeSp) === 'baixa') return { ...nada, texto: 'Poucos documentos ou sem pagamento recente — só fatos' };
  const { perfil } = perfilCliente(r);
  if (perfil === 'misto') return { ...nada, texto: 'Frequência e valor do atraso divergem — sem sugestão automática' };
  if (perfil === 'sem_dado') return nada;

  const dia = porDia(r.volumeEmitido12m);

  if (perfil === 'atraso_leve' || perfil === 'atraso_cronico') {
    const excesso = r.excessoCarenciaPond;
    const cenario: Cenario =
      dia === null
        ? { reais: null, motivo: 'sem volume na janela', rotulo: 'cenário: atraso cai à carência de 3d' }
        : excesso === null
          ? { reais: null, motivo: 'sem atraso medido', rotulo: 'cenário: atraso cai à carência de 3d' }
          : { reais: excesso * dia, motivo: 'excesso sobre a carência × volume diário', rotulo: 'cenário: atraso cai à carência de 3d — não é previsão' };
    return {
      ...nada,
      alavanca: 'cobrar_atraso',
      texto: perfil === 'atraso_cronico' ? 'Régua de cobrança ativa + revisar limite de crédito' : 'Lembrete D−2 e D+1',
      cenario,
      descontoCandidato: perfil === 'atraso_leve',
    };
  }

  // pontual / folga → degrau
  const prazo = r.prazoConcedidoPond;
  if (prazo === null) return nada;
  const para = degrauAbaixo(prazo);
  if (para === null) return { ...nada, texto: 'Prazo já no menor degrau usual' };
  const de = Math.round(prazo);
  const degrau = { de, para };
  if (perfil === 'folga') {
    return {
      ...nada, alavanca: 'degrau_prazo', degrau,
      texto: `Candidato a degrau ${de}→${para} dias`,
      cenario: { reais: null, motivo: 'benefício depende de piloto', rotulo: 'paga antes do vencimento — encurtar pode liberar zero' },
    };
  }
  return {
    ...nada, alavanca: 'degrau_prazo', degrau,
    texto: `Degrau ${de}→${para} dias (hipótese)`,
    cenario: dia === null
      ? { reais: null, motivo: 'sem volume na janela', rotulo: 'cenário: se continuar pagando no vencimento' }
      : { reais: (de - para) * dia, motivo: 'dias a menos × volume diário', rotulo: 'cenário: se continuar pagando no vencimento' },
  };
}

export type ResultadoDesconto =
  | { ok: true; dMax: number }
  | { ok: false; motivo: 'custo_ausente' | 'custo_invalido' | 'dias_invalidos' };

/** Teto de indiferença: P·(1−d)·(1+c)^(N/30) = P ⇒ d = 1 − (1+c)^(−N/30). Antes de custos e risco. */
export function descontoMaximo(custoMensal: number | null, dias: number): ResultadoDesconto {
  if (custoMensal === null) return { ok: false, motivo: 'custo_ausente' };
  if (!Number.isFinite(custoMensal) || custoMensal <= 0) return { ok: false, motivo: 'custo_invalido' };
  if (!Number.isFinite(dias) || dias <= 0) return { ok: false, motivo: 'dias_invalidos' };
  return { ok: true, dMax: 1 - Math.pow(1 + custoMensal, -dias / 30) };
}

/** Input BR em % a.m. ("2,5" → 0,025). Vazio = ausente; resto inválido = fail-closed. */
export function parseCustoMensal(texto: string):
  | { ok: true; c: number }
  | { ok: false; motivo: 'custo_ausente' | 'custo_invalido' } {
  const t = texto.trim();
  if (t === '') return { ok: false, motivo: 'custo_ausente' };
  if (!/^\d+([.,]\d+)?$/.test(t)) return { ok: false, motivo: 'custo_invalido' };
  const pct = Number(t.replace(',', '.'));
  if (!Number.isFinite(pct) || pct <= 0) return { ok: false, motivo: 'custo_invalido' };
  return { ok: true, c: pct / 100 };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test -- src/lib/financeiro/__tests__/ciclo-cliente-helpers.test.ts > $TMPDIR/h.log 2>&1; rc=$?; tail -c 800 $TMPDIR/h.log; [ $rc -eq 0 ]`
Expected: PASS, todos verdes. (`'1e999'` falha a regex → `custo_invalido`.)

- [ ] **Step 5: Falsificar o ramo de dinheiro (uma camada por vez)**

Commitar ANTES. Depois, em sequência, editar e rodar o teste exigindo vermelho, e restaurar com `git checkout -- src/lib/financeiro/ciclo-cliente-helpers.ts`:
1. trocar `1 - Math.pow(1 + custoMensal, -dias / 30)` por `Math.pow(1 + custoMensal, dias / 30) - 1` → teste "1,9608%" deve ficar vermelho;
2. trocar `volume === null || volume <= 0 ? null` por `volume === null ? 0` → teste "volume ausente" vermelho;
3. remover o bloco `(0) Estoque vencido` → testes de vencida vermelhos.
Registrar no commit/PR as 3 saídas vermelhas (recorte `tail -c 400`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/financeiro/ciclo-cliente-helpers.ts src/lib/financeiro/__tests__/ciclo-cliente-helpers.test.ts
git commit -m "feat(financeiro): helper puro do ciclo por cliente — perfil, alavanca, cenários e desconto [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Hooks de leitura `useFinanceiroCiclo.ts`

**Files:**
- Create: `src/hooks/useFinanceiroCiclo.ts`

**Interfaces:**
- Consumes: views do Task 1; `fetchAllPages` de `@/lib/postgrest`; `normalizarResumo`, `num` (Task 2); `supabase` de `@/integrations/supabase/client`; `Company`, `ALL_COMPANIES` de `@/contexts/CompanyContext`.
- Produces:
  - `useCicloResumo(): UseQueryResult<ResumoCliente[]>`
  - `type CoorteMes = { company: Company; mes: string; valorVencido: number; valorPago: number; valorEmAberto: number; pctValorPago: number | null; prazoConcedido: number | null; prazoReal: number | null; atraso: number | null; mesParcial: boolean }`
  - `useCicloCoorte(): UseQueryResult<CoorteMes[]>`
  - `useReceitaDiariaTtm(): UseQueryResult<Record<Company, number | null>>`
  - `type TituloCliente = { lancamento: number; documento: string | null; emissao: string; vencimento: string; baixa: string | null; valor: number; saldo: number | null; situacao: string; prazoConcedido: number; prazoReal: number | null; atraso: number | null; diasVencido: number | null }`
  - `useCicloTitulosCliente(company: Company | null, cliente: number | null): UseQueryResult<TituloCliente[]>`
  - `hojeSp(): string` (YYYY-MM-DD em America/Sao_Paulo)

- [ ] **Step 1: Implementar** (hook fino sobre helper testado; o contrato erro≠vazio é provado no Task 4)

```ts
// src/hooks/useFinanceiroCiclo.ts
// Leituras da aba "Ciclo" (master-only). Fatos das views v_ciclo_*; regra no helper puro.
// Erro de leitura LANÇA (react-query expõe `error`) — nunca vira lista vazia.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { normalizarResumo, num, type ResumoCliente, type ResumoClienteRow } from '@/lib/financeiro/ciclo-cliente-helpers';
import { ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';

export function hojeSp(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

export function useCicloResumo() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'resumo'],
    queryFn: async (): Promise<ResumoCliente[]> => {
      const linhas = await fetchAllPages<ResumoClienteRow>(
        (de, ate) =>
          supabase.from('v_ciclo_cliente_resumo' as never).select('*')
            .order('company', { ascending: true })
            .order('omie_codigo_cliente', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ResumoClienteRow[] | null; error: unknown }>,
        'v_ciclo_cliente_resumo',
      );
      return linhas.map(normalizarResumo);
    },
  });
}

export type CoorteMes = {
  company: Company; mes: string; valorVencido: number; valorPago: number; valorEmAberto: number;
  pctValorPago: number | null; prazoConcedido: number | null; prazoReal: number | null; atraso: number | null; mesParcial: boolean;
};

export function useCicloCoorte() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'coorte'],
    queryFn: async (): Promise<CoorteMes[]> => {
      const { data, error } = await supabase.from('v_ciclo_empresa_coorte' as never).select('*')
        .order('company', { ascending: true }).order('mes_vencimento', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
        company: r.company as Company,
        mes: String(r.mes_vencimento),
        valorVencido: num(r.valor_vencido_no_mes) ?? 0,
        valorPago: num(r.valor_pago) ?? 0,
        valorEmAberto: num(r.valor_em_aberto) ?? 0,
        pctValorPago: num(r.pct_valor_pago),
        prazoConcedido: num(r.prazo_concedido_pond),
        prazoReal: num(r.prazo_real_pond_pagas),
        atraso: num(r.atraso_pond_pagas),
        mesParcial: r.mes_parcial === true,
      }));
    },
  });
}
```

> Nota: em `useCicloCoorte` o `?? 0` de `valorVencido/valorPago/valorEmAberto` é seguro — a view usa `coalesce(…, 0)` nessas três colunas (zero REAL de soma sobre linhas existentes); `error` já lançou antes. As colunas sem `coalesce` ficam `null`.

```ts
/** Receita por competência TTM (12 meses fechados) / 365, por empresa. Sem linha → null. */
export function useReceitaDiariaTtm() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'receita-ttm'],
    queryFn: async (): Promise<Record<Company, number | null>> => {
      const hoje = hojeSp();
      const [a, m] = hoje.split('-').map(Number);
      const fimExclusivo = a * 100 + m;                       // mês corrente (excluído)
      const inicio = (a - 1) * 100 + m;                       // mesmo mês do ano anterior (incluído)
      const linhas = await fetchAllPages<Record<string, unknown>>(
        (de, ate) =>
          supabase.from('fin_dre_competencia_base' as never).select('company, ano, mes, categoria_codigo, valor_total')
            .eq('origem', 'CR')
            .order('company', { ascending: true }).order('ano', { ascending: true })
            .order('mes', { ascending: true }).order('categoria_codigo', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
        'fin_dre_competencia_base/ciclo-ttm',
      );
      const soma: Record<Company, number | null> = { oben: null, colacor: null, colacor_sc: null };
      for (const l of linhas) {
        const ym = (num(l.ano) ?? 0) * 100 + (num(l.mes) ?? 0);
        if (ym < inicio || ym >= fimExclusivo) continue;
        const c = l.company as Company;
        const v = num(l.valor_total);
        if (!ALL_COMPANIES.includes(c) || v === null) continue;
        soma[c] = (soma[c] ?? 0) + v;
      }
      const out = { ...soma };
      for (const c of ALL_COMPANIES) out[c] = soma[c] === null ? null : (soma[c] as number) / 365;
      return out;
    },
  });
}
```

> Janela: com hoje = 2026-10, `inicio = 202510`, `fimExclusivo = 202610` → 12 meses fechados (out/25…set/26). Vale para qualquer `m`, inclusive 12. `soma[c]` só deixa de ser `null` se houver ao menos uma linha válida — empresa sem DRE fica "—", nunca R$ 0.

```ts
export type TituloCliente = {
  lancamento: number; documento: string | null; emissao: string; vencimento: string; baixa: string | null;
  valor: number; saldo: number | null; situacao: string; prazoConcedido: number;
  prazoReal: number | null; atraso: number | null; diasVencido: number | null;
};

export function useCicloTitulosCliente(company: Company | null, cliente: number | null) {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'titulos', company, cliente],
    enabled: company !== null && cliente !== null,
    queryFn: async (): Promise<TituloCliente[]> => {
      const linhas = await fetchAllPages<Record<string, unknown>>(
        (de, ate) =>
          supabase.from('v_ciclo_cr_titulos' as never).select('*')
            .eq('company', company as string).eq('omie_codigo_cliente', cliente as number)
            .order('data_vencimento', { ascending: false })
            .order('omie_codigo_lancamento', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
        'v_ciclo_cr_titulos/cliente',
      );
      return linhas.map((r) => ({
        lancamento: num(r.omie_codigo_lancamento) ?? -1,
        documento: typeof r.numero_documento === 'string' ? r.numero_documento : null,
        emissao: String(r.data_emissao), vencimento: String(r.data_vencimento),
        baixa: typeof r.data_baixa === 'string' ? r.data_baixa : null,
        valor: num(r.valor_documento) ?? 0, saldo: num(r.saldo), situacao: String(r.situacao),
        prazoConcedido: num(r.prazo_concedido_dias) ?? 0,
        prazoReal: num(r.prazo_real_dias), atraso: num(r.atraso_dias), diasVencido: num(r.dias_vencido),
      }));
    },
  });
}
```

> `valor ?? 0` e `prazoConcedido ?? 0` são seguros: a view filtra `valor_documento > 0` finito e datas NOT NULL, então ausência aqui é impossível; mantê-los evita `number | null` em campos que a view garante.

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck:app > $TMPDIR/tc.log 2>&1; rc=$?; tail -c 800 $TMPDIR/tc.log; [ $rc -eq 0 ]`
Expected: exit 0.

- [ ] **Step 3: Rodar o gate de leitura single-shot**

Run: `heavy bun run test -- src/__tests__/leitura-single-shot-gate.test.ts > $TMPDIR/g.log 2>&1; rc=$?; tail -c 800 $TMPDIR/g.log; [ $rc -eq 0 ]`
Expected: PASS (todo `.data ??` tem `error` checado no mesmo arquivo).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useFinanceiroCiclo.ts
git commit -m "feat(financeiro): hooks de leitura da aba Ciclo (resumo paginado, coorte, receita TTM, títulos)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: UI da aba "Ciclo" + registro master-only

**Files:**
- Create: `src/components/financeiro/cashflow/ciclo/CicloTab.tsx`, `CicloEmpresaCards.tsx`, `CicloTendencia.tsx`, `CicloClientesTabela.tsx`, `CicloClienteDrill.tsx`, `CicloDescontoPainel.tsx`
- Create: `src/components/financeiro/cashflow/ciclo/__tests__/CicloTab.test.tsx`, `.../__tests__/FinanceiroCapitalGiro.ciclo-gate.test.tsx`
- Modify: `src/pages/FinanceiroCapitalGiro.tsx` (TabsList/TabsContent)

**Interfaces:**
- Consumes: hooks do Task 3; `sugerirAlavanca`, `perfilCliente`, `confiancaCliente`, `descontoMaximo`, `parseCustoMensal` (Task 2); `useCashflowProjection(company)` (`data.indicadores.{prazo_medio_recebimento, prazo_medio_pagamento, prazo_medio_estoque, cash_conversion_cycle}`, `data.confianca_dados?.motivos`); `COMPANIES`, `ALL_COMPANIES`; `useUrlState`; `track`.
- Produces: `export function CicloTab(): JSX.Element` (default-free named export).

- [ ] **Step 1: Escrever o teste de componente**

Ler antes um teste existente de página financeira para copiar o padrão de mock do supabase/hooks: `src/pages/__tests__/FinanceiroDashboard.erro-por-aba.test.tsx`. Mockar os hooks (não o supabase) para isolar a UI:

```tsx
// src/components/financeiro/cashflow/ciclo/__tests__/CicloTab.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';

const resumoMock = vi.fn();
const coorteMock = vi.fn();
const receitaMock = vi.fn();
const projMock = vi.fn();

vi.mock('@/hooks/useFinanceiroCiclo', () => ({
  hojeSp: () => '2026-10-14',
  useCicloResumo: () => resumoMock(),
  useCicloCoorte: () => coorteMock(),
  useReceitaDiariaTtm: () => receitaMock(),
  useCicloTitulosCliente: () => ({ data: [], isLoading: false, error: null }),
}));
vi.mock('@/hooks/useCashflowProjection', () => ({
  useCashflowProjection: (company: string) => projMock(company),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { CicloTab } from '@/components/financeiro/cashflow/ciclo/CicloTab';

const ok = <T,>(data: T) => ({ data, isLoading: false, error: null });
const cli = (o: Partial<ResumoCliente>): ResumoCliente => ({
  company: 'oben', omieCodigoCliente: 1, nomeCliente: 'ACME', nParcelas: 8, nDocumentos: 8, valorPago: 1000,
  valorPagoSemBaixa: null, prazoConcedidoPond: 30, prazoRealPond: 30, atrasoPond: 0, atrasoP50: 0, atrasoP80: 0,
  atrasoP80Valor: 0, atrasoMaxObservado: 0, excessoCarenciaPond: 0, pctValorAtrasado: 0, ultimaBaixa: '2026-10-01',
  nVencidas: null, saldoVencido: null, saldoVencido90: null, diasVencidoMax: null, volumeEmitido12m: 36500,
  primeiraEmissao: '2025-10-20', nStatusAmbiguo: null, ...o,
});
const proj = { prazo_medio_recebimento: 31, prazo_medio_pagamento: 12, prazo_medio_estoque: 40, cash_conversion_cycle: 59 };

const renderTab = () => render(<MemoryRouter><CicloTab /></MemoryRouter>);

beforeEach(() => {
  coorteMock.mockReturnValue(ok([]));
  receitaMock.mockReturnValue(ok({ oben: 11300, colacor: 2100, colacor_sc: 550 }));
  projMock.mockImplementation(() => ok({ indicadores: proj, confianca_dados: { motivos: [] } }));
});

describe('CicloTab', () => {
  it('erro de leitura do resumo mostra erro, não estado vazio', () => {
    resumoMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    renderTab();
    expect(screen.getByText(/não foi possível ler/i)).toBeInTheDocument();
    expect(screen.queryByText(/sem títulos/i)).not.toBeInTheDocument();
  });

  it('sucesso vazio mostra EmptyState', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab();
    expect(screen.getByText(/sem títulos/i)).toBeInTheDocument();
  });

  it('mesmo nome em 2 empresas renderiza 2 linhas (chave composta)', () => {
    resumoMock.mockReturnValue(ok([cli({ company: 'oben' }), cli({ company: 'colacor' })]));
    renderTab();
    expect(screen.getAllByText('ACME')).toHaveLength(2);
  });

  it('cliente só-vencido aparece com "Recuperar vencidos"', () => {
    resumoMock.mockReturnValue(ok([cli({ nParcelas: null, nDocumentos: null, atrasoP80: null, atrasoP80Valor: null, ultimaBaixa: null, saldoVencido: 500 })]));
    renderTab();
    expect(screen.getByText(/Recuperar vencidos/)).toBeInTheDocument();
  });

  it('engine falha numa empresa: só ela vira "—", as outras seguem', () => {
    resumoMock.mockReturnValue(ok([]));
    projMock.mockImplementation((c: string) =>
      c === 'colacor' ? { data: undefined, isLoading: false, error: new Error('500') } : ok({ indicadores: proj, confianca_dados: { motivos: [] } }));
    renderTab();
    expect(screen.getByTestId('ciclo-card-colacor')).toHaveTextContent('—');
    expect(screen.getByTestId('ciclo-card-oben')).toHaveTextContent('31d');
  });

  it('mostra o caveat fixo', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab();
    expect(screen.getByText(/Todo R\$ é cenário, não previsão/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- src/components/financeiro/cashflow/ciclo > $TMPDIR/u.log 2>&1; rc=$?; tail -c 800 $TMPDIR/u.log; [ $rc -ne 0 ]`
Expected: FAIL — `CicloTab` não existe.

- [ ] **Step 3: Implementar os componentes**

`CicloEmpresaCards.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCashflowProjection } from '@/hooks/useCashflowProjection';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import type { CoorteMes } from '@/hooks/useFinanceiroCiclo';

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const dias = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(0)}d`);

function pond(meses: CoorteMes[], campo: 'prazoConcedido' | 'prazoReal') {
  let s = 0, w = 0;
  for (const m of meses) { const v = m[campo]; if (v !== null && m.valorPago > 0) { s += v * m.valorPago; w += m.valorPago; } }
  return w > 0 ? s / w : null;
}

export function CicloEmpresaCard({ company, coorte, receitaDia }: { company: Company; coorte: CoorteMes[]; receitaDia: number | null }) {
  const { data, error, isLoading } = useCashflowProjection(company);
  const ind = error ? null : data?.indicadores;
  const motivos = data?.confianca_dados?.motivos ?? [];
  const meses = coorte.filter((m) => m.company === company);
  const concedido = pond(meses, 'prazoConcedido');
  const real = pond(meses, 'prazoReal');
  const divergem = ind?.prazo_medio_recebimento != null && real !== null && Math.abs(ind.prazo_medio_recebimento - real) > 3;
  return (
    <Card data-testid={`ciclo-card-${company}`}>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{COMPANIES[company].shortName}</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-4 gap-2 text-center">
          {(['PME', 'PMR', 'PMP', 'Ciclo'] as const).map((rotulo) => {
            const v = isLoading ? undefined : rotulo === 'PME' ? ind?.prazo_medio_estoque : rotulo === 'PMR' ? ind?.prazo_medio_recebimento
              : rotulo === 'PMP' ? ind?.prazo_medio_pagamento : ind?.cash_conversion_cycle;
            return (<div key={rotulo}><div className="text-xs text-muted-foreground">{rotulo}</div><div className="font-mono text-lg">{dias(v)}</div></div>);
          })}
        </div>
        <div className="text-xs text-muted-foreground">
          1 dia de PMR = {receitaDia === null ? '— (sem receita TTM)' : brl(receitaDia)}
        </div>
        {concedido !== null && real !== null && (
          <div className="text-xs">Prazo concedido {concedido.toFixed(1)}d → real {real.toFixed(1)}d
            <span className={real - concedido > 0 ? 'text-status-warning' : 'text-status-success'}> ({(real - concedido >= 0 ? '+' : '')}{(real - concedido).toFixed(1)}d de atraso)</span>
          </div>
        )}
        {divergem && <div className="text-xs text-status-warning">Fontes divergem: engine {dias(ind?.prazo_medio_recebimento)} × coorte {dias(real)}</div>}
        {error && <div className="text-xs text-status-error">Motor de caixa indisponível para esta empresa</div>}
        {motivos.length > 0 && <div className="text-xs text-muted-foreground">{motivos.join(' · ')}</div>}
        {company === 'colacor_sc' && <div className="text-xs text-muted-foreground">Serviços — poucos documentos por cliente; leitura majoritariamente de baixa confiança.</div>}
      </CardContent>
    </Card>
  );
}
```

`CicloTendencia.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CoorteMes } from '@/hooks/useFinanceiroCiclo';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';

export function CicloTendencia({ coorte, company }: { coorte: CoorteMes[]; company: Company }) {
  const serie = coorte.filter((m) => m.company === company).map((m) => ({
    mes: m.mes.slice(0, 7) + (m.mesParcial ? '*' : ''),
    concedido: m.prazoConcedido, real: m.prazoReal,
    pago: m.pctValorPago === null ? null : Math.round(m.pctValorPago * 100),
  }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{COMPANIES[company].shortName} — prazo por mês de vencimento</CardTitle>
        <p className="text-xs text-muted-foreground">Coortes recentes têm parte ainda em aberto (% pago no tooltip) e parecem melhores do que são. * = mês corrente.</p>
      </CardHeader>
      <CardContent className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={serie}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} unit="d" />
            <Tooltip
              formatter={(v: number) => `${Number(v).toFixed(1)}d`}
              labelFormatter={(rotulo: string, itens) => {
                const pago = (itens?.[0]?.payload as { pago: number | null } | undefined)?.pago;
                return `${rotulo} — ${pago == null ? '—' : `${pago}%`} do valor já pago`;
              }}
            />
            <Legend />
            <Line type="monotone" dataKey="concedido" name="Concedido" stroke="hsl(var(--muted-foreground))" dot={false} />
            <Line type="monotone" dataKey="real" name="Real (pagas)" stroke="hsl(var(--primary))" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
```

(Na implementação, carregar a skill `dataviz` e ajustar cores/legibilidade; o `% pago` aparece no rótulo do tooltip de cada mês.)

`CicloClientesTabela.tsx`:

```tsx
import { useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { confiancaCliente, perfilCliente, sugerirAlavanca, type ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const d = (v: number | null) => (v === null ? '—' : `${v.toFixed(0)}d`);
const ROTULO_PERFIL: Record<string, string> = {
  folga: 'Folga', pontual: 'Pontual', atraso_leve: 'Atraso leve', atraso_cronico: 'Atraso crônico', misto: 'Misto', sem_dado: 'Sem pagamento',
};

export function CicloClientesTabela({ clientes, hoje, empresa, perfilFiltro, onAbrir }: {
  clientes: ResumoCliente[]; hoje: string; empresa: Company | 'all'; perfilFiltro: string;
  onAbrir: (c: ResumoCliente) => void;
}) {
  const linhas = useMemo(() => clientes
    .filter((c) => empresa === 'all' || c.company === empresa)
    .map((c) => ({ c, s: sugerirAlavanca(c, hoje), p: perfilCliente(c), conf: confiancaCliente(c, hoje) }))
    .filter((l) => perfilFiltro === 'todos' || l.p.perfil === perfilFiltro)
    .sort((a, b) => {
      const ord = (x: typeof a) => (x.s.alavanca === 'recuperar_vencido' ? 0 : x.s.alavanca === 'cobrar_atraso' ? 1 : x.s.alavanca === 'degrau_prazo' ? 2 : 3);
      return ord(a) - ord(b) || (b.s.cenario?.reais ?? -1) - (a.s.cenario?.reais ?? -1);
    }), [clientes, hoje, empresa, perfilFiltro]);

  return (
    <Table>
      <TableHeader><TableRow>
        <TableHead>Cliente</TableHead><TableHead>Empresa</TableHead><TableHead className="text-right">Vencido aberto</TableHead>
        <TableHead className="text-right">Docs</TableHead><TableHead className="text-right">Concedido</TableHead><TableHead className="text-right">Real</TableHead>
        <TableHead className="text-right">Atraso p80 (qtd | R$)</TableHead><TableHead>Perfil</TableHead><TableHead>Alavanca</TableHead>
        <TableHead className="text-right">Cenário</TableHead><TableHead>Confiança</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {linhas.map(({ c, s, p, conf }) => (
          <TableRow key={`${c.company}:${c.omieCodigoCliente}`} className="cursor-pointer" onClick={() => onAbrir(c)}>
            <TableCell>{c.nomeCliente ?? `#${c.omieCodigoCliente}`}</TableCell>
            <TableCell>{COMPANIES[c.company as Company]?.shortName ?? c.company}</TableCell>
            <TableCell className="text-right font-mono">{c.saldoVencido ? <span className="text-status-error">{brl(c.saldoVencido)}</span> : '—'}</TableCell>
            <TableCell className="text-right font-mono">{c.nDocumentos ?? '—'}</TableCell>
            <TableCell className="text-right font-mono">{d(c.prazoConcedidoPond)}</TableCell>
            <TableCell className="text-right font-mono">{d(c.prazoRealPond)}</TableCell>
            <TableCell className="text-right font-mono">{d(c.atrasoP80)} | {d(c.atrasoP80Valor)}</TableCell>
            <TableCell>{ROTULO_PERFIL[p.perfil]}</TableCell>
            <TableCell className="text-xs">{s.texto || '—'}{s.descontoCandidato && <Badge variant="outline" className="ml-1">desconto?</Badge>}</TableCell>
            <TableCell className="text-right font-mono" title={s.cenario?.rotulo}>
              {s.cenario === null ? '—' : s.cenario.reais === null ? <span className="text-muted-foreground text-xs">{s.cenario.motivo}</span> : brl(s.cenario.reais)}
            </TableCell>
            <TableCell><Badge variant={conf === 'media' ? 'secondary' : 'outline'}>{conf === 'media' ? 'média' : 'baixa'}</Badge></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

`CicloClienteDrill.tsx`:

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCicloTitulosCliente } from '@/hooks/useFinanceiroCiclo';
import { sugerirAlavanca, type ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import type { Company } from '@/contexts/CompanyContext';
import { PageSkeleton } from '@/components/ui/page-skeleton';

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function CicloClienteDrill({ cliente, hoje, onFechar }: { cliente: ResumoCliente | null; hoje: string; onFechar: () => void }) {
  const q = useCicloTitulosCliente((cliente?.company as Company) ?? null, cliente?.omieCodigoCliente ?? null);
  const s = cliente ? sugerirAlavanca(cliente, hoje) : null;
  return (
    <Sheet open={cliente !== null} onOpenChange={(o) => { if (!o) onFechar(); }}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader><SheetTitle>{cliente?.nomeCliente ?? `#${cliente?.omieCodigoCliente}`}</SheetTitle></SheetHeader>
        {s && (
          <div className="my-3 rounded-md border p-3 text-sm">
            <div className="font-medium">{s.texto || 'Sem sugestão'}</div>
            {s.cenario && <div className="text-xs text-muted-foreground">{s.cenario.rotulo} — {s.cenario.reais === null ? s.cenario.motivo : `${brl(s.cenario.reais)} (${s.cenario.motivo})`}</div>}
            {s.degrau && <div className="text-xs">Aplicar ao calendário de parcelas (ex.: 30/60/90 → {s.degrau.para}/{s.degrau.para * 2}/{s.degrau.para * 3}), não à média.</div>}
          </div>
        )}
        {q.isLoading && <PageSkeleton variant="list" />}
        {q.error && <p className="text-status-error text-sm">Não foi possível ler as parcelas deste cliente.</p>}
        {q.data && (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Doc</TableHead><TableHead>Vencimento</TableHead><TableHead>Situação</TableHead>
              <TableHead className="text-right">Valor</TableHead><TableHead className="text-right">Concedido</TableHead><TableHead className="text-right">Atraso</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {q.data.map((t) => (
                <TableRow key={t.lancamento}>
                  <TableCell>{t.documento ?? t.lancamento}</TableCell>
                  <TableCell>{t.vencimento}</TableCell>
                  <TableCell>{t.situacao === 'vencida_aberta' ? <span className="text-status-error">vencida há {t.diasVencido}d</span> : t.situacao.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="text-right font-mono">{brl(t.situacao === 'vencida_aberta' ? t.saldo ?? t.valor : t.valor)}</TableCell>
                  <TableCell className="text-right font-mono">{t.prazoConcedido}d</TableCell>
                  <TableCell className={`text-right font-mono ${t.atraso !== null && t.atraso > 3 ? 'text-status-warning' : ''}`}>{t.atraso === null ? '—' : `${t.atraso.toFixed(0)}d`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

`CicloDescontoPainel.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { descontoMaximo, parseCustoMensal } from '@/lib/financeiro/ciclo-cliente-helpers';
import { track } from '@/lib/analytics';

const N_CENARIOS = [10, 20, 30] as const;

export function CicloDescontoPainel({ custoTexto, onCusto }: { custoTexto: string; onCusto: (t: string) => void }) {
  const parsed = parseCustoMensal(custoTexto);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Desconto por pontualidade — teto de indiferença</CardTitle>
        <p className="text-xs text-muted-foreground">d = 1 − (1+c)^(−N/30). Antes de custos operacionais e mudança de risco. Quem já pagaria em dia também recebe o desconto — sem piloto não há adesão medida.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="flex items-center gap-2">Custo do seu dinheiro (% a.m.)
          <Input className="w-24" inputMode="decimal" value={custoTexto} placeholder="ex.: 2,5"
            onChange={(e) => onCusto(e.target.value)}
            onBlur={() => { if (parsed.ok) track('financeiro.ciclo_desconto_simulado', { custo_pct: parsed.c * 100 }); }} />
        </label>
        {!parsed.ok && (
          <p className={parsed.motivo === 'custo_invalido' ? 'text-status-error' : 'text-muted-foreground'}>
            {parsed.motivo === 'custo_ausente' ? 'Informe o custo do seu dinheiro para ver o desconto máximo.' : 'Valor inválido — use um número positivo, ex.: 2,5.'}
          </p>
        )}
        {parsed.ok && (
          <table className="w-full text-left">
            <thead><tr><th>Antecipa N dias</th><th className="text-right">Desconto máximo</th></tr></thead>
            <tbody>
              {N_CENARIOS.map((n) => {
                const r = descontoMaximo(parsed.c, n);
                return (<tr key={n}><td>{n} dias</td><td className="text-right font-mono">{r.ok ? `${(r.dMax * 100).toFixed(2).replace('.', ',')}%` : '—'}</td></tr>);
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
```

`CicloTab.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { useCicloCoorte, useCicloResumo, useReceitaDiariaTtm, hojeSp } from '@/hooks/useFinanceiroCiclo';
import { useUrlState } from '@/hooks/useUrlState';
import { ALL_COMPANIES, COMPANIES, type Company } from '@/contexts/CompanyContext';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { track } from '@/lib/analytics';
import type { ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import { CicloEmpresaCard } from './CicloEmpresaCards';
import { CicloTendencia } from './CicloTendencia';
import { CicloClientesTabela } from './CicloClientesTabela';
import { CicloClienteDrill } from './CicloClienteDrill';
import { CicloDescontoPainel } from './CicloDescontoPainel';

export const CAVEAT_CICLO =
  'Direcional. Prazo concedido = vencimento − emissão de cada parcela (vencimento vigente; renegociação apaga o original). Todo R$ é cenário, não previsão — não há piloto medido.';

export function CicloTab() {
  const hoje = hojeSp();
  const resumo = useCicloResumo();
  const coorte = useCicloCoorte();
  const receita = useReceitaDiariaTtm();
  const [filtros, setFiltros] = useUrlState({ cicloEmpresa: 'oben', cicloPerfil: 'todos', cicloCusto: '' });
  const [aberto, setAberto] = useState<ResumoCliente | null>(null);

  useEffect(() => { track('financeiro.ciclo_aberto'); }, []);

  const empresa = filtros.cicloEmpresa as Company | 'all';
  const coorteDados = coorte.data ?? [];

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{CAVEAT_CICLO}</p>

      <div className="grid gap-3 md:grid-cols-3">
        {ALL_COMPANIES.map((c) => (
          <CicloEmpresaCard key={c} company={c} coorte={coorteDados} receitaDia={receita.data?.[c] ?? null} />
        ))}
      </div>
      {coorte.error && <p className="text-status-error text-sm">Não foi possível ler a tendência por coorte.</p>}
      {empresa !== 'all' && <CicloTendencia coorte={coorteDados} company={empresa} />}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={filtros.cicloEmpresa} onValueChange={(v) => setFiltros({ cicloEmpresa: v })}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ALL_COMPANIES.map((c) => <SelectItem key={c} value={c}>{COMPANIES[c].shortName}</SelectItem>)}
            <SelectItem value="all">Todas (visão)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filtros.cicloPerfil} onValueChange={(v) => setFiltros({ cicloPerfil: v })}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[['todos', 'Todos os perfis'], ['atraso_cronico', 'Atraso crônico'], ['atraso_leve', 'Atraso leve'], ['pontual', 'Pontual'], ['folga', 'Folga'], ['misto', 'Misto'], ['sem_dado', 'Sem pagamento']]
              .map(([v, r]) => <SelectItem key={v} value={v}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {resumo.isLoading && <PageSkeleton variant="list" />}
      {resumo.error && <p className="text-status-error text-sm">Não foi possível ler o comportamento de pagamento dos clientes.</p>}
      {resumo.data && resumo.data.length === 0 && (
        <EmptyState tone="operational" icon={Inbox} title="Sem títulos pagos ou vencidos" description="Nenhum título pago em 12 meses nem vencido em aberto." />
      )}
      {resumo.data && resumo.data.length > 0 && (
        <CicloClientesTabela clientes={resumo.data} hoje={hoje} empresa={empresa} perfilFiltro={filtros.cicloPerfil}
          onAbrir={(c) => { setAberto(c); track('financeiro.ciclo_cliente_drill', { empresa: c.company }); }} />
      )}

      <CicloDescontoPainel custoTexto={filtros.cicloCusto} onCusto={(t) => setFiltros({ cicloCusto: t })} />
      <CicloClienteDrill cliente={aberto} hoje={hoje} onFechar={() => setAberto(null)} />
    </div>
  );
}
```

> `PageSkeleton` variantes reais: `'cockpit' | 'list' | 'form' | 'detail' | 'auto'` (medido) — usar `list`. `useUrlState` serializa string — os três defaults são strings. A mensagem "sem títulos" do teste casa com o `title` do EmptyState ("Sem títulos pagos ou vencidos").

- [ ] **Step 4: Registrar a aba (master-only)**

Em `src/pages/FinanceiroCapitalGiro.tsx`: adicionar `import { CicloTab } from '@/components/financeiro/cashflow/ciclo/CicloTab';`, e:

```tsx
          <TabsTrigger value="eventos">Eventos</TabsTrigger>
          {isMaster && <TabsTrigger value="ciclo">Ciclo</TabsTrigger>}
        </TabsList>
...
        <TabsContent value="eventos"><EventosManager /></TabsContent>
        {isMaster && <TabsContent value="ciclo"><CicloTab /></TabsContent>}
```

- [ ] **Step 5: Rodar testes de componente, typecheck e lint**

Run: `heavy bun run test -- src/components/financeiro/cashflow/ciclo > $TMPDIR/u.log 2>&1; rc=$?; tail -c 800 $TMPDIR/u.log; [ $rc -eq 0 ]`
Run: `heavy bun run typecheck:app > $TMPDIR/tc.log 2>&1; rc=$?; tail -c 600 $TMPDIR/tc.log; [ $rc -eq 0 ]`
Run: `bun lint > $TMPDIR/l.log 2>&1; rc=$?; tail -c 600 $TMPDIR/l.log; [ $rc -eq 0 ]`
Expected: todos exit 0.

- [ ] **Step 6: Teste do gate master na página**

Criar um arquivo SEPARADO (o mock de `useAuth` colidiria com os mocks do `CicloTab.test.tsx`), que renderiza a página com os filhos pesados mockados como `() => null`:

```tsx
// src/components/financeiro/cashflow/ciclo/__tests__/FinanceiroCapitalGiro.ciclo-gate.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = { isMaster: false };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/components/financeiro/cashflow/PosicaoAgora', () => ({ PosicaoAgora: () => null }));
vi.mock('@/components/financeiro/cashflow/Fluxo13Semanas', () => ({ Fluxo13Semanas: () => null }));
vi.mock('@/components/financeiro/cashflow/NcgDecomposicao', () => ({ NcgDecomposicao: () => null }));
vi.mock('@/components/financeiro/cashflow/EventosManager', () => ({ EventosManager: () => null }));
vi.mock('@/components/financeiro/cashflow/ConfigCashflowDialog', () => ({ ConfigCashflowDialog: () => null }));
vi.mock('@/components/financeiro/cashflow/ciclo/CicloTab', () => ({ CicloTab: () => null }));

import FinanceiroCapitalGiro from '@/pages/FinanceiroCapitalGiro';

describe('aba Ciclo — gate master', () => {
  it('não-master não vê a aba', () => {
    auth.isMaster = false;
    render(<MemoryRouter><FinanceiroCapitalGiro /></MemoryRouter>);
    expect(screen.queryByRole('tab', { name: 'Ciclo' })).toBeNull();
  });
  it('master vê a aba', () => {
    auth.isMaster = true;
    render(<MemoryRouter><FinanceiroCapitalGiro /></MemoryRouter>);
    expect(screen.getByRole('tab', { name: 'Ciclo' })).toBeInTheDocument();
  });
});
```

Run: `heavy bun run test -- src/components/financeiro/cashflow/ciclo > $TMPDIR/u.log 2>&1; rc=$?; tail -c 800 $TMPDIR/u.log; [ $rc -eq 0 ]`

- [ ] **Step 7: Commit**

```bash
git add src/components/financeiro/cashflow/ciclo src/pages/FinanceiroCapitalGiro.tsx
git commit -m "feat(financeiro): aba Ciclo (master) — cockpit por empresa, fila de clientes, drill e desconto [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Verificação integral, docs e PR

**Files:**
- Modify: `docs/agent/financeiro.md` (nova seção curta)
- Create: `docs/historico/ciclo-financeiro-cliente.md`

- [ ] **Step 1: Suíte completa e gates**

Run: `heavy bun run test > $TMPDIR/all.log 2>&1; rc=$?; tail -c 1500 $TMPDIR/all.log; [ $rc -eq 0 ]`
Run: `heavy bun run typecheck > $TMPDIR/tc.log 2>&1; rc=$?; tail -c 600 $TMPDIR/tc.log; [ $rc -eq 0 ]`
Run: `bun run claude:size > $TMPDIR/cs.log 2>&1; rc=$?; tail -c 400 $TMPDIR/cs.log; [ $rc -eq 0 ]`
Expected: exit 0 nos três (inclui o gate de manifesto e o single-shot).

- [ ] **Step 2: Docs**

Em `docs/agent/financeiro.md`, ao fim, acrescentar:

```markdown
## Ciclo por cliente (aba "Ciclo", master) — fatos em `v_ciclo_*`, regra em `ciclo-cliente-helpers.ts`

> 2026-10-14. Spec `docs/superpowers/specs/2026-10-14-ciclo-financeiro-cockpit-cliente-design.md`. Prova `db/test-fin-ciclo-cliente.sh`. Diário `docs/historico/ciclo-financeiro-cliente.md`.

- **Prazo concedido = `vencimento − emissão` da PARCELA** (não há condição de pagamento persistida por cliente; vencimento é o VIGENTE — renegociação apaga o original). Média de 30/60/90 = 60 ≠ condição "60": proposta sempre por calendário de parcelas.
- ⚠️ **Amostra só de pagos é viés de sobrevivência**: o vencido em aberto (oben R$268k/408 títulos em 2026-10) é a 2ª população, nunca média com os pagos. Tendência por **mês de VENCIMENTO** com `% pago` — por mês de baixa, recuperar dívida velha "piora" o gráfico.
- ⚠️ **Desconto: `d_max = 1 − (1+c)^(−N/30)`**, não `(1+c)^(N/30) − 1` (achado Codex P0). N = antecipação incremental de CENÁRIO, nunca o atraso histórico.
- **Excesso sobre a carência = média de `max(0, atraso−3)`**, não `max(0, média−3)` — antecipação não cancela atraso.
- Todo R$ da aba é **cenário rotulado**; encurtar prazo de quem paga ANTES do vencimento pode liberar zero (sem R$).
```

Criar `docs/historico/ciclo-financeiro-cliente.md` com: data, PR, números medidos (spec §2), tabela do challenge Codex (spec §11), saídas das falsificações (SQL e helper), e "Fase N+1 só com sinal: query de uso `financeiro.ciclo_aberto` com denominador (nº de sessões master no período)".

- [ ] **Step 3: Commit docs**

```bash
git add docs/agent/financeiro.md docs/historico/ciclo-financeiro-cliente.md
git commit -m "docs(financeiro): lição do ciclo por cliente + diário

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Re-conferir paralelos e abrir PR (não-draft só se tudo verde)**

Run: `git fetch -q origin && git grep -l "v_ciclo_cliente_resumo" origin/main; gh pr list --state open --search "ciclo" --json number,title`
Expected: nenhum artefato homônimo na main / PR paralelo. Então `git push -u origin HEAD` e `gh pr create` com corpo contendo: resumo, roadmap de deploy (migration → envelope/SQL Editor; Publish → founder; edge: nenhuma), evidências coladas (exit 0 dos testes, `PROVA-CICLO-CLIENTE-OK` nos 2 locales, falsificações vermelhas), challenge Codex, e terminar com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Ligar Auto-fix via `mcp__ccd_pr__set_monitor`.

- [ ] **Step 5: Deploy e verificação (após merge)**

1. Migration: pré-voo (`pg_get_viewdef` — as views são novas, conferir `SELECT to_regclass('public.v_ciclo_cliente_resumo')` = NULL antes), aplicar no envelope (idempotente: `CREATE OR REPLACE VIEW`; transacional; postcondição embutida imprime `CICLO-CLIENTE-VIEWS-OK`) ou entregar ao founder para o SQL Editor.
2. Verificar via `psql-ro`: `SELECT company, count(*), round(sum(saldo_vencido)) FROM v_ciclo_cliente_resumo GROUP BY 1` bate com spec §2 (±10%).
3. Founder: Publish no Lovable. Verificar a aba em prod (bundle novo servido) com a skill `lovable-deploy-verify`.
```
