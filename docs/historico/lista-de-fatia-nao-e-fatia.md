# A lista de fatia não é a fatia — re-derive antes de montar o prompt

> 2026-09-05, fechando a `omie-nfe-recebimento` que saiu `SEM_PROVA` no `/fecho`.
> Alvo: o Passo 3 da skill `lovable-deploy-verify`.

## O que aconteceu

A tarefa chegou bem-formada, e trazia a fatia **já medida, com a procedência declarada** — "closure
de imports (`fecharGrafo`), fatia de deploy = closure ∪ {mapa}" —, em 5 arquivos: `index.ts`,
`versao.ts`, `_shared/auth.ts`, `_shared/sonda-versao.ts`, `_shared/sonda-fingerprints.ts`. Até a
sutileza certa vinha explicada: o mapa é excluído de propósito pela `fecharGrafo()` e ainda assim
precisa ir no deploy.

Re-rodando a `fecharGrafo` na `main` sincronizada, o closure é outro:

```
supabase/functions/_shared/auth.ts
supabase/functions/_shared/sonda-versao.ts
supabase/functions/omie-nfe-recebimento/index.ts
supabase/functions/omie-nfe-recebimento/resposta.ts   ← ausente na lista recebida
supabase/functions/omie-nfe-recebimento/versao.ts
```

Fatia = closure ∪ {mapa} = **6 arquivos, não 5**. O `resposta.ts` nasceu no PRÓPRIO PR (#2201, `A`
no `--name-status`), que acrescentou ao `index.ts` o
`+import { statusHttpEfetivacao } from "./resposta.ts"`. Um prompt de deploy com os 5 sobe uma
função cujo import não resolve: a edge não boota (#2020) e quem descobre é a sonda que existia
para provar o deploy.

## Por que este caso não é nenhum dos irmãos

| doc | a ferramenta erra? | a causa real |
|---|---|---|
| [closure-de-hash-nao-e-lista-de-deploy.md](closure-de-hash-nao-e-lista-de-deploy.md) | não — a exclusão do mapa é deliberada | conjunto certo para a OUTRA pergunta |
| #2127 (em [fatia-de-deploy-envelhece.md](fatia-de-deploy-envelhece.md)) | **sim** | `--name-status` é cego a import novo de arquivo PRÉ-EXISTENTE |
| [fatia-de-deploy-envelhece.md](fatia-de-deploy-envelhece.md) | não | terceiros tocaram o closure DEPOIS |
| **este** | **não** | **a lista chegou pronta e estava incompleta** |

Aqui as duas ferramentas acertavam, e isso foi medido, não presumido: o `--name-status` do #2201
lista `A supabase/functions/omie-nfe-recebimento/resposta.ts`, e a `fecharGrafo` da main o inclui
(rodada, saída acima). Não houve cegueira de ferramenta, nem envelhecimento por PR de terceiro —
o defeito estava na **cópia**. E nada na lista o denuncia: 5 arquivos, procedência nomeada e o mapa
corretamente somado ao fim são exatamente o que produz quem seguiu o procedimento inteiro.

## A regra

Metade desta transcrição **já foi automatizada**, e pelo mesmo motivo:
[sonda-le-worktree-defasado.md](sonda-le-worktree-defasado.md) registra que o gerador do SQL existe
porque digitar `versao_esperada`/`fonte_esperada` na unha produz veredito falso. Do lado da
**fatia de arquivos** a transcrição continua manual — o prompt do Passo 3 é escrito à mão — e falha
do mesmo jeito, só que o desfecho é pior: marcador errado dá veredito falso, lista errada deixa a
edge sem bootar.

**Lista de fatia recebida pronta é entrada não-verificada, por mais bem-formada que seja.** É a irmã
de *"relato de veredito não é veredito"* (§2 do `closure-de-hash-nao-e-lista-de-deploy.md`), do lado
do DEPLOY em vez do lado da LEITURA: lá se pede o `request_id` e se lê o banco; aqui se re-roda o
closure. Custa uma linha, no worktree já sincronizado com `origin/main`:

```bash
bun -e 'import {RAIZ_EDGES,fecharGrafo} from "./scripts/sonda-fingerprint"; console.log(fecharGrafo(`${RAIZ_EDGES}/<edge>/index.ts`).join("\n"))'
```

…e some `_shared/sonda-fingerprints.ts` ao resultado. O `git fetch` que a receita já exige antes de
gerar o SQL (para o `versao_esperada` não sair velho) vale igual para a LISTA — são a mesma
sincronia, usada por duas perguntas diferentes.

## Rodapé — o desfecho, e um detalhe que quase custou a leitura

Nenhum código de produção mudou nesta sessão. A verificação: sonda 1 (`request_id` 70287) devolveu
`PRE_SONDA_FONTE` — `v1.0-sensor-inicial`, sem `fonte`, sem eco de `edge`: bundle anterior ao #1789
E ao #1998, com a `v1.1` do #2201 nunca deployada. Deploy dos 6 arquivos pelo founder; sonda 2
(70362) devolveu `DEPLOY CONFIRMADO` (`v1.1-falha-sai-nao-2xx` + `fonte e69f5f4f…` + eco do slug), e
o `edges-pendentes.sh` virou `NO_AR` trocando o próprio exit de `1` para `0`.

⚠️ **Quando o bundle suspeito é PRÉ-eco, colar o `request_id` no `ids` não é opcional.** O bloco de
leitura acha a linha pelo `content->>'edge'`, campo que só nasceu no #1789 — e era exatamente o que
o bundle no ar não emitia. Sem o `ids`, a leitura sairia "nenhuma sonda na janela: INDETERMINADO",
ou seja **ausência de dado no lugar de uma pendência PROVADA**, que é a classe do #2156 uma geração
de campo atrás (o mecanismo está em
[sonda-eco-passivo-sem-colagem.md](sonda-eco-passivo-sem-colagem.md); o corolário é este).
