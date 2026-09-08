# A invariante do agregado não tinha dono — o pedido de venda

**2026-09-07.** Frente estrutural, não bugfix. Origem: parecer Codex (gpt-6-astra, reasoning max)
sobre a taxa de reincidência do repo — *"a raiz é fragmentação da responsabilidade pela correção.
A invariante pertence ao pedido, à transação ou ao conjunto publicado; implementação e verificação
frequentemente cobrem apenas um arquivo, escritor ou camada."*

## O experimento que já estava no banco

O agregado **pedido de venda** tem três invariantes. Só uma é estrutural — e é a única que não viola.
Mesma tabela, mesmos escritores, mesmo time; a variável é ter ou não estrutura no ponto de escrita.

| Invariante | Proteção | Violações em prod (2026-09-07) |
|---|---|---|
| **I1 identidade** — 1 pedido Omie = 1 linha canônica | `uniq_sales_orders_omie_pedido_id` (UNIQUE parcial) | **0** — 25 grupos duplicados, 25 com exatamente 1 canônico |
| **I2 composição** — `items` jsonb ≡ `order_items` | nenhuma | **39** pedidos |
| **I3 valor** — total = Σ itens | nenhuma | **7** pedidos |

Ressalva de leitura (Codex): o índice parcial garante **no máximo** um canônico, não a existência.
"Exatamente 1 em 25/25" combina garantia estrutural de unicidade com propriedade observada.

## Por que as correções anteriores não fecharam a classe

- **2026-06-17** — RPC atômica `criar_pedidos_com_itens` (pai+filho na mesma transação).
- **2026-08-30** — RPC `reconciliar_pedidos_omie`, `FOR UPDATE` no pai, diff dentro da transação, 87 asserts PG17.

Mesmo assim **8 pedidos divergentes nasceram depois da primeira** (o mais recente criado em 11/08).
A proteção ficou **dentro do escritor certo**; o agregado seguiu sem dono.

**O escritor alternativo é real e está em produção:** `supabase/functions/omie-vendas-sync/index.ts:3381`
atualiza `items` + `subtotal` + `total` de um pedido canônico e **nunca toca `order_items`**.
Aquele código é cuidadoso — checa 0 linhas, devolve erro honesto, passou por revisão do Codex ("P1 do diff").
O revisor perguntou *"esta escrita está correta?"*, não *"o pedido segue coerente depois dela?"*.
É a fragmentação em uma linha de código.

Assimetria que explica a classe: **`order_items` tem 2 escritores** (as duas RPCs), **o jsonb tem 11** —
e 9 deles gravam só o jsonb. Todo o lado push/app grava cabeçalho sem linhas.

## Dano medido (precisão > recall: duplicata benigna separada de defeito)

Dos 28 pedidos sem linhas, **25 são linha "push" não-canônica cujo gêmeo tem os itens** (desenho
legítimo: push do app + pull do Omie coexistem) e 2 são rascunho/orçamento. Ali a perda real é R$ 314,40.

O dano de verdade está na divergência **parcial**: **15 pedidos canônicos**, 14 `faturado`,
R$ 27.795,25, 63 diferenças de item. Como `fin-valor-cockpit`, `algorithm-a-audit` e `apriori`
ancoram em `order_items`, item não escrito vira **vazio, não erro** — **R$ 10.676,56 de venda
faturada invisível** para o money-path.

## A correção: a invariante passa a pertencer ao agregado

`supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql` — **CONSTRAINT TRIGGER
DEFERRABLE INITIALLY DEFERRED** nas **duas** pontas (`sales_orders` e `order_items`), chamando **um único
verificador** que relê o estado pelo id.

Decisões que importam:

- **Condicionada à existência de linhas.** Pedido sem `order_items` é push do app — desenho legítimo,
  fora do escopo. "Sempre coerente" reprovaria o desenho certo junto com o defeito.
- **DEFERRABLE** porque as RPCs legítimas escrevem cabeçalho e linhas em statements sucessivos: só o
  COMMIT é um instante em que a coerência precisa valer. Já o escritor PostgREST (1 statement = 1
  transação) é avaliado no commit dele — que é exatamente o que se quer barrar.
- **Sem `UPDATE OF items`** (Codex): outro `BEFORE UPDATE` pode alterar `items` sem a coluna aparecer
  na cláusula, e a trigger não dispararia.
- **`ENABLE ALWAYS`**, senão `session_replication_role='replica'` desliga a invariante inteira.
- **Compara `(produto, quantidade, preço, desconto)` por `EXCEPT ALL` nos dois sentidos.** Contagem
  igual é necessária e insuficiente — trocar produto de mesmo preço passaria. `EXCEPT ALL` preserva
  multiplicidade e trata NULL como não-distinto de NULL: **ausente ≠ zero** nos dois espelhos.
- **NÃO valida I3 (valor).** A semântica de `desconto` está contraditória entre escritores — o sync
  aplica `qtd*preço*(1−desconto/100)`, o cockpit `qtd*preço−desconto`. Hoje é **latente**: desconto é
  0 em 100% dos 70.889 itens do jsonb e das 70.860 linhas. Fixar uma fórmula agora seria escolher
  regra financeira sem decisão de produto.

## Prova e falsificação

`db/test-pedido-venda-coerencia.sh` — **31 asserts, PG17 descartável, dois locales, exit 0**.
**Roda no CI**: o #2364 (mergeado durante esta frente) criou o job `provas-sql` e a allowlist
`db/nucleo-ci.txt`; esta prova está registrada lá com `asserts≥31`, no caminho obrigatório do merge.
⚠️ Ao registrar, o formato da linha de contagem importa: o runner lê `PASS=n FAIL=n`,
`RESULTADO: n ok / n fail` ou `n ok / n fail` — o `n ok, n falhas` que eu usava **não casa**
(`falh` ≠ `fail`) e teria reprovado com "exit 0 mas SEM contagem". Verificado aplicando a regex
do runner na saída real, não lendo-a.

- **ANTES**: reproduz o escritor alternativo real e mostra o banco aceitando a corrupção.
- **DEPOIS**: o mesmo update é recusado; escrita atômica e push do app seguem passando.
- **Ataques por fora** (exigência do parecer): delete de linha solto, linha fantasma, update de preço
  só na linha, preço→NULL, jsonb sem a chave de preço, jsonb esvaziado, `SET CONSTRAINTS ALL IMMEDIATE`,
  `COPY`, `discount` NULL vs `"desconto":0`. Todos bloqueados.
- **Concorrência**: duas metades da mesma reconciliação em transações separadas, por FIFO (ordem
  determinística, sem sleep-e-torcer) — ao menos uma recusada e estado final coerente. Idem sob
  `REPEATABLE READ` (o furo apontado no parecer não se materializou neste cenário; não foi testado
  exaustivamente, e a serialização por escrita técnica no pai não foi necessária aqui).
- **Falsificação**: derrubar as triggers faz os ataques voltarem a passar (os asserts têm dente); e
  sabotar o `ENABLE ALWAYS` faz o **apply abortar** na postcondição — com **controle verde na mesma
  invocação**, senão a sabotagem não provaria nada.

## Passivo e o que NÃO foi feito

Ligada hoje, a invariante reprova **15 de 31.219** pedidos com linhas (**0,048%**); 31.204 passam sem
alteração. Esses 15 ficam impedidos de receber UPDATE até reparo — **o reparo não vai junto de
propósito**: mexer em itens de pedido faturado é correção financeira, não centralização de proteção,
e pede decisão caso a caso.

Também não foi feito: corrigir o escritor alternativo (`omie-vendas-sync:3381`) para escrever as duas
metades na mesma transação. Enquanto não for, a edição de pedido no Omie passa a **falhar em vez de
corromper** — com o agravante de que o Omie já foi mutado quando a recusa acontece.
