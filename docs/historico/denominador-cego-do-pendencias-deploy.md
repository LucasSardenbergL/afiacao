# O denominador cego do `pendencias:deploy` — e o vão entre dois gates que se remetiam

> 2026-10-06 · incidente **#2824** (`f55523513`) · conserto no `pendencias:deploy` e no `sonda:nova`
> Classe: **verde por AUSÊNCIA de dado**, a que o `CLAUDE.md` nomeia como a mais cara de pagar.

## O que aconteceu

O #2824 tirou `estoque: prod.quantidade_estoque || 0` de **cinco** edges. O `pendencias:deploy`
acusou **quatro** como P1 pendentes. A quinta — `tint-omie-sync`, money-path do tintométrico — não
apareceu em **nenhuma** seção do relatório: nem pendente, nem confere.

Ela não tem `supabase/functions/tint-omie-sync/versao.ts`. E a ausência do marcador comprava
silêncio no relatório inteiro, inclusive no denominador:

```
versao.ts ausente
  ⇒ fora de edgesInstrumentadas()        (sonda-fingerprint.ts:219-224 — filtra por PRESENÇA do marcador)
  ⇒ fora de _shared/sonda-fingerprints.ts
  ⇒ fora de lerEsperados()               (itera Object.entries(mapa))
  ⇒ fora de julgar()                     (itera os esperados)
  ⇒ invisível no relatório E no denominador
```

A linha de fecho dizia `cobertura: 62/62 edges mapeadas com atestação`. Verdadeira, e lida como
cobertura total — de **97** pastas de edge na main. As 35 sem marcador não estavam reprovadas:
estavam ausentes do denominador. Sem deploy, a `tint-omie-sync` seguia gravando `estoque = 0` no
tintométrico — exatamente o defeito que o #2824 foi corrigir — e nenhum sensor reclamava, nunca.

## O vão: dois `continue` que apontavam um para o outro

O verde-falso foi **provado**, não suposto. Rodando os dois gates de diff sobre `f55523513`, antes
desta entrega:

| gate | exit | cita `tint-omie-sync`? | por quê |
|---|---|---|---|
| `sonda:bump` | 0 ✓ "toda edge instrumentada alterada nesta fatia bumpou o VERSAO" | não | `versaoBase === null ⇒ continue` — só olha edge COM marcador na base |
| `sonda:nova` | 0 ✓ "toda edge nascida nesta fatia tem a decisão TOMADA" | não | `ler(base, entrada) !== null ⇒ continue` — a edge já existia |

O comentário do `continue` do `sonda:nova` dizia *"já existia: é MUDANÇA, e quem cuida é o
`sonda:bump`"*. O do `sonda:bump` descartava quem não tinha marcador. **Edge antiga, sem marcador,
cujo corpo muda** caía entre os dois, e os dois saíam verdes com mensagem de aprovação.

Mais: o cabeçalho do `sonda:nova` já havia **diagnosticado esta classe em 2026-08-28** —
*"quando o universo de um gate é lista derivada de artefato OPT-IN, quem nunca entrou não reprova:
some"*, com o caso `cobertura: 39/39` que era 39/40. A resposta de então cobriu o eixo "edge que
NASCE". O eixo "edge que MUDA sem marcador" ficou aberto por mais seis semanas.

## A premissa do grandfathering estava desatualizada — e a medição que a contraria estava no mesmo comentário

A vovó-cláusula das edges sem marcador se justificava com *"a maioria é leitura pura"*. Medido hoje
na `origin/main`, com `detectarMutacao`/`detectarRpcs` do próprio gate (stripper compartilhado, não
grep):

```
97 pastas de edge (fora _shared) · 62 com versao.ts · 35 sem
das 35:  16 ESCREVEM por PostgREST · 4 só .rpc() (opaco) · 15 nenhum dos dois
```

Leitura pura é **15 de 35 (43%)**: minoria. E a linha 48 do mesmo comentário já registrava 31 de 56
escrevendo em 2026-08-28 — **a medição que derruba a premissa estava seis linhas abaixo dela**.
Ninguém releu as duas juntas. A conclusão (dispensa é legítima) sobrevive; o que caiu foi a ideia
de que a dispensa é o caso *esperado*.

## O que foi feito

**1. O relatório DECLARA o que não alcança** (`scripts/pendencias-deploy.ts`)

- `lerUniverso(ref)` conta as pastas de edge da ref e classifica as sem marcador por escrita.
  **Fail-closed**: `ls-tree` que falha lança, e o `main` devolve exit 2 — universo vazio por erro
  imprimiria `0 fora do alcance`, o mesmo silêncio com cara de boa notícia.
- Seção `⚫ FORA DO ALCANCE` nomeia cada uma, escritoras primeiro (roteiro de prioridade, não
  inventário), com o eixo do risco no cabeçalho.
- A cobertura passa a imprimir os **dois** denominadores:
  `cobertura: 62/62 … · alcance: 62/97 edges da ref instrumentadas (35 fora do alcance, acima)`.
- `--json` ganhou `totalExistentes` e `semMarcador` (acrescentados, sem bump do `FORMATO_JSON`):
  o consumidor passa a distinguir "edge CONFERE" de "edge não julgável", que antes chegavam as
  duas como ausência da chave.

É **aviso**, não pendência: não muda exit code. Não há prova a cobrar de quem não tem sensor.

**2. O `sonda:nova` cobra a decisão de quem MEXE** (`scripts/sonda-edge-nova-gate.ts`)

Segundo universo, `origem: 'mexida-sem-marcador'`: `index.ts` nos dois lados, sem `versao.ts` no
head, e a fatia alterou algo que `contaComoCorpo`. Mesma pergunta, mesmas duas saídas, mesma
`DISPENSAS` com `porque` assinado e `leitura-pura` falsificada contra a fonte. **Sem máquina nova
e sem segunda allowlist** — uma segunda fonte de verdade sobre "esta edge não precisa de sonda"
repetiria o incidente de 2026-09-10 que o próprio CLI registra.

Só o `_test.ts` mexido não entra: teste não cria deploy pendente, e gate que grita errado treina a
ignorar.

## A decisão de produto: o passivo das 35 NÃO é reprovado

Escolha do founder, e é o ponto que mais importa guardar. O gate é de **DIFF, não de estado**: numa
fatia que não mexe nas 35, ele fica verde. Reprovar o passivo quebraria a main por condição
pré-existente, e retro-preencher `DISPENSAS` seria *"inventar assinatura de decisão que ninguém
tomou"* — o que o comentário da própria `DISPENSAS` já proibia. A decisão de cada edge acontece no
PR que mexer nela, onde ela tem **contexto e dono** (condição 3 de `maquinas-meta.md`).

Medição do atrito, contra as **25 últimas fatias reais da main**: **1 reprova — a do incidente.**
Zero atrito falso em 24 fatias.

## Falsificação (8 camadas, controle verde na MESMA invocação)

Controle de 192 testes verde ANTES do primeiro `sed`, aborto se a árvore tivesse mudança não
commitada (`restaurar()` é `git checkout --`), teto no laço. Uma camada por vez:

| sabotagem | pegou? |
|---|---|
| régua do 2º universo removida | ✓ |
| `semMarcador` degradado para `[]` | ✓ |
| classe de escrita apagada | ✓ |
| `alcance` fora da cobertura | ✓ |
| seção não impressa | ✓ |
| fail-closed do `lerUniverso` degradado | ✓ |
| guarda do `_test.ts` removida | ✓ |
| união das réguas virou só `index.ts` | ✓ |

**A oitava ficou VERDE na primeira rodada** — e é a lição mais útil daqui. A união das duas réguas
(`index.ts` **ou** `versao.ts`) nasceu sem sensor: na árvore real toda edge com marcador também tem
entrada, então qualquer teste contra o repo fica verde com a régua errada. **Verde por vacuidade.**
A resposta foi extrair `montarUniverso(pastas, ler)` — o mesmo seam que `montarEstadoNovas` tem no
gate irmão, e pelo mesmo motivo: *o caso que distingue as réguas não existe na árvore, só em
fixture*. Sem a falsificação, essa correção teria entrado sem teste.

Dois achados menores do caminho, ambos de `evidencia-positiva-shell.md`: um `[exited with code 0]`
do shell envolvente quase passou por typecheck verde quando o tsc tinha saído 2; e o `PIPESTATUS`
num bloco de `heavy ... | tail` teria fabricado aprovação no zsh (o hook barrou).

## O que ficou de fora, declarado

- **16 edges que escrevem seguem sem sensor** até que um PR mexa nelas. Instrumentá-las é leva
  própria, com deploy e 1ª sonda por edge (precedente: #2094).
- O corpo coletado em `mexida-sem-marcador` é *o que a fatia tocou ∪ `index.ts` do head*, não a
  pasta inteira — um helper não tocado que escreva escapa da falsificação de `leitura-pura`. Mesma
  classe do limite de `_shared/` que o gate já declarava.
- A classe `nenhuma` diz "o `index.ts` não escreve", **não** "a edge é inerte".
- O `sonda:nova` segue `pull_request`-only: edge que nasce ou muda por push direto do Lovable, sem
  PR, continua fora.
