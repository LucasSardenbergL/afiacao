# sku-items: a "família Sayerlack série 1 de 0 itens" era CT-e — o frete saía da fila só por expirar

> 2026-10-05. Pendência do §7 de [sku-items-consumo-redundante-no-ciclo.md](sku-items-consumo-redundante-no-ciclo.md):
> o diário das 07:00 do `sync_sku_items` OBEN gravava quase nenhum item, com ~19 "NFes" pendentes
> por dia girando no backoff. O motivo novo do #2539 respondeu: **`ok_sem_itensRecebimento`** (a
> chave vem AUSENTE). E a causa estava no tipo do documento: **é CT-e (modelo 57), o conhecimento
> de frete**, e não NF-e de produto. Conserto (parte A): o CT-e sai da fila ANTES de qualquer
> consulta à Omie. Regra que fica: **"0 itens" pede o TIPO do documento antes de qualquer
> hipótese de etapa, parâmetro ou chamada.**

## 1. O que se pensava × o que era

- **Pensava-se:** a Omie respondia "0 itens" para NF-e da Sayerlack série 1. Isso seria uma lacuna
  de COBERTURA no dado do motor, talvez de etapa do recebimento (`cEtapa`/`cRecebido`), talvez de
  outra chamada ou parâmetro.
- **Era:** o módulo `recebimentonfe` da Omie traz NF-e E CT-e na mesma lista (`ListarRecebimentos`
  não filtra por modelo). O `omie-sync-nfes-recebidas` gravava o CT-e sem pedido como linha órfã de
  `purchase_orders_tracking`, igual a uma NF-e. O CT-e documenta o SERVIÇO de transporte e não tem
  item de produto. Os produtos estão na NF-e transportada, que já vira leadtime.
- **Não havia lacuna de cobertura de NF-e.** Havia cota da Omie queimada e uma fila que nunca
  esvaziava.

## 2. A evidência (psql-ro, 2026-10-05 ~17h UTC — 11 dias depois do deploy da v1.2)

| medição | valor |
|---|---|
| marcações no controle desde o deploy da v1.2 (2026-09-24 18h) | 24 `ok_sem_itensRecebimento` · 0 `ok_0_itens` · 9 `ok_com_itens` |
| as 57 `ok_0_itens` restantes | todas anteriores ao deploy (última 2026-09-23 07:00): motivo antigo congelado |
| papel das linhas sem itens | 100% órfãs (`omie_codigo_pedido < 0`), gravadas pelo `omie-sync-nfes-recebidas` |
| modelo do documento (chave pos. 21–22 **e** `cabec.cModeloNFe`) | órfãs 120d: **57 (CT-e) → 59/59 sem `itensRecebimento`** · 55 (NF-e) → 33/33 com |
| outros marcadores das 59 | `infoCadastro.cOperacao = 15` em 100% · chave `cteCfopEntrada` em 47 |
| a etapa discrimina? | **não**: NF-e com `cEtapa=40`/`cRecebido=N` tem itens (24); CT-e com `cEtapa=80`/`cRecebido=S` não tem (42) |
| tracking inteiro (só OBEN) | 55 → 413 linhas, 399 com leadtime · 57 → 135 linhas (102 Sayerlack série 1 desde 2026-01-19), **0** com leadtime |
| cobertura de NF-e | 30d **45/45** · 120d **206/206** com leadtime |
| fila do diário das 07:00 | 17 linhas, **100% modelo 57**; zero NF-e pendente |
| custo nos 11 runs das 07:00 pós-deploy | 55 consultas → 5 itens; ~4 NF-e marcadas ⇒ **~51/55 (≈93%) em CT-e**; 19–44s, 1 timeout (09-27) |
| sync de NFes (84 runs, 7d) | 4,0 consultas/run; ~2,2 CT-e na janela de emissão de 3 dias (estimativa) ⇒ ~55% das chamadas de detalhe dele também em CT-e |
| casamento de frete (sync de CT-e) | 82 casamentos: 69 → NF-e 55 · **11 → a PRÓPRIA linha do CT-e** · 2 → outro CT-e ⇒ 13 fretes (16%) não chegaram à NF-e |
| `nIdReceb` com chaves de modelos diferentes | **0** grupos (o filtro antes do dedup é seguro) |

A doc oficial da Omie (`/api/v1/produtos/recebimentonfe/`) confirma o desenho. `ListarRecebimentos`
filtra só por período, fornecedor e `cEtapa`. O campo `cteCfopEntrada` tem "Preenchimento válido
para recebimentos de CT-e". Nenhuma chamada dá "itens" de um CT-e. O `omie-sync-ctes-recebidos` já
filtrava a mesma lista por `cModeloNFe === "57"` (`index.ts:410`). O `omie-sync-nfes-recebidas` não
filtrava nada.

## 3. O conserto (parte A) — `omie-sync-sku-items` `v1.3-cte-fora-da-fila`

- [`escopo.ts`](../../supabase/functions/omie-sync-sku-items/escopo.ts) — decisão pura:
  `modeloDaChave` (posições 21–22, parser ESTRITO de 44 dígitos ASCII, sem trim nem `Number`),
  `ehCte` e `separarCtes` (preserva a ordem e a identidade das linhas).
- **Denylist, não allowlist.** Sai só o 57 legível. Chave ilegível, ausente ou de modelo
  desconhecido fica na fila (incerteza vira tentativa, nunca exclusão silenciosa). O 67 (CT-e OS)
  fica de fora: não existe na população medida.
- **A posição é contrato.** O fluxo é pendentes brutos → filtro → backoff e ordenação → dedup →
  consulta. Com isso o CT-e não conta em `fila_em_backoff` nem no sensor `fila_parada_48h`, e
  nunca é eleito no dedup no lugar de uma NF-e.
- **Contador `ctes_fora_da_fila`** no `results`. Os pendentes brutos são `fila_pendente` +
  `ctes_fora_da_fila`. O contador conta linhas, não requests economizados.
- **Sem escrita no controle.** As 81 linhas de CT-e em `sku_items_sync_controle` ficam como
  histórico, e o motivo antigo fica congelado. Sem retorno antecipado: o recompute e o fechamento
  do log rodam mesmo num run só de CT-e.
- **Prova:** Deno (`escopo_test.ts`, 5 testes) e invariante vitest de fronteira e POSIÇÃO em
  `edge-money-path-invariants.test.ts`.

## 4. Codex no desenho — gpt-6-astra · max · 388s · 125.645 tokens: sem P0/P1

| achado do Codex (todos P2) | decisão |
|---|---|
| A em um PR; B (fonte) e a defesa do `buscarCandidatas` em outro | aceito |
| B sozinho não protege o casamento: o sync de CT-e reprocessa 30 dias | aceito, vai para o PR B |
| o matcher pode re-associar um CT-e já usado em runs seguintes | aceito: medir antes de mexer (PR B) |
| em B, classificar na resposta do `ListarRecebimentos`, antes do sleep, da consulta e do `updateLinhasDoPedido` | aceito (PR B) |
| denylist 57, parser estrito, sem o 67 | aceito |
| a ordem do fluxo e a definição do contador | aceito, e virou invariante posicional |
| medir `nIdReceb` com várias chaves | medido: 0 mistura 55/57. Os 9 grupos 55 viram observação aberta (§7) |
| 45/45 é prova vazia do caminho de gravação | aceito: pós-deploy, acompanhar 1 NF-e nova até os itens |
| critério pós-deploy: CT-e com `tentativas`/`ultima_tentativa` INTOCADOS | aceito: baseline no deploy (§8) |

## 5. Codex no código

Sem Codex: a cota estava em 88% (teto 85%), e a janela reabre em 09/10 19:30. **Caminho B**: revisor adversarial
independente, **sem P0/P1**, com 4 achados P3, todos incorporados.

| achado (P3) | decisão |
|---|---|
| vitest cego a 3 mutantes (`pendentes.concat(ctesForaDaFila)`, `pendentes && pendentesBrutos`, a linha certa comentada com `pendentes = pendentesBrutos`); o `vereditoFronteira` não enxerga desestruturação | aceito: asserts sobre `removerComentarios(src)` e âncora `= pendentes\s*\.map\(` |
| a fixture do Deno não fixava a POSIÇÃO do modelo (o mutante `includes("57")` passava) | aceito: NF-e com `57` no nNF |
| CNPJ alfanumérico: o writer arranca letras da chave | radar no §7 (direção segura; raiz no writer) |
| o SQL de revalidação media `substr = '57'` sem o predicado estrito da edge | aceito: `~ '^[0-9]{44}$'` |

## 6. Falsificação — uma camada por vez, controle verde na mesma invocação

| sabotagem | resultado |
|---|---|
| allowlist (`!== "55"`) no lugar da denylist | vermelho (Deno) |
| parser leniente (aceita espaço no fim) | vermelho (Deno) |
| filtro removido (fila nasce dos brutos) | vermelho (vitest) |
| retorno do filtro descartado | vermelho (vitest, fronteira) |
| filtro DEPOIS do dedup (texto todo presente, só a ordem muda) | vermelho na asserção de ORDEM: `"separarCtes" tem de vir ANTES de "backoff"` |
| contador some do `results` | vermelho (vitest) |
| fila ordenada = `pendentes.concat(ctesForaDaFila)` (achado do revisor) | vermelho (vitest, âncora `.map(`) |
| fila ordenada = `pendentes && pendentesBrutos` (achado do revisor) | vermelho (vitest) |
| a linha certa COMENTADA, brutos no lugar (achado do revisor) | vermelho (vitest sobre o código sem comentários) |
| modelo por `chave.includes("57")` em vez da posição (achado do revisor) | vermelho (Deno, NF-e com 57 no nNF) |

Os 4 últimos passavam VERDES na 1ª versão dos testes. O controle ficou verde no início e no fim da
mesma invocação (10 de 10 vermelhos, worktree limpo depois).

## 7. O que fica descoberto

- **Parte B, na fonte — ENTREGUE em [cte-fora-do-rastreio.md](cte-fora-do-rastreio.md).** O
  `omie-sync-nfes-recebidas` pula o 57 na resposta do `ListarRecebimentos` (chave crua E
  `cModeloNFe`), e o `buscarCandidatas` do `omie-sync-ctes-recebidos` tira a linha 57 das
  candidatas. A medição corrigiu o número daqui: os 13 são **vínculos** em linha 57; por CT-e, só 3
  nunca chegaram a uma NF-e, porque o matcher re-associa o CT-e já usado. E o vínculo extra é quase
  sempre a linha-irmã da mesma NF-e, então não se impôs unicidade.
- **As 135 linhas de CT-e no tracking e os 13 fretes desviados.** Limpar ou re-casar é decisão do
  founder: tem efeito em dado, e o redeploy não desfaz vínculo gravado. As views
  `v_leadtime_por_grupo` (conta CT-e como "pedido": 33 de 39) e `v_pedidos_em_aberto` (29 CT-e como
  AGUARDANDO_CTE) não têm leitor no repo.
- **Integridade do `nIdReceb` (pré-existente).** 9 grupos com o mesmo `nIdReceb` em chaves de NF-e
  distintas: 42 linhas, todas modelo 55 com pedido casado, todas com leadtime. Cobertura documental
  OK, mas a completude por par (tracking, SKU) não está provada.
- **Radar: CNPJ alfanumérico (inscrições novas desde jul/2026).** O writer do sync de NFes normaliza a chave com
  `replace(/\D/g, "")` (`omie-sync-nfes-recebidas/index.ts:281`) e arrancaria as letras. A chave ficaria com menos de
  44 caracteres, o parser estrito devolveria `null` e o CT-e voltaria à fila. A direção é segura (tentativa, não
  perda), mas a chave gravada estaria corrompida para qualquer casamento por chave. A raiz é o writer; tratar na
  parte B (revisão adversarial, P3).
- **14 NF-e sem leadtime (mar–abr/2026).** São anteriores ao controle (07/2026), já fora da janela, e
  nunca foram tentadas. Com o CT-e fora da fila, um run avulso com `dias` largo custaria ~14
  consultas para recuperá-las. É decisão do founder (dado histórico).

## 8. Deploy e revalidação

1. PR mergeado ⇒ `bun run pendencias:deploy` decide ⇒ deploy da `omie-sync-sku-items` pelo MCP. O eco
   `v1.3-cte-fora-da-fila` aparece no próximo tick do :35 (jobid 186).
2. **Baseline no momento do deploy** (read-only): as linhas de controle de CT-e, com contagem, soma de
   `tentativas` e `max(ultima_tentativa)`. Depois do deploy elas têm de ficar IDÊNTICAS, e nenhuma
   linha nova de controle pode aparecer em modelo 57.
3. Revalidação no 1º run das 07:00 pós-deploy (`psql-ro -v ON_ERROR_STOP=1`):

```sql
-- CT-e intocados: nenhuma tentativa nova depois do deploy (:deploy = instante do deploy)
select count(*) from sku_items_sync_controle c join purchase_orders_tracking t on t.id = c.tracking_id
where t.nfe_chave_acesso ~ '^[0-9]{44}$' and substr(t.nfe_chave_acesso, 21, 2) = '57'
  and c.ultima_tentativa > :deploy;
-- o diário enxerga os CT-e e não os consulta
select started_at, status, (results->>'ctes_fora_da_fila')::int ctes_fora,
       (results->>'fila_pendente')::int pend, (results->>'consultas_detalhadas')::int det,
       (results->>'requisicoes_omie')::int req, round(duracao_ms/1000.0,1) dur_s
from fin_sync_log where action = 'sync_sku_items' and started_at > :deploy order by started_at;
-- cobertura de NF-e intacta
select count(*), count(*) filter (where exists (select 1 from sku_leadtime_history h where h.tracking_id = t.id))
from purchase_orders_tracking t
where t.empresa = 'OBEN' and t.t2_data_faturamento >= now() - interval '30 days'
  and substr(t.nfe_chave_acesso, 21, 2) = '55';
```

Esperado: 0 CT-e com tentativa nova; no diário, `ctes_fora_da_fila` igual aos CT-e pendentes da
janela de 30 dias (17 no dia 05/10, caindo conforme expiram) e `requisicoes_omie` só de NF-e; a
cobertura de NF-e segue completa. **E 1 NF-e nova acompanhada até os itens gravados**, porque 45/45
com zero pendente não exercita o caminho de gravação.

## 9. Desfecho — o deploy e a prova (2026-10-05/07)

1. **Merge (#2798).** Squash às 18:47:25 UTC (`e80fe16ec`). Antes do deploy, a `main` foi conferida:
   o artefato estava presente (`separarCtes(pendentesBrutos)` e a `VERSAO` v1.3), e nenhum commit
   posterior tocava a edge. Não havia "Changes" do Lovable revertendo nada.
2. **Ledger antes.** `omie-sync-sku-items` estava em `DIVERGE_P1`, servindo a v1.2 (eco das 22:35Z).
   Outras 3 edges pendentes (`fin-valor-cockpit`, `omie-analytics-sync`, `sync-reprocess`) eram de
   outras sessões e ficaram FORA deste envio. O ledger final fechou com 0 pendentes.
3. **Coordenação.** O `list_messages` mostrou outra sessão deployando a `fin-valor-cockpit` às
   23:38:42Z, ainda sem resposta. Esperou-se esse deploy terminar antes de enviar este, para não
   disputar o agente.
4. **Baseline (23:35:05 UTC).** 81 linhas de CT-e no controle, Σ `tentativas` = 454,
   `max(ultima_tentativa)` = 2026-10-05 07:00:40.592, impressão `afe4f263f244afa8718f30dd38343f4d`.
5. **Envio às 23:39:31Z** (colagem do `pendencias:prompt`, 9 arquivos, base `588336292`). O agente
   conferiu 9 de 9 hashes, deployou verbatim e reportou Active (401 sem credencial), com
   `No files were edited.`. Custou 1,6 crédito. O sensor de edição, 5,4 min depois, deu `SEM_EDICAO`
   (exit 0, 0 commits do bot na `main`).
6. **Prova passiva no tick das 00:35 UTC (jobid 186).**
   - `net._http_response` #105003: HTTP 200, `versao = v1.3-cte-fora-da-fila`, `fonte` `d1fe060b…`
     (o fingerprint que o ledger esperava).
   - O run das 00:35:02 fechou `complete` em 0,4s, com o campo novo `ctes_fora_da_fila` presente
     (0 na janela de 3 dias).
   - O baseline dos CT-e ficou **idêntico** às 00:36:05.
   - O `pendencias:deploy` deu `CONFERE` via eco, com 0 pendentes.
7. **Revalidação — ✅ (psql-ro, 2026-10-07 01:46 UTC).** Foram 15 runs depois do deploy, todos
   `complete`. Usei as queries do §8 com `:deploy` = `2026-10-05 23:41+00`, o ledger
   `deploy_atestacoes` e o recorte por bundle descrito abaixo.
   - **Quem serviu.** A v1.3 isolada serviu só o tick das 00:35 de 06/10 (1 eco no ledger). Às 01:34
     entrou a `v1.4-pendencia-por-item` (#2801, de outra sessão), com 14 ecos até 00:35 de 07/10. Ela
     carrega o MESMO corte: `separarCtes(pendentesBrutos)` antes do backoff. O diário de 06/10 rodou
     na v1.4: o `results` dele traz `fila_incompleta`, chave que só existe no código da v1.4. O que se
     mediu, portanto, é o corte da v1.3 dentro do bundle da v1.4.
   - **Diário das 07:00:35 de 06/10 (dias=30).** `ctes_fora_da_fila` deu **18**. É o esperado pela
     regra da edge com o que existia às 07:00: os 17 de 05/10 mais 1 CT-e que entrou no rastreio às
     02:15. Os outros números: `fila_pendente` 1, `consultas_detalhadas` 1, `requisicoes_omie` **1**,
     8,5s. A única consulta foi uma NF-e modelo 55 (000951497, Renner Sayerlack), que fechou
     `ok_com_itens` com 3 itens. Nenhum dos 18 CT-e custou consulta.
   - **CT-e intocados.** Nenhuma linha de controle modelo 57 tem `ultima_tentativa` depois do deploy.
     O baseline ficou **idêntico** 26h depois: 81 linhas, Σ 454, max 2026-10-05 07:00:40.592,
     impressão `afe4f263f244afa8718f30dd38343f4d`.
   - **Ticks de 2h (dias=3).** `ctes_fora_da_fila` subiu de 0 a 2 à medida que 2 CT-e entraram no
     rastreio (02:15 e 18:15 de 06/10). Nenhum dos dois foi consultado.
   - **NF-e nova até os itens.** A 000116856 (Francimar) entrou no rastreio às 14:15:35 de 06/10. O
     tick das 14:35 a consultou (`fila_pendente` 1, `requisicoes_omie` 1) e gravou 1 item às 14:35:11
     (`ok_com_itens`): 20 minutos de ponta a ponta.
   - **Cobertura 55 na janela de 30 dias: 50 de 51.** A que falta é a 000954162 (Renner Sayerlack),
     que entrou às 00:15:38 de 07/10, 1h30 antes da medição. Está na fila pela regra da v1.4 (1 item
     "aguardando associação"). Não é CT-e nem lacuna do corte. O `sku_leadtime_history` OBEN teve 71
     linhas atualizadas em 7 dias.
8. **Parte B no ar.** A `omie-sync-nfes-recebidas` `v1.4-cte-fora-do-rastreio` tem eco desde 20:37
   de 06/10, e a `omie-sync-ctes-recebidos` `v1.2` desde 19:54. O CT-e das 18:15 ainda entrou pela
   v1.3 da edge de NF-e. Desde a parte B, nenhum CT-e entrou no rastreio em 3 ciclos. É pouco para
   concluir (em 06/10, antes dela, entraram 2), e essa revalidação é da
   [cte-fora-do-rastreio.md](cte-fora-do-rastreio.md). Hoje há 19 CT-e pendentes na janela de 30
   dias (os 18 do diário mais o das 18:15), e o `t2` mais novo é 2026-10-06 03:00 UTC. Se a fonte
   segurar e as 135 linhas ficarem como estão (§7), o `ctes_fora_da_fila` cai a 0 à medida que esses
   CT-e saem da janela. No tick de 2h isso acontece a partir de 2026-10-09 03:00 UTC; no diário, a
   partir de 2026-11-05 03:00 UTC. A medição é a query do diário no §8.
