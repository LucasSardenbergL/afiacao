# União de duas vias cegas não é cobertura — a classe que nenhuma enumerava (2026-09-05)

O Passo 3 do `/fecho` (`edges-pendentes.sh`) enumerava os alvos da janela pela UNIÃO de duas vias,
e o comentário dizia, com razão, que cada uma sozinha tem furo. O que ninguém tinha feito era a
conta da INTERSEÇÃO dos furos:

| via | enxerga | é cega para |
|---|---|---|
| (a) diff de `sonda-fingerprints.ts` | efeito de `_shared/` | quem não está no mapa |
| (b) `git log --name-only` das pastas | edge fora do mapa | quem foi afetada sem ter a pasta tocada |

A interseção é uma classe inteira: **edge FORA do mapa que importa `_shared/`**. Ela não vira alvo
por via nenhuma — não vira chip, e a pendência some por AUSÊNCIA DE DADO. Num script que APAGA
pendência, é o modo de falha caro de `sonda-ausente-em-script-que-apaga.md`.

**Medido** sobre `origin/main`, com a própria `fecharGrafo` do `sonda-fingerprint.ts`, rodada sobre
um `git archive` extraído (nunca sobre a árvore de trabalho): 95 pastas com `index.ts`, 81 importam
`_shared/`, 40 no mapa ⇒ **41 na classe cega**. Na janela real 2026-08-21→09-05, DUAS delas foram
afetadas de fato e escapariam inteiras: `visit-score-recalc-client` (por `_shared/leitura-critica.ts`,
4 commits na janela) e `elevenlabs-transcribe`.

## A regra

**Ao unir vias para enumerar, calcule a interseção dos furos — não a união das coberturas.** "Cada
uma cobre o furo da outra" é uma afirmação sobre PARES; a pergunta certa é se sobra alguém fora das
duas. Aqui sobravam 41, e o texto que declarava os furos estava certo em cada metade.

## Por que instrumentar as 41 NÃO era o conserto

O impulso é dar `versao.ts` às 41 para que entrem na via (a). Três medições contra:

1. **Fecha os casos, não a classe.** Edge nova fora do mapa recria o buraco — é literalmente a
   lição que fez nascer o `sonda-edge-nova-gate.ts` (a `analytics-outbox-drain`, #2035).
2. **Instrumentar em massa PRODUZ a enxurrada de chip que o script existe para cortar.** Entrar no
   mapa só vira evidência positiva DEPOIS do deploy manual; até lá a main serve `fonte`, o ar não,
   e o veredito correto é pendência PROVADA. 41 de uma vez = 41 deploys manuais e 41 chips.
3. **Sondar bundle pré-sensor dispara o fluxo real** (`deploy.md`). Entre as 41 estão
   `whatsapp-send-template` e `nvoip-calls`: a janela entre merge e deploy é uma em que sondar
   manda mensagem e toca o telefone do cliente.

O conserto da CLASSE é a **via (c)**: edge afetada = algum arquivo do fecho transitivo aparece no
`git diff base..head`, com universo = toda pasta com `index.ts`. Não toca produção, não pede deploy,
e o pior caso é chip a mais — a direção certa num script que apaga pendência. `scripts/edges-afetadas.ts`.

A instrumentação continua valendo, mas por outro motivo e em outra escala: ela dá SUPRESSÃO por
evidência positiva servida, não visibilidade. Por isso virou leva pequena e priorizada por EFEITO
(as 5 de efeito fora do nosso banco), não varredura das 41.

## Detalhes que custaram tempo

- **Reusar a `fecharGrafo`, não reimplementar o fecho em bash.** Duas noções de "o que entra no
  bundle" divergem em silêncio — a mesma razão pela qual `parsearMapa` foi extraída para lá.
- **O binário vem de `$0`, os dados de `$RAIZ`.** A suíte aponta `CLAUDE_PROJECT_DIR` para um repo
  git de fixture; derivar o caminho do auxiliar de `$RAIZ` o faria sumir dentro do teste.
- **`alterados` vazio ⇒ ninguém afetado, nem a edge de fecho ilegível.** O fail-closed local existe
  para "não sei se ESTA mudança a atingiu"; sem mudança nenhuma não há dúvida, e incluí-la geraria
  chip perpétuo — ruído com o mesmo desfecho do sinal.
- **A falsificação do harness bash não alcança o `.ts`.** O `--falsificar` sabota o alvo por `sed`
  no `.sh`; a lógica nova mora no módulo TS e precisou de `scripts/edges-afetadas.test.ts` com
  falsificação própria. A asserção que importa lá é que o universo é `index.ts` e NÃO o mapa —
  sabotá-la para exigir `versao.ts` faz a via (c) virar cópia cara da via (a), e a classe cega
  volta inteira com a suíte bash ainda verde.
