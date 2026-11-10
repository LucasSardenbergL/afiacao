# Plano — portal Sayerlack → Omie: pontos cegos (revisão Codex + Fable, 2026-11-06)

> Origem: revisão adversarial sobre a main `0332d4034` (Codex gpt-6-astra high + Fable com dados de prod via psql-ro).
> Regra deste plano: **nenhum achado fica de fora** — cada um tem onda, ou está marcado 🧭 (decisão do founder).
> Tabela de rastreio no fim: todo ID dos dois pareceres aponta para um item.

## Andamento (checklist das ondas — o item do Rastreio está feito quando a onda dele está ✅)

- ✅ **Onda 1** — #3688; migration `20261107120000` aplicada (envelope #941). 🧭 alíquota de 27101230, 32091010,
  32099020, 32159000 e 39095012 aguarda o founder (nenhuma NF no banco prova).
- ✅ **Onda 2** (+ 7.4) — #3691; migration `20261107140000` aplicada (#947); envio v1.13, disparar v1.11, importar v1.5
  com DEPLOY CONFIRMADO (#950, #952, #954); Publish feito.
- ✅ **Onda 3** — #3693; varrer v1.5 com DEPLOY CONFIRMADO (#958).
- ✅ **Onda 4** — #3703; migration `20261107220000` aplicada (#960); varrer v1.6 DEPLOY CONFIRMADO (#962).
- ✅ **Onda 5A fatia 1** (5.1 + claim recusa o 6 + 5.5) — #3708; migration `20261108120000` aplicada (#966);
  disparar v1.12 (#971), importar v1.6 (#973), varrer v1.7 (#975) com DEPLOY CONFIRMADO; Publish feito.
- ✅ **5A fatia 2, 5B, Ondas 6, 7 e 8** — entregues pela revisão 2; o andamento item a item fica em
  [2026-11-08-sayerlack-revisao-2.md](2026-11-08-sayerlack-revisao-2.md) §Andamento (7.5 encerrada: o portal não
  expõe IPI por item). As 5 alíquotas 🧭 da Onda 1 foram provadas nas NF-e do Omie (#3717, #3744).

## Dados de prod que dimensionam (psql-ro, 2026-11-07)

- 6 importações (5 botão · 1 cron), todas `disparado` com PO, 0 divergência PO × app.
- Única falha real: CP006 (NCM sem alíquota). **18 SKUs comprados nos últimos 180 d sem alíquota, 8 NCMs:**
  27101230 · 29209090 · 32041920 · 32091010 · 32099020 · 32110000 · 32159000 · 39095012.
- **2 de 46 rodadas leram 0 linhas e deram sucesso** (23/10 e 03/11 01:30 UTC) — incidente de verde-falso que
  justifica o sensor das Ondas 3 e 4 (regra de máquina meta).
- `info_portal` null em 46/46 (seletor `.dataTables_info` nunca casou).
- POs lançados à mão com contrato: 17 nos 30 d antes de 14/10 → 0 desde 15/10.
- 129 pedidos Sayerlack disparados pelo app em 90 d saíram `000 À Vista`; o importado leva a condição do portal.

## Decisões do founder (✅ tomadas em 2026-11-06)

- **D-1 Condição real** — pedido Sayerlack disparado pelo app passa a usar a condição REAL do contrato/portal, não
  `000 À Vista` fixo. Item 7.4 (sobe de prioridade: vem junto da Onda 2, money-path, Codex antes).
- **D-2 Mapear as condições** — de-para explícito condição do portal → código do catálogo Omie OBEN, cobrindo as
  condições que o portal usa (ex.: "30 DIAS" → "Para 30 dias (C)"). Levantar a lista real numa rodada `listar`;
  caso ambíguo vai ao founder com a lista. Item 2.6.
- **D-3 Importar vários números de uma vez** — fazer. Item 8.5 (no diálogo do botão: lista de números, um resultado
  por número, sem paralelismo que estoure o Browserless).

## Onda 1 — Alíquota dos 8 NCMs (só banco, sem código) · P0

1.1 Levantar a alíquota de IPI de cada NCM a partir das NFs de entrada Sayerlack já recebidas (XML/itens de NF no
    banco, via psql-ro). NCM sem NF que prove a alíquota → listar ao founder, não inventar (ausente ≠ zero).
1.2 Migration de seed idempotente em `ipi_aliquota_ncm` (`ON CONFLICT DO NOTHING`, postcondição: os 8 NCMs com
    alíquota e os 18 SKUs resolvem NCM → alíquota). Modelo em `docs/agent/reposicao.md`.
1.3 Aplicar pelo envelope (`bun run db:aplicar … --ensaio` e depois real) e validar por fora com psql-ro.
1.4 Sensor permanente: contagem de SKUs Sayerlack ativos no de-para sem alíquota (vira número no card, item 6.8).

Deploy: migration (eu, envelope). Sem edge, sem Publish.

## Onda 2 — Importadora: re-disparo seguro + respostas honestas · P1

Edge `sayerlack-importar-pedido-portal` + `importar-portal.ts` + diálogo.

2.1 **Re-disparo relê a situação no portal** (Codex A1/D1). No ramo "já existe sem PO", antes de chamar
    `disparar-pedidos-aprovados`: abrir o portal, ler a situação do protocolo e exigir situação importável
    (e `situacoes_permitidas` quando vier do cron). Cancelado → recusa com motivo `pedido_cancelado` e encaminha para
    a saída do item 5.3. Portal ilegível → indeterminado, não dispara.
2.2 **Nenhum "não foi importado" com pedido gravado** (Codex C1): resposta com `pedido_id`/`ja_existia` → tom aviso,
    título "Pedido X está no app (#id) — falta resolver"; resposta 2xx nula/ilegível → `respostaIndeterminada`.
2.3 **Mensagem "concilie em Gerir pedidos"** (Codex B1 / Fable B2) passa a dizer o que fazer de verdade hoje
    (abrir o pedido #id; a vinculação de PO manual chega no item 7.1) e ganha botão para o pedido.
2.4 **CP006 sem "peça ao administrador"** (Fable C4): diz o NCM e o passo (cadastrar a alíquota; runbook do item 8.4).
2.5 **Ledger das tentativas do botão** (Fable B3): toda recusa e todo sucesso do botão gravam linha (reusar
    `sayerlack_varredura_falha` com `origem='botao'`, ou `acoes_execucoes` — decidir no início pela leitura do schema),
    com sqlstate, motivo, duração. Substitui a dependência do PostHog.
2.6 **Mapeamento "30 DIAS"** conforme D-2 (só se o founder decidir mudar).
2.7 **Resolver a pendência na hora** (Codex B3): importação bem-sucedida (botão ou cron) marca resolvida a linha
    aberta do protocolo em `sayerlack_varredura_falha`, sem esperar a próxima rodada.

Testes: vitest (títulos/tons), Deno (ramos), PG17 se tocar RPC (2 locales + falsificação). Gates de edge completos
(`sonda:bump`, `sonda:fingerprint -- --write`, `edges:*`, `authz:*`).
Deploy: migration se 2.5/2.7 pedirem; edge importar; Publish.

## Onda 3 — Varredura: nunca verde sem prova · P1

Edge `sayerlack-varrer-pedidos-portal` + `varredura.ts`.

3.1 **0 linhas lidas = erro** (Codex A5 / Fable A1): exigir `lidos > 0` ou o portal dizer explicitamente "0 de 0".
3.2 **Consertar `info_portal`** e exigir `lidos == total anunciado` (Fable D1); falta → erro com o trace.
3.3 **Cabeçalhos da tabela conferidos** (Fable D1): faltou "Pedido/Situação/Data Emissão/Vlr" → erro (DOM mudou).
3.4 **Linhas ilegíveis ou protocolo repetido = rodada com erro**, não descarte silencioso (Codex A5).
3.5 **Re-disparo que falha entra na saúde da rodada** (Codex D4): `redisparos` com falha → execução com erro.
3.6 **Resumo preservado em exceção** (Codex D4): a edge grava o resumo parcial antes de lançar (sem mexer em
    `_shared/registro-execucao.ts`, que serve 10 edges).
3.7 **Pendências além da janela de 7 dias** (Codex A6): a rodada também reconsulta, por número, cada linha aberta de
    `sayerlack_varredura_falha` (com teto por rodada) e cada pedido do app sem PO, independentemente da data.
3.8 **Re-disparo do cron usa a mesma checagem do item 2.1** (situação relida na própria importadora).
3.9 **Carência eterna por sync travado** (Fable A7): `carencia_aguarda_sync` acima de N horas → pendência visível.
3.10 **`modo=listar` com zero efeito** (Fable D5): não chamar `marcarResolvidos` em listar.

Deploy: edge varrer (+ importar se 3.8 tocar). Sem Publish se só a edge.

## Onda 4 — Vigia do cron · P1

4.1 **Regra no `data_health`/Sentinela** (Codex D5 / Fable D2): ≥1 rodada efetiva de `reposicao.varrer_portal_sayerlack`
    por dia útil (fora do horário em que o portal fecha); ausência → alerta pelo canal existente. Citar o incidente
    das 2 rodadas de 0 lidos no PR. Ler `docs/agent/sync.md` antes (conjunto acoplado `_data_health_compute`).
4.2 **Falha antes do protocolo também avisa** (Codex D5): login/config/Browserless gera e-mail 1× por causa.
4.3 **Cota do Browserless** (Fable A8): registrar sessões usadas por rodada/importação no resumo; alerta só se a
    contagem mostrar risco (sem máquina nova sem incidente).

Deploy: migration (envelope) + edge se 4.2.

## Onda 5 — Situação do portal no pedido · P1

5.1 **Colunas `portal_situacao_ultima` e `portal_situacao_em`** no pedido do app, 1 escritor = varredura (Fable B1).
    A rodada já lê a situação dos `ja_no_app` e hoje descarta.
5.2 **Pedido alterado no portal depois de importado** (Codex A2 / Fable A2): comparar itens, quantidades, preço e
    condição do portal com o pedido gravado; diferença → pendência "alterado no portal" com o diff, e aviso.
    (Sem reescrever o PO automaticamente — money-path, Codex antes.)
5.3 **Cancelado no portal sem PO** (Codex B2): ação auditada "encerrar pedido cancelado no fornecedor", aceita só com
    situação 6 relida e sem PO no Omie (conferido); nova transição de estado, já que `sucesso_portal` bloqueia o
    cancelamento hoje.
5.4 **Cancelado no portal com PO vivo no Omie** (Fable A3/B4): aviso por e-mail 1× por protocolo + linha no card.
5.5 **Gerir pedidos mostra a situação do portal** ("Atendido parcial", "Cancelado") no detalhe do pedido.

Testes PG17 nas transições; Codex no money-path (5.2/5.3). Deploy: migration + edge varrer + Publish.

## Onda 6 — Card do portal · P1/P2

6.1 **"Nada pendente" só com prova** (Codex C2 / Fable C3): exige última rodada efetiva recente; senão "sem rodada
    desde X". Mostrar também carência, espera de sync e adiados.
6.2 **Contrato do painel rígido** (Codex C2): `{}` sem as chaves → erro de leitura, não listas vazias.
6.3 **Refetch com falha não mostra dado velho como atual**: "consultado às HH:MM" + aviso quando a última falhou.
6.4 **Sem contagem dupla** (Codex C3): mesmo protocolo em pendências e sem PO conta uma vez.
6.5 **Truncamento visível** (Codex C3): a RPC devolve totais; o card diz "mostrando 50 de N".
6.6 **`cancelado_humano` fora de "sem PO"** (Codex C3) na RPC.
6.7 **Card acompanha o resto da página** (Codex C4): as ações de Gerir pedidos invalidam `portal-sayerlack-painel`;
    botão atualizar sempre visível; refetch ao terminar o horário do cron.
6.8 **Sensor de SKUs sem alíquota** no card (Fable B6, do item 1.4).
6.9 **Vocabulário único** (Fable C2): "pedido de compra" em todo o card (ou "PO" — seguir o resto da página).
6.10 **Cmd-K "Importar pedido do portal"** (Fable C1) via `useRegisterCommands`.
6.11 Linhas de "alterado no portal" e "cancelado com PO vivo" (da Onda 5).

Deploy: migration (RPC) + Publish.

## Onda 7 — Funcionalidades maiores · P2

7.1 **Vincular PO lançado à mão** (Codex B1 / Fable B2): no pedido, escolher o PO do Omie com aquele contrato,
    conferir itens/valores e gravar o vínculo auditado. Frequência hoje 0 — fica na onda 7 por isso.
7.2 **Evidência durável por tentativa** (Codex B4): guardar o cabeçalho lido, a condição original, a resposta de
    itens e o id de correlação de cada tentativa (tabela append-only), sem sobrescrever a mensagem anterior.
7.3 **Transportadora e observações do portal no PO** (Codex A3): levar `data_pedido.transportadora` e as observações
    para o payload do Omie; frete além de mercadoria+IPI tratado como componente (hoje cairia em CP007).
7.4 **Condição unificada** conforme D-1.
7.5 **IPI por linha** (Codex A4): investigar se o portal expõe NCM/IPI por item; se expuser, conferir linha a linha
    além do total. Se não expuser, registrar a limitação no doc e encerrar.

## Onda 8 — Testes, QA e operação · P1/P2

8.1 **Testes dos handlers reais** (Codex D1): suíte Deno que roda os dois `index.ts` com fetch/DB simulados nos
    ramos: existente cancelado, resposta perdida depois de gravar, PO manual, re-disparo que falha, 0 lidos.
8.2 **Contrato do DOM** (Codex D2 / Fable D1): fixtures HTML do portal (consulta com 2+ páginas, detalhe com
    `#condicoes_pagamento`, sessão expirada) e o script do navegador executado contra elas.
8.3 **QA no navegador e no celular** (Codex D3 / Fable D3): passar a tela pelo `/qa` no browser do app, incluindo
    viewport estreita, teclado, abrir pedido e voltar. (Sem Playwright no repo: QA guiado, não E2E novo.)
8.4 **Runbook "pedido do portal não entrou"** (Codex D5 / Fable D4): em `docs/runbooks/` — CP006, IP002, IP006,
    IP007, IP008, senha do portal, cota Browserless, cron parado, backlog antigo.
8.5 **Importar vários números de uma vez** conforme D-3.

## Ordem e sessões

1 → 2 → 3 → 4 em sequência (cada uma é um PR; 2 e 3 mexem nas duas edges, não paralelizar).
5 depois de 3. 6 depois de 5 (usa as colunas). 7 e 8 no fim; 8.1/8.2 podem nascer junto da onda que testam.
Cada onda: Codex no money-path, gates de edge, registro em `docs/historico/importar-pedido-portal-sayerlack.md`,
e as camadas de deploy feitas (migration eu pelo envelope; edge pelo pacote `pendencias:deploy`; Publish pelo founder).

## Rastreio (todo achado → item)

| Achado | Item | | Achado | Item |
|---|---|---|---|---|
| Codex A1 | 2.1 · 3.8 | | Fable A1 | 3.1–3.3 |
| Codex A2 | 5.2 | | Fable A2 | 5.2 |
| Codex A3 | 7.3 | | Fable A3 | 5.4 |
| Codex A4 | 7.5 | | Fable A4 | D-2 · 2.6 |
| Codex A5 | 3.1 · 3.4 | | Fable A5 | D-1 · 7.4 |
| Codex A6 | 3.7 | | Fable A6 | 1.1–1.3 |
| Codex B1 | 2.3 · 7.1 | | Fable A7 | 3.9 |
| Codex B2 | 5.3 | | Fable A8 | 4.3 |
| Codex B3 | 2.7 · 3.7 | | Fable A9 | coberto (sem achado) |
| Codex B4 | 7.2 | | Fable B1 | 5.1 · 5.5 |
| Codex C1 | 2.2 | | Fable B2 | 2.3 · 7.1 |
| Codex C2 | 6.1–6.3 | | Fable B3 | 2.5 |
| Codex C3 | 6.4–6.6 | | Fable B4 | 5.4 |
| Codex C4 | 6.7 | | Fable B5 | D-3 · 8.5 |
| Codex D1 | 8.1 · 2.1 | | Fable B6 | 1.4 · 6.8 |
| Codex D2 | 8.2 | | Fable C1 | 6.10 |
| Codex D3 | 8.3 | | Fable C2 | 6.9 |
| Codex D4 | 3.5 · 3.6 | | Fable C3 | 6.1 |
| Codex D5 | 4.1 · 4.2 · 8.4 | | Fable C4 | 2.4 |
| | | | Fable C5 | conforme (sem achado) |
| | | | Fable D1 | 3.2 · 3.3 · 8.2 |
| | | | Fable D2 | 4.1 |
| | | | Fable D3 | 8.3 |
| | | | Fable D4 | 8.4 |
| | | | Fable D5 | 3.10 |
