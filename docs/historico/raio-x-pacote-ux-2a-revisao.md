# Raio-X: pacote de UX + 5 bugs da 2ª revisão (Codex + Fable, 2026-11-03)

Prod em 03/11: 1 visita e 0 decisões no app desde a fase B. A meta é 25/11: 100% do Top 61 congelado decidido e
≥ R$ 60 mil liberados. A revisão concluiu que o problema era o FLUXO: 3–4 toques e 2 rolagens por item, liquidar em 2
passagens, nenhum "próximo item" e a aba escondida. Critério desta entrega: **menos toques até uma decisão real**, sem
afrouxar nenhuma regra de dinheiro.

## Toques até 1 decisão (medido no harness mobile 375×812)

| Caminho | Antes | Agora |
|---|---|---|
| Card com sugestão confirmável | Decidir → (rolar) destino → Salvar → reabrir → execução → Salvar = 5+ | **1** ("Confirmar: Trocar") |
| Fila do Top 61 | — (não existia) | 1 para abrir + **1 por item** (Confirmar → abre o próximo) |
| Liquidar com piso/canal | 2 passagens (decisão, depois execução) | 1 painel, 1 salvar |

## Bugs

1. **Travamento entre os dois formulários** — sumiu com o formulário único (UX 5): um botão grava `raio_x_decidir` e,
   em sequência, `raio_x_planejar` com a versão que a decisão devolveu. Sucesso parcial (decisão gravou, plano não) diz
   isso em aviso próprio e conta como decidido.
2. **Coorte zerada sem linha** — `linhasForaDoEstoque` (src/lib/reposicao/raio-x/fila.ts) sintetiza a linha histórica
   (saldo 0, valor de hoje null, `valor_coorte` = foto da coorte) para decidir. O SKU nunca sai da coorte; o placar não
   muda (continua lendo os fatos + a coorte).
3. **Unidades** — migration `20261103120000_raio_x_unidades.sql`: margem do plano só com unidade de venda única no
   histórico = a do estoque; desconto só com uma unidade em 12m; `raio_x_medicao` devolve unidade do estoque + unidades
   das NFs desde a foto, e o médio 12m só com unidade única = estoque. TS: `unidadeEquivalente` manda para "sem medição"
   o SKU vendido em outra unidade. Prod (coorte Oben, 61): 43 com unidade comprovada, **18 nunca vendidos ficam sem
   margem** (nada prova a unidade do piso), 0 divergentes.
4. **Alerta de piso** — o texto diz "preço médio desde a foto abaixo do piso atual" (o piso não é versionado).
5. **Sugestão que o servidor recusa** — `alinharSugestaoAoServidor`: liquidar sem `inequivoco === true` vira "revisar"
   com o motivo; o "Confirmar" também recusa liquidar sem o veredito (2ª camada). O bloqueio segue no servidor (RX004).

## Codex (código, gpt-6-astra high, 121 s): 2 P1 + 1 P2, todos corrigidos neste PR

- P1: o plano ia com a versão devolvida pelo `decidir` (que não checa versão) e podia sobrescrever, sem RX003, o plano
  de outro operador → o salvar combinado relê `atualizado_em` antes e recusa se mudou.
- P1: troca por **encalhe** com crédito: plano falhando depois do crédito gravado contava o crédito como liberado →
  o crédito vai DEPOIS da contrapartida (falha subconta, o lado seguro).
- P2: o médio 12m da medição misturava unidades (classificava "liquidado" e margem sacrificada errados) → NULL sem
  unidade única = estoque.

## Sensor

`reposicao.raio_x_decisao` no ledger (migration `20261103120100`), chave `empresa:sku:origem` (card · sheet · fila),
1 linha por SKU × origem × dia. "Quando medir" (query, depois do Publish):

```sql
SELECT props->>'origem' AS origem, count(*) FROM analytics_outbox
 WHERE evento = 'reposicao.raio_x_decisao' AND ocorrido_em >= '2026-11-04' GROUP BY 1;
```

## Lições

- **Verificar UX sem login de teste:** harness Vite no scratchpad com plugin `resolveId` que troca só Supabase/Auth/
  leitura por fakes e renderiza o componente REAL — pegou o "Pular" colado no X do Sheet e o botão de destino estourando.
- Um salvar que encadeia duas RPCs herda a concorrência da MAIS FRACA: se a 1ª não checa versão, a 2ª não pode usar a
  versão que a 1ª devolve como prova de que nada mudou.
