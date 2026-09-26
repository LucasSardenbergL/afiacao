# `cancelar_pedido_sugerido` revertido por colagem fora de ordem — 18 dias invisível

> 2026-09-26 · sessão de deploy da leva do #2547 (`disparar-pedidos-aprovados` v1.3 + `dispatch-notifications` v1.1).
> Quem viu foi o gate de pré-condição de banco do `pendencias-pacote` (eixo de CORPO, #2428) — nenhum audit.

## Sintoma

`bun scripts/pendencias-pacote.ts` saiu **exit 3 (BLOQUEADO)** e não emitiu a colagem das edges:
`cancelar_pedido_sugerido` "EXISTE em prod, mas rodando o corpo de `20260906170000`", com a
`20260907095841_disparado_simulado_e_estado_pos_disparo.sql` commitada depois. Nenhuma edge da leva
chama a RPC — ela entrou pelo **conjunto acoplado** da migration de uma RPC que a leva chama.

## Diagnóstico (medido por `psql-ro`, não deduzido)

- A `20260907095841` **foi** aplicada: 2 dos seus 3 objetos (o trigger
  `reposicao__valida_cancelamento_pos_disparo` e `corrigir_cancelamento_pos_disparo`) estavam na forma
  nova, **byte-idênticos** ao arquivo e com o **mesmo `xmin` (9923079)** — uma transação só.
- As **11** funções da `20260906170000` (selo M1) tinham todas o `xmin` **9924256** — outra transação,
  **posterior**: a de 06/09 foi colada DEPOIS da de 07/09 e recriou `cancelar_pedido_sugerido` com o
  corpo antigo (sem a recusa de `disparado_simulado`). "A última a recriar vence" (`database.md` §2).
- **Datação** por `xmin` × tabela só-de-inserção (`sync_reprocess_log`; as linhas do
  `cron.job_run_details` daquela data já tinham sido expurgadas): 07/09 colada em **2026-09-07
  16:15–18:15Z**; 06/09 em **18:15–20:16Z do mesmo dia**. O método foi validado na reaplicação desta
  sessão, que o `cron.job_run_details` datou em 00:56–00:57Z, batendo com o relógio.
- O corpo de 07/09 é o de 06/09 **mais** a recusa (o diff no repo é só acréscimo; a própria
  postcondição da 07/09 checa `[REGRESSAO-PORTAL]`) ⇒ reaplicá-la não reverte o selo M1.
- **Impacto real: nenhum dinheiro exposto.** O trigger `trg_valida_cancelamento_pos_disparo` (aplicado,
  habilitado) já barrava `disparado_simulado → cancelad*` em toda via de escrita; faltava a "porta
  educada" — a RPC devolveria a exceção do trigger em vez do `{error}` que a UI lê. E havia **0**
  pedidos em `disparado_simulado` (de 589).

## Conserto (2026-09-26 00:56Z, pela sessão, dentro do ENVELOPE)

- **`db:aplicar` não serve:** a migration traz `BEGIN;`/`COMMIT;` (recusa por desenho) e transformar o
  arquivo no cliente quebra o sha256 que o banco recalcula.
- **Pelo MCP `query_database`**, só o `CREATE OR REPLACE` de `cancelar_pedido_sugerido`, verbatim, em
  `BEGIN/COMMIT`, com postcondição que exige **`md5(prosrc)` = md5 do corpo calculado PELO BANCO a partir
  dos bytes do arquivo** (`8f49cbaf…`) — uma transcrição que divergisse 1 byte abortaria a transação.
  Trigger e `corrigir` ficaram intocados (já estavam idênticos).
- **Ensaio antes:** a mesma SQL terminando em `RAISE EXCEPTION 'ENSAIO_OK …'` rotulado ⇒ rollback
  garantido e veredito positivo no texto do "erro"; o `psql-ro` confirmou prod intacto (o MCP honra a
  transação).
- **2ª testemunha (`psql-ro`, outra conexão):** corpo byte-idêntico à `20260907095841`, `xmin` novo
  10593775, ACL idêntico ao anterior, e **12/12** predicados da postcondição ORIGINAL da migration.

## Desfecho

O gate reabriu (pacote `094b3f2a844e`, exit 0) e a leva foi ao ar. Outra sessão (a do #2549, no
`/fecho` dela) montou o MESMO pacote e mandou a MESMA colagem minutos depois; o Lovable respondeu
`deduplicated: true` ⇒ **um** deploy (1,1 crédito). A sonda saiu pelo #2559 (recibo #163; respostas
93264/93265 com `versao` + `fonte` da main) e o `pendencias:deploy` fechou em **exit 0, 61/61**.

## Lições

1. **Deriva de CORPO não tem sensor geral.** Audit de existência não vê (o objeto existe nos dois
   estados); o `authz:funcoes:prod` cobre o manifesto de authz, não o domínio. O único olho foi o eixo
   de corpo do gate do pacote — e só porque uma edge do conjunto acoplado foi deployada. Função fora de
   qualquer leva segue sem sensor (tarefa de acompanhamento aberta nesta sessão).
2. **Migration COM envelope aplicada pela sessão vai pelo MCP, e o risco é a TRANSCRIÇÃO:** feche-o com
   o md5 do corpo na postcondição (calculado pelo banco a partir do arquivo) + ensaio com
   `RAISE EXCEPTION` rotulado. Registrado em `docs/agent/database.md` §Escrita.
3. **O pacote é determinístico por (ref, estado de prod)**, então duas sessões na mesma leva geram a
   mesma colagem. O Lovable deduplicou — inócuo aqui por sorte de conteúdo idêntico, não por desenho.

Nota: o mesmo gate apontou `reposicao_persistir_qtde_inteira` como "corpo que não bate com nenhuma
versão commitada". Medido: a diferença são **3 linhas de comentário** ausentes em prod; a lógica é
idêntica. Cosmético, sem ação.
