# Clientes (/admin/customers): onda 3, último contato na lista e ação na ficha 360 (2026-11-22)

Fecha a 2ª rodada de revisão da tela (ondas 1 e 2: `clientes-onda-1-carteira-priorizada.md` e
`clientes-onda-2-ficha-unica.md`).

## ⚠️ Entrou SEM sinal da fase anterior (decisão do founder)

`docs/historico/fase-sem-sinal.md` pede sinal de uso com denominador antes da fase seguinte. Em
2026-11-22, o sensor (`db/sensor-clientes-adocao.sql`) mostrou denominador = 1 master e 0 vendedoras. O
Lucas pediu a onda 3 mesmo assim. Por isso as ações novas nascem com sensor: `clientes.ficha_acao` com
`ficha:'360'` e `tipo` `registrar_desfecho`/`criar_tarefa`. Esse evento já está na allowlist, então não
houve migration. O desfecho em si continua medido por `venda.contato_registrado`.

## O que mudou

1. **Último contato na lista.** Cada linha mostra "contato há Nd · desfecho". A leitura é UMA, em lote,
   dos clientes da tela (`useUltimoContato`), em chunks de 200 com paginação, nunca uma por linha. As
   fontes são `venda_contato` (ficha de ligação e Fila do Dia) e `route_contact_log` (lista por rota),
   numa janela de 180d. `farmer_calls` está vazia em prod, e `v_carteira_sla` deriva dela, então
   nenhuma das duas serve. Ausente ≠ zero: sem registro → "sem contato registrado em 180d"; falha →
   "último contato indisponível". Pela RLS, a vendedora vê os PRÓPRIOS registros em `venda_contato`; o
   master vê todos.
2. **Desfecho na 360.** Reusa `BotoesContato` (RPC `venda_registrar_contato`, guarda de lente), mas só
   quando o cliente está na carteira ELEGÍVEL do usuário REAL. É o mesmo gate da RPC, que daria 42501.
   Fora disso, a ficha diz por quê. Registrar invalida o último contato da lista e a timeline da 360.
3. **Próxima ação na 360.** Mostra as tarefas abertas do cliente (`useTarefasAbertasDoCliente` sobre
   `v_tarefas_estado`): atrasadas primeiro, depois o prazo. A lista vazia diz "nenhuma tarefa aberta
   visível para você", porque a RLS filtra por responsável/criador. O botão "Tarefa" abre o
   `CriarTarefaDialog` para o próprio usuário, com empresa `oben` (o mesmo default explícito da tarefa
   por voz).
4. **Crédito na 360.** Não existe LIMITE de crédito no banco, e nada se chama "limite". A ficha afirma
   o vencido há 60+ dias (a régua do alerta do pedido) nas 3 empresas, via `useCreditoDoCliente`:
   `omie_customer_account_map_fresco` → pares (company, código) → `fin_contas_receber`, somando também
   os aliases fiscais ATIVOS (`customer_canonical_alias`). Alias em `conflict` = identidade ambígua →
   não soma. A RLS dos aliases só abre para gestor/master: os demais leem sem eles, e a ficha avisa que
   a soma pode ser parcial. Sem conta mapeada → "sem conta Omie vinculada"; falha → "indisponível";
   sync defasado → avisa com a data. Quem abre a 360 é staff e passa em `fin_user_can_access`, então
   "nenhum título vencido" é leitura positiva.
5. **Fronteiras.** O sensor da tela foi para `src/lib/nav/sensor-clientes.ts` (plataforma), e a 360 mede
   sem aresta. A página `Customer360` compõe os módulos donos (tarefas e financeiro) e passa as leituras
   ao `AcoesDaFicha`, que só apresenta. As 3 arestas da página (`CriarTarefaDialog`, `useTarefas`,
   `useAlertaCreditoCliente`) foram registradas conscientemente, no molde da `VozTarefaDialog`.

## Provas

- Falsificação na MESMA invocação: controle verde e depois **12 de 12 sabotagens vermelhas**: falha virando
  "sem contato", último = primeiro, ausente virando "hoje", lista sem a linha, crédito com falha virando
  ok, sem conta virando ok, sem aviso de soma parcial, atrasada ignorada, botões fora da carteira,
  carteira sem o filtro de dono, tarefa com falha virando "nenhuma", e pares aceitando a conta `servicos`.

## Como medir (a régua da próxima fase)

`db/sensor-clientes-adocao.sql` (o detalhe `ficha:tipo` de `clientes.ficha_acao` mostra
`360:registrar_desfecho` e `360:criar_tarefa`). Sinal mínimo: ≥1 vendedora no denominador usando
desfecho ou tarefa a partir da 360. O ledger retém ~7 dias, então rode dentro da janela.
