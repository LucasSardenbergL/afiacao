# Boot: o chunk da rota baixa em paralelo ao auth e a sidebar faz prefetch (plano v5, lote 6, F1+F5)

**Data:** 2026-11-03 · **Deploy:** só Publish (founder) · Plano: `docs/superpowers/plans/2026-11-03-plano-melhoria-v5/README.md` §2.F

## Problema

O `ProtectedRoute` segura o render até o `useAuth()` resolver (sessão, role, aprovação). Como as
156 páginas eram `React.lazy`, o `import()` da página só começava **depois** disso: o boot de `/`
fazia auth e chunk em série. A sidebar só navegava no clique, então todo chunk novo começava a
baixar no clique.

## O que mudou

- **Loader único (`src/lib/preload-rota.ts`).** `lazyRota(carregar)` é o `React.lazy` das páginas
  e guarda o MESMO `carregar` para o prefetch. A árvore `<Route>` do `App.tsx` virou a constante
  `arvoreDeRotas`, renderizada pelo `<Routes>` e registrada com `createRoutesFromElements`. Ela é o
  mapa rota→import (`matchRoutes`), e nenhum caminho é repetido.
- **F1.** O `main.tsx` chama `prefetchRota(location.pathname)` antes do `createRoot`. O chunk da
  rota de entrada baixa enquanto o auth roda. **Só baixa**: o `ProtectedRoute` não mudou, então a
  página continua sem renderizar antes do auth. Gate e fail-closed estão intactos.
- **F5.** O `SidebarItem` do `AppShell` usa `usePrefetchRota(item.path)`, com 80 ms de intenção de
  ponteiro (passar o mouse por cima não baixa tudo) e prefetch imediato no foco de teclado.
- **Risco do Codex tratado antes do F5.** Um prefetch de chunk ausente (deploy novo, SW velho)
  dispara `vite:preloadError`, e o handler global recarregava a página. Agora o handler
  (`tratarFalhaDeChunk`) só recarrega se um carregamento REAL (o wrapper do `lazy`) estiver em voo.
  Falha só de prefetch é silenciosa. A navegação real com o mesmo chunk falha de novo e recarrega
  1×, com a guarda anti-loop intacta.
- Offline ou `saveData` → não faz prefetch. Assim, uma falha de rede não deixa a navegação real
  presa a um módulo que falhou.

## Prova

- `src/lib/__tests__/preload-rota.test.tsx` (9 casos): (a) o prefetch e o render chamam o mesmo
  carregador, e o `App.tsx` declara cada `import("./pages/…")` uma vez, dentro de `lazyRota`;
  (b) um prefetch que rejeita (imitando o `__vitePreload`) não recarrega, e o controle de
  navegação real na mesma invocação recarrega 1×; (c) o `ProtectedRoute` com auth carregando não
  renderiza a página mesmo com o chunk pronto. Também cobre o hook (intenção e foco) e o offline.
- Falsificação: 7 sabotagens, uma por vez (prefetch que recarrega, render antes do auth, loader
  duplicado na lib, mapa paralelo no App, sem intenção, sem guarda offline, prefetch que ignora
  wrapper). Todas ficaram vermelhas em `LC_ALL=C` e em `pt_BR.UTF-8`, com controle verde antes e
  depois na mesma invocação.

## LCP

O baseline em prod (`telemetria_vitals`, 2026-11-03) dá LCP de `/` com p50 de 4.070 ms e p75 de
7.821 ms, n=8, 1 usuário e 6 builds. É pista, não prova. O "depois" só existe após o Publish e
se mede com a query do PR (builds vistos pela primeira vez depois do Publish).

## Lições

- A árvore de `<Route>` em JSX já é um mapa. `createRoutesFromElements` + `matchRoutes` evitam
  manter uma 2ª lista de caminhos que diverge da 1ª.
- Todo import especulativo passa pelo mesmo `vite:preloadError` da navegação real. Quem recarrega
  precisa saber **quem** pediu o chunk.
