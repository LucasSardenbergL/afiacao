# Carteira sem perder clientes na capa: profiles do scoring em lotes (plano v9, C18)

2026-11-11 · plano v9, lote 1 · só front (`useFarmerScoring.ts`) · deploy = **Publish do Lovable (founder)**.

## O defeito

`useFarmerScoring` montava o `profileMap` com UMA request:
`profiles.select('user_id, name, phone').in('user_id', customerIds)`, sem `.range()` e com o
`error` descartado (`const { data: profilesData }`). `customerIds` são os clientes distintos do
universo inteiro de `sales_orders` (`universo-pedidos-query.ts`), e mais abaixo
`if (!profile) return;` tira do score quem não voltou no mapa.

Três rostos do mesmo furo:

1. **Capa silenciosa.** Com mais de 1.000 clientes com profile, o PostgREST devolve 1.000, sem
   erro. O resto sai do score e da agenda.
2. **Erro descartado.** Se a request falhasse (com 1.245 UUIDs a URL tinha ~46 KB; nenhum 414 foi
   observado, o risco é plausível e não medido), o `?? []` virava `profiles = []`, e a carteira
   inteira sumia sem mensagem.
3. **`farmer_calls`** tinha o mesmo `{ data }` sem `error`: falha virava "nenhuma ligação", a taxa
   de contato zerava em silêncio.

## A medida em prod (psql-ro, 11/11/2026)

| | valor |
|---|---|
| clientes distintos no universo (`status` fora da denylist, `deleted_at IS NULL`) | **1.245** |
| com profile | **1.214** |
| sem profile (aliases fiscais `@placeholder.local`, legítimos) | 31 |
| flagged `excluir_da_carteira` dentro do universo | 0 |
| `profiles.user_id` duplicado | 0 |
| `farmer_calls` (linhas) | 0 |

A RLS de `profiles` deixa staff (master/employee) ler todos, então **toda conta staff** mandava o
`.in` de 1.245 e recebia no máximo 1.000. Os **214** cortados eram teto; a interseção com os
elegíveis é:

- **gestor/master** (`capCarteiraLer`, sem recorte de carteira) e 0 flagged no universo:
  **214 clientes de 1.214 (17,6%) fora do score**, todos elegíveis.
- **vendedor** (recorte pela carteira, simulação `LIMIT 1000` na mesma ordem de plano): vendedora A
  91 de 532, vendedora B 76 de 433, carteira do founder 47 de 249. Os 214 cortados caem todos em
  alguma carteira. Quais clientes caem depende da ordem do plano (a request não tinha `.order`),
  então o recorte por vendedor é simulação; o total por conta staff, não.

O hook é só de exibição: nada truncado foi gravado (`farmer_client_scores` é da edge
`calculate-scores`).

## O conserto

- `lerProfilesEmLotes`: lotes de **100** UUIDs (URL medida pelo Codex com o builder e a query
  exata: 100 → 4.040 bytes, 150 → 5.990, 200 → 7.940), cada lote por `fetchAllPages` com `.order('user_id')` + `.range()`. Erro ou `data: null`
  LANÇAM; o `catch` que já existia declara o erro e não publica, então o último resultado bom fica
  na tela. Sequencial de propósito (a aceleração ficou fora, ver abaixo).
- Profile **ausente** não é falha: o lote volta curto e o cliente segue fora do score, como antes.
- `farmer_calls` por `fetchAllKeyset` (cursor por `id`, uuid): mesmo fail-closed, a capa deixa de
  morder quando a tabela crescer, e ligação gravada ou apagada durante a leitura não desloca a página
  seguinte (o offset deslocaria; achado P2 do Codex). Com 0 linhas em prod, nenhum score muda hoje.

## A prova

`src/hooks/__tests__/scoring-profiles-em-lotes.test.tsx`, com stub que reproduz o transporte
(sem `.range()` capa em 1.000; `.in` filtra de verdade) e o cenário da prod (1.245 clientes, 31 sem
profile, espalhados): os 1.214 pontuados; o sem profile fora sem abortar; nenhum `.in` acima de 150
e a soma cobrindo o universo; falha num lote do meio (erro e `data: null`) declara e preserva;
1.200 ligações com a que conta na 2ª página do cursor, e falha nessa 2ª página declara e preserva
(achado P3 do Codex: com uma ligação só, tirar a paginação passava). O golden (`universo-pedidos-golden.ts`, 160 clientes) segue para a equivalência
do cálculo.

Falsificação (controle verde em `LC_ALL=C` e `pt_BR.UTF-8` na mesma invocação, uma camada por vez):
código antigo inteiro → 7 vermelhos de 8; engolir o erro do lote → 2; lote único de 2.000 → 1;
engolir o erro de `farmer_calls` → 2; `farmer_calls` fail-closed mas sem paginar → 3.

## Codex

`scripts/codex-async.sh` (gpt-6-astra, high) no diff: **APROVAR, sem bloqueador.** P2 (offset de
`farmer_calls` sob escrita concorrente) e P3 (teste de ligações sem 2ª página) acolhidos acima.
Limitação registrada, não demonstrada: uma RLS futura que escondesse profile com resposta 200 seria
indistinguível do alias fiscal ausente.

## Fora do escopo, de propósito

A aceleração (`Promise.all` das leituras independentes). `capCarteiraLer` pula a leitura de
`carteira_assignments` para quem vê tudo, e no Mini concorrência sem limite pode piorar a RPC de
margem: só entra com medida por papel (parecer do Codex no v9).
