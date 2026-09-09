# `valor_desconto`/`valor_juros`/`valor_multa` do título: campo que o Omie nunca enviou

**2026-09-08** · edge `omie-financeiro` · money-path (DRE / fluxo de caixa) · achado adjacente do [#2386](https://github.com/LucasSardenbergL/afiacao/pull/2386)

## O defeito

`syncContasPagar` e `syncContasReceber` gravavam, cada uma, três campos assim:

```ts
valor_desconto: t.valor_desconto || 0,
valor_juros:    t.valor_juros    || 0,
valor_multa:    t.valor_multa    || 0,
```

`t` é cada título devolvido por `ListarContasPagar` / `ListarContasReceber`. **Nenhuma dessas três
chaves existe na resposta.** O `|| 0` transformava `undefined` em `0` — e `0`, numa coluna de
dinheiro, é uma **afirmação** ("não houve desconto"), não a verdade ("este endpoint não diz").

É a mesma classe do [desconto de item de pedido](desconto-a-sonda-lia-campo-que-nao-existe.md),
mordida um dia antes — e com o mesmo fornecedor de dados.

## A prova (doc oficial + banco + controle positivo)

| Evidência | Resultado |
|---|---|
| `valor_desconto`/`valor_juros`/`valor_multa` nas docs de `/financas/contapagar/` e `/contareceber/` | **0 ocorrências** nas duas |
| Onde os campos reais vivem | sub-tag **`pagamento`/`recebimento`** — *"Detalhes da baixa"*, ao lado de *"Data da Baixa"* |
| Campos `valor_*` do nível raiz do título | `documento`, `pis`, `cofins`, `csll`, `ir`, `iss`, `inss` (+ `valor_pag` só no CP) |
| Banco (psql-ro) | **0 de 60.607** títulos com valor ≠ 0 · zero NULLs |
| **Controle positivo**, mesma linha de código | `valor_documento` preenchido em **44.482/44.482** e **16.125/16.125** |

O erro era **duplo**: nome inexistente *e* nível errado (título vs. baixa). Logo **não há dado
perdido do título** — o título não tem esses atributos. Não era caso de "corrigir a leitura".

> ⚠️ A doc declara que `recebimento`/`pagamento` só valem nos métodos de **inclusão e alteração**.
> Isso descarta também o conserto tentador de "ler o caminho aninhado" — o LIST não o preenche.

## Por que OMITIR a chave, e não gravar `null`

Primeira intenção foi `valor_desconto: null` (ausente ≠ zero). A revisão Codex derrubou:
o sync roda **em ciclo**, então `null` explícito faria desta função um **writer destrutivo** —
apagaria, a cada volta, qualquer valor que uma futura ingestão de baixas gravasse ali. Omitir a
chave preserva o valor no `UPDATE` do upsert e só deixa o `INSERT` sem informação, que é a verdade.

**Isto depende do `DROP DEFAULT`.** Com `DEFAULT 0` na coluna, o INSERT de um título novo
ressuscita o zero fabricado sem passar por linha nenhuma de TypeScript.

## O que ficou por decidir: manter as colunas ou dropar

O Codex recomenda **dropar** como estado final, e o argumento não é "100% NULL é feio":

> Reservar três escalares **no título** para representar valores de **baixas** é contrato
> mal-definido — o Omie admite **baixa parcial**. Última baixa? Acumulado? Líquido de
> cancelamentos? De qual período? Manter os nomes agora induz o próximo implementador a encaixar
> o dado na estrutura errada, quando o certo seria uma tabela de baixas.

Concordo com o diagnóstico. O DROP não foi executado aqui porque é irreversível, em tabela
money-path de produção, e exige regenerar os tipos — decisão do founder, não da sessão.

**A limpeza do histórico (0 → NULL) foi deliberadamente NÃO proposta**, por dois riscos medidos
no próprio repo:

1. `fin_audit_trigger` pula apenas `auth.role()='service_role'`
   ([migration](../../supabase/migrations/20260525010000_fin_audit_skip_service_role.sql):29). Um
   UPDATE pelo SQL Editor roda como `postgres` → **60.607 registros de auditoria**.
2. `fin_period_lock_trigger` pode **recusar** a alteração de títulos de períodos fechados.

Se o desfecho for o DROP, esse UPDATE seria trabalho jogado fora de qualquer modo.

## SQL para o SQL Editor (o founder cola)

**Passo 1 — fecha o defeito agora.** Só catálogo: não reescreve linha, não dispara trigger de
linha. Mantenha o DDL numa transação curta e separada (o `ALTER TABLE` toma `ACCESS EXCLUSIVE`).

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE fin_contas_receber
  ALTER COLUMN valor_desconto DROP DEFAULT,
  ALTER COLUMN valor_juros    DROP DEFAULT,
  ALTER COLUMN valor_multa    DROP DEFAULT;

ALTER TABLE fin_contas_pagar
  ALTER COLUMN valor_desconto DROP DEFAULT,
  ALTER COLUMN valor_juros    DROP DEFAULT,
  ALTER COLUMN valor_multa    DROP DEFAULT;

COMMENT ON COLUMN fin_contas_receber.valor_desconto IS
  'NÃO INGERIDO. Desconto é atributo da BAIXA (sub-tag `recebimento`), não do título; '
  '`ListarContasReceber` não o devolve. NULL = desconhecido. Ver '
  'docs/historico/desconto-juros-multa-do-titulo-nao-existem-no-omie.md';
COMMENT ON COLUMN fin_contas_pagar.valor_desconto IS
  'NÃO INGERIDO. Ver fin_contas_receber.valor_desconto.';

COMMIT;
```

Verificação (deve devolver 6 linhas, todas com `column_default` vazio):

```sql
SELECT table_name, column_name, column_default
  FROM information_schema.columns
 WHERE table_name IN ('fin_contas_receber','fin_contas_pagar')
   AND column_name IN ('valor_desconto','valor_juros','valor_multa')
 ORDER BY 1,2;
```

**Passo 2 — opcional, estado final recomendado.** Só depois do Passo 1 no ar e do sync corrigido
deployado. Exige regenerar `src/integrations/supabase/types.ts`.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE fin_contas_receber
  DROP COLUMN valor_desconto RESTRICT,
  DROP COLUMN valor_juros    RESTRICT,
  DROP COLUMN valor_multa    RESTRICT;
ALTER TABLE fin_contas_pagar
  DROP COLUMN valor_desconto RESTRICT,
  DROP COLUMN valor_juros    RESTRICT,
  DROP COLUMN valor_multa    RESTRICT;
COMMIT;
```

## Achado adjacente NÃO corrigido (fora do escopo)

O CP documenta na raiz um campo que não ingerimos: **`valor_pag` — "Valor a pagar. Disponível
apenas para os métodos de consulta e listagem."** O código lê `t.valor_pago` (com "o"), que não
existe; e `fin_contas_pagar.valor_pago` é 0 em 16.125/16.125.

⚠️ **`valor_pag` é "valor A pagar" (saldo em aberto), não "valor pago".** Usá-lo como baixa seria
fabricar outro número. A coluna gerada `saldo = valor_documento - COALESCE(valor_pago,0)` é hoje
sempre igual a `valor_documento` — já conhecido, contido por guard de status
([#396](https://github.com/LucasSardenbergL/afiacao/issues/396), `titulo-status.ts`).

## A lição

**Zero medido num campo que a origem não preenche prova a ingestão, não a realidade** — a mesma do
#2386. O que este caso ACRESCENTA:

1. **A ausência tem dois sabores, e eles pedem código diferente.** No item de pedido, a entidade
   *tem* os campos e o Omie os omite quando não há desconto → ausência informativa → `0` é correto.
   No título, a entidade *não tem o conceito* → ausência é silêncio → `0` é fabricação. Perguntar
   "o campo existe?" não basta: é preciso perguntar **de que entidade ele é atributo**.
2. **O tipo TypeScript era cúmplice.** Enquanto `valor_desconto?: number` estivesse declarado em
   `OmieContaPagar`, ler `t.valor_desconto` type-checava e parecia legítimo. Corrigir a escrita sem
   corrigir o tipo deixa a armadilha armada.
3. **`null` não é automaticamente o oposto de fabricar.** Num escritor cíclico, gravar `null`
   explícito é destrutivo. A pergunta certa não é "0 ou null?", é "quem mais escreve aqui?".
4. **Um invariante que proíbe `|| 0` é fraco** — `?? 0` ou um helper passam. O gate tem de ser
   POSITIVO: a chave não é escrita, em forma nenhuma; e existe um controle que falha se o alvo
   sumir do arquivo (senão o teste fica verde por vacuidade).
