# O eco de `versao` na canária promete demais — `_shared/` só o `fonte` cobre, e ele não viaja ali

> Ritual `/codex challenge` (`gpt-5.6-sol`, reasoning `xhigh`, via `scripts/codex-async.sh`) sobre o
> desenho do **#2026** — conduzido em **2026-08-28**, DEPOIS do merge e ANTES do deploy. Fecho:
> **#2054** (`8c2a8b716`). O código estava na main desde `231425fa5`, mas deploy de edge no Lovable é
> manual, então a revisão ainda prevenia.

## Por que houve ritual atrasado

O CLAUDE.md manda conduzir o `/codex` **sempre** que a entrega toca money-path. O #2026 instrumentou a
`omie-vendas-sync` — que escreve NO OMIE sem desfazer (`criar_pedido`/`alterar_pedido`/`excluir_pedido`,
`criar_cliente`, ordens de produção) — e a sessão daquele PR validou por gates e testes, mas **pulou a
2ª opinião**. Este doc é o ritual sendo pago com atraso, e o que ele comprou.

## O achado

A canária `identidade_probe` passou a ecoar `versao` ao lado do `contrato` "para quem verifica ler os
dois **sem uma segunda chamada**". A promessa vale enquanto a fatia for **edge-local** — e some quando
toca `_shared/`:

- o `sonda:bump` **exclui `_shared/` de propósito** (cobri-lo daria ~12 bumps à mão por PR) ⇒ o `VERSAO`
  não bumpa;
- o `canaria:bump` traz de `_shared/` **só os símbolos que a FIXTURE exercita**, e o
  `authorizeCronOrStaff` roda ANTES dela ⇒ o `contrato` não bumpa;
- logo, sem deploy, a canária do bundle velho responde os **três** campos idênticos e **mente verde** —
  inclusive para um hardening do gate de auth desta edge money-path.

Só o **`fonte`** discrimina (fingerprint SHA-256 do fecho transitivo **com** `_shared/`) — e ele **não
viaja na canária**, só na rota `{"probe":true}`. **O conserto é de RITO, não de código:** fatia que toca
`_shared/` exige as DUAS chamadas.

**A generalização** (é o que sobrevive a esta edge): *o marcador aceso à mão só cobre o que o gate dele
enxerga.* Dois marcadores independentes não somam cobertura — eles somam **pontos cegos**, e o ponto
cego comum foi exatamente `_shared/`, que nenhum dos dois gates mede por decisão deliberada de custo.
Quem promete "leia os dois e pronto" está prometendo pela **união** quando a verdade é a **interseção**.

## Corroboração independente, no mesmo dia

O **#2052** (outra sessão, mergeado horas antes) achou a MESMA lição por outro caminho: o gerador
`bun run sonda:sql` julgava deploy só por `corpo->>'versao'` e devolvia `DEPLOY CONFIRMADO` para um
bundle PARCIAL (`fonte = "nao-mapeada"`). O corpo dele registra que, ao verificar justamente a
`omie-vendas-sync`, **o SQL teve de ser corrigido à mão para incluir o `fonte`**. Dois caminhos
independentes, mesma conclusão — e os dois PRs são complementares (ele conserta a **sonda**, este
conserta a **canária**). `git merge-tree` provou que não conflitam.

## O que foi medido (não presumido)

| afirmação | como foi provada |
|---|---|
| `req.clone()` não diverge do original | `Deno.serve` REAL (corpo de socket, não `new Request` em memória): 6/6 cenários, inclusive **8 MB** e **3 s** de corpo pendente durante o await de rede. **Falsificado**: sem o clone, A/C/F quebram em `Body already consumed` |
| o bump `v2 → v3` era EXIGIDO | commit **sintético** (`git commit-tree`, sem tocar refs nem working tree) com o marcador revertido ⇒ `canaria:bump` **exit 1** nomeando a edge |
| `x-cron-secret` é IO-free | `auth.ts` retorna `{ok, via:"cron"}` só com headers; o ramo staff faz `fetch` a `/auth/v1/user` ⇒ verificar por JWT staff pode dar 401 lido como "não deployou" |
| comentário MUDA o `fonte` | o fingerprint é da FONTE crua: `d0d0580c…` → `47c046a5…` sem mudança de comportamento — por isso o `VERSAO` **não** bumpou |

⚠️ **Duas armadilhas de método que quase passaram**, e valem mais que o achado:

1. **Gate verde por VACUIDADE.** `sonda:bump`/`canaria:bump` comparam base↔HEAD **via git**. Rodados com
   a fatia ainda **não commitada**, eles veem zero mudanças e passam — verde que não mede nada. Só depois
   do commit (base `ce6cb7d01` ≠ HEAD) o verde virou evidência.
2. **Falsificação que não discrimina.** Nos cenários D/E do teste do clone, o assert era "lançou algo" —
   e eles passaram **mesmo sabotados**, porque a marca do ramo mudou (`SyntaxError` → `TypeError`) sem o
   assert notar. É a regra do CLAUDE.md ("case a MARCA do ramo") mordendo em teste novo.

## O parecer do Codex

Vereditos: **(1)** clone — *aceitar como está*, severidade baixa; **(2)** dois marcadores — *ajustar a
verificação antes do deploy*, **alta para verificabilidade** (é o achado acima); **(3)** bump v2→v3 —
*aceitar como está*, severidade baixa.

Pontos dele que sobreviveram à conferência:

- **Sobre o clone:** o `tee` do Fetch dá o mesmo fluxo aos dois ramos; `clone()` só lança se o corpo já
  estiver perturbado, o que o gate não faz. O risco é **retenção de memória**, não divergência — o clone
  precisa receber o corpo inteiro, então durante o `auth.getUser` os bytes já estão enfileirados nos dois
  ramos. Cenário: JSON grande ⇒ dois objetos materializados ⇒ teto de 256 MB do worker ⇒ 546. **Falha
  SEGURA** (indisponibilidade daquele sync, nunca escrita errada no Omie). Ele mesmo marca como hipótese
  operacional, não bug demonstrado. Correção de prosa que aceitei: **"byte-idêntico" deve ser lido como
  "código posterior intacto"** — memória e timing mudam.
- **Sobre o bump:** o precedente do #1974 **não** sustenta este caso (lá a fixture mudou; aqui não), mas
  o bump é defensável porque a **superfície observável** da canária mudou — que é o que o gate mede. E
  **reverter agora seria pior**: um operador que exija só `contrato=v2` aprovaria o bundle antigo.
- **Sobre inflação de versão:** não acontece por construção — as cadências são distintas (fora da
  superfície da canária não bumpa `contrato`; mudança só em `versao.ts` fica excluída; mudança edge-local
  relevante exige `VERSAO` mas não `contrato`).

⚠️ **Limitação declarada do parecer:** o Codex abriu com `STATUS: DONE_WITH_CONCERNS` — o sandbox
read-only bloqueou a inicialização interna do processo, então ele **não executou nada**; é análise
estática. Que ele leu o repo de verdade está provado: citou `sonda-fingerprints.ts` com o SHA
`d0d0580c…`, conferido e batendo. As medições da tabela acima existem justamente porque ele não pôde
fazê-las.

⚠️ **O parecer CRU se perdeu** na reciclagem do worktree (vivia em `/private/tmp`, que não sobrevive) —
o que está acima é a síntese conferida, não a transcrição. **Lição operacional:** artefato de ritual que
vale auditoria nasce em `docs/`, não no scratchpad. Um achado dele foi descartado por mim e fica
registrado: propagação por região (`x-sb-edge-region`), que ele mesmo marcou como hipótese — precisão >
recall manda não inflar o rito com passo sem gatilho medido.

## Onde a regra vive agora

`docs/agent/deploy.md`, §Canárias — a ⚠️ "Nem `contrato` + `VERSAO` JUNTOS cobrem `_shared/`", logo após
a dos marcadores independentes, e a linha da tabela da `omie-vendas-sync`, que deixou de prometer o que
o eco não cobre.
