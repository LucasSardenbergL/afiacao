# Orçamento de compra — backtest v1 (simulação)

**O que é:** simulação read-only de um orçamento de caixa sobre os ciclos do motor de reposição Sayerlack dos últimos 90 dias. Pergunta: se um corte por valor (ΔV>0 por embalagem) + guarda de caixa (reserva de 30 dias, cenário-guarda sem vendas novas) estivesse ligado, quanto do pedido do motor teria sido aceito, e o corte teria causado ruptura? **Nada mudou em produção.** v1 = só simulação; aplicar no app é a v2, atrás do portão abaixo.

- Spec: [`docs/superpowers/specs/2026-10-15-orcamento-compra-design.md`](../specs/2026-10-15-orcamento-compra-design.md)
- Página de decisão (gerada, commitada): [`index.html`](index.html) — publicada como Artifact pelo controlador da sessão.
- Código: `scripts/orcamento-compra/simular.ts` (backtest), `scripts/orcamento-compra/pagina.ts` (página), `src/lib/reposicao/orcamento-compra/*` (núcleo puro, sem I/O), `fatos.sql` (consulta read-only).

## Como rodar

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
# 1) backtest contra produção (read-only via ~/.config/afiacao/psql-ro); saida/ é ignorada pelo git
bun scripts/orcamento-compra/simular.ts --banco docs/superpowers/orcamento-compra/saida > /tmp/oc-run.log 2>&1; rc=$?
tail -c 1500 /tmp/oc-run.log; [ "$rc" -eq 0 ] && grep -c '^fim|ok$' /tmp/oc-run.log   # esperado: 1
# exit 2 = pré-voo reprovado → corrigir a FONTE, nunca afrouxar o pré-voo

# 2) página
bun scripts/orcamento-compra/pagina.ts --publico docs/superpowers/orcamento-compra/saida/resultado.json docs/superpowers/orcamento-compra/index.html > /tmp/oc-pag.log 2>&1; rc=$?
tail -1 /tmp/oc-pag.log; [ "$rc" -eq 0 ]   # esperado: fim|ok
```

## Resultado da rodada de 2026-10-15, após a onda final R32–R53 (fatos de hoje = 2026-10-15; ciclos de 2026-07-18 a 2026-10-15)

> **Repo público (decisão do founder, 2026-10-15):** valores em dinheiro aparecem como **% do que o motor pediu nos disparados** (= 100%). Os absolutos ficam só na saída local git-ignorada (`saida/`) e no Artifact privado. A página commitada é gerada com `--publico`.

| Medida | Valor |
|---|---|
| Ciclos / disparados | 268 / 119 (+140 expirados, 7 cancelados, 2 pendentes) |
| Motor pediu (disparados, com frete 2,5%) | 100% (base) |
| **Orçamento aceitaria** (disparados **com guarda de caixa**, R51) | 0% — só 2 disparados têm veredito de caixa (ambos inviáveis; 0,5% do pedido do motor neles) |
| Aceito **sem guarda de caixa** (117 disparados indeterminados; só o gate econômico) | 46,7% |
| Cortes nos disparados por motivo | econômico 44,4% · financeiro 0,5% · sem score 8,4% |
| Valor cortado efetivo / expirado (dedup. por episódio; sem score fora, R48) | 35,6% / 23,0% |
| **Revisão humana** (sem score, disparados; R48) | 91 embalagens, 7,2% (dedup.), 0 sem preço |
| Cortes sem preço (todos os ciclos) | 60 |
| Episódios de corte (efetivos, dedup. 7d) | 215 |
| **Precisão por episódio** (portão) | **84,9%** — 41 classificados, 174 indeterminados → cobertura **19,1%**; valor classificado 8,7% |
| Precisão por corte | 87,3% — 147 classificados, 720 indeterminados; valor classificado 10,4% |
| Classes dos cortes classificados (replay conjunto por SKU, R32) | adiado 120 · eliminado 1 · **teria_rompido 26** |
| Cortes com chegada aproximada (pedido sem t4, R33) | 151 |
| ΔDIO (positivo = menos estoque; soma dos episódios medidos) / caixa liberado | 0,84 dia / 1,1% — 16 episódios medidos (16 no subconjunto do CMV), 88 sem horizonte, 111 indeterminados |
| CMV diário do universo do motor (cobertura R46) | valor omitido (repo público) — 85,6% dos SKUs com preço e demanda |
| Embalagens sensíveis ao modelo | 603 |
| Estados de caixa (todos os ciclos) | **indeterminado 264** · inviável 4 · viável 0 (disparados: 117 · 2 · 0) |
| Indeterminado por camada | compromisso_nao_conciliado 262 · snapshot 2 (2026-10-15, snapshot do dia ainda não tirado) |
| Inviáveis | ciclos 1302, 1303 (24/07, disparados) e 1316, 1317 (25/07, expirados) — 1ª violação no dia 0 |
| Sensibilidade (disparados) | 15d: 0% com guarda, 0 inviáveis, 119 indeterminados (46,9% sem guarda) · 30d: 0%, 2, 117 (46,7%) · 45d: 9,6%, 36, 60 (23,2%) |

### O que mudou em relação à rodada R31 (e por quê)

- **Precisão caiu de 100% para 84,9%.** O replay agora tira **todas** as embalagens cortadas do SKU juntas (R32), no dia em que o pedido chegou de fato (R33). Medir uma a uma escondia ruptura: 26 cortes classificados agora romperiam. A revisão final tinha estimado ~88,8%.
- **Quase todo ciclo virou indeterminado (264 de 268).** A causa é o fim do corte de 60 dias (R38): pedido disparado sem NF, de qualquer idade dentro de 180 dias, volta a ser compromisso inteiro. Com 15 dias ou mais, ele é "não conciliado".
  - **Diagnóstico datado 2026-10-15, não recalculado:** 13 pedidos disparados em maio/junho **sem nenhuma NF no tracking** somam 7,4% do pedido do motor nos disparados (× 1,025 de frete). Eles ficam em todas as janelas de 180 dias e, junto com títulos fora da base (R35), passam do limiar de 10% da reserva.
  - Numa variante de diagnóstico **sem esses 13 pedidos** (só para medir o peso deles, não é resultado): 196 viáveis · 63 inviáveis · 9 indeterminados; aceito com guarda 33,4%.
  - **Pergunta para o founder:** esses 13 pedidos de maio/junho foram de fato faturados e pagos (fora do tracking) ou nunca saíram? Se foram pagos, o caminho é trazer a evidência de pagamento para os fatos (não reintroduzir o corte de idade).
- **Inviáveis caíram de 61 para 4** só porque os outros ciclos agora são indeterminados — a guarda não deu veredito neles. Isso não é melhora do caixa.
- **"Orçamento aceitaria" caiu para 0%** porque agora só soma ciclos com veredito de caixa (R51). O que só o gate econômico aceitou (46,7%) aparece à parte, como "sem guarda de caixa".

### R57/R58 — os 13 pedidos de maio/junho sem NF (2026-10-16)

Investigação por pedido (psql-ro): a edge de NF casa NF↔pedido pelo nº do pedido na Sayerlack (`nNumPedCompra` = `cContrato`). As NFs de maio chegaram **antes** de a linha do pedido existir no tracking (criadas em 2026-06-26) e viraram linhas órfãs nunca reconciliadas. Correção na fonte: sessão própria (edge `omie-sync-nfes-recebidas`).

| Destino | Pedidos | Evidência |
|---|---|---|
| NF órfã pelo contrato, título pago | 3 (1002, 1007, 1011) | `nNumPedCompra` = `cContrato` |
| Refeito à mão no Omie, NF paga | 2 (1005→1010, 1015→1037) | mesmos itens e quantidades |
| Sem NF em lugar nenhum | 8 | ficam indeterminados (decisão do founder) |

O founder aprovou as duas regras; o challenge Codex (xhigh, 2026-10-16) achou que elas fabricavam liquidação e elas foram **endurecidas** (fail-closed):
- **R57 (contrato):** liga a NF só se **todo** identificador Sayerlack do pedido (`cContrato` e protocolo do portal) tem NF. 1007, 1011 e 1005 foram **reenviados ao portal em 22/05** e ganharam outro pedido na Sayerlack (protocolos 2096768–2096771), que **não tem NF**: pode estar em aberto, então não liga.
- **R58 (substituto):** só para pedido sem nenhum identificador Sayerlack, com veto quando o contrato do manual pertence a um pedido do motor (1037 = 1048, o mesmo pedido Sayerlack) e unicidade nos dois sentidos.
- **As-of:** a NF vinculada só vale se faturada **antes** do dia do ciclo (a topologia NF↔pedido também carrega informação futura).

**Resultado (fatos de 2026-10-16):** só 1 disparado ganha NF (1002); os estados não mudam (268 indeterminados, 4 inviáveis). A precisão por episódio desta rodada (91,8%) vem dos fatos novos, não da regra: os mesmos fatos sem os vínculos dão o mesmo número. Diagnóstico datado, não resultado: com as regras como aprovadas, sem endurecer, seriam 84 viáveis · 67 inviáveis · 121 indeterminados.

**O que destrava:** conferir no portal Sayerlack o status dos pedidos 2096768, 2096769, 2096770, 2096771 (reenvios de 22/05) e 2094267 (1015). Cancelados = evidência positiva para ligar; em aberto = compromisso real que a guarda tinha razão de segurar.

### R59 — pedido ENCERRADO no Omie sai do caixa (2026-10-18)

Decisão do founder: corrigir na fonte. Pedido disparado que foi **encerrado no Omie** (cancelado no portal) e **não tem evidência nenhuma de NF** deixa de ser compromisso. Com qualquer NF (no tracking, por vínculo R57/R58 ou de qualquer identificador Sayerlack do pedido, em qualquer data), segue a conciliação normal.

- **De onde vem o sinal.** O encerramento não aparece no cabeçalho do `PesquisarPedCompra` (os pedidos encerrados vêm com `cEtapa="15"`, como os abertos). A `omie-sync-pedidos-compra` (v1.5) faz, depois do completo limpo, uma passada só com `lExibirPedidosEncerrados` ligado e registra o conjunto em `reposicao_encerrados_omie_publicacao`. A coluna `purchase_orders_tracking.encerrado_omie_em` (1 writer) é esse conjunto **quando publicado**.
- **Habilitação.** Até alguém ligar `habilitado` na publicação, a passada só **observa**: grava o conjunto e não toca a coluna.
- **O filtro não é "cancelado" (medido na 1ª publicação, 2026-10-20).** O `lExibirPedidosEncerrados` devolveu **517 de 560** pedidos da janela (92%), e 382 deles têm NF: é o ciclo CONCLUÍDO do Omie, não só o pedido cancelado. O controle positivo passou (1014, 1049 e 1005 dentro) e o negativo também (0 dos 23 pedidos abertos de out/2026 sem NF no conjunto). Mas ser encerrado não basta para sair do caixa. Daí o **R59 v2** (#3176): o candidato (encerrado, com identificador Sayerlack, sem NF) só sai **se aprovado por nome** em `scripts/orcamento-compra/r59-exclusoes-aprovadas.ts`, depois de revisado. Candidato não aprovado fica no caixa e aparece em `pendentesR59`.
- **Pré-voo.** O backtest só roda se a ÚLTIMA tentativa da passada estiver `publicado`, com `habilitado` ligado e de até 48h antes dos fatos. Toda passada abre o registro em `coletando` e, se falhar, se abstiver ou morrer no meio, ele fica `coletando` ou `invalidado`, e a publicação anterior deixa de valer. Observado, invalidado ou velho = sinal ausente, não "nenhum encerrado".
- **De onde o backtest tira o conjunto.** Pedido encerrado = marcado na coluna **e** presente nos `ids` da publicação, uma tabela que cliente não escreve. Escrita manual na coluna sozinha não tira pedido do caixa. Evidência de NF vem de dois exportadores: o da conciliação (com data) e um sem filtro de data e de janela.
- **Só sai do caixa quem tem identificador.** O pedido precisa ter cContrato ou protocolo do portal, e nenhum desses identificadores pode ter NF. Sem identificador, o pedido nunca sai: um substituto refeito à mão (R58) pode ter faturado sem deixar rastro.
- **Resíduo conhecido (premissa).** A varredura completa reescreve o `raw_data` das linhas de pedido e apaga o `itensRecebimento` (medido em 18/10: só 4 de 390 linhas com NF ainda o têm). Uma NF de vários pedidos gravada na linha de OUTRO pedido antes de 18/10 não aparece como evidência. A `recebimento_associacao_sombra` (#3124) fecha isso daqui em diante. Por isso o `resultado.json` lista em `foraDoCaixaR59` cada pedido que o R59 tirou do caixa, para revisar um a um.
- **Look-ahead (premissa).** O sinal é o de **hoje**. `encerrado_omie_em` é quando a passada viu o encerramento, não a data real (o Omie não a expõe). Um ciclo anterior ao encerramento já trata o pedido como fora do caixa, então o backtest fica mais otimista do que a guarda teria sido naquele dia. A continuidade do motor (R54) segue contando o encerrado, o que é conservador.

### Rodada de 2026-10-20 — com o R59 v2 (fatos de 2026-10-20; ciclos de 2026-07-22 a 2026-10-20)

Publicação dos encerrados: seq 155, de 2026-10-20, habilitada. Aprovados (#3183): **1005, 1014 e 1049**, conferidos pelo founder como cancelados na Sayerlack. Pendente: **1230**, atendido total, segue no caixa. O contrafactual "sem R59" usa os mesmos fatos com `encerrado_omie=false` em todo disparado.

| | sem R59 | com R59 v2 |
|---|---|---|
| Estados, todos os 279 ciclos (viável · inviável · indeterminado) | 166 · 74 · 39 | **200 · 70 · 9** |
| Estados, 127 disparados | 72 · 31 · 24 | **92 · 30 · 5** |
| Indeterminados (disparados) por camada | 20 compromisso não conciliado · 4 snapshot | 1 compromisso não conciliado · 4 snapshot |
| Aceito com guarda (motor nos disparados com veredito) | 31,5% | 33,7% |
| Aceito sem guarda (indeterminados, só o gate econômico) | 10,0% do motor | 1,9% do motor |
| Sensibilidade da reserva, disparados (inviáveis · indeterminados) | 15d: 12 · 115 · 30d: 31 · 24 · 45d: 60 · 5 | 15d: 13 · 26 · 30d: 30 · 5 · 45d: 56 · 4 |
| Precisão por episódio (portão) | 89,1%, com 48 classificados e cobertura de 19,2% | igual (o R59 mexe no caixa, não no replay) |

- **Três pedidos destravaram a guarda.** Tirá-los do caixa leva os indeterminados dos disparados de 24 para 5. O compromisso não conciliado cai de 20 ciclos para 1, e os 4 por falta de snapshot não mudam.
- **Inviáveis quase não mudam (31 → 30).** O efeito é dar veredito onde não havia, não fabricar folga.
- **O portão segue FECHADO** (abaixo): precisão 89,1% < 95%, cobertura 19,2% < 50%, 70 ciclos inviáveis e 9 indeterminados.
- **Rodar:** `simular.ts --banco` estourou o `statement_timeout` de 2min do psql-ro com o banco sob carga. Gerar o `fatos.sql` com `set statement_timeout = '10min'` na frente (75–90s) e passar o JSON ao `simular.ts`.

### Rodada de 2026-10-21: horizonte de 60 dias (mesmos fatos de 2026-10-20)

**Decisão do founder (2026-10-21):** a guarda verifica a reserva em **60 dias**, não mais em 91. A reserva continua de 30 dias e o cenário continua sem vendas novas. Foi a opção escolhida de uma grade horizonte × reserva rodada sobre os mesmos fatos:

| Disparados (127) | 91d · reserva 30 | **60d · reserva 30** | 45d · reserva 30 | 91d · reserva 15 |
|---|---|---|---|---|
| viável · inviável · indeterminado | 92 · 30 · 6 | **113 · 9 · 6** | 117 · 5 · 6 | 88 · 13 · 27 |
| Aceito com guarda | 31,8% | **36,2%** | 37,4% | 26,9% |

- **Todos os 279 ciclos:** 250 viáveis · 20 inviáveis · 9 indeterminados (com 91 dias eram 200 · 70 · 9). Indeterminados nos disparados: 1 por compromisso não conciliado e 5 por falta de snapshot, os mesmos de antes.
- **Baixar a reserva piora o veredito.** O limiar do compromisso não conciliado é 10% da reserva: com 15 dias, os indeterminados sobem de 6 para 27.
- **Sensibilidade da reserva com 60 dias** (disparados, inviáveis · indeterminados): 15d 0 · 27 · 30d 9 · 6 · 45d 29 · 5.
- Precisão por episódio 88,8% e cobertura de 19,4%: o portão segue **FECHADO**.

### Caixa indeterminado e cobertura do replay: o t4 que nunca chega (2026-10-21)

- **Os 13 pedidos de maio/junho sem NF estão resolvidos** (psql-ro, 2026-10-20). Dos 36 disparados de maio/junho, 33 têm NF no tracking. Os 3 sem NF (1005, 1014 e 1049) são os cancelados que o R59 v2 tira do caixa. O caixa indeterminado já tinha caído para 9 de 279 na rodada de 2026-10-20.
- **A cobertura de 19% vem do fechamento do estoque, não do caixa.** Os 107 SKUs ruins erram para CIMA: em 431 de 480 fechamentos ruins, o estoque reconstruído fica acima do gravado. O erro anda em degraus. Exemplo: o SKU 12101724100 tem os pedidos 1161 (NF 947706) e 1221 (NF 951654) com NF e **sem t4**, e as 16 unidades somem da reconstrução.
- **Causa na fonte:** o backfill da `omie-sync-nfes-recebidas` grava `nid_receb` antes do recebimento e nunca volta à linha. São 81 linhas OBEN de julho a outubro com NF e sem t4. Correção: PR #3284 (v1.10, a revisita grava o t4 da NF conhecida e recebida). Imputar o t4 (emissão + 7 dias) levou a cobertura de 19,1% para 38,4% e os SKUs ruins de 107 para 90. É experimento, não resultado: o número real sai depois do deploy e do catch-up.
- **Resíduos menores medidos:** a consolidação de demanda por substituição de SKU (`sku_substituicao`, 7 SKUs) põe no SKU novo a venda que baixou o estoque do antigo, cerca de 35 unidades. A malha PCP pesa só 3 dos 108 SKUs ruins.

### Rodada de 2026-10-21 depois do t4 (fatos de 2026-10-21; horizonte de 60 dias)

**Fonte corrigida e catch-up feitos.** A `omie-sync-nfes-recebidas` v1.10 (#3284) está no ar: a sonda atestou às 12:37 UTC, com o hash igual ao da main. O catch-up rodou em duas invocações, ambas com HTTP 200 e `erros=0`:
- janela de 01/06 a 25/09: `t4_preenchidos=75` e `t4_nid_divergente=1`;
- `revisita_dias=30`: `t4_preenchidos=9`.

Linhas OBEN com NF desde junho e sem t4: **86 → 2**. Uma é o pedido 1150, com o nid de outro recebimento, que fica intocado por desenho. A outra é uma órfã que o Omie ainda marca como não recebida. Nenhum t4 ficou antes da emissão ou no futuro, e o lag mediano é de 5 dias. Em 2 NFs o t4 cai às ~21h e o app efetivou na manhã seguinte (1 dia de diferença).

| | antes do t4 (fatos de 20/10) | **depois do t4 (fatos de 21/10)** |
|---|---|---|
| SKUs com fechamento ruim | 107/155 | **90/155** |
| Episódios classificados | 48 | **93** |
| Cobertura por episódio | 19,4% | **38,8%** |
| Precisão por episódio | 88,8% | **82,6%** |
| Estados, 279 ciclos (viável · inviável · indeterminado) | 250 · 20 · 9 | 250 · 17 · 12 |
| Disparados | 113 · 9 · 6 | 113 · 8 · 7 |
| Aceito com guarda | 36,2% | 33,9% |

- **A cobertura bateu com o experimento** de imputação (38,4% previstos).
- **A precisão caiu porque a amostra deixou de ser viesada.** Os 88,8% vinham só dos SKUs cujo estoque fechava. Separando por motivo do corte (episódios dos disparados, `precisaoPorEpisodio` com `cortesDetalhe` filtrado por `motivo`):

  | Episódios por motivo | Precisão | Classificados | Cobertura |
  |---|---|---|---|
  | **econômico** (ΔV ≤ 0) | **94,5%** | 85 | 37,6% |
  | econômico, sem chegada aproximada (R33) | 98,1% | 83 | 44,4% |
  | **financeiro** (guarda de caixa) | **43,8%** | 9 | 52,9% |

  Em valor, dos cortes classificados: econômico R$ 3,1 mil teria rompido contra R$ 75,6 mil adiado ou eliminado; financeiro **R$ 9,7 mil teria rompido contra R$ 7,6 mil adiado**. **O gate econômico funciona. Quem rompe estoque é o corte por caixa:** o que a guarda tira para caber na reserva faz falta depois em mais da metade dos episódios. **Mas o financeiro é praticamente UM ciclo:** todo o R$ 9,7 mil que teria rompido está no ciclo 1277 (23/07), onde a guarda cortou R$ 18,8 mil de 11 SKUs de um mesmo pedido, e 2 deles (8689743956 e 8689776554) romperiam. Os outros 7 ciclos com corte financeiro (23–28/07) somam R$ 9,5 mil, quase tudo indeterminado. Desde 28/07, com o horizonte de 60 dias, a guarda não faz nenhum corte financeiro. É evidência de UM evento, não de um padrão. Decisão pendente do founder, sem urgência porque a guarda quase não corta: o que ela deve fazer quando o caixa não comporta o pedido (cortar, escalar para aprovação humana ou só alertar).
- **Indeterminados:** 9 por falta de snapshot (inclui o ciclo de hoje, cujo snapshot ainda não foi tirado) e 3 por compromisso não conciliado.
- **O portão segue FECHADO.**

### R60: o fechamento do estoque no instante da leitura (2026-10-21)

O `estoque_fisico` que o motor grava é lido **na geração** do ciclo. A spec §7 comparava a reconstrução com o fim de `data − 1`, mas 223 de 279 ciclos são gerados à tarde (a maioria por volta das 17h15 SP), quando o estoque já descontou a venda do próprio dia.

- **Medido (fatos de 2026-10-21):** resíduo entre leituras consecutivas do estoque gravado (Δestoque + demanda − recebimento), com as janelas deslocadas:

  | Deslocamento | −1 dia | 0 (spec) | **+1 dia** | +2 dias |
  |---|---|---|---|---|
  | Σ\|resíduo\| | 845 | 760 | **419** | 786 |
  | Janelas exatas (de 902) | 583 | 583 | **756** | 656 |

  O resíduo líquido vai de 102 para 12. Deslocar os **recebimentos** (t4) para trás ou para a frente piora tudo: o `dRec` está certo.
- **Regra:** ciclo gerado a partir das 12h SP fecha contra o fim do próprio dia; antes disso, contra o fim de `data − 1`. A série de demanda as-of continua até `data − 1` (R22).
- **Efeito (mesmos fatos):** SKUs com fechamento ruim de 90 para **40**/155; cobertura por episódio de 38,8% para **47,5%**; precisão por episódio de 82,6% para 83,6%. Por motivo: **econômico 95,4%** (n=105, cobertura 46,5%) e financeiro 40,6% (n=10, quase tudo o ciclo 1277).
- **Ressalva (viés de seleção do conjunto medido):** os 71 cortes econômicos que a R60 passou a medir (R$ 13,3 mil) têm **zero** rupturas, contra 7,6% dos 343 já medidos. A chance disso por acaso é de cerca de 0,4%. A R60 não usa o resultado do corte (o fechamento compara com o estoque gravado no momento da decisão), mas o conjunto medido **não é aleatório**: os SKUs que fecham tendem a ser os que o corte não rompe. Os 95,4% valem para os 46,5% medidos, e é por isso que o portão exige cobertura ≥ 50%.
- Falsificação: forçar d−1, forçar d, cortar às 13h e vazar o dia `d` na série de demanda deram 4 de 4 vermelhos, com controle verde.
- Hipóteses descartadas nesta rodada: NF de venda sem título no contas a receber (50 de 1.220; tirá-las só leva a cobertura de 38,8% para 39,8%) e o deslocamento do t4.

### R61: o estoque baixa pela venda FÍSICA do próprio SKU (2026-10-21)

A `v_sku_demanda_efetiva` consolida no SKU novo a venda do antigo (`sku_substituicao`) e soma os componentes da malha PCP. Isso está certo para **decidir** a reposição, mas o estoque deste SKU só baixa pela venda **dele mesmo**.

- **Regra:** a reconstrução do estoque e o replay usam a `demanda_fisica` (`venda_items_history` crua). A série da decisão (média, amostras, proteção) continua com a `demanda` efetiva, que é o que o motor enxerga. `demanda_fisica` ausente ou com `qtde` nula reprova o pré-voo.
- **Efeito (fatos de 2026-10-21, com a R60):**

  | | R60 | **R60 + R61** |
  |---|---|---|
  | SKUs com fechamento ruim | 40/155 | **35/155** |
  | Cobertura por episódio | 47,5% | **50,4%** |
  | Precisão por episódio | 83,6% | 84,3% |
  | ↳ econômico | 95,4% (n=105) | **96,2% (n=111, cobertura 49,6%)** |
  | ↳ financeiro | 40,6% (n=10) | 40,0% (n=11) |

- **Viés de seleção:** os 34 cortes econômicos que passaram a ser medidos têm zero rupturas, contra uma taxa de base de 4,1% (17 em 410). O esperado seria cerca de 1,4, e a chance de zero por acaso é de cerca de 24%: nada significativo. Dez cortes já medidos mudaram de classe, porque o replay agora usa a venda física.
- **Falsificação:** reconstruir com a efetiva, desligar os dois pré-voos e a decisão passar a usar a física deram 4 de 4 vermelhos, com controle verde.
- **Os 17 inviáveis e o corte financeiro são a MESMA semana:** todos os inviáveis são ciclos de 23 a 28/07, o aperto de caixa de julho; desde 29/07, todo ciclo com veredito é viável. A janela é de 90 dias, então essa semana sai dela por volta de 27/10. Aí os inviáveis vão a 0 e o acerto geral tende ao do econômico. **Leitura honesta:** o portão abriria porque a semana difícil envelheceu, não porque a guarda provou que lida com aperto de caixa. A decisão sobre o que a guarda faz quando o caixa não comporta o pedido continua de pé.
- **Indeterminados por snapshot (14 a 20/10):** a `fin-cashflow-engine` estourava o tempo lendo `v_titulo_baixas` com os três cenários em paralelo (`acoes_execucoes`: `FalhaLeituraCritica` 57014). Corrigido pela v1.9 (#3252), no ar desde 21/10 às 02:08Z, e o cron de 21/10 rodou 9 de 9. Snapshot não se refaz retroativamente: esses ciclos ficam indeterminados até saírem da janela, por volta de meados de janeiro.
- **Portão: FECHADO**, mas agora só por três critérios: a precisão geral (84,3%, puxada pelo corte financeiro, quase todo o ciclo 1277), os 17 inviáveis e os 12 indeterminados (9 sem snapshot). A cobertura (50,4%) e o volume (120 episódios) já passam.

### R62–R64: decisões do founder sobre a guarda e o portão (2026-10-21)

- **R62 (decisão 2b): num aperto de caixa a guarda não corta, ela ESCALA ao humano.** O pedido aparece como "o caixa não comporta, faltam R$ X", junto com a proposta de corte, e quem decide é o founder. O backtest continua simulando a proposta. A precisão do **portão** passa a medir só os cortes **automáticos** (econômicos), e a dos escalados fica em `resumo.precisaoEpisodiosEscalados`, informativa. Motivo medido: o corte econômico acerta 96,2%; o corte por caixa acertou 40% (n=11, quase todo o ciclo 1277, 23/07).
- **R63 (decisão 3b): sai do portão o indeterminado SÓ por snapshot cujo job de snapshot registrou erro no dia do ciclo ou na véspera** (`acoes_execucoes`, `fin_cashflow.snapshot_diario`, status `erro`) **e** cujo snapshot pessimista da Oben não existe. Hoje são os dias 14, 16, 17, 19 e 20/10 (timeout de `v_titulo_baixas`, corrigido no #3252). Dia sem snapshot e sem registro de erro (28/07, 17/09, 11/10) **não** sai: sem evidência, fail-closed. Os excluídos ficam listados em `resumo.excluidosPortao` e continuam contados em `estados`.
- **R64: o pré-voo recusa a rodada com NF efetivada nas últimas 30h sem t4 no tracking.** A reconstrução ancora no estoque de AGORA. Uma entrada que já está no estoque, mas cujo t4 só chega na revisita das 04:15 UTC, quebra o fechamento de todo ciclo anterior do SKU. Medido: os fatos das 17:55 UTC de 21/10, depois de 2 NFs efetivadas à tarde, deram 60 SKUs com fechamento ruim, contra 35 às 15:54 UTC. **Rode o backtest depois das 04:15 UTC e antes dos recebimentos do dia.**
- **Resíduo conhecido:** 3 NFs efetivadas em 15 e 16/10 **nunca entraram no tracking** (Sayerlack 000132472 e 000132477, de outra série; e uma pessoa física). São entradas de estoque que a reconstrução não vê.
- **Rodada (fatos de 2026-10-21 15:54 UTC, R60–R63):** precisão dos automáticos **96,2%** (n=111) ✅ · cobertura **49,6%** · 17 inviáveis (23 a 28/07) · **3** indeterminados (compromisso não conciliado; 9 excluídos pela R63). Portão: `FECHADO: cobertura 49,6% < 50% · 17 inviáveis · 3 indeterminados`. Os inviáveis saem da janela por volta de 27/10.

### Rodada OFICIAL pós-julho (fatos de 2026-10-28 23:51 UTC; ciclos de 30/07 a 28/10; main com R60–R64, sem R65)

Pré-voo limpo: `recebimentos_sem_t4=[]`, e `falhas_snapshot` com os 5 dias de 14 a 20/10.

| Critério | Valor | |
|---|---|---|
| Precisão por episódio (cortes automáticos) | **99,0%** (n=126) | ✅ |
| Cobertura | **51,0%** | ✅ |
| Inviáveis | **0** (a semana de 23 a 28/07 saiu da janela) | ✅ |
| Indeterminados | **81** (9 excluídos pela R63) | ❌ |

`avaliarPortao` e o jq concordam: **FECHADO, 81 ciclos indeterminados**. Escalados (R62): nenhum episódio.

**Por que 81 indeterminados, todos `compromisso_nao_conciliado`, de 05/10 em diante.** O código não mudou: o código da main de 21/10 dá o mesmo resultado sobre estes fatos. O que muda é o dado. No ciclo de 02/10 o não conciliado é de R$ 9,8 mil; no de 05/10, de **R$ 23,1 mil**, acima do limiar de R$ 22,6 mil (10% da reserva). No mesmo intervalo, os títulos Sayerlack representados na foto de caixa caem de 5 para 3. A causa é a **NF 951810** (R$ 28,8 mil; pedidos 2661, 2662 e 2763): ela **venceu em 30/09 e só foi paga em 23/10**. Vencida e sem pagamento, ficou fora da foto de caixa, e pela R35 título fora da projeção não desconta o compromisso. Somam-se resíduos antigos: o pedido 69 (R$ 26,7 mil contra uma NF de R$ 9,6 mil, entrega parcial de maio) e a **NF 945097 (R$ 10,8 mil, ATRASADO desde 31/07 e ainda sem baixa)**.

**Leitura:** o fail-closed está certo. Uma dívida vencida e não paga que não aparece na projeção é um compromisso real que a guarda não consegue reconciliar. Esses ciclos saem da janela por volta de 03/01/2027. Duas perguntas para o founder:
1. A **NF 945097 está mesmo em aberto**, ou o pagamento não chegou ao CP? Se foi paga, é falha de sync e a correção é na fonte.
2. A projeção pessimista **deve carregar título vencido e não pago** como saída imediata? Hoje ela o perde, o que deixa o caixa otimista justamente quando há atraso.

### Conferências de sanidade

- `nDisparados` = 119; nenhum pai `split_em_filhos` na janela (R45 sem efeito nesta rodada, coberto por teste) ✅
- `valorMotorDisparados` igual à rodada R31 ao centavo (o universo de ciclos disparados não mudou) ✅
- Fatos novos: 426 ids de título Sayerlack (R34), 122 títulos na janela (110 com baixa, R35), 268 chegadas de pedido (57 com t4, R33), linhas de lag 381 faturamento / 128 vencimento / 299 chegada (R39), 176 disparados desde 2026-04-30 (R38).
- Nenhuma semana de snapshot tem `total_saidas` diferente do detalhe (R42 sem efeito nesta rodada, coberto por teste).
- Fechamento do estoque reconstruído: 107 de 153 SKUs com erro de fechamento em ao menos um ciclo. **Limitação, não escondida:** o replay desses SKUs vira `indeterminado`, e por isso a cobertura é baixa.

### R28 + R30 — compromisso "a faturar"

Um pedido disparado entra inteiro (× 1,025, R41) na camada `compromisso_a_faturar` quando, com menos de 15 dias (p90 pedido→faturamento), está **sem NF** (R28) ou tem **NF sem título descontável até o snapshot** (R30/R35). Essa camada não conta no limiar de 10% da reserva. Os mesmos casos com 15 dias ou mais são `compromisso_nao_conciliado`.

R35: um título só desconta o compromisso se está **representado no snapshot** (id na lista de saídas) ou foi **liquidado antes do dia do snapshot**. Título existente no CP, vencido e fora da projeção, não desconta.

### R29 — por que havia 61 inviáveis (diagnóstico datado 2026-10-15, não recalculado)

Na rodada R31, a base de caixa sozinha, sem nenhuma candidata, já furava a reserva em todos os 61 inviáveis (mediana de 72 dias até a 1ª violação). Exemplo do ciclo 1239 (20/07): a reserva era ~82% do saldo e, em 91 dias, continuidade do motor + saídas não-Sayerlack somavam ~3,6× os títulos a receber.

## O que o backtest diz sobre o cenário-guarda

- **Desde 2026-10-20 a guarda dá veredito** em 270 de 279 ciclos (R59 v2 e os 13 pedidos resolvidos, acima).
- **Quando a base sozinha fura a reserva**, a condição de reserva **como especificada** reprova o ciclo qualquer que seja o pedido, e por isso não serve para decidir compras. Com 91 dias, isso acontecia em 30 dos 127 disparados.

**Decidido (2026-10-21):** encurtar o horizonte para 60 dias (rodada acima). Ficaram de fora o cenário de entrada de vendas (não implementado) e baixar a reserva (que aumenta os indeterminados).

## Portão da v2 (re-executável — não é recado)

**Aplicar no app só se TODOS passarem** (R31 + R36 + R47):
- precisão **por episódio** ≥ 95%;
- ≥ 30 episódios classificados;
- **cobertura ≥ 50%** (classificados ÷ episódios efetivos);
- **zero** ciclo inviável;
- **zero** ciclo indeterminado (sem veredito de caixa não há prova de viabilidade);
- campo ausente ou não numérico **fecha** (resultado.json antigo nunca abre).

Inviáveis "explicados" **não** abrem o portão. Só uma decisão do founder sobre o cenário-guarda pode mudar esse critério. Rode o passo 1 de "Como rodar" e então (a fonte da verdade é `avaliarPortao` em `scripts/orcamento-compra/pagina.ts`; o `jq` repete os limiares):

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
R=docs/superpowers/orcamento-compra/saida/resultado.json
jq -r '
  def num: if type == "number" and isnormal or . == 0 then . else null end;
  .resumo as $r | ([.ciclos[] | select(.estado.tipo == "inviavel")] | length) as $inv
  | ([.ciclos[] | select(.estado.tipo == "indeterminado" and (.exclusaoPortao // null) == null)] | length) as $ind  # R63
  | [ (if (($r.precisaoEpisodios.precisao | num) // -1) < 0.95 then "precisão por episódio \($r.precisaoEpisodios.precisao) < 0.95" else empty end),
      (if (($r.precisaoEpisodios.n | num) // -1) < 30 then "\($r.precisaoEpisodios.n) episódios classificados < 30" else empty end),
      (if (($r.coberturaEpisodios | num) // -1) < 0.5 then "cobertura insuficiente: \($r.coberturaEpisodios) < 0.5" else empty end),
      (if $inv > 0 then "\($inv) ciclos inviáveis" else empty end),
      (if $ind > 0 then "\($ind) ciclos indeterminados" else empty end) ]
  | if length == 0 then "ABERTO" else "FECHADO: " + join(" · ") end' "$R" > /tmp/oc-portao.txt; rc=$?
cat /tmp/oc-portao.txt; [ "$rc" -eq 0 ] && grep -qx 'ABERTO' /tmp/oc-portao.txt   # exit 0 = portão aberto
```

**Estado em 2026-10-20 (R59 v2):** portão **FECHADO** por precisão (89,1%), cobertura (19,2%), 70 inviáveis e 9 indeterminados — o R59 tirou 30 indeterminados, mas não mexe nos outros três motivos.

**Estado em 2026-10-15 (após a onda final R32–R53): portão FECHADO**, pelo comando acima e pela página, com quatro motivos:
- **precisão por episódio 84,9%** < 95%: o replay conjunto (R32) na chegada real (R33) achou ruptura que o replay por embalagem escondia;
- **cobertura insuficiente:** só 41 de 215 episódios (19,1%) classificam;
- **4 ciclos inviáveis;**
- **264 ciclos indeterminados:** 262 por compromisso não conciliado, puxados pelos 13 pedidos de maio/junho sem NF (decisão do founder, acima).
