# Plano v4, lote 10 — zonas da home em paralelo e memo medido (2026-11-02)

Itens C2 (fatia 2) e C8 de `docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md`.

## C2 fatia 2 — leituras independentes das zonas saem juntas

As zonas Sistema, Vendas, Estoque, Reposição e Financeiro (`src/hooks/dashboard/use*Zone.ts`) faziam
3–4 `await` em série, um por KPI, sem que nenhum usasse o resultado de outro. Cada bloco virou uma
função `ler*` e o `queryFn` faz `await Promise.all([...])`. Tintométrico já era paralelo.

- **Falha sem mudar de cara.** Os blocos que engoliam a falha seguem engolindo (o `Promise.all` nunca
  rejeita por eles). Na Vendas só a leitura do dia lança, com a mesma mensagem do ramo. Na Sistema
  cada bloco segue degradando só o seu KPI (`erroAprovacoes`/`erroStaff`).
- **Ficou em série o que depende:** o lote de `profiles` do topo da Vendas espera os `user_id` do
  `orders`.
- **Achado do paralelismo (consertado aqui):** o topo da Estoque era UMA lista com `push` de dois
  blocos. Em paralelo, a ordem (NF antes de FEFO) passaria a depender de quem responde primeiro.
  Agora são duas listas concatenadas em ordem fixa.
- Os `count ?? 0` silenciosos de Estoque, Reposição e Vendas (orçamentos) seguem como estavam. Mudar
  isso altera a semântica de falha, e este lote não podia.

Teste: `src/hooks/dashboard/__tests__/zonas.paralelo.test.tsx`. O supabase de mentira segura toda
resposta. Em série, só a 1ª leitura aparece como iniciada. Os casos de falha soltam as respostas
fora de ordem. Falsificação com controle verde na mesma invocação, em `LC_ALL=C` e `pt_BR.UTF-8`:
8/8 sabotagens reprovaram no teste certo (as 5 zonas de volta à série, o topo da Estoque em ordem de
chegada, a Vendas engolindo a falha do dia, blocos da Sistema cruzados).

## C8 — memo só onde o React Profiler mediu ganho

O parecer cortou C8 por falta de perfil. Agora há perfil: `<Profiler>` sobre a página real (jsdom, build
dev), mediana de 15–20 repetições, 3 rodadas cada, contagem de render por instrumentação temporária
(não commitada). O volume vem de prod: no máximo 10 pedidos por ciclo e 23 itens por pedido (90 dias).

| Cenário | Antes | Depois |
|---|---|---|
| `AdminReposicaoPedidos`: abrir+fechar itens de 1 linha (10 pedidos) | 20 renders de `PedidoRow`, 9,4 ms | 2 renders, 6,2 ms |
| `AdminReposicaoPedidos`: abrir+fechar "Histórico de hoje" | 26 renders, 7,4 ms | 3 renders, 3,8 ms |
| Sidebar: navegar entre 2 rotas (master, 34 itens visíveis) | 34 renders de `SidebarItem`, 2,93 ms | 2 renders, 1,56 ms |

- `PedidoRow` virou `memo` e os callbacks recebem o pedido, então a página passa a mesma função a
  todas as linhas (`useCallback`; o `mutate` do TanStack v5 é estável, o objeto da mutação não).
- `SidebarItem` virou `memo`. O detalhe: o `useNavigate` do react-router 6 troca de identidade a cada
  rota, que é exatamente quando o memo tem de valer. Os itens recebem um `irPara` estável que lê o
  `navigate` atual por ref.
- Os números absolutos são do jsdom, não do browser. O que se transporta é a proporção e a contagem
  de renders.
