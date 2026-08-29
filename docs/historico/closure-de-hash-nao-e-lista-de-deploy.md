# Closure de hash ≠ lista de deploy — e o veredito lido da sessão errada (2026-08-29)

Verificação das 4 edges alteradas entre 25/08 e 27/08 (`carteira-rebuild`, `omie-analytics-sync`,
`enviar-pedido-portal-sayerlack`, `sayerlack-captura-precos`). Desfecho: as 4 `DEPLOY CONFIRMADO`.
Duas armadilhas apareceram no caminho, e nenhuma delas estava em `docs/`.

## 1. A `fecharGrafo()` é autoritativa para o HASH e ERRADA para o DEPLOY

Para montar o prompt de deploy, a fatia foi derivada da `fecharGrafo()` de
`scripts/sonda-fingerprint.ts` — a MESMA função que produz o `fonte`. Parecia a escolha óbvia: é o
fecho transitivo dos imports locais, é o que o fingerprint mede, e usá-la evita reconstruir a fatia
lendo `import` a olho.

**Ela omite, calada, um arquivo que o bundle precisa.** Medido nesta main:

```
closure tem sonda-versao.ts:       true
closure tem sonda-fingerprints.ts: false
```

E `sonda-versao.ts` importa o mapa na linha 14 (`import { FONTE_SHA256 } from "./sonda-fingerprints.ts"`).

A exclusão é **deliberada e correta** no lado do hash — o cabeçalho do gerador a explica: o mapa é a
SAÍDA, incluí-lo seria ponto-fixo (mudar o arquivo mudaria o hash que muda o arquivo). O erro não é
do gerador; é assumir que o conjunto que ele fecha responde a OUTRA pergunta. São duas perguntas
diferentes com respostas que diferem por exatamente um arquivo:

| pergunta | conjunto certo |
|---|---|
| que bytes o `fonte` mede? | `fecharGrafo(index.ts)` |
| que arquivos o deploy tem de nomear? | `fecharGrafo(index.ts)` **∪ `_shared/sonda-fingerprints.ts`** |

**O modo de falha é o pior possível** — irmão do #2020, e pior de ler: deployar sem o mapa não
quebra o boot (o import resolve, o arquivo existe no bundle anterior), mas o `FONTE_SHA256` servido
é o VELHO. A sonda responde `fonte` desatualizado ou `nao-mapeada` — ou seja, **quem descobre é a
própria sonda que existia para provar o deploy**, e ela nasce cega justamente na fatia que a
instrumenta. O veredito `DEPLOY PARCIAL` do bloco de leitura existe para pegar exatamente isto.

**Regra:** derivar a fatia de deploy da `fecharGrafo()` está certo — desde que se some o mapa ao
final. Um check barato que segura: exigir que cada arquivo do closure ∪ {mapa} apareça no prompt, e
**falsificá-lo** removendo uma linha (feito aqui: removendo o `sonda-fingerprints.ts` o check ficou
vermelho nas 2 edges; no original, verde).

## 2. Com ~30 sessões paralelas, veredito da sessão errada é indistinguível do certo

No meio da verificação veio o relato `DEPLOY CONFIRMADO nas quatro`. Era **verdade** — de outras
quatro edges. Na janela de 6h do `pg_net.ttl`, as edges realmente sondadas foram
`omie-sync-estoque`, `omie-sync-nfes-recebidas`, `omie-sync-pedidos-compra` e `omie-vendas-sync`;
as 4 em verificação tinham **zero** linhas. Todas as quatro sondadas batiam com a main, então o
resultado lido era legítimo — só pertencia a outro bloco.

**O que torna isto traiçoeiro é a coincidência do NÚMERO.** "Quatro edges, todas confirmadas" casa
com a expectativa perfeitamente; nada no texto do resultado denuncia a troca. E três das quatro
estavam na lista de "já verificadas" do próprio briefing — ou seja, outra sessão re-sondando o que
já estava provado produz exatamente o relato que se espera ver.

**O que separou** foi não aceitar o relato: reler o veredito do banco pelos `request_id`. E o
controle importou — a primeira leitura voltou vazia, o que sozinho é **ausência de dado**, não
prova. Rodar a MESMA query com uma edge que se sabia presente (`omie-sync-estoque`) provou que a
query enxergava, e só então o vazio virou veredito.

**Regra:** relato de veredito não é veredito. Peça o `request_id` e leia você mesmo — é 1 query, e
o bloco de leitura já casa o campo `edge` da resposta com a edge perguntada, que é o que impede uma
resposta de outra edge passar por esta. Antes de ler um vazio como resposta, rode o controle
positivo com uma linha que você sabe existir.

## Rodapé — o que não mudou

Os dois pontos acima são de PROCESSO; nenhum código de produção mudou. A verificação em si fechou
verde nas quatro, com `versao` + `fonte` + eco `probe:true` + campo `edge` casando, lidos por
`request_id` (nunca `ORDER BY id DESC LIMIT 1`).
