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
- **Habilitação.** Que o filtro sozinho devolve só encerrados ainda é hipótese. Até alguém ligar `habilitado` na publicação, a passada só **observa**: grava o conjunto e não toca a coluna. Antes de habilitar, confira no conjunto observado o controle positivo (1014 e 1049 dentro) e o negativo (um pedido aberto de out/2026 fora).
- **Pré-voo.** O backtest só roda se a ÚLTIMA tentativa da passada estiver `publicado`, com `habilitado` ligado e de até 48h antes dos fatos. Toda passada abre o registro em `coletando` e, se falhar, se abstiver ou morrer no meio, ele fica `coletando` ou `invalidado`, e a publicação anterior deixa de valer. Observado, invalidado ou velho = sinal ausente, não "nenhum encerrado".
- **De onde o backtest tira o conjunto.** Pedido encerrado = marcado na coluna **e** presente nos `ids` da publicação, uma tabela que cliente não escreve. Escrita manual na coluna sozinha não tira pedido do caixa. Evidência de NF vem de dois exportadores: o da conciliação (com data) e um sem filtro de data e de janela.
- **Só sai do caixa quem tem identificador.** O pedido precisa ter cContrato ou protocolo do portal, e nenhum desses identificadores pode ter NF. Sem identificador, o pedido nunca sai: um substituto refeito à mão (R58) pode ter faturado sem deixar rastro.
- **Resíduo conhecido (premissa).** A varredura completa reescreve o `raw_data` das linhas de pedido e apaga o `itensRecebimento` (medido em 18/10: só 4 de 390 linhas com NF ainda o têm). Uma NF de vários pedidos gravada na linha de OUTRO pedido antes de 18/10 não aparece como evidência. A `recebimento_associacao_sombra` (#3124) fecha isso daqui em diante. Por isso o `resultado.json` lista em `foraDoCaixaR59` cada pedido que o R59 tirou do caixa, para revisar um a um.
- **Look-ahead (premissa).** O sinal é o de **hoje**. `encerrado_omie_em` é quando a passada viu o encerramento, não a data real (o Omie não a expõe). Um ciclo anterior ao encerramento já trata o pedido como fora do caixa, então o backtest fica mais otimista do que a guarda teria sido naquele dia. A continuidade do motor (R54) segue contando o encerrado, o que é conservador.

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

- **Hoje a guarda quase não dá veredito:** 264 dos 268 ciclos são indeterminados, 262 deles por compromisso não conciliado. A primeira decisão é sobre os 13 pedidos de maio/junho sem NF (acima).
- **Quando dava veredito (rodada R31), a base sozinha furava a reserva** em julho e parte de agosto. Nesse caso a condição de reserva **como especificada** reprova o ciclo qualquer que seja o pedido, e por isso não serve para decidir compras.

A próxima decisão é do founder. Primeiro os 13 pedidos sem NF; depois, entre três caminhos para o cenário-guarda (sem ordem de preferência):

1. **Calibrar um cenário de entrada de vendas:** substituir o "zero venda nova" por uma entrada conservadora medida.
2. **Encurtar o horizonte:** verificar a reserva numa janela menor que 91 dias.
3. **Baixar a reserva:** exigir menos que 30 dias de saídas.

### Leitura (o que NÃO concluir)

- **A precisão de 84,9% cobre só 19,1% dos episódios.** Ruptura em período censurado vira indeterminado por construção. A amostra é enviesada para SKUs que fecham o estoque e não romperam de verdade. Não ler como "o corte rompe em 15% dos casos" nem como "rompe pouco".
- **"Econômico" domina o corte** porque o intervalo de oportunidade é 1 dia (premissa R49). A embalagem marginal só compra 1 dia de cobertura extra e perde para o custo de carregamento.
- **Sem score não é corte do orçamento** (R48). Ele é revisão humana: entra no replay (conservador), mas não no valor cortado nem na precisão.

## Falsificação (2026-10-15, refeita após a onda final R32–R53)

Regras do laço:
- Uma camada por vez.
- Controle verde **antes e depois** na mesma invocação.
- Confere que o `sed` casou (`git diff` não vazio).
- Restaura com `git checkout --`.

Rodado com `LC_ALL=C` e `LC_ALL=pt_BR.UTF-8`: **12/12 vermelho nos dois** (24/24), `git status` limpo ao fim.

Para refazer, rode, para cada linha da tabela abaixo:
1. `bun run test -- <teste>` (tem de dar verde);
2. `sed -i '' '<sed>' <arquivo>`;
3. `bun run test -- <teste>` (tem de dar vermelho);
4. `git checkout -- <arquivo>`;
5. `bun run test -- <teste>` (verde de novo).

`M/` = `src/lib/reposicao/orcamento-compra/`; `S/` = `scripts/orcamento-compra/`.

| # | Intenção | Arquivo | `sed` | Teste | Resultado |
|---|---|---|---|---|---|
| 1 | conciliação sem descontar título | `M/camadas.ts` | `s/const residuo = c.valor - titulado;/const residuo = c.valor;/` | `M/caixa.test.ts` | 5 failed / 28 |
| 2 | avaliarEstado sem violação | `M/caixa.ts` | `s/if (primeiraViolacao === null && p.saldo < reserva)/if (false)/` | `M/caixa.test.ts` | 2 failed / 28 |
| 3 | corte sem checar caixa | `M/corte.ts` | `s/if (!temAnterior(c) \|\| !cabe(\[fluxoDe(c)\]))/if (!temAnterior(c))/` | `M/corte.test.ts` | 3 failed / 27 |
| 4 | atendidas sem backlog | `M/valor.ts` | `s/return Math.min(Q, backlog) + /return /` | `M/valor.test.ts` | 2 failed / 12 |
| 5 | classificarCorte sem `teria_rompido` | `M/replay.ts` | `s/  if (sem.unidadesPerdidas > com.unidadesPerdidas + 1e-9) return 'teria_rompido';//` | `M/replay.test.ts` | 2 failed / 21 |
| 6 | R28/R30: nunca "a faturar" | `M/camadas.ts` | `s/const aFaturar = semComprovacao && diffDias(c.data, inicio) < idadeLimiteDias;/const aFaturar = false;/` | `M/caixa.test.ts` | 3 failed / 28 |
| 7 | R30: só pedido sem NF pode ser "a faturar" | `M/camadas.ts` | `s/const aFaturar = semComprovacao && /const aFaturar = c.nfs.size === 0 \&\& /` | `M/caixa.test.ts` | 1 failed / 28 |
| 8 | R32: replay de uma embalagem só | `S/simular.ts` | `s/const qtde = doSku.reduce((s, x) => s + x.c.qtde, 0);/const qtde = doSku[0].c.qtde;/` | `S/simular.test.ts` | 3 failed / 56 |
| 9 | R35: título fora da base desconta | `S/simular.ts` | `s/^    return 0;$/    return valor;/` | `S/simular.test.ts` | 1 failed / 56 |
| 10 | R36: indeterminado não fecha o portão | `S/pagina.ts` | `s/if (indeterminados > PORTAO.indeterminadosMax)/if (false)/` | `S/pagina.test.ts` | 2 failed / 13 |
| 11 | R40: continuidade cumulativa | `M/corte.ts` | `s/lagDias, aceito)\]/lagDias, 0)]/` | `M/corte.test.ts` | 2 failed / 27 |
| 12 | R47: `n` NaN passa no portão | `S/pagina.ts` | `s/if (!finito(pe?.n) \|\| pe.n < PORTAO.nMin)/if (pe.n < PORTAO.nMin)/` | `S/pagina.test.ts` | 1 failed / 13 |

(Na tabela, `\|` é o `|` escapado do Markdown: no shell o `sed` usa `|` literal.)

## Perguntas abertas (spec §10)

1. **Mínimo da Sayerlack**: por pedido no portal ou por NF? Qual valor? (a v1 simula com mínimo = 0, i.e. não modelado).
2. Tabela Sayerlack 28/42/56d (encargo, parcela única/parcelado, desconto de 2%) — não usada na v1; registrada para a v2.
3. O CP Sayerlack liquidado fica ~33% acima da compra disparada pelo motor (por mês): compras fora do motor? O backtest só mede o que passa pelo motor; o caixa usa o CP real.

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
  | ([.ciclos[] | select(.estado.tipo == "indeterminado")] | length) as $ind
  | [ (if (($r.precisaoEpisodios.precisao | num) // -1) < 0.95 then "precisão por episódio \($r.precisaoEpisodios.precisao) < 0.95" else empty end),
      (if (($r.precisaoEpisodios.n | num) // -1) < 30 then "\($r.precisaoEpisodios.n) episódios classificados < 30" else empty end),
      (if (($r.coberturaEpisodios | num) // -1) < 0.5 then "cobertura insuficiente: \($r.coberturaEpisodios) < 0.5" else empty end),
      (if $inv > 0 then "\($inv) ciclos inviáveis" else empty end),
      (if $ind > 0 then "\($ind) ciclos indeterminados" else empty end) ]
  | if length == 0 then "ABERTO" else "FECHADO: " + join(" · ") end' "$R" > /tmp/oc-portao.txt; rc=$?
cat /tmp/oc-portao.txt; [ "$rc" -eq 0 ] && grep -qx 'ABERTO' /tmp/oc-portao.txt   # exit 0 = portão aberto
```

**Estado em 2026-10-15 (após a onda final R32–R53): portão FECHADO**, pelo comando acima e pela página, com quatro motivos:
- **precisão por episódio 84,9%** < 95%: o replay conjunto (R32) na chegada real (R33) achou ruptura que o replay por embalagem escondia;
- **cobertura insuficiente:** só 41 de 215 episódios (19,1%) classificam;
- **4 ciclos inviáveis;**
- **264 ciclos indeterminados:** 262 por compromisso não conciliado, puxados pelos 13 pedidos de maio/junho sem NF (decisão do founder, acima).
