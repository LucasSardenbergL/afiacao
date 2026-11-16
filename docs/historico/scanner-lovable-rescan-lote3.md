# Rescan do scanner Lovable Security — lote 3 (2026-11-15)

Continuação do [lote 2](scanner-lovable-rescan-lote2.md). O lote tem duas partes: os 3 itens que a triagem anterior já tinha separado como reais, e a triagem dos 4 achados que a varredura de 2026-11-14 trouxe de novo. Cada um foi conferido na PROD via `psql-ro` e no código antes de qualquer conserto. Os três não-óbvios passaram pela 2ª opinião do Codex (gpt-6-astra, reasoning high, 82 s).

## O que entrou

| Achado | Correção |
|---|---|
| 🟠 `03689f08`: o `gmail-webhook-receiver` salvava anexo sem limite de tamanho | `gmail-webhook-receiver` v1.1: o corpo é lido em stream com teto de 42 MB e devolve 413 sem alocar o resto. Os tetos são 30 MB por anexo em base64 (o mesmo do extrator), 40 MB por mensagem e 20 anexos. O maior e-mail registrado tinha 11. Estourar um teto recusa a mensagem INTEIRA antes do 1º upload, e ela fica `rejeitado`. Como o dedupe devolve 400 a cada retry, o Apps Script não entra em laço. O ramo de suspensão vem antes do teto, então o alerta de compra não se perde por causa de um anexo grande |
| 🟠 A IA do extrator via vision não tinha cota | `promocao-extrair-via-vision` v1.2: o principal staff consome `ia_consumir_cota` (30/h e 100/dia por usuário). O uso medido teve pico de 11/h e de 12/dia. Cron e service_role (o webhook) não têm usuário e ficam limitados pelos tetos do webhook. O seed vem antes da edge na migration `20261115213000`, porque sem a linha a RPC nega |
| 🟡 O número discado no `nvoip-calls` não era validado | `nvoip-calls` v1.3: aceita só número brasileiro discável (celular com 11 dígitos, fixo com 10 e 0800), com `+55`, `55` ou zero de longa distância, e devolve o formato nacional que a Nvoip já recebia. Recusa internacional, tarifado (0900/0300/0500), código curto e símbolo de DTMF. O número segue **livre**, por decisão do founder (prospecção) |
| 🟠 `ec253a34`: dava para injetar HTML no e-mail de novo pedido | `omie-sync` v1.14: o nome do cliente, o e-mail, o telefone, o documento, o nº da OS e os itens passam por `_shared/escape-html.ts` |
| 🟡 `43bd6b91`: `cobranca_dona` servia de oráculo da carteira | A função é SECDEF, devolve o uuid da dona de qualquer cliente, e authenticated tinha EXECUTE, inclusive customer. Na migration `20261115213100`, as 3 policies SELECT de cobrança passam a usar o booleano `cobranca_sou_dona(company, codigo)`, que só responde pelo próprio `auth.uid()`. O EXECUTE de authenticated em `cobranca_dona` sai, e as 4 funções SECDEF seguem chamando como postgres |

## Triagem dos 4 achados novos

| Código | Veredito | Por quê |
|---|---|---|
| `ec253a34` | **Real**, corrigido | O texto digitado entrava cru no HTML do e-mail da equipe |
| `43bd6b91` | **Real** e baixo (só um uuid), corrigido | O Codex concordou e propôs o conserto do booleano. Um gate "é staff" deixaria o vazamento entre vendedores |
| `7330d2bc` | **Desenho**, aceitar | `rag-search` exige employee ou master, e a RLS de PROD já dá a esses papéis SELECT em `rag_chunks` e `customer_processes`. A edge não amplia nada. É a mesma classe de `1e1b16869`/`84389ac7` |
| `b339bb5b` | **Real**, corrigido em PR próprio (decisão do founder: "quem troca o vendedor responsável pelo cliente sou apenas eu") | Veja a seção abaixo |

## `b339bb5b`: só o master troca a dona da carteira

O vendedor do mapa (`omie_customer_account_map.omie_codigo_vendedor`) decide a dona: o `carteira-rebuild` deriva o `owner_user_id` dele, cruzado com o `omie_vendedor_map`. Na PROD, o employee mexia na posse por 5 caminhos, levantados pelo Fable e pelas 4 rodadas do Codex:

1. a policy ALL do mapa;
2. a RPC `register_carteira_member` (INVOKER), chamada pela tela de aprovações;
3. o `codigo_vendedor` vindo do body no `criar_perfil_local`;
4. a policy ALL do ledger da carteira: excluir um clone ou mudar o `identity_state` e disparar o rebuild muda a dona;
5. a RPC renovando o TTL de 7 dias da view fresca e permutando códigos Omie entre clientes.

Conserto: migration `20261116090000_seg_b339_vendedor_so_master.sql` e `omie-cliente` v1.11.

- A RPC vira SECURITY DEFINER com gate de papel. Servidor e master seguem como antes. O employee admite o cliente, mas não escolhe o vendedor, não renova o TTL e não troca o código de um vínculo existente. Essa última trava fica no `ON CONFLICT ... WHERE`, que é atômico. Customer e qualquer outro papel recebem 42501.
- O mapa e o ledger passam a ter master ALL e staff SELECT. TRUNCATE sai de anon e authenticated nas 4 tabelas da posse, e a escrita sai de anon.
- A edge chama a RPC com o JWT do chamador quando ele não é master, para que o gate valha também pela edge. Sem JWT, falha fechada.

Prova: `db/test-seg-b339-vendedor-so-master.sh` (PG17). O controle A0 mostra o furo de antes, e há 20 asserções com claims avulsas e em JSON. As 9 sabotagens ficaram vermelhas em C e em pt_BR.

**Deploy ([#3912](https://github.com/LucasSardenbergL/afiacao/pull/3912), em 2026-11-16, 2 créditos):**

- Migration pelo envelope, na tentativa #1137. O ensaio fez ROLLBACK com POST-OK. Na validação por fora via psql-ro, a RPC ficou DEFINER com `search_path` vazio e sem anon, as policies novas estão no mapa e no ledger, o TRUNCATE saiu dos papéis de client e as 26.647 linhas ficaram intactas.
- O pacote `fabf12c02964` (`omie-cliente`) saiu contra `56bf1f116`, com 16/16 hashes. O envio estourou o tempo do cliente e não foi reenviado: a mensagem foi achada pelo `list_messages` e acompanhada pelo `get_message`.
- Sonda `db/sonda-seg-b339-20261116.sql`, na tentativa #1141: DEPLOY CONFIRMADO em `v1.11-vendedor-so-master`. O `pendencias:deploy` saiu com exit 0.

**Risco residual, aceito pelo founder ("Sim, deploy assim"):** o employee ainda admite um vínculo NOVO com um código Omie livre. É isso que permite aprovar um cadastro e vender para cliente novo. Se esse código for o que o Omie passou a usar para outro cliente V, o sync deixa de revalidar V e, quando o TTL vence, a dona de V cai para Hunter. O employee não escolhe a dona, mas pode fazer V perder a dona. Fechar isso exige validar o código no Omie, no servidor, antes de o vínculo do employee valer (admissão pendente). É escopo próprio.

## Lições

- **O guard de colisão de migration leu o HEAD de OUTRO checkout.** O `wt:preflight` barrou a migration da cobrança como "EM VOO em 27 worktrees". A causa: o checkout principal estava num HEAD destacado e antigo, sem a `20261031210000_cobranca_fila.sql`, e o guard tomou esse HEAD por histórico. A conferência por worktree (`git status` e grep de migration não commitada) e por PR deu zero concorrência. Foi falso positivo, e não houve dano.
- **A ordem das asserções decide se uma sabotagem antiga continua vermelha.** A prova da cobrança já tinha a sabotagem `revoke_dona` casando no C9e (o estado original). Aplicar a migration nova antes do C9e faria essa sabotagem ficar VERDE, porque o REVOKE novo cobriria o removido. O bloco D entra depois do C9e e antes do C10.
- **Uma sabotagem só prova algo se o dado de base distingue os lados.** A 1ª versão sabotava a policy da promessa, mas V1 já via as 2 promessas existentes, então a sabotagem ficaria verde. A troca foi para a de evento, em que V1 vê 20 de 22.

## Prova

- `db/test-cobranca-fila.sh` (PG17) ganhou o bloco D. D0 fixa a linha de base por papel. D1 confere a ACL. D2 prova que a chamada direta a `cobranca_dona` dá 42501 para customer e vendedora. D3 e D4 provam que as leituras de caso, promessa, evento e fila ficam IDÊNTICAS antes e depois. D5 prova que `sou_dona` responde só pelo chamador, D6 que `registrar` segue funcionando e D7 que a migration é idempotente. O controle tem 68 asserções e 0 falhas. Há 4 sabotagens novas: a da ACL (pega na postcondição), a do helper aberto, a da policy sem o ramo da gestão e a do evento de outro caso.
- Testes Deno: `limites-anexo_test.ts` (9), `numero-destino_test.ts` (5) e `escape-html_test.ts` (2). `test:edges` deu 2645/0.

## Deploy

Pendente: será registrado no PR de sonda.

## Fica para o founder

- Marcar como **aceitos por desenho** no scanner: `7330d2bc`. Também `78952df6` e `f14d9731`, que vêm do lote 2 e são críticos, e por isso só se marcam pela tela de Segurança.
- Marcar como corrigidos, depois do próximo rescan: `03689f08`, `ec253a34`, `43bd6b91` e `b339bb5b`.
- Próximo passo do `b339bb5b`, sem dono ainda: a admissão pendente, com o código conferido no Omie pelo servidor antes de o vínculo do employee valer.
