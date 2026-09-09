# Extrair duplicação consolida mutações gêmeas — a aritmética do contrato cai, o poder não. Prove.

**2026-09-08.** 4ª etapa da desduplicação do `scripts/sonda-versao-sql.ts`, o gerador do SQL que
decide se uma edge está no ar (`DEPLOY CONFIRMADO` / `BUNDLE VELHO` / `CANÁRIA VERMELHA` /
`SEM CANARIA NO AR` / `INDETERMINADO`). O bloco da canária nasceu como cópia do da sonda (#2380);
o #2392 unificou timeout/trava/rodapé; sobrou a chamada `net.http_post` e o CTE
`controle_credencial`. Extraí os dois. **O que a extração ensinou não foi sobre duplicação — foi
sobre o que acontece com o contrato de mutação quando duas cópias viram uma.**

## O problema: o contrato encolhe, e "encolheu" não distingue duas coisas opostas

`scripts/mutcheck.d/sonda-versao-sql.mut` tinha duas mutações gêmeas, distinguidas **só pelo
alias** que cada cópia usava:

```
s/AND NOT EXISTS \(SELECT 1 FROM ids i2  WHERE i2\.request_id  = r\.id\)/AND true/   (sonda)
s/AND NOT EXISTS \(SELECT 1 FROM ids mp2 WHERE mp2\.request_id = r\.id\)/AND true/   (canária)
```

Com o CTE numa função só, o texto passa a existir **uma vez** — e as duas mutações não casam mais
nada, ficando `INVÁLIDO (não casou)`. Reancorá-las no texto novo colapsa as duas em **uma**.

A regra de ouro do repo é "se o contrato encolher, a cobertura encolheu junto". Aqui ela precisa de
uma emenda, porque **90 → 89 PEGA tem duas causas opostas**:

- **perda real:** uma invariante deixou de ser exercitada;
- **consolidação:** dois pontos de defeito viraram um, e o único mutante restante quebra os dois
  consumidores.

O número sozinho não separa as duas. E há uma armadilha específica: **o `mutcheck.sh` roda a suíte
INTEIRA e reporta o agregado.** Depois da consolidação, `PEGA` significa apenas "algum teste
morreu" — uma metade bem testada esconde a outra descoberta, e o contrato fica afirmando uma
cobertura que ninguém mediu. (Ressalva levantada no ritual `/codex`, gpt-6-astra, 2026-09-08.)

## O conserto: provar por CONSUMIDOR, não pelo agregado

`scripts/prova-consumidores-controle.sh` aplica **a mesma mutação do `.mut`** e roda a suíte
filtrada por modo, exigindo vermelho nos **dois** isoladamente — com controle verde antes, na mesma
invocação, e um guard contra o `-t` que não casa teste nenhum (vitest sai 0 por vazio: verde por
ausência, exatamente a falha que o script existe para não cometer).

```
CONTROLE  SONDA    verde e casou teste ✓
CONTROLE  CANARIA  verde e casou teste ✓
MUTANTE   SONDA    morto ✓
MUTANTE   CANARIA  morto ✓
```

Falsificado: removida a asserção que mata o mutante, a prova acusa **os dois** modos como
descobertos e sai vermelha. Sem isso ela seria uma afirmação, não uma medida.

## O que a extração REVELOU (e é o argumento que a justifica)

A duplicação não era simetria — era **cobertura desigual que ninguém via**. Medido no dia:

| invariante | sonda | canária |
|---|---|---|
| `x-cron-secret` / `Content-Type` | **ausente** | **ausente** (`grep -c` = 0 nas duas) |
| `name = 'CRON_SECRET'` | pinado | **ausente** |
| `BETWEEN 200 AND 299`, `= 401`, `interval '6 hours'` | pinados | **ausentes** |

Na cópia da canária, `BETWEEN 200 AND 499` ou `interval '6 days'` **passava a suíte**. Com uma
cópia só, as asserções da sonda passam a valer para os dois modos **por construção, não por
disciplina de quem copia** — e as invariantes que faltavam nos dois entraram como mutações novas.

O drift dos headers é o caso caro, porque **se lê como o contrário do que é**: header errado ⇒ 401
só na leva ⇒ o `controle_credencial` (que conta tráfego de **fora** da leva) segue verde ⇒ sai
`BUNDLE VELHO (pre-sonda)` **confiante** ⇒ redeploy à toa de edge que já estava no ar.

**Saldo do contrato: 90 → 92 PEGA** (−1 consolidação, +3 invariantes novas), 2 SOBREVIVE, 94
padrões, 94 cirúrgicos. A decomposição está escrita no próprio `.mut`, no ponto de uso — o saldo
positivo **não é prova de cobertura**, é só a aritmética; a prova é o script por consumidor.

## O que NÃO foi extraído, e por quê

Vereditos e as guardas `X.ok_recentes >= PISO AND X.recusas_recentes = 0` ficaram **explícitos em
cada bloco**. Os dois julgam coisas diferentes a partir do mesmo número, e unificá-los seria
transformar dois julgamentos distintos num só. `blocoDisparo*`, `corpoDoPassoDeLeitura*` e
`valuesAlvos*` também ficaram de fora: na canária, corpo e sufixo escolhem entre **executar a
canária e executar o fluxo real** — parametrizar isso é onde uma associação errada troca o alvo.

## Evidência de que a extração não mudou o veredito

`scripts/sonda-versao-sql.ts` é money-path, então a extração precisa provar que **não mexeu no que
o SQL decide**. Comparei o SQL emitido em 8 variantes (sonda/canária × leva mista × `--so-disparo`
/`--so-leitura`/`--janela`) antes e depois, descartando linhas de comentário e normalizando o alias
local: **8/8 equivalentes, 0 divergentes, 0 ausentes**. O comparador é fail-closed (variante
faltando é falta de dado, não igualdade) e foi falsificado com 3 sabotagens semânticas.

## A limitação que o ritual expôs (e que NÃO se conserta aqui)

O controle de credencial é **histórico**: prova que algum tráfego recente passou, não que **esta
leva** mandou a credencial certa, e não diz qual credencial autenticou os 2xx que contou. O header
errado é uma segunda manifestação da limitação que o aviso do vault já reconhecia — e, ao
contrário da rotação de segredo, **essa não se desqualifica sozinha**. O aviso passou a ser emitido
pela própria função (vale para os dois modos; até aqui só a sonda o carregava), e os headers viraram
invariante vigiada no gerador. Um controle **ativo**, autenticado e associado à tentativa atual,
merece entrega própria.

## O acidente que a própria sessão cometeu: `git add -A` durante o mutcheck

A rodada cheia do `mutcheck` demora ~10min e muta o fonte no disco enquanto roda. Fiz commits de
WIP nesse intervalo — e um `git add -A` pegou `supabase/functions/_shared/desconto-omie.ts`
**mutado**, commitando `return null` → `return 0` num arquivo que eu não estava tocando: o
`Number(null) === 0` que o repo persegue, entrando por acidente num PR de refactor. O mutcheck
restaurou o arquivo depois, e a mutação ficou só no **commit** — invisível no `git status`, visível
só no diff contra a main.

Dois sensores independentes o pegariam, e um deles pegou: o hook de colisão multi-sessão avisou que
**dois PRs abertos** (#2412, #2413) tocavam justamente esse arquivo. O outro é a auditoria de escopo
do próprio diff — `git diff --name-only origin/main...HEAD` filtrando os arquivos esperados.

> Enquanto uma rodada de mutation testing estiver viva, **nunca `git add -A`**. Ou espere, ou
> adicione por caminho explícito. E antes de abrir o PR, liste os arquivos do diff e confira que
> **todos** estavam no escopo — arquivo alheio no diff é mutação commitada até prova em contrário.

## A regra

> Ao extrair duplicação coberta por mutação, **consolidar não é perder** — mas o contrato não sabe
> a diferença. Registre a consolidação **no ponto de uso**, dizendo quais mutações convergiram, e
> prove que o mutante restante morre **por consumidor isolado**: o mutcheck lê a suíte agregada, e
> agregado não distingue "os dois cobertos" de "um cobrindo o outro". Mutação nova só compensa
> consolidação quando é invariante **real e antes ausente** — nunca reposição contábil.
