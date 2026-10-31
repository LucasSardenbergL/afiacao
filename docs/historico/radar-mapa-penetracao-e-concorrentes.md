# Radar, frente 4: penetração por município e camada de concorrentes no mapa (2026-10-29)

**Contexto.** O Radar está em prod e sem uso ([radar-uso-e-recorte-cnae-2026-10-28.md](radar-uso-e-recorte-cnae-2026-10-28.md)).
O founder decidiu implementar as ideias do brainstorm em 5 frentes paralelas. Esta é a 4ª (mapa):
mostrar onde o mercado é grande e a penetração é baixa, e acrescentar uma camada de concorrentes
(revendas de tinta e verniz) que **não** entra na fila de leads. O recorte de CNAE dos leads não mudou.

## O que entrou

| Peça | Arquivo |
| --- | --- |
| Tabelas `radar_concorrentes_lote` + `radar_concorrentes_municipio` (RLS gateada), RPC de leitura `radar_penetracao_por_municipio`, porta de escrita `radar_concorrentes_publicar` (só `service_role`) | `supabase/migrations/20261029170140_radar_penetracao_e_concorrentes.sql` |
| Ação `publicar_concorrentes` na edge (v1.4) | `supabase/functions/radar-ingest/index.ts` |
| Recorte de concorrentes no mesmo scan da carga + modo `--so-concorrentes` | `scripts/radar/carga.ts`, `scripts/radar/concorrentes.ts` |
| Hook `useRadarPenetracaoMunicipios` + helpers (média ponderada, faixa, oportunidades) | `src/queries/useRadarContagemMunicipios.ts` |
| Mapa com camada Leads/Penetração e liga/desliga de concorrentes | `src/components/radar/RadarMapa.tsx` |
| Ranking: penetração por cidade + "Mercado grande, pouca penetração" | `src/components/radar/RadarRankingCidades.tsx` |

## Decisões

- **RPC nova, não coluna nova na `radar_contagem_por_municipio`.** Acrescentar coluna ao `RETURNS TABLE`
  exige DROP + CREATE (reseta o ACL) e colidiria com a frente 2, que recria essa função para trocar o
  gate. Uma função nova e aditiva não recria objeto vivo. A frente 2 continua dona da contagem.
- **Denominador = empresas do lote vigente no município, todas as situações de prospecção.** Inclui
  `ja_cliente` e `descartado`: é o mercado ativo do CNAE-alvo segundo o dump, não a fila. Numerador =
  `ja_cliente`. Sem denominador (município só com concorrente) → `penetracao` NULL. Sem lote → a RPC
  grita `lote inválido` e o hook nem chama (camada indisponível).
- **Concorrentes ausentes ≠ zero.** `concorrentes` sai NULL em todos os municípios enquanto o lote não
  tiver linha em `radar_concorrentes_lote`. Com a publicação, município sem revenda vira 0.
- **CNAEs corrigidos contra o `Cnaes.zip` da RFB (dump 2026-10).** O briefing citava 4679-6/99 e
  4744-0/05, que no catálogo são "atacadista de materiais de construção em geral" e "varejista de
  materiais de construção não especificados". Os de tinta e verniz são **4679-6/01** (atacadista de
  tintas, vernizes e similares) e **4741-5/00** (varejista de tintas e materiais para pintura).
- **Agregado por (lote, município, CNAE), não por estabelecimento.** O mapa só precisa da contagem.
  Assim a camada fica sem dado cadastral de terceiros e sem 100 mil linhas a mais.
- **Publicação atômica e reconciliada.** `radar_concorrentes_publicar` substitui o lote inteiro numa
  transação, confere soma das linhas = total contado e recusa total 0 (recorte vazio é defeito da carga,
  não "nenhuma revenda no país").
- **A camada não derruba a fila.** O `catch` geral da edge marca o lote de leads como `error`. Por isso
  a ação nova trata o próprio erro, e a carga publica **depois** do `finalize`. Se falhar, a carga termina
  com `exitCode 6` (job vermelho + e-mail do GitHub) e o lote de leads continua `complete`.
- **Sensor.** Abrir `/radar` já é medido no ledger (`navegacao.rota_servida`). Ligar/desligar camada é
  interação de UI e vai no `track()` (`radar.mapa_camada`, `radar.mapa_concorrentes`). Um evento novo no
  ledger exigiria mexer na allowlist de `analytics_ledger_registrar`, fora desta frente.

## Achado: a fonte de `ja_cliente` quase só cobre MG

Medido em prod (psql-ro, 2026-10-29), lote 2026-10: 503.929 empresas em 5.442 municípios, **2.686
clientes (0,53%)**, e 5.307 municípios sem nenhum cliente. **2.676 dos 2.686 clientes estão em MG**
(Divinópolis 265, Passos 229, Carmo do Cajuru 214…). São Paulo tem 1 cliente em 25.082 empresas.
Joinville tem 0 em 3.100.

A causa é a fonte, não o mercado: `omie_clientes_nao_vinculados` só tem `empresa = 'oben'` (10.124 em
MG, 7 em SC), e nenhum CNPJ de SC dessa fonte está no radar. Por isso a legenda do mapa avisa que, fora
de MG, 0% pode ser cadastro ausente, não mercado virgem.

### Correção (2026-10-31): a Colacor SC já entrava; o buraco é o cliente Colacor sem usuário

A hipótese "os clientes da Colacor SC não entram no `ja_cliente`" estava errada. Medido em prod
(psql-ro, 2026-10-31):

- `radar_recruzar_ja_cliente` (e `radar_docs_clientes`) leem `profiles.document` ∪
  `omie_clientes_nao_vinculados.cnpj_cpf`, **sem filtro de empresa**. Os vinculados, de qualquer conta,
  já entram por `profiles`: dos 5.296 documentos do mapa `colacor_sc` (`omie_customer_account_map`),
  **0** ficam fora dessa fonte.
- "Colacor SC" é o CNPJ catarinense do grupo (veículo fiscal), não uma carteira em Santa Catarina. UF do
  endereço dos clientes mapeados em `colacor_sc`: MG 4.975 · SP 202 · RS 35 · PR 26 · SC 24 · ES 9. A
  Oben dá MG 5.286 · SC 26. Os 24 clientes `colacor_sc` com endereço em SC têm 24 CNPJs e **nenhum**
  está em `radar_empresas`: estão fora do CNAE-alvo.
- Cruzando com o radar cada fonte candidata (mapa das 3 contas, `customer_canonical_alias`,
  `cliente_grupo_membros`, `omie_cliente_confirmacoes`, `profiles`, não-vinculados): **0 empresas
  novas** em qualquer UF. Mudar a função SQL não mudaria nada.

O que nunca era lido: o cliente do Omie da Colacor (contas `servicos` e `colacor_vendas`) **sem usuário
nenhum**. O `start_nao_vinculados` da `omie-analytics-sync` recusava toda conta fora de `vendas`
("v1: só Oben"). A entrega:

- edge v1.15-nao-vinculados-tres-contas: `start_nao_vinculados` aceita as 3 contas. O `linked` já era
  escopado à conta do run (proof fresca por conta), que é a pré-condição para abrir;
- `supabase/migrations/20261031141053_nao_vinculados_cron_colacor.sql`: jobs diários para `servicos`
  (08:40Z) e `colacor_vendas` (08:50Z), depois do da Oben (08:30Z). O recruzamento diário do radar
  (06:15Z) pega as linhas no dia seguinte;
- a tela `/clientes-nao-vinculados` continua lendo só `empresa='oben'`: as linhas novas servem ao
  radar, não à tela.

Expectativa honesta: a carteira conhecida da Colacor tem o perfil da Oben (MG), então o mais provável é
o `ja_cliente` crescer em MG, não aparecer em SC.

#### Medido (2026-10-31, psql-ro): +8 em MG, SC segue 0

Ordem em prod: edge v1.15 atestada pela sonda às 18:19Z (fonte `409a1b64e69f` = main) → migration
de cron pelo `db:aplicar` (recibo #795, 3 jobs validados por fora) → primeiro snapshot fora do cron
(`db/2026-10-31-nao-vinculados-colacor-primeiro-snapshot.sql`, recibo #797, as duas respostas 202) →
recruzamento (`db/2026-10-31-radar-recruzar-ja-cliente-colacor.sql`, recibo #800, função com o md5
de sempre). O disparo e o recruzamento manuais existem porque o recruzamento diário (06:15Z) roda
antes do snapshot Colacor (08:40Z e 08:50Z): pelo calendário, o primeiro efeito só sairia em 02/11.

| | antes (16:15Z) | depois (18:5xZ) |
|---|---|---|
| `ja_cliente` MG | 3.003 | **3.011** |
| `ja_cliente` SP | 3 | 3 |
| `ja_cliente` ES, MT, PA, PE, PR, RJ, RS | 1 cada | 1 cada |
| `ja_cliente` SC | 0 | **0** |

- Snapshots: `colacor_sc` tem 55 clientes sem usuário e `colacor` tem 272 (327 linhas, 217 CNPJs).
  A Oben tem 10.168.
- UF desses clientes: colacor = MG 194 · SP 47 · PR 16 · **SC 9** · RJ 2 · ES 2 · BA 1 · RS 1;
  colacor_sc = MG 50 · SP 2 · PA 1 · PR 1 · sem UF 1.
- No radar, 30 desses CNPJs casam (colacor 23, colacor_sc 7), **todos em MG**. Só 8 eram novos; o
  resto já estava marcado por profiles ou pelo snapshot da Oben.
- Os 9 clientes Colacor de SC não estão no `radar_empresas`, assim como os 24 com usuário medidos
  antes: o radar de SC é recortado pelo CNAE-alvo, e esses clientes ficam fora dele.

Conclusão: a fonte do `ja_cliente` agora cobre as 3 contas, e o 0% de SC é **real**, não um buraco
de fonte. Nenhum cliente conhecido do grupo em SC está no universo do radar de SC.

#### Por que SC fica fora: não há cliente comprador lá (psql-ro, 2026-10-31)

Conjunto: CNPJs (14 caracteres) de `profiles` com endereço em SC ∪ não-vinculados das 3 contas com
`uf='SC'`. São **38**. O universo do radar é `situação ativa E CNAE-alvo` (`scripts/radar/carga.ts`),
e `radar_situacao_cadastral` guarda a situação RFB dos CNPJs conhecidos. Então dá para separar as
causas sem ter o CNAE na base:

| situação RFB (lote 2026-10) | no radar | CNPJs | leitura |
|---|---|---|---|
| 02 ativa | não | 30 | fora **pelo CNAE** |
| sem registro | não | 7 | não-vinculados Colacor que entraram hoje, depois da carga |
| 08 baixada | não | 1 | fora pela situação |

Quem são os 38: transportadoras (Expresso Leomar, Aceville, Transville, Alfa, Pauta, Azurelog…),
fornecedores (Kanefusa Serras, HD Ferragens, Tecnofast, Mastercol) e prestadores (software, finanças,
armazém). **Nenhum tem pedido** em `sales_orders`. O cadastro de "clientes" do Omie também guarda
fornecedor e transportadora; o grupo não tem cliente comprador em SC.

**Decisão: o recorte de CNAE não muda.** Ampliar o CNAE não acharia cliente em SC, porque não há
cliente lá para achar, e a medição de 28/10
([radar-uso-e-recorte-cnae-2026-10-28.md](radar-uso-e-recorte-cnae-2026-10-28.md)) já dizia que ampliar
só aumentaria uma fila sem dono. O 0% de SC no mapa é o dado certo: mercado sem nenhuma penetração.

**Precisão das 8 marcações novas.** Como o snapshot de não-vinculados inclui fornecedor e
transportadora, um fornecedor dentro do CNAE-alvo poderia virar `ja_cliente` e sair da fila por
engano. Conferi as 8: duas vidraçarias, uma fábrica de esquadrias, uma de usinagem e quatro MEIs de
móveis ou artefatos de madeira, todas em MG e cadastradas pela Colacor. Nenhuma é fornecedor ou
transportadora. O "0 pedidos" delas é esperado: `colacor_sc` é a conta de serviços (afiação), que não
passa por `sales_orders`. O risco existe (é o mesmo do snapshot da Oben desde a v1), mas não apareceu
nesta leva.

## Custo

O agregado do lote é seq scan em `radar_empresas` (~573 mil linhas), como a contagem com `p_lote`:
3,4 s de execução com cache frio (76 mil buffers lidos do disco) e abaixo disso quente. Fica sob o
corte de 8 s do PostgREST, mas com pouca folga a frio. Se doer, a saída é um covering
`(ultimo_lote, municipio_codigo) INCLUDE (uf, ja_cliente)` com `CREATE INDEX CONCURRENTLY`.

## Provas

- `db/test-radar-penetracao-concorrentes.sh` (PG17, no núcleo do CI): 26 asserts chamando as RPCs como
  `authenticated` com o GUC do JWT. Cobrem penetração com denominador, lote velho fora, `p_uf`/`p_limit`,
  concorrentes NULL→0, lote inválido e gate com SQLSTATE casada, RLS sob `SET ROLE authenticated`
  (gestor lê, sem gate 0 linhas, anon 42501, INSERT 42501), reconciliação/total 0/CNAE fora, re-publicação
  sem duplicar, falha sem tocar a publicação anterior, ACL e PRE (gate ausente aborta tudo; corpo
  divergente aborta e fica intacto). O banco de teste tem os default privileges do Supabase, para que um
  REVOKE esquecido falhe aqui. `--falsificar`: controle verde e **19/19** sabotagens vermelhas. A primeira
  rodada pegou 2 lacunas da própria prova: o `cegar_md5` não cegava a 2ª função, e sem default privileges
  a sabotagem de ACL era inerte.
- `scripts/radar/concorrentes.test.ts` (4) e `scripts/radar/radar-ingest-concorrentes.test.ts` (4,
  fiação e ordem: publica depois do `finalize`, erro isolado do `radar_ingest_state`).
- `src/queries/__tests__/useRadarContagemMunicipios.lote-vigente.test.tsx`: hook (lote vigente, UF, sem
  lote → null sem chamar a RPC, erro do lote propaga) e helpers (média ponderada só com denominador,
  faixas, oportunidades, `—` para null).

## Camadas de deploy

| Camada | Quem | Observação |
| --- | --- | --- |
| Migration `20261029170140` ✅ aplicada 2026-10-30 | sessão (envelope: idempotente + transacional + PÓS) | **depois** da migration da frente 2 que cria `private.cap_radar_prospectar`; a PRE aborta sem ela |
| Edge `radar-ingest` v1.4 ✅ 2026-10-30 | sessão, mensagem ao agente do Lovable | sonda DEPLOY CONFIRMADO; `pendencias:deploy` em "confere" |
| 1ª carga de concorrentes ✅ 2026-10-31 (lote 2026-10) | sessão, `workflow_dispatch` com `so_concorrentes=true` (#3425) | daqui em diante entra sozinha na carga mensal |
| Publish do Lovable | founder | mapa e ranking novos |

## Aplicação em prod (2026-10-30)

O PR #3414 foi mergeado antes da migration, a pedido do founder. A migration entrou depois de a
frente 2 aplicar `private.cap_radar_prospectar(uuid)` (`20261029201200`, #3417; assinatura conferida
por psql-ro: `(uuid) RETURNS boolean`, SECURITY DEFINER, anon sem EXECUTE).

- **Canal:** MCP do Lovable (`query_database`, role `postgres`). O arquivo tem envelope `BEGIN;`/`COMMIT;`,
  e o `db:aplicar` recusa isso por desenho, então não há recibo em `db_aplicacoes`.
- **Ensaio:** o mesmo SQL com `RAISE 'ENSAIO_OK'` no lugar do `COMMIT`. Chegou ao marcador depois da
  PÓS (P1 a P8, incluindo o md5 dos dois corpos), e um psql-ro logo em seguida confirmou que nada ficou
  no banco.
- **Apply:** com `COMMIT`.
- **2ª testemunha (psql-ro):**
  - a query de validação do PR deu `frente4_aplicada`;
  - md5 vivo: penetração `f52a86ce…`, publicar `baeb6ff1…` (iguais aos do arquivo);
  - as duas policies chamam `cap_radar_prospectar`;
  - anon não lê e authenticated não escreve;
  - `radar_contagem_por_municipio` da frente 2 continua intacta (md5 `85dbce2b…`).
- **Pré-voo `wt:preflight`:** 🟢, sem colisão de objeto. O resultado chegou depois do apply porque a
  varredura das 182 worktrees demorou; antes disso uma busca à mão pelos nomes dos objetos já tinha
  dado zero colisão.
- **RPC como `authenticated` em prod:** feita depois, quando o canal MCP voltou. MG deu 846 municípios
  e zero divergências contra a contagem direta. Sem a capacidade, a resposta é `forbidden: radar`.

## 1ª carga de concorrentes (2026-10-31)

O Mac não tinha disco para a carga (são mais de 25 GB de trabalho), e `forcar=true` recarregaria
também a fila de leads. Por isso o workflow ganhou o input `so_concorrentes` (#3425): ele usa o mês
pedido sem passar pelo seletor e chama `carga.ts --so-concorrentes`.

- **Run:** [41158645343](https://github.com/LucasSardenbergL/afiacao/actions/runs/41158645343), verde
  em 2h26 (os 10 zips de Estabelecimentos, cerca de 9 min cada depois do primeiro).
- **Publicado:** lote `2026-10`, 21.833 estabelecimentos em 2.435 municípios e 28 UFs, 2.856 linhas
  (município × CNAE). Por CNAE: 4741500 (varejo) 20.386 e 4679601 (atacado) 1.447.
- **Conferência por psql-ro:** o cabeçalho em `radar_concorrentes_lote` bate com a soma e com a
  contagem de municípios de `radar_concorrentes_municipio`. 9 municípios com concorrente não têm
  coordenada em `radar_municipios`, então não aparecem como ponto no mapa.
- **RPC como `authenticated`** (transação com ROLLBACK): em MG, os 846 municípios vêm com
  `concorrentes` não nulo, 336 deles com valor positivo, somando 2.127 (igual à tabela). Nenhum
  município de MG tem só concorrente sem lead. No Brasil, a primeira página de 2.000 tem 1.727
  municípios com concorrente.
