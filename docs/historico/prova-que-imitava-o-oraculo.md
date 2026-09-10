# A prova que imitava o oráculo — reimplementar `format()` com `sed` acerta por coincidência do corpus

**2026-09-09.** `db/test-canaria-veredito.sh` julga a ordem dos ramos do CASE que separa
**BUNDLE VELHO SERVINDO** (⇒ redeployar) de **CANÁRIA VERMELHA** (⇒ investigar regressão) — dois
desfechos opostos em money-path. Ela não confere um SQL commitado: gera o SQL pelo gerador do repo
e o EXECUTA num PG17 efêmero.

Só que o SQL que ela executava não era o que o Postgres produziria. O passo 2 (o CASE) é **escrito**
pelo passo 1, por `format($sonda$…$sonda$, m.ids)`. A prova não executa o passo 1 — o artefato de
fixture é inerte por desenho — então ela **reconstruía** o passo 2 imitando o `format()` com shell:

    extrai_leitura … | sed "s|%1\$L|'$mapa'|" | sed 's|%%|%|g'

O PR que fechou a igualdade CLI × fixture (#2444) já trazia a ressalva do parecer Codex: aquela
igualdade certifica o **artefato entregue** à transformação, não a **fidelidade da transformação**.

## A medição

`format()` real do PG 17.10 contra o pipeline de `sed`, mesmos insumos, corpo e mapa por arquivo nos
dois lados, comparação por `md5` dentro do próprio banco. **8 de 11 classes divergem:**

| # | insumo | `format()` real | os dois `sed` |
|---|---|---|---|
| C0 | 1 sentinela, mapa comum (**o caso de hoje**) | — | **igual** |
| C1 | dois `%1$L` na MESMA linha | interpola os dois | o 2º fica literal (falta `/g`) |
| C2 | dois `%1$L` em linhas diferentes | — | igual (o `sed` opera por linha) |
| C3 | mapa com aspa simples | `'{"i''t":1}'` | `'{"i't":1}'` — SQL inválido |
| C4 | mapa NULL | `NULL` | `''` |
| C5 | mapa com backslash | `E'{"a\\b":1}'` | `'{"ab":1}'` — perdeu o `\` |
| C6 | corpo com `%%1$L` | `%1$L` | `%'{…}'` |
| C7 | mapa contendo `%%` | mantém `%%` | colapsa para `%` |
| C8 | mapa contendo `&` | literal | `&` vira a match inteira |
| C9 | corpo com `%%` simples | — | igual |
| C10 | mapa contendo `\|` | literal | o `sed` MORRE ("bad flag") |

O artefato de hoje tem `%1$L` **1×** e `%%` **0×**. A transformação estava correta **por coincidência
do conteúdo**, não por desenho: defeito LATENTE, não ativo — nenhum veredito de produção saiu errado.

> Quando uma prova precisa do produto de uma função que ela não pode executar, há duas saídas:
> imitar a função, ou **arranjar quem a execute**. A imitação só é verificável contra insumos que
> alguém escolheu — e o corpus que a mantém correta não é contrato de ninguém. Se o oráculo já está
> de pé no teste, imitá-lo é a escolha cara.

## O que ficou

Quem executa o `format()` agora é o **PG17 que a prova já sobe** (`format(pg_read_file(corpo),
pg_read_file(mapa))`, superuser local). O oráculo passa a ser o Postgres, e não sobra imitação para
divergir — o que, pelo mesmo parecer, dispensa a asserção de fidelidade: comparar duas chamadas
nativas com os mesmos argumentos é tautologia.

Duas alternativas foram **medidas e descartadas**:

- **manter os `sed` e comparar com o `format()` real** — acrescenta um detector, mas conserva um
  imitador já demonstrado incompleto;
- **executar o passo 1 inteiro contra a armadilha** (o `net.http_post` falso do teste) — mais fiel
  na aparência, impossível na prática: a armadilha devolve **`7777` FIXO**, então todos os alvos
  colidiriam num id só e o mapa deixaria de distinguir canárias.

E o **recorte** ganhou dente, porque não tinha nenhum. Medido: com a tag de fechamento trocada, o
`awk` seguia até o EOF e devolvia **8257 B** onde o bloco legítimo tem **8037** — 220 B de FORA,
incluindo o `RAISE` do envelope inerte. A sonda do chamador (`grep -q 'AS veredito'`) **não pega**:
ela pergunta se o recorte tem o CASE, não se ele é o recorte CERTO. Agora o recorte confere abertura
E fechamento, emite **zero byte** quando falha (como a CLI faz nas recusas), confere a **aridade** dos
blocos (ordinal não é identidade) e preserva o **LF de abertura**, que era descartado — 8037 B contra
8038 B reais. Inócuo no SQL, mas "byte a byte" só vale se for byte a byte.

## Dois erros meus que a medição pegou

**O caso NULL não é o da trava fechada.** Eu ia instalar uma asserção de leva vazia com esse nome.
Medido: a trava é um `CASE` que **preserva a linha** com `request_id` nulo, então o agregado sai
`{"nome": null}` — um par de valor nulo, que `jsonb_each_text` lê como **1 par**. Agregado SQL `NULL`
exige `disparos` com **zero linhas**, e o gerador **recusa leva vazia** (exit 1, zero bytes): o caminho
é **inalcançável**, e testá-lo seria caminho morto. O comentário de `corpoDoPassoDeLeitura` afirmava o
contrário e foi corrigido — a linha errada estava no gerador, não só na minha cabeça.

**Divergência medida não é bug em produção.** C3/C5/C8/C10 pedem aspa, backslash, `&` ou `|` num nome
de edge; C1/C6/C7 pedem um gerador que ainda não existe. Nenhuma é alcançável hoje. O que justifica a
correção é a **classe**, não um incidente — e dizer o contrário seria vender defeito latente como
incêndio.

**Ver também:** [prova-que-parou-de-ver-o-gerador.md](prova-que-parou-de-ver-o-gerador.md) (a mesma
prova, cega ao gerador e à CLI), [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md),
[gates-textuais-cegos.md](gates-textuais-cegos.md) (verde por cegueira do medidor).
