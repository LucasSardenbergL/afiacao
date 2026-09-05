# Deriva de corpo: o vivo estava À FRENTE — e a migration parada era a bomba

> **A classe (2026-08-30):** num banco operado por paste no SQL Editor, "o corpo em prod não bate
> com nenhuma migration" **não** quer dizer que prod está errado. Das 24 derivas triadas, o corpo
> vivo era o **mais novo em todas as 8** que divergiam de fato — e em 5 delas o que só existia vivo
> era **hardening de autorização**. O perigo inverte de lado: quem ameaça o money-path não é o
> banco, é a **migration mergeada e nunca aplicada**, porque aplicá-la DESFAZ o hardening vivo.
>
> A regra: **antes de "regularizar" uma deriva aplicando a migration do repo, compare a direção.**
> `CREATE OR REPLACE` a partir de um repo mais velho é uma regressão silenciosa de authz — e o CI
> não vê, porque o repo está internamente consistente. E **antes de tratar deriva como dívida,
> separe comentário de código**: 16 dos 24 alarmes (67%) eram comentário, formatação ou texto de
> mensagem, com o código byte-idêntico.

Origem: a Seção 3 de `scripts/audit-custom-migrations.ts` (#2105) passou a comparar o md5 do CORPO
de cada função redefinida por mais de uma migration contra o corpo vivo. Acusou deriva em massa e
ninguém tinha triado. Esta é a triagem.

## O número: 24, não 27

A medição de 2026-08-29 dizia 27. Hoje são **24 DERIVA · 69 em dia · 4 ausentes**. A diferença não é
drift: as 3 que saíram (`_data_health_compute`, `data_health_watchdog`, `fin_sync_heartbeat`) foram
**regularizadas** pela migration `20260829041500_analytics_outbox_trigger_sensor.sql`, mergeada
depois da medição, que capturou o corpo vivo. Provado por md5 — no SQL commitado em #2105 o esperado
era `e353fa76…`/`5ca754da…`/`7b8fa80e…` contra vivos `538f5373…`/`2113e2ac…`/`4665b298…`; hoje batem.
**27 = 24 + essas 3.** Regularizar deriva capturando o corpo vivo é o fluxo que já funciona.

## Método (dois eixos que não se confundem)

O md5 do audit colapsa whitespace, então **nenhuma** deriva é diferença de espaço — todas são
conteúdo. Para separar conteúdo *significativo* de ruído, dois eixos independentes:

1. **Comentário** — remover com o stripper COMPARTILHADO (`removerComentariosSql`), nunca regex
   local. Se o resto empata, a deriva é comentário.
2. **Esqueleto × literais** — extrair os literais `'...'` (com `''` escapado) para uma lista, e só
   então normalizar espaço em torno de operadores no que sobra. Normalizar **dentro** da string
   mascararia mudança de mensagem e de predicado textual; comparar sem extrair confundiria
   `escopo = 'sku'` com `escopo='sku'`.

Para a **direção** (vivo mais novo ou mais velho), o teste barato e objetivo é datar o símbolo que
só um dos lados usa: se o corpo vivo referencia algo criado DEPOIS da última migration que o define,
o vivo é mais novo. Não precisa de opinião.

| Veredito | N | Exemplos |
| --- | --- | --- |
| Só comentário (código idêntico) | 13 | `aprovar_versao_boletim`, `fin_calcular_confiabilidade` |
| Formatação pura | 2 | `resolve_markup_policy`, `get_ultimos_precos_cliente` |
| Só literal de texto | 1 | `detectar_skus_sem_grupo` |
| **Estrutura difere** | **8** | abaixo |

As 13 de comentário têm **todas** delta negativo (−27 a −1654 bytes): o apply descarta comentário.
É assinatura sistemática de ferramenta, não de edição de lógica.

## O achado: 6 das 8 são money-path/autorização, e o repo é o lado frouxo

- **`get_tint_price`, `get_tint_prices`, `get_preco_cockpit`** — o vivo usa `private.cap_custo_ler`
  (master, ou employee **com** `commercial_role IN ('estrategico','super_admin')`). O repo tem
  `employee OR master` — **qualquer employee** — e no cockpit `pode_ver_carteira_completa`, que ainda
  inclui `gerencial`. É o gate que decide se `cmc` e `markup_perc` saem como número ou `null`. O
  hardening FU4F (`cap_custo_ler` nasceu em 2026-07-18) foi colado em prod e nunca virou migration
  para estas três, cujas últimas migrations são de 04 e 08/07.
- **`farmer_recomendacoes_substituir` e `farmer_bundle_recomendacoes_substituir`** — só o vivo tem o
  guard que conta linhas com `farmer_id IS DISTINCT FROM p_farmer_id` e faz `RAISE EXCEPTION`, mais
  um `FOR SHARE`. **`FOR SHARE` não aparece em nenhuma migration do repo.** Sem ele, um farmer grava
  recomendação para cliente de outro.
- **`aplicar_promocoes_no_ciclo`** — o caso que dá nome à lição, abaixo.

Os outros dois (`reposicao_pos_candidatos`, `register_carteira_member`) são vivo-mais-novo benigno:
usam `omie_po_inexistente_antes_de` e `evidence_document_normalized`, colunas criadas depois.

## `aplicar_promocoes_no_ciclo`: a última a recriar venceu — no REPO

Três migrations do MESMO dia (2026-06-06) redefinem a função. A das **18h** era o hardening
(`ajustado_humano`, join com `promocao_campanha` + janela de datas, `::text`). A das **20h**
(`promo_forward_buying_min`) redefiniu a função **sem nada disso** — a armadilha do
`CREATE OR REPLACE` documentada em `../agent/database.md`, só que dentro do repo.

Prod ficou na linhagem das 18h e evoluiu; o repo ficou com a versão regressiva. Medido por marcador:
`ajustado_humano` vivo=2 · repo(20h)=0 · hardening(18h)=3; `ceil(` vivo=0 · repo=2.
**Aplicar a migration do repo hoje regride produção** e ainda troca `::text` por `::bigint` num join
de código de produto.

## O que NÃO era achado (e por que a medição importa)

A migration das 20h declarava fechar três defeitos. Dois deles prod já resolve por outro caminho: o
`GREATEST(av.qtde_com_desconto, pci.qtde_final)` vivo nunca reduz abaixo da qtde gerada, e
`minimo_forcado_manual` está vivo em `gerar_pedidos_sugeridos_ciclo`. Sobrou o `ceil` ausente —
qtde fracionária. **O efeito medido é zero:** de 2.433 itens em `pedido_compra_item`, 85 têm
`qtde_final` fracionária e **todos os 85 são itens SEM promoção**; os 27 com promoção têm zero.

Precisão > recall funcionou: o alarme "prod ignora o mínimo forçado e grava qtde fracionária" era
plausível, bem-formado, e **falso**. Um cruzamento de uma query o desmentiu. Tinta se vende em
volume — fração não é defeito por si só.

## Os falsos-positivos do detector (16 + 4)

- **67% de ruído.** Um eixo secundário comparando o md5 do corpo **sem comentários** separaria
  deriva-de-comentário de deriva-de-código e deixaria 8 alarmes acionáveis em vez de 24. Alarme
  falso em massa é como uma seção nova nasce desligada — a mesma lição que a Seção 3 já aprendeu
  quando o stripper errado produziu 52 derivas em vez de 24.
- **Os 4 "ausente em prod" são todos falsos.** `carteira_visivel_para` existe, em `private` — a
  Seção 3 só procura em `public`; `estimar_impacto_exclusao_outlier` já está na lista `OBSOLETE` do
  próprio audit, que a Seção 3 não consulta; `calcular_gatilhos_reposicao` e `import_tint_formulas`
  foram dropadas por migration e faltam nessa lista. Mesma família do
  [audit-migrations-falso-vermelho.md](audit-migrations-falso-vermelho.md): o vermelho é do
  extrator, não do banco.

## Pendências (nenhuma tocada aqui — a triagem foi só leitura via `psql-ro`)

1. Migration de **captura** do corpo vivo das 5 de authz — é o único jeito de o repo parar de ser
   uma bomba de regressão. Money-path: pede `prove-sql-money-path`.
2. ~~Decidir o destino de `20260606200000_reposicao_promo_forward_buying_min.sql`~~ — **RESOLVIDA
   em 2026-08-30**: APOSENTADA, não aplicar. A captura `20260830214547` devolve a precedência ao
   corpo hardened e aborta se a das 20h tiver sido colada. Três das quatro afirmações desta triagem
   foram corrigidas na re-medição (o vivo NÃO evoluiu além das 18h; o risco do `::bigint` não
   reproduz; o `ceil` é redundante nos dois insumos) —
   [captura-de-corpo-vivo-como-aposentar-migration.md](captura-de-corpo-vivo-como-aposentar-migration.md).
3. Corrigir a Seção 3: eixo sem-comentários, schema `private`, e consultar `OBSOLETE`.
