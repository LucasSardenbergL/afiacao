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
fundo por chute, e sim uma propriedade do dado: **enquanto `resets_at` está no futuro a janela é a
mesma, e dentro de uma janela o consumo só sobe** ⇒ uma leitura antiga é **PISO** do saldo de agora.
Piso é o lado certo de errar num guard: nunca libera o que devia barrar.

## Regras

1. **Ache o medidor do provedor antes de otimizar.** Existe um número que decide "acabou"? Meça nele.
2. **Proxy plausível não avisa que é proxy.** Tokens→cota, linhas→complexidade, bytes→custo: todo
   proxy tem um multiplicador que muda sem avisar (aqui, na troca de modelo em 05/09).
3. **Baseline recortado fabrica tendência.** Série que começa onde os dados começam, não onde o
   fenômeno começa, inventa crescimento. Confira o ponto inicial contra o período anterior.
4. **2ª opinião só morde com o substrato junto** — mande o caminho dos dados e peça re-medição.
5. **Sensor de recurso esgotável: teste no estado ESGOTADO**, que é quando ele precisa falar. A suíte
   sintética passa; é o estado real que denuncia.
