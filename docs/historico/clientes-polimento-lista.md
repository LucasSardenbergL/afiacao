# /admin/customers: polimento da lista (2026-11-21)

Continuação de #4027, #4028, #4032/#4036 e #4044. Só front: sem migration e sem edge, falta só o Publish.

**Contagem honesta.** `useClientesScope` fazia `return count ?? 0`, e a tela mostrava "0 clientes na base" quando o PostgREST devolvia `count: null`. Antes da contagem chegar, também caía em `customers.length` e mostrava esse número como se fosse o total da base. Agora `total` é `number | null` e só vem preenchido quando a fonte confirma o número. Na base, isso é o `count` do servidor. Na carteira, é a carteira inteira depois que a query dá sucesso. O estado novo `contagemPendente` separa os casos de `null`. O helper puro `rotuloContagem` (`config.ts`) monta o texto:
- confirmado: "16.099 clientes na base" ou "N clientes na carteira";
- pendente: "N clientes carregados";
- `null` sem pendência: "contagem indisponível".

O rodapé "Todos os clientes carregados (N)" agora conta `customers.length`, que é exatamente o que está na tela, e não o count.

**Rótulos.** "Gasto mensal" passou a ser "Média mensal (180d)", na coluna da lista e no `MetricCard` do 360. O filtro de saúde trocou os emojis por um pontinho de cor com os tokens `status-*`. Saiu o avatar genérico com o ícone `<User>`, que não dizia nada. A coluna "Prioridade" ganhou um tooltip em linguagem de vendedor: a nota ordena quem contatar primeiro e junta risco de perda, recompra e meta; "—" quer dizer sem histórico de compra, ou seja, fora da fila de recompra. O tooltip tem um `TooltipProvider` local, porque o Radix exige um e os testes renderizam a lista sem o `App`.

**Motivo do contato.** Uma linha sob o nome mostra o motivo, por exemplo "Atenção · 66d sem compra", e aparece também no celular, onde as colunas somem. Vem do helper puro `motivoContato`, que usa `classeSaudeExibida` e `metricasExibiveis`:
- `sem_historico` mostra "Sem histórico de compra", sem os 999d sentinela;
- sem recência medida, mostra só a classe e não inventa dias;
- `0d` medido aparece como `0d`;
- sem score, a linha não aparece.

**Prova.** `__tests__/polimento-lista.test.ts` cobre a lógica pura e `CustomerListView.test.tsx` cobre o render. A falsificação rodou depois do commit, na mesma invocação: controle verde, três sabotagens vermelhas (rótulo com 0 fabricado, dias fabricados, linha de motivo escondida) e controle final verde.

**Lacuna conhecida.** O `?? null` do hook não tem teste unitário próprio. O hook não é testado isoladamente, e a tela recebe `total` por prop.

**Fora desta entrega.** O churn 100 de `sem_historico` fica para uma entrega própria de edge e money-path. A chave A–Z normalizada para nomes sujos do Omie também fica de fora.
