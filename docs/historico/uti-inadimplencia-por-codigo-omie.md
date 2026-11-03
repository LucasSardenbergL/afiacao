# UTI: inadimplência casada por código Omie, não por documento (2026-11-03)

Lote 1 do plano v5 (item UTI, §2.C; contestação do Codex em `anexos/codex-contestacao.md`).

## Problema

`useUtiContas` casava o título vencido com o cliente pelo `cnpj_cpf` do título. O Omie não manda esse campo (`docs/historico/fin-ic-reconcile-contraparte-por-codigo.md`). O hook descartava o título sem documento e, quando o cliente não casava com nenhum, mostrava saldo 0. Resultado: o sinal de inadimplência dava **"ok" (false/0) para todo cliente com CNPJ no profile**, que é um adimplente fabricado.

Medido com psql-ro em 2026-11-03, contando só títulos em aberto:

| empresa | em aberto | sem documento | vencidos 31+ | vencidos 31+ sem documento | saldo vencido 31+ |
|---|---|---|---|---|---|
| colacor | 328 | 328 | 200 | 200 | R$ 101.668,54 |
| colacor_sc | 119 | 119 | 57 | 57 | R$ 17.038,30 |
| oben | 853 | 853 | 319 | 319 | R$ 174.671,63 |

Nenhum título em aberto tinha documento. Todos tinham `omie_codigo_cliente`, e nenhum estava com `ausente_omie_desde`.

## Regra nova

- **Identidade:** o par (empresa, código Omie) leva a um user pelo `omie_customer_account_map`, que tem `UNIQUE (omie_codigo_cliente, account)`. Os 576 vencidos 31+ casaram todos com um único user.
- **Alias fiscal (database.md §5):** com alias `active` em `customer_canonical_alias`, a dívida soma no canônico. Hoje o mapa já aponta o código colacor_sc do alias para o canônico (1.633/1.633). Mesmo assim, o hook dobra o alias de forma defensiva. Alias `conflict` deixa a identidade ambígua, e a dívida fica desconhecida.
- **Linha-clone fora do spine:** 1.459 scores são de users alias (churn 100, nenhuma compra em 180 dias, artefato do B-lite), e 1.458 deles apareciam em "observação". Quando o canônico está no spine, a linha do alias sai.
- **Ausente ≠ zero:** se um título vencido não tem dono unívoco (sem código, sem vínculo, ambíguo, alias em conflito ou saldo nulo), ele vai para `recebiveisSemCliente`. Nesse caso, quem não tem dívida atribuída fica `null` ("sem dado"), porque o título órfão pode ser dele. Quem tem dívida atribuída continua com sinal `true`, e o valor dele passa a ser um **piso**: a tela mostra "≥" e um aviso.
- **Corte:** "31+ dias" agora é `vencimento <= hoje-31`. Antes era `lt`, que exigia 32 dias ou mais.

## Limite conhecido

A leitura de `customer_canonical_alias` passa por RLS (`cap_carteira_ler`). Para um staff sem essa capacidade, a leitura volta vazia sem erro. O alias deixa de ser dobrado, mas a dívida continua indo ao canônico, porque o mapa já aponta para ele.
