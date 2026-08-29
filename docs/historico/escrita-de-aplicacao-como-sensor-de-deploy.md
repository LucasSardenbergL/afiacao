# A ESCRITA de aplicação como sensor de deploy — e as três vias que pareciam servir e teriam mentido

> **Verificação do #2086 (`elevenlabs-transcribe`, commit `a8c3e0c47`, correção de SEGURANÇA), em
> 2026-08-29.** Levantada pela rede de segurança do repo para edge de terceiro que mergeia sem
> deploy (o ritual `/fecho` do #2090 a detectou na janela dele). O veredito foi **já estava no ar** —
> nada a pedir ao founder, deploy redundante evitado. O durável não é o veredito: são as **três vias
> descartadas** e o porquê de cada uma. A via que funcionou virou ritual na
> [`lovable-deploy-verify`](../../.claude/skills/lovable-deploy-verify/SKILL.md) pelo #2095; este doc
> guarda o que não cabe lá — o que se tentou antes, e o que cada tentativa teria afirmado de errado.

## O veredito e a cadeia que o sustenta

`ia_consumir_cota` faz `INSERT INTO public.ia_uso_evento (user_id, funcao)` **depois** de todos os
`RETURN` de bloqueio. Quatro linhas com `funcao='elevenlabs-transcribe'`, entre 00:32:26Z e
00:33:27Z, contra o merge às **00:17:10Z**:

| elo | evidência |
|---|---|
| existe rastro | 4 linhas em `ia_uso_evento` para a função |
| é pós-merge | todas ~15 min depois do merge |
| só o bundle novo emite | o único caller do slug é `supabase/functions/elevenlabs-transcribe/index.ts:98`<!--cita: 'elevenlabs-transcribe',-->, nascido no PR — o bundle velho nem importava `_shared/ia-cota.ts` |
| foi uso real | autor com role `master`, 4 chamadas em 61 s (12–27 s de intervalo): cadência de ditado, não de `SELECT` no editor |
| não quebrou nada | o `INSERT` mora no ramo PERMITIDO ⇒ o seed de `ia_uso_limite` entrou antes do deploy; não houve o 503 `sem_limite` |

## Via descartada 1 — a "mensagem de erro única" tem uma pré-condição a mais que a escrita

A técnica do [#2035](fail-closed-como-sensor-de-deploy.md) diz: mensagem de erro única no repo prova
o BUNDLE. As ressalvas já registradas lá cobrem mensagem genérica e string que também vive em
`_shared/` ou noutra edge. **Falta uma, e é exatamente a que este caso viola.**

`{"error":"Token inválido"}` parecia a candidata perfeita — o PR a introduziu, com status 401, no
guard novo de `claims.sub`. Mas a **mesma edge já a emitia antes**, no gate de assinatura do JWT:

| pergunta | resposta |
|---|---|
| a string é nova no **trecho** que o PR criou? | sim |
| a string é nova na **edge**? | **não** — `supabase/functions/elevenlabs-transcribe/index.ts:39`<!--cita: error: 'Token inválido'--> já a emitia |
| a string é única no **repo**? | **não** — 10 arquivos, incluindo 6 outras edges |

Um 401 com essa mensagem seria emitido pelos **dois** bundles, com o mesmo corpo e o mesmo status. A
leitura "recebi `Token inválido` ⇒ bundle novo" é falsa, e falha no sentido caro: **falso positivo**,
que ENCERRA a verificação — o mesmo formato de erro da sentinela não-exclusiva do Passo 4.

> **Regra:** a unicidade que importa é a do **bundle**, não a do diff. O `+` no diff prova que a
> linha é nova; não prova que a **string** é. Meça no pai, com resposta positiva:
> `git show <sha>^:<arquivo> | grep -c '<string>'` — **zero** é a condição; qualquer outro número
> mata a via. É o `--pai` do Passo 4 aplicado a edge: a pergunta é a mesma ("é nova?"), só o
> universo muda.

## Via descartada 2 — `net._http_response` é estruturalmente cego para edge que o USUÁRIO chama

`pg_net` só registra o que o **BANCO** emitiu via `net.http_post`. Edge chamada pelo browser nunca
passa por lá. Não é retenção curta (o `pg_net.ttl = 6 h` seria o problema seguinte) — é **ausência de
mecanismo**: a tabela não observa esse universo.

Consultar e ler "0 linhas" seria `ausente ≠ zero` no formato mais traiçoeiro: uma tabela que
responde, com exit 0, sobre algo que ela nunca poderia ter visto.

> **Regra:** antes de abrir `net._http_response`, pergunte **quem chama a edge**. Cron/banco → a via
> serve. Usuário/frontend → a tabela é muda, e o silêncio dela não é sinal.

## Via descartada 3 — a sonda ATIVA atravessaria o próprio buraco que a fatia veio fechar

Provar por comportamento exigiria alcançar o 401 novo. Duas condições, ambas satisfazíveis: o guard
de `sub` fica **depois** da validação do arquivo (então a chamada precisa levar áudio válido), e
`sub` só falta em JWT de **assinatura válida sem sujeito** — o `anon key` do projeto é precisamente
isso, e passaria pelo `getClaims`.

O que reprova a via é o **ramo negativo**. Se o bundle fosse o VELHO, essa mesma chamada passaria
direto à ElevenLabs e **gastaria o orçamento de IA** — o recurso que o #2086 veio proteger. A sonda
pagaria o buraco para medir o buraco, e o gasto é maior justamente na hipótese que ela existe para
detectar.

> **Regra de desenho de sonda:** quando o caminho ATIVO de prova atravessa o recurso caro que a
> fatia veio proteger, a via passiva deixa de ser conveniência e passa a ser a única honesta. Não
> havendo passiva, o custo do ramo negativo entra na decisão **antes** de invocar — não depois.

## Meta-lição — o artefato já estava na main, e a busca por PR foi cega

Ao registrar a lição, `gh pr list --state open` filtrando por `lovable-deploy-verify` voltou
**vazio** — lido como "ninguém mexeu, pode escrever". Estava errado: o #2095 já havia **mergeado**
essa mesma via na skill, com estes números exatos. PR mergeado não aparece em `--state open`, e
buscar por TÍTULO não o acharia de outro jeito.

Quem achou foi o `git grep` do **símbolo** em `origin/main` (`ia_uso_evento`), como manda o CLAUDE.md
§Multi-sessão. Sem ele, teria saído um PR duplicado sobre uma superfície quente. O detalhe operacional
que faz a diferença: o worktree estava **3 commits atrás** — `git fetch` sozinho não bastaria se a
busca fosse feita em `HEAD` em vez de `origin/main`.

> **Regra:** "conflito de arquivo" e "tarefa já entregue" são eixos diferentes. Antes de escrever,
> procure o ARTEFATO em `origin/main`; a lista de PRs abertos é cega para tudo que já mergeou.

## Referências

- [`lovable-deploy-verify`](../../.claude/skills/lovable-deploy-verify/SKILL.md) — Passo 4, §N3 PASSIVO por ESCRITA DE APLICAÇÃO (o ritual; #2095)
- [fail-closed-como-sensor-de-deploy.md](fail-closed-como-sensor-de-deploy.md) — #2035, a mensagem única (que este doc restringe)
- [verificabilidade-do-conjunto-orquestrado.md](verificabilidade-do-conjunto-orquestrado.md) — o marcador plantado, e o `modo:"background"` que esvazia o eco
- [verificar-sonda-versao.md](verificar-sonda-versao.md) — a escada N1/N2/N3 e os anti-sinais já reprovados
