# Radar — pacote A: defeitos da fila do vendedor (2026-11-06)

Contexto: nenhum vendedor usou o Radar em 60 dias, e o próximo passo do founder é um piloto com um vendedor.
Duas revisões independentes da main (Codex xhigh e Fable) acharam defeitos que fariam o piloto tropeçar.
O pacote A corrige esses defeitos e mexe só no front. O pacote B (entrada do vendedor, com migration) vem em
outro PR.

## O que mudou e por quê

| Item | Defeito | Correção |
|---|---|---|
| A1 | "Próximo" no fim dos 50 carregados voltava ao 1º lead (sem `fetchNextPage`) | `src/lib/radar/fila.ts` decide entre abrir o próximo, buscar a página seguinte ou encerrar. No fim de verdade a ficha fecha com o aviso "Fim da fila". Nunca volta ao topo. Se o lead aberto saiu da lista, segue da posição dele |
| A2 | O descarte em lote não invalidava `['radar','amostra']`: o lead de controle descartado seguia na fila | `src/lib/radar/invalidar-cache.ts` é a invalidação única: tudo sob `['radar']`, e no lote a lista recomeça do topo |
| A3 | Sair e voltar à tela com um lote em voo deixava a tela nova presa em `aguardando` | O estado do lote virou um store por usuário (`useSyncExternalStore`), observado por toda instância do hook |
| A4 | O botão da ficha abria a confirmação com o lead já no Omie e sem checar `cadastravelNoOmie` (lead baixado ia à edge). O erro era genérico | `useCadastroOmieComRecuperacao` concentra resultado e recuperação, compartilhado com a oferta pós-sinal. Há trava síncrona por CNPJ (P2 do Codex) |
| A5 | Uma falha na página seguinte apagava a lista. A copy citava um "modo de ataque" inexistente | A lista é preservada e o rodapé oferece "Tentar carregar mais". O vazio oferece "Limpar filtros", e o erro sem página oferece "Tentar de novo" |
| A6 | `vista` entrava nos filtros: Lista↔Mapa apagava a seleção e relia a fila | A apresentação fica separada dos dados |
| A7 | No desktop, o "Ligar" abria o softphone, e a telefonia está congelada até 10/01/2027 | `RadarTelefoneAcao`: copia o número no desktop e mantém `tel:` no celular. Saiu o "Criar tarefa pra mim" (tarefas congeladas) |
| A8 | A copy prometia mais do que o dado sustenta | "Cadastros novos no Omie", "Revendas de tinta registradas (CNAE)", fonte das 3 contas no mapa, "última presença: … · ausente no lote atual" |

## Lições

- **A página da fila não tinha teste, e foi por isso que o A1 passou.** `src/pages/__tests__/RadarClientes.test.tsx`
  roda a página com react-query DE VERDADE: a lista é um `useInfiniteQuery` sobre páginas falsas e a amostra usa
  a chave e o staleTime reais. Com isso, paginação, erro de página seguinte e invalidação se comportam como em
  prod. Cada correção foi sabotada uma a uma, com o controle verde na mesma invocação, e deixou vermelha a
  asserção dela.
- **Estado de runner que sobrevive ao unmount precisa morar fora do componente E ser observável.** Uma trava
  global (`Set`) com um `useState` local é meia solução: a instância nova sabe que algo roda, mas nunca vê o fim.
- **Trava de UI por `useState` não exclui.** Ela só informa. Retry de toast e nova confirmação são caminhos
  paralelos, e a exclusão tem de ser síncrona e compartilhada (por CNPJ).
