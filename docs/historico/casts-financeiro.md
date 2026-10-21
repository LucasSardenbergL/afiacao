# Casts que desligam o tipo — módulo financeiro (plano v2 · item 4 / I1 · PR 8, money-path)

2026-10-21. Oitavo PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md), depois de [casts-vendas.md](casts-vendas.md). Escopo: os arquivos não-teste do módulo ativo `financeiro` (manifesto). Eram 58 ocorrências textuais de `as never`/`as unknown as` em 20 arquivos. Agora são **0**. Money-path, com Codex de desenho (`RÉGUA:`) antes do código e adversarial no diff final.

## O que os casts escondiam

Tudo conferido na PROD via `psql-ro` (CHECKs, `pg_get_function_arguments`, `pg_get_functiondef`, NULLs por coluna, chaves e tipos dos jsonb) antes de corrigir. De novo, **todos** os comentários "não está nos tipos gerados" eram falsos: as 13 tabelas, 1 view e 6 RPCs estavam no `types.ts`.

- **A tela Intercompany quebrava ao exibir o DRE consolidado.** O cast afirmava `{dre_linha, valor_bruto, eliminacoes, valor_liquido}`, mas a RPC `fin_consolidado_intercompany` devolve `{conta, total_bruto, eliminacoes, total_consolidado}` desde a v2 (migration `20260518004300`). `fmt(undefined)` lançava ao renderizar, e o erro da RPC era engolido (`catch { /* RPC may not exist */ }`). Agora a borda `src/lib/financeiro/consolidado-intercompany.ts` lê as colunas reais. Erro da RPC vira toast e a seção não aparece. Resposta de mês/ano já trocado é descartada. A cobertura por empresa vem dos snapshots do mês: com nenhuma empresa a seção não aparece (os zeros da RPC são `COALESCE`); com parte delas, a tela avisa "soma parcial".
- **A RPC soma a eliminação intercompany ao CMV com o sinal trocado.** O CMV é gravado POSITIVO (prod: 91 snapshots > 0, 23 = 0, nenhum < 0), e a RPC faz `cmv + valor_elim`, inflando o consolidado em vez de reduzir. Até a RPC ser corrigida (SQL, fora deste PR), a eliminação e o líquido do CMV aparecem como "—" quando há eliminação. **Pendência de money-path para outra sessão.**
- **`fin_funding_inputs.funding_inputs` é `{}` nas 3 empresas,** e o cast o entregava como `FundingInputs` completo. O tipo honesto é parcial em profundidade (`FundingInputsSalvos`), lido por forma. Chave ausente continua ausente, para não apagar os DEFAULTS no merge do diálogo.
- **A DRE afirmava não-nulas 16 colunas que o schema declara nullable** (DEFAULT 0). Agora `paraFinDRE` LANÇA em NULL (0 NULL em 133 snapshots) e lê o `detalhamento` por forma, cobrindo tudo que o tipo `FinDRE` promete: impostos, confiança, `fora_dre`, `imposto_teorico`, `mapeamentos_invalidos`. O ponto de equilíbrio fazia `Number(x ?? 0)` e `Number(v)` no jsonb (NULL e `""` viravam 0). Agora exige as colunas e valida despesas e composição sem coerção.
- **Contas a pagar/receber:** `FinContaPagar`/`FinContaReceber` afirmavam não-nulas colunas nullable. Dinheiro, status e categoria agora são exigidos (lança). Nome, CNPJ, documento e descrição ficaram anuláveis ("—" na tela, célula vazia no CSV). Prod: 0 NULL em 16.248 títulos de CP e 45.334 de CR.
- **Vocabulário de CHECK virava `string` no gerador** e o cast o afirmava como união. Guardas na borda `src/lib/financeiro/borda-tabelas.ts`: dívidas (`company`, `tipo`, `cp_inclusion_status`, `coobrigada_por`), antecipações, classificação de custo (`_default` é domínio legítimo e não passa pela guarda de empresa), eventos, alertas e config de cashflow.
- **Comparativo por empresa:** `raw ?? 0` deixou de existir. NULL (só nos prazos) vira "—" em qualquer formato.

## O que ficou

- Bordas novas: `src/lib/financeiro/borda-json.ts` (leitores por forma reutilizáveis), `dre-borda.ts`, `borda-tabelas.ts` e `consolidado-intercompany.ts`, com testes co-localizados (cada ramo de lançamento casando a mensagem, mais as formas reais de prod).
- **Prova sobre a prod** (dump `psql-ro` → script local, não commitado): 133/133 DRE com valores idênticos ao cru; 114 snapshots do PE, mapeamento antigo ≡ novo; 61.582 títulos passam a exigência; config, funding e alertas idênticos ao gravado. `FALHAS=0`. Única projeção: `fora_dre.lancamentos_nao_zero` é do writer, não está no `FinDRE` e ninguém a lê.
- **Falsificação** com controle verde na mesma invocação: 7 sabotagens (número aceita string, união sem guarda, opcional escreve ausente, DRE sem exigir numéricas, composição aceita NULL, coobrigada sem guarda, CMV com eliminação exibido), todas vermelhas.
- Gate `casts:stale`: baseline `{from: 20, rpc: 21}` → `{from: 19, rpc: 18}`; piso `castsLiterais` **41 → 37** = contagem real.
- `ConfigCashflowDialog` regrava `thresholds`/`overrides_cenario`. A borda **preserva chave desconhecida**, como o cast antigo preservava (lição de [casts-vendas.md](casts-vendas.md)).
- `listarContas` recebe a página inteira do chamador, `(de, ate) => …order…range(de, ate)`. Assim os gates textuais `single-shot-truncado` e `paginacao-artesanal` (G7) enxergam o `.range()` e o `.order()` na mesma expressão.
- Achados registrados e NÃO corrigidos (anteriores, fora do escopo de casts):
  - `FinanceiroOrcamento`: mês sem snapshot conta como realizado 0 (`d ? d[linha] : 0`).
  - `FinanceiroOrcamento`: o `catch` do load mantém o rascunho anterior, e trocar de empresa pode salvar o rascunho na empresa nova.
  - `FundingInputsDialog` permite salvar antes de a leitura terminar (sobrescreve com DEFAULTS).
  - `getDRE` trata `data: null` sem erro como lista vazia.
  - `useFinanceiroCiclo` não descarta coorte sem chave (`company`/`mes_vencimento` NULL).

## Lições

- **Cast em tela que nunca renderiza esconde o defeito por meses:** a RPC mudou de forma em maio, e a seção do consolidado só existia no cast.
- **Corrigir a leitura pode EXPOR um número errado que o defeito escondia.** Antes de reexibir, confira a convenção do dado (aqui, o sinal do CMV). Valor conhecido como errado vira "—", não número.
- **A prova sobre a prod compara VALORES, não só "não lançou".** Zero lançamentos com uma borda que projeta errado passaria verde (P2 do Codex).
