# Gate de auth canônico nas 13 edges (lote H do plano de melhoria v2) — 2026-10-18

**O que era:** 13 edges carregavam uma CÓPIA local de `authorizeCronOrStaff` — 9 devolvendo `boolean`
(`disparar-pedidos-aprovados`, `enviar-pedido-portal-sayerlack`, `gerar-pedidos-diario`,
`omie-cron-diario`, `omie-sync-{ctes-recebidos,nfes-recebidas,pedidos-compra,sku-items,vendas-items}`)
e 4 devolvendo `AuthResult` (`fin-{cashflow-engine,ic-reconcile,period-override,suggest-mapping}`).
Mesma lógica, 13 lugares para divergir, e o comentário do canônico (`_shared/auth.ts`) dizia
`admin/employee/manager/master` quando o código aceita só `employee|master`.

**A armadilha que decidiu a ORDEM:** a canônica devolve `AuthResult` (`{ok:false, response}` é
**truthy**). Trocar o import e esquecer o `if (!(await authorizeCronOrStaff(req)))` **abre a edge**:
sem credencial ela passa do gate e vai ao fluxo real (Omie, inserts). Por isso o Codex corrigiu a
ordem do plano: **testes negativos nos HANDLERS primeiro**, troca depois.

**O que entrou:**
- `_shared/harness-handler.ts`: carrega o `index.ts` como módulo, captura o handler do `Deno.serve`,
  substitui `Deno.env.get` e `fetch` (simula só `/auth/v1/user` + `user_roles`; qualquer outra URL é
  EFEITO). Import do `index.ts` é **computado** (`new URL("./index.ts", import.meta.url)`): literal faria
  o `deno test` type-checar a edge contra o supabase-js do `node_modules` (outra versão da do lock do
  `edges:typecheck`) e gerar TS2322 falsos.
- `<edge>/index_test.ts` × 13, cada um com 4 negativos (sem credencial · cron-secret errado · Bearer
  inválido · JWT customer → **401 e zero fetch fora do gate**) + 1 **controle positivo** (cron válido +
  `{probe:true}` → 200 com `VERSAO` e zero fetch — prova que o request ALCANÇA o handler; sem ele um 401
  de qualquer origem passaria).
- `_shared/auth_test.ts`: o canônico EXECUTADO (cron · service role · employee · master · customer ·
  sem papel · JWT inválido · `CRON_SECRET` ausente · fetch lançando → fail-closed) + `authorizeCron` e
  `authorizeMaster`.
- Troca nas 13: cópia apagada, `import { authorizeCronOrStaff } from "../_shared/auth.ts"`, teste
  booleano → `.ok`. Nas fin-* somem também `type AuthResult` e `unauthorized()` locais.
- `test:hooks` (package.json) ganha **1 linha**: `git grep --untracked "function authorizeCronOrStaff"`
  fora de `_shared/` → vermelho com marcador `COPIA-LOCAL-DE-authorizeCronOrStaff`. Não é gate novo.

**Falsificação (commit `90d3137fd`, saída colada no PR):** em `disparar-pedidos-aprovados`, import novo
+ `if (!(await authorizeCronOrStaff(req)))` antigo → **4 FAILED** (esperado 401, recebido 500 — a edge
entrou no fluxo real), controle positivo `ok`, `exit=1`; restaurado com `git checkout --`. A linha do
`test:hooks`: árvore limpa `exit=0`; cópia nova não rastreada em `supabase/functions/zz/index.ts` →
marcador + `exit=1`; `_shared/auth.ts` não dispara.

**Lições:**
- **`deno test` e npm sob `--no-remote`:** o `npm:@supabase/supabase-js@2` resolve pelo `node_modules`
  do `bun install` (medido com `DENO_DIR` vazio: zero download). Teste de handler que importa `index.ts`
  é possível offline — mas o type-check desse grafo é do `edges:typecheck`, não do `deno test`.
- **`deno test` carrega e roda cada arquivo em sequência** (medido: A vê A, B vê B) — stubs de
  `globalThis.fetch`/`Deno.serve` por arquivo não vazam entre suítes.
- **Teste negativo sem controle positivo é teatro**: 401 "de qualquer lugar" aprova. O par
  negativo+positivo no MESMO harness é o que fecha.

**Deploy (founder, 2 levas de ~7):** as 13 edges bumpadas (`vX.Y-gate-auth-canonico`) aparecem em
`bun run pendencias:deploy` após o merge. Sem janela mista: a canônica e as cópias têm a mesma
semântica de request (mesmos headers, mesmos papéis, mesmo 401).
