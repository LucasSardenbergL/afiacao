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

## Resolução (2026-06-06) — todos os itens fechados

- **P1 (RPC mutante escapa do guard) — ✅ FEITO** (commit `6ae1fa48`). `createLensGuardedClient` intercepta `.rpc(name,...)`: na lente, bloqueia tudo que não começa com `get_`/`list_` (allowlist explícita vazia). 3 testes novos (`registrar_contato_rota`/`confirmar_item_picking` rejeitam; `get_minha_positivacao`/`list_impersonation_targets` passam; fora da lente passa).
  - ⚠️ **Descoberta load-bearing:** o ordering do `ImpersonationContext` agora é REQUERIDO pelo guard de RPC — `log_impersonation_start` roda ANTES de `setLensActive(true)` e `end_impersonation` roda DEPOIS de `setLensActive(false)`. Ambas são RPCs **mutantes** (não `get_`/`list_`) → se rodassem com a lente ativa, o próprio P1 as bloquearia. Por isso o P2#3 abaixo **não pode** ser "endurecido" reordenando.

- **P2#1 (override legado preso) — ✅ FEITO.** `DashboardPersonaContext` não inicializa mais do `localStorage` (começa `null`) e **limpa a chave órfã** `dashboardPersonaOverride` no boot. `setOverride`/`clearOverride`/`override` **removidos** do contexto (zero consumidor no app — a "troca de visão" é a lente, não override manual); `usePersona(null)`. `inferPersona` passo 1 (override) fica intacto (puro, agora sempre `null`). Teste reescrito (3 casos: resolve por `display*`; na lente→`vendedor` via `display*`; **ignora override legado e limpa a chave**).

- **P2#2 (`displayLoading` ignorado + loading eterno) — ✅ FEITO.** `useDisplayAccess` separa `isLoading` (loading genuíno → `displayLoading:true`) de **settled-sem-perfil** (RPC falhou/vazia → rebaixa fail-closed com `displayLoading:false` — mata o loading eterno do `isLoading || !targetProfile`). AppShell (desktop `AppSidebar` + `MobileNav`) renderiza placeholder **"Carregando visão…"** quando `displayLoading`, em vez do menu parcial. `ImpersonationBanner` ganha **watcher de auto-saída**: `isError` persistente (após os retries do React Query) → `toast.error` + `stopImpersonation` (mount único do banner = 1 toast; `isImpersonating` vira false no render seguinte e o guard impede toast duplicado). +1 teste de regressão (settled-sem-perfil → `displayLoading:false`).

- **P2#3 (timing stop/restore) — ✅ CORRIGIDO de verdade (não só aceito) na re-verificação do codex (ver F2 abaixo).** As RPCs de auditoria passaram a rodar no `supabaseUnguarded` (client SEM guard), então não dependem mais de ordenar `setLensActive` em volta delas. No `stopImpersonation` o guard **fica ATIVO durante o await** do `end_impersonation` e só desliga + limpa o `target` ao final → **sem janela** "guard off + UI ainda na lente" (fecha o vetor de flush offline). No reload, o effect defensivo segue re-sincronizando o guard.

- **P2#4 (`/meu-dia` não vira o dashboard da Farmer) — ✅ ESCOPO FASE 2 (documentado).** `CommercialDashboard`/`useMyCommercialRole` decidem Master vs Commercial dashboard pelo cargo **REAL** do master → na lente segue mostrando o `MasterDashboard`. É gap de **fidelidade** (a lente não reproduz o `/meu-dia` da Farmer), **não dano**. Tela não-migrada → entra na Fase 2 (migração de telas internas pra `display*`). Anotado no §13 do spec.

- **P2#5 (tipo de `displayCommercialRole`) — ✅ DOCUMENTADO (edge).** `CommercialRole` é o tipo legado de 4 valores (`operacional/gerencial/estrategico/super_admin`); o banco tem também `farmer/hunter/closer/master`. `inferPersona` só casa os 4 no switch (passo 4), MAS o passo 2 (**department**) vem antes e resolve as personas reais (Farmers têm `department='vendas'` → `vendedor`). Alvo com cargo novo-estilo **e sem** department cai em heurística/`geral` (degradação honesta, sem dano). Ampliar o tipo rippla pra `useCommercialRole` e outros consumidores → **fora de escopo** deste fix; anotado no §13 do spec.

**Validação (1ª rodada):** 385 arquivos / **2412 testes verdes**, `bun run typecheck` limpo, `bun lint` **0 errors** (82 warnings pré-existentes de `exhaustive-deps`).

## Re-verificação do codex no diff (2026-06-06) — 3 achados REAIS, todos corrigidos

O consult adversário do codex (`gpt-5.5 xhigh`) **pendurou antes do veredito final** (padrão do CLAUDE.md — explorou o repo no read-only e bateu no `timeout 540s`), MAS o stream de raciocínio capturou **3 furos reais** antes de morrer. Verifiquei cada um (decisão solo, fallback do CLAUDE.md) — **todos confirmados e corrigidos**:

- **F1 (P1 funcional) — RPC de LEITURA com nome em PT bloqueada.** A heurística `get_`/`list_` é inglês-cêntrica; `listar_pedidos_a_separar` (leitura pura, `queries/usePedidosASeparar.ts`, anti-join SELECT) não casa `list_` → ficava bloqueada na lente (tela de picking quebraria). **Fix:** entrou na `RPC_READONLY_ALLOWLIST` (`lens-write-guard.ts`). ⚠️ **A verificação evitou um tiro no pé:** os outros "candidatos" do codex `ciclo_oportunidade_do_dia` e `sugerir_negociacao_paralela_hoje` são **ESCRITAS** (geram pedidos/sugestões — `handleGerarCiclo`/`handleGerarSugestoes`); allowlistar às cegas teria **vazado 2 escritas**. Ficam bloqueadas de propósito. (`estimar_impacto_exclusao_outlier`/`fin_estimar_estoque_omie` são leituras em telas Reposição/Financeiro **inalcançáveis** no lens das Farmers de hoje → deixadas bloqueadas, sem dano; allowlistar quando uma persona-alvo as alcançar + confirmar pureza.)

- **F2 (P1 funcional + P2 write-window) — RPCs de auditoria bloqueadas pelo próprio guard.** O guard de RPC do P1 bloqueava `log_impersonation_start` na **troca direta de alvo** A→B (chip `PersonaSwitcherChip:51` / `ViewAsPicker:31` chamam `startImpersonation(B)` com a lente ainda ativa) → a auditoria de início falhava. E a janela do `stop` (guard off antes do `await end_impersonation` com `target` ainda setado) permitia **flush offline** escrever como master. **Fix:** `client.ts` expõe `supabaseUnguarded` (client SEM guard); `ImpersonationContext` usa-o p/ `log_impersonation_start` + `end_impersonation` (bookkeeping legítimo do master). Com isso o guard **permanece ativo** durante toda a entrada/troca/saída (a auditoria fura pelo client raw), fechando os dois vetores.

- **F3 (P1 money-path) — `fetch` cru pra edge contorna o `functions.invoke` do guard.** `DispararAgoraButton` faz `POST` direto a `/functions/v1/enviar-pedido-portal-sayerlack` (não `supabase.functions.invoke`) → o write-guard não pega → na lente, "Disparar agora" efetivaria um **pedido REAL no portal Sayerlack** como master. **Fix:** checagem `isLensActive()` no `handleClick` (early-return + toast). (Varredura dos outros 2 `fetch` crus pra edge: `useSuggestedMapping` é **leitura** ok; o de `TintApiContract` está dentro de um `CodeBlock` = string de doc, não é call real.)

**Testes novos:** `lens-write-guard` (allowlist PT passa / escrita PT bloqueada), `DispararAgoraButton` (na lente não faz fetch + toast / fora da lente dispara). **Validação (2ª rodada):** suíte + `typecheck` + `lint` re-rodados verdes.

## Lembretes de deploy (Fase A não vai ao ar sozinha)
- **Frontend:** Publish manual no Lovable (a lente só aparece pro master no app publicado).
- Sem migration, sem edge function nesta Fase A (tudo client-side; a RPC `get_user_access_profile_for` já existe em prod).
