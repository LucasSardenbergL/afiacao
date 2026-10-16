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
bun scripts/orcamento-compra/pagina.ts docs/superpowers/orcamento-compra/saida/resultado.json docs/superpowers/orcamento-compra/index.html > /tmp/oc-pag.log 2>&1; rc=$?
tail -1 /tmp/oc-pag.log; [ "$rc" -eq 0 ]   # esperado: fim|ok
```

## Resultado da rodada de 2026-10-15, após R28+R30 (fatos de hoje = 2026-10-15; janela 2026-07-18..2026-10-15)

| Medida | Valor |
|---|---|
| Ciclos / disparados | 267 / 118 (+140 expirados, 7 cancelados, 2 pendentes) |
| Motor pediu (disparados, com frete 2,5%) | R$ 376.171 |
| Orçamento aceitaria (disparados) | R$ 119.273 (31,7%) |
| Cortes nos disparados por motivo | econômico R$ 167.776 · financeiro R$ 57.550 · sem score R$ 31.571 |
| Valor cortado efetivo / expirado (dedup. por episódio) | R$ 198.812 / R$ 155.344 |
| Cortes sem preço | 58 |
| Episódios de corte (efetivos, dedup. 7d) | 267 |
| Precisão do corte | 100,0% — n = 160 cortes classificados, **919 indeterminados** (de 1.079); valor classificado R$ 43.044 |
| Classes dos cortes classificados | adiado 112 · eliminado 48 · teria_rompido 0 |
| ΔDIO / caixa liberado | 1,12 dia / R$ 5.304 — só 24 episódios medidos (106 sem horizonte de 30d, 137 indeterminados) |
| CMV diário do universo do motor | R$ 4.756 |
| Embalagens sensíveis ao modelo (sinal de ΔV muda empírico × gaussiano) | 600 |
| Estados de caixa (todos os ciclos) | viável 203 · inviável 61 · indeterminado 3 (disparados: 92 · 23 · 3) |
| Indeterminado por camada | snapshot 2 (2026-10-15, snapshot do dia ainda não tirado) · compromisso_nao_conciliado 1 (2026-08-25) |
| Inviáveis por mês | julho 40 de 40 · agosto 21 de 89 · setembro 0 de 86 · outubro 0 de 52 |
| Sensibilidade (disparados) | 15d: R$ 134.333, 8 inviáveis · 30d: R$ 119.273, 23 inviáveis · 45d: R$ 101.714, 53 inviáveis |

### Conferências de sanidade

- `nDisparados` = 118 (esperado ≈ 120, contagem só Sayerlack) ✅
- `valorMotorDisparados` = R$ 376.171,13 = Σ `valor_total` dos 118 ciclos disparados (R$ 366.996,23) × 1,025 → divergência **0,00%** ✅ (sem JOIN duplicando, sem split contado 2×).
- Fechamento do estoque reconstruído: **107 de 152 SKUs (70%) com erro de fechamento** em ao menos um ciclo (|reconstruído − estoque_fisico gravado| > max(passo, 10%)); por linha, 548 de 1.032 fecham. O erro é majoritariamente positivo (reconstruído > gravado; mediana +1 un, p90 +10 un). Pelo critério do brief (estoque reconstruído < 0 em algum dia de 270d), são 13/152 (8,6%). **Limitação, não escondida:** passa de 30% pelo critério de fechamento. O replay desses SKUs vira `indeterminado`, e por isso 85% dos cortes não classificam.

### R28 + R30 — compromisso "a faturar"

Um pedido disparado entra inteiro na camada `compromisso_a_faturar` quando, com menos de 15 dias (p90 pedido→faturamento):
- está **sem NF** (R28); ou
- tem **NF sem título no CP até o snapshot do ciclo** (R30).

Essa camada **não** conta no limiar de 10% da reserva que torna o ciclo indeterminado. Os mesmos casos com 15 dias ou mais continuam `compromisso_nao_conciliado`.

Motivo do R30: `disparados.nfs` é a lista de NFs de HOJE (olhar adiante). Uma NF recente sem título as-of significa apenas "ainda não titulada". No diagnóstico, todos os pedidos nessa situação tinham menos de 15 dias, e o título existia hoje.

Efeito medido nos indeterminados: só o R28 levou de 232 para 230; com o R30, foram para **3**. O caixa passou a dar veredito, e com isso apareceram os inviáveis que o indeterminado mascarava: 13 → 61.

### R29 — por que há ciclos inviáveis

A causa é **aperto real de caixa no cenário-guarda**, não um artefato de borda de janela.

- **Janelas completas:** todas as janelas de lookback estão completas.
  - Pagos não-Sayerlack: desde 2025-12-22, e a janela da reserva do 1º ciclo começa em 2026-01-19.
  - Títulos Sayerlack: desde 2026-01-19.
  - Disparados: desde 2026-04-30, quando o motor começou; a consulta corta em hoje−180.
  - Snapshots: diários desde 2026-07-13.
- **A base sozinha fura a reserva:** nos 61 inviáveis, a base de caixa sem nenhuma candidata já fura a reserva. A 1ª violação vem de 4 a 90 dias à frente, mediana de 72.

| Ciclo | Saldo inicial | Reserva 30d | Piso da base (data) | 1ª violação | 3 maiores camadas até o piso |
|---|---|---|---|---|---|
| 1239 (2026-07-20, disparado) | R$ 355k | R$ 291k | R$ 57k (10-18) | 09-09 | continuidade do motor −R$ 199k · saídas não-Sayerlack −R$ 190k · compromisso não conciliado −R$ 16k (títulos da base: +R$ 108k) |
| 1259 (2026-07-22, disparado) | R$ 354k | R$ 289k | R$ 57k (10-20) | 09-11 | continuidade −R$ 205k · saídas não-Sayerlack −R$ 205k · não conciliado −R$ 19k (base: +R$ 134k) |

(Diagnóstico por camada medido antes do R30; nele o "não conciliado" de ~R$ 16–21k agora é "a faturar", com o mesmo valor no caixa.)

## O que o backtest diz sobre o cenário-guarda

- **Como a guarda funciona:** sem nenhuma venda nova, ela olha **91 dias** à frente e exige que o saldo fique acima de **30 dias de saídas** em todos os dias.
- **Quantos ciclos ela reprova:** nesta rodada, **61 de 267 ciclos (23%)** ficaram inviáveis, todos de 2026-07-18 a 2026-08-23. Foram todo o mês de julho e 21 dos 89 ciclos de agosto. Setembro e outubro ficaram viáveis, com saldo mais folgado.
  - Nos 23 disparados inviáveis, o motor pediu R$ 62.472 e a guarda aceitaria R$ 956. Corta tudo o que não é protegido.
- **O veredito não depende da compra:** em todos os inviáveis, a base sozinha já fura a reserva (tabela do R29).
  - Exemplo do ciclo de 20/07: o saldo de R$ 355k tem folga de só R$ 65k sobre a reserva.
  - Em 91 dias saem ~R$ 390k (continuidade do motor + saídas não-Sayerlack) e entram só ~R$ 108k de títulos já emitidos.

**Conclusão:** quando o saldo está perto da reserva, a condição de reserva **como especificada é estrita demais para decidir compras**. Ela reprova o ciclo independentemente do pedido. **O portão da v2 continua FECHADO.**

A próxima decisão é do founder, entre três caminhos (sem ordem de preferência):

1. **Calibrar um cenário de entrada de vendas:** substituir o "zero venda nova" por uma entrada conservadora medida, por exemplo um percentil baixo do recebimento histórico.
2. **Encurtar o horizonte:** verificar a reserva numa janela menor que 91 dias, mais próxima do ciclo pedido → pagamento.
3. **Baixar a reserva:** exigir menos que 30 dias de saídas. Na sensibilidade, 15 dias deixam 8 inviáveis entre os disparados e 45 dias deixam 53.

### Leitura (o que NÃO concluir)

- **Precisão 100% é sobre amostra enviesada:** só classifica corte cujo SKU fecha o estoque e cuja série pós-decisão não tem dia censurado (estoque ≤ 0). SKUs que de fato romperam caem em `indeterminado` por construção. Não ler como "o corte nunca causa ruptura".
- **"Econômico" domina o corte** porque o intervalo de oportunidade é 1 dia (o motor roda diariamente): a embalagem marginal só "compra" um dia de cobertura extra e perde para o custo de carregamento. A classe `adiado` (112) > `eliminado` (48) é coerente com isso.

## Falsificação (2026-10-15, refeita após R30)

Uma camada por vez; controle verde ANTES e DEPOIS na mesma invocação; confere que o `sed` casou (`git diff` não vazio); restaura com `git checkout --`. Rodado com `LC_ALL` vazio, `LC_ALL=pt_BR.UTF-8` e `LC_ALL=C`: **7/7 vermelho nos três**, `git status` limpo ao fim.

| Sabotagem (intenção) | Arquivo / teste | Resultado (idêntico nos 3 ambientes) |
|---|---|---|
| conciliação sem descontar título (`residuo = c.valor`) | `camadas.ts` / `caixa.test.ts` | vermelho: 5 failed / 27 |
| avaliarEstado sem violação (`if (false)`) | `caixa.ts` / `caixa.test.ts` | vermelho: 2 failed / 27 |
| corte sem checar caixa (`!cabe(...)` removido) | `corte.ts` / `corte.test.ts` | vermelho: 3 failed / 22 |
| atendidas sem backlog (`Math.min(Q, backlog) +` removido) | `valor.ts` / `valor.test.ts` | vermelho: 2 failed / 10 |
| classificarCorte sem `teria_rompido` | `replay.ts` / `replay.test.ts` | vermelho: 2 failed / 21 |
| R28/R30: nunca "a faturar" (`aFaturar = false`) | `camadas.ts` / `caixa.test.ts` | vermelho: 3 failed / 27 |
| R30: só pedido sem NF pode ser "a faturar" (`semComprovacao` → `c.nfs.size === 0`) | `camadas.ts` / `caixa.test.ts` | vermelho: 1 failed / 27 |

## Perguntas abertas (spec §10)

1. **Mínimo da Sayerlack**: por pedido no portal ou por NF? Qual valor? (a v1 simula com mínimo = R$ 0, i.e. não modelado).
2. Tabela Sayerlack 28/42/56d (encargo, parcela única/parcelado, desconto de 2%) — não usada na v1; registrada para a v2.
3. ~R$ 33k/mês entre CP Sayerlack liquidado (~R$ 133k) e compra disparada pelo motor (~R$ 100k): compras fora do motor? O backtest só mede o que passa pelo motor; o caixa usa o CP real.

## Portão da v2 (re-executável — não é recado)

**Aplicar no app só se:** precisão do corte ≥ 95% com n ≥ 30 episódios efetivos **e** zero ciclo inviável não explicado. Rode o passo 1 de "Como rodar" e então:

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
R=docs/superpowers/orcamento-compra/saida/resultado.json
jq -e '.resumo as $r | ($r.precisao.precisao != null and $r.precisao.precisao >= 0.95 and $r.precisao.n >= 30 and $r.episodios >= 30)' "$R" > /dev/null; rc_precisao=$?
jq -r '.ciclos[] | select(.estado.tipo=="inviavel") | [.data, .status, .estado.primeiraViolacao, (.estado.deficitMax|floor)] | @tsv' "$R" > /tmp/oc-inviaveis.tsv
wc -l < /tmp/oc-inviaveis.tsv   # cada linha precisa de explicação escrita aqui antes de abrir a v2
[ "$rc_precisao" -eq 0 ] && [ ! -s /tmp/oc-inviaveis.tsv ]   # exit 0 = portão aberto
```

**Estado em 2026-10-15 (após R28+R30): portão FECHADO** (comando acima: `rc_precisao=0`, 61 inviáveis → exit 1).
- A parte de precisão passa: 100%, n = 160, 267 episódios.
- Os 61 inviáveis são estruturais do cenário-guarda (ver "O que o backtest diz sobre o cenário-guarda"); a decisão de calibragem é do founder.
- A precisão vem de uma amostra enviesada: 85% dos cortes indeterminados e 70% dos SKUs com fechamento ruim.
