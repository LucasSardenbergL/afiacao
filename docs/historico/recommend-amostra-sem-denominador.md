# A amostra que media a população errada — `sim_score` do motor de recomendação

**Entrega:** `fix(recommend)` 2026-08-21 · edges `recommend/index.ts` + `_shared/recommend-leituras.ts`
**Origem:** dois defeitos deixados NOMEADOS pelo #1836 (que tratou truncagem de transporte), mais
um terceiro que só apareceu ao medir. Challenge Codex `gpt-5.6-sol/xhigh`.
**Irmão da mesma classe:** [`roteirizador-corte-cidades.md`](roteirizador-corte-cidades.md) — 2ª vez
no repo que um corte por ranking usa um EIXO que não é o da decisão que a tela serve.

## O que se sabia, e o que estava errado no que se sabia

Sabia-se de dois defeitos: (a) `clusterSize` contava os até 100 clientes lidos enquanto o
numerador vinha dos 50 amostrados, então `sim` saía pela metade; (b) `.order("id").limit(100)`
não é amostragem, é sorteio estável por UUID.

Medindo, o defeito dominante era um TERCEIRO, invisível nos dois enunciados: **87% do cluster
`critico` (5.406 de 6.185) é `sales_history_status = 'sem_historico'`** — cliente sem venda
válida monetizada. A amostra de 50 pegava ~42 dessas linhas. Elas entram no **denominador** de
`sim` e nunca no numerador. Dos 50 amostrados, **8** tinham qualquer compra.

Ou seja: o problema não era *quais* 100 sortear, era que a população sorteada não era a
população da pergunta. Aumentar a amostra não corrigiria — só adiaria, exatamente como o
teto de 500 cidades do roteirizador.

## A lição de método: os dois consertos eram ACOPLADOS

| | `sim` máx em `critico` | cruza 0,10? |
|---|---|---|
| hoje | 0,04 | não |
| só o denominador | 0,08 | não |
| só o filtro de histórico | 0,09 | não |
| os dois | **0,18** | **sim** |

Nenhum dos dois isolado muda comportamento observável no cluster onde estão 91,6% dos clientes
reais. Entregar "o de uma linha primeiro" teria produzido um PR verde, correto e **inerte** — e
a leitura natural depois seria "corrigimos e não mudou nada, então não era problema".

⚠️ Mas a recíproca também é armadilha, e o Codex pegou: isolados eles **não** são inócuos nos
outros clusters (`atencao` 1→4 produtos cruzando 0,10; `estavel` 0→8) nem em `probability`, que
o vendedor VÊ como "Prob. conversão". "Não muda nada" era verdade só em `critico`.

## O sinal: evidência com denominador

`recommendation_log`, medido em 2026-08-21 **antes do deploy** = 666 impressões `cross_sell`
(última no próprio dia) + 27 `repurchase` + **zero `cluster_based`, em 693 impressões desde
fevereiro**. A edge rodava; o ramo nunca havia disparado. (Deixou de ser verdade em 2026-08-22,
por causa desta entrega — ver a seção de verificação no fim.)

E a prova é **construtiva**, não estatística: com denominador 100 o `sim` máximo era 0,04 /
0,12 / 0,10 nos três clusters, e o corte de `cluster_based` é 0,15 — inalcançável nos três.
Isso importa porque `assoc > 0` **precede** o teste de cluster no `if`, então "zero impressões"
sozinho não provaria a causa; a medição dos máximos prova.

## O que NÃO estava morto (correção do Codex à minha própria leitura)

Dizer "o ramo de similaridade está morto" era errado. `minMaxNorm` é `(v-min)/(max-min)`: com
todos os `sim` entre 0 e 0,04, o maior candidato ainda é normalizado para **1,0** e leva o peso
`w_sim` (0,20) inteiro. O que estava morto era a **apresentação** (`recommendation_type` e a
explicação percentual); o **sinal de ranking** sempre esteve em força total.

Corolário que vale além deste caso: **normalização min-max apaga a escala, então "o número é
minúsculo" não implica "não influencia o ranking"** — e, na direção oposta, um fator uniforme
some no componente normalizado mas **sobrevive** em qualquer corte contra constante e em
qualquer caminho não-linear (aqui, `simNorm → sigmoid → probability → eip`, de peso 0,35).

## Por que whitelist e não `.neq('sem_historico')`

`sales_history_status` é NULLABLE (zero nulos hoje; o schema permite) e negação no PostgREST é
NULL-blind — o `.neq` excluiria NULL por efeito colateral invisível. Pior: um status **novo**
que signifique "sem venda" entraria sozinho na amostra e reabriria o defeito em silêncio.
`.in(['ativo','stale'])` falha **fechada**. A paridade com a união `SalesHistoryStatus` de
`src/lib/scoring/salesHistoryStatus.ts` virou gate de vitest, porque o Deno não enxerga `src/`.

## Segue aberto (nomeado nos dois arquivos para não passar por consertado)

- **auto-inclusão**: o cliente que recebe a recomendação pode estar entre os 50 e contar no
  próprio denominador — falta leave-one-out com reposição da vaga;
- **o teto plano de 1.000 compras MORDE hoje** em `atencao` e `estavel` (1.000 exatas). Como
  `order_items.id` também é UUID, o corte é amostra de LINHAS e não janela temporal: comprador
  pesado ocupa mais linhas e pode deixar outro cliente do cluster sem nenhuma linha observada —
  que o denominador então trata como "não comprou". O certo é agregar no banco (últimos K
  PEDIDOS por cliente, dedup `(cliente, produto)`) via RPC;
- o cluster é global por `health_class` e **ignora `farmer_id`**, embora a coluna exista;
- **os cortes 0,10/0,15/0,20 não foram recalibrados.** Com n=50 e comparação estrita exigem 6, 8
  e 11 clientes distintos; o máximo medido depois do conserto é 9. A explicação percentual segue
  inalcançável em `critico` — e o Codex tem razão em não baixá-la agora: em 9/50 o intervalo de
  95% vai de ~10% a ~31%, e mostrar "18%" como fato ao vendedor é afirmar mais do que se mediu.

## Verificado em produção (2026-08-22, pós-deploy manual da edge)

O deploy da edge é manual pelo chat do Lovable, então merge na main não bastava. Verificado
abrindo a aba **Oportunidades** de um cliente `atencao` no app logado: o painel renderizou e a
edge gravou 5 impressões novas às 02:52 UTC — as primeiras desde 21/08 20:04.

| tipo | `score_sim` | clientes se den=50 | se den=100 |
|---|---|---|---|
| **`cluster_based`** | **0,1800** | **9** | 18 |
| `repurchase` | 0,0600 | 3 | 6 |
| `cross_sell` ×3 | 0,0000 | 0 | 0 |

Dois fatos independentes, cada um conclusivo sozinho:

1. **`score_sim = 0,18` era impossível no código velho.** Com denominador 100 o teto absoluto
   medido nos três clusters era 0,12 (`atencao`, 12/100); 0,18 exigiria 18 clientes distintos
   no mesmo produto, e o máximo medido em `atencao` é 12. Com denominador 50, 0,18 são 9
   clientes — que cabe. A coluna "se den=100" existe para mostrar a leitura absurda que o
   código antigo precisaria.
2. **`cluster_based` apareceu pela primeira vez em 698 impressões.** Exige `sim > 0,15`,
   inalcançável sob o teto de 0,12.

Método que vale reusar: **a assinatura de versão não foi o tipo novo, foi o VALOR impossível.**
`cluster_based` podia não aparecer mesmo com o código certo, porque `hasPurchased` e `assoc > 0`
precedem o teste de cluster no `if`. Já `score_sim > 0,12` não depende de precedência nenhuma —
é aritmética do denominador. Escolher a assinatura que o caminho de código NÃO consegue suprimir
é o que separa prova de indício. (É a técnica do `docs/agent/deploy.md` §"a edge que ESCREVE numa
tabela carrega a prova do próprio deploy", com a diferença de que aqui a testemunha é um valor
CONTÍNUO, não um enum — e por isso sobrevive à preempção.)

### O que a primeira observação real já mostrou

A linha `cluster_based` saiu com `explanation_key = **margin**`, não `cluster`. Não é defeito
novo: é a **inconsistência entre gates** que o challenge Codex havia derivado no papel, agora
visível em produção. O tipo usa `sim > 0,15` e a explicação usa `sim > 0,20`, então a faixa
[0,15 · 0,20] produz uma recomendação ROTULADA como "cluster" que **explica outra coisa** ao
vendedor. Com o máximo medido em 0,18 (`critico`) e 0,24 (`atencao`), essa faixa não é canto
raro — é onde a maior parte do sinal vive hoje. Fica para a entrega de recalibragem, com o
gatilho já satisfeito (existe sinal com denominador); o que NÃO se deve fazer é baixar 0,20
para 0,15 sem antes decidir o que a explicação percentual afirma, porque em 9/50 o intervalo
de 95% vai de ~10% a ~31%.

## Prova reproduzível

`db/recommend-amostra-cluster-antes-depois.sql` (read-only, roda no `psql-ro`) — replica verbatim
a lógica antiga e a nova, e imprime também o denominador de uso do `recommendation_log`.
