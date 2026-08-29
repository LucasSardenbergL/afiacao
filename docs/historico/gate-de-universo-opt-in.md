# Gate cujo universo é lista opt-in: quem nunca entrou não reprova — some

> Entrega de 2026-08-28. O gate: `scripts/sonda-edge-nova-gate.ts` (`bun run sonda:nova`).
> O caso que o motivou está medido em [verificar-sonda-versao.md](verificar-sonda-versao.md) §14.

## A classe da falha

Um fiscal cujo **universo** é derivado de um artefato **opt-in** não tem como reprovar quem nunca
optou. Não é bug: é o desenho funcionando, e é por isso que passa despercebido — a saída não é
vermelha nem amarela, é uma linha a menos.

Os três gates de sonda que existiam compartilhavam esse universo, cada um por um caminho:

| gate | universo | como ele se deriva |
|---|---|---|
| `sonda:bump` | edges com `versao.ts` na BASE | edge sem marcador cai no `versaoBase === null` e sai |
| `sonda:fingerprint` | `edgesInstrumentadas()` | a presença de `versao.ts` na pasta |
| `pendencias:deploy` | `lerMapaCommitado()` | o mapa commitado, que só tem edge instrumentada |

MEDIDO: a edge `analytics-outbox-drain` nasceu no #2035 sem `versao.ts` e fora de
`_shared/sonda-fingerprints.ts`. Nenhum dos três reclamou. O relatório dizia `cobertura: 39/39`
quando o repo tinha 40 edges elegíveis — **o 40º não estava reprovado, estava ausente do
denominador**. Ela foi instrumentada no #2094; este gate é para a próxima.

A generalização vale além da sonda: **toda vez que um gate mede "N de N" sobre uma lista que o
próprio artefato fiscalizado alimenta, o denominador é cúmplice.** A pergunta que separa os dois
casos é "o que aconteceria com um item que nunca entrou na lista?" — se a resposta é "some", falta
um gate na FRONTEIRA DE ENTRADA.

## A régua

Pasta de `supabase/functions/` é NOVA quando tem `index.ts` no HEAD e não tinha na BASE. A entrada
— não o diff — é o que decide: a fatia pode tocar só um `helper.ts`, e pasta que ganha arquivo sem
ganhar `index.ts` não é edge servida. Ler os dois lados separa NASCER de MUDAR (quem cuida é o
`sonda:bump`) e de SUMIR (que não é problema de ninguém).

Edge nova precisa de UMA das duas, e o gate não escolhe qual:

- **(a)** `versao.ts` com `VERSAO` legível **e** entrada no mapa de fingerprints;
- **(b)** o nome em `DISPENSAS`, com motivo tipado e o `porque` assinado.

## Por que (b) existe

Das 95 pastas de edge, 40 são instrumentadas. As 55 restantes **não são dívida**: a maioria é
leitura pura, classe que a terceira leva (#1767) excluiu de propósito — "chamá-la já é grátis,
então a sonda não resolve problema que ela tenha". Exigir `versao.ts` de toda edge nova seria
imposto sobre quem não precisa de sonda, e **gate assim é o que alguém afrouxa no primeiro
atrito**. O que este gate proíbe não é a dispensa: é a OMISSÃO.

O que impede a válvula de virar o buraco: `leitura-pura` é uma afirmação sobre o CÓDIGO, e o gate
a falsifica contra a fonte. Os motivos que texto nenhum decide continuam existindo — e o gate
declara esse limite em vez de fingir que cobre.

## O que a FALSIFICAÇÃO achou (e o desenho não)

Dois furos, ambos descobertos por rodar o gate contra o repo real, nenhum deles previsto:

1. **`.rpc()` também escreve, e o texto não diz qual RPC lê.** O detector original só via a cadeia
   PostgREST (`.from().insert()`). O teste de controle positivo — que exige que a
   `analytics-outbox-drain` REPROVE como `leitura-pura` — ficou vermelho: ela grava por
   `analytics_outbox_aceitar`, um RPC. Medido nas 56 pastas sem `versao.ts`: **31** escrevem por
   PostgREST, **12** chamam `.rpc()`, **20** não fazem nem um nem outro. Um único motivo
   `leitura-pura` daria verde AUTO-VERIFICADO a 12 edges cuja escrita o gate não enxerga — e no
   formato exato do caso que motivou o gate. Daí `leitura-via-rpc` ser motivo separado, com o
   `porque` obrigado a NOMEAR o RPC: o gate não lê o corpo da função, quem lê é a review, e ela
   precisa do nome.
2. **Edge nova nasce UNTRACKED, e `git diff` não a enxerga.** Com a pasta criada e não adicionada
   ao índice, o gate imprimia `✓ toda edge nascida nesta fatia tem a decisão TOMADA`. Verde por
   CEGUEIRA no exato instante em que o autor roda o gate para saber se decidiu. O CI nunca veria
   (lá tudo já está commitado) — **o falso-verde era só LOCAL, e local é onde a decisão
   acontece**. Corrigido unindo `git ls-files --others --exclude-standard` quando o head é a
   árvore de trabalho.

## Limites declarados

- **`pull_request`-only**, como o `sonda:bump`: no `push`/`schedule` da main a merge-base é o
  próprio HEAD, e diff vazio se leria como "nenhuma edge nasceu". A metade descoberta é a edge que
  nasce por push DIRETO do Lovable, sem PR.
- **A lista não se revisita sozinha.** O gate é de DIFF: vê a edge no dia em que ela nasce e nunca
  mais. Quem cobra a coerência da lista contra a árvore (dispensa de edge que não existe, dispensa
  de edge que hoje tem `versao.ts`, `leitura-pura` que passou a escrever) são os testes-sentinela
  de ESTADO em `scripts/sonda-edge-nova-gate.test.ts`, que o `bun run test` roda em todo evento.
- **`DISPENSAS` nasce vazia de propósito.** Ela cobre o que nasce daqui para a frente; as 55
  não-instrumentadas que já existiam não passam por este gate. Retroalimentá-la seria inventar
  assinatura de decisão que ninguém tomou.
