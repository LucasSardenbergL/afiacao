# Cota medida em tokens — a unidade que eu sabia ler, não a unidade em que o recurso é cobrado

> **A classe (2026-09-18):** medir um recurso escasso na unidade VISÍVEL (tokens, linhas, bytes,
> requisições) quando a unidade COBRADA é outra — e o medidor da unidade certa estava no mesmo
> arquivo que eu já tinha aberto. Não é falta de dado nem de rigor: a análise foi cuidadosa,
> reproduzível e **numericamente correta na unidade errada**. Por isso o erro não se anuncia — ele
> chega como conclusão bem fundamentada, com tabela e tudo.
>
> A regra que fica: **antes de otimizar um recurso limitado, ache o medidor que o PROVEDOR usa para
> dizer "acabou".** Se existe um número que decide o corte, é nele que se mede — nunca num proxy que
> você deduziu. E o proxy não avisa que é proxy: aqui ele inverteu o sinal da recomendação.

Parente do *"ausente ≠ zero"* e do *"validação só conta com evidência positiva"*, mas num eixo novo:
lá o defeito é **não ter o dado**; aqui o dado estava presente, abundante e **errado para a pergunta**.

---

## O que aconteceu

O founder perguntou por que a cota do Codex acabava rápido. Medi 174 sessões de setembro a partir de
`~/.codex/sessions/**/rollout-*.jsonl`, somando `total_token_usage`. O método era sólido — o próprio
revisor confirmou depois que `total_token_usage` nunca decresce (0 quedas em 1.766 arquivos) e que o
total de 229M reproduzia. **E a conclusão estava invertida.**

| | tokens por consulta (mediana) | cota por 1M tokens |
|---|---|---|
| `gpt-5.6-sol` · agosto | 2.171.405 | **~0,45 pp** |
| `gpt-6-astra`/`max` · set 05+ | 783.099 (**−3x**) | **~3,3 pp (até 5,63)** |

Em tokens o modelo novo é 3x mais barato. Em **cota** é ~6x mais caro por token — líquido, cada
consulta ficou mais cara. A prova que dispensa modelo:

> **21/08 — 83,1M tokens = 45% da cota**  ·  **10/09 — 18,1M tokens = 102% da cota**
> *4,6x menos tokens, 2,3x mais cota.*

A recomendação que quase saiu para o founder era **"não rebaixe o reasoning, ele é mais barato"** —
que trancava o regime mais caro. Segundo erro da mesma família: comecei a série em 01/08, e a janela
de 03/08 apareceu com 3 worktrees; incluindo julho já eram 18. Desse artefato saiu um "crescimento de
17x da frota" que **some** quando o baseline é honesto — tokens por janela de 7 dias estão flat
desde agosto. Duas conclusões, mesma causa: a régua.

## O medidor que estava no mesmo arquivo

```json
"rate_limits":{"primary":{"used_percent":94.0,"window_minutes":10080,"resets_at":1789834903}}
```

`window_minutes` 10080 = 7 dias = a janela rolante do plano. E `resets_at` 1789834903 → **19/09
13:21:43**, idêntico ao `try again at Sep 19th, 2026 1:21 PM` que o servidor devolve no 429. Estava
em 174 das 174 sessões que eu já havia lido linha a linha. Eu grepei os mesmos arquivos atrás de
`total_token_usage` e passei por cima de `used_percent` em cada um deles.

**O que custou:** a cota bateu 100% em **14/09 19:40** e só reabriu **19/09 13:21**. No meio,
**36 chamadas mortas** (10/09: 18 · 11/09: 4 · 14/09: 11 · 15/09: 1 · 18/09: 2) — cada uma um ritual
que não aconteceu. E o silêncio de 16–17/09 nos rollouts, que eu li como "dados faltando", era a
parede.

## Como o erro foi pego

Pelo ritual de 2ª opinião — mas com o **Fable 5.1**, não com o Codex (pedir ao Codex uma opinião
sobre a cota do Codex gastaria a cota em questão). O que fez a revisão morder não foi o modelo: foi o
prompt ter entregue **o caminho dos dados brutos** junto das conclusões, com a instrução explícita de
não acreditar nos números e re-medir. Revisor sem acesso ao substrato só consegue concordar.

## A lição de 2ª ordem: o sensor cego na hora exata

O sensor construído a partir disso (`scripts/codex-async.sh`, exit 79) nasceu com um ponto cego que
**só o teste ao vivo pegou** — a suíte sintética passava: a sessão que BATE na parede não recebe
medidor nenhum, porque o 429 vem antes. Com a cota estourada, os rollouts mais recentes são todos
falhas: **0 dos 5 últimos** tinham leitura; dos 40, 27. Lendo só os 5 últimos, o sensor respondia
"desconhecido" exatamente na situação para a qual foi feito.

É o padrão de *sonda que emudece justo quando o alarme importa* — e a defesa não foi olhar mais
fundo por chute, e sim uma propriedade do dado: ~~enquanto `resets_at` está no futuro a janela é a
mesma, e dentro de uma janela o consumo só sobe ⇒ uma leitura antiga é **PISO** do saldo de agora.
Piso é o lado certo de errar num guard: nunca libera o que devia barrar.~~
**⚠️ A frase riscada acima está ERRADA e custou ~9h de bloqueio em 13/10/2026** — a janela é ROLANTE
e `resets_at` anda para frente sozinho. Mantida riscada de propósito: ela é plausível, foi escrita com
convicção e sobreviveu a uma revisão. Refutação medida na seção *A premissa do PISO era falsa* abaixo.

---

## A premissa do PISO era falsa (2026-10-13)

A defesa acima — "leitura antiga é piso do saldo de agora" — **virou o defeito**. O sensor recusou
duas consultas com `SALDO_ALTO: a cota está em 95.0%` enquanto o saldo real era **3%**.

| leitura (local) | used_percent | resets_at | rollout |
|---|---|---|---|
| 12/10 13:32 | 91,0% | 18/10 08:58 | `rollout-2026-10-12T13-32-30-…` |
| 12/10 21:00 | 94,0% | 18/10 08:58 | `rollout-2026-10-12T21-00-03-…` |
| 12/10 21:14 | **95,0%** | **18/10 08:58** | `rollout-2026-10-12T21-14-33-…` |
| 13/10 06:33 | **3,0%** | **20/10 06:33** | `rollout-2026-10-13T06-33-10-…` |

Em 12/10 21:48 o sensor leu os 95% / reset 18/10 (ainda no FUTURO ⇒ a armadilha da "leitura obsoleta"
não descartou) e recusou. Em 13/10 06:32 **repetiu a mesma leitura obsoleta**. Só saiu do caminho com
`CODEX_ASYNC_TETO_SALDO=0` — que desliga o sensor INTEIRO. As duas chamadas que então rodaram
nasceram reportando 3% com reset 20/10: a janela havia rolado, e o sensor barrou ~9h de trabalho
legítimo contra uma cota praticamente VAZIA. **O custo é o oposto exato do que ele existe para
evitar.**

### Por que a premissa é falsa

`resets_at` de uma janela ROLANTE **anda para frente sozinho** — a janela nova é CONCEDIDA, não só
consumo velho envelhecendo (a janela nova nasce com `used_percent` 0 e `resets_at` = agora +
exatamente `window_minutes`). Logo **duas leituras podem AMBAS ter `resets_at` no futuro e pertencer
a janelas DIFERENTES** — e aí a antiga não é piso de nada: é de outra janela.

### A medição (1.959 rollouts · 28.986 leituras · mai–out/2026)

- **`primary` não é sempre o mesmo bucket:** `window_minutes` 300 (5h, dominante mai–jun), 10080
  (7 dias, desde jul), 43200 (30 dias, 63 leituras em ago). Uma janela é a dupla
  `(window_minutes, resets_at)` — e qualquer texto que diga "janela de 7 dias" fixo erra 1/3 do corpus.
- **O piso vale DENTRO da janela e NADA entre janelas:** nas 19.602 leituras do bucket de 7 dias,
  das 16 violações de piso ≥10pp, **16 de 16 coincidem com `resets_at` mudando — ZERO dentro de uma
  mesma janela.** A premissa não era "quase certa": era certa num escopo e aplicada em outro.
- **O erro mora na IDADE da leitura:** violações ≥50pp só aparecem a partir de 9,3h (+95pp, este
  incidente), 9,6h (+83pp) e 43,6h (+95pp). Mas o teto de idade **limita, não elimina** — mediu-se
  +53pp com 42 min.
- **Teto de idade quase não custa onde o sensor se paga:** em regime alto (`pct`≥85) 99,3% das
  leituras têm antecessora de ≤2h (99,1% ≤1h) — quando a recusa importa, a leitura é densa.
- **O preço do teto, honesto:** entre 14/09 19:46 e 19/09 13:21 houve **113,6h** com a cota de fato
  em 100% e ZERO leitura nova (12 rollouts abertos no período, **nenhum** com medidor — a parede do
  429). Ali o teto faz cada tentativa gastar UMA chamada em vez de ser barrada. É o lado certo de
  errar: cota esgotada sai em `exit 75` NA HORA, sem retry, citando o `try again at` do servidor —
  uma chamada rápida que devolve a verdade autoritativa, contra ~9h de bloqueio.
- **Janela é `resets_at` EXATO, sem tolerância:** o servidor recalcula `resets_at` por requisição e o
  mesmo ciclo aparece com 1s de diferença, mas o jitter (até 0,97h) **encosta** na rolagem real
  (mínima 1,01h) — não há corte que separe. Replay incremental das 28.986 leituras: sem tolerância,
  19 momentos (de ~29k) passam com piso 84% onde o agrupamento recusaria com 85% (**1 pp**, na margem
  do teto); com tolerância de 1h, importa-se até **+75 pp** de janela já descartada — isto é,
  reintroduz-se este incidente com 75× o tamanho do erro oposto.

### O conserto

`scripts/codex-async.sh` (suíte: `scripts/test-codex-async.sh`, 4 casos novos + falsificação):

1. **A leitura escolhida é a mais FRESCA pelo `timestamp` da própria LINHA do rollout**, não "a
   primeira de reset futuro na ordem dos nomes". Nome de arquivo é hora de ABERTURA da sessão: uma
   sessão longa ainda escrevendo carrega medidor mais fresco num arquivo de nome mais ANTIGO. A ordem
   por nome errava **nos dois sentidos** — recusava com 95% de janela vencida *e* passava com 20%
   onde o piso da janela era 94%.
2. **O saldo é o MAIOR `used_percent` da janela escolhida** (o piso, agora no escopo em que vale).
   Leitura de `resets_at` menor é de outra janela e **não entra**.
3. **Teto de idade** (`CODEX_ASYNC_IDADE_MAX_SALDO`, default 120 min): acima dele degrada para
   `SALDO_DESCONHECIDO` e **SEGUE com aviso** — nunca recusa. Tem válvula PRÓPRIA, porque em 13/10 a
   única saída era desligar o sensor inteiro.

## Regras

1. **Ache o medidor do provedor antes de otimizar.** Existe um número que decide "acabou"? Meça nele.
2. **Proxy plausível não avisa que é proxy.** Tokens→cota, linhas→complexidade, bytes→custo: todo
   proxy tem um multiplicador que muda sem avisar (aqui, na troca de modelo em 05/09).
3. **Baseline recortado fabrica tendência.** Série que começa onde os dados começam, não onde o
   fenômeno começa, inventa crescimento. Confira o ponto inicial contra o período anterior.
4. **2ª opinião só morde com o substrato junto** — mande o caminho dos dados e peça re-medição.
5. **Sensor de recurso esgotável: teste no estado ESGOTADO**, que é quando ele precisa falar. A suíte
   sintética passa; é o estado real que denuncia.
6. **Janela ROLANTE: "o prazo ainda não venceu" NÃO prova que a janela é a mesma.** O `resets_at` de
   uma janela rolante anda para frente sozinho — duas leituras podem ter o prazo no futuro e ser de
   ciclos diferentes. Uma leitura só é piso do estado de AGORA se pertencer à MESMA janela, e a
   identidade da janela é um campo do dado (`(window_minutes, resets_at)`), não a validade do prazo.
7. **Em sensor, leitura sem IDADE é leitura sem confiança.** Dado velho que decide com confiança é
   pior que dado ausente: ausente degrada e avisa, velho **recusa**. Date a leitura na fonte (aqui, o
   `timestamp` da linha) e ponha teto de idade **com válvula própria** — se a única saída for desligar
   o sensor inteiro, a válvula não existe.
