# O dry-run apurou 215/215 — o número que daria também com os campos de desconto AUSENTES

**2026-09-10** · `supabase/functions/omie-desconto-backfill/` · money-path · irmão de [desconto-a-sonda-lia-campo-que-nao-existe.md](desconto-a-sonda-lia-campo-que-nao-existe.md) e [fase-sem-sinal.md](fase-sem-sinal.md)

## O que aconteceu

A sequência de execução do backfill de `order_items.desconto_valor` (Oben/TTM) foi fechada com o Codex no #2448: dry-run de 1 página → dry-run completo com alvo congelado → canário escrito conferido **por ID e por valor** → restante. Dois freios: *nenhum percentual agregado autoriza escrita*, e *controle positivo obrigatório antes de escrever* (casos reais com desconto > 0, qtd > 1, tipos `V`/`P`).

O passo 1 rodou em produção (bundle v1.2): 100 pedidos, 2 sem pai local, **215 linhas oferecidas, 215 apuradas, zero recusas** nos quatro motivos. Resultado limpo — e mudo sobre o que importava:

- o casamento é pelo trio (SKU, qtd, preço), que **não depende** dos campos de desconto;
- a régua `descontoItemOmie` devolve `0` quando os três campos (`tipo_desconto`, `valor_desconto`, `percentual_desconto`) vêm ausentes — é o contrato dela ("o Omie não informou desconto").

Logo, **215/215 é exatamente o número que sairia se a resposta não trouxesse os campos**. E a resposta só tinha contagens: nem quantas apuradas eram > 0, nem o tipo, nem quais IDs. O controle positivo exigido "antes de escrever" era impossível pelo caminho do backfill, e "os IDs escritos batem com o plano" só era conferível por contagem.

## A forma generalizável

> **Sensor de COBERTURA não é sensor de VALOR.** Quando o numerador é produzido por um caminho que não depende do campo que carrega o dinheiro, cobertura de 100% é compatível com esse campo ausente. Antes de aceitar uma cobertura como controle, pergunte: *este número seria diferente se o campo que importa viesse vazio?* Se não, o sensor mede o casamento, não o dado.

É o `ausente ≠ zero` no eixo do **instrumento**: a régua degrada certo (ausência → 0 é decisão documentada dela), e é justamente por isso que a origem do 0 precisa ser observável em outro lugar. A suíte do módulo tinha o mesmo ponto cego no nome de um teste — *"o Omie informou que NÃO há desconto"* com uma fixture **sem nenhum campo de desconto**: informar zero e não informar nada eram o mesmo caso.

## O que o protocolo pressupunha

A sequência do Codex exigia IDs e controle positivo; a edge só devolvia contagens. Descobrir a lacuna **no passo 1, que não escreve**, é o desenho funcionando. Descobri-la no canário teria sido escrita às cegas — e o `fin-valor-cockpit` já lê `desconto_valor` (`null` fica fora da receita; valor entra), então zeros fabricados converteriam "não apurado" em "sem desconto" na tela.

## O que mudou (v1.3)

- `_shared/desconto-backfill.ts`: toda linha apurada carrega `origem` — `ausentes` / `zerados` / `informados` / `invalidos`, o tipo normalizado e a **base do item do Omie** que casou. O sensor **não muda o valor** apurado (a régua segue decidindo).
- A resposta ganha `diagnostico` (positivas e zeros por origem, qtd > 1, tipos V/P/vazio/outro), a **conferência de cada pedido contra `total_pedido.valor_descontos`** do próprio Omie (testemunha por valor que não passa pelo casamento com o banco), `amostra_positivas` (um representante garantido por combinação tipo × qtd>1, com nº do pedido para conferência à mão), a reconferência das linhas que a ingestão já gravou (controle CONHECIDO) e `desfechos` por ID — é o que torna "IDs escritos batem com o plano" conferível por fora, contra o banco.
- A **escrita ficou restrita à janela** que o denominador mede (`pedidoNaJanela`): o filtro do `ListarPedidos` é por inclusão OU alteração, e um pedido antigo alterado na janela oferecia filhos NULL ao plano.
- Os dois `continue` do laço de pedidos (sem código, sem linhas locais) passaram a contar, e o de fora da janela também: os pedidos fecham.
- `desconto-omie.ts` ficou intocado de propósito: o `omie-vendas-sync` também o importa, e mexer nele mudaria o fingerprint do sync e exigiria redeploy dele.

## O que a 2ª opinião pegou no próprio sensor

O 1º desenho classificava pela presença de **qualquer** campo — e `{tipo_desconto: "X"}` sem número virava `zerados`, afirmando um zero que o Omie não informou (P1 do Codex). O instrumento feito para separar "zero informado" de "zero por ausência" reproduzia a confusão num caso de borda. Hoje a classificação olha só os campos numéricos. Os outros achados que entraram: a base do sensor era a local (qtd 1,0000001 casa com 1 e contaria como "qtd > 1" — evidência fabricada), a amostra podia excluir justamente a combinação que decide a semântica do percentual, e o alvo congelado **não restringia a escrita** (preexistente — virou a restrição de janela). O que ficou como procedimento, sem mudar a edge: a janela é recalculada em UTC a cada invocação, então cada passada roda dentro de um dia UTC e recomeça da pág. 1 se a janela mudar; `completo: true` é o fim da paginação observada, não cobertura do alvo — esta se mede por ID.

Prova: módulo 45/45 (22 testes novos), mutcheck 33/33 pegas com controle+ (17 mutações novas; 1 mutação antiga precisou ser reescrita porque o tipo novo a deixou sem compilar — o runner a acusou como INVÁLIDA, não como pega).
