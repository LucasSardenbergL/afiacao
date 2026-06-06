# Lente Fase A — correções do review final (codex) — plano de fechamento

> Estado em 2026-06-06: Fase A implementada (12 commits, 2408 testes verdes, typecheck/lint limpos). O review final do codex (`/tmp/codex-final.log`) apontou 1 P1 bloqueante + 5 P2 ANTES de a Fase A poder ir ao ar. Este doc é o input pra fechar (retomável após `/compact`).

## Confirmado sólido pelo codex (não mexer)
- Sem lente, paridade preservada (exceto o override legado — P2 abaixo).
- Nenhum consumidor de `useDisplayAccess` decide escrita/identidade.
- AppShell separa display-filter vs query-enable; badges suprimidos na lente.
- `RequireFinanceiroAccess` chama hooks incondicionalmente e não consulta a permissão do master na lente.

## P1 — BLOQUEANTE: RPC mutante escapa do write-guard

**Onde:** `src/lib/impersonation/lens-write-guard.ts` — o guard intercepta `from`/`storage`/`functions`, mas **`.rpc()` passa cru**. RPCs mutantes acionáveis na lente:
- `registrar_contato_rota` / `desfazer_contato_rota` via `OutcomeMenu.tsx:59` → `useRegistrarContato.ts:23` (o vendedor acessa a lista de ligação).
- `confirmar_item_picking` — a fila offline pode disparar automaticamente.

Gravam **como master** durante a lente → viola read-only.

**Correção:** no `createLensGuardedClient`, interceptar `.rpc(name, ...)`. Na lente, **bloquear por padrão**; liberar só leitura:
```ts
const RPC_READONLY_ALLOWLIST = new Set<string>([ /* nomes explícitos de leitura sem prefixo, se houver */ ]);
function isReadOnlyRpc(name: string): boolean {
  return name.startsWith('get_') || name.startsWith('list_') || RPC_READONLY_ALLOWLIST.has(name);
}
// no get do Proxy:
if (prop === 'rpc') {
  const orig = Reflect.get(targetObj, prop, receiver);
  if (typeof orig === 'function') {
    return (...args: unknown[]) => {
      const name = typeof args[0] === 'string' ? args[0] : '';
      if (lensActive && !isReadOnlyRpc(name)) return blockedResult(`rpc:${name}`);
      return (orig as (...a: unknown[]) => unknown).apply(targetObj, args);
    };
  }
}
```
**Timing OK (verificado):** `log_impersonation_start` roda em `startImpersonation` ANTES de `setLensActive(true)`; `end_impersonation` roda em `stopImpersonation` DEPOIS de `setLensActive(false)` → ambas passam (fora do guard). A heurística não precisa cobri-las.

**Testes a adicionar** (`lens-write-guard.test.ts`): na lente, `rpc('registrar_contato_rota')` rejeita com `LensReadOnlyError`; `rpc('get_minha_positivacao')` passa; `rpc('list_x')` passa.

**Limitação documentada:** RPC de leitura que não comece com `get_`/`list_` fica vazia na lente (degradação honesta, sem dano) — adicionar à allowlist explícita se aparecer.

## P2 (10/10) — override legado `dashboardPersonaOverride` preso

**Onde:** `src/contexts/DashboardPersonaContext.tsx:25` lê o override do localStorage no init, mas o chip novo (`PersonaSwitcherChip`) removeu o `setOverride`/`clearOverride`. Override persistido de antes fica preso e **vence tudo** (`persona-detect.ts:47`), inclusive na lente.

**Correção:** como a troca manual foi aposentada, o override manual não existe mais. No `DashboardPersonaProvider`, **parar de inicializar a partir do localStorage** (começar `null`) e **limpar a chave órfã** (`localStorage.removeItem('dashboardPersonaOverride')`) no boot. Ajustar `DashboardPersonaContext.test.tsx`: o caso "inicializa a partir do override persistido" deixa de fazer sentido → trocar por "ignora override legado e limpa a chave". Avaliar se `setOverride`/`clearOverride` ainda têm consumidor; se não, podem sair do contexto (ou ficar como no-op documentado).

## P2 (9/10) — `displayLoading` ignorado + loading eterno em falha de RPC

**Onde:** `AppShell.tsx:361` (desktop e mobile) não trata `displayLoading` → menu parcial no load (sales-only vê seções além de Vendas brevemente). E `useDisplayAccess.ts:53`: usa `isLoading || !targetProfile` → se a RPC `get_user_access_profile_for` **falha**, `!targetProfile` é sempre true → **loading eterno**.

**Correção:**
1. `useDisplayAccess`: distinguir erro de loading. Pegar `isError` do `useImpersonatedAccessProfile`. Em erro na lente → NÃO `displayLoading` eterno; rebaixar tudo + sinalizar (ou o `ImpersonationContext` sai da lente com toast). `displayLoading` deve refletir só `isLoading` real.
2. AppShell: quando `displayLoading`, renderizar placeholder ("Carregando visão…") em vez do menu rebaixado, nos DOIS componentes (desktop + MobileNav).

## P2 (9/10) — timing de stop/restore da lente

**Onde:** `ImpersonationContext.tsx:60` — `stopImpersonation` faz `setLensActive(false)` antes do `await end_impersonation` e do `setTarget(null)`: janela curta em que a UI ainda está na lente mas mutações já passam. No reload, `ImpersonationContext.tsx:33` restaura `target` tarde → no 1º render o master real aparece antes de a lente/guard voltarem.

**Correção (menor):** manter `setLensActive(false)` no stop só após confirmar a saída, ou aceitar a janela (o usuário já clicou "Sair"). Pro reload, o effect de `setLensActive(!!target)` já re-sincroniza; o risco é leitura (vê o app real um instante), não escrita. Avaliar custo/benefício — provável "aceitar + documentar".

## P2 (9/10) — `/meu-dia` não vira o dashboard da Farmer (fidelidade) — ESCOPO FASE 2

**Onde:** `CommercialDashboard.tsx:19` / `useMyCommercialRole.ts:25` — `/meu-dia` decide qual dashboard renderizar (Master vs Commercial) pelo cargo do master real. Na lente, continua mostrando MasterDashboard. Reduz fidelidade como QA, mas **não é dano** — é uma tela não-migrada (Fase 2). Documentar como limitação conhecida da Fase 1.

## P2 (8/10) — tipo de `displayCommercialRole`

**Onde:** `useDisplayAccess.ts:18` — `CommercialRole` é o tipo legado de 4 valores (`operacional/gerencial/estrategico/super_admin`), mas o banco tem também `farmer/hunter/closer/master`. `inferPersona` ignora esses → sem departamento, a persona do alvo cai em heurística/`geral`. Edge case. Avaliar ampliar o tipo ou documentar.

## Ordem de execução sugerida (pós-compact)
1. P1 (RPC) — bloqueante, faz a Fase A virar read-only de verdade. + testes.
2. P2 override legado — fácil, alto impacto (persona errada).
3. P2 displayLoading + loading eterno — médio.
4. P2 stop/restore timing — avaliar (provável documentar).
5. P2 /meu-dia + displayCommercialRole tipo — documentar como Fase 2/edge.
6. Rodar suíte + typecheck + lint. Codex de re-verificação no diff das correções.
7. `superpowers:finishing-a-development-branch` → PR.

## Lembretes de deploy (Fase A não vai ao ar sozinha)
- **Frontend:** Publish manual no Lovable (a lente só aparece pro master no app publicado).
- Sem migration, sem edge function nesta Fase A (tudo client-side; a RPC `get_user_access_profile_for` já existe em prod).
