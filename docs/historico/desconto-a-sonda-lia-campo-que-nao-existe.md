# O desconto era ambíguo entre dois consumidores — mas a sonda que "provou" o empate lia um campo que a API não tem

**2026-09-07** · `supabase/functions/_shared/desconto-omie.ts` · money-path · irmão de [gates-textuais-cegos.md](gates-textuais-cegos.md) e [fase-sem-sinal.md](fase-sem-sinal.md)

## O que se procurava

Uma **ambiguidade semântica** no campo `desconto` de item de pedido de venda, apontada pela revisão do Codex durante a frente do agregado (#2363). Dois consumidores, a mesma coluna, fórmulas incompatíveis:

| Consumidor | Fórmula | Semântica |
|---|---|---|
| `omie-vendas-sync:1304`, `:1500`; `_shared/omie-pedido.ts:104`; `auditoria-margem.ts:46`; `algorithm-a-audit:44` | `qtd·preço·(1 − d/100)` | percentual |
| `fin-valor-cockpit:616`; `valor-cockpit-helpers.ts:541` | `qtd·preço − d` | valor absoluto |

Com qtd=2, preço=100, desconto=10: **180 contra 190**. São 7 consumidores, não 2 — o enunciado subestimava o alcance.

A justificativa para nunca ter aparecido era: `desconto` é 0 em 100% do acervo (70.889 itens do jsonb + 70.860 linhas de `order_items`, e antes 68.459/68.459 em 2026-07-21), e onde o desconto é zero as duas fórmulas coincidem.

## O que se achou

**A explicação estava certa no fato e errada na causa.** O zero não é "a operação não dá desconto". A ingestão lê `prod.desconto` — e esse campo **não existe na API do Omie**.

Doc oficial, lida em 2026-09-07 (`GET https://app.omie.com.br/api/v1/produtos/pedido/`). A entidade `det.produto` expõe **três** campos de desconto:

```
tipo_desconto        string(1)   discriminador — "V" = valor, "P" = percentual
percentual_desconto  decimal     percentual (0-100)
valor_desconto       decimal     valor em moeda
```

`grep -c '^desconto$'` na doc inteira = **0**. As únicas variantes são as seis acima mais `valor_descontos` (total calculado). O código lia uma chave que a origem nunca envia: `undefined` → `|| 0` → grava 0, para sempre, em todo item.

Consequências, em ordem de gravidade:

1. **A pergunta estava mal-posta.** "Percentual ou absoluto?" não tem resposta binária: o Omie manda os dois e um discriminador que diz qual vale. Nenhuma das duas fórmulas em produção estava certa sozinha — inclusive a que "venceria" um desempate.
2. **O 100% de zeros é cegueira da sonda, não medição.** Nenhuma das três medições (70.889, 68.459, 44.461) diz nada sobre a operação. Elas mediram um campo inalcançável.
3. **Não se sabe se há dinheiro sendo perdido.** Se a operação pratica desconto por item, ele é descartado na ingestão hoje, e a receita registrada está **superestimada**. Isso não é latente — seria um erro ativo. Provar exige um payload real do Omie, que nenhuma consulta ao nosso banco substitui.

## A forma generalizável

> **Zero medido num campo que a origem não preenche prova a ingestão, não a realidade.** Antes de tratar "0 em 100% dos casos" como fato do negócio, verifique que o campo lido EXISTE no contrato da origem. Um acervo unânime é evidência forte de que ninguém escreve ali — e "ninguém escreve" tem duas causas indistinguíveis pelo dado: não há o que escrever, ou o escritor mira no lugar errado.

É a §Armadilhas do CLAUDE.md — *ausência de sinal não é aprovação* — no eixo do **contrato de leitura**: o `grep` que não acha confere caixa e acento, mas a sonda que lê `obj.campo_inexistente` não tem sequer o que conferir. `undefined` é silencioso, e `|| 0` o converte num número plausível.

## O erro de raciocínio que quase se repetiu

A migration [`20260723160000_farmer_margem_correcoes_review.sql:151-165`](../../supabase/migrations/20260723160000_farmer_margem_correcoes_review.sql) já tinha chegado perto em 2026-07-21: registrou a ambiguidade, mediu os zeros, recusou-se a fixar uma semântica no cara-ou-coroa (decisão certa) e escreveu que o campo era morto "por erro de nome na ingestão". Mas a prova que ela deu foi:

> `omie-vendas-sync` grava `prod.desconto`, mas a API do Omie expõe `valor_desconto` — nome que `omie-financeiro` usa corretamente.

**A conclusão estava certa; o argumento, não.** Ele cruzou dois endpoints diferentes: `omie-financeiro` lê contas a receber, não itens de pedido. Verificado na doc de `/api/v1/financas/contareceber/`, a entidade do título (`conta_receber_cadastro`) **não tem campo de desconto nenhum** — `valor_desconto` tem 0 ocorrências ali, e o `desconto` que existe pertence à entidade de **baixa** (`conta_receber_lancar_recebimento`). Ou seja: `omie-financeiro:810,954` grava `valor_desconto: t.valor_desconto || 0` de um campo que aquela resposta também não traz.

A lição não é sobre o Omie: **"o vizinho faz assim e funciona" não é evidência quando o vizinho fala com outro contrato.** A afirmação certa veio de ler a doc do endpoint em questão, não de generalizar do endpoint ao lado.

## A ordem da correção não é livre

Achado de desenho que vale mais que o helper: **os consumidores vêm antes da ingestão.**

- Com o acervo em zero, trocar a fórmula dos 7 consumidores é **numericamente inerte** — nenhum número em produção muda, e a mudança é verificável a custo baixo.
- Corrigir a ingestão primeiro **ativa** a divergência: no instante em que o primeiro desconto real for gravado, os 5 consumidores percentuais passam a calcular errado sobre um dado que antes era neutro.

O zero que escondeu o bug é a mesma propriedade que torna a correção dos consumidores segura. É uma janela, e ela fecha na primeira ingestão corrigida.

## O fail-closed morre na fronteira do banco

Apontado pela revisão do Codex e confirmado: [`20260906180000_order_items_identidade_linha.sql:361`](../../supabase/migrations/20260906180000_order_items_identidade_linha.sql) faz `coalesce((it->>'discount')::numeric, 0)`. A linha imediatamente acima, do `unit_price`, usa `CASE WHEN … THEN … END` e deixa o NULL passar.

O mesmo contraste está em [`sync-reprocess/index.ts:298-302`](../../supabase/functions/sync-reprocess/index.ts): três linhas de comentário explicam que `unit_price` preserva `null` porque *ausente ≠ zero* — e a linha seguinte escreve `discount: prod.desconto || 0`.

> **Uma régua aprendida num campo não se propaga sozinha para o vizinho da mesma linha.** O `null` que um helper devolve só sobrevive se TODA a cadeia até a coluna souber recebê-lo; um `coalesce(...,0)` na RPC apaga o fail-closed sem deixar rastro.

## Como o teste foi provado (e o que a prova achou)

O acervo atual não distingue as duas regras, então uma suíte construída sobre ele fica verde sem medir nada. A suíte ([`desconto-omie_test.ts`](../../supabase/functions/_shared/desconto-omie_test.ts)) ancora em qtd=2, preço=100, desconto=10 — o caso em que percentual dá 180 e absoluto dá 190 — e o contrato de mutação ([`scripts/mutcheck.d/desconto-omie.mut`](../../scripts/mutcheck.d/desconto-omie.mut)) mede o poder dela: **15 mutações, 14 pegas, 1 sobrevivente declarada, controle+ ✓**.

A falsificação achou dois defeitos que os 10 testes verdes escondiam:

1. **O instrumento estava cego.** O `eq` copiado do teste vizinho compara por `JSON.stringify`, que serializa `Infinity`, `-Infinity` e `NaN` todos como a string `"null"`. A mutação "quantidade zero passa a dividir" sobreviveu porque o helper devolvia `-Infinity` e o assert que exigia `null` **passava**. Um comparador cego exatamente no eixo que a suíte existe para vigiar — o mesmo formato de [gates-textuais-cegos.md](gates-textuais-cegos.md), agora no assert em vez do stripper.
2. **Uma camada era redundante.** O guard de `percentual > 100` não é alcançável como invariante independente: qualquer percentual acima de 100 produz desconto maior que a base, e o guard seguinte já rejeita. Registrada como `SOBREVIVE` com a razão, em vez de fingir cobertura.

Vale a regra do CLAUDE.md: sabotar **uma camada por vez** — a que fica verde é redundante ou inalcançada. Aqui foram as duas coisas, em camadas diferentes.

## O que ficou aberto de propósito

- **I3 (validar VALOR na invariante do agregado)** segue bloqueado, e agora por um motivo melhor: não é a ambiguidade entre duas fórmulas, é que a base de cálculo não é confiável enquanto a ingestão descartar o desconto. Fixar I3 sobre totais derivados de desconto sempre-zero carimbaria o erro como invariante.
- **A conferência contra `valor_total` do item** foi considerada e **não** implementada. A doc marca o campo "Preenchimento Opcional" e não publica a identidade dos componentes; na doc de remessas o "Valor Total do Item" incorpora IPI e substituição tributária. Usar como veto derrubaria item legítimo por diferença tributária. Se for usada, que seja como diagnóstico com estados separados (confere / diverge / indisponível), e a candidata melhor é `total_pedido.valor_descontos`, que o Omie calcula.
