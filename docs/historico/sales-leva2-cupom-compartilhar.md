# Revisão /sales — leva 2: cupom, WhatsApp e preço ausente (2026-11-27)

Achados da revisão Codex r3 + Fable (2026-11-25). Entrega só de front (sem migration, sem edge).

## Re-verificação na main
- **#25** (preço ausente vira 0 no editor): já resolvido por 94d097071 (leva 1). Não tocado.
- **#53**: dinheiro/vencimentos já unificados. O que restava era a LINHA DO ITEM copiada nas duas vias do
  cupom → `linhaItemCupomHtml` única; o total do lote também passou a usar `totalDoCupomHtml`.

## Dados de prod (psql-ro, 2026-11-27)
- 6.556 itens vivos com `tint_nome_cor` e SEM `tint_cor_id` (7 com os dois) → cupom e WhatsApp omitiam a cor.
- 0 item sem preço, 0 quantidade 0, 0 jsonb não-array, `sales_orders.account` só oben/colacor,
  `orders` (afiação) vazia. Os demais achados são preventivos.

## O que mudou
- **#24** `src/lib/cor-tinta.ts` (`textoDaCor`, plataforma): escreve o que se sabe da cor; do nome sai só o
  sufixo ` - BS`. O corte antigo ("tira a última parte se > 2") apagava a cor de ~76 itens
  ("346J - ACRIL BS - PLATINA BIANCA"). WhatsApp: `empresa` obrigatório no cabeçalho (era "Pedido Colacor"
  fixo); Novo Pedido usa cabeçalho neutro (o envio junta empresas e cada número já diz a sua).
- **#26** Cupom: quantidade 0 sai 0 e ausente sai "—" (era `|| 1`), e a linha sem quantidade não multiplica
  por 1. Desconto ausente fica `null`. Conta desconhecida → `null` (era Oben): `printSalesOrder` lança, a
  lista recusa com toast, o painel mostra o motivo. `/sales/print`: só oben/colacor, o resto fica fora da folha
  com aviso (colacor_sc não vira 'afiacao' porque essa chave desliga a leitura do desconto de item).
- **#11** WhatsApp de /sales passa `itensAOrcar` (mesma conta do cupom). Na releitura da OS de afiação, um
  preço de serviço ≤ 0 vira `null` (`precoServicoDaOs`, a mesma régua de `precoServicoParaExibicao` na criação).
- **#27** `itensIlegiveis` (jsonb não-lista): painel "não foi possível ler", Imprimir/Compartilhar travados; a
  folha do dia marca só o pedido (antes um lançamento derrubava o dia inteiro da origem).
- **#29** Condição salva fora da lista mostra o código + "(indisponível para nova escolha)", ou "(lista de
  condições indisponível)" quando a lista falhou ou degradou; a lista vazia não esconde mais a condição.

## Prova
Testes por achado; falsificação com controle verde na mesma invocação, 11 sabotagens, todas vermelhas em
`LC_ALL=C` e `pt_BR.UTF-8`. Codex no desenho (6 P1 aplicados) e no diff (0 P0).

## Deixado de fora (consciente)
- Sync (`omie-vendas-sync`/`_shared/omie-pedido.ts`) converte quantidade 0/ausente em 1 ANTES do cupom
  (Codex). É edge, e o deploy da v1.54 está em curso em outra sessão; 0 casos em prod → leva 3.
- `cnpjsComDesconto` diverge entre as vias (avulso: CNPJs das 3 empresas; lote: 3 CNPJs de cliente). Decisão
  do founder.
- Novo Pedido: o diálogo permite imprimir/compartilhar o carrinho inteiro após envio parcial; o mapa de
  parcelas do `/sales/print` é indexado só pelo código (Colacor pode sobrescrever Oben) → leva 3.
- `/sales/print`: as duas queries ainda não leem o erro antes da folha vazia (baseline do gate
  erro-colapsado 6→4 por mudança de FORMA, não por correção).
