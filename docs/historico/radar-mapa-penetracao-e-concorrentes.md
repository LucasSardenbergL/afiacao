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
MG, 7 em SC), e nenhum CNPJ de SC dessa fonte está no radar. Os clientes da Colacor SC não entram no
`ja_cliente`. Por isso a legenda do mapa avisa que, fora de MG, 0% pode ser cadastro ausente, não
mercado virgem. Ampliar a fonte do `ja_cliente` para o Omie da Colacor é trabalho de outra entrega
(mexe em `radar_recruzar_ja_cliente`).

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
| Migration `20261029170140` | sessão (envelope: idempotente + transacional + PÓS) | **depois** da migration da frente 2 que cria `private.cap_radar_prospectar`; a PRE aborta sem ela |
| Edge `radar-ingest` v1.4 | founder, chat do Lovable | `bun run pendencias:deploy` decide; sonda depois |
| 1ª carga de concorrentes | automática na carga mensal do lote 2026-11 (sonda de segunda-feira) | ou antes, à mão: `bun scripts/radar/carga.ts --mes 2026-10 --so-concorrentes` com `RADAR_INGEST_URL`/`RADAR_CRON_SECRET` (~2 h, só os 10 zips de Estabelecimentos) |
| Publish do Lovable | founder | mapa e ranking novos |
