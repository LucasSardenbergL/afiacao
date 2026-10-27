# process-nfe: trilha, relógio do Omie e regra de quantidade (plano v3, item 1)

**Data:** 2026-10-21 · **Edge:** `supabase/functions/process-nfe` `v2.0-trilha-relogio-regra-quantidade` · **Migration:** `20261021175441_nfe_recebimento_manual_trilha.sql` · money-path/estoque.

## Por que

A aba "Manual" de `/admin/estoque/recebimento` chama a `process-nfe`, que conclui o recebimento **no Omie** (`AlterarRecebimento` → `AlterarEtapaRecebimento` etapa 40 → `ConcluirRecebimento` = entrada de estoque e fiscal no ERP). O founder decidiu (2026-10-21, respostas do plano v3) que o recebimento deixa de ser feito direto no Omie, e esta aba vira caminho oficial. Ela tinha três problemas: `fetch` sem teto de tempo, nenhum registro no banco (o histórico ficava no `localStorage`), e a quantidade calculada como `Math.round(nQtdeNFe / fator)`, com o fator caindo para `|| 1`.

## O caso real que decidiu a regra

Medido em prod via `psql-ro`:

- 3.765 de 4.118 recebimentos concluídos no Omie (91%) têm quantidade recebida ≠ quantidade da NF (`sku_leadtime_history`). A Sayerlack fatura em **litro** e o estoque é em **unidade**: 3.676 pares L→UN, com fatores 18 / 3,6 / 0,9 / 0,81 / 5.
- NF **000955811** (Oben, Sayerlack, pendente), seq 5, PRD03454: `nQtdeNFe = 54` L, e o próprio Omie já pré-preenche `itensAjustes.nQtdeRecebida = 3` UN (`recebimento_associacao_sombra`, que lê esses dois campos das NF pendentes).
- O `nFatorConversao` é opcional no payload (spec 2026-06-04), e o recorte real de 14/10 (`omie-sync-nfes-recebidas/associacao_test.ts`) não traz esse campo: 1 L → 0,055556 UN.

A regra antiga mandaria 54 UN (fator ausente, 18× a mais) ou 972 UN (fator multiplicativo 0,055556 usado como divisor). Nos dois casos ela **sobrescrevia** o número certo que o Omie já tinha calculado. O `Math.round` também cortava a fração da NF sem conversão (2,43 L → 2 L).

## O que mudou

1. **Regra explícita** (`regra-quantidade.ts`): a edge não calcula conversão.
   - Unidade da NF ≠ unidade de estoque: manda o número que o Omie converteu.
   - Mesma unidade: manda a quantidade da NF, exata.
   - Recusa a NF inteira, sem escrever nada, nestes casos:
     - conversão sem o número do Omie;
     - conversão com o número do Omie **igual** ao da NF. Medido: `THINNER NITRO DN.4260L5`, lata de 5 L, entrou 20 L → 20 UN; `SELADORA …00LT`, 90 L → 90 UN. É também o resíduo que a v1 deixava;
     - mesma unidade com o Omie tendo outro número;
     - unidade ilegível;
     - fator explícito ≠ 1 no item, porque o sentido do fator não foi confirmado: lido ao contrário, 0,055556 vira 972 em vez de 3;
     - sequência ou quantidade ilegível. A versão antiga inventava `i + 1` para sequência ausente.
2. **Trilha** `nfe_recebimento_manual_trilha`: um evento por passo, com quem, conta, NF, `nIdReceb`, chave, itens (unidades, quantidade da NF, do Omie, regra e quantidade enviada) e o resultado. A tabela é append-only por trigger (nem o `service_role` edita), com RLS: staff lê, só a edge escreve, e o REVOKE fecha o default privileges do Supabase. A trilha de **intenção** é gravada antes de cada escrita e é fail-closed (sem ela, a escrita não sai). A de **resultado** é best-effort: se falhar, a resposta leva `trilha_incompleta`.
3. **Omie pelo núcleo** `_shared/omie-cliente.ts`: teto de relógio de 140 s, retentativa só do que é seguro, e `OmieEscritaIndeterminada` ("confira no Omie antes de repetir") quando a escrita pode ter gravado.
4. **Guardas antes de escrever:**
   - Só segue com NF comprovadamente aberta: `cRecebido` e `cCancelada` explicitamente "N", mesmo critério do `omie-nfe-recebimento-sync/estado.ts`. Recebida, cancelada, etapa 80 ou estado ausente param sem escrever.
   - A listagem (`dtEmissaoDe` de 180 dias, `cExibirDetalhes`) vai até o fim. Recusa se houver mais de um recebimento não cancelado com o número, porque número de NF é por emitente, ou se a lista passar de 30 páginas sem chegar ao fim.
   - Hífen no número é recusado: "1234-5" juntaria a série ao número. Etapa já em 40 → não chama `AlterarEtapaRecebimento` (substitui o "erro com a palavra *etapa* é benigno", que deixava qualquer erro de etapa seguir para o `Concluir`). `nIdReceb` divergente na consulta → para.
5. **Auth:** o fluxo real exige JWT de staff (o recebimento fica em nome de quem clicou). Antes, `x-cron-secret` com qualquer JWT de usuário passava, inclusive de customer. Conta desconhecida agora dá 400 (antes caía em silêncio nas credenciais da Colacor SC).

A resposta continua `{ steps, success, error, versao }` (mais `execucao_id`), então a tela não muda.

## Revisão adversária (Caminho B — o Codex sem cota até 27/10)

Um subagente Opus revisou o diff com a `RÉGUA:` escrita. Achados que entraram:
- **P1-A:** NF = Omie com conversão concluía, com aviso; agora recusa.
- **P1-B:** mesma unidade e números divergentes; agora recusa.
- **P1-C:** a guarda "já recebida" ficava aberta quando o dado faltava e ignorava cancelada; agora exige N/N.
- **P1-D:** a busca parava no 1º número igual; agora vai até o fim e recusa duplicata.
- **P3:** TRUNCATE passava pelo append-only; agora há trigger por statement e REVOKE do `service_role`.
- **P3:** erro de entrada voltava 400 e a tela só mostrava "non-2xx"; agora volta 200 com `steps`/`error`.
- A resposta ganhou `desfecho`: `ok` · `erro` · `recusado` · `indeterminado`.

Ficaram de fora: a trava contra reenviar o `Concluir` depois de um indeterminado (P2) e a reconsulta de confirmação depois do `Concluir` (P2). A falsificação da correção D achou um teste verde pelo motivo errado: no teste do teto, a NF repetia em todas as páginas, então quem recusava era a guarda de duplicata. O fixture foi corrigido.

## Provas

- `db/test-nfe-recebimento-manual-trilha.sh` (PG17, default privileges reproduzido): 19 asserts verdes. `--falsificar` deu 8/8 sabotagens vermelhas no assert declarado, em `LC_ALL=C` e em `pt_BR.UTF-8`.
- `process-nfe/fluxo_test.ts` + `regra-quantidade_test.ts` (Deno `--no-remote`): 25 testes. 15/15 sabotagens ficaram vermelhas no teste delas:
  - regra antiga, NF = Omie aceita, sobrescrita do Omie, fator aceito, unidade ilegível aceita, arredondamento;
  - estado aberto fail-open, 1º match, teto vira fim, hífen aceito;
  - gate de staff, intenção ignorada, início fail-open, indeterminada→erro, etapa sempre.

  A sabotagem do gate de staff foi refeita no valor do predicado, porque a 1ª versão não compilava.

## Fora do escopo (follow-ups)

- **Reenvio depois de um indeterminado** (P2 do revisor): a guarda N/N barra a repetição quando o Omie já marcou `cRecebido = S`, mas não se ele demorar a marcar. Falta recusar quando a trilha tem `concluir_recebimento/intencao` sem desfecho para o mesmo `n_id_receb`. Também falta a reconsulta de confirmação depois do `Concluir`, como a gêmea faz.
- **Rótulos de unidade sinônimos** (L × LT, UN × UND) caem em "conversão com NF = Omie" e são recusados. Se aparecer na trilha, o conserto é uma lista de sinônimos na regra.
- **Decisão do founder (2026-10-27): o `omie-nfe-reconcile` fica LIGADO.**
- **`nfe_recebimentos` não é atualizada** pela `process-nfe`. Quem fecha no painel a NF recebida pela aba Manual é o `omie-nfe-reconcile` (cron de hora em hora, seg–sáb), por isso desligá-lo não é neutro.
- O histórico da tela continua no `localStorage`. Ler a trilha na tela fica para depois.
- O rateio de departamento (`nQtdeNFe × (nValorUnitario || nValorTotal)`) foi mantido como estava.
