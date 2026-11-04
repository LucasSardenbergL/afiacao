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
  dispara `vite:preloadError`, e o handler global recarregava a página. Agora
  `instalarRecuperacaoDeChunk` atribui a falha pelo `payload` do evento, que é o mesmo objeto de
  erro que rejeita a promise. O prefetch marca os seus erros e o `lazy` real marca os dele. A
  decisão espera um macrotask e ignora só o erro que veio de prefetch. Falha real, de página ou
  de import não-rota (componente lazy interno, `pwa-update`), segue recarregando 1×.
- **Rota cujo prefetch falhou recarrega na navegação real, antes de carregar.** O
  `__vitePreload` marca a dependência CSS como vista antes de baixá-la. Se o CSS falhou no
  prefetch, a 2ª tentativa resolveria o JS e renderizaria sem CSS, sem novo evento. A guarda
  anti-loop vale: se já recarregou nesta sessão, carrega normal. Pelo mesmo motivo, a
  navegação que começa com o prefetch daquela rota em voo espera o desfecho dele.
- **Entrada por redirect.** O prefetch segue `<Navigate to>` absoluto por até 3 saltos (os 19
  redirects do `App.tsx` são todos literais absolutos).
- Offline ou `saveData` → não faz prefetch. Assim, uma falha de rede não deixa a navegação real
  presa a um módulo que falhou.

## Prova

- `src/lib/__tests__/preload-rota.test.tsx` (16 casos): (a) o prefetch e o render chamam o mesmo
  carregador, e o `App.tsx` declara cada `import("./pages/…")` uma vez, dentro de `lazyRota`;
  (b) um prefetch que rejeita (imitando o `__vitePreload` 5.4, com `payload`) não recarrega, e a
  navegação real dessa rota recarrega 1×. Também cobre a falha real sem prefetch, o prefetch de A
  falhando com B saudável em voo, o import não-rota falhando com prefetch em voo, o prefetch
  ainda pendente na hora da navegação, o `payload` primitivo e a guarda anti-loop; (c) o `ProtectedRoute` com auth carregando não renderiza a página mesmo com o chunk
  pronto. Fora isso, cobre redirects (com teto), intenção do ponteiro, foco e offline.
- Falsificação: 15 sabotagens, uma por vez. Todas ficaram vermelhas em `LC_ALL=C` e em
  `pt_BR.UTF-8` (30/30), com controle verde antes e depois na mesma invocação. Na 1ª rodada, a
  sabotagem "redirect sem teto" ficou **verde**, o que mostrou que o teste de ciclo não provava
  o teto (ver Lições). O teste foi trocado.
- Codex (2 chamadas, `-r high`). 1ª: 4 achados (P1×2, P2×2), todos aplicados. 2ª (verificação):
  2 fechados; 1 P2 reaberto (a navegação começando com o prefetch ainda em voo) e 1 P2 novo
  (`payload` primitivo), ambos aplicados. 1 residual aceito: import não-rota que rejeita com o
  MESMO objeto de erro de um prefetch (erro de avaliação compartilhado), que reload não conserta.

## LCP

O baseline em prod (`telemetria_vitals`, 2026-11-03) dá LCP de `/` com p50 de 4.070 ms e p75 de
7.821 ms, n=8, 1 usuário e 6 builds. É pista, não prova.

**O campo não resolve o "depois", e esperar não muda isso** (medido 2026-11-04 11:01Z): em 30 dias a
tabela tem 103 linhas de **1 usuário**, cerca de 1 LCP por build. Os Publish saem a cada poucas
horas e já misturam lotes (o lote 7 entrou no mesmo dia). Dias depois haveria n≈10 de um aparelho
com 2 lotes confundidos. A 1ª amostra pós-Publish (3.964 ms, n=1) é ruído.

**Resolvido por A/B de laboratório (2026-11-04).** Build de produção de `f0ca540a6` (antes) e de
`09d1f52f3` (o merge do lote 6), que diferem só pelo lote 6. Cada build tem seu servidor estático
e cada carga sai de um contexto frio. A sessão falsa fica no localStorage, e o Supabase é
interceptado com 400 ms fixos por requisição: role `master` aprovado e `[]` no resto. Todo
tráfego externo é bloqueado. As cargas alternam antes/depois em 15 pares, mais 1 aquecimento
descartado. Em todas, `/` renderizou (nenhuma terminou em `/auth`), e o elemento do LCP foi um
`<p>`. O p vem de Mann-Whitney.

| perfil | métrica | antes p50 [IQR] | depois p50 [IQR] | Δ p50 | p |
|---|---|---|---|---|---|
| mobile (Slow 4G + CPU 4×) | LCP | 11.384 [11.142–11.648] | 10.640 [10.278–10.786] | **−744 ms** | 0,0006 |
| | LCP − início do auth | 4.257 | 3.413 | **−844 ms** | 0,0001 |
| | pedido do `Index` − início do auth | +537 | −193 | −730 ms | <0,0001 |
| desktop (10 Mbps, 40 ms, CPU 1×) | LCP | 2.896 [2.600–3.634] | 2.456 [2.446–3.542] | −440 ms | 0,10 |
| | pedido do `Index` − início do auth | +426 | −37 | −463 ms | <0,0001 |

- **O mecanismo está provado nos dois perfis:** o chunk da página saiu de "depois do auth" para
  "antes do auth". No mobile, o LCP cai ~0,75 s com significância. No desktop, o ganho (~0,44 s)
  fica dentro do ruído da máquina compartilhada (p=0,10). O absoluto do mobile é alto pelo
  throttling Lighthouse somado à máquina carregada; o que vale é o Δ par a par.
- **O que o F1 NÃO cobre, e é o próximo ganho:** para staff, o elemento do LCP vem do
  `StaffDashboard`, um `lazy` **aninhado** dentro do `Index`. Ele só começa a baixar quando o
  `Index` renderiza, ou seja, depois do auth, nas duas versões. O prefetch de rota só enxerga os
  `lazyRota` da árvore do `App.tsx`. Pré-carregar o lazy interno da página de entrada é outra
  fase, com sinal de produto próprio.
- Limites: o laboratório fixa o auth em 400 ms e usa só a persona master. É medida do
  **mecanismo**, não do usuário real. O script era de scratchpad e não ficou no repo, porque não
  é gate nem sensor. O método está aqui para ser reproduzido.

## Lições

- A árvore de `<Route>` em JSX já é um mapa. `createRoutesFromElements` + `matchRoutes` evitam
  manter uma 2ª lista de caminhos que diverge da 1ª.
- Todo import especulativo passa pelo mesmo `vite:preloadError` da navegação real. Quem recarrega
  precisa saber **quem** pediu o chunk, e contador global de "em voo" não sabe: atribua pelo
  objeto de erro (`payload`).
- O `decodePath` do react-router engole qualquer exceção, inclusive o `RangeError` de estouro de
  pilha. Recursão infinita dentro de `matchRoutes` não lança, só termina. Um teto de recursão se
  prova pelo efeito além dele, nunca por "não lançou".
