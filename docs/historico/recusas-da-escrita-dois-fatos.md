# "Base mudou" contava a corrida perdida — `recusadas` eram dois fatos com consertos opostos

**2026-09-14** · `supabase/functions/omie-desconto-backfill/` · `_shared/desconto-backfill.ts` · money-path · continuação de [cobertura-que-o-campo-ausente-tambem-daria.md](cobertura-que-o-campo-ausente-tambem-daria.md) (sensor v1.3, #2467) e do #2475 (a RPC que contava as próprias escritas)

## O que aconteceu

`desconto_backfill_aplicar(p_linhas jsonb)` devolve `{pedidas, aplicadas, recusadas, ja_apuradas}`, com `recusadas = pedidas − aplicadas`. Esse resíduo junta dois fatos:

- **(a) a base mudou** — o trio (SKU, quantidade, preço) da linha não é mais o que a leitura que montou o plano viu. Conserto: reler o Omie.
- **(b) corrida perdida** — a linha JÁ tinha `desconto_valor` quando a escrita chegou, porque outro writer ou uma execução sobreposta do backfill gravou na janela entre a leitura e a RPC. Conserto: nenhum — o guard `desconto_valor IS NULL` fez o certo.

A edge lia só `aplicadas`/`recusadas` e somava TODO `recusadas` em `escrita_recusada_base_mudou`, nos dois caminhos (lote e retry linha a linha). Com corrida perdida o rótulo mandava o operador reler o Omie — o conserto oposto ao certo.

O campo que separa os dois fatos existia desde a 1ª versão da RPC, e por isso ninguém sentia falta: ele contava errado (depois do UPDATE, somando as linhas que a própria chamada escrevia — corrigido no #2475, aplicado em prod em 2026-09-11, recibo #58 em `db_aplicacoes`) e a edge nunca o leu. O #2475 consertou o PRODUTOR, e o cabeçalho da própria migration registrava que "a edge não lê `ja_apuradas`". Esta entrega é o CONSUMIDOR.

## A forma generalizável

> **Resíduo aritmético (`total − sucesso`) não é motivo.** `recusadas = pedidas − aplicadas` é exato e operacionalmente mudo quando o operador precisa escolher o conserto. Antes de dar RÓTULO a um resíduo, pergunte: *todo elemento dele pede o mesmo conserto?* Se não, o rótulo mente sempre que o outro fato acontece — e o campo que reparte o resíduo é dado como qualquer outro: ausente ≠ zero.

Corolário do §7 do `money-path.md` no eixo produtor × consumidor: **consertar o campo no produtor não conserta o rótulo no consumidor.** A correção só termina quando alguém lê.

Segundo corolário, que veio do Codex: **repartir um resíduo por uma contagem feita em OUTRO statement só é exato sem escritor concorrente.** Em READ COMMITTED o mundo muda entre a contagem e a escrita, inclusive durante a espera pelo lock. Com isso, os dois rótulos trocam de fato nos dois sentidos. O motivo exato por linha tem de ser decidido no MESMO statement que decide o desfecho. Fora dele, documente a partição como aproximação e diga em que condição ela vale.

## O desenho: três formas, e a do meio não tem `base_mudou`

`lerRetornoEscrita(retorno, enviadas)` devolve:

| forma | quando | o que a edge soma |
| --- | --- | --- |
| `classificado` | `aplicadas`, `recusadas` e `ja_apuradas` legíveis, soma fecha com as enviadas, `ja_apuradas ≤ recusadas` | `recusadas − ja_apuradas` em `escrita_recusada_base_mudou`; `ja_apuradas` em `escrita_recusada_ja_apurada` |
| `nao_classificado` | `ja_apuradas` ausente/null, ilegível (string numérica, fração, negativo, NaN) ou maior que `recusadas` | `recusadas` inteiro em `escrita_recusada_nao_classificada`; a causa em `diagnostico.escrita_retornos_nao_classificados` |
| `ilegivel` | sem `aplicadas`/`recusadas` legíveis, ou `aplicadas + recusadas ≠` linhas enviadas | nada — a edge **lança** (HTTP 500) |

As escritas fecham: `escrita_pedida = aplicada + recusada_base_mudou + recusada_ja_apurada + recusada_nao_classificada + linhas_em_pedido_incoerente`.

Três decisões, cada uma com o motivo:

1. **Ausência estrutural, não zero.** A forma `nao_classificado` não tem campo `base_mudou`: nenhum consumidor consegue ler "0 corridas perdidas" num retorno que não disse nada. `Number(r.ja_apuradas ?? 0)` teria jogado as recusas em "base mudou" — o motivo fabricado a partir do campo ausente.
2. **Degradar × lançar é assimétrico de propósito.** Sem `ja_apuradas`, a ESCRITA continua sabida (`aplicadas` legível): só o diagnóstico degrada, e parar o backfill por um campo de observabilidade seria desproporcional. Sem `aplicadas`/`recusadas`, a edge não sabe o que escreveu — mesma régua do SQLSTATE desconhecido ("erro que não sei nomear propaga"). O `Number(r?.aplicadas ?? 0)` da v1.3 fabricava "0 aplicadas" de um retorno vazio. ⚠️ Isto vai além da letra da tarefa, que falava de `ja_apuradas`, e fica registrado como decisão.
3. **A soma contra as linhas ENVIADAS** é a única conferência que não depende da RPC: a edge sabe quantas mandou. Soma que não fecha é outro contrato respondendo, e repartir recusas sobre ela classificaria um número que não descreve a chamada.

A causa aparece mesmo com zero recusas (`nao_classificado` com `recusadas: 0`): o sinal "a RPC deste ambiente não fala o contrato" tem de chegar antes da primeira recusa.

A SOMA também mora no módulo (`somarRetornoEscrita`), e não na edge: com ela dentro da edge, `+= r.base_mudou + r.ja_apuradas` reintroduzia o rótulo duplo sem nenhum teste ficar vermelho (Codex). A edge ficou com um repasse de uma linha, chamado nos dois caminhos.

## Limites conhecidos (registrados, não corrigidos aqui)

- **A partição é exata só sem escritor concorrente durante a chamada** (Codex). A RPC conta `ja_apuradas` num statement e escreve em outro, e em READ COMMITTED os contadores trocam de fato nos DOIS sentidos:
  - linha NULL na contagem que outro writer preenche antes do UPDATE sai como `base_mudou`, sendo corrida perdida. Isso vale **inclusive durante a espera pelo lock da linha**, em que a condição é reavaliada — a janela não é de microssegundos;
  - linha contada como já apurada cujo desconto a reconciliação invalida (preço mudou → desconto NULL, ver `20260908215704_desconto_valor_atravessa_os_escritores.sql`) sai como `ja_apuradas`, e precisa de reapuração;
  - linha que sumiu antes da contagem sai como `base_mudou`.

  Fechar isso exige a RPC devolver o motivo por linha, decidido no próprio UPDATE.
- **`ja_apuradas > recusadas` não identifica a versão da RPC** (Codex).
  - Falso positivo na atual: a reconciliação zera o desconto entre a contagem e o UPDATE, e a linha é aplicada → `{aplicadas: 1, recusadas: 0, ja_apuradas: 1}`. A degradação protege a contagem.
  - Falso negativo na anterior ao #2475, que tem o mesmo shape: três linhas NULL, uma aplicável → `{3, 1, 2, 1}` → partição base=1/já=1, quando o certo é 2/0.

  Qual versão está no ar se prova no banco: em 2026-09-14, `md5(prosrc)` da prod = `c0aa159558d48b2aac391e0e8c9517c0` = corpo da migration `20260910214850` = corpo de `db/aplicar-desconto-backfill-rpc.sql`, com `INTO v_ja_apuradas` antes de `WITH plano AS` (via `psql-ro`).
- **Id repetido no plano — [P1] do Codex, preexistente; fechado para a ESCRITA na v1.5 ([diagnostico-que-nao-bloqueia-a-escrita.md](diagnostico-que-nao-bloqueia-a-escrita.md)).** A RPC não recusa id duplicado. Com valores diferentes, o `UPDATE … FROM` grava um deles, e qual é imprevisível; na contagem, a cópia não aplicada sai como "base mudou". A conciliação garante unicidade DENTRO de um pedido, mas a edge **não deduplica pedidos entre páginas**, e o lote é descarregado a cada 25 pedidos **conciliados** — a fronteira do lote não se alinha à da página. Um pedido no fim da página N que reapareça no início da N+1 (paginação deslocada por inclusão/alteração durante o run) é relido ainda NULL e entra duas vezes no MESMO lote; o Codex reproduziu o fluxo no handler, com I/O simulado.
  - Com descontos iguais, o dano é contagem e trabalho redundante.
  - Com o desconto alterado entre as duas leituras, um valor arbitrário é gravado. O `plano_aprovado` da v1.5 (um valor em centavos por id) fecha o valor arbitrário, mas sobrava a cópia VELHA — igual ao aprovado — gravada enquanto a nova saía como fora do plano, na mesma invocação.

  **Medição (2026-09-14).** Nas duas passadas completas de dry-run da v1.3 (11/09 e 14/09, 54 páginas cada), medi por id sobre as respostas colhidas: **10.594 e 10.587 desfechos, zero id repetido dentro de uma resposta e zero id em duas páginas**. A sessão que levou a decisão mediu também a ordem: a doc do `ListarPedidos` diz que `ordenar_por` tem padrão Código e que o filtro de data pega incluídos e/ou alterados, sem cursor; empiricamente o código sobe em 52/52 fronteiras (medição dela, não reconferida aqui). Redação que vale: *zero duplicatas observadas nos recortes medidos; frequência operacional não estimada.*

  **Decisão, na v1.5:** a escrita exige `max_paginas: 1` presente — ausente ou ≠ 1 é HTTP 400 (`lerParametrosBackfill`); o dry-run segue multipágina. A imunidade deixa de morar no script de quem dispara, e não depende de a frequência ser zero. O que fica:
  - duplicata dentro da MESMA resposta do Omie não é coberta (sem mecanismo conhecido; zero em 108 páginas);
  - a edge não serializa invocações sobrepostas: o guard `IS NULL` impede sobrescrita, mas não escolhe a leitura mais nova (a operação serializa pela trava de sequência do ledger de disparos);
  - omissão ≠ duplicação: `completo` diz que o laço chegou ao fim da paginação, não que todos os ids aprovados foram vistos — o fechamento operacional confere os ids aprovados ainda NULL;
  - reabrir dedup no plano ou recusa na RPC se surgir um 2º chamador da RPC ou necessidade real de escrita multipágina.
- **Não há teste unitário provando que os DOIS caminhos da edge chamam a soma** (Codex): remover a chamada do retry sobrevive à suíte, porque a edge não tem harness (preexistente). A garantia hoje é a revisão mais o repasse de uma linha.
- **A resposta 500 do retorno ilegível não traz página segura de retomada** (Codex). Repetir a partir da página inicial é seguro na RPC conhecida, mas relê o Omie. A melhoria fica registrada; o ramo não dispara com a RPC verificada em prod.

## Evidência

- **RED** com um stub que transcrevia a lógica da v1.3: 8 falhas, todas por asserção (`4 recusadas − 1 já apurada`; `esperava 'nao_classificado', veio {"tipo":"classificado",…,"base_mudou":3}`), zero TypeError. Os 2 controles ("`ja_apuradas = 0` é dado" e "todo retorno legível fecha com as enviadas") ficaram verdes, como previsto: a edge velha somava tudo num contador só, e a soma fechava por acidente.
- **RED 2** (a soma no módulo): `TS2724`, a função não existia.
- **GREEN final** (commit `5df7b1e38`, cada passo com rc capturado):
  - suíte 59/59;
  - `test:edges` 1120 passed / 0 failed;
  - `edges:typecheck` 0 erros de classe-crash, com os mesmos 114 tolerados de antes (nenhum novo);
  - `deno check` da edge e da suíte com 0 erros;
  - os 14 vitest que leem os arquivos como texto, 204/204;
  - `sonda:bump` ✓ (v1.4), `sonda:fingerprint` mudou só esta edge, `sonda:cron-prova --gate` 6/6 closures PASSA;
  - eslint rc=0.
- **Contrato de mutação:** 22 mutações novas em `scripts/mutcheck.d/desconto-backfill.mut`.
  - Na leitura do retorno: rótulo único, rótulos trocados, ausente → 0, null ≠ ausente, coerção `Number()`, fração/negativo aceitos, guard do excesso, soma não conferida, array como objeto, aplicadas zeradas no degradado.
  - Na soma: base mudou somando as já apuradas, contadores trocados ou sumidos, causa não contada, ilegível calado.

  Rodada final: **55 mutações · 55 pegas · 0 sobreviventes · 0 inválidas**, controle+ 55/55.
- ⚠️ **Mutante que não compila não é mutante morto.** A 1ª rodada teve 1 inválido: `if (ja > recusadas)` → `if (false)`. O TS marca o bloco de `if (false)` como inalcançável e ali perde o estreitamento de `aplicadas`/`recusadas` (2× TS2322). O guard morto passou a ser `if (ja < 0)`, provado numa cópia com controle verde na mesma invocação. O Codex achou o mesmo, de forma independente.
- **2ª opinião (Codex, gpt-6-astra max):** MERGEAR COM AJUSTE, com 7 achados. Os ajustes 2 a 7 entraram; o 1 ([P1] id repetido, preexistente) está nos Limites, para decisão à parte.

## Deploy

Edge de deploy manual (Lovable). Merge ≠ produção: quem decide é `bun run pendencias:deploy` (ledger `deploy_atestacoes`). Com o bundle novo no ar, a sonda responde `v1.4-recusas-da-escrita-por-motivo`.
