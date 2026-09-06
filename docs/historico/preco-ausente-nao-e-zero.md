# Preço ausente do Omie deixa de virar R$ 0,00 — e a defesa que era inalcançável

**2026-09-05** · fecha a origem que o PR #2206 (M-04) mediu e deixou aberta de propósito.
Migration `20260905225613_preco_ausente_nao_e_zero.sql` · prova `db/test-preco-ausente-nao-e-zero.sh`.

## O que estava errado

Item sem `valor_unitario` no Omie chegava ao app como preço **zero**. Três camadas concordavam
em fabricar esse zero, e nenhuma delas sabia que estava fabricando:

| Camada | O que fazia | Efeito |
|---|---|---|
| Coluna | `order_items.unit_price` NOT NULL **DEFAULT 0** | "não sei" não tinha como ser escrito |
| RPC de ingestão | `coalesce((it->>'unit_price')::numeric, 0)` | ausência virava 0 na escrita |
| Writers (edge) | `prod.valor_unitario \|\| 0` em 4 sites | ausência virava 0 antes mesmo da RPC |

Na margem do cliente, esse item entrava com **receita 0 e custo cheio** — margem negativa
fabricada, que rebaixava o health score de um cliente que não fez nada de errado.

## A lição: a defesa existia e era inalcançável

`private.margem_cliente_agregada()` já tinha o guard certo, escrito num PR anterior:

```sql
AND i.preco_unit IS NOT NULL AND i.preco_unit >= 0 AND i.preco_unit < 'Infinity'::numeric
```

Só que a coluna era **NOT NULL**. O ramo `IS NOT NULL` **nunca executava em produção**. E o
caminho que a produção percorria de fato — preço `0` — passava por `>= 0` como **computável**.
A defesa protegia contra um valor que o schema tornava impossível, e deixava passar o valor que
o schema tornava inevitável.

Pior: o harness `db/test-margem-cliente-helper-compartilhado.sh` **provava esse ramo**, inserindo
`unit_price = NULL` numa tabela de teste que — ao contrário da prod — permitia NULL. Verde no
teste, morto na produção. O teste não estava errado sobre o helper; estava errado sobre o mundo.

> **Regra que sai daqui:** um teste que monta o schema **à mão** pode provar um ramo que o schema
> **real** torna inalcançável. Quando o harness cria a tabela, ele também escolhe a realidade —
> e nada avisa quando essa escolha diverge da prod. Ao provar um guard de ausência, verifique se
> a coluna **pode mesmo** ser nula; se não pode, o guard é decorativo e o verde é cegueira.
> O harness novo monta `order_items` **como prod** (`NOT NULL DEFAULT 0`) e deixa a **migration**
> alterá-la — é a única forma de o teste falar do mesmo mundo que o founder aplica.

Essa é a irmã estrutural do `?? 0` inerte já registrado em `money-path.md`: lá, a correção não
chegava ao consumidor; aqui, a defesa não alcançava o produtor.

## As decisões que não eram óbvias

**Ausência e zero são fatos diferentes, e a ingestão preserva os dois.** A régua da ingestão é
finitude **não-negativa** (`>= 0`): ausente → `NULL`, `0` informado → `0`, lixo (negativo,
Infinity, NaN) → `NULL`. Converter o zero informado em NULL seria mais simples e estava na mesa,
mas destruiria informação da fonte de graça. Quem decide se o preço **serve** para margem é o
**consumo**, onde a régua é finitude **positiva** (`> 0`) e exclui também o zero — porque receita 0
com custo real é margem −100%, que envenena o agregado.

**Cobertura por motivo se sobrepõe, e isso fica dito.** `itens_sem_preco` e `itens_sem_custo` são
contagens independentes: um item sem os dois conta nas duas, e a soma delas **excede**
`itens_ignorados`. Fazê-las particionar exigiria eleger um motivo "principal" — uma escolha
arbitrária apresentada como fato. O `COMMENT` da função diz isso, e um assert do harness fixa a
sobreposição (`2 + 2 = 4 > 3`) para que ninguém a "conserte" depois.

**O subtotal do pedido NÃO degrada para `null`.** Foi considerado e recusado: `sales_orders.total`
e `subtotal` são NOT NULL em prod, `reconciliar_pedidos_omie` rejeita total nulo, e os KPIs de
faturamento somam a coluna. Anular o total de um pedido por causa de um item trocaria um total
encolhido por um **buraco no faturamento**, que é pior. O sinal honesto de "este total está
incompleto" ficou **derivável** do items-jsonb (algum item com `valor_unitario: null`), sem coluna
nova e sem fabricar número.

**Tornar a coluna nullable INTRODUZIRIA um bug se parasse aí.** `reconciliar_pedidos_omie` compara
preço para decidir se reescreve o item:

```sql
abs(coalesce(a.unit_price, 0) - d.unit_price) < 1e-6
```

Com a coluna nullable, esse `coalesce` passa a **mentir**: um item gravado como NULL compararia
**igual** a um desejado `0`, o UPDATE não rodaria, e o pedido ficaria eternamente dessincronizado
do Omie sem ninguém ver. O diff virou NULL-safe no mesmo commit. A sabotagem `H:I6` do harness
mede exatamente isso: com o diff antigo, `corrections` cai de 1 para 0.

**O backfill de cor apagava preço bom.** Um bloco cujo escopo é acrescentar `tint_nome_cor`
reconstruía `sales_orders.items` **inteiro** a partir da leitura atual do Omie e gravava por cima.
Se o Omie tivesse parado de informar `valor_unitario` desde o sync original, o preço bom era
apagado por uma leitura pior — perda silenciosa num campo que o backfill nem pretendia tocar.
Agora o preço é **mesclado** (`mesclarPrecoPreservado`): o gravado vence sempre que for utilizável.

> **Regra que sai daqui:** um writer que **reconstrói** um registro inteiro para mudar **um campo**
> carrega junto todos os outros, e a leitura de hoje pode ser pior que a de ontem. Ou ele mescla,
> ou o escopo declarado ("backfill de cor") é menor que o escopo real.

**DROP+CREATE de função RESETA o ACL — e `private` não fecha nada.** As duas funções de margem
ganharam colunas no `RETURNS TABLE`, o que o Postgres não aceita via `CREATE OR REPLACE`. O DROP
faz a função renascer com `EXECUTE` para `PUBLIC`, e o schema `private` **concede USAGE a `anon` e
`authenticated`** (medido em prod) — é o `REVOKE` que fecha, e só ele. Sem os REVOKE/GRANT
reemitidos por nome, esta migration teria **aberto a margem por cliente**, isto é, custo agregado,
ao browser. A postcondição embutida verifica o ACL e aborta a transação se ele não estiver fechado.

## O que a prova mede

`db/test-preco-ausente-nao-e-zero.sh` — PG17 real, **45 asserts**, exit 0. Roda em dois tempos:

1. **ANTES**: aplica só o que hoje está em prod e mede o bug. O item sem preço vira `0` e puxa a
   margem do cliente para **−20,00**. Sem esta metade, a metade seguinte provaria uma correção sem
   provar que havia o que corrigir.
2. **DEPOIS**: aplica a migration e mede a correção nos quatro objetos, incluindo o ACL e o
   `SECURITY DEFINER`, e o barramento de `authenticated` por **SQLSTATE 42501** (não por contagem
   de linhas, que confundiria "barrado" com "não achou nada").

Cinco sabotagens confirmam o dente, com destaque para duas:

| Sabotagem | Verdadeiro | Sob sabotagem |
|---|---|---|
| helper volta a `>= 0` | margem 76,00 | **52,00** (a fabricação, medida) |
| diff volta a NULL-blind | 1 correção | **0** (o zero informado nunca entraria) |

## O que o challenge do Codex acrescentou

O ritual `/codex` (gpt-6-astra, reasoning max) rodou sobre os dois primeiros commits e achou
**quatro P1** que eu não tinha achado. Os quatro são da mesma família, e a família é a lição:

> **Tornar uma coluna nullable não é uma mudança local.** A régua nova estava certa; o `null` que
> ela produz é que encontrava consumidores que ninguém tinha olhado. Depois de um `DROP NOT NULL`,
> a pergunta obrigatória não é "meu código trata null?", é **"quem mais lê esta coluna?"** — e a
> resposta se obtém do catálogo (`pg_get_functiondef ~ 'coluna'`), não da memória.

O que a varredura do catálogo pega, e o que ela não pega:

| Onde o NULL entra | Sintoma | Como se acha |
|---|---|---|
| `a * b` numa soma | receita 0 com custo cheio | grep por aritmética na função |
| denominador de média | valor **diluído**, não ausente | ler a expressão inteira, não a coluna |
| `ORDER BY … DESC` | NULL vai para o **topo** | saber o default do Postgres |
| consumidor TS da RPC | `Number(null)` = 0 | seguir a RPC até quem a chama |

Os dois primeiros são invisíveis a um grep por `unit_price`: aparecem só quando se lê a expressão
completa. O terceiro não aparece nem lendo a expressão — depende de saber que `DESC` é `NULLS FIRST`.

**A média diluída foi o achado mais fino.** Em `get_defasagem_cliente`, o último preço praticado é
`sum(unit_price * quantity) / sum(quantity)`. O numerador ignora a linha sem preço, porque `sum`
pula NULL; o denominador **conserva a quantidade dela**. Duas linhas do mesmo SKU e dia, quantidade
1 cada, preços 100 e NULL, davam **50**. Não é um valor ausente nem um zero: é um preço plausível,
que ninguém praticou, e que segue para markup e classificação de defasagem. Um valor errado que
parece certo é pior que um nulo, porque nada o sinaliza.

Também vale registrar o que **eu errei ao corrigir**: troquei `item.valor_total ||` por um teste de
nulidade em `itemTotal` e, com isso, `{valor_total: 0, quantidade: 2, unitario: 50}` passou a
devolver 0 em vez de 100. O `||` tratava 0 como "ainda não calculado" — que é exatamente o estado
de um rascunho. **Havia um teste fixando esse caso, e ele estava na suíte que eu não tinha rodado
ainda.** A lição não é sobre `||`: é que uma mudança de "falsy" para "nullish" muda o comportamento
de TODOS os valores falsy, e o 0 quase sempre é um deles.

Um P2 do Codex foi **fechado por medição, não por argumento**: ele apontou que a mescla lê só
`valor_unitario` e disse explicitamente não ter podido confirmar o shape em produção. Consultei:
dos 70.927 itens do items-jsonb, **70.927 têm `valor_unitario` e zero têm `unit_price`**. O shape é
único. Um "não confirmei" do revisor é um convite a medir, não um item a descartar.

## O estado em produção

Medição por `psql-ro` em 2026-09-05: **70.852 itens** em `order_items`, **zero** com preço 0,
zero negativos, zero nulos. O caso é **latente**, não corrente.

Isto é dito aqui porque muda o que a entrega promete: ela **impede a fabricação futura**, não
conserta nenhuma linha existente, e nenhum health score muda de valor no dia do apply. O motivo de
fazer agora é que a defesa que já existia era inalcançável — e uma defesa inalcançável é pior que
nenhuma, porque o teste verde ao lado dela desencoraja quem passaria por ali de olhar de novo.

## A armadilha que peguei no fim: o mutcheck interrompido comita por você

O `test:edges` passou local e reprovou no CI. A causa não era ambiente: o commit levava uma
alteração que eu **não escrevi** — `ATRASO_BASE_MS` de 1000 para 800 em
`_shared/cmc-snapshot-retry.ts`. É uma **mutação plantada pelo `bun run mutcheck`**, que eu rodei
sob `timeout 600` para diagnosticar o job vermelho. O timeout matou o processo no meio de um
contrato, **antes do cleanup que restaura o arquivo**, e o `git add -A` seguinte varreu o bug para
dentro do commit.

> **Uma ferramenta que ESCREVE no working tree para depois restaurar deixa lixo quando é
> interrompida — e `git add -A` não distingue o que você escreveu do que ela plantou.** Antes de
> commitar depois de rodar mutcheck (ou qualquer harness de falsificação que sabote o repo), rode
> `git status` e olhe a LISTA, não só o seu recorte mental do que mudou. E nunca envolva essas
> ferramentas em `timeout` sem prever a restauração.

É a irmã da regra que o CLAUDE.md já tem ("COMMITE antes de falsificar — `restaurar()` costuma ser
`git checkout --`"), pelo outro lado: ali o risco é a restauração **apagar** seu trabalho; aqui é a
restauração **não acontecer** e o trabalho dela virar seu.

Dois sinais funcionaram como projetado, e vale dizer quais:

- **O teste de equivalência do backoff pegou a mutação.** É literalmente para isso que o mutcheck
  existe — só que desta vez ele mediu um bug que estava commitado, não plantado.
- **A divergência local-verde / CI-vermelho foi o que denunciou o commit sujo.** Local eu já tinha o
  arquivo restaurado por uma re-execução; o CI leu o que estava commitado. Quando local e CI
  discordam sobre um teste PURO (que não lê ambiente nem rede), a primeira hipótese não é "flake":
  é **o working tree e o commit terem conteúdos diferentes**.

## Desfecho: aplicado, validado e EXECUTADO (2026-09-06)

O founder colou a migration no SQL Editor. A verificação foi em três camadas, e as três eram
necessárias porque cada uma responde a uma pergunta diferente:

| camada | pergunta | resultado |
|---|---|---|
| `db/valida-preco-ausente-nao-e-zero.sql` | os objetos existem no estado certo? | 10/10 ✅ (antes: 8 ❌) |
| `pg_proc.proacl` comparado ao pré-apply | o `DROP FUNCTION` abriu alguma? | idêntico, função por função |
| `db/sonda-exec-preco-ausente.sql` | elas **rodam**? | as 6, sem quebra |

A terceira não é redundante, e é a que quase ficou de fora. As duas primeiras leem o **catálogo**:
elas provam que o objeto existe e com que privilégio. **Existir não é funcionar** — SQL e plpgsql
são late-bound, o `CREATE` aceita corpo que só quebra ao RODAR, e este repo já pagou isso 3x. Sem a
sonda, a fatia teria sido declarada pronta com base em duas evidências que não tocam o corpo.

> **A validação de catálogo e a de execução respondem perguntas diferentes.** Depois de um apply que
> recria função, as duas são obrigatórias — e a de execução é a que o ritual esquece, porque a de
> catálogo dá ✅ e parece suficiente.

**Escrever a sonda quase produziu um veredito fabricado**, e isso vale mais que a sonda. O gate
interno de staff e o `permission denied for function` do ACL compartilham a **SQLSTATE 42501**. A
primeira versão classificava só pelo código e respondeu **GATE** — "o corpo rodou até o gate" — para
uma função em que ela **nem tinha entrado**. Ausência de acesso lida como aprovação, dentro de uma
ferramenta cujo trabalho é justamente separar os dois. Corrigida, ela distingue três estados, e o
terceiro é o que faltava: **SEM ACESSO não é veredito**.

Dados intactos após o apply: os mesmos 70.852 itens, zero nulos, zero zeros — a migration só mexe em
schema e função. A reprodução do helper sobre os dados reais dá 1.227 clientes, 43.587 itens
computáveis, **0 sem preço** e 27.225 sem custo: o gargalo da cobertura de margem é, e continua
sendo, **custo** — não preço.

## Pendências assumidas

- **`omie-vendas-sync:3161`** (trava de crédito na edição) faz `Number(oi?.produto?.valor_unitario) || 0`
  sobre o `ConsultarPedido`: item sem preço **reduz** `totalAtualOmie` e **afrouxa** o gate de
  aumento de exposição. É money-path e fica fora desta fatia de propósito — mexer no gate de
  crédito pede a sua própria medição e a sua própria prova.
- **Sites de catálogo** (`omie_products.valor_unitario`, ~6 edges) mantêm `|| 0`. É outro campo e
  outro consumidor; o gate textual desta fatia é específico (`prod.valor_unitario || 0`) justamente
  para não dar verde medindo o catálogo em vez do item de pedido.
