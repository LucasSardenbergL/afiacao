# Plano — portal Sayerlack: revisão 2 (Codex + Fable sobre as Ondas 1–5A, 2026-11-08)

> Continua `2026-11-06-sayerlack-portal-pontos-cegos.md` (o rastreio de lá segue valendo para as ondas 5–8).
> Este adendo traz as **brechas novas B1–B12** achadas no que já foi entregue e a divisão em sessões.
> Parecer do Codex na íntegra no Apêndice; o do Fable está resumido nos itens (com os números de prod).

## Estado de prod medido (Fable, psql-ro, 07/11 ~23h UTC)

- 218/218 pedidos Sayerlack com protocolo têm PO; 0 pendências abertas; 0 importações desde importar v1.5.
- Nenhuma rodada efetiva do cron com o código das Ondas 3–5A (sábado = portal fechado). A prova de leitura
  (3 fontes do total) **nunca foi observada em prod**.
- 5A: migration, disparar v1.12 e importar v1.6 no ar; varrer v1.7 sendo solta pela sessão da 5A.
- 13 SKUs Sayerlack ativos sem alíquota (9 NCMs); os 5 NCMs pendentes do founder cobrem 9 SKUs comprados.
- De-para de condição: 1 linha (`30 DIAS → A30`). O catálogo OBEN tem pares com e sem "(C)" também para 4, 6 e 13 dias.

## Decisões

- ✅ Founder: seguir com B1–B12 e depois o resto do plano.
- ✅ Alíquota dos 5 NCMs provada nas NF-e do Omie (39095012 = 3,25%; os outros 4 = 0%, CST 51) — PR #3717.
- ✅ B13 (decisão delegada pelo founder): SEMPRE a variante sem "(C)"; de-para "30 DIAS" A30 → T54 (nenhum PO usou "(C)").
- 🧭 Founder: significado do "(C)". **Até decidir (decisão de engenharia, fail-closed):** portal "4/6/13 DIAS",
  e qualquer N em que o catálogo tenha as duas variantes, viram **ambíguos → IP007** (recusa com a lista), em vez
  de gravar a variante sem "(C)" em silêncio. Implementar em B-sessão A, item B13.

## Andamento da Sessão A (edges e banco)

- ✅ **Bloco 1** (#3718) — B1, B2, B3, B4, B5, B6, B7 (edge), B9, B10, B11, B13. Migration `20261109120000` aplicada
  (#984); importar v1.7 e varrer v1.8 com DEPLOY CONFIRMADO (sondas #986/#988, 2026-11-08).
- ✅ **IPI dos 5 NCMs** (#3717) — migration `20261109130000` aplicada (#979).
- ⏳ Leitura operacional de segunda 09/11 (`modo=listar`, antes das 12:30 SP) — SQL pronto em
  `db/varredura-portal-leitura-segunda-listar-20261109.sql` (aplicar pelo envelope e ler `acoes_execucoes`);
  tarefa agendada no Mac do founder para segunda (portal fechado sáb 12h → seg 6h).
- ✅ **5.3** (#3727) — botão auditado "Encerrar — cancelado no fornecedor": migration `20261110100000` aplicada (#990),
  edge nova `sayerlack-encerrar-cancelado-portal` v1.0 DEPLOY CONFIRMADO (sonda #993). Publish do botão: founder.
- ✅ **5.4 + cobertura** (#3731) — incidente persistido, cobertura dos pedidos com PO não faturado, source
  `sayerlack_cancelado_com_po` no data_health. Migration `20261110120000` aplicada (#996); varrer v1.9 DEPLOY
  CONFIRMADO (sonda #999, 2026-11-08).
- ✅ **8.1** (#3737) — testes dos handlers reais da importar e da varrer (harness + PostgREST falso por rota), 21
  sabotagens vermelhas. Só testes: nada a deployar.
- ✅ **8.2** (#3742) — seletores e paginação testados contra HTML (vitest + jsdom), funções de página em
  `_shared/sayerlack-portal-dom.ts`; importar v1.8 e varrer v1.10, as 2 com DEPLOY CONFIRMADO.
- 🔄 **7.2 + 4.3** — evidência imutável de cada leitura (`sayerlack_portal_evidencia`, migration `20261111090000`) e
  sessão do Browserless contada pela importadora; importar v1.9 e varrer v1.11 (migration → importar → varrer).
- 🔄 **7.3** — transportadora do portal no `cObs` do PO, lida da evidência do 7.2; disparar v1.13 (Caminho B, Codex
  retroativo pendente).
- ⏳ Depois (numa sessão nova, em série): 7.1, 5.2 (botão "aceitar o portal", decisão do founder) (7.5 encerrada: o portal não expõe IPI por item).

## Andamento da Sessão B (tela e painel)

- ✅ **PR B1** (#3715) — B7 (tela), B8, 8.5, 6.10, 6.7 (chave sob `pedidos-ciclo`), B12/8.4 runbook. Publish: founder.
- 🔄 **PR B2** — RPC `sayerlack_painel_portal` v2 (migration `20261109100000` APLICADA, #977) + card (6.1–6.9, 6.11 sem
  "alterado no portal", que espera a 5.2) + prova PG17.
- ✅ **8.3** — QA no navegador do app (app local com o código do B2, dados de prod, usuário master), desktop e
  375×812: card com horário, sensor de alíquota (13 SKUs) e "não posso afirmar" (correto: a última efetiva é v1.4);
  importados com "pedido de compra"; Cmd-K abre o diálogo; vários números com inválido mostrado e botão travado (sem
  enviar importação real); Esc fecha e devolve o foco; sem rolagem horizontal; alvos de toque com 44px; abrir pedido
  pelo card funciona. Achado fora da fronteira: em Gerir pedidos o "voltar" do celular não fecha o detalhe do pedido
  (ele é estado da página, não da URL) — vale para a página inteira, follow-up.

## Brechas novas (B1–B13)

Dinheiro:
- **B1** Situação ilegível autoriza importação/re-disparo pelo botão (`leitura.ts:105,118`, `importar/index.ts:540-567`);
  e na varredura situação/data ilegíveis não contam como ilegíveis (`varredura.ts:107,115,433`). Exigir situação
  RECONHECIDA nos dois; a varredura fica vermelha. Teste que PRODUZ o contador, não que o injeta (`varredura_test.ts:259`).
- **B2** Botão re-dispara pedido existente já "Atendido Total"/"Fatur Balcão" (3/7) sem aviso (`importar/index.ts:540-557`):
  recusar o re-disparo nessas situações com mensagem "faturado no portal — confira a NF no Omie" (importação NOVA
  continua aceitando qualquer situação, decisão do founder).
- **B3** Cancelamento lido e não persistido deixa a compra liberada (`importar/index.ts:270-292,529`; `M5:278`;
  vigia ignora falha pós-prova `M4:1620`): falha ao gravar o "6" vira erro da rodada + alerta + nova tentativa;
  `situacao_gravada` entra no ledger.
- **B4** Pedido em `indeterminado_requer_conciliacao` faz a varredura sair antes de observar cancelamentos dos
  demais (`varredura.ts:78`, `varrer/index.ts:680-682,744`): separar "bloquear importação" de "ler e gravar situações".
- **B5** Re-disparo de pedido do app sem PO sem carência (`varrer/index.ts:816-851,888-893`): exigir sync de
  `pedidos_compra` completo depois da última falha (+5 min) ou consulta viva ao Omie por contrato antes do re-disparo.
- **B6** Indeterminado na última rodada da janela sai da fila para sempre (`varrer/index.ts:797,803,860,947`):
  virar trabalho durável de reconciliação (sem afirmar que falhou) e contar na saúde da rodada.

Tela e monitoramento:
- **B7** Edge perde o `pedido_id` quando a consulta ao espelho falha (`importar/index.ts:422,444,457,613`);
  resposta 2xx `{}`/sem contrato vira "não foi importado" (`importar-portal.ts:70,107`, Dialog `:56,61`):
  guardar o pedido conhecido logo ao achá-lo; sem desfecho reconhecido → indeterminado. Teste de objeto incompleto.
- **B8** `situacao_gravada:'erro'` não aparece na tela (`importar-portal.ts:13-31`): mostrar aviso.
- **B9** `modo=listar` satisfaz o vigia do cron (`M4:1611,1625`; `varrer/index.ts:627,635`): o vigia só conta
  rodadas `modo=importar`.
- **B10** 1ª importação não grava a situação lida (escritor só faz UPDATE antes do INSERT — `importar/index.ts:529→594`,
  `M5:205`): gravar após criar, respeitando a ordenação temporal.
- **B11** Opções do `#condicoes_pagamento` não vão ao ledger (`importar/index.ts:602,657-670`): `detalhes.condicoes_opcoes`.
- **B12** Mensagem CP006 e vigia citam `docs/runbooks/sayerlack-pedido-portal-nao-entrou.md`, que não existe → escrever (= 8.4).
- **B13** "(C)" ambíguo → IP007 (ver Decisões).

Operacional (não é código): **segunda 09/11, antes das 12:30 SP**, rodar a varredura em `modo=listar` e ler no
registro `resposta_chaves`/`dt_total`/`info_portal`. Se nenhuma fonte do total casar, o cron fica vermelho em toda
rodada → corrigir antes (vira urgente o 8.2). Fica com a sessão A.

## O que falta do plano original (confirmado pelos dois)

Parciais: 1.4 (sensor no card → 6.8), 2.6 (de-para: B11 + B13 + inventário real), 4.3 (contagem do botão), 7.2.
Faltam: 5.2, 5.3, 5.4, 6.1–6.11, 7.1, 7.3, 7.5, 8.1, 8.2, 8.3, 8.4 (=B12), 8.5.

Ajustes de desenho:
- **5.3** reusar `conciliarCanceladoNoPortalPorConsulta` (disparar v1.12) numa RPC/ação auditada; tratar
  `disparo_claim_em` aberto; ausência de resposta do Omie ≠ ausência de compra.
- **5.4** gatilho já existe (`gravarSituacoes` → `canceladas`); aviso como source do `data_health` (padrão 4.1), 1×/protocolo.
- **5.2** snapshot inicial durável antes de comparar; comparar SKU, qtde, mercadoria, IPI e condição; sem PO,
  divergência impede re-disparo do retrato antigo; com PO, pendência com diff. Só situações 1/5, com o teto das reconsultas.
- **6.x** a RPC do painel devolve `ultima_rodada_efetiva` (modo importar, prova ok), totais, horário, espera/carência;
  deduplica por protocolo; **inclui pedidos originados no app** (hoje `sem_po` exige `importado_portal_em`, `MP:279`).
- **7.1** nasce dos dois pontos que já detectam `po_manual_no_omie`; conferir contrato composto e conteúdo.
- **7.2** correlação pelo id de `acoes_execucoes` + evidência imutável (cabeçalho, itens brutos, opções).
- **8.1** usar `_shared/harness-handler_test.ts`; incluir falha ao gravar o "6", objeto incompleto, perda do id,
  listar mascarando cron, indeterminado saindo da janela.
- **8.5** laço sequencial no front, um resultado e uma recuperação por número.

## Divisão em sessões (decidida)

Regra: duas sessões nunca escrevem nos mesmos arquivos.

- **Sessão A — edges e banco (money-path), agora:** B1–B7 (parte edge), B9, B10, B11, B13 e a leitura de segunda.
  Depois, na mesma linha: 5.3, 5.4, 5.2, 8.1, 8.2, 7.1, 7.2, 7.3, 7.5, 4.3 (botão).
  Arquivos: `supabase/functions/sayerlack-*`, `disparar-pedidos-aprovados`, `_shared/sayerlack-*`, migrations.
- **Sessão B — tela e painel, agora em paralelo:** B7 (parte tela: `{}` → indeterminado), B8, B12/8.4 (runbook),
  Onda 6 inteira (6.1–6.11, com a RPC `sayerlack_painel_portal` — migration própria), 8.5, 8.3 (QA no navegador).
  Arquivos: `src/components/reposicao/pedidos/*`, a RPC do painel, `docs/runbooks/`.
  Não toca edges. Se precisar de campo novo da edge, pede à sessão A.
- Contrato entre as duas: a sessão A não muda o formato da resposta da importadora sem avisar a B; B8 consome
  `situacao_gravada`, que já existe.

---

## Apêndice — parecer do Codex (gpt-6-astra high, 2026-11-08), na íntegra

**Há brechas P1 nas ondas entregues. Não encontrei evidência suficiente para classificar algum achado como P0.** As principais são: situação ilegível ainda autoriza importação pelo botão; cancelamento lido pode não virar bloqueio persistido; e algumas falhas continuam produzindo certeza falsa na interface ou no monitoramento.

Revisei o código local, o plano e o histórico, sem editar arquivos nem abrir `schema-snapshot.sql`. Executei **47 testes puros existentes**, usando Node com adaptação de `Deno.test`: todos passaram. As contraprovas abaixo executaram funções reais; uma também executou o corpo de `tratar()` com banco simulado. Não executei PG17 nem consultei produção.

Para encurtar as referências `arquivo:linha`:

| Sigla | Arquivo |
|---|---|
| `I` | `supabase/functions/sayerlack-importar-pedido-portal/index.ts` |
| `L` | `supabase/functions/sayerlack-importar-pedido-portal/leitura.ts` |
| `V` | `supabase/functions/sayerlack-varrer-pedidos-portal/index.ts` |
| `R` | `supabase/functions/sayerlack-varrer-pedidos-portal/varredura.ts` |
| `D` | `supabase/functions/disparar-pedidos-aprovados/index.ts` |
| `UI/` | `src/components/reposicao/pedidos/` |
| `M1` | `supabase/migrations/20261107120000_ipi_aliquota_ncm_seed_nf_onda1.sql` |
| `M2` | `supabase/migrations/20261107140000_sayerlack_condicao_portal_onda2.sql` |
| `M4` | `supabase/migrations/20261107220000_data_health_sayerlack_varredura_portal.sql` |
| `M5` | `supabase/migrations/20261108120000_sayerlack_situacao_portal_no_pedido.sql` |
| `MP` | `supabase/migrations/20261106140000_sayerlack_importar_portal_revisao.sql` |
| `H` | `docs/historico/importar-pedido-portal-sayerlack.md` |

**1) O que foi entregue e pode melhorar**

**A1 — Situação ilegível ainda pode virar compra — P1 · P**

Cenário: o portal devolve `Situação: "???"`, mantendo itens e valores válidos. `lerCabecalho()` aceita qualquer texto não vazio que não pareça cancelamento. Pelo botão, `situacoesPermitidas` é nulo: nenhuma lista de códigos impede a criação ou o re-disparo.

**Evidência:** `L:105`, `L:118`, `I:540`, `I:551`, `I:567`. A contraprova retornou cabeçalho `ok:true` para `"???"`, enquanto `situacaoObservada()` retornou `null`.

Isso é uma lacuna do **2.1**, não o cancelamento explícito já corrigido. Exigir situação reconhecida também no botão; a autorização humana para importar outras situações não transforma texto ilegível em situação válida.

**A2 — Falha ao persistir cancelamento deixa a compra liberada — P1 · M**

Cenário: pedido existente sem PO tem situação antiga `1` ou nula. A importadora lê `6`, mas a RPC de situação falha. A tentativa atual recusa o cancelado, porém o disparador seguinte continua autorizado pelo estado antigo.

**Evidência:** `I:270` trata a gravação como operação que nunca lança; `I:281` retorna `"erro"`; `I:529` continua o processamento; `M5:278` bloqueia somente o `6` persistido. Na varredura, o erro aparece em `V:665` e `V:955`, mas o vigia ignora falhas posteriores à prova de leitura em `M4:1620`.

**Agravante:** `situacao_gravada` não entra nos detalhes duráveis da tentativa (`I:657`). No botão, sobra principalmente o log.

É diferente da janela de segundos já declarada no histórico: aqui o veto pode permanecer ausente até outra leitura bem-sucedida. A persistência do veto precisa de recuperação e alerta próprios; não pode receber o mesmo tratamento de uma falha de telemetria.

**A3 — Um pedido em conciliação desliga a observação dos demais — P1 · M**

Cenário: pedido A fica em `indeterminado_requer_conciliacao`. Pedido B, já com protocolo e sem PO, é cancelado no fornecedor. Todas as varreduras retornam antes de abrir o portal; B permanece sem o `6` e pode ser comprado pelo disparador.

**Evidência:** `R:78`, `V:680`, `V:682`; a gravação das situações só acontece em `V:744`; o claim permite situação nula em `M5:278`.

A trava global já existia para impedir importação duplicada. A **nova responsabilidade de observar cancelamentos**, introduzida pela 5A, não foi separada dela. Bloquear criação de compras deve permitir continuar lendo e registrando situações.

**A4 — “Leitura provada” aceita situação e data ilegíveis — P1 · P**

Cenários reproduzidos:

- Número válido e situação vazia → `ilegiveis:0`, prova `ok:true`, classificação `situacao_nao_importavel`.
- Número válido e emissão `"??"` → `ilegiveis:0`, prova `ok:true`, classificação `fora_da_janela`.

O pedido desaparece dos candidatos sem tornar a rodada vermelha.

**Evidência:** `R:107` só contabiliza protocolo inválido como ilegível; `R:115` aceita situação/data sem validação; `R:433` confia nessa contagem. O teste de ilegibilidade injeta o contador pronto, sem provar sua produção: `supabase/functions/sayerlack-varrer-pedidos-portal/varredura_test.ts:259`.

A Onda 3 provou quantidade de linhas e presença de cabeçalhos, mas não toda a legibilidade necessária para decidir.

**A5 — Erro no espelho apaga um pedido que a importadora já encontrou — P1 · P**

Cenário reproduzido no corpo real de `tratar()`: a primeira consulta encontra o pedido `#77`, sem PO; a consulta a `purchase_orders_tracking` falha. A resposta é HTTP 500, `etapa:"importacao"`, **sem `pedido_id`**. A tela afirma “não foi importado”.

**Evidência:** `I:422`, `I:444`, `I:457`, `I:613`; apresentação em `UI/importar-portal.ts:107`.

A correção anterior preservou o ID **quando ele chega no HTTP 500**. Este é outro caminho: a própria edge perde a identidade antes de montar a resposta. Guardar o pedido conhecido imediatamente após encontrá-lo resolve esse caso.

**A6 — JSON sem contrato ainda vira certeza de “não importado” — P1 · P**

Cenário reproduzido: resposta 2xx `{}` resulta em “Pedido X não foi importado”. Um erro HTTP com `{"error":"…"}`, sem contrato da importadora, também é convertido pelo diálogo em recusa de importação, embora possa ocorrer depois de algum efeito.

**Evidência:** `UI/importar-portal.ts:70`, `UI/importar-portal.ts:107`; `UI/ImportarPedidoPortalDialog.tsx:56`, `UI/ImportarPedidoPortalDialog.tsx:61`.

O teste novo cobre `null`, string, array e número, mas não objeto incompleto: `UI/__tests__/importar-portal.test.ts:40`.

Validar o contrato de resposta. Sem desfecho reconhecido, mostrar indeterminado; uma mensagem de infraestrutura não prova rollback.

**A7 — `listar` pode deixar o vigia do cron verde — P2 · P**

Cenário: cron de importação parado; alguém executa `modo:"listar"` com leitura válida. Essa execução atualiza a “última efetiva” e pode substituir uma falha anterior como último desfecho, apesar de não importar nem re-disparar nada.

**Evidência:** os dois modos compartilham o registro (`V:627`, `V:635`); a consulta de efetividade não filtra modo (`M4:1611`), nem a de último desfecho (`M4:1625`). Os cenários efetivos do teste usam `modo:"importar"`: `db/test-data-health-sayerlack-varredura.sh:325`.

O sensor precisa distinguir **portal legível** de **automação de importação executada**.

**A8 — Primeira importação perde a situação que acabou de ler — P2 · P**

Cenário: importar um número que ainda não existe no app. A situação é enviada ao escritor antes do INSERT; o escritor só faz UPDATE, portanto não grava nada. Depois da criação não há segunda gravação. O pedido nasce sem situação, embora a resposta conheça o estado do portal.

**Evidência:** ordem em `I:529` → `I:567` → `I:594`; escritor em `M5:205`; INSERT sem situação em `M2:276`.

Isso deixa o detalhe sem informação até uma leitura posterior — particularmente relevante para pedidos antigos, fora da janela, que já saíram com PO. Persistir a observação inicial junto da criação, respeitando a ordenação temporal existente.

**A9 — Indeterminado pode terminar verde e sair definitivamente da fila — P2 · M**

Cenário: na última rodada em que um pedido cabe nos sete dias, a chamada à importadora perde a resposta antes de criar qualquer registro. A varredura grava apenas `indeterminados` no resumo, termina com sucesso e não cria pendência. No dia seguinte, o protocolo está fora da janela e não entra na reconsulta.

**Evidência:** `V:797`, `V:803`; a composição de problemas ignora indeterminados em `V:947`; a recuperação busca apenas falhas abertas e pedidos existentes sem PO em `V:860`.

Preservar “não sei” é correto. Falta transformar essa incerteza em trabalho durável de reconciliação, sem afirmar que a compra falhou.

Não reapresentei como novidades os contratos compostos, o bloqueio do default à vista, a imutabilidade do protocolo nem as corridas temporais já corrigidas. Também não considero as provas PG17 “só caminho feliz”: há falsificações e concorrência reais. A lacuna está principalmente na composição das edges e nas entradas que os testes puros não exercitam.

**2) O que ainda falta do plano**

`FEITO` significa implementação encontrada; não é nova certificação de deploy. Prioridade e esforço abaixo se referem ao trabalho restante. Para QA, `FALTA` significa **falta comprovação no repositório**, não afirmação de que ninguém tenha testado manualmente.

| Item | Estado | Evidência e trabalho restante | Prior./esforço |
|---|---|---|---|
| **1.1** Levantar alíquotas | **FEITO** | Investigação separou três comprovados e cinco sem NF: `M1:8`, `M1:14`. | — |
| **1.2** Seed dos oito NCMs | **PARCIAL** | Seed e postcondição cobrem **3/8**, não oito: `M1:23`, `M1:34`. Cinco continuam dependendo de evidência/decisão. | P1/M |
| **1.3** Aplicação e validação | **FEITO** | Para os três semeados, aplicação #941 e conferência estão documentadas em `H:180`. Não revalidei produção. | — |
| **1.4** Sensor permanente | **FALTA** | Há query no histórico (`H:185`), mas não sensor operacional/card. | P2/P |
| **2.1** Re-disparo relê situação | **PARCIAL** | Releitura existe: `I:473`, `I:551`. Situação desconhecida ainda passa pelo botão: A1. | P1/P |
| **2.2** Respostas honestas | **PARCIAL** | Ramos principais corrigidos em `UI/importar-portal.ts:98`; restam A5/A6. | P1/P |
| **2.3** Orientação e abrir pedido | **FEITO** | Mensagem de PO manual: `I:451`; link: `UI/importar-portal.ts:59`. | — |
| **2.4** CP006 acionável | **PARCIAL** | Informa NCM e procedimento (`L:245`), mas aponta para runbook inexistente (`L:252`). | P2/P |
| **2.5** Ledger de tentativas | **FEITO** | Abertura, origem e fechamento: `I:363`, `I:619`, `I:645`. É best-effort; recusas de entrada anteriores à abertura ficam fora. | — |
| **2.6** De-para explícito | **PARCIAL** | Tradutor e tabela existem; única semente é `30 DIAS → A30`: `M2:42`, `M2:75`. Não há inventário reconciliado de todas as condições. | P1/M |
| **2.7** Resolver pendência imediatamente | **FEITO** | PO confirmado resolve pendência em `I:390`, `I:398`, `I:425`. | — |
| **3.1** Zero exige prova | **FEITO** | `R:425`, `R:430`: zero só passa com total anunciado zero. | — |
| **3.2** Total e `info_portal` | **FEITO** | Fontes ampliadas: `V:198`, `V:203`; consistência em `R:392`. | — |
| **3.3** Cabeçalhos obrigatórios | **FEITO** | `R:367`, `R:416`. | — |
| **3.4** Ilegíveis/repetidos vermelhos | **PARCIAL** | Repetidos e números ilegíveis cobertos; situação/data não: A4. | P1/P |
| **3.5** Re-disparo afeta saúde | **PARCIAL** | `falhou` torna vermelho (`V:951`); indeterminado não (`V:845`). | P2/P |
| **3.6** Resumo em exceção | **FEITO** | Acumulador e fechamento com erro: `V:633`, `V:655`. | — |
| **3.7** Pendências fora da janela | **FEITO** | Fila, teto, reserva e reconsulta: `V:556`, `V:586`, `V:860`, `R:469`. A9 exige ampliar quem entra nessa fila. | — |
| **3.8** Cron usa releitura | **FEITO** | Chama a mesma importadora com situações permitidas: `V:507`, `V:837`; validação em `I:540`. | — |
| **3.9** Carência travada visível | **FEITO** | Limite de seis horas e aviso: `R:443`, `V:920`. | — |
| **3.10** Listar sem efeitos de negócio | **FEITO** | Escritas/ações de negócio condicionadas ao modo: `V:737`, `V:744`, `V:763`, `V:1012`. Registro de execução permanece. | — |
| **4.1** Vigia do cron | **PARCIAL** | Regra e canal existem; `listar` pode satisfazê-la: `M4:1609`, A7. | P2/P |
| **4.2** Aviso pré-protocolo | **FEITO** | Causa estruturada em `V:643`, `V:704`; consumo em `M4:1620`. | — |
| **4.3** Consumo Browserless | **PARCIAL** | Conta chamadas de importação como sessões (`V:638`), inclusive quando retornam antes do navegador. Tentativa pelo botão não registra contagem em `I:657`. | P2/P |
| **5.1** Situação persistida | **PARCIAL** | Colunas, escritor e claim existem (`M5:26`, `M5:163`, `M5:255`); faltam coberturas A2/A3/A8. | P1/M |
| **5.2** Alterado no portal | **FALTA** | Re-disparo usa o pedido antigo sem comparar conteúdo: `I:549`. Não existe diff persistido. | P1/G |
| **5.3** Encerrar cancelado sem PO | **FALTA** | Não existe ação auditada específica. `V:364` trata outro caso: pedido que já tinha PO e cujo PO sumiu. | P1/M |
| **5.4** Cancelado com PO vivo | **FALTA** | Detalhe avisa (`UI/PortalStatusPanel.tsx:80`), mas não há aviso dedicado 1×/protocolo nem linha no card. A rodada resolve pendência quando encontra PO: `V:765`. | P1/M |
| **5.5** Situação no detalhe | **FEITO** | Texto, horário e aviso: `UI/PortalStatusPanel.tsx:57`. Depende da cobertura de 5.1. | — |
| **6.1** “Nada pendente” com prova | **FALTA** | Depende apenas das listas vazias: `UI/PedidosPortalCard.tsx:110`. Não exige rodada recente nem considera carências/adiados. | P1/M |
| **6.2** Contrato rígido do painel | **FALTA** | `{}` vira três listas vazias: `UI/importar-portal.ts:163`. O teste exige esse comportamento incorreto: `UI/__tests__/importar-portal.test.ts:121`. | P1/P |
| **6.3** Refetch e idade dos dados | **PARCIAL** | Há aviso de erro (`UI/PedidosPortalCard.tsx:57`), mas dados anteriores continuam renderizados, inclusive “Nada pendente”; não há horário da consulta. | P2/P |
| **6.4** Deduplicar contagem | **FALTA** | Soma direta das duas listas: `UI/PedidosPortalCard.tsx:34`. | P2/P |
| **6.5** Truncamento explícito | **FALTA** | RPC limita listas a 50 sem totais: `MP:273`, `MP:282`, `MP:291`. | P2/P |
| **6.6** Excluir `cancelado_humano` | **FALTA** | Ausente da exclusão em `MP:281`. Pode continuar oferecido como compra pendente. | P2/P |
| **6.7** Atualização integrada | **PARCIAL** | Diálogo invalida painel (`UI/ImportarPedidoPortalDialog.tsx:19`); demais ações não. Atualizar só aparece após erro (`UI/PedidosPortalCard.tsx:61`); não há refetch pelo horário do cron. | P2/M |
| **6.8** Sensor de alíquota no card | **FALTA** | Contrato da RPC só devolve três listas: `MP:269`; card não consome sensor. | P2/P |
| **6.9** Vocabulário único | **FALTA** | Mistura “pedido de compra”, “PO” e “sem PO”: `UI/PedidosPortalCard.tsx:91`, `UI/PedidosPortalCard.tsx:128`. | P2/P |
| **6.10** Cmd-K | **FALTA** | Não existe registro do comando de importação. Entrada atual: `UI/ImportarPedidoPortalDialog.tsx:103`. | P2/P |
| **6.11** Linhas de alteração/cancelamento | **FALTA** | Não existem no contrato `MP:269` nem no card. | P1/M |
| **7.1** Vincular PO manual | **FALTA** | A própria resposta declara indisponibilidade: `I:453`; reconsulta apenas mantém pendência: `V:890`. | P2/G |
| **7.2** Evidência durável completa | **PARCIAL** | Ledger por tentativa existe, mas só resumo: `I:657`. Não guarda cabeçalho, itens brutos e conjunto de opções; não existe snapshot completo por tentativa. | P1/M |
| **7.3** Transportadora/observações/frete | **FALTA** | Fixture já contém transportadora (`leitura_test.ts:24`), parser não a retorna (`L:220`); PO usa observação genérica (`D:1320`). | P2/M |
| **7.4** Condição real unificada | **FEITO** | Tradução comum em `M2:60`; aplicação antes de sucesso em `supabase/functions/enviar-pedido-portal-sayerlack/index.ts:2140`; bloqueio do default em `D:1288`. | — |
| **7.5** Investigar IPI por linha | **FEITO** | Veredito (2026-11-08): o portal **não expõe** NCM nem IPI por item; o IPI só aparece na NF faturada (founder + 257 tentativas, `form/add` e consulta sem campo de IPI). A alíquota vem das NF-e do Omie: sensor = 0 (#3717, #3744). Histórico §"7.5". | P2/M |
| **8.1** Handlers reais | **FALTA** | Importar/varrer têm testes dos módulos puros, não dos fluxos de seus `index.ts`. O teste do disparador cobre autorização: `supabase/functions/disparar-pedidos-aprovados/index_test.ts:1`. | P1/M |
| **8.2** Fixtures DOM executáveis | **FALTA** | Scripts continuam embutidos (`I:39`, `V:72`); fixtures existentes são objetos já extraídos (`leitura_test.ts:9`), não HTML exercitando seletores/paginação. | P1/M |
| **8.3** QA browser/celular | **FALTA** | Não encontrei comprovação do roteiro exigido no plano. Classes responsivas e testes de componente não comprovam esse QA. | P2/M |
| **8.4** Runbook | **FALTA** | `docs/runbooks/sayerlack-pedido-portal-nao-entrou.md` **não existe**, embora já seja indicado ao operador (`L:252`) e pelo vigia (`M4:1596`). | P2/P |
| **8.5** Vários números | **FALTA** | Estado, validação e chamada são escalares: `UI/ImportarPedidoPortalDialog.tsx:41`, `:51`, `:96`. | P2/M |

As decisões **D-1, D-2 e D-3** correspondem, portanto, a **FEITO, PARCIAL e FALTA**. Os registros Fable A9/C5 continuam “sem achado”; não geram implementação adicional.

**O desenho das próximas ondas precisa incorporar o que já existe:**

- **5A restante:** separar leitura de situações da autorização para importar; cobrir protocolos com PO fora dos sete dias; reutilizar o escritor temporal existente. O encerramento deve tratar explicitamente `disparo_claim_em` aberto e conciliar por consulta ao Omie, sem transformar ausência de resposta em ausência de compra. Os avisos precisam de reserva/token, conforme o próprio histórico já prevê (`H:305`).
- **5B:** criar um snapshot inicial durável antes de comparar alterações. Comparar SKU, quantidade, mercadoria, IPI e condição normalizada; somente comparar totais não detecta troca de itens. Sem PO, divergência precisa impedir re-disparo do retrato antigo; com PO, produzir pendência com diff.
- **6:** a RPC deve devolver totais, horário da consulta, última execução efetiva de **importação**, falhas recentes e estados de espera. Deduplicar por protocolo. Também deve incluir pedidos originados no app: hoje `sem_po` exige `importado_portal_em IS NOT NULL` (`MP:279`), enquanto a 5A protege um conjunto maior.
- **7:** aproveitar o ID de `acoes_execucoes` como correlação, acrescentando evidência imutável. A vinculação manual deve verificar contrato composto e conteúdo, não apenas encontrar um número. Transportadora/frete exigem ampliar a prova financeira, preservando CP007 como proteção.
- **8:** antecipar 8.1/8.2 para antes das próximas mudanças no fluxo financeiro. Incluir falha na gravação do `6`, objeto de resposta incompleto, perda do ID, `listar` mascarando cron e indeterminado saindo da janela. O lote de 8.5 deve manter um resultado e uma recuperação independentes por número, com execução sequencial.

**TOP 10 por valor/esforço**

| Ordem | Trabalho | Prioridade | Esforço |
|---:|---|---|---|
| 1 | Exigir situação reconhecida antes de importar/re-disparar — **A1** | P1 | P |
| 2 | Fazer situação/data ilegíveis reprovarem a leitura — **A4** | P1 | P |
| 3 | Preservar pedido conhecido e tratar resposta sem contrato como indeterminada — **A5/A6** | P1 | P |
| 4 | Fechar a recuperação da persistência do cancelamento — **A2** | P1 | M |
| 5 | Manter observação de cancelamentos durante bloqueio por pedido em voo — **A3** | P1 | M |
| 6 | Impedir que `listar` satisfaça o vigia da importação — **A7** | P2 | P |
| 7 | Remover o verde falso do painel e endurecer seu contrato — **6.1–6.3** | P1 | M |
| 8 | Criar o runbook que a produção já manda consultar — **8.4** | P2 | P |
| 9 | Testar os handlers reais com falhas entre leitura, gravação e disparo — **8.1** | P1 | M |
| 10 | Cobrir protocolos antigos com PO e avisar cancelamento com compra viva — **5.4 / 5A restante** | P1 | M |
