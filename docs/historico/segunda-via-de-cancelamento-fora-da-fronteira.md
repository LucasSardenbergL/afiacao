# A segunda via: fechar o guard numa fronteira não fecha as outras portas dela

> Entrega de 2026-09-06. Fecha o `[P1]` do parecer Codex do #2204 na via que nem o #2204 nem a
> migration `20260905224959` (guard atômico de `cancelar_pedido_sugerido`) cobriram.
> Artefatos: `supabase/migrations/20260906105549_remover_itens_pedido_guard.sql`,
> `src/components/reposicao/pedidos/remover-itens-pedido.ts`,
> `db/test-remover-itens-pedido-guard.sh` (41 asserts, verdes nos dois locales).

## O achado

O #2204 criou a "fronteira única" do cancelamento humano (`rejeitar-pedido.ts` → RPC
`cancelar_pedido_sugerido`) e a `20260905224959` fechou o TOCTOU **dentro** dessa RPC. Ficou de pé
uma **segunda via**, no modal de detalhes: `useDetalhesModal.recalcularPedido` gravava por `UPDATE`
cru via PostgREST exatamente os mesmos campos — `status='cancelado_humano'`, `cancelado_por`,
`cancelado_em`, `justificativa_cancelamento`, `status_envio_portal='nao_aplicavel'`,
`portal_proximo_retry_em=null` — **espelhando à mão** o que a RPC faz, sem passar por ela.

Sem guard de status no servidor. O único freio era `podeEditar`, no cliente:
`status === 'pendente_aprovacao' || status === 'bloqueado_guardrail'`, avaliado sobre o
`pedido.status` que o browser tem em mãos e que pode estar minutos velho. É literalmente o segundo
`[P1]` do Codex no #2204 — *"a allowlist não é política de servidor; ela valida apenas o status
potencialmente obsoleto vindo do browser"* — na via que o #2204 não cobriu.

**A lição de método:** procurar a fronteira pelo NOME (quem chama a RPC) é cego para quem
**reimplementa** a operação. A busca que teria achado isto no #2204 é pelos EFEITOS —
`git grep "cancelado_humano"`, `git grep "justificativa_cancelamento"` — não pelo nome da função.
Toda vez que uma fronteira nasce, vale varrer os *campos que só ela deveria escrever*.

## O que a tarefa original não previa: o dano começa antes do cancelamento

As **três** vias do modal (remover item, remover em lote, descontinuar SKU) chamavam
`DELETE FROM pedido_compra_item` **antes** do recálculo, também sem guard. Fechar só o cancelamento
deixaria metade do dano de pé: um pedido `disparado` ficaria com itens faltando — divergência
silenciosa contra o pedido real no fornecedor, e sem carimbo nenhum. A edge
`disparar-pedidos-aprovados` **lê** `pedido_compra_item` para montar o `IncluirPedCompra`
(3 ocorrências, todas SELECT — medido em 2026-09-06), então a janela é real.

Por isso a unidade atômica virou **remoção + recálculo + cancelamento-se-vazio**, numa RPC só.

## As quatro correções que vieram do Codex (gpt-6-astra · max, 224s, 78k tokens)

Eu tinha um desenho pronto. O parecer derrubou três pedaços dele — vale registrar os erros, não só
o resultado:

1. **Minha justificativa para a RPC irmã estava errada.** Eu argumentei que adicionar parâmetro
   viraria overload ambíguo no PostgREST. **O PostgREST suporta overloads com aridades diferentes**;
   a armadilha real são defaults sobrepostos e assinaturas iguais diferindo só no tipo. A razão que
   se sustenta é **semântica**: remover itens é operação distinta de cancelar, e seus estados
   permitidos são legitimamente diferentes — copiar o predicado do cancelamento "para não divergir"
   seria justamente o erro.

2. **Denylist → allowlist.** Meu predicado era `NOT IN ('disparado','concluido_recebido')`, copiado
   do cancelamento. Ele **deixaria remover item de um pedido `aprovado_aguardando_disparo`** — que é
   exatamente o estado que o disparador seleciona para chamar o ERP. O predicado certo é
   `IN ('pendente_aprovacao','bloqueado_guardrail')`: a allowlist do cliente virando política de
   servidor, sem estreitar o produto (é o mesmo conjunto do `podeEditar`).

3. **O guard não precisa estar no `WHERE` da primeira escrita — mas então precisa de LOCK.** A
   `20260905224959` pôde pôr o predicado no `WHERE` porque lá a escrita é uma só. Aqui são três, e o
   predicado vive em **outra tabela**. Um `EXISTS (SELECT … FROM pedido_compra_sugerido)` no `WHERE`
   do `DELETE` **não resolve**: o EvalPlanQual re-avalia a linha ALVO travada (o item), não o
   subselect sobre outra tabela. A forma correta é `SELECT … FOR NO KEY UPDATE` no pai **antes** de
   qualquer escrita: o lock mantém a decisão válida até o commit.
   E **`FOR NO KEY UPDATE`, não `FOR SHARE`** — com SHARE dois removedores adquirem o lock juntos e
   **deadlockam na promoção** quando ambos forem atualizar o pai. `FOR KEY SHARE` é insuficiente.

4. **`RETURN jsonb {'error'}` depois de um `DELETE` não desfaz o `DELETE`.** O PostgREST commita a
   transação que termina sem erro SQL. Depois da primeira escrita, toda falha vira `RAISE`.
   Corolário aplicado: um `UPDATE` que pega **zero linhas** (RLS de escrita) não pode retornar `ok`.

## Duas descobertas que só apareceram ao FALSIFICAR

O harness só ficou honesto depois de duas correções que a própria falsificação expôs:

- **`CREATE OR REPLACE` PRESERVA o ACL.** A sabotagem "remove o `GRANT`" não fazia a postcondição
  gritar, porque o privilégio sobrevivia da aplicação anterior. Sem `DROP` antes de cada variante, os
  asserts de ACL eram **sempre-verdes** — teatro. Agora `aplica_variante()` dropa a função primeiro.
- **O harness precisa reproduzir os DEFAULT PRIVILEGES do Supabase.** Num PG17 limpo,
  `REVOKE … FROM PUBLIC` já basta para tirar `anon`, e a sabotagem do `REVOKE … FROM anon` ficava
  sempre-verde. Na PROD **não é assim**: medido no pré-voo, o ACL de `cancelar_pedido_sugerido` traz
  `anon=X/postgres` — um grant **explícito**, exatamente a armadilha que o CLAUDE.md descreve
  (*"`REVOKE FROM PUBLIC` NÃO tira `anon`/`authenticated`"*). Sem
  `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE … TO anon, authenticated, service_role` no setup, o
  harness estaria provando **um ambiente que não existe**.
  O simétrico também apareceu: com os default privileges reproduzidos, apagar a linha do
  `GRANT … TO authenticated` passou a ser inócuo — a sabotagem que testa o assert é **revogar**, não
  apagar uma linha redundante.

## As outras escritas do modal (a varredura pedida)

`recalcularPedido` gravava `valor_total`/`num_skus` junto com o cancelamento. Esses dois são
**recálculo legítimo** e continuam sendo gravados nos **dois** ramos da RPC — o guard condiciona o
*carimbo de status*, não o derivado. Varrendo o resto do modal, sobraram dois `UPDATE` em
`pedido_compra_sugerido`, ambos **pré-existentes e fora desta fatia**:

| Onde | Grava | Veredito |
|---|---|---|
| `salvarMutation` | `valor_total` após editar quantidades | legítimo; sem carimbo de status |
| `salvarCondicaoMutation` | condição de pagamento, parcelas | legítimo; sem carimbo de status |

Os dois também decidem por `podeEditar`/`podeEditarCondicao` no cliente, então tecnicamente são a
mesma classe — mas o dano é de outra ordem de grandeza: gravar um número derivado num pedido
disparado é divergência de valor, não um cancelamento carimbado sobre uma compra real. Ficam
registrados aqui, **não corrigidos nesta fatia**.

Por isso o gate textual do teste proíbe `UPDATE` que grave **`status:`** na tabela, e não qualquer
`UPDATE` — um gate mais largo ficaria vermelho por causa desses dois e seria desligado na primeira
manutenção. O próprio gate é falsificado no teste (uma amostra proibida tem de casar, uma legítima
não), senão uma regex com erro de escrita seria sempre-verde.

## O que esta entrega NÃO fecha (dito para não ser lido como fechado)

1. **O efeito externo no Omie.** O lock serializa o banco, não o ERP. Se o disparador já leu os itens
   e está dentro do `IncluirPedCompra`, a compra acontece. A allowlist estreita muito a janela (o
   disparador não seleciona `pendente_aprovacao`/`bloqueado_guardrail`), mas *estreitar* não é
   *fechar*. Fechar é o claim atômico no disparador — o cenário B de
   [guard-fora-da-escrita-nao-e-guard.md](guard-fora-da-escrita-nao-e-guard.md), ainda aberto.
2. **`aprovar_pedido_sugerido` tem o MESMO TOCTOU** — verificado na PROD em 2026-09-06:
   `SELECT * INTO … WHERE id` → valida → `UPDATE … WHERE id`, sem repetir o predicado e sem lock.
   Uma aprovação concorrente pode esperar este lock e gravar `aprovado_aguardando_disparo` **por
   cima** do cancelamento. Mesma classe de defeito, outra função, outra fatia.
3. **Esta é fronteira de APLICAÇÃO, não de PRIVILÉGIO.** Sendo `SECURITY INVOKER`, não dá para
   revogar `DELETE` de `pedido_compra_item` do `authenticated` para forçar a passagem — isso
   quebraria o `DELETE` executado pela própria função. Um cliente antigo ainda escreve direto.

## A prova

`db/test-remover-itens-pedido-guard.sh` — 41 asserts, `exit 0` em `LC_ALL=C` **e** em
`HARNESS_LC=pt_BR.UTF-8` (o controle do eixo confirma que a língua do servidor mudou de fato).
Grupos: **P** positivos · **N** negativos (inclui `aprovado_aguardando_disparo`, o caso que uma
denylist deixaria passar) · **A** ACL · **V** vazamento entre pedidos · **R** a CORRIDA · **F**
falsificação.

O grupo **R** é o centro, com barreira **observada** (não `sleep`): o orquestrador polla
`pg_blocking_pids` até **ver** a segunda conexão bloqueada, e só então libera a primeira.
- **R1 = baseline do bug**: a via CRUA transcrita do front carimba `cancelado_humano` sobre o pedido
  que acabou de virar `disparado`. Sem R1 vermelho, R2 verde não provaria nada — poderia significar
  só que a corrida nunca aconteceu.
- **R2 = a fronteira** na mesma corrida: espera o lock, relê `disparado`, recusa, não toca a linha.
- **F7 falsifica o próprio R2**: corrida idêntica, mas o bloqueador leva o pedido a um status **ainda
  dentro** da allowlist → a fronteira **aceita**. Verde aqui + verde em R2 prova que a recusa de R2
  veio do **status relido**, não do simples fato de ter esperado no lock.
