# Meu dia do CEO — Leva 2: decisões do founder (2026-11-20)

Continuação da Leva 1 (#4025, #4026). Números medidos em prod por `psql-ro` no dia; decisões do founder na
sessão. Listas nominais de clientes ficaram fora do repo (entregues ao founder em arquivo).

## O que os números mostraram (e o que corrigiram no briefing)

- **Pool "órfão" do master:** 12.717 carteiras elegíveis (`source = hunter_orphan`), mas só **56 clientes
  compraram em 12 meses** (R$ 655k, ~84% num único cliente que o próprio master atende). O "12 de 2.399" do
  briefing não se reproduziu. 54 dos 56 **não têm vendedor no cadastro do Omie** (`omie_codigo_vendedor`
  NULL): é por isso que caem no master. A vendedora principal lançou o último pedido de 47 deles.
- **A carteira vem do Omie e é reconstruída toda noite** (`carteira-rebuild`, cron 07:30): vendedor do
  cliente no Omie × `omie_vendedor_map`. Escrever direto em `carteira_assignments` seria revertido no dia
  seguinte. As alavancas reais são o **mapa de vendedores** (app) e o **vendedor do cliente** (Omie).
- **A 2ª vendedora saiu da empresa.** Em 90 dias ela lançou 2 pedidos; a vendedora principal lançou 451
  (R$ 404k) para a carteira dela.
- **Sem nota >180d (Colacor, 180–365d):** 321 pedidos, R$ 110k, **reconciliados com o Omie em 12/10**: o
  status é do Omie, não artefato. 179 abaixo de R$ 200; em 202 o cliente faturou outro pedido depois; um
  cliente concentra 25 pedidos (R$ 39k). Já a **Oben tem 676 pedidos de 180–365d nunca reconciliados**: o
  status deles é o da 1ª importação e não vale como verdade.
- **Esfriando:** 216 clientes (comprou em 12m, última compra >90d), R$ 641k/ano histórico; ~R$ 314k disso é
  um único cliente com 475 pedidos/ano (provável código de balcão — o founder confere).

## Decisões e o que foi feito

| Tema | Decisão | Feito |
|---|---|---|
| Carteira da vendedora que saiu | passar para a vendedora principal; remapear no app **e** abrir sessão para a escrita no Omie | 6 códigos de vendedor dela em `omie_vendedor_map` apontados para a vendedora principal (envelope MCP: ensaio `ENSAIO_OK` + 2ª testemunha psql-ro). O rebuild das 07:30 move os 1.272 clientes. |
| Papel comercial dela | tirar | 1 linha de `commercial_roles` removida (mesmo envelope). Login, profile e histórico intactos. |
| 54 órfãos ativos | o founder marca quem fica com quem | planilha de marcar num artifact privado. A aplicação depende do vendedor no Omie (sessão da escrita no Omie, ou o time à mão). |
| Meta do placar | meta por **potencial da vendedora** (produtividade de ligações, ticket, cross/up-sell) | fora desta sessão: vira sessão própria. |
| Sem nota >180d | lista para conferir no Omie | lista entregue ao founder. O app não escreve no Omie. |
| Esfriando | juntar ao Combinado do dia, sem duplicar a recompra | 3ª fonte do combinado (rodízio cobrança → recompra → esfriando) + migration `20261120210000` (a RPC do ledger aceita o tipo `esfriando`). |

A reversão da escrita (ids das 6 linhas do mapa e a linha de `commercial_roles`, com os valores originais)
está no corpo do PR desta entrega.

## Lição

**Dono de carteira é DERIVADO do Omie.** Antes de "redistribuir carteira", ache o escritor: aqui é o
`carteira-rebuild` noturno, e a mudança durável é no mapa de vendedores ou no cadastro do Omie, nunca em
`carteira_assignments`.

## Sensores (rodar daqui a ~2 semanas)

```sql
-- a carteira migrou?
SELECT ca.owner_user_id, count(*) FROM carteira_assignments ca WHERE ca.eligible GROUP BY 1;
-- o combinado está sendo usado, e com esfriando?
SELECT dia, vendedora_id, n_copias,
       (SELECT count(*) FROM jsonb_array_elements(itens) i WHERE i->>'tipo' = 'esfriando') AS esf
  FROM combinado_dia ORDER BY dia DESC;
```
