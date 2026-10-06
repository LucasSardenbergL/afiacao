# Venda empurrada no universo canônico no ENVIO — Plano de Implementação

> **Para quem executa:** SUB-SKILL OBRIGATÓRIA: `superpowers:executing-plans` (nativo, recomendado aqui —
> money-path não se delega) ou `superpowers:subagent-driven-development`. Passos com checkbox (`- [ ]`).

**Goal:** a linha do app nasce com `order_date_kpi` (dia de SP) no envio ao Omie, sem reabrir a contagem
dupla dos gêmeos; o ranking não credita a linha do app a ninguém; a conversão de orçamento para de
regravar `'rascunho'`; o sensor `vendas_empurradas_sem_gemeo` para de dizer o contrário.

**Architecture:** o trigger que já existe na linha do app (`sales_orders_gemeo_app_derivar`) ganha um
ramo: quando a linha PASSA a ter `omie_pedido_id` (write-back) ou nasce com ele, sem gêmea, sem kpi e sem
outra linha do pedido com kpi, deriva o kpi do instante do statement (`sales_orders_instante_envio()` =
`statement_timestamp()`) em `America/Sao_Paulo`. Nenhum escritor TS/edge muda para o kpi. No front, o
ranking só atribui linha com hash `omie_` e o `SalesQuotes` deixa o `'enviado'` da edge como estado final.
Uma 2ª migration troca só o texto do sensor de órfã.

**Tech Stack:** Postgres 17 (Supabase, prod `TimeZone=UTC`), PL/pgSQL, bash + `db/lib/pg-harness.sh`
(PG17 descartável), React/TS + vitest, `bun run db:aplicar`, `~/.config/afiacao/psql-ro`.

**Spec:** [docs/superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md](../specs/2026-10-05-app-grava-kpi-no-envio-design.md)

> **Execução (2026-10-06):** o código commitado é a fonte de verdade; desvios: **Task 3 retirado** (o
> ranking passou a atribuir pelo dono da carteira, em outra entrega) e a **prova A tem 13 sabotagens** (+ `pos_sem_dono`/A27, da revisão final) —
> a guarda "outra linha com kpi" NÃO é inalcançável: no UPDATE que zera o kpi do app ela casa a versão
> velha da própria linha e vira trava de reserva do import, então `sem_condicao_envio` declara A11/A13 e
> a nova `sem_envio_nem_autoguarda` (as duas travas fora) declara A6/A21.

## Global Constraints

- **Worktree único:** `/Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push` (branch
  `claude/app-grava-kpi-push`). O cwd do shell volta para outro diretório a cada chamada: todo comando
  começa com `cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push &&`.
- **Regra 1 (literal do founder):** kpi só no INSERT da linha do app ou no MESMO UPDATE do write-back que
  grava o `omie_pedido_id` — nunca num UPDATE posterior de linha já empurrada que liste
  `omie_pedido_id`, `account`, `hash_payload`, `order_date_kpi` ou `gemeo_importado_id` (40P01).
- **Regra 2:** a data é o DIA de São Paulo do instante (`AT TIME ZONE 'America/Sao_Paulo'`), nunca UTC.
- **`gemeo_importado_id` não tem GRANT para `authenticated`:** nada em `src/` lê essa coluna (42501).
- **Migrations:** só ADICIONAR arquivos novos em `supabase/migrations/` (nunca editar os existentes);
  sem `BEGIN/COMMIT` (o `db:aplicar` abre a transação); PRE com identidade por md5, POS com
  `RAISE EXCEPTION`; texto SQL em ASCII sem acento quando estiver dentro do corpo da v2 (Migration B).
- **Provas:** PG17 descartável, `--falsificar` com controle verde na MESMA invocação, uma camada por vez,
  nos DOIS idiomas do servidor (`LC_ALL=C` padrão e `HARNESS_LOCALE=pt_BR.UTF-8`); **commitar antes de
  falsificar**; strings casadas em ASCII, caixa fixa, sem `-i`.
- **Evidência positiva:** todo veredito com o comando autoritativo terminado e `exit=0` colado; nunca
  `| tail` num comando cujo exit importa.
- **Nenhuma edge muda.** Camadas de deploy: 2 migrations (a sessão, via `db:aplicar`) + Publish do front
  (founder).
- **Codex:** só `scripts/codex-async.sh` em background; cota alta (exit 79) = PR **DRAFT** até o
  adversarial no diff (cota reabre **09/10 19:30**).
- **PR:** DRAFT até Codex + revisão final; nunca `gh pr merge --admin`; Auto-fix ligado ao criar.
- pt-BR em código novo, commits, PR e docs; commits terminam com
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Orçamento convertido** (linha `orcamento` → write-back da edge): tem de ganhar o kpi e entrar no
   universo; com o **bundle velho** que ainda regrava `'rascunho'`, a venda sai pelo status e volta **1×**
   pela importada → A16, A17 (Task 1).
2. **Envio perto da meia-noite de SP com o servidor em UTC** → A5 + sabotagens `fuso_utc` e
   `data_da_sessao` (Task 1; o harness sobe com `TimeZone=UTC`).
3. **O write-back roda como `service_role` depois do REVOKE** (papel sem EXECUTE nas funções) → A18 (Task 1).
4. **Card do ranking com linhas do app e importadas misturadas:** Σ ranking + não atribuído = receita MTD
   das mesmas linhas → teste de invariante (Task 3).
5. **Linha com hash próprio (não `omie_`) empurrada:** o trigger não a observa — sem kpi e sem erro, como
   hoje (0 em prod) → A19 (Task 1).

## Diferenças em relação à spec (decididas aqui, todas mais estritas)

- A guarda "outra linha do mesmo pedido com kpi" perde o `AND o.id <> NEW.id`: é inalcançável (no envio
  a versão velha da própria linha tem pid nulo; no INSERT ela não existe). A sabotagem prova a guarda
  inteira.
- Sabotagens a mais: `data_da_sessao` (tira o `AT TIME ZONE`; só avermelha com o servidor em UTC) e
  `costura_now` (a costura com `now()`; o A3 a pega).
- Asserts a mais: A16–A19 (Review Focus 1, 3, 5).
- A PRE também confere a costura, se ela já existir; a POS separa o erro de md5 (marca própria).
- A costura ganha `SET search_path TO 'public'` (advisor do Supabase) e corpo em várias linhas (a
  sabotagem extrai o bloco até `$function$;`).
- Prova B: o A5 compara a linha inteira do sensor (menos o `probable_cause` e a idade) com a da v2 para a
  mesma órfã — "a detecção não muda" vira medição, não só md5.
- `fetchPedidosMTD` perde o `as PedidoMTDRow[]`: o tipo inferido do select passa a ter de cobrir a
  interface, então tirar `hash_payload` do select vira erro de compilação, não `undefined` em runtime.

## Convenção: materializar blocos deste plano

Os arquivos longos estão aqui uma vez só, cada um logo depois de um marcador `<!-- arquivo: X -->`.
As duas funções abaixo também são um bloco: o Task 0 (Step 3) as grava em `/tmp/kpi-helpers.sh`, e todo
comando que as usa começa com `. /tmp/kpi-helpers.sh &&` (cada chamada do Bash é um shell novo). Logs
vão para `/tmp/kpi-*.log` (numa sessão do Claude, o scratchpad da sessão no lugar de `/tmp`).

<!-- arquivo: helpers -->
```bash
materializar() {  # $1 = marcador (o texto depois de "arquivo: "), $2 = destino
  awk -v alvo="<!-- arquivo: $1 -->" '
    $0 == alvo { achou = 1; next }
    achou && !dentro && /^```/ { dentro = 1; next }
    dentro && /^```$/ { exit }
    dentro { print }' docs/superpowers/plans/2026-10-05-app-grava-kpi-no-envio.md > "$2"
  [ -s "$2" ] || { echo "❌ bloco '$1' vazio ou ausente"; return 1; }
}
md5py() {  # $1 = arquivo, $2 = função → md5 do prosrc (o mesmo md5(prosrc) do PG)
  python3 - "$1" "$2" <<'PY'
import hashlib, sys
s = open(sys.argv[1], encoding='utf-8').read()
i = s.index('CREATE OR REPLACE FUNCTION public.%s(' % sys.argv[2])
a = s.index('AS $function$', i) + len('AS $function$')
b = s.index('$function$;', a)
print(hashlib.md5(s[a:b].encode('utf-8')).hexdigest())
PY
}
```

## Estrutura de arquivos

| arquivo | ação | responsabilidade |
|---|---|---|
| `supabase/migrations/20261005220000_sales_orders_kpi_no_envio.sql` | criar | Migration A: costura + novo corpo de `sales_orders_gemeo_app_derivar` + REVOKE + PRE/POS |
| `db/test-sales-orders-kpi-no-envio.sh` | criar | prova PG17 da A (26 asserts, 11 sabotagens) |
| `supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql` | criar | Migration B: corpo da v2 com 2 trocas de texto + PRE/POS |
| `db/test-data-health-venda-empurrada-conta-pelo-app.sh` | criar | prova PG17 da B (9 asserts, 4 sabotagens) |
| `src/lib/dashboard/fetch-pedidos-mtd.ts` | modificar | seleciona `hash_payload`; sem `as` |
| `src/lib/dashboard/team-kpis.ts` | modificar | `OrderRankRow.hash_payload`; só a importada credita |
| `src/hooks/useTeamRanking.ts:49-52` | modificar | repassa `hash_payload` |
| `src/lib/dashboard/__tests__/team-kpis.test.ts` | modificar | linhas com hash + 2 testes novos |
| `src/pages/SalesQuotes.tsx:197-205` | modificar | sai o `update({ status: 'rascunho' })` |
| `src/pages/__tests__/SalesQuotes.accountGuard.test.tsx` | modificar | sucesso sem update |
| `db/nucleo-ci.txt` | modificar | 2 entradas |
| `scripts/audit-custom-migrations.sql`, `docs/migrations-audit.md` | regerar | `bun run audit:migrations` |
| `docs/historico/app-grava-kpi-no-envio.md` | criar | diário da entrega |
| `docs/agent/database.md:281` | modificar | bullet dos gêmeos |
| `docs/historico/gemeos-push-pull-contagem-unica.md` | modificar | 1 linha: entregue |

Nenhum arquivo novo em `src/` (o manifesto de módulos não muda: `src/lib/dashboard/**`, os hooks e os
testes do `SalesQuotes` já têm dono).

---

### Task 0: Preparação

**Files:** nenhum.

- [ ] **Step 1: sincronizar e procurar colisão**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && git fetch -q origin && git status --short && git log --oneline HEAD..origin/main | head -20 && git grep -l "sales_orders_instante_envio\|_data_health_compute\|sales_orders_gemeo_app_derivar" origin/main -- supabase/migrations | sort | tail -3 && gh pr list --state open --limit 50 --json number,title --jq '.[] | select(.title|test("data.health|gemeo|kpi|ranking|SalesQuotes|sales_orders";"i")) | "\(.number) \(.title)"'; echo "exit=$?"
```

Esperado: `git status` limpo; nenhuma migration na main mais nova que `20261005150000` definindo
`_data_health_compute` ou `sales_orders_gemeo_app_derivar`; `sales_orders_instante_envio` ausente; nenhum
PR aberto no mesmo tema. Se a main andou, `git merge origin/main` (sem conflito esperado). Se aparecer
colisão: parar e reavaliar antes de seguir.

- [ ] **Step 2: dependências**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && { [ -d node_modules ] || bun install; } && ls db/lib/pg-harness.sh db/stubs-supabase.sql db/stubs-data-health-trio.sql db/fixtures/get-data-health-predecessora-prod-20261005.sql; echo "exit=$?"
```

Esperado: os 4 caminhos listados, `exit=0`.

- [ ] **Step 3: gravar os helpers**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && awk -v alvo='<!-- arquivo: helpers -->' '$0 == alvo { achou = 1; next } achou && !dentro && /^```/ { dentro = 1; next } dentro && /^```$/ { exit } dentro { print }' docs/superpowers/plans/2026-10-05-app-grava-kpi-no-envio.md > /tmp/kpi-helpers.sh && . /tmp/kpi-helpers.sh && type materializar md5py >/dev/null; echo "exit=$?"
```

Esperado: `exit=0`.

---

### Task 1: Migration A — o trigger deriva o kpi no envio (+ prova)

**Files:**
- Create: `db/test-sales-orders-kpi-no-envio.sh`
- Create: `supabase/migrations/20261005220000_sales_orders_kpi_no_envio.sql`

**Interfaces:**
- Consumes: `20261001100001` (os 3 triggers, `uniq_sales_orders_kpi_por_pedido_omie`, os 2 CHECKs, corpo
  vivo md5 `cc036077756a992f97835f383686e110`); RPC `criar_pedidos_com_itens` de
  `*_desconto_valor_atravessa_os_escritores.sql`.
- Produces: `public.sales_orders_instante_envio() RETURNS timestamptz` (SQL, `STABLE`, INVOKER, sem
  EXECUTE para PUBLIC/anon/authenticated); novo corpo de `public.sales_orders_gemeo_app_derivar()`;
  constantes `MD5_DERIVAR` e `MD5_INSTANTE` (anotar — o Task 8 valida a prod com elas).

- [ ] **Step 1: materializar a prova (teste primeiro)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && . /tmp/kpi-helpers.sh && materializar prova-a db/test-sales-orders-kpi-no-envio.sh && grep -l "PGPORT_TEST:-5601" db/*.sh; echo "exit=$?"
```

Esperado: só `db/test-sales-orders-kpi-no-envio.sh` usa a porta 5601 (se outro já usar, trocar a porta
do novo). O bloco:

<!-- arquivo: prova-a -->
```bash
#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — a venda empurrada ganha order_date_kpi NO ENVIO (o trigger da linha do app deriva)
# ║      bash db/test-sales-orders-kpi-no-envio.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sales-orders-kpi-no-envio.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sales-orders-kpi-no-envio.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Sobre a migration REAL (*_sales_orders_kpi_no_envio.sql), por cima da cadeia real (coerência →
# ║  importador → gêmeos 20261001100001), com a RPC REAL do importador e o servidor em TimeZone=UTC
# ║  (como a prod):
# ║   · a costura do relógio é o statement (DO com pg_sleep; > now() numa transação de vários comandos);
# ║   · o write-back (o UPDATE do criarPedidoVenda, SEM kpi) deriva o dia de SP — 06/10 01:30Z → 05/10,
# ║     bordas 02:59:59Z/03:00Z; INSERT já com pid deriva; kpi explícito é respeitado;
# ║   · só no ENVIO: o import depois do push não re-deriva (RPC real: inserted, app marcado, a venda conta
# ║     1× com o total da importada); UPDATE sem transição, DELETE da importada e reimport também não;
# ║   · a 2ª linha do app no mesmo pedido não quebra o write-back; mesmo pid em contas diferentes;
# ║     orçamento convertido; o bundle velho que regrava 'rascunho'; papel sem EXECUTE; hash próprio;
# ║   · corrida nos dois sentidos, determinística (bandeira + pg_stat_activity);
# ║   · em clones da prod de hoje: reaplicar = no-op, a PRE recusa corpo desconhecido, a POS tem dente,
# ║     o ACL fecha.
# ║  Spec: docs/superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md
# ╚═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5601}"
SLUG="kpi-no-envio"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC
unset PGTZ PGOPTIONS            # o fuso da SESSÃO é o do servidor (UTC, como a prod): a sabotagem data_da_sessao depende disso

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar — o laço de db/test-gemeos-push-pull-contagem-unica.sh, verbatim no método: controle
# VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e cada sabotagem só conta se
# (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle), (3) CADA assert declarado
# estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o controle não tem.
# docs/historico/falsificacao-exit-nao-e-dente.md
# ════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_derivacao:A4,A5,A8,A18 fuso_utc:A4,A5 data_da_sessao:A4,A5
              sem_condicao_envio:A6,A11,A13,A21 sobrescreve_kpi:A10 sem_guarda_outra_linha:A12
              costura_clock:A2 costura_now:A3
              pre_sem_identidade:A24 pos_sem_dente:A25 sem_revoke:A26"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha sozinha aprovaria"
    echo "     todas as sabotagens por vermelhidão constante, não por dente)."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
# PG DESCARTÁVEL: durabilidade desligada (não muda nada do que é provado); deadlock_timeout curto;
# TimeZone=UTC como a PROD — o 'UTC' por engano e o ::date puro só erram com o servidor em UTC.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c TimeZone=UTC -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c deadlock_timeout=200ms" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
Pd() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# SQLSTATE da saída de erro (ASCII, invariante a lc_messages). NUNCA deixa a linha do servidor no log:
# o juiz do --falsificar conta 'ERROR:  ' e uma sabotagem bem-sucedida não pode parecer erro de SQL.
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
rodar() { local out; if out="$(P -q -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo OK; else printf '%s\n' "$out" | sqlstate; fi; }

MIG_COER="$REPO_ROOT/supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql"
MIG_RPC="$(find "$REPO_ROOT/supabase/migrations" -name "*_desconto_valor_atravessa_os_escritores.sql" | sort | tail -1)"
MIG_GEMEOS="$REPO_ROOT/supabase/migrations/20261001100001_sales_orders_gemeo_importado_contagem_unica.sql"
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_sales_orders_kpi_no_envio.sql" | sort | tail -1)"
for m in "$MIG_COER" "$MIG_RPC" "$MIG_GEMEOS" "$MIG"; do
  [ -n "$m" ] && [ -f "$m" ] || { echo "❌ migration ausente: [$m] — a prova testaria o NADA"; exit 1; }
done

c1="11111111-1111-1111-1111-111111111111"    # cliente A
c2="22222222-2222-2222-2222-222222222222"    # cliente B
sys="33333333-3333-3333-3333-333333333333"   # usuário de sistema do importador
vend="44444444-4444-4444-4444-444444444444"  # vendedor (linha do app)
p1="aaaaaaaa-0000-0000-0000-000000000001"    # produto 555
app() { echo "a0000000-0000-0000-0000-000000000$1"; }   # id da linha do app do pedido $1 (3 dígitos)
imp() { echo "b0000000-0000-0000-0000-000000000$1"; }   # id da importada SEMEADA do pedido $1

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC · TimeZone=UTC ═══"
# ── schema mínimo fiel à prod (o mesmo de db/test-gemeos-push-pull-contagem-unica.sh) ─────────────
P -q <<'SQL'
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, account text);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho', notes text,
  omie_pedido_id bigint, omie_numero_pedido text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  account text NOT NULL DEFAULT 'oben', hash_payload text,
  customer_address text, customer_phone text, order_date_kpi date, deleted_at timestamptz,
  omie_payload jsonb, omie_response jsonb, omie_reconciliado_em timestamptz,
  CONSTRAINT sales_orders_hash_omie_canonico CHECK (hash_payload IS NULL OR hash_payload NOT LIKE 'omie\_%'
    OR (omie_pedido_id IS NOT NULL AND hash_payload = 'omie_' || account || '_' || omie_pedido_id)));
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
CREATE UNIQUE INDEX uniq_sales_orders_omie_pedido_id
  ON public.sales_orders (account, omie_pedido_id) WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;
CREATE TRIGGER update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric DEFAULT 0,
  desconto_valor numeric, omie_codigo_item bigint,
  created_at timestamptz DEFAULT now(), hash_payload text);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, product_id uuid NOT NULL, unit_price numeric NOT NULL,
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now());
SQL
# a cadeia REAL que a prod executou, na ordem lexical: coerência (DEFERRED) → importador
P -q -1 -f "$MIG_COER" >/dev/null
P -q -1 -f "$MIG_RPC" >/dev/null

# ── backlog como a prod tinha antes dos gêmeos (o mesmo da prova dos gêmeos) ─────────────────────────
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$c1'),('$c2'),('$sys'),('$vend') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, omie_codigo_produto, account) VALUES ('$p1', 555, 'oben');
INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, account, omie_pedido_id,
                                 hash_payload, omie_payload, order_date_kpi, created_at) VALUES
  ('$(app 101)', '$c1', '$vend', 'enviado',   527.20, 'oben',    101,  NULL,            '{}', '2026-04-06', '2026-04-06 13:49Z'),
  ('$(imp 101)', '$c1', '$sys',  'faturado',  600,    'oben',    101,  'omie_oben_101', NULL, '2026-04-06', '2026-04-06 12:00Z'),
  ('$(app 102)', '$c1', '$vend', 'enviado',   527.20, 'oben',    102,  NULL,            '{}', '2026-04-06', '2026-04-06 13:55Z'),
  ('$(imp 102)', '$c2', '$sys',  'faturado',  560,    'oben',    102,  'omie_oben_102', NULL, '2026-04-06', '2026-04-06 12:00Z'),
  ('$(app 103)', '$c1', '$vend', 'enviado',   240,    'oben',    103,  NULL,            '{}', NULL,         '2026-06-10 11:43Z'),
  ('$(imp 103)', '$c1', '$sys',  'faturado',  339.10, 'oben',    103,  'omie_oben_103', NULL, '2026-06-10', '2026-06-10 12:00Z'),
  ('$(app 104)', '$c1', '$vend', 'enviado',   314.40, 'oben',    104,  NULL,            '{}', '2026-04-06', '2026-04-06 18:55Z'),
  ('$(app 105)', '$c1', '$vend', 'orcamento', 4660,   'oben',    NULL, NULL,            NULL, NULL,         '2026-06-12 15:00Z'),
  ('$(app 106)', '$c1', '$vend', 'rascunho',  10,     'oben',    NULL, NULL,            NULL, NULL,         '2026-06-12 15:05Z'),
  ('$(app 107)', '$c1', '$vend', 'enviado',   50,     'colacor', 107,  NULL,            '{}', '2026-04-07', '2026-04-07 14:00Z'),
  ('$(imp 107)', '$c2', '$sys',  'faturado',  70,     'oben',    107,  'omie_oben_107', NULL, '2026-04-07', '2026-04-07 12:00Z'),
  ('$(app 108)', '$c1', '$vend', 'enviado',   25,     'oben',    108,  NULL,            '{}', '2026-04-08', '2026-04-08 10:00Z'),
  ('a1000000-0000-0000-0000-000000000108', '$c1', '$vend', 'enviado', 25, 'oben', 108, NULL, '{}', '2026-04-08', '2026-04-08 10:05Z'),
  ('$(imp 108)', '$c1', '$sys',  'faturado',  30,     'oben',    108,  'omie_oben_108', NULL, '2026-04-08', '2026-04-08 12:00Z');
SQL
# os gêmeos, como a prod os tem desde 2026-10-05 (o corpo que esta entrega substitui)
P -q -1 -f "$MIG_GEMEOS" >/dev/null

nova_app() {  # $1 = total[, $2 = status, $3 = conta] → linha do app SEM pid, como o balcão/orçamento a criam
  Pq -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, status, total, account) VALUES ('$c1', '$vend', '${2:-rascunho}', $1, '${3:-oben}') RETURNING id;"
}
write_back() {  # $1 = id da linha do app, $2 = pid → o UPDATE do criarPedidoVenda (omie-vendas-sync), SEM kpi
  echo "UPDATE public.sales_orders SET omie_pedido_id = $2, omie_numero_pedido = '$2', omie_payload = '{}'::jsonb, omie_response = '{}'::jsonb, status = 'enviado' WHERE id = '$1';"
}
# uma linha do app empurrada ANTES desta entrega (pid, sem gêmeo, sem kpi): o A11 parte dela, e a POS
# dos clones tem de aceitá-la (spec §8.5: a empurrada antes do apply não ganha kpi).
PRE_APPLY="$(nova_app 70)"
P -q -c "$(write_back "$PRE_APPLY" 1100)"
# MOLDE = a prod de hoje (cadeia + gêmeos + backlog), SEM esta migration: os clones do A23–A26 partem daqui.
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T prove molde

echo "═══ migration desta entrega: $(basename "$MIG") ═══"
eq "A1 a migration aplica e a postcondição passa" "$(P -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)" "OK"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM — no BANCO, recriando a função com UM trecho trocado; o repo nunca é tocado. O padrão
# tem de ocorrer exatamente 1× no bloco (substituição que não pega deixaria a suíte verde). As três
# últimas são aplicadas nos clones (A24–A26), sobre CÓPIAS da migration.
# ════════════════════════════════════════════════════════════════════════════════════════════════
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, "w").write(s.replace(de, para))
PYSAB
}
sabotar() {
  local fn="$1" de="$2" para="$3" tmp
  tmp="$(mktemp "/tmp/sab-${SLUG}.XXXXXX")"
  awk -v fn="CREATE OR REPLACE FUNCTION public.${fn}(" \
      'index($0,fn)==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$MIG" > "$tmp"
  trocar "$tmp" "$de" "$para" || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× em $fn"; rm -f "$tmp"; exit 9; }
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
  echo "⚠️  SABOTAGEM ATIVA em $fn — a suíte abaixo DEVE ficar vermelha"
}

case "${SABOTAGEM:-}" in
  "") ;;
  sem_derivacao)
    sabotar sales_orders_gemeo_app_derivar \
      "      NEW.order_date_kpi := (public.sales_orders_instante_envio() AT TIME ZONE 'America/Sao_Paulo')::date;" "      NULL;" ;;
  fuso_utc)
    sabotar sales_orders_gemeo_app_derivar "AT TIME ZONE 'America/Sao_Paulo'" "AT TIME ZONE 'UTC'" ;;
  data_da_sessao)
    sabotar sales_orders_gemeo_app_derivar \
      "(public.sales_orders_instante_envio() AT TIME ZONE 'America/Sao_Paulo')::date" "public.sales_orders_instante_envio()::date" ;;
  sem_condicao_envio)
    sabotar sales_orders_gemeo_app_derivar "    IF v_envio AND NOT EXISTS" "    IF NOT EXISTS" ;;
  sobrescreve_kpi)
    sabotar sales_orders_gemeo_app_derivar "  ELSIF NEW.order_date_kpi IS NULL THEN" "  ELSIF true THEN" ;;
  sem_guarda_outra_linha)
    sabotar sales_orders_gemeo_app_derivar "AND o.order_date_kpi IS NOT NULL) THEN" "AND false) THEN" ;;
  costura_clock)
    sabotar sales_orders_instante_envio "SELECT pg_catalog.statement_timestamp()" "SELECT pg_catalog.clock_timestamp()" ;;
  costura_now)
    sabotar sales_orders_instante_envio "SELECT pg_catalog.statement_timestamp()" "SELECT pg_catalog.now()" ;;
  pre_sem_identidade|pos_sem_dente|sem_revoke) ;;   # aplicadas nos clones (A24–A26)
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac

# ── leituras ───────────────────────────────────────────────────────────────────────────────────────
# 't' quando a linha do app $1 está marcada: sem kpi e apontando para a importada do mesmo pedido.
marcada() { Pq -c "SELECT (a.order_date_kpi IS NULL AND i.id IS NOT NULL AND a.gemeo_importado_id IS NOT DISTINCT FROM i.id)
  FROM public.sales_orders a LEFT JOIN public.sales_orders i ON i.account = a.account AND i.hash_payload LIKE 'omie\_%'
   AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id WHERE a.id = '$1';"; }
kpi_ptr() { Pq -c "SELECT coalesce(order_date_kpi::text, 'nulo') || '|' || CASE WHEN gemeo_importado_id IS NULL THEN 'nulo' ELSE 'ptr' END
  FROM public.sales_orders WHERE id = '$1';"; }
dup_kpi() { Pq -c "SELECT count(*) FROM (SELECT 1 FROM public.sales_orders WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL
  GROUP BY account, omie_pedido_id HAVING count(*) > 1) d;"; }
canon() {  # $1 = pid[, $2 = conta] → "receita|linhas" do universo canônico daquele pedido Omie
  Pq -c "SELECT coalesce(sum(total)::text, 'nada') || '|' || count(*) FROM public.sales_orders
          WHERE account = '${2:-oben}' AND omie_pedido_id = $1 AND order_date_kpi IS NOT NULL
            AND status NOT IN ('cancelado','rascunho','pendente','orcamento') AND deleted_at IS NULL;"
}
DATA_OMIE='"order_date_kpi":"2026-10-05",'   # o dInc do Omie = o dia de SP do envio (25/25 na prod)
payload() {  # $1 = pid, $2 = total → 1 pedido do Omie da OBEN; items-jsonb ≡ itens (o trigger de coerência exige)
  printf '%s' "'[{\"customer_user_id\":\"$c1\",\"created_by\":\"$sys\",\"account\":\"oben\",\"hash_payload\":\"omie_oben_${1}\",\"omie_pedido_id\":${1},\"omie_numero_pedido\":\"${1}\",\"status\":\"importado\",${DATA_OMIE}\"created_at\":\"2026-10-05T12:00:00Z\",\"subtotal\":${2},\"discount\":0,\"total\":${2},\"items\":[{\"omie_codigo_produto\":555,\"quantidade\":1,\"valor_unitario\":${2},\"desconto\":0}],\"itens\":[{\"omie_codigo_produto\":555,\"quantity\":1,\"unit_price\":${2},\"discount\":0,\"hash_payload\":\"omie_oben_${1}_555\"}]}]'::jsonb"
}
rpc() { Pq -c "SELECT (r->>'inserted') || '|' || (r->>'skipped_complete') || '|' || jsonb_array_length(r->'failed')
  FROM (SELECT public.criar_pedidos_com_itens($(payload "$1" "$2")) AS r) x;"; }

echo "═══ a costura do relógio (a função REAL desta migration) ═══"
# shellcheck disable=SC2016  # $d$/$m$ são dollar-quotes do PostgreSQL, não variáveis do shell
COSTURA_FIXA='DO $d$ DECLARE a timestamptz; b timestamptz; BEGIN
  a := public.sales_orders_instante_envio(); PERFORM pg_sleep(0.2); b := public.sales_orders_instante_envio();
  IF a IS DISTINCT FROM b THEN RAISE EXCEPTION $m$a costura andou dentro do statement$m$; END IF;
END $d$;'
eq "A2 a costura é fixa no statement (2 leituras com pg_sleep entre elas: iguais)" "$(rodar "$COSTURA_FIXA")" "OK"
r3="$(Pq -q 2>/dev/null <<'SQL'
BEGIN;
SELECT pg_sleep(0.2);
SELECT public.sales_orders_instante_envio() > now();
COMMIT;
SQL
)" || r3="ERRO"
eq "A3 a costura é o statement, não a transação (> now() num comando posterior da mesma transação)" \
   "$(printf '%s\n' "$r3" | grep -v '^$' | tail -1)" "t"

# Daqui em diante o instante é FIXO (GUC test.instante; sem ela, o statement): só assim "dia de SP, nunca
# UTC" se prova em qualquer hora. CREATE OR REPLACE preserva o ACL que a migration fechou.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.sales_orders_instante_envio()
 RETURNS timestamp with time zone LANGUAGE sql STABLE
AS $f$ SELECT coalesce(nullif(current_setting('test.instante', true), '')::timestamptz, pg_catalog.statement_timestamp()) $f$;
ALTER DATABASE prove SET test.instante = '2026-10-06 01:30:00+00';
SQL

echo "═══ o envio deriva o dia de SP ═══"
A4ID="$(nova_app 100)"
P -q -c "$(write_back "$A4ID" 1001)"
eq "A4 o write-back sem gêmeo deriva o dia de SP do instante (06/10 01:30Z → 2026-10-05)" "$(kpi_ptr "$A4ID")" "2026-10-05|nulo"
A5a="$(nova_app 100)"; A5b="$(nova_app 100)"
P -q -c "SET test.instante = '2026-10-06 02:59:59+00'; $(write_back "$A5a" 1002)"
P -q -c "SET test.instante = '2026-10-06 03:00:00+00'; $(write_back "$A5b" 1003)"
eq "A5 bordas da meia-noite de SP: 02:59:59Z → 05/10 · 03:00:00Z → 06/10" \
   "$(kpi_ptr "$A5a")|$(kpi_ptr "$A5b")" "2026-10-05|nulo|2026-10-06|nulo"

echo "═══ só no ENVIO: o importador e os UPDATEs seguintes não re-derivam ═══"
A6ID="$(nova_app 100)"
P -q -c "$(write_back "$A6ID" 1010)"
r6="$(rpc 1010 120)"
eq "A6 import depois do push (RPC real): inserted, app marcado, importada com o dInc, a venda conta 1× com o total da importada" \
   "$r6|$(kpi_ptr "$A6ID")|$(Pq -c "SELECT order_date_kpi FROM public.sales_orders WHERE hash_payload = 'omie_oben_1010';")|$(canon 1010)" \
   "1|0|0|nulo|ptr|2026-10-05|120|1"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1020 80));" >/dev/null
A7ID="$(nova_app 80)"
r7="$(rodar "$(write_back "$A7ID" 1020)")"
eq "A7 push DEPOIS do import: o write-back passa e não deriva (a importada já é a venda)" \
   "$r7|$(kpi_ptr "$A7ID")|$(canon 1020)" "OK|nulo|ptr|80|1"
r8="$(rodar "INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, omie_pedido_id, omie_payload) VALUES ('c0000000-0000-0000-0000-000000001030', '$c1', '$vend', 'enviado', 40, 1030, '{}');")"
eq "A8 linha do app que JÁ NASCE com pid (sem gêmeo) deriva o kpi" "$r8|$(kpi_ptr c0000000-0000-0000-0000-000000001030)" "OK|2026-10-05|nulo"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1031 41));" >/dev/null
r9="$(rodar "INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, omie_pedido_id, omie_payload) VALUES ('c0000000-0000-0000-0000-000000001031', '$c1', '$vend', 'enviado', 41, 1031, '{}');")"
eq "A9 linha do app que nasce com pid de pedido JÁ importado nasce marcada, sem kpi" "$r9|$(kpi_ptr c0000000-0000-0000-0000-000000001031)" "OK|nulo|ptr"
r10a="$(rodar "INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, omie_pedido_id, omie_payload, order_date_kpi) VALUES ('c0000000-0000-0000-0000-000000001040', '$c1', '$vend', 'enviado', 42, 1040, '{}', DATE '2026-04-06');")"
A10ID="$(nova_app 43)"
r10b="$(rodar "UPDATE public.sales_orders SET omie_pedido_id = 1041, omie_numero_pedido = '1041', omie_payload = '{}'::jsonb, status = 'enviado', order_date_kpi = DATE '2026-04-07' WHERE id = '$A10ID';")"
eq "A10 kpi explícito é respeitado (INSERT com pid e kpi; write-back que traz o kpi)" \
   "$r10a|$(kpi_ptr c0000000-0000-0000-0000-000000001040)|$r10b|$(kpi_ptr "$A10ID")" "OK|2026-04-06|nulo|OK|2026-04-07|nulo"
r11="$(rodar "UPDATE public.sales_orders SET omie_pedido_id = omie_pedido_id, account = account WHERE id = '$PRE_APPLY';")"
eq "A11 linha empurrada ANTES do apply: UPDATE sem transição de pid não deriva" "$r11|$(kpi_ptr "$PRE_APPLY")" "OK|nulo|nulo"
A12a="$(nova_app 25)"; A12b="$(nova_app 25)"
P -q -c "$(write_back "$A12a" 1060)"
r12="$(rodar "$(write_back "$A12b" 1060)")"
eq "A12 2ª linha do app no MESMO pedido (só por SQL manual): o write-back passa e só a 1ª tem kpi" \
   "$r12|$(kpi_ptr "$A12a")|$(kpi_ptr "$A12b")|$(dup_kpi)" "OK|2026-10-05|nulo|nulo|nulo|0"
A13ID="$(nova_app 70)"
P -q -c "$(write_back "$A13ID" 1070)"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1070 70));" >/dev/null
r13="$(rodar "DELETE FROM public.sales_orders WHERE hash_payload = 'omie_oben_1070';")"
depois_delete="$(kpi_ptr "$A13ID")"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1070 70));" >/dev/null
eq "A13 apagar a importada não re-deriva o kpi do app; o reimport refaz o ponteiro" \
   "$r13|$depois_delete|$(marcada "$A13ID")" "OK|nulo|nulo|t"
r14="$(rodar "UPDATE public.sales_orders SET account = account WHERE id IN ('$(app 105)', '$(app 106)');")"
eq "A14 orçamento e rascunho (sem pid) seguem sem kpi e sem ponteiro, mesmo tocando coluna observada" \
   "$r14|$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id IN ('$(app 105)', '$(app 106)') AND (gemeo_importado_id IS NOT NULL OR order_date_kpi IS NOT NULL);")" "OK|0"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1150 55));" >/dev/null
A15ID="$(nova_app 50 rascunho colacor)"
P -q -c "$(write_back "$A15ID" 1150)"
eq "A15 mesmo pid em contas diferentes: a COLACOR deriva o kpi dela; a venda da OBEN segue sendo a importada" \
   "$(kpi_ptr "$A15ID")|$(canon 1150 colacor)|$(canon 1150 oben)" "2026-10-05|nulo|50|1|55|1"

echo "═══ os caminhos do app (Review Focus) ═══"
A16ID="$(nova_app 300 orcamento)"
P -q -c "$(write_back "$A16ID" 1160)"
eq "A16 orçamento convertido (SalesQuotes → edge): o write-back leva a 'enviado', deriva o kpi e a venda entra no universo" \
   "$(Pq -c "SELECT status FROM public.sales_orders WHERE id = '$A16ID';")|$(kpi_ptr "$A16ID")|$(canon 1160)" "enviado|2026-10-05|nulo|300|1"
A17ID="$(nova_app 310 orcamento)"
P -q -c "$(write_back "$A17ID" 1170)"
P -q -c "UPDATE public.sales_orders SET status = 'rascunho' WHERE id = '$A17ID';"   # o SalesQuotes ANTIGO
antes_import="$(kpi_ptr "$A17ID")|$(canon 1170)"
r17="$(rpc 1170 320)"
eq "A17 bundle velho regrava 'rascunho' depois do envio: o kpi fica, a venda sai pelo status e volta 1× pela importada" \
   "$antes_import|$r17|$(kpi_ptr "$A17ID")|$(canon 1170)" "2026-10-05|nulo|nada|0|1|0|0|nulo|ptr|320|1"
P -q <<'SQL'
CREATE ROLE escritor_sem_exec NOLOGIN;
GRANT USAGE ON SCHEMA public TO escritor_sem_exec;
GRANT SELECT, INSERT, UPDATE ON public.sales_orders TO escritor_sem_exec;
SQL
A18ID="$(nova_app 60)"
sem_exec="$(Pq -c "SELECT has_function_privilege('escritor_sem_exec', 'public.sales_orders_instante_envio()', 'EXECUTE')
                       OR has_function_privilege('escritor_sem_exec', 'public.sales_orders_gemeo_app_derivar()', 'EXECUTE');")"
r18="$(rodar "SET ROLE escritor_sem_exec; $(write_back "$A18ID" 1180)")"
eq "A18 papel SEM EXECUTE nas funções (o service_role depois do REVOKE) faz o write-back e o kpi nasce" \
   "$sem_exec|$r18|$(kpi_ptr "$A18ID")" "f|OK|2026-10-05|nulo"
A19ID="$(Pq -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, status, total, hash_payload) VALUES ('$c1', '$vend', 'rascunho', 19, 'checkout_abc') RETURNING id;")"
r19="$(rodar "$(write_back "$A19ID" 1190)")"
eq "A19 linha com hash PRÓPRIO (não omie_) empurrada: o trigger não a observa — sem kpi, sem erro (como hoje)" \
   "$r19|$(kpi_ptr "$A19ID")" "OK|nulo|nulo"

echo "═══ corrida: o advisory lock serializa write-back e importador ═══"
P -q -c "CREATE TABLE public._prova_bandeira (id int);"
Pbg() {  # $1 = application_name, $2 = SQL → conexão própria (para segurar transação ou esperar lock)
  PGAPPNAME="$1" "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q -tA -c "$2"
}
# shellcheck disable=SC2016  # $w$ é o dollar-quote do PostgreSQL, não variável do shell: não pode expandir
SEGURAR='DO $w$ BEGIN WHILE NOT EXISTS (SELECT 1 FROM public._prova_bandeira) LOOP PERFORM pg_sleep(0.02); END LOOP; END $w$;'
esperar() {  # $1 = application_name, $2 = condição sobre pg_stat_activity (alias a). Nunca aborta a suíte.
  local i=0
  while [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity a WHERE a.application_name = '$1' AND ($2);")" != "1" ]; do
    i=$((i+1)); if [ "$i" -gt 400 ]; then echo "  (timeout esperando $1: $2)"; return 0; fi
    sleep 0.05
  done
}
corrida() {  # $1 = SQL que SEGURA a transação aberta, $2 = SQL que deve ESPERAR → "rc|saída-ou-SQLSTATE"
  P -q -c "DELETE FROM public._prova_bandeira;"
  ( Pbg prova_segura "BEGIN; $1 $SEGURAR COMMIT;" > "$TMP/segura.out" 2>&1 || true ) &
  esperar prova_segura "a.wait_event = 'PgSleep'"
  ( if Pbg prova_espera "$2" > "$TMP/espera.out" 2>&1; then echo 0; else echo 1; fi > "$TMP/espera.rc" ) &
  esperar prova_espera "a.wait_event_type = 'Lock'"
  P -q -c "INSERT INTO public._prova_bandeira VALUES (1);"
  wait || true
  local rc saida
  rc="$(cat "$TMP/espera.rc")"
  if [ "$rc" = 0 ]; then saida="$(grep -v '^$' "$TMP/espera.out" | tail -1 || true)"; else saida="$(sqlstate < "$TMP/espera.out")"; fi
  printf '%s|%s' "$rc" "$saida"
}
A20ID="$(nova_app 90)"
r20="$(corrida "SELECT public.criar_pedidos_com_itens($(payload 1200 90));" "$(write_back "$A20ID" 1200)")"
eq "A20 corrida (o importador segura a transação): o write-back ESPERA o lock, não deriva e sai marcado" \
   "${r20%%|*}|$(kpi_ptr "$A20ID")" "0|nulo|ptr"
A21ID="$(nova_app 91)"
r21="$(corrida "$(write_back "$A21ID" 1210)" "SELECT public.criar_pedidos_com_itens($(payload 1210 91))->>'inserted';")"
eq "A21 corrida (o write-back segura, com o kpi já derivado): o importador ESPERA, insere e o app sai marcado" \
   "$r21|$(marcada "$A21ID")" "0|1|t"

echo "═══ invariante final ═══"
inv="$(Pq -c "SELECT (SELECT count(*) FROM (SELECT 1 FROM public.sales_orders WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL
                                                GROUP BY account, omie_pedido_id HAVING count(*) > 1) d)
  || '|' || (SELECT count(*) FROM public.sales_orders a JOIN public.sales_orders i
               ON i.account = a.account AND i.hash_payload LIKE 'omie\_%' AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id
              WHERE a.hash_payload IS NULL AND a.omie_pedido_id IS NOT NULL AND a.gemeo_importado_id IS DISTINCT FROM i.id)
  || '|' || (SELECT count(*) FROM public.sales_orders WHERE gemeo_importado_id IS NOT NULL AND order_date_kpi IS NOT NULL);")"
eq "A22 invariante final: 0 pedido com 2 kpi · todo app com gêmeo aponta para ele · 0 ponteiro com kpi" "$inv" "0|0|0"

echo "═══ em clones da prod de hoje (molde): reaplicar, PRE, POS, ACL ═══"
foto_db() { Pd "$1" -tA -c "SELECT md5(string_agg(id || ':' || coalesce(order_date_kpi::text, '-') || ':' || coalesce(gemeo_importado_id::text, '-')
  || ':' || status || ':' || total, ',' ORDER BY id)) FROM public.sales_orders;"; }
md5s_db() { Pd "$1" -tA -c "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc
  WHERE proname IN ('sales_orders_gemeo_app_derivar', 'sales_orders_instante_envio');"; }
md5_der() { Pd "$1" -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.sales_orders_gemeo_app_derivar()'::regprocedure;"; }

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde re
r23a="$(Pd re -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)"
antes23="$(foto_db re)|$(md5s_db re)"
r23b="$(Pd re -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)"
eq "A23 reaplicar a migration é no-op (a PRE aceita esta versão; nenhuma linha nem corpo muda)" \
   "$r23a|$r23b|$([ "$(foto_db re)|$(md5s_db re)" = "$antes23" ] && echo igual || echo mudou)" "OK|OK|igual"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pre
# shellcheck disable=SC2016  # $f$ é dollar-quote do PostgreSQL
Pd pre -q -c 'CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_app_derivar() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '"'public'"' AS $f$ BEGIN RETURN NEW; END $f$;'
estranho="$(md5_der pre)"
cp "$MIG" "$TMP/mig-pre.sql"
if [ "${SABOTAGEM:-}" = "pre_sem_identidade" ]; then
  trocar "$TMP/mig-pre.sql" "  IF v_md5 <> 'cc036077756a992f97835f383686e110'" "  IF false AND v_md5 <> 'cc036077756a992f97835f383686e110'" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na PRE"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PRE (sem a identidade do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out24="$(Pd pre -q -1 -f "$TMP/mig-pre.sql" 2>&1 || true)"
case "$out24" in
  *"PRE FALHOU"*) r24="recusou" ;;
  *) if [ -z "$out24" ]; then r24="aplicou"; else r24="erro:$(printf '%s\n' "$out24" | sqlstate)"; fi ;;
esac
eq "A24 a PRE recusa um corpo vivo desconhecido e não o sobrescreve" "$r24|$(md5_der pre)" "recusou|$estranho"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pos
cp "$MIG" "$TMP/mig-pos.sql"
trocar "$TMP/mig-pos.sql" "  v_envio boolean;" "  v_envio boolean; -- corpo que nao e o desta versao" \
  || { echo "❌ a declaração do v_envio mudou de forma — o A25 não consegue montar o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_sem_dente" ]; then
  trocar "$TMP/mig-pos.sql" "  IF v_md5_der IS DISTINCT FROM " "  IF false AND v_md5_der IS DISTINCT FROM " \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na POS"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em POS (sem o md5 do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out25="$(Pd pos -q -1 -f "$TMP/mig-pos.sql" 2>&1 || true)"
case "$out25" in
  *"POS FALHOU kpi-no-envio md5:"*) r25="recusou:md5" ;;
  *"POS FALHOU"*) r25="recusou:outro_motivo" ;;
  *) if [ -z "$out25" ]; then r25="aplicou"; else r25="erro:$(printf '%s\n' "$out25" | sqlstate)"; fi ;;
esac
eq "A25 a POS recusa um corpo que não é o desta versão (md5)" "$r25" "recusou:md5"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde acl
cp "$MIG" "$TMP/mig-acl.sql"
if [ "${SABOTAGEM:-}" = "sem_revoke" ]; then
  trocar "$TMP/mig-acl.sql" "REVOKE ALL ON FUNCTION public.sales_orders_instante_envio()    FROM PUBLIC, anon, authenticated;" "" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o REVOKE da costura não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em REVOKE da costura — a suíte abaixo DEVE ficar vermelha"
fi
r26="$(Pd acl -q -1 -f "$TMP/mig-acl.sql" >/dev/null 2>&1 && echo OK || echo FALHOU)"
acl26="$(Pd acl -tA -c "SELECT count(*) FILTER (WHERE has_function_privilege(r.papel, p.oid, 'EXECUTE')) || '|' || count(DISTINCT p.oid)
  FROM pg_proc p CROSS JOIN (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
 WHERE p.oid IN (SELECT to_regprocedure(s) FROM unnest(ARRAY['public.sales_orders_gemeo_app_derivar()',
                   'public.sales_orders_gemeo_importada_antes()', 'public.sales_orders_gemeo_importada_depois()',
                   'public.sales_orders_instante_envio()']) AS s);")"
eq "A26 a migration fecha o EXECUTE das 4 funções para PUBLIC/anon/authenticated" "$r26|$acl26" "OK|0|4"

echo
echo "PASS=${PASS}  FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 2: rodar a prova e ver falhar (sem a migration)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bash db/test-sales-orders-kpi-no-envio.sh > /tmp/kpi-a.log 2>&1; echo "exit=$?"; grep -m1 "migration ausente" /tmp/kpi-a.log
```

Esperado: `exit=1` e a linha `❌ migration ausente: [] — a prova testaria o NADA`.

- [ ] **Step 3: materializar a Migration A**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && . /tmp/kpi-helpers.sh && materializar migration-a supabase/migrations/20261005220000_sales_orders_kpi_no_envio.sql; echo "exit=$?"
```

<!-- arquivo: migration-a -->
```sql
-- ============================================================================================
-- A venda empurrada entra no universo canonico NO ENVIO: o trigger da linha do app deriva o kpi
-- ============================================================================================
-- Desde 20261001100001 os gemeos push/pull contam 1x (so order_date_kpi): a importada e a venda e a
-- linha do app vira recibo (kpi NULL + gemeo_importado_id). Mas nenhum escritor do app grava o kpi:
-- a venda empurrada so entrava no universo quando o importador trazia a gemea (~2 h), e a que nunca
-- volta ficava fora. Aqui o trigger da linha do app (trg_sales_orders_gemeo_app ->
-- sales_orders_gemeo_app_derivar) passa a DERIVAR o kpi no ENVIO:
--  * ENVIO = a linha passa a ter omie_pedido_id (UPDATE com OLD.omie_pedido_id nulo: o write-back do
--    criarPedidoVenda) ou ja nasce com ele (INSERT). O UPDATE do trigger da importada, que zera este
--    kpi antes de a importada entrar, nao e envio e nao re-deriva - se re-derivasse, o indice unico
--    barraria a importada (23505).
--  * so se o kpi vier vazio (kpi explicito e respeitado) e se nenhuma OUTRA linha do mesmo pedido ja
--    tiver kpi (a 2a linha do app cairia em 23505 no write-back, depois de o Omie aceitar).
--  * a data e o DIA DE SAO PAULO do instante, nunca o de UTC (a prod roda com TimeZone=UTC).
--  * o instante vem de public.sales_orders_instante_envio() = statement_timestamp(): a chegada do
--    UPDATE do write-back, antes de qualquer espera de lock (now() seria o inicio da transacao;
--    clock_timestamp() incluiria a espera). A funcao existe para a prova fixar o instante.
--  * nenhum lock novo, nenhum escritor novo, nenhum UPDATE posterior nas 5 colunas observadas: a
--    regra "kpi so no INSERT ou no MESMO UPDATE do write-back" vale por construcao.
-- Os 3 triggers, o indice unico e os 2 CHECKs da 20261001100001 NAO mudam. Sem backfill (0 candidatas).
--
-- Corpo de partida = o de PROD, conferido em 2026-10-05 (md5 do prosrc):
--   sales_orders_gemeo_app_derivar  cc036077756a992f97835f383686e110 = 20261001100001
--   sales_orders_instante_envio     ausente (nasce aqui)
-- Spec: docs/superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md (5.1, 5.2)
-- Aplicacao: `bun run db:aplicar` (o EXECUTOR fornece a transacao - por isso nao ha BEGIN/COMMIT aqui).
-- Prova: db/test-sales-orders-kpi-no-envio.sh (PG17, com --falsificar).
-- ============================================================================================
SET LOCAL lock_timeout = '5s';

-- ── PRE: trava e identidade, ANTES de ler (idioma da 20261005150000) ─────────────────────────
-- O ALTER ... SET search_path com o MESMO valor atualiza a linha de pg_proc: um CREATE OR REPLACE
-- concorrente espera esta transacao e falha. Funcao ausente ABORTA. Identidade = md5 EXATO; aceita o
-- predecessor (1o apply) ou ESTA versao (re-aplicacao idempotente); qualquer outro corpo aborta. A
-- costura, se ja existir, tem de ser a desta versao.
DO $pre$
DECLARE
  v_md5  text;
  v_md5i text;
BEGIN
  ALTER FUNCTION public.sales_orders_gemeo_app_derivar() SET search_path = public;

  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.sales_orders_gemeo_app_derivar()');
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.sales_orders_gemeo_app_derivar() ausente depois da trava.';
  END IF;
  IF v_md5 <> 'cc036077756a992f97835f383686e110' AND v_md5 <> '__MD5_DERIVAR__' THEN
    RAISE EXCEPTION 'PRE FALHOU: public.sales_orders_gemeo_app_derivar() tem corpo md5 % - nem o predecessor '
                    '(cc036077756a992f97835f383686e110) nem esta versao (__MD5_DERIVAR__). Outro aplicador '
                    'recriou a funcao depois do pre-voo; este apply o REVERTERIA. Remonte a migration sobre o '
                    'pg_get_functiondef vivo.', v_md5;
  END IF;

  SELECT md5(p.prosrc) INTO v_md5i
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.sales_orders_instante_envio()');
  IF v_md5i IS NOT NULL AND v_md5i <> '__MD5_INSTANTE__' THEN
    RAISE EXCEPTION 'PRE FALHOU: public.sales_orders_instante_envio() ja existe com corpo md5 % (esta versao: '
                    '__MD5_INSTANTE__). Remonte a migration sobre o pg_get_functiondef vivo.', v_md5i;
  END IF;
END
$pre$;

-- ── a costura do relogio ─────────────────────────────────────────────────────────────────────
-- INVOKER e sem EXECUTE publico: o unico chamador e o trigger SECURITY DEFINER, que roda como o dono.
CREATE OR REPLACE FUNCTION public.sales_orders_instante_envio()
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT pg_catalog.statement_timestamp()
$function$;

-- ── o trigger da linha do app: igual a 20261001100001 + o ramo do ENVIO ────────────────────────
CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_app_derivar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gemeo uuid;
  v_envio boolean;
BEGIN
  -- Linha do app ainda não empurrada: não há gêmea possível.
  IF NEW.omie_pedido_id IS NULL THEN
    NEW.gemeo_importado_id := NULL;
    RETURN NEW;
  END IF;
  -- Serializa com o trigger da importada do MESMO pedido (write-back x importador). Quem chega
  -- depois vê o commit do outro: o SELECT abaixo roda com snapshot novo, depois do lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('sales_orders.gemeo:' || NEW.account || ':' || NEW.omie_pedido_id, 0));
  SELECT i.id INTO v_gemeo
    FROM public.sales_orders i
   WHERE i.account = NEW.account
     AND i.hash_payload LIKE 'omie\_%'
     AND i.hash_payload = 'omie_' || NEW.account || '_' || NEW.omie_pedido_id;
  NEW.gemeo_importado_id := v_gemeo;
  IF v_gemeo IS NOT NULL THEN
    NEW.order_date_kpi := NULL;
  ELSIF NEW.order_date_kpi IS NULL THEN
    -- ENVIO = a linha que não tinha pedido Omie e passa a ter (write-back), ou que já nasce com ele.
    -- O UPDATE do trigger da importada (que zera este kpi) não é envio: não re-deriva.
    IF TG_OP = 'INSERT' THEN
      v_envio := true;
    ELSE
      v_envio := OLD.omie_pedido_id IS NULL;
    END IF;
    -- Outra linha do MESMO pedido já com kpi: não deriva (o índice único barraria este write-back).
    IF v_envio AND NOT EXISTS (SELECT 1 FROM public.sales_orders o
                                WHERE o.account = NEW.account
                                  AND o.omie_pedido_id = NEW.omie_pedido_id
                                  AND o.order_date_kpi IS NOT NULL) THEN
      -- O dia de São Paulo do envio, nunca o de UTC (a prod roda com TimeZone=UTC).
      NEW.order_date_kpi := (public.sales_orders_instante_envio() AT TIME ZONE 'America/Sao_Paulo')::date;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sales_orders_instante_envio()    FROM PUBLIC, anon, authenticated;
-- redundante sob CREATE OR REPLACE (preserva o ACL da 20261001100001); fica como contrato
REVOKE ALL ON FUNCTION public.sales_orders_gemeo_app_derivar() FROM PUBLIC, anon, authenticated;

-- ── POS: invariantes dos gemeos + objetos + ACL medido + identidade dos corpos ─────────────────
DO $post$
DECLARE
  v_dup        bigint;
  v_sem_ptr    bigint;
  v_ptr_errado bigint;
  v_ptr_kpi    bigint;
  v_obj        int;
  v_acl        int;
  v_md5_der    text;
  v_md5_ins    text;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT 1 FROM public.sales_orders
     WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL
     GROUP BY account, omie_pedido_id HAVING count(*) > 1) d;
  SELECT count(*) INTO v_sem_ptr
    FROM public.sales_orders a
    JOIN public.sales_orders i
      ON i.account = a.account AND i.hash_payload LIKE 'omie\_%'
     AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id
   WHERE a.hash_payload IS NULL AND a.omie_pedido_id IS NOT NULL
     AND a.gemeo_importado_id IS DISTINCT FROM i.id;
  SELECT count(*) INTO v_ptr_errado
    FROM public.sales_orders a
   WHERE a.gemeo_importado_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.sales_orders i
                      WHERE i.id = a.gemeo_importado_id AND i.account = a.account
                        AND i.omie_pedido_id = a.omie_pedido_id AND i.hash_payload LIKE 'omie\_%');
  SELECT count(*) INTO v_ptr_kpi
    FROM public.sales_orders WHERE gemeo_importado_id IS NOT NULL AND order_date_kpi IS NOT NULL;
  SELECT (SELECT count(*) FROM pg_trigger
           WHERE tgrelid = 'public.sales_orders'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
             AND tgname IN ('trg_sales_orders_gemeo_app', 'trg_sales_orders_gemeo_importada_antes',
                            'trg_sales_orders_gemeo_importada_depois'))
       + (SELECT count(*) FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname IN ('uniq_sales_orders_kpi_por_pedido_omie', 'idx_sales_orders_app_pedido_omie',
                               'idx_sales_orders_gemeo_importado_id'))
       + (SELECT count(*) FROM pg_constraint
           WHERE conrelid = 'public.sales_orders'::regclass
             AND conname IN ('sales_orders_gemeo_e_recibo', 'sales_orders_importada_tem_data'))
    INTO v_obj;
  -- ACL medido, nao declarado: nenhuma role publica executa as 3 SECDEF dos gemeos nem a costura
  SELECT count(*) INTO v_acl
    FROM (VALUES ('public.sales_orders_gemeo_app_derivar()'), ('public.sales_orders_gemeo_importada_antes()'),
                 ('public.sales_orders_gemeo_importada_depois()'), ('public.sales_orders_instante_envio()')) AS f(sig),
         (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
   WHERE has_function_privilege(r.papel, f.sig, 'EXECUTE');
  IF v_dup <> 0 OR v_sem_ptr <> 0 OR v_ptr_errado <> 0 OR v_ptr_kpi <> 0 OR v_obj <> 8 OR v_acl <> 0 THEN
    RAISE EXCEPTION 'POS FALHOU kpi-no-envio: dup_kpi=% sem_ponteiro=% ponteiro_errado=% ponteiro_com_kpi=% objetos=%/8 acl_aberto=%',
      v_dup, v_sem_ptr, v_ptr_errado, v_ptr_kpi, v_obj, v_acl;
  END IF;

  SELECT md5(prosrc) INTO v_md5_der FROM pg_proc WHERE oid = 'public.sales_orders_gemeo_app_derivar()'::regprocedure;
  SELECT md5(prosrc) INTO v_md5_ins FROM pg_proc WHERE oid = 'public.sales_orders_instante_envio()'::regprocedure;
  IF v_md5_der IS DISTINCT FROM '__MD5_DERIVAR__' OR v_md5_ins IS DISTINCT FROM '__MD5_INSTANTE__' THEN
    RAISE EXCEPTION 'POS FALHOU kpi-no-envio md5: derivar=% instante=% (esperado __MD5_DERIVAR__ / __MD5_INSTANTE__)',
      v_md5_der, v_md5_ins;
  END IF;
END
$post$;
```

- [ ] **Step 4: gravar as constantes de md5 (os corpos já estão no arquivo; PRE e POS ficam fora deles)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && . /tmp/kpi-helpers.sh && MA=supabase/migrations/20261005220000_sales_orders_kpi_no_envio.sql && D="$(md5py "$MA" sales_orders_gemeo_app_derivar)" && I="$(md5py "$MA" sales_orders_instante_envio)" && sed -i '' -e "s/__MD5_DERIVAR__/$D/g" -e "s/__MD5_INSTANTE__/$I/g" "$MA" && echo "MD5_DERIVAR=$D MD5_INSTANTE=$I" && grep -c "__MD5_" "$MA"
```

Esperado: as duas constantes impressas (anotar para o Task 8) e `0` placeholders (o `grep -c` sai 1
quando conta 0 — é o esperado aqui).

- [ ] **Step 5: rodar a prova (controle, `LC_ALL=C`)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bash db/test-sales-orders-kpi-no-envio.sh > /tmp/kpi-a.log 2>&1; echo "exit=$?"; grep -E "^PASS=|❌" /tmp/kpi-a.log | head -20
```

Esperado: `exit=0` e `PASS=26  FAIL=0`. Se a POS acusar `md5`, o md5 python ≠ PG: confira o Step 4 (o
corpo vai do `AS $function$` ao `$function$;`, sem o `AS`).

- [ ] **Step 6: commitar (antes de falsificar)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && git add db/test-sales-orders-kpi-no-envio.sh supabase/migrations/20261005220000_sales_orders_kpi_no_envio.sql && git commit -q -m "$(cat <<'EOF'
feat(db): a linha do app ganha order_date_kpi no envio — o trigger deriva o dia de SP do write-back [money-path]

sales_orders_gemeo_app_derivar() passa a derivar o kpi quando a linha do app ganha o pedido Omie
(write-back ou INSERT com pid) sem gêmea, sem kpi explícito e sem outra linha do pedido com kpi. O
instante é o statement do write-back (sales_orders_instante_envio), no dia de São Paulo. Só no envio:
o UPDATE do trigger da importada não re-deriva, e a contagem segue 1×. Prova PG17 com 26 asserts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

- [ ] **Step 7: falsificar (`LC_ALL=C`)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bash db/test-sales-orders-kpi-no-envio.sh --falsificar > /tmp/kpi-a-f.log 2>&1; echo "exit=$?"; grep -E "controle|SABOTAGENS:|❌|falsificação" /tmp/kpi-a-f.log
```

Esperado: `exit=0`, `✅ controle VERDE (26 asserts)`, `SABOTAGENS: 11 vermelhas / 0 falhas`. Sabotagem
que não avermelhar o assert declarado = buraco no desenho: investigar e corrigir a migration ou o
assert (nunca a lista).

- [ ] **Step 8: o 2º idioma do servidor**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sales-orders-kpi-no-envio.sh > /tmp/kpi-a-pt.log 2>&1; echo "exit=$?"; grep "^PASS=" /tmp/kpi-a-pt.log; HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sales-orders-kpi-no-envio.sh --falsificar > /tmp/kpi-a-pt-f.log 2>&1; echo "exit=$?"; grep "SABOTAGENS:" /tmp/kpi-a-pt-f.log
```

Esperado: `exit=0` + `PASS=26  FAIL=0`; `exit=0` + `SABOTAGENS: 11 vermelhas / 0 falhas`.

- [ ] **Step 9: shellcheck**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bun run lint:shell > /tmp/sc.log 2>&1; echo "exit=$?"; grep -A3 "test-sales-orders-kpi-no-envio" /tmp/sc.log | head -20
```

Esperado: `exit=0`. Achado no arquivo novo → corrigir, re-rodar Steps 5–8 e commitar (`git commit -am`
com a mesma assinatura).

---

### Task 2: Migration B — o texto do sensor (+ prova)

**Files:**
- Create: `db/test-data-health-venda-empurrada-conta-pelo-app.sh`
- Create: `supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql`

**Interfaces:**
- Consumes: o compute da `20261005150000` (md5 de prod `5ae67f7eec50058c67589a58081b7c7e`), a cadeia da
  prova `db/test-data-health-vendas-empurradas.sh` (stubs, 5 migrations, fixture do wrapper). O texto
  cita a `20261005220000` (Task 1), só em comentário.
- Produces: novo corpo de `public._data_health_compute()`; constante `MD5_B` (anotar para o Task 8).

- [ ] **Step 1: materializar a prova**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && . /tmp/kpi-helpers.sh && materializar prova-b db/test-data-health-venda-empurrada-conta-pelo-app.sh && grep -l "PGPORT_TEST:-5621" db/*.sh; echo "exit=$?"
```

Esperado: só `db/test-data-health-venda-empurrada-conta-pelo-app.sh` usa a porta 5621.

<!-- arquivo: prova-b -->
```bash
#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — vendas_empurradas_sem_gemeo: o texto diz que a venda empurrada CONTA pela linha do app
# ║      bash db/test-data-health-venda-empurrada-conta-pelo-app.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-data-health-venda-empurrada-conta-pelo-app.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-venda-empurrada-conta-pelo-app.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Sobre a cadeia REAL do data health (a de db/test-data-health-vendas-empurradas.sh, com a v2 aplicada
# ║  = a prod de hoje) e a migration REAL desta entrega (*_data_health_venda_empurrada_conta_pelo_app.sql):
# ║   · o corpo é o da v2 com EXATAMENTE as 2 trocas de texto (desfeitas, dão o md5 de prod da v2);
# ║   · numa órfã, o probable_cause diz que a venda conta pela linha do app, e o resto da linha do sensor
# ║     é idêntico ao da v2 (a detecção não muda);
# ║   · em clones: a PRE recusa corpo desconhecido, a POS tem dente, o REVOKE fecha um ACL aberto;
# ║   · reaplicar = no-op.
# ║  Spec: docs/superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md (5.4, 6)
# ╚═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5621}"
SLUG="venda-empurrada-conta-pelo-app"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar — o laço de db/test-gemeos-push-pull-contagem-unica.sh, verbatim no método: controle
# VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e cada sabotagem só conta se
# (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle), (3) CADA assert declarado
# estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o controle não tem.
# docs/historico/falsificacao-exit-nao-e-dente.md
# ════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="troca_extra:A3 pre_sem_identidade:A6 pos_sem_dente:A7 sem_revoke:A8"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha sozinha aprovaria"
    echo "     todas as sabotagens por vermelhidão constante, não por dente)."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pd() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
-- O mesmo de db/test-data-health-vendas-empurradas.sh: auth.uid() lê test.uid e, sem ele, o `sub` de
-- request.jwt.claims (a POS da v2, aplicada no setup, simula uma sessão logada sem papel); papéis e
-- carteira como o wrapper get_data_health() da prod os chama.
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('test.uid', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$f$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT public.has_role(_user_id, 'master') $f$;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, "w").write(s.replace(de, para))
PYSAB
}
md5_corpo() {  # $1 = arquivo → md5 do prosrc do _data_health_compute definido nele (o mesmo md5(prosrc) do PG)
  python3 - "$1" <<'PY'
import hashlib, sys
s = open(sys.argv[1], encoding='utf-8').read()
i = s.index('CREATE OR REPLACE FUNCTION public._data_health_compute(')
a = s.index('AS $function$', i) + len('AS $function$')
b = s.index('$function$;', a)
print(hashlib.md5(s[a:b].encode('utf-8')).hexdigest())
PY
}

# A cadeia REAL que a prod executou até a v2 (a mesma de db/test-data-health-vendas-empurradas.sh).
MIG_TRIO="$REPO_ROOT/supabase/migrations/20261001011500_data_health_vendas_empurradas_sem_gemeo.sql"
MIGS=(
  "$REPO_ROOT/supabase/migrations/20260918200000_data_health_sync_reprocess_saude.sql"
  "$REPO_ROOT/supabase/migrations/20260920210000_sync_reprocess_retry_nao_liquida_erro.sql"
  "$REPO_ROOT/supabase/migrations/20260920233000_sync_reprocess_degradado_so_das_vigiadas.sql"
  "$REPO_ROOT/supabase/migrations/20260922225500_data_health_portal_humano_critico_apos_24h.sql"
  "$MIG_TRIO"
)
MIG_V2="$REPO_ROOT/supabase/migrations/20261005150000_data_health_vendas_empurradas_v2.sql"
WRAPPER_PROD="$REPO_ROOT/db/fixtures/get-data-health-predecessora-prod-20261005.sql"
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_data_health_venda_empurrada_conta_pelo_app.sql" | sort | tail -1)"
for m in "${MIGS[@]}" "$MIG_V2" "$WRAPPER_PROD" "$MIG"; do
  [ -n "$m" ] && [ -f "$m" ] || { echo "❌ arquivo ausente: [$m] — a prova testaria o NADA"; exit 1; }
done

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC ═══"
P -q -f "$REPO_ROOT/db/stubs-data-health-trio.sql"
# ACL do compute como em PROD (só postgres/service_role), ANTES da cadeia: CREATE OR REPLACE preserva.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint,
               freshness_basis text, message text, last_error text, probable_cause text,
               how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $stub$ SELECT NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bigint, NULL::text,
                 NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $stub$;
REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._data_health_compute() TO service_role;
SQL
for m in "${MIGS[@]}"; do P -q -1 -f "$m" >/dev/null; done
P -q -1 -f "$WRAPPER_PROD" >/dev/null
P -q -1 -f "$MIG_V2" >/dev/null
# UMA órfã: linha do app empurrada há 10 dias, sem gêmeo (a forma do _semear_venda da prova da v2).
# Semeada ANTES do molde: prove (B) e molde (v2) leem os MESMOS dados — o A5 compara as duas linhas.
P -q <<'SQL'
INSERT INTO public.sales_orders (id, account, omie_pedido_id, omie_numero_pedido, omie_payload, hash_payload,
                                 status, total, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'oben', 900000000001, '000000000000001',
        jsonb_build_object('cabecalho', jsonb_build_object('data_previsao',
          to_char((now() - interval '10 days') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY'))),
        NULL, 'enviado', 100, now() - interval '10 days', now() - interval '10 days');
SQL
# MOLDE = a prod de hoje (v2 viva) + a órfã, SEM esta migration: os clones do A6–A8 partem daqui.
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T prove molde

MD5_V2="5ae67f7eec50058c67589a58081b7c7e"   # o compute de PROD hoje (= o "depois" da v2)
MD5_B="__MD5_B__"                           # o desta versão (Task 2, Step 4)
# As 2 trocas, texto EXATO (velho = o da v2; novo = o desta migration).
cat > "$TMP/velho1.txt" <<'TXT'
    -- omie_pedido_id) so entra na positivacao quando o importador traz o GEMEO: outra linha, mesma
    -- (account, omie_pedido_id), omie_payload nulo, com order_date_kpi. Ao vivo e congelado contam SO o
    -- kpi, que a linha do app criada desde 25/05 nao tem. O importador pode PULAR um pedido e isso so
TXT
cat > "$TMP/novo1.txt" <<'TXT'
    -- omie_pedido_id) ganha order_date_kpi NO ENVIO (20261005220000: o trigger da linha do app deriva
    -- o dia de SP do write-back) e conta pela linha do app ate o importador trazer o GEMEO: outra
    -- linha, mesma (account, omie_pedido_id), omie_payload nulo, com order_date_kpi, que entao vira a
    -- venda. O importador pode PULAR um pedido e isso so
TXT
cat > "$TMP/velho2.txt" <<'TXT'
                || 'Omie. Enquanto o gemeo nao chega a venda fica fora da positivacao ao vivo E do mes '
                || 'congelado: os dois contam so order_date_kpi, que a linha do app criada desde 25/05 nao tem.' END,
TXT
cat > "$TMP/novo2.txt" <<'TXT'
                || 'Omie. Enquanto o gemeo nao chega a venda conta pela linha do app (valor e cliente do app, '
                || 'sem a confirmacao do Omie), na positivacao ao vivo e no congelado se o mes fechar assim; '
                || 'cancelada no Omie, ela segue contando ate a linha do app ser marcada cancelado.' END,
TXT

# ════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM — sobre CÓPIAS da migration; o repo nunca é tocado. troca_extra troca o arquivo usado pela
# suíte inteira; as outras três, as cópias dos clones (A6–A8).
# ════════════════════════════════════════════════════════════════════════════════════════════════
MIG_USADA="$MIG"
case "${SABOTAGEM:-}" in
  "") ;;
  troca_extra)
    cp "$MIG" "$TMP/mig-b.sql"
    trocar "$TMP/mig-b.sql" "interval '6 days'" "interval '7 days'" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o limiar do broken não ocorre exatamente 1×"; exit 9; }
    # o erro que SÓ o A3 pega: uma troca a mais com o md5 recalculado (PRE e POS aceitam o corpo errado)
    novo_md5="$(md5_corpo "$TMP/mig-b.sql")"
    python3 - "$TMP/mig-b.sql" "$MD5_B" "$novo_md5" <<'PY'
import sys
p, de, para = sys.argv[1:4]
s = open(p, encoding='utf-8').read()
open(p, 'w', encoding='utf-8').write(s.replace(de, para))
PY
    MIG_USADA="$TMP/mig-b.sql"
    echo "⚠️  SABOTAGEM ATIVA em corpo de B (limiar do broken 6 → 7 dias, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  pre_sem_identidade|pos_sem_dente|sem_revoke) ;;   # nos clones (A6–A8)
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac

md5_vivo() { Pd "$1" -tA -c "SELECT md5(prosrc) || '|' || array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;"; }
ler_sensor() { Pd "$1" -tA -c "SELECT $2 FROM public._data_health_compute() WHERE source = 'vendas_empurradas_sem_gemeo';"; }

echo "═══ migration desta entrega: $(basename "$MIG") ═══"
eq "A1 a migration aplica sobre a v2 e a postcondição passa" "$(P -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && echo OK || echo FALHOU)" "OK"
eq "A2 o corpo vivo é o desta versão (md5 do PG = md5 do arquivo) e o search_path é o de prod" \
   "$(md5_vivo prove)|$(md5_corpo "$MIG")" "$MD5_B|search_path=public, pg_temp|$MD5_B"
r3="$(python3 - "$MIG_USADA" "$MD5_V2" "$TMP" <<'PY'
import hashlib, sys
p, md5_v2, tmp = sys.argv[1:4]
s = open(p, encoding='utf-8').read()
i = s.index('CREATE OR REPLACE FUNCTION public._data_health_compute(')
a = s.index('AS $function$', i) + len('AS $function$')
b = s.index('$function$;', a)
corpo = s[a:b]
for n in ('1', '2'):
    velho = open(f'{tmp}/velho{n}.txt', encoding='utf-8').read()
    novo = open(f'{tmp}/novo{n}.txt', encoding='utf-8').read()
    if corpo.count(novo) != 1 or corpo.count(velho) != 0:
        print(f'troca{n}:novo={corpo.count(novo)},velho={corpo.count(velho)}')
        sys.exit(0)
    corpo = corpo.replace(novo, velho)
d = hashlib.md5(corpo.encode('utf-8')).hexdigest()
print('igual' if d == md5_v2 else 'difere:' + d)
PY
)" || r3="ERRO_PY"
eq "A3 desfazer as 2 trocas devolve o corpo de PROD da v2 (5ae67f7e…): nada além delas mudou" \
   "$(md5_corpo "$MIG_V2")|$r3" "$MD5_V2|igual"
eq "A4 numa órfã, o probable_cause diz que a venda CONTA pela linha do app (o texto velho saiu)" \
   "$(ler_sensor prove "(status <> 'ok')::text || '|' || (probable_cause LIKE '%conta pela linha do app%')::text || '|' || (probable_cause LIKE '%fica fora da positivacao%')::text")" \
   "true|true|false"
LINHA="md5(concat_ws('|', source, domain, status, expected_max_age_seconds, freshness_basis, message, last_error, how_to_fix, severity))"
eq "A5 o resto da linha do sensor (status, message, last_error, how_to_fix…) é idêntico ao da v2 para a mesma órfã" \
   "$([ "$(ler_sensor prove "$LINHA")" = "$(ler_sensor molde "$LINHA")" ] && echo igual || echo difere)" "igual"

echo "═══ em clones da prod de hoje (molde): PRE, POS, ACL ═══"
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pre
awk 'index($0,"CREATE OR REPLACE FUNCTION public._data_health_compute(")==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$MIG_V2" > "$TMP/estranho.sql"
trocar "$TMP/estranho.sql" "  WITH checks AS (" "  WITH checks AS ( -- corpo estranho" \
  || { echo "❌ o início do corpo da v2 mudou de forma — o A6 não monta o caso"; exit 1; }
Pd pre -q -f "$TMP/estranho.sql" >/dev/null
estranho="$(md5_vivo pre)"
cp "$MIG_USADA" "$TMP/mig-pre.sql"
if [ "${SABOTAGEM:-}" = "pre_sem_identidade" ]; then
  trocar "$TMP/mig-pre.sql" "  IF v_md5 <> '5ae67f7eec50058c67589a58081b7c7e'" "  IF false AND v_md5 <> '5ae67f7eec50058c67589a58081b7c7e'" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na PRE"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PRE (sem a identidade do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out6="$(Pd pre -q -1 -f "$TMP/mig-pre.sql" 2>&1 || true)"
case "$out6" in
  *"PRE FALHOU"*) r6="recusou" ;;
  *"POS OK"*) r6="aplicou" ;;
  *) r6="erro:$(printf '%s\n' "$out6" | sqlstate)" ;;
esac
eq "A6 a PRE recusa um corpo vivo desconhecido e não o sobrescreve" "$r6|$(md5_vivo pre)" "recusou|$estranho"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pos
cp "$MIG_USADA" "$TMP/mig-pos.sql"
trocar "$TMP/mig-pos.sql" "  WITH checks AS (" "  WITH checks AS ( -- corpo que nao e o desta versao" \
  || { echo "❌ o início do corpo mudou de forma — o A7 não monta o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_sem_dente" ]; then
  trocar "$TMP/mig-pos.sql" "  IF v_md5 IS DISTINCT FROM '" "  IF false AND v_md5 IS DISTINCT FROM '" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na POS"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em POS (sem o md5 do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out7="$(Pd pos -q -1 -f "$TMP/mig-pos.sql" 2>&1 || true)"
case "$out7" in
  *"POSTCONDICAO FALHOU md5"*) r7="recusou:md5" ;;
  *"POSTCONDICAO FALHOU"*) r7="recusou:outro_motivo" ;;
  *"POS OK"*) r7="aplicou" ;;
  *) r7="erro:$(printf '%s\n' "$out7" | sqlstate)" ;;
esac
eq "A7 a POS recusa um corpo que não é o desta versão (md5)" "$r7" "recusou:md5"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde acl
Pd acl -q -c "GRANT EXECUTE ON FUNCTION public._data_health_compute() TO PUBLIC, anon, authenticated;"
cp "$MIG_USADA" "$TMP/mig-acl.sql"
if [ "${SABOTAGEM:-}" = "sem_revoke" ]; then
  trocar "$TMP/mig-acl.sql" "REVOKE EXECUTE ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;" "" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o REVOKE não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em REVOKE do compute — a suíte abaixo DEVE ficar vermelha"
fi
r8="$(Pd acl -q -1 -f "$TMP/mig-acl.sql" >/dev/null 2>&1 && echo OK || echo FALHOU)"
vaz8="$(Pd acl -tA -c "SELECT count(*) FROM (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
                         WHERE has_function_privilege(r.papel, 'public._data_health_compute()', 'EXECUTE');")"
eq "A8 com o EXECUTE aberto (deriva de ACL), aplicar a migration o fecha para PUBLIC/anon/authenticated" "$r8|$vaz8" "OK|0"

antes9="$(md5_vivo prove)"
r9="$(P -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && echo OK || echo FALHOU)"
eq "A9 reaplicar é no-op (a PRE aceita esta versão; o corpo não muda)" \
   "$r9|$([ "$(md5_vivo prove)" = "$antes9" ] && echo igual || echo mudou)" "OK|igual"

echo
echo "PASS=${PASS}  FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 2: rodar e ver falhar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bash db/test-data-health-venda-empurrada-conta-pelo-app.sh > /tmp/kpi-b.log 2>&1; echo "exit=$?"; grep -m1 "arquivo ausente" /tmp/kpi-b.log
```

Esperado: `exit=1` e `❌ arquivo ausente: [] — a prova testaria o NADA`.

- [ ] **Step 3: gerar a Migration B (cabeçalho + compute da v2 com as 2 trocas + rodapé)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && . /tmp/kpi-helpers.sh && S="$(mktemp -d)" && M2=supabase/migrations/20261005150000_data_health_vendas_empurradas_v2.sql && MB=supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql \
 && awk '/^cat > "\$TMP\/velho1.txt"/{f=1} f' db/test-data-health-venda-empurrada-conta-pelo-app.sh | awk '/^TXT$/{n++} {print} n==4{exit}' | sed 's#\$TMP#'"$S"'#' > "$S/textos.sh" && bash "$S/textos.sh" \
 && materializar migration-b-cabecalho "$MB" \
 && awk 'index($0,"CREATE OR REPLACE FUNCTION public._data_health_compute(")==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$M2" > "$S/compute-v2.sql" \
 && python3 - "$S" <<'PY' && cat "$S/compute-b.sql" >> "$MB" && materializar migration-b-rodape "$S/rodape.sql" && cat "$S/rodape.sql" >> "$MB" && wc -l "$MB"; echo "exit=$?"
import sys
d = sys.argv[1]
c = open(f'{d}/compute-v2.sql', encoding='utf-8').read()
for n in ('1', '2'):
    v = open(f'{d}/velho{n}.txt', encoding='utf-8').read()
    w = open(f'{d}/novo{n}.txt', encoding='utf-8').read()
    assert c.count(v) == 1, f'troca {n}: o texto velho ocorre {c.count(v)}x na v2'
    c = c.replace(v, w)
open(f'{d}/compute-b.sql', 'w', encoding='utf-8').write('\n' + c + '\n')
PY
```

Esperado: `exit=0` e ~1.420 linhas. (Os 4 textos vêm da PRÓPRIA prova — uma fonte só; o `awk` corta
no 4º `TXT` de fechamento — a linha de abertura termina em `<<'TXT'` e não casa `^TXT$`.) Conferir à mão: `grep -c "conta pela linha do app" "$MB"` = 1 e
`grep -c "fica fora da positivacao" "$MB"` = 0.

<!-- arquivo: migration-b-cabecalho -->
```sql
-- ============================================================================================
-- vendas_empurradas_sem_gemeo: o texto diz que a venda empurrada CONTA pela linha do app
-- ============================================================================================
-- Depois de 20261005220000 (o trigger da linha do app deriva order_date_kpi no envio), a venda
-- empurrada conta pela linha do app enquanto o gemeo nao chega. O probable_cause do sensor e o
-- comentario do bloco diziam o contrario ("fica fora da positivacao"). Esta migration e o corpo da
-- 20261005150000 (v2) com EXATAMENTE essas 2 trocas de texto - a deteccao nao muda (a prova exige
-- que desfazer as 2 trocas devolva o md5 de prod da v2). get_data_health, data_health_watchdog e
-- fin_sync_heartbeat NAO mudam (o probable_cause nao entra no fingerprint do watchdog).
--
-- Corpo de partida = o de PROD, conferido em 2026-10-05 (md5 do prosrc):
--   _data_health_compute  5ae67f7eec50058c67589a58081b7c7e = 20261005150000
-- Spec: docs/superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md (5.4)
-- Aplicacao: `bun run db:aplicar` (o EXECUTOR fornece a transacao - por isso nao ha BEGIN/COMMIT aqui).
-- Prova: db/test-data-health-venda-empurrada-conta-pelo-app.sh (PG17, com --falsificar).
-- ============================================================================================

-- ── PRE: trava e identidade, ANTES de ler (idioma da 20261005150000) ─────────────────────────
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_temp;
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._data_health_compute()');
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public._data_health_compute() ausente depois da trava.';
  END IF;
  IF v_md5 <> '5ae67f7eec50058c67589a58081b7c7e' AND v_md5 <> '__MD5_B__' THEN
    RAISE EXCEPTION 'PRE FALHOU: public._data_health_compute() tem corpo md5 % - nem o predecessor '
                    '(5ae67f7eec50058c67589a58081b7c7e) nem esta versao (__MD5_B__). Outro aplicador recriou '
                    'a funcao depois do pre-voo; este apply o REVERTERIA. Remonte a migration sobre o '
                    'pg_get_functiondef vivo.', v_md5;
  END IF;
END
$pre$;
```

<!-- arquivo: migration-b-rodape -->
```sql
REVOKE EXECUTE ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;

-- ── POS: o sensor responde, os 31 sources seguem unicos, ACL medido, identidade do corpo ──────────
DO $post$
DECLARE
  v_n      int;
  v_ndist  int;
  v_status text;
  v_sev    text;
  v_vazado int;
  v_md5    text;
BEGIN
  SELECT count(*), max(status), max(severity) INTO v_n, v_status, v_sev
    FROM public._data_health_compute() WHERE source = 'vendas_empurradas_sem_gemeo';
  IF v_n <> 1 OR v_status NOT IN ('ok','stale','broken') OR v_sev IS DISTINCT FROM 'warning' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: vendas_empurradas_sem_gemeo com % linha(s), status % e severity % '
                    '(esperado 1, ok|stale|broken e warning).', v_n, COALESCE(v_status, '<NULL>'), COALESCE(v_sev, '<NULL>');
  END IF;

  SELECT count(*), count(DISTINCT source) INTO v_n, v_ndist FROM public._data_health_compute();
  IF v_n <> v_ndist OR v_ndist <> 31 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: o compute devolveu % linhas para % sources (esperado 31/31).', v_n, v_ndist;
  END IF;

  SELECT count(*) INTO v_vazado
    FROM (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
   WHERE has_function_privilege(r.papel, 'public._data_health_compute()', 'EXECUTE');
  IF v_vazado <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: _data_health_compute() executavel por % papel(eis) publico(s).', v_vazado;
  END IF;

  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public._data_health_compute()');
  IF v_md5 IS DISTINCT FROM '__MD5_B__' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU md5: public._data_health_compute() com md5 % (esperado __MD5_B__).',
                    COALESCE(v_md5, '<ausente>');
  END IF;
  IF (SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure)
       IS DISTINCT FROM 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: public._data_health_compute() com search_path fora do medido em prod.';
  END IF;

  RAISE NOTICE 'POS OK: 31 sources; vendas_empurradas_sem_gemeo=%', v_status;
END
$post$;
```

- [ ] **Step 4: gravar `MD5_B` na migration e na prova**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && . /tmp/kpi-helpers.sh && MB=supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql && B="$(md5py "$MB" _data_health_compute)" && sed -i '' "s/__MD5_B__/$B/g" "$MB" db/test-data-health-venda-empurrada-conta-pelo-app.sh && echo "MD5_B=$B" && grep -c "__MD5_B__" "$MB" db/test-data-health-venda-empurrada-conta-pelo-app.sh
```

Esperado: `MD5_B=` impresso (anotar) e `:0` nos dois arquivos.

- [ ] **Step 5: rodar a prova (controle)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bash db/test-data-health-venda-empurrada-conta-pelo-app.sh > /tmp/kpi-b.log 2>&1; echo "exit=$?"; grep -E "^PASS=|❌" /tmp/kpi-b.log | head -12
```

Esperado: `exit=0` e `PASS=9  FAIL=0`. Se o A4 vier `false|…` no status, a órfã não foi detectada no
harness: comparar com o `_semear_venda` de `db/test-data-health-vendas-empurradas.sh` (colunas e
`data_previsao`) antes de mexer em qualquer outra coisa.

- [ ] **Step 6: commitar, falsificar nos 2 idiomas, shellcheck**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && git add db/test-data-health-venda-empurrada-conta-pelo-app.sh supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql && git commit -q -m "$(cat <<'EOF'
fix(data-health): o sensor de venda empurrada diz que ela conta pela linha do app [money-path]

Depois do kpi no envio, o probable_cause de vendas_empurradas_sem_gemeo (e o comentário do bloco)
diziam que a venda ficava fora da positivação. Corpo = v2 com exatamente essas 2 trocas (desfeitas,
dão o md5 de prod da v2); a detecção não muda. Prova PG17 com 9 asserts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)" && bash db/test-data-health-venda-empurrada-conta-pelo-app.sh --falsificar > /tmp/kpi-b-f.log 2>&1; echo "exit=$?"; grep -E "controle|SABOTAGENS:" /tmp/kpi-b-f.log; HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-venda-empurrada-conta-pelo-app.sh > /tmp/kpi-b-pt.log 2>&1; echo "exit=$?"; grep "^PASS=" /tmp/kpi-b-pt.log; HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-venda-empurrada-conta-pelo-app.sh --falsificar > /tmp/kpi-b-pt-f.log 2>&1; echo "exit=$?"; grep "SABOTAGENS:" /tmp/kpi-b-pt-f.log; bun run lint:shell > /tmp/sc.log 2>&1; echo "shellcheck exit=$?"
```

Esperado: os quatro `exit=0`; `controle VERDE (9 asserts)`; `SABOTAGENS: 4 vermelhas / 0 falhas` duas
vezes; `PASS=9  FAIL=0`; `shellcheck exit=0`.

---

### Task 3: Ranking — a linha do app vai para "Sem vendedor atribuído"

**Files:**
- Modify: `src/lib/dashboard/team-kpis.ts:59-109`
- Modify: `src/lib/dashboard/fetch-pedidos-mtd.ts:5-10,28,43`
- Modify: `src/hooks/useTeamRanking.ts:49-52`
- Test: `src/lib/dashboard/__tests__/team-kpis.test.ts`

**Interfaces:**
- Produces: `OrderRankRow.hash_payload: string | null` e `PedidoMTDRow.hash_payload: string | null`
  (obrigatórios: o compilador acusa quem não os passar). `montarRanking` mantém a assinatura.

- [ ] **Step 1: escrever os testes (falhando)**

Em `src/lib/dashboard/__tests__/team-kpis.test.ts`, no teste
`'montarRanking: atribui por created_by, …'`, troque as linhas do array `orders` por (a semântica do
teste não muda — todas são importadas):

```ts
    const orders: OrderRankRow[] = [
      { total: 1000, status: 'faturado', created_by: 'A', hash_payload: 'omie_oben_1' },
      { total: 500, status: 'enviado', created_by: 'A', hash_payload: 'omie_oben_2' },
      { total: 9999, status: 'cancelado', created_by: 'A', hash_payload: 'omie_oben_3' }, // inválido → ignorado
      { total: 300, status: 'faturado', created_by: 'B', hash_payload: 'omie_colacor_4' },
      { total: 200, status: 'faturado', created_by: 'X', hash_payload: 'omie_oben_5' }, // X não é vendedor → não atribuído
      { total: 150, status: 'faturado', created_by: null, hash_payload: 'omie_oben_6' }, // sem autor → não atribuído
    ];
```

e acrescente, depois do teste `'montarRanking: vazio → …'`:

```ts
  it('montarRanking: a linha do APP (hash nulo) e o hash próprio contam no total como não atribuído — só a importada credita o vendedor', () => {
    const orders: OrderRankRow[] = [
      { total: 700, status: 'enviado', created_by: 'A', hash_payload: null }, // venda empurrada; a importada ainda não chegou
      { total: 300, status: 'faturado', created_by: 'A', hash_payload: 'omie_oben_501' }, // a importada → Ana
      { total: 50, status: 'enviado', created_by: 'B', hash_payload: 'checkout_x1' }, // hash próprio, não omie_
    ];
    const r = montarRanking(orders, new Map([['A', 'Ana'], ['B', 'Bia']]));
    expect(r.ranking).toEqual([{ id: 'A', nome: 'Ana', receita: 300, pedidos: 1 }]);
    expect(r.naoAtribuido).toEqual({ receita: 750, pedidos: 2 });
    expect(r.semAtividade).toBe(1); // Bia: a única venda dela é de hash próprio
  });

  it('montarRanking: o total do card (Σ ranking + não atribuído) é a receita MTD das mesmas linhas', () => {
    const linhas = [
      { total: 700, status: 'enviado', created_by: 'A', hash_payload: null, order_date_kpi: '2026-10-05' },
      { total: 300, status: 'faturado', created_by: 'A', hash_payload: 'omie_oben_501', order_date_kpi: '2026-10-02' },
      { total: 120, status: 'importado', created_by: 'X', hash_payload: 'omie_oben_502', order_date_kpi: '2026-10-03' },
      { total: 999, status: 'rascunho', created_by: 'A', hash_payload: null, order_date_kpi: '2026-10-04' }, // fora do universo
    ];
    const r = montarRanking(linhas, new Map([['A', 'Ana']]));
    const totalCard = r.ranking.reduce((s, v) => s + v.receita, 0) + r.naoAtribuido.receita;
    expect(totalCard).toBe(somarReceita(linhas, '2026-10-01', '2026-11-01'));
    expect(totalCard).toBe(1120);
  });
```

(`somarReceita` e `OrderRankRow` já são importados no topo do arquivo; confira com
`grep -n "somarReceita\|OrderRankRow" src/lib/dashboard/__tests__/team-kpis.test.ts | head -3`.)

- [ ] **Step 2: ver falhar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && heavy bun run test src/lib/dashboard/__tests__/team-kpis.test.ts > /tmp/tk.log 2>&1; echo "exit=$?"; grep -E "✓|×|FAIL|Tests " /tmp/tk.log | head -12
```

Esperado: `exit=1`; falha `a linha do APP (hash nulo)…` (hoje a Ana recebe 1.000); o de invariante passa
(ele vale antes e depois — é a guarda contra perder a linha do app do total).

- [ ] **Step 3: implementar**

`src/lib/dashboard/team-kpis.ts` — `OrderRankRow`, o doc de `naoAtribuido`, o doc e o laço de
`montarRanking`:

```ts
export interface OrderRankRow {
  total: number | null;
  status: string | null;
  created_by: string | null;
  /** Proveniência: a linha IMPORTADA do Omie carrega `omie_<conta>_<pedido>`; a do app, nulo (ou próprio). */
  hash_payload: string | null;
}
```

```ts
  /**
   * Pedidos válidos sem vendedor atribuído: created_by NULL ou não-vendedor, OU linha do app (venda
   * empurrada cuja importada ainda não chegou). Conta no total, fora do ranking.
   */
  naoAtribuido: { receita: number; pedidos: number };
```

```ts
/**
 * Ranking de vendedores por receita de pedidos válidos, ATRIBUÍDO por `created_by` — só na linha
 * IMPORTADA do Omie (`hash_payload` `omie_…`). A linha do APP é a venda enquanto a importada não chega
 * (o trigger deriva o kpi no envio) e conta no total, mas vai para "não atribuído": quando a importada
 * chega, a venda passa a ser ela, e creditar o app faria a venda pular de vendedor (spec 2026-10-05, D1).
 * `vendedores` = Map<userId, nome> dos vendedores reais (commercial_role farmer/hunter/closer).
 * created_by fora desse set → "não atribuído". Ordena por receita desc. Não lista vendedor sem pedido
 * (entra em `semAtividade`).
 */
export function montarRanking(orders: OrderRankRow[], vendedores: Map<string, string>): RankingResult {
  const acc = new Map<string, { receita: number; pedidos: number }>();
  let naoR = 0;
  let naoP = 0;
  for (const o of orders) {
    if (!isPedidoValido(o.status)) continue;
    const v = o.total ?? 0;
    const importada = o.hash_payload?.startsWith('omie_') === true;
    if (importada && o.created_by && vendedores.has(o.created_by)) {
      const cur = acc.get(o.created_by) ?? { receita: 0, pedidos: 0 };
      cur.receita += v;
      cur.pedidos += 1;
      acc.set(o.created_by, cur);
    } else {
      naoR += v;
      naoP += 1;
    }
  }
```

(o resto da função não muda.)

`src/lib/dashboard/fetch-pedidos-mtd.ts`:

```ts
export interface PedidoMTDRow {
  total: number | null;
  status: string | null;
  created_by: string | null;
  order_date_kpi: string | null;
  /** Proveniência — o ranking só atribui a linha importada (`omie_…`). */
  hash_payload: string | null;
}
```

```ts
      .select('total, status, created_by, order_date_kpi, hash_payload')
```

```ts
    // Sem `as`: o tipo inferido do select tem de cobrir PedidoMTDRow — tirar uma coluna do select (ex.:
    // hash_payload, de que o ranking depende) vira erro de compilação, não `undefined` em runtime.
    const rows: PedidoMTDRow[] = data;
```

`src/hooks/useTeamRanking.ts:49-52`:

```ts
      return montarRanking(
        orders.map((o) => ({ total: o.total, status: o.status, created_by: o.created_by, hash_payload: o.hash_payload })),
        vendedores,
      );
```

- [ ] **Step 4: ver passar + typecheck + o gate do universo de pedidos**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && heavy bun run test src/lib/dashboard/__tests__/team-kpis.test.ts src/__tests__/universo-pedidos-ts-gate.test.ts > /tmp/tk.log 2>&1; echo "test exit=$?"; grep -E "Tests |FAIL" /tmp/tk.log; heavy bun run typecheck:app > /tmp/tc.log 2>&1; echo "typecheck exit=$?"; head -c 1500 /tmp/tc.log
```

Esperado: `test exit=0`, `typecheck exit=0`. Se o typecheck reclamar do `const rows: PedidoMTDRow[] =
data`, cole o erro: a solução é ajustar a interface ao tipo inferido (nunca voltar o `as`).

- [ ] **Step 5: commitar e falsificar (o select e o critério)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && git add src/lib/dashboard/team-kpis.ts src/lib/dashboard/fetch-pedidos-mtd.ts src/hooks/useTeamRanking.ts src/lib/dashboard/__tests__/team-kpis.test.ts && git commit -q -m "$(cat <<'EOF'
fix(ranking): a linha do app sem a importada conta no total e vai para "Sem vendedor atribuído" [money-path]

Com o kpi no envio, a linha do app entra no MTD enquanto a importada não chega. Creditá-la ao
created_by faria a venda pular de vendedor quando a importada chegasse (ela carrega o created_by do
LIMIT 1 do importador). montarRanking só atribui hash omie_; fetchPedidosMTD seleciona hash_payload e
perde o `as` (o compilador exige a coluna no select).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)" && sed -i '' "s/, order_date_kpi, hash_payload')/, order_date_kpi')/" src/lib/dashboard/fetch-pedidos-mtd.ts && { heavy bun run typecheck:app > /tmp/tc-f.log 2>&1; echo "typecheck SEM a coluna exit=$? (esperado ≠0)"; grep -m1 "hash_payload" /tmp/tc-f.log; } ; git checkout -- src/lib/dashboard/fetch-pedidos-mtd.ts && sed -i '' "s/    const importada = o.hash_payload?.startsWith('omie_') === true;/    const importada = true;/" src/lib/dashboard/team-kpis.ts && { heavy bun run test src/lib/dashboard/__tests__/team-kpis.test.ts > /tmp/tk-f.log 2>&1; echo "test SEM o critério exit=$? (esperado ≠0)"; } ; git checkout -- src/lib/dashboard/team-kpis.ts && git status --short
```

Esperado: as duas linhas `exit≠0` (a 1ª cita `hash_payload`), e `git status` limpo no fim. Se o
typecheck SEM a coluna sair `0`, a inferência do select não pegou: a guarda passa a ser um teste vitest
que lê `src/lib/dashboard/fetch-pedidos-mtd.ts` como texto e exige `hash_payload` dentro do `.select(`
(falsificado do mesmo jeito) — nunca ficar sem guarda.

---

### Task 4: `SalesQuotes` — converter não regrava `'rascunho'`

**Files:**
- Modify: `src/pages/SalesQuotes.tsx:197-205`
- Test: `src/pages/__tests__/SalesQuotes.accountGuard.test.tsx:6-11,121,135-137`

- [ ] **Step 1: mudar o teste (falhando)**

No cabeçalho (linhas 6–11), troque o trecho `e só marca 'rascunho' no SUCESSO (fail-closed do edge deixa
o orçamento intacto)` por `e, no SUCESSO, não regrava status nenhum: o 'enviado' que a edge grava tira a
linha da lista e mantém a venda no universo (spec 2026-10-05); o fail-closed do edge deixa o orçamento
intacto`. No teste da linha 121, troque o título por
`'destrava OBEN: envia ao edge SEM codigo_cliente (o edge deriva do documento) e, no sucesso, NÃO regrava o status'`
e as linhas 135–137 por:

```ts
    // Sucesso do edge → toast de sucesso e NENHUM update: o 'enviado' da edge é o estado final
    // (regravar 'rascunho' tirava a venda do universo canônico — spec 2026-10-05 §3.4).
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.updateSalesOrder).not.toHaveBeenCalled();
```

- [ ] **Step 2: ver falhar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && heavy bun run test src/pages/__tests__/SalesQuotes.accountGuard.test.tsx > /tmp/sq.log 2>&1; echo "exit=$?"; grep -E "×|Tests " /tmp/sq.log | head -6
```

Esperado: `exit=1`, falha no `not.toHaveBeenCalled()` (hoje o update com `{ status: 'rascunho' }` acontece).

- [ ] **Step 3: implementar** — em `src/pages/SalesQuotes.tsx`, troque as linhas 197–205:

```ts
      // Sucesso: marca como pedido (sai da lista de orçamentos). Só AQUI — falha do edge deixa o
      // orçamento intacto, sem status órfão.
      const { error: updateError } = await supabase
        .from('sales_orders')
        .update({ status: 'rascunho' })
        .eq('id', quote.id);
      if (updateError) throw updateError;
      queryClient.invalidateQueries({ queryKey: ['sales-quotes'] });
      toast.success('Orçamento convertido em pedido!');
```

por:

```ts
      // Sucesso: a edge já gravou 'enviado' + o pedido Omie na linha (e o trigger deriva o kpi no
      // envio) — ela sai da lista de orçamentos, que filtra 'orcamento', sem regravar nada. Regravar
      // 'rascunho' aqui tirava a venda do universo canônico (rascunho ∈ STATUS_NAO_VENDA).
      queryClient.invalidateQueries({ queryKey: ['sales-quotes'] });
      toast.success('Orçamento convertido em pedido!');
```

- [ ] **Step 4: ver passar (os dois testes do SalesQuotes) + lint**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && heavy bun run test src/pages/__tests__/SalesQuotes.accountGuard.test.tsx src/pages/__tests__/SalesQuotes.priceGuard.test.tsx > /tmp/sq.log 2>&1; echo "test exit=$?"; grep -E "Tests " /tmp/sq.log; bunx eslint src/pages/SalesQuotes.tsx src/pages/__tests__/SalesQuotes.accountGuard.test.tsx > /tmp/es.log 2>&1; echo "eslint exit=$?"; head -c 800 /tmp/es.log
```

Esperado: `test exit=0`, `eslint exit=0` (se o `supabase` virar import sem uso, o eslint acusa — ele
continua usado pela lista e pelo `functions.invoke`).

- [ ] **Step 5: commitar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && git add src/pages/SalesQuotes.tsx src/pages/__tests__/SalesQuotes.accountGuard.test.tsx && git commit -q -m "$(cat <<'EOF'
fix(orcamentos): converter não regrava 'rascunho' depois do envio — a venda fica no universo [money-path]

O update pós-sucesso regravava 'rascunho' por cima do 'enviado' da edge: rascunho está em
STATUS_NAO_VENDA, então a venda convertida sumia da receita até a importada chegar. A lista de
orçamentos já filtra 'orcamento'; o 'enviado' basta.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline -1
```

---

### Task 5: Registros, docs e verificação completa

**Files:**
- Modify: `db/nucleo-ci.txt` (depois da entrada `db/test-gemeos-push-pull-contagem-unica.sh`)
- Regerar: `scripts/audit-custom-migrations.sql`, `docs/migrations-audit.md`
- Create: `docs/historico/app-grava-kpi-no-envio.md`
- Modify: `docs/agent/database.md:281`, `docs/historico/gemeos-push-pull-contagem-unica.md`

- [ ] **Step 1: o núcleo do CI** — logo depois da linha
`db/test-gemeos-push-pull-contagem-unica.sh   37  falsificar=11`, inserir:

```text
# kpi no envio: o trigger da linha do app deriva order_date_kpi (dia de SP do statement do write-back)
# quando ela ganha o pedido Omie sem gêmeo — RPC real do importador, corrida nos 2 sentidos, costura do
# relógio, bordas de SP com o servidor em UTC, PRE/POS/ACL em clones. 11 sabotagens, uma camada por vez.
db/test-sales-orders-kpi-no-envio.sh   26  falsificar=11
# o texto do sensor vendas_empurradas_sem_gemeo depois do kpi no envio: corpo = v2 + exatamente 2 trocas
# (desfeitas, dão o md5 de prod da v2), probable_cause novo numa órfã, resto da linha igual ao da v2.
db/test-data-health-venda-empurrada-conta-pelo-app.sh   9  falsificar=4
```

- [ ] **Step 2: regerar o registro de migrations e rodar os fiscais**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bun run audit:migrations > /tmp/am.log 2>&1; echo "audit exit=$?"; git diff --stat -- scripts/audit-custom-migrations.sql docs/migrations-audit.md; bun scripts/falsificar-exige-assert-gate.ts > /tmp/fg.log 2>&1; echo "fiscal falsificar exit=$?"; tail -3 /tmp/fg.log; heavy bun run test scripts/audit-custom-migrations.test.ts scripts/falsificacao-cobertura.test.ts scripts/falsificar-exige-assert-gate.test.ts > /tmp/fx.log 2>&1; echo "vitest fiscais exit=$?"; grep -E "Tests |FAIL" /tmp/fx.log
```

Esperado: `audit exit=0` com o diff só nas 2 migrations novas (+ as funções que elas definem);
`fiscal falsificar exit=0`; `vitest fiscais exit=0`.

- [ ] **Step 3: o diário** — criar `docs/historico/app-grava-kpi-no-envio.md`:

```markdown
# A venda empurrada entra no universo canônico no ENVIO (kpi da linha do app)

> 2026-10-06 · money-path · spec [2026-10-05-app-grava-kpi-no-envio-design.md](../superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md)
> · plano [2026-10-05-app-grava-kpi-no-envio.md](../superpowers/plans/2026-10-05-app-grava-kpi-no-envio.md)
> · antecedente [gemeos-push-pull-contagem-unica.md](gemeos-push-pull-contagem-unica.md)

## O que mudou

- **`20261005220000_sales_orders_kpi_no_envio.sql`** — `sales_orders_gemeo_app_derivar()` deriva
  `order_date_kpi` = dia de SP de `sales_orders_instante_envio()` (= `statement_timestamp()`) quando a
  linha do app PASSA a ter `omie_pedido_id` (write-back) ou nasce com ele, sem gêmea, sem kpi explícito e
  sem outra linha do pedido com kpi. Nenhum escritor TS/edge grava kpi; a regra "kpi só no INSERT ou no
  MESMO UPDATE do write-back" vale por construção.
- **`20261005220100_data_health_venda_empurrada_conta_pelo_app.sql`** — o `probable_cause` de
  `vendas_empurradas_sem_gemeo` (e o comentário do bloco) dizem que a venda conta pela linha do app;
  corpo = v2 + 2 trocas (a detecção não muda).
- **Ranking (`montarRanking`)** — só a importada (`hash_payload` `omie_…`) credita `created_by`; a linha
  do app conta no total como "Sem vendedor atribuído".
- **`SalesQuotes.convertToOrder`** — não regrava `'rascunho'` depois do envio (o `'enviado'` da edge basta).

## Por que assim

- **O trigger deriva (D2, founder):** tira os escritores TS do caminho. Só no ENVIO, porque o UPDATE do
  trigger da importada que zera o kpi do app re-derivaria e o índice único barraria a importada (23505).
- **Ranking não atribuído (D1, founder):** a importada carrega o `created_by` do `LIMIT 1` do importador
  (100% das importadas de set+out numa farmer); creditar a linha do app faria a venda "migrar" quando a
  importada chegasse. A atribuição real é outra entrega.
- **`statement_timestamp()`:** a chegada do UPDATE do write-back; `now()` seria o início da transação,
  `clock_timestamp()` incluiria a espera de lock. A prod roda com `TimeZone=UTC`: `::date` puro erraria
  3 h por dia.

## Provas

- `db/test-sales-orders-kpi-no-envio.sh` — 26 asserts, 11 sabotagens (C e pt_BR).
- `db/test-data-health-venda-empurrada-conta-pelo-app.sh` — 9 asserts, 4 sabotagens (C e pt_BR).
- vitest: `team-kpis.test.ts` (app → não atribuído; total do card = receita) e
  `SalesQuotes.accountGuard.test.tsx` (sucesso sem update); o select do MTD é checado pelo compilador.

## Limites conhecidos

- **Órfã conta pelo app** (venda que nunca volta: cancelada/excluída direto no Omie, cliente não resolvido)
  até alguém marcar a linha do app — a defesa é o sensor (stale em 6 h, broken em 6 dias).
- **Valor da janela:** até a importada chegar conta o `total` do app (5/22 pares divergiam, até R$ 640,90).
- **Meia-noite:** envio que cruza a meia-noite de SP entre o `IncluirPedido` e o write-back dá ao app o
  dia seguinte ao dInc; o import corrige.
- **DELETE de importada** deixa a linha do app sem kpi até o reimport (nenhum caminho de prod apaga).
- **Empurrada antes do apply** não ganha kpi (havia 0); **linha com hash próprio** (não `omie_`) não é
  observada pelo trigger (havia 0).
- **Bundle velho:** o `SalesQuotes` antigo segue regravando `'rascunho'` (a venda volta pela importada);
  o ranking antigo creditaria a linha do app — por isso Publish antes do apply.

## Deploy

Ordem: Publish do front (founder) → o cliente do founder atualizado → apply A (`--ensaio`, real) →
validação por fora (`psql-ro`) → apply B → validação. Status: **pendente** (o Task 8 do plano registra
datas, recibos do ledger `db_aplicacoes` e as consultas de validação aqui).

## Quando medir (o 1º envio real depois do apply)

    ~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -tA -c "SELECT id, created_at, order_date_kpi,
      (updated_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia_sp_do_envio, gemeo_importado_id IS NOT NULL AS tem_gemeo
      FROM public.sales_orders WHERE hash_payload IS NULL AND omie_pedido_id IS NOT NULL
       AND updated_at > '<instante do apply A>' ORDER BY updated_at DESC LIMIT 5;" -c "SELECT 'FIM-OK';"

Esperado: `order_date_kpi` = `dia_sp_do_envio` enquanto `tem_gemeo` = f; kpi nulo depois que a importada
chega (`tem_gemeo` = t).
```

- [ ] **Step 4: o bullet do `database.md` e o ponteiro no histórico dos gêmeos**

Em `docs/agent/database.md:281`, troque a frase `⇒ o app PODE gravar kpi, desde que **no INSERT ou no
MESMO UPDATE do write-back que seta o pid** — qualquer UPDATE posterior de linha já empurrada que liste
uma das 5 colunas que o trigger observa (pid, conta, hash, kpi, ponteiro) inverte a ordem de lock com o
importador (40P01, sem duplicata).` por:

```markdown
⇒ desde `20261005220000` a linha do app **ganha o kpi NO ENVIO**: o trigger deriva o dia de SP do write-back (`sales_orders_instante_envio()` = `statement_timestamp()`) quando ela passa a ter pid sem gêmeo — nenhum escritor TS/edge grava kpi. Quem precisar gravá-lo: só **no INSERT ou no MESMO UPDATE do write-back que seta o pid** — qualquer UPDATE posterior de linha já empurrada que liste uma das 5 colunas que o trigger observa (pid, conta, hash, kpi, ponteiro) inverte a ordem de lock com o importador (40P01, sem duplicata).
```

e, depois do link final do bullet (o que aponta `gemeos-push-pull-contagem-unica.md`), acrescente ` · ` e
um link para `app-grava-kpi-no-envio.md` com o mesmo prefixo `../historico/` (relativo a `docs/agent/`),
tudo na MESMA linha 281.

Em `docs/historico/gemeos-push-pull-contagem-unica.md`, logo abaixo do título da seção
"O que o PR do kpi do app precisa", inserir:

```markdown
> **Entregue em 2026-10-06** — [app-grava-kpi-no-envio.md](app-grava-kpi-no-envio.md): o trigger deriva o kpi no envio (abordagem A), o ranking não atribui a linha do app e o `SalesQuotes` não regrava `'rascunho'`.
```

- [ ] **Step 5: verificação completa**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && heavy bun run typecheck > /tmp/v-tc.log 2>&1; echo "typecheck exit=$?"; bun run lint > /tmp/v-lint.log 2>&1; echo "lint exit=$?"; heavy bun run test > /tmp/v-test.log 2>&1; echo "test exit=$?"; grep -E "Test Files |Tests " /tmp/v-test.log; bun run lint:shell > /tmp/v-sc.log 2>&1; echo "shellcheck exit=$?"
```

Esperado: os quatro `exit=0`. Teste vermelho fora do que esta entrega tocou: conferir se também está
vermelho em `origin/main` antes de mexer (estado compartilhado não é desta sessão).

- [ ] **Step 6: commitar**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && git add db/nucleo-ci.txt scripts/audit-custom-migrations.sql docs/migrations-audit.md docs/historico/app-grava-kpi-no-envio.md docs/agent/database.md docs/historico/gemeos-push-pull-contagem-unica.md && git commit -q -m "$(cat <<'EOF'
docs(kpi-no-envio): núcleo do CI, registro de migrations e diário da entrega

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)" && git log --oneline origin/main..HEAD
```

---

### Task 6: PR DRAFT

- [ ] **Step 1: re-conferir colisão (o auto-merge fecha PR em minutos)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && git fetch -q origin && git log --oneline HEAD..origin/main | head && git grep -l "sales_orders_instante_envio" origin/main -- . | head -3; gh pr list --state open --limit 50 --json number,title --jq '.[] | select(.title|test("gemeo|kpi|ranking|SalesQuotes|data.health";"i")) | "\(.number) \(.title)"'; echo "exit=$?"
```

Esperado: nenhum artefato `sales_orders_instante_envio` na main, nenhum PR concorrente. Se a main andou:
`git merge origin/main`, re-rodar as 2 provas (controle) e o `heavy bun run test`.

- [ ] **Step 2: push e PR DRAFT**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && git push -u origin claude/app-grava-kpi-push && gh pr create --draft --base main --title "feat: a venda empurrada entra no universo canônico no ENVIO — o trigger deriva o kpi da linha do app [money-path]" --body-file /tmp/pr-body.md
```

Corpo (`/tmp/pr-body.md`, escrever antes): resumo (as 4 mudanças), decisões D1/D2 do founder, provas
(26/11 e 9/4 nos 2 idiomas + vitest), riscos (§8 da spec), camadas de deploy (2 migrations pela sessão
após o Publish do founder; nenhuma edge), e estas duas linhas literais:

```text
Codex: desenho=sem-codex (SALDO_ALTO 89%, Caminho B — spec §7) · código=pendente (cota reabre 09/10 19:30) · extra=nenhum
REVISÃO INDEPENDENTE PENDENTE
```

terminando com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: ligar o monitor** — `mcp__ccd_pr__get_status`; se não listar o PR,
`mcp__ccd_pr__bind_pr`; depois `mcp__ccd_pr__set_monitor` com `auto_fix` e `address_comments`.
Atualizar o diário (`Deploy`) com o número do PR e commitar/push.

---

### Task 7: Codex adversarial + revisão final (a partir de 09/10 19:30)

- [ ] **Step 1: o diff para o Codex (sem o corpo copiado da B e sem os arquivos gerados)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && S="$(mktemp -d)" && git diff origin/main...HEAD -- . ':(exclude)supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql' ':(exclude)scripts/audit-custom-migrations.sql' ':(exclude)docs/migrations-audit.md' > "$S/diff.txt" && { awk 'index($0,"CREATE OR REPLACE FUNCTION public._data_health_compute(")==1{exit} {print}' supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql; echo '... (corpo = v2 + as 2 trocas de velho*/novo* da prova B; A3 prova) ...'; awk '/^REVOKE EXECUTE ON FUNCTION public._data_health_compute/{f=1} f' supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql; } > "$S/b-resumo.sql" && wc -c "$S/diff.txt" "$S/b-resumo.sql" && echo "$S"
```

- [ ] **Step 2: rodar em background** (Bash com `run_in_background: true`):

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && { cat <<'EOF'
Revisão ADVERSÁRIA de um PR money-path (Postgres 17 / Supabase, prod TimeZone=UTC, READ COMMITTED).
Contexto: em sales_orders, a venda empurrada pelo app ao Omie volta pelo importador como OUTRA linha
(gêmeos). Desde 20261001100001 a importada é a venda e a linha do app vira recibo (kpi NULL +
gemeo_importado_id), sob advisory lock por (account, pid) e índice único de 1 kpi por pedido. Este PR
faz o trigger da linha do app DERIVAR order_date_kpi no envio (dia de SP do statement_timestamp), muda o
ranking (só a importada credita o vendedor), tira um UPDATE 'rascunho' pós-envio e troca 2 textos do
sensor de órfã. Ataque e traga só cenários CONCRETOS (estado inicial + sequência exata de statements ou
eventos + o que sai errado + qual assert da prova deveria pegar e não pega) em que:
(a) uma venda conte 2× no universo canônico (só order_date_kpi, status fora de cancelado/rascunho/
pendente/orcamento, deleted_at nulo); (b) uma venda empurrada fique sem kpi quando deveria tê-lo, ou
ganhe kpi quando não deveria; (c) o kpi caia no dia errado (UTC × SP, relógio da transação × do
statement); (d) o write-back (UPDATE do criarPedidoVenda) ou o importador (RPC criar_pedidos_com_itens)
falhem com 23505/40P01/42501 onde antes passavam; (e) a PRE/POS deixem passar um apply que reverte outra
versão ou deixem o ACL aberto; (f) o ranking credite uma venda a um vendedor e depois a outro, ou o total
do card divirja da receita MTD; (g) a Migration B mude alguma detecção. Sem refatoração estética.
EOF
cat "$S/diff.txt" "$S/b-resumo.sql"; } | scripts/codex-async.sh -r max - > "$S/codex.out" 2>&1; echo "exit=$?"
```

Desfechos: `exit=0` → ler `$S/codex.out` e tratar cada achado (reproduzir na prova primeiro: assert
novo vermelho → correção → verde → falsificar de novo nos 2 idiomas); `exit=79` → cota ainda alta: o PR
segue DRAFT, reagendar; outro exit → o que o script instruir (Caminho B de novo se for cota).
Atualizar a linha `Codex:` do PR com o desfecho (`código=<exit> · achados=<n> tratados`).

- [ ] **Step 3: revisão final com contexto novo** — despachar um revisor (Agent `general-purpose`,
`model: "opus"`, em pt-BR) com: o caminho do worktree, a spec, este plano e `git diff origin/main...HEAD`;
pedir achados concretos (arquivo:linha, cenário, gravidade) contra a spec e as Global Constraints, sem
editar nada. Tratar os achados, re-rodar o que tocou (provas + vitest), commitar e push.

- [ ] **Step 4: tirar do DRAFT** — com Codex e revisão tratados, trocar `REVISÃO INDEPENDENTE PENDENTE`
pela linha do desfecho e `gh pr ready <nº>` (o auto-merge leva com o CI verde). Conferir o merge de verdade:
`gh pr view <nº> --json state,mergedAt`.

---

### Task 8: Deploy (Publish → apply A → apply B → `/fecho`)

- [ ] **Step 1: Publish do front (founder)** — pedir ao founder o Publish no Lovable e que o cliente
dele clique a atualização do app (o card do ranking é do Master). Esperar a confirmação dele no chat.

- [ ] **Step 2: pré-voo por fora**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && ~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT 'derivar=' || md5(prosrc) FROM pg_proc WHERE oid = 'public.sales_orders_gemeo_app_derivar()'::regprocedure;
SELECT 'instante=' || coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.sales_orders_instante_envio()')), 'ausente');
SELECT 'compute=' || md5(prosrc) FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;
SELECT 'dup_kpi=' || count(*) FROM (SELECT 1 FROM public.sales_orders WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL GROUP BY account, omie_pedido_id HAVING count(*) > 1) d;
SELECT 'FIM-OK';
SQL
echo "exit=$?"
```

Esperado: `derivar=cc036077756a992f97835f383686e110`, `instante=ausente`,
`compute=5ae67f7eec50058c67589a58081b7c7e`, `dup_kpi=0`, `FIM-OK`, `exit=0`. Qualquer outro valor: parar
(a PRE abortaria de todo jeito).

- [ ] **Step 3: apply A (ensaio, depois real)** — no worktree sincronizado com a main já mergeada
(`git fetch && git merge origin/main`, arquivo commitado e limpo):

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bun run db:aplicar supabase/migrations/20261005220000_sales_orders_kpi_no_envio.sql --ensaio; echo "exit=$?"
```

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && bun run db:aplicar supabase/migrations/20261005220000_sales_orders_kpi_no_envio.sql; echo "exit=$?"
```

Esperado: `exit=0` nos dois (o ensaio termina em ROLLBACK).

- [ ] **Step 4: validação da A por fora**

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && ~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT 'derivar=' || md5(prosrc) FROM pg_proc WHERE oid = 'public.sales_orders_gemeo_app_derivar()'::regprocedure;
SELECT 'instante=' || md5(prosrc) || ' cfg=' || coalesce(array_to_string(proconfig, '|'), '-') FROM pg_proc WHERE oid = 'public.sales_orders_instante_envio()'::regprocedure;
SELECT 'acl_aberto=' || count(*) FROM (VALUES ('public.sales_orders_gemeo_app_derivar()'), ('public.sales_orders_gemeo_importada_antes()'), ('public.sales_orders_gemeo_importada_depois()'), ('public.sales_orders_instante_envio()')) f(sig), (VALUES ('public'), ('anon'), ('authenticated')) r(papel) WHERE has_function_privilege(r.papel, f.sig, 'EXECUTE');
SELECT 'dup_kpi=' || count(*) FROM (SELECT 1 FROM public.sales_orders WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL GROUP BY account, omie_pedido_id HAVING count(*) > 1) d;
SELECT 'ptr_com_kpi=' || count(*) FROM public.sales_orders WHERE gemeo_importado_id IS NOT NULL AND order_date_kpi IS NOT NULL;
SELECT 'ledger=' || estado FROM public.db_aplicacoes WHERE arquivo LIKE '%20261005220000_sales_orders_kpi_no_envio.sql' AND sha256 NOT LIKE 'ensaio:%' ORDER BY id DESC LIMIT 1;
SELECT 'FIM-OK';
SQL
echo "exit=$?"
```

Esperado: `derivar=<MD5_DERIVAR do Task 1>`, `instante=<MD5_INSTANTE> cfg=search_path=public`,
`acl_aberto=0`, `dup_kpi=0`, `ptr_com_kpi=0`, `ledger=aplicada`, `FIM-OK`, `exit=0`.

- [ ] **Step 5: apply B e validação** — o mesmo ritual com
`supabase/migrations/20261005220100_data_health_venda_empurrada_conta_pelo_app.sql` (`--ensaio`, real), e:

```bash
cd /Users/lucassardenberg/Projetos/afiacao-claude-app-grava-kpi-push && ~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT 'compute=' || md5(prosrc) || ' cfg=' || array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;
SELECT 'acl_aberto=' || count(*) FROM (VALUES ('public'), ('anon'), ('authenticated')) r(papel) WHERE has_function_privilege(r.papel, 'public._data_health_compute()', 'EXECUTE');
SELECT 'ledger=' || estado FROM public.db_aplicacoes WHERE arquivo LIKE '%20261005220100_data_health_venda_empurrada_conta_pelo_app.sql' AND sha256 NOT LIKE 'ensaio:%' ORDER BY id DESC LIMIT 1;
SELECT 'FIM-OK';
SQL
echo "exit=$?"
```

Esperado: `compute=<MD5_B> cfg=search_path=public, pg_temp`, `acl_aberto=0`, `ledger=aplicada`,
`FIM-OK`, `exit=0`. (A POS do apply já executou o compute na prod: 31/31 sources.)

- [ ] **Step 6: fechar** — registrar no diário (`Deploy`) datas, recibos e as saídas acima (sem
segredo), commitar por PR pequeno de docs (ou no PR, se ainda aberto); rodar `/fecho`.

---

## Pronto quando (espelho da spec §10)

- [ ] spec e plano revisados (founder);
- [ ] Tasks 1–5 verdes (provas falsificadas nos 2 idiomas, vitest, typecheck, lint, shellcheck) no PR
  **DRAFT** (Task 6);
- [ ] Codex adversarial no diff (≥ 09/10 19:30) e revisão final com contexto novo, achados tratados (Task 7);
- [ ] Publish do front e o cliente do founder atualizado; apply A e B via `db:aplicar` com postcondição
  verde e validação por `psql-ro` (Task 8);
- [ ] diário em `docs/historico/` e bullet do `database.md` atualizados (Task 5, completado no Task 8).
