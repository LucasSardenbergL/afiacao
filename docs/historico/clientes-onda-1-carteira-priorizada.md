# Clientes (/admin/customers): onda 1, carteira priorizada e estados honestos (2026-11-21)

Segunda rodada de revisão da tela (Fable na lente de produto, Codex na de engenharia) depois do programa
#4027–#4091. A onda 1 junta os defeitos de front que travavam o fluxo da vendedora. A onda 2 (uma ficha
só como destino e a ligação com o cliente de origem) vem num PR próprio. A onda 3 espera sinal de uso.

## O que mudou

1. **A carteira prioriza.** A carteira da vendedora era sempre A–Z (`ordenarPorNome`), e o seletor só
   aparecia na base completa. Agora o `useClientesScope` ordena a carteira em memória com
   `ordenarCarteira`, que espelha a ordem da RPC `listar_clientes_base`: prioridade DESC, ausente no fim
   (`sem_historico` = sentinela, não medida), desempate pela chave do A–Z e depois por `user_id`. O
   seletor aparece nos dois modos. Os ids e o hash dos scores usam a lista crua, então reordenar não troca
   a key nem busca os scores de novo.
2. **Pedido com o cliente certo.** "Novo pedido" na ficha ia para `/sales/new` sem cliente. Agora vai
   para `?customer=`. E o `/sales?customer=` do "Ver todos" deixou de ser ignorado: `useSalesOrders` filtra
   por `customer_user_id` no servidor (o parâmetro entra na queryKey; valor que não é uuid cai em
   "todos"), e a tela mostra o chip "Pedidos de …" com um X para tirar o filtro.
3. **Filtro de saúde com estados próprios.** Enquanto os scores carregavam, ou quando falhavam, o mapa
   vazio fazia "Crítico" dizer "nenhum cliente". Agora o scope expõe `scoresEstado`. Na carteira,
   `estadoFiltroSaude` só aplica o filtro com os scores lidos. Sem eles, a tela avisa
   (carregando, ou falha com "Tentar novamente" que refaz só os scores) e NÃO filtra; a busca por nome
   segue valendo. A prioridade sem scores cai no A–Z e a tela diz isso.
4. **Resumo pré-visita.** "Última ligação" lia de `useCustomerCalls`, que exige transcrição. Agora usa
   `useCustomerLastCall`: a ligação mais recente, com ou sem transcrição. Cada fonte (compra, visita,
   ligação) tem estado próprio (`estadoFonteBrief`). "Nunca comprou" e "nenhuma" só aparecem com a leitura
   bem-sucedida; falha vira "indisponível".
5. **Aba Pedidos da ficha antiga.** O `error` era descartado e a falha virava "Nenhum pedido
   registrado". Agora há erro honesto com "Tentar novamente", as linhas são clicáveis e existe o link
   "Ver todos os pedidos". Os dois vão para `/sales?customer=`, porque o detalhe do pedido é um painel
   do `/sales`, sem deep link. O cartão "Categorias" mostrava "null" e passou a mostrar `—`.
6. **Voltar para a fila de origem.** A ficha leva a fila na URL (`search`/`health`/`ordem`, via
   `queryDaFila`) e a rolagem no `location.state`. A entrada da lista no histórico também ganha a rolagem,
   então o voltar do navegador cai na mesma posição. "Clientes", o voltar e o "Voltar para Clientes" da 360
   devolvem a mesma fila. Helpers puros em `src/components/adminCustomers/navegacao.ts`.
7. **Sensor.** `ModoClientes` separa `carteira_prioridade` de `carteira_nome`. Antes era só
   `carteira`, e é esse valor que agora mede se a VENDEDORA usa a priorização. Evento novo
   `clientes.ficha_acao` (chave `ficha:tipo`; `tipo` ∈ ligar, novo_pedido, abrir_360, ver_pedidos), só
   enums. A allowlist é SQL, então veio a migration `20261121231200_analytics_ledger_clientes_ficha_acao.sql`
   (molde TRAVA → PRE → CREATE → PÓS, md5 novo `4c6e2d58…`), provada em PG17 por
   `db/test-analytics-ledger-clientes-ficha.sh` nos dois locales, com 5 de 5 sabotagens detectadas.
   `db/sensor-clientes-adocao.sql` passou a contar o evento novo.

## Lição

Na 1ª rodada da falsificação, o harness PG17 copiado do anterior ficou vermelho "por OUTRO motivo": nas
sabotagens S2 e S3, a troca de md5 deixava a PRE sem o corpo vivo do momento. O controle verde e as
sabotagens na mesma invocação mostraram que o defeito estava no teste, não na migration. É o caso de
"sempre-vermelha aprova tudo" do CLAUDE.md, ao contrário: sem a leitura do motivo, teria passado por
detecção.

## Como medir (onda 3 só com sinal)

`~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-clientes-adocao.sql`: procure
`lista_aberta`/`cliente_aberto` com modo `carteira_prioridade` por employee (com o denominador) e
`clientes.ficha_acao` por tipo.
