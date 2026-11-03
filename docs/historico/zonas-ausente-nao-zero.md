# Zonas Estoque, Reposição e Vendas: "—" em vez de 0 fabricado (2026-11-02)

Continuação do lote 10 do plano v4. O lote 5 (N3) consertou a zona Sistema; o plano não listava
as outras, e a revisão do lote 10 achou o mesmo padrão em mais 6 KPIs da home staff.

## O defeito

O supabase-js **devolve** o erro (`{ data: null, count: null, error }`), não lança. Os blocos das
zonas tinham `try/catch` e faziam `x = count ?? 0`: o `catch` nunca via a falha e o KPI afirmava
"0" com a mesma cara de um zero medido. A lista de topo vazia por falha dizia "Sem pendências".

| zona | KPI | era |
|---|---|---|
| Estoque | NF pendentes | 0 (o `if (nf)` pulava com `data null`) |
| Estoque | Picking abertos | `count ?? 0` |
| Estoque | Conferidas hoje | `count ?? 0` |
| Reposição | Sugeridos prontos | `count ?? 0` |
| Reposição | Alertas ativos | `count ?? 0` |
| Reposição | Aumentos 7d | `count ?? 0` |
| Vendas | Aguardando (orçamentos) | `count ?? 0` |

## O conserto (mesma regra do lote 5)

- Cada bloco lança o próprio erro com a marca do ramo (`tabela (rótulo): mensagem`) ou
  `… — malformada` quando vem null sem error. O valor fica `null` → KPI "—".
- O cartão de prioridade não dispara com contagem que ninguém leu.
- A lista de topo que falhou mostra `AvisoLeituraFalhou` (`testId="aviso-topo-falhou"`) no lugar de
  "Sem pendências". Com parte lida (Estoque junta NF e FEFO), mostra o que veio **e** avisa.
- Na Reposição, uma severidade do topo que falha invalida a lista inteira: sem os críticos ela
  parecia completa.
- O hook expõe `erros` (por bloco) e `erroTopo`. A falha da leitura do dia na Vendas continua
  derrubando a zona inteira (card de erro), como antes.

Fora: o nome do cliente no topo da Vendas ainda cai em "Cliente" se a leitura de `profiles` falhar
(rótulo, não número).

## Prova

`src/hooks/dashboard/__tests__/zonas.ausente-nao-zero.test.tsx` (29 testes): erro e malformada por
KPI, casando a mensagem do ramo; zero medido segue "0" (controle); telas com aviso e sem.
Falsificação com controle verde na mesma invocação, em `LC_ALL=C` e `pt_BR.UTF-8`: 10/10
sabotagens reprovaram no teste certo (o `throw` do erro tirado em 5 blocos, o KPI de volta a
`?? 0` em 2, `nfPendentes` começando em 0, os avisos de topo desligados em 2 telas).
