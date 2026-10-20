# `omie-nfe-recebimento-sync` ignora CT-e (v1.6-ignora-cte)

> 2026-10-20. Continuação de [nfe-recebimento-rpc-transacional.md](nfe-recebimento-rpc-transacional.md) (v1.5) e
> irmã de [cte-fora-do-rastreio.md](cte-fora-do-rastreio.md): o mesmo `ListarRecebimentos` que o rastreio já
> filtrava também alimenta a materialização de recebimentos, e ela não filtrava modelo.

## O problema medido (psql-ro, prod, 2026-10-20)

| medição | valor |
|---|---|
| cabeçalhos em `nfe_recebimentos` com `substr(chave_acesso,21,2)='57'` | **28**, todos OB e todos com 0 itens: 26 `efetivado` e 2 `pendente` |
| cabeçalhos sem itens no total | 57 (os 28 CT-e são metade) |
| `nfe_importacao_falhas` modelo 57 | 3 linhas `NFE01` origem `sync`, máx. 3 tentativas, última 2026-10-20 12:50Z |
| a consulta da rodada 12:50Z (OB) | nIdReceb 12199225171, CT-e 000132483: `falha_dado` NFE01 "lote sem itens" |

A triagem da v1.5 deixou de pular o cabeçalho `pendente` sem itens (para repará-lo). Com isso, o CT-e
`pendente` voltava a ser candidata e gastava a **única** consulta de detalhe da conta na rodada.

## O que mudou

1. **Triagem da listagem** (`listagem.ts`): `classificarModeloRecebimento(rec.cabec).tipo === "cte"` é a
   PRIMEIRA checagem e vira pulo `cte`, contado em `ctes` no `por_armazem`. Vem antes de "já importada":
   os 26 CT-e efetivados contam como `ctes`, não como `ja_importados`. Não soma no `skipped`, que desce
   em relação à série anterior.
2. **Detalhe** (`rodada.ts`, `gravar`): CT-e revelado pelo detalhe dá desfecho `cte`, sem RPC, e registra
   impedimento `CTE` no ledger. Sem esse registro a mesma CT-e disputaria a consulta para sempre. Com
   ≥3 tentativas ela estaciona.
3. **Botão** (`index.ts`, `importarPorChave`): chave com modelo 57 responde 400 `entrada_invalida`
   "isto é um CT-e (frete), não NF-e de mercadoria — não há itens para receber" ANTES de ler o banco e
   de consultar o Omie. O front já mostra o `error` de qualquer 4xx.

**Régua.** A triagem do cron exige os DOIS sinais (chave crua E `cModeloNFe` = 57). Divergência, modelo
ausente, modelo malformado e chave ilegível seguem candidatas: a incerteza vira consulta, e o detalhe
decide. O botão usa só a chave, porque é o único sinal que ele tem e a recusa é explícita ao operador.
Modelos 65 e 67 ficam fora (sem medição; 65 é NFC-e com mercadoria).

**Invariante do sensor** (testado no Deno):
`listados = ctes + sem_id + ja_importados + cancelados + recebidos_no_omie + aguardando + consultados`.

## Prova

- Deno: 83 testes verdes (edge + helper `_shared/modelo-documento-fiscal`).
- Falsificação com controle verde na mesma invocação: tirar o filtro da triagem, o do detalhe, o ledger
  `CTE`, trocar os dois sinais por chave-só ou pôr o `cte` depois de "já importada" deixam o Deno
  vermelho. No vitest, tirar a recusa do botão ou trocar `CTE` por `NFE01` deixam o guardrail vermelho.
- Codex desenho (RÉGUA): aprovado com ajustes, todos incorporados (ledger `CTE`, incerteza provada no
  laço, invariante do sensor, `vez` fixa, ordem antes do estado, 65/67 fora).
- Codex adversarial no diff: **reprovou sem P0**, com dois achados reproduzidos e corrigidos.
  - **P1, preexistente e alcançado pelo writer novo:** a leitura das estacionadas por CHAVE não filtrava
    armazém e somava o `omie_id_receb` de outra conta. Uma CT-e estacionada em OB fazia a NF-e 55 de CC
    com o mesmo id virar "já importada". Agora `acrescentarEstacionadas` (pura, testada) só aceita o id
    da própria conta, e o select traz `warehouse_id`.
  - **P2:** ledger que não grava o impedimento `CTE` saía calado. Agora vai a errors[] (success:false).
  - As duas correções e a fiação do select foram falsificadas (vermelho com a sabotagem).

## Passivo: os 28 CT-e gravados (decisão do founder)

Nada foi apagado nem alterado. A triagem nova os classifica como `cte` e eles param de disputar a
consulta. Ficam na tela de conferência como cabeçalhos sem itens. Opções propostas no PR: marcar com
status próprio, arquivar fora da tela, ou deixar como está. Quem decide é o founder.

## Re-sonda pós-deploy

`bun run sonda:sql omie-nfe-recebimento-sync` deve responder `v1.6-ignora-cte`. Depois, a contagem de
modelo 57 em `nfe_recebimentos` deve ficar congelada em 28, o `por_armazem.OB.ctes` deve ser > 0 e
`consulta.desfecho = "cte"` não deve repetir. O controle positivo é uma NF-e 55 nova chegando com itens.
