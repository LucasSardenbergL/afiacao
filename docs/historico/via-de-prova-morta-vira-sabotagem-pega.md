# A via de prova morta vira "sabotagem pega" — controle verde não cobre o resto do laço

**Data:** 2026-09-07 · **PRs:** #2308 (eixo SHELL) e este (eixo VIA) · **Classe:** `ausente ≠ zero`

## O sintoma que trouxe a investigação

O check `validate` reprovava em PRs cujo diff não tocava nada relacionado:
`sonda-veredito-401-eval.sh --falsify` acusava `sabotagem NO-OP (alvo sumiu do gerador)` e
terminava com `N cegueira(s)`. Não reproduzia no macOS: 4 execuções locais limpas.

## O que os RELÓGIOS disseram (e a mensagem não dizia)

No run 34124343894, as 5 primeiras sabotagens voltaram em **~1,7 ms cada** e as 6 seguintes em
**~840 ms**. 840 ms é o custo de rodar os cenários; 1,7 ms é o custo de não rodar nada. E as cegas
eram sempre um **PREFIXO** a partir da primeira — no run 34116946335 (na `main`) foram as duas
primeiras. Prefixo mata explicação por conteúdo: os 11 padrões existiam, byte a byte, em todos os
refs. O que variava era **quando**, não **o quê**.

## Causa raiz nº 1 — o pipeline não é o grep (fechada no #2308)

```bash
if ! printf '%s' "$ORIG" | command grep -qF "$de"; then   # → "alvo sumiu do gerador"
```

`grep -q` sai no **primeiro** match sem drenar o stdin. O `printf`, que ainda tinha bytes a
escrever, morre de **SIGPIPE**; sob `set -o pipefail` o pipeline devolve **141** — com o grep tendo
respondido `0`/ACHOU. O `if !` lê 141 como "não achei". Reprodução determinística:

```
$ printf '%s' "$BIG" | grep -qF "<padrão no início>"; echo $?
141          # o grep ACHOU; o pipeline reprovou
```

Só aparece quando o payload não cabe no buffer do pipe — daí ser corrida, e daí o prefixo logo
após o controle (que tinha acabado de gastar 12 `bun` + `psql`). **Não reproduz no macOS**: o BSD
grep drena o stdin antes de sair. Falsificar só aqui não prova nada (lição do #1483).

## Causa raiz nº 2 — vermelho por AUSÊNCIA creditado como vermelho por DIVERGÊNCIA

Ao investigar a nº 1 apareceu a irmã, mais cara porque falha **ABERTA**. O laço creditava a
sabotagem sempre que a suíte ficasse vermelha:

```bash
executar_casos >"$TMP/falsify.out" 2>&1
if [ "$rc" -ne 0 ]; then printf '  [ok ] pegada: %s\n' "$nome"
```

Mas vermelho tem duas origens que não se parecem em nada:

| origem | o que é | o que prova |
|---|---|---|
| o banco respondeu **OUTRA** coisa | DADO | a asserção divergiu ⇒ a sabotagem foi pega |
| o banco **não respondeu** | AUSÊNCIA de dado | nada |

Com o Postgres efêmero morto **depois** do controle, toda sabotagem seguinte herda um vermelho que
já existia. Medido injetando `P() { return 1; }` logo após o controle verde:

```
--falsify: 0 cegueira(s) (esperado: 0)     ← exit 0, com 11/11 "[ok] pegada"
```

O gate mais rigoroso do repo aprovando sem ter olhado.

## A lição que o controle verde NÃO cobre

`docs/historico/falsificacao-sem-linha-de-base.md` exige controle verde na MESMA invocação do laço,
e estava lá — funcionando. **Controle verde é necessário e não é suficiente:** ele prova que a
suíte não era sempre-vermelha *no instante t₀*, e o laço julga em t₁…t₁₁. A via pode morrer no
meio, e quando morre o controle vira álibi: já atestou, ninguém mais desconfia.

## O remédio

1. `veredito()`/`rodar()` **nomeiam** o não-veredito (`SEED_FALHOU`/`SQL_VAZIO`/vazio), e `via_caiu`
   acumula, **separado do `rc`** de propósito.
2. `via_viva()` — sonda **POSITIVA fim-a-fim** com o alvo **já restaurado**: semeia o caminho feliz
   e exige a marca conhecida de volta. `SELECT 1` não bastaria: a via tem três pernas (Postgres,
   `bun`, o caminho do SQL) e `command -v` não vê perna quebrada.
3. Vermelho **+** cenário sem veredito **+** via morta ⇒ `exit 2` **nomeando a causa**, nunca
   `[ok] pegada`. Modo normal com a via morta sai **2** (via), não **1** (divergência de contrato):
   um exit 1 manda o próximo agente editar a asserção para "consertar o contrato".
4. Guardado por `scripts/test-eval-via-morta.sh`, que roda o eval **de verdade** num sandbox no tmp
   (mock de infraestrutura não tem como morrer), com controle verde na mesma invocação e
   `--falsificar` que arranca o discriminador e **exige o fail-open de volta**.

## Pegadinha que o próprio teste pegou

A 1ª versão do teste injetava a morte imediatamente antes de `cegas=0` — que mora no ramo do
`--falsify`. No modo normal a mutação **nunca executava** e o caso ficava verde por CEGUEIRA:
exatamente o que o teste existe para proibir. Mutação precisa ser injetada num ponto que o modo sob
teste realmente **alcança** — "o `sed` casou" não é o mesmo que "a linha rodou".
