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

1. **Regra explícita** (`regra-quantidade.ts`): a edge não calcula conversão. Se a quantidade do Omie é igual à da NF, manda a da NF. Se há sinal de conversão (unidades diferentes ou fator ≠ 1 no item), manda a do Omie. Sem conversão, manda a da NF exata. Recusa a NF inteira, sem escrever nada, quando há conversão sem o número do Omie, unidade ilegível com divergência, ou sequência/quantidade ilegível. A versão antiga inventava `i + 1` para sequência ausente.
2. **Trilha** `nfe_recebimento_manual_trilha`: um evento por passo, com quem, conta, NF, `nIdReceb`, chave, itens (unidades, quantidade da NF, do Omie, regra e quantidade enviada) e o resultado. A tabela é append-only por trigger (nem o `service_role` edita), com RLS: staff lê, só a edge escreve, e o REVOKE fecha o default privileges do Supabase. A trilha de **intenção** é gravada antes de cada escrita e é fail-closed (sem ela, a escrita não sai). A de **resultado** é best-effort: se falhar, a resposta leva `trilha_incompleta`.
3. **Omie pelo núcleo** `_shared/omie-cliente.ts`: teto de relógio de 140 s, retentativa só do que é seguro, e `OmieEscritaIndeterminada` ("confira no Omie antes de repetir") quando a escrita pode ter gravado.
4. **Guardas antes de escrever:** NF já recebida no Omie (`cRecebido = S` ou etapa 80) para sem escrever, o que torna a repetição depois de uma indeterminada segura. Etapa já em 40 → não chama `AlterarEtapaRecebimento` (substitui o "erro com a palavra *etapa* é benigno", que deixava qualquer erro de etapa seguir para o `Concluir`). `nIdReceb` divergente na consulta → para.
5. **Auth:** o fluxo real exige JWT de staff (o recebimento fica em nome de quem clicou). Antes, `x-cron-secret` com qualquer JWT de usuário passava, inclusive de customer. Conta desconhecida agora dá 400 (antes caía em silêncio nas credenciais da Colacor SC).

A resposta continua `{ steps, success, error, versao }` (mais `execucao_id`), então a tela não muda.

## Provas

- `db/test-nfe-recebimento-manual-trilha.sh` (PG17, default privileges reproduzido): 15 asserts verdes; `--falsificar` deu 6/6 sabotagens vermelhas no assert declarado, em `LC_ALL=C` e em `pt_BR.UTF-8`.
- `process-nfe/fluxo_test.ts` + `regra-quantidade_test.ts` (Deno `--no-remote`): 23 testes. Oito sabotagens (regra antiga, gate de staff, intenção ignorada, guarda já-recebida, início fail-open, indeterminada→erro, etapa sempre, arredondamento) ficaram vermelhas no teste delas. A do gate de staff foi refeita sabotando o valor do predicado, porque a 1ª versão não compilava.

## Fora do escopo (follow-ups)

- **Colisão de número de NF entre fornecedores:** o `ListarRecebimentos` para no 1º recebimento com o número. A trilha e a tela mostram fornecedor e chave, mas nada impede concluir a NF de outro fornecedor com o mesmo número.
- **`nfe_recebimentos` não é atualizada** pela `process-nfe`. Quem fecha no painel a NF recebida pela aba Manual é o `omie-nfe-reconcile` (cron de hora em hora, seg–sáb), por isso desligá-lo não é neutro.
- O histórico da tela continua no `localStorage`. Ler a trilha na tela fica para depois.
- O rateio de departamento (`nQtdeNFe × (nValorUnitario || nValorTotal)`) foi mantido como estava.
