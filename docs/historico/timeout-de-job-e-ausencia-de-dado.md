# Timeout de job é AUSÊNCIA DE DADO, não reprovação

**2026-09-07** · `.github/workflows/ci.yml` · teto do `validate` 15min → 25min, `mutation-check` 10min → 15min

## A classe

Quando um job estoura `timeout-minutes`, o GitHub Actions cancela e o check aparece como
**`validate = fail`**. O sintoma é **indistinguível de uma reprovação real** — mesmo X vermelho,
mesmo bloqueio do auto-merge, mesma cara no PR. Mas não houve veredito nenhum: o job foi
interrompido no meio, com **zero teste reprovado**.

É a doutrina da [evidência positiva](evidencia-positiva-shell.md) aplicada ao eixo do TEMPO —
irmã de [espera-sem-desistencia.md](espera-sem-desistencia.md), com o sinal invertido: lá o laço
sem teto fabricava "ainda em andamento" a partir de "nunca vai chegar" (fail-OPEN); aqui o teto
fabrica "reprovou" a partir de "não terminei de olhar" (**fail-CLOSED sobre código sadio**).

E esta é a única falha do repo que **reprova código SADIO**. Todo outro gate vermelho quer dizer
"achei algo"; este quer dizer "não cheguei ao fim" — e diz isso com a mesma voz.

Caso vivo: o **#2285** foi cancelado aos 915s com um único `##[error]The operation was canceled`.
`test:edges` fechara **1037 passed / 0 failed**; build, lint, hooks e falsificação, todos verdes.
Nada quebrara. O autor leu "o CI reprovou".

## A medição (58 runs, duração por step via `gh api .../runs/<id>/jobs`)

Com o teto em 15min (900s), a distribuição do `validate` era um **penhasco**, não uma nuvem:

| desfecho | n | durações |
| --- | --- | --- |
| success | 46 | 650s … **900s** (o mais lento batendo EXATAMENTE no teto) |
| cancelled | 5 | 901 · 901 · 904 · 904 · 917s |

**Nenhum cancelamento abaixo de 900s.** Isso é o que descarta as hipóteses alternativas: não eram
cancelamentos humanos nem de concorrência (esses cairiam em qualquer duração) — era o relógio.
Uma distribuição contínua sendo **truncada**: os runs que teriam levado 905s não falharam, foram
*censurados*. **20 dos 46 verdes (43%) fecharam nos últimos 30s antes do corte**, e ~10% dos runs
que passariam morriam por sorte de runner.

## A causa é a MÁQUINA, não um step

O runner do Actions vem em duas populações, e **todo step escala junto**:

| step | runner rápido | runner lento |
| --- | --- | --- |
| `Tests` (vitest) | 273s | 391s |
| `Falsificação` | 163s | 205s |
| Type check (src) | 37s | 52s |
| `Hooks guard tests` | 60s | 71s |

~30% de spread uniforme. Isso é o que diferencia "um step ficou lento" (regressão — procure a
causa) de "a máquina é outra" (variância — dê folga). Procurar step culpado aqui seria caçar
fantasma.

## Por que nada foi cortado

Dois steps concentram **65%** do job — não é morte por mil cortes. Mas nenhum é gordura:

- **`Tests` (383s, 43%)** — `vitest run` sobre **8.134 testes / 786 arquivos** em jsdom, sem
  restrição de workers. ~21 testes/s. Não há config patológica a corrigir.
- **`Falsificação` (201s, 22%)** — re-executa 10 dos scripts de `test:hooks` em modo sabotagem.
  Parece redundância e **não é**: o CLAUDE.md exige o **controle verde na MESMA invocação do laço**
  (sempre-vermelha aprova TUDO, e a suíte crua do `test:hooks` é outra invocação). Cortar a
  sobreposição seria remover justamente a prova de que o teste sabe ficar vermelho.

Ou seja: o job faz ~11min de trabalho legítimo no runner rápido e ~15min no lento. O teto fora
posto em 15.

## A correção, e por que ela não esconde regressão

`validate` 15 → **25min** (~63% de folga sobre o pior observado, muito além da variância de
runner); `mutation-check` 10 → **15min** — o **gêmeo latente**, achado pela mesma medição: 28 runs
entre 346s e 533s, com o pior já consumindo **89%** do teto, a um runner lento do mesmo
falso-vermelho. `authz-sentinela` fica em 10min (roda em ~18s).

Subir o teto **não** esconde regressão de tempo: a duração de cada run continua registrada no
histórico do Actions, e a medição acima é reproduzível em um comando. O teto não é o sensor de
performance — nunca foi. Ele só deixa de **mentir sobre o resultado**.

## A regra

> **Teto (de tempo, de iterações, de páginas) que dispara vira AUSÊNCIA DE DADO, e ausência de
> dado não é veredito.** Todo teto que reporta pelo mesmo canal de um resultado real precisa (a)
> de folga medida sobre o pior caso OBSERVADO, não sobre o típico, e (b) de um sintoma que se
> distinga de uma reprovação de verdade.

Corolário para dimensionar: **meça a distribuição, não a média.** A média do `validate` (≈820s)
ficava confortavelmente abaixo de 900s e não previa nada; quem decidia o desfecho era a cauda.
Quando um teto tem cauda encostada nele, ele já está reprovando — só não avisa que é ele.
