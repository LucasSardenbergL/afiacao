# O ✅ "toda edge ativa foi atestada" era um ∀ derivado da AUSÊNCIA de achado

**2026-09-10** · `scripts/pendencias-deploy.ts` + `scripts/lib/sonda-cron-testemunha.ts` · irmão de [evidencia-positiva-shell.md](evidencia-positiva-shell.md), [cobertura-que-o-campo-ausente-tambem-daria.md](cobertura-que-o-campo-ausente-tambem-daria.md) e [espera-sem-desistencia.md](espera-sem-desistencia.md) · mecanismo em [sonda-por-cron-fail-closed.md](sonda-por-cron-fail-closed.md)

## O que aconteceu

Logo após o apply da **onda 5** da allowlist do cron de sonda, o `bun run pendencias:deploy` imprimiu:

```
🕒 SONDA POR CRON — 16 edge(s) ativa(s), 2 tick(s) recente(s), 30/30 disparo(s) atestado(s)
   ✅ toda edge ativa foi atestada nos ticks recentes — o bundle do ledger continua no ar
```

16 ativas e **30** disparos em 2 ticks = 15 edges × 2. A 16ª — `omie-desconto-backfill`, habilitada às
23:04Z, depois do tick das 22:37Z — **nunca tinha sido perguntada**, e o resumo afirmou cobertura sobre
ela. O juiz (`julgarSondaCron`) estava **certo**: pular quem nenhum tick perguntou é a diferença entre
*ausência de PERGUNTA* e *silêncio* — acusar ali seria alarme falso a cada edge nova. O defeito estava
uma camada acima: o ✅ era `achados.length === 0 && avisos.length === 0`.

## A forma generalizável

> **Um resumo com "toda/todo" é um ∀ — e derivá-lo da AUSÊNCIA de achado o faz herdar TODO `continue`
> do juiz.** A linha universal precisa iterar a MESMA população que ela nomeia, com evidência POSITIVA
> por membro. Juiz que pula sem deixar rastro é indistinguível, para quem resume, de juiz que aprovou.

É o `ausente ≠ zero` na camada do **resumo**, e o pior caso não é a edge nova: com o cron existindo e
**nunca** tendo rodado com sucesso, a tela saía `0/0 disparo(s) atestado(s)` + ✅ — zero exame, veredito
de aprovação. Os dois `continue` do juiz viraram listas (`semPergunta`, `silencioEsperado`), e o ✅ só
sai quando toda ativa foi perguntada **e** atestada — nunca sobre população vazia, que é ausência de
dado, não aprovação.

## O teto da espera, e a régua que evita o alarme falso

"⏳ sem pergunta" sem teto é **laço de espera fail-OPEN**: descreveria para sempre, com cara de
normalidade, uma edge cujo sensor de rollback morreu. Acima de **2 períodos do cron + 15 min** (a MESMA
tolerância do `cronSondaParado`, agora com uma definição só) a linha vira AVISO: um tick pergunta TODA
ativa (`deploy_sonda_disparar` sem `p_alvos`), então um tick já passou sem perguntar por ela.

A régua da espera é `greatest(habilitado_em, último disparo em QUALQUER tick)` — **não** só
`habilitado_em`. Medido em prod no mesmo dia: às 23:14Z houve um **tick manual parcial** (só
`sonda-relay`, o one-liner `deploy_sonda_disparar(ARRAY[…])` que o `sonda:sql` oferece). Um tick parcial
desloca o do cron da janela de 2, e as outras 15 edges — perguntadas 34 min antes — virariam "o
dispatcher não pergunta" com a régua ingênua. O avesso também é real: o kill switch (`UPDATE … SET
ativo`) **não** mexe em `habilitado_em`, então uma edge recém-reativada conta espera antiga — por isso o
teto gera AVISO que nomeia as duas causas, nunca achado (precisão > recall).

## Como foi falsificado

16 mutações em 2 contratos novos (`scripts/mutcheck.d/pendencias-deploy-resumo-cobertura.mut` e
`sonda-cron-fora-do-exame.mut`), **16/16 pegas**, baseline verde na MESMA invocação do harness, nos
**dois** locales (`LC_COLLATE=C` e `pt_BR.UTF-8`), com asserts em ASCII de caixa fixa. Duas delas pinam a
direção INVERSA — o juiz não pode passar a acusar quem nenhum tick perguntou — e uma devolve o defeito
inteiro (`todaAtivaAtestada = true`). O texto do ✅ ficou **idêntico** de propósito: trocá-lo faria o
teste negativo (`not.toContain('toda edge ativa foi atestada')`) passar por cegueira, então o controle
positivo exige a mesma string.

## O que ficava em aberto — FECHADO em 2026-10-09

A janela de 2 ticks era **global**, não por edge: depois de um tick manual parcial, as outras ativas
ficavam com 1 disparo na janela e, por ~2 h, o silêncio delas só podia virar AVISO — nunca
`SONDA_CRON_SILENCIOSA` (que exige 2 disparos mudos). Não era desonestidade do resumo (1 disparo
respondido É atestação), era **poder de detecção** reduzido num intervalo conhecido.

Entregue como `row_number() OVER (PARTITION BY edge ORDER BY enfileirado_em DESC) <= 2`, com o TETO de
idade que o `LIMIT` por tick dava de graça e um cabeçalho que parou de afirmar "N tick(s) recente(s)" —
número que, com a janela por edge, não mede mais a população examinada. A narrativa, a contagem medida em
prod (global: 14 edges com 1 disparo · por edge: 15 com 2) e a mutação que foi descartada por não poder
pegar estão em
[janela-global-rouba-a-vaga-de-quem-nao-participou.md](janela-global-rouba-a-vaga-de-quem-nao-participou.md).
