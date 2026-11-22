# Clientes (/admin/customers): onda 2, uma ficha só como destino e ligação com o cliente de origem (2026-11-22)

Continuação da 2ª rodada de revisão da tela (Fable na lente de produto, Codex na de engenharia). A onda 1
está em `clientes-onda-1-carteira-priorizada.md` (#4105). A onda 3 (último contato na lista, desfecho na
ficha, próxima ação, crédito na ficha) espera sinal de uso. O sensor `clientes.*` está no ledger.

## O que mudou

1. **Uma ficha só como destino (item 8).** A lista de Clientes abria `/admin/customers/:id`, a ficha
   mais pobre, enquanto a carteira, a positivação, a busca global e os follow-ups abriam `/:id/360`. A
   agenda do dia, o histórico da telefonia e o dashboard do farmer também caíam na ficha antiga. Agora todos
   abrem a **360**. A lista passa a fila de origem (busca, saúde, ordem e rolagem) no `state`, então o
   "Clientes" da 360 volta para a mesma fila.
   As duas fichas NÃO foram fundidas. A ficha antiga virou **"Cadastro e ferramentas"** (ferramentas,
   exige-OC, abas Chamadas, Visitas, Processo e Contatos). Ela abre pela `IdentityColumn` da 360: há um
   botão "Cadastro e ferramentas" e também "Gerenciar contatos"/"Adicionar contato". Os três levam a fila
   (`urlCadastroCliente` + `estadoComOrigem`), então o "Clientes" do Cadastro volta para a mesma lista. A
   previsão de demanda também abre a 360. O deep link `/admin/customers/:id` continua funcionando.
   O helper de navegação saiu de `adminCustomers/navegacao.ts` para `src/lib/nav/clientes.ts`
   (plataforma). Com isso, a aresta `pages/Customer360.tsx → adminCustomers/navegacao.ts`, registrada na
   onda 1, saiu da baseline de fronteiras. A sessão irmã "clientes-onda-2" achou esse ponto, os links da
   `IdentityColumn` e a previsão de demanda; o código veio do commit local dela, c14e8e078.
   ⚠️ Esse bloco (helper em `lib/nav`, links da `IdentityColumn`, previsão de demanda e o denominador
   abaixo) foi enviado DEPOIS do merge automático do #4110 e ficou órfão na branch. Ele entrou num PR de
   follow-up. Lição: depois de abrir o PR, todo push extra precisa entrar antes do merge automático.
   Confira `gh pr view --json state` antes do push.
2. **Ligação com o cliente de origem (item 9).** O `CallButton` recebia só nome e telefone, e o
   `resolveCustomerByPhone` resolvia o cliente de novo pelo número. Com telefone compartilhado (19% dos
   clientes), a ligação feita da ficha do próprio cliente ia para a conferência sem dono. Agora
   `CallButton`/`Dialer` → `WebRTCDialer` → `makeCall(phone, { clienteOrigemId })`. O id segue como
   **candidato** para o `resolveCallParty` (call log) e para a sessão gravada (`farmer_calls`). A agenda
   do dia passa o id também. A regra pura é `decidirDonoComOrigem`:
   - número desconhecido continua desconhecido (sair da ficha não transforma o número em cliente);
   - dono único = candidato → ele;
   - dono único ≠ candidato → **divergência → sem dono** (conferência em `/farmer/calls/pending-link`),
     sem herdar nome ou cargo do contato do outro cliente;
   - número compartilhado → o candidato **só** se o número for dele (contato ou perfil, só dígitos, sufixo
     de 8) **e** ele estiver na carteira elegível de quem liga. Leitura falhou → sem dono.
   A evidência é lida com a RLS do usuário REAL. Sob a lente "Ver como", o `makeCall` já recusa na
   fonte, porque o WebRTC fura o write-guard (`docs/agent/impersonation.md`). Não houve SQL: a RPC
   `resolver_cliente_por_telefone` continua sendo a fonte do reconhecimento.
   **Denominador hoje = 0.** Em prod, em 2026-11-22 (psql-ro), `farmer_calls` tinha 0 linhas e
   `call_log` tinha 20 (de 2026-05-28 a 2026-06-09): nenhuma ligação gravada virou registro até agora. O item 9 previne um defeito que
   ainda não aconteceu. É barato e fica com teste, mas o efeito só se mede quando houver ligações.
   Acompanhamento:
   `SELECT count(*) AS ligacoes, count(*) FILTER (WHERE customer_user_id IS NULL) AS sem_cliente FROM public.farmer_calls;`

## Provas

- vitest: `resolve-customer.origem.test.ts` (regra pura e wiring das leituras), `WebRTCDialer.test.tsx`
  (o id chega ao `makeCall`), `WebRTCCallContext.fim-remoto-persiste.test.tsx` (o id vai ao party E ao
  persist; ligação recebida vai sem candidato) e `AdminCustomers.busca-deeplink.test.tsx` (a lista abre a
  360 com a fila), `IdentityColumn.cadastro.test.tsx` e `lib/nav/__tests__/clientes.test.ts`.
- Falsificação na MESMA invocação: controle verde e depois **10 de 10 sabotagens vermelhas** (carteira
  ignorada, telefone ignorado, divergência mantendo o outro dono, sem filtro de dono da carteira, sem filtro
  de `eligible`, candidato não repassado, contexto sem repassar ao persist, contexto sem repassar ao
  party, dialer sem repassar, lista voltando à ficha antiga). Na integração do helper e dos links:
  controle verde e **4 de 4 vermelhas** (Cadastro sem a fila na URL, sem o state, "Adicionar contato" com
  link cru, 360 voltando a importar de `adminCustomers`).

## Fora de escopo

- A 360 não mede `ficha_acao` (`ficha:'360'`): instrumentar a 360 a partir de `adminCustomers/` abriria
  outra aresta de fronteira. Fica para quando o sinal da onda 1 pedir.

## Deploy

Só front: **Publish** no Lovable. Sem migration e sem edge.
