# "Existe" não é "está na versão que a edge espera" (#2428)

> Gate de ordem do deploy de edges. O eixo que faltava, por que o conserto óbvio era o errado, e o
> fail-open que a primeira versão do próprio conserto reencenou.

## O que foi medido (2026-09-09)

`bun run pendencias:pacote` declarou, para uma leva de 5 edges:

```
✅ pré-condição de banco satisfeita — todas as RPCs da leva existem em prod
📦 pacote `a0c70264cae9` · 5 edge(s) · 14 RPC(s) de pré-condição      (exit 0)
```

E ao lado, em prod:

```
pg_get_functiondef LIKE '%desconto_valor%'  →  f
```

`public.criar_pedidos_com_itens` **existe** — na versão anterior à
`20260908215704_desconto_valor_atravessa_os_escritores.sql`, mergeada e não aplicada. A edge
`omie-vendas-sync` da main apura `descontoItemOmie` e o manda no payload. A RPC velha recebe o
`jsonb` e **descarta o campo**. Sem erro, sem 500, sem entrada em log: `order_items.desconto_valor`
seguiria NULL (71.006/71.006), o sync reportaria sucesso, e o ledger de deploy passaria a atestar
`CONFERE` sobre metade de uma entrega.

O `precondicao-banco.ts` previa este dia. Ele declarava o limite e o gatilho de reentrada:

> o primeiro incidente em que a RPC EXISTIA e mesmo assim a edge quebrou por contrato

O gatilho disparou — e o incidente foi **pior que o previsto**: a RPC não quebrou. O modo de falha
que o cabeçalho imaginava (`Could not find the function`) é barulhento e se auto-denuncia. Este é
silencioso, e a diferença importa: um gate que existe para impedir "edge no ar antes da DDL" não
pode depender de a DDL faltante *fazer barulho*.

## Por que o conserto óbvio estava errado

"Compare o corpo em prod com o corpo do repo e reprove a divergência" **trava todo deploy**. Neste
banco, apply manual diverge do repo por DESENHO (`docs/agent/database.md` §4: a última a recriar
vence; ~210 objetos em prod sem `CREATE` commitado; o `audit:migrations` já classifica 108 funções
como DERIVA).

Medido nas **65 RPCs literais chamadas pelas 97 edges** do repo:

| | |
|---|---|
| corpo bate com a última migration | **48** |
| corpo diverge do repo | **14** |
| sem `CREATE` em migration nenhuma | 2 |
| ausente em prod | 1 |

Das 14 divergências, **11 são benignas** — edição direta no SQL Editor, de junho a agosto. Um gate
que reprovasse divergência bloquearia 17 de 65 e seria desligado na primeira semana. O próprio
arquivo já tinha escrito a regra que o proibia:

> gate de deploy que bloqueia sem razão não é conservador: ele ensina o operador a contorná-lo, e
> aí não gateia mais nada.

## O discriminador: evidência POSITIVA de atraso

A pergunta certa não é *"o corpo bate com o repo?"* e sim **"a migration desta leva foi aplicada?"**.
Ela tem resposta positiva e barata:

| classificação | o que se MEDE | efeito |
|---|---|---|
| `EM_DIA` | o corpo vivo é o da última migration que define a função | libera |
| `CORPO_ANTERIOR` | o corpo vivo é um corpo que **este repo commitou antes** do atual | **BLOQUEIA** |
| `DERIVA` | o corpo vivo não bate com nenhuma versão commitada | declara, não bloqueia |
| `INDECIDIVEL` | overload, `prosqlbody`, `LANGUAGE c`, sem `CREATE` commitado | declara, não bloqueia |

"Prod está rodando uma versão que o próprio repo commitou ANTES desta" é fato do catálogo. É
categoricamente diferente de "o corpo diverge": divergir é o estado normal; **regredir para uma
versão commitada não é**.

Nas mesmas 65: **48 EM_DIA · 3 CORPO_ANTERIOR · 11 DERIVA · 2+1 fora de alcance**. As 3 são
exatamente as três funções da migration pendente. Zero falso positivo sobre as 11 derivas.

A taxonomia **já existia** no repo — é a Seção 3 do `audit-custom-migrations.ts`, desde 2026-08-29.
O que faltava era ela estar no caminho do deploy: lá ela vive num SQL que alguém precisa colar, que
é a mesma prosa executável do #2285 ("emitir a query é confiar que alguém rode").

## O que o Codex derrubou (challenge, `gpt-6-astra` max, 310s)

Verifiquei cada alegação antes de aceitar; três eram defeitos **reproduzíveis** do extrator que eu
ia promover a gate — todos capazes de FABRICAR o "corpo esperado":

| entrada | o que o extrator devolvia |
|---|---|
| `CREATE f() AS $$SELECT 2$$` + o mesmo create **comentado** para rollback | o corpo do COMENTÁRIO |
| `f()` sem dollar-quote, seguida de `g() AS $$…$$` | o corpo de **g** creditado a **f** |
| tag `$v1$` (com dígito) | idem: corpo roubado da função seguinte |

O conserto usa uma propriedade que `removerComentariosSql` já tinha e ninguém explorava: ele
**preserva os offsets**. Delimitar no texto mascarado e fatiar do CRU dá as duas coisas —
imunidade a comentário na hora de decidir onde o corpo começa, e comentários internos preservados
no hash (que é o que `pg_proc.prosrc` guarda). Delta no `audit:migrations`: **+1 definição
recuperada, zero perdas**.

Outros quatro, aceitos:

- **Receita EXATA** (`md5(prosrc)`), não a normalizada do audit: o colapso `\s+ → ' '` iguala
  `SELECT 'a  b'` e `SELECT 'a b'`, que o Postgres executa diferente. Mesmas 48 em dia — precisão
  sem custo de recall.
- **Conjunto ACOPLADO**: conferir só o que a leva chama deixa escapar um dos três escritores.
  `20260908215704` recria os três, mas `reconciliar_pedidos_omie` é chamada por `sync-reprocess`,
  não por `omie-vendas-sync`. A unidade de apply é a MIGRATION (`BEGIN; … COMMIT;`), então o gate
  confere todas as funções dela — inclusive as que nenhuma edge da leva chama.
- **Árvore pelo SHA resolvido**, não pelo nome mutável `origin/main`: com ~30 worktrees, a ref pode
  se mover no meio da execução e o pacote sairia com a fatia de um commit e as migrations de outro.
- **O rótulo afirma só o que se mede**: `CORPO_ANTERIOR`, não "não aplicada". O catálogo não guarda
  histórico de apply — uma migration aplicada e depois sobrescrita por uma antiga daria a mesma
  leitura. A AÇÃO é a mesma, e é ela que o relatório manda fazer.

Recusado, com o motivo escrito: o manifesto de capacidades por consumidor ("edge@sha exige
desconto/v1"). É o desenho certo para provar compatibilidade, e é uma entrega própria — o eixo aqui
prova *ordem de apply*, não *compatibilidade semântica*, e isso fica declarado no cabeçalho.

## A lição mais cara: a 1ª versão do conserto reencenou o próprio bug

O eixo novo passou **VERDE contra prod**, com a migration pendente, e **todos os testes verdes**.

Causa: a primeira versão filtrava candidatos com
`git grep -l -E "\b(nome1|nome2)\b"`. **`\b` não é word-boundary em POSIX ERE.** O grep casou zero
arquivos, saiu 1 sem escrever em stderr, e o código leu isso como "nenhum candidato" — histórico
vazio, nada a conferir, leva liberada. Fail-open silencioso, a mesma classe que o PR existe para
fechar, dentro do PR que a fecha.

Três coisas ficam disso:

1. **Só rodar contra prod pegou.** A suíte inteira era verde. O `--sem-rede` e os fakes reproduzem
   o protocolo, não o dialeto do `git` real.
2. **O conserto não foi tirar o `\b` — foi tirar o FILTRO.** `git cat-file --batch` lê as 721
   migrations (6,4 MB) num spawn só em **0,05s**, mais rápido que o `git grep` que o filtro
   economizava. Um otimizador com um modo de falha silencioso não estava pagando por si.
3. **Controle positivo por CAMADA.** Os quatro eixos antigos provam que o BANCO respondeu; nenhum
   prova que o REPO foi lido. O eixo 5 traz os seus (`inventarioDaRef`, `funcoesConhecidas`), e a
   distinção entre eles é fina de propósito: "zero arquivos lidos" é legítimo quando o filtro não
   acha nada, mas "arquivos lidos e zero funções extraídas" é extrator quebrado.

## Falsificação

`bun run falsificar:gate-corpo` — controle verde **antes** de qualquer sabotagem, e o script
**aborta sem sabotar** se o controle falhar (sabotagem sobre base vermelha não distingue "pegou" de
"reprova tudo"). Os dois blocos importam por igual:

- **sabotagens** (têm de virar o veredito): corpo anterior → `BLOQUEADA`; repo lido vazio →
  `INCERTA`; arquivos lidos sem funções → `INCERTA`.
- **não-sabotagens** (têm de seguir verdes): deriva, overload, corpo não textual, função sem DDL
  commitada. Sem este bloco, um gate que reprova tudo passaria — e ele bloquearia 17 das 65.

O falsificador foi ele próprio falsificado: com o ramo `CORPO_ANTERIOR` removido, com `DERIVA`
passando a bloquear, e com o controle positivo desligado, ele fica **vermelho** nas três.

## Evidência

```
antes:  exit 0 · "✅ pré-condição de banco satisfeita"
depois: exit 3 · nomeia as 3 RPCs, a migration em prod e a que falta aplicar, e avisa
        "não espere erro: a RPC velha aceita o payload novo e DESCARTA o campo em silêncio"
```

test 8684 · typecheck · lint · knip · shellcheck 407 · test:hooks · claude:size — todos verdes.

## O que segue descoberto (declarado, não deduzido)

`DERIVA` não bloqueia, e isso é fail-open **deliberado**: uma função editada à mão que também ignore
o campo novo produz a mesma falha silenciosa e passa. Sem um `CREATE` commitado para comparar, o
eixo não tem como distingui-la de uma edição manual legítima — e o bloqueio falso mata o gate
inteiro. **O que fecha esse resto é commitar a DDL** (aí a função sai de `DERIVA`), não mais código
aqui.

Também fora de alcance: `ALTER FUNCTION`, mudança só de atributo (`SECURITY DEFINER`,
`search_path`), `DROP`+`CREATE` com corpo idêntico, e COLUNA — o gate de coluna continua ausente.
