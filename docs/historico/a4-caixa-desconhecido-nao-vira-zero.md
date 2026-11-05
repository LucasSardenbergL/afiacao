# A4 (próxima melhor ação): caixa desconhecido deixa de virar R$0 — plano v6, lote 1 (C1 A4-DADO)

**Data:** 2026-11-04 · **Edge:** `fin-next-best-action` v1.1 (`v1.1-caixa-desconhecido-nao-vira-zero`) · **Tela:** `/financeiro/proxima-acao` · **Money-path**

## O defeito

A A4 compõe a A1 (`fin-cashflow-engine`) por empresa e calcula o "caixa disponível" que decide `financiar_ja` × `financiar_condicional`. Ela fabricava o número em três pontos:

1. **Transporte:** `dias_cobertura ?? 0` e `saldo_tesouraria ?? 0`. A A1 devolve `dias_cobertura = null` de propósito quando as saídas projetadas do horizonte são ~0 ("sem base de saída", `diasCoberturaProjetado`). O `?? 0` transformava esse null em "cobertura zero", e o helper devolvia **R$0 disponível**.
2. **Confiança:** só ficava baixa quando a resposta inteira da A1 era nula. Os motivos de degradação da A1 (`confianca_dados`) eram descartados.
3. **Fila:** `caixaPorEmpresa[e]?.disponivel ?? 0`, e `classificarStatus` comparava o custo com esse zero.

Reprodução do Codex: cobertura `null` com saldo de R$10.000 resultava em **disponível R$0 e confiança alta**. A1 que falhava (null) também virava 0, com um haircut aplicado sobre o zero.

## A correção

- **`caixaDaA1`** (transporte novo, puro): resposta crua da A1 → `{ disponivel: number|null, confianca, saldo_tesouraria, dias_cobertura, motivos }`.
  - Saldo ausente, cobertura `null` explícita ("sem base de saída") e cobertura ausente viram `disponivel: null`, cada caso com seu motivo. Quando o saldo é conhecido, ele é preservado: a tela mostra "saldo conhecido, disponível não calculado".
  - Cobertura `0` é **zero conhecido**, porque a A1 só a devolve com saldo ≤ 0. Nesse caso o disponível é 0 com confiança alta.
  - Saldo datado (`confianca_dados.saldo_inicial`) mantém o cálculo com haircut, rebaixa a confiança para baixa e propaga o motivo.
  - Só `saldo_inicial: null` **explícito** atesta o frescor. Se o bloco estiver ausente, ou se vier no formato legado da A1 anterior a `8d901e947` (`{ motivos }` sem `saldo_inicial`), o cálculo segue com confiança **média** e o motivo "frescor não atestado", e esse caixa não decide financiar.
  - **Os demais motivos da A1 (estoque, CMV, PMR/PMP/CCC) não tocam o caixa.** Nenhum deles entra em `saldo_tesouraria` nem em `dias_cobertura`. A contestação do Codex pediu explicitamente para não transformar toda degradação em nulidade.
- **`caixaDisponivel`** aceita e devolve `null`.
- **Fila:** só o caixa de confiança **alta** decide `financiar_ja` × `condicional`. Caixa desconhecido, ou estimado a partir de saldo datado, leva a `falta_dado`. O motivo de cada empresa chega à confiança da fila como `Caixa (<empresa>): …`, no lugar da frase genérica de antes.
- **Contrato do front:** `ProximaAcaoResult.caixa_por_empresa[e].disponivel: number | null`, com campos novos opcionais. Um bundle de edge anterior à v1.1 não manda esses campos, então a tela tolera a ausência. A tela mostra "—", o saldo conhecido e os motivos. O título do grupo passou a ser "Falta dado (definir ação / hurdle / caixa)".
- **Estrutura da edge:** o helper saiu da `index.ts` para `fila.ts`, cópia **VERBATIM** do bloco `// MIRROR-START a4-fila` de `src/lib/financeiro/next-best-action-helpers.ts`. A paridade textual é vigiada em `edge-money-path-invariants.test.ts`. A composição das respostas A1/A2/A3 saiu para `orquestracao.ts`, sem IO. A `index.ts` ficou só com IO e a chamada.

## Efeito em produção (o que muda de verdade)

Hoje **todo** candidato `crescer` sai com `caixa_consumido = null`: o sleeve company-level e o "crescer" da A3 não estimam ticket. Por isso esses candidatos já caíam em `falta_dado`, e a guarda nova de caixa **não muda nenhum status em produção hoje**. Ela protege o dia em que houver ticket dimensionado. O que muda já é o **card "Caixa disponível por empresa"**, onde R$0 fabricado vira "—" com motivo, e o `caixa_livre` do `fin-funding`, que lê `disponivel ?? null` e passa a receber null em vez de 0. Esse campo é só contexto, não fonte do planejador.

## Prova

- **Deno** (`fin-next-best-action/fila_test.ts`, 14 casos): cobertura null, saldo datado (incluindo o contraexemplo do Codex, em que a estimativa de R$32,5k não aprova uma ação de R$30k), caso saudável, PMR não rebaixa, A1 nula, saldo ausente, cobertura ausente, zero conhecido, A1 sem `confianca_dados`, formato legado `{ motivos }` sem `saldo_inicial`, e **ponta a ponta resposta crua da A1 → `montarRespostaA4` → JSON**.
- **Falsificação Deno**, com controle verde na mesma invocação e nos dois locales (`C` e `pt_BR.UTF-8`): 12 sabotagens, uma camada por vez, 12 pegas em cada locale. Duas delas estão no **caller** (`?? 0` reintroduzido sobre o transporte e a confiança antiga "só A1 nula").
- **mutcheck** (`scripts/mutcheck.d/next-best-action-helpers.mut`, vitest do helper `src/`): 16 mutações, 16 pegas, 0 inválidas, baseline verde.

## Codex

- **Desenho** (gpt-6-astra · max · 324s · 129.747 tokens): sem P0. Dois P1 aceitos. (1) O haircut de saldo datado aprovava `financiar_ja` com confiança baixa, e por isso o caixa decisório passou a exigir confiança alta. (2) A prova precisava alcançar o caller, o que levou à extração de `orquestracao.ts` e ao teste ponta a ponta. Recusas:
  - **Atualizar o tipo `A4Response.disponivel` no `fin-funding`:** o runtime já faz `?? null`. Mudar só a anotação muda a fonte da edge e criaria um deploy redundante sem mudança de comportamento. Fica para a próxima mudança real do `fin-funding`.
  - **Canária comportamental `{canary:true}`:** a sonda de versão com fingerprint já atesta que o bundle servido é a fonte da main. Uma canária seria máquina meta nova sem incidente citado.
- **Código** (gpt-6-astra · max · 346s · 147.383 tokens): sem P0. Um P1 aceito: o formato legado da A1 (`{ motivos }` sem `saldo_inicial`) passava como confiança alta. Corrigido, com teste ponta a ponta e uma sabotagem a mais. O Codex conferiu ainda 56 comparações numéricas contra a implementação anterior (sem divergência), oito renderizações front antigo/novo × payload antigo/novo/null (sem quebra) e o `fin-funding` (decisões inalteradas).
- **Ressalva preexistente registrada, sem correção neste lote:** a cobertura usa `saldo_cc`, mas a fração de reserva é aplicada sobre `saldo_tesouraria` (que é `saldo_cc − folha_30d`). As fórmulas não são equivalentes. Exemplo: conta de R$100k, folha de R$20k e saída diária de R$1k dão R$63,2k disponível, contra R$59k por "tesouraria − 21 × saída". A folha já foi separada, então não há violação do piso, mas a política de sobreposição da folha merece decisão própria.

## Deploy

Duas camadas manuais fora do merge: **deploy da edge `fin-next-best-action`** (o ledger diz `bun run pendencias:deploy`) e **Publish** do front. A ordem segura é edge primeiro: o front antigo já renderiza `null` como "—", e o novo tolera a ausência dos campos novos.
