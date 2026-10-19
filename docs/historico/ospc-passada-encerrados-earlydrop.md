# Passada de encerrados (R59) morria por `EarlyDrop` — `omie-sync-pedidos-compra` v1.7 (2026-10-18)

## Sintoma

A passada só de encerrados da v1.5 (#3132) roda depois de um completo LIMPO e nunca fechava: heartbeat
`pedidos_compra_encerrados` preso em `running`, registro `reposicao_encerrados_omie_publicacao` preso em
`coletando`, sem log algum. Dois disparos manuais (#3144, recibos #512 e #514) repetiram: o 1º com o cliente
segurando 300s (504 aos 150s), o 2º com corte de 25s no cliente — o que derrubou a hipótese "o gateway matou o
worker" **na leitura de então**. Fail-closed preservado: o backtest só aceita `publicado`+`habilitado`.

## Evidência (3º disparo, recibo #515, `db/disparo-diagnostico-ospc-oben-20261018.sql`)

Os logs dos dois primeiros já tinham expirado (retenção ~10 min no Lovable Cloud). O 3º disparo foi feito para
ler o log DENTRO da janela, pelo agente do Lovable em plan mode (sem edição). Execution `9fd480ba`:

| instante (UTC) | fonte | evento |
|---|---|---|
| 21:16:47 | function_logs | `booted`; pg_net corta o cliente em 25s |
| 21:18:39.800 | function_logs | `publicou run … ids=549` — completo limpo em 112s; **última linha da função** |
| 21:18:39.94 | banco | tentativa `coletando` seq 147 |
| 21:19:17.500 | function_edge_logs | **504 `IDLE_TIMEOUT`, `execution_time_ms:150146`** |
| 21:20:07.506 | function_logs | **`shutdown reason:EarlyDrop`**, `cpu_time_used:127`, heap 11MB / total 14MB |

## Causa

O gateway encerra a request aos 150s **independentemente de o cliente já ter saído** — o corte de 25s do pg_net
não muda nada do lado do runtime. Com a request encerrada e nenhuma promise registrada em `waitUntil`, o
supervisor `per_worker` do edge-runtime v1.77 aposenta o worker na metade do wall-clock (~200s do boot) com
`EarlyDrop` (Codex leu o fonte: `strategy_per_worker.rs`). O "a edge segue server-side até terminar" de
2026-06-26 era verdade só até essa verificação: o completo (112–179s) cabia; a passada, que vem depois dele e
pode gastar até ~90s por página, não.

## Fix

`manter-vivo.ts` → `segurarWorker(trabalho)`: o MESMO promise que o handler aguarda vai para
`EdgeRuntime.waitUntil` (rejeição engolida só na cópia). A resposta continua saindo só no fim (o "não responder
cedo" do pipeline ordenado do `omie-cron-diario` segue de pé); o worker vive até o trabalho acabar, com teto no
wall-clock (~400s; `DEADLINE_ENCERRADOS_MS` = 380s). Ganhou rastro por página na passada e aviso se o runtime
não oferecer `waitUntil`.

## Riscos pré-existentes apontados pelo Codex (fora do escopo, não corrigidos aqui)

- O cron avança para `nfes` ~27s depois do `pedidos` em `modo:"background"` — o handler síncrono não é barreira
  de conclusão.
- Os upserts do espelho `purchase_orders_tracking` não têm fencing por `runSeq`; um run manual concorrente pode
  sobrescrever um mais novo. Sobreviver até ~400s alarga essa janela (os ticks do cron, a cada 2h, não se
  sobrepõem).
- As RPCs da passada não têm timeout próprio; o deadline de 380s cobre só as chamadas ao Omie.

## Prova pós-deploy (2026-10-19)

Deploy pelo MCP do Lovable (pacote `77a6bb85dc14`, 9/9 sha256 contra `5bb91c6a5`, sensor de edição
`SEM_EDICAO`); sonda (recibo #532) → **DEPLOY CONFIRMADO** `v1.7-worker-segurado-waituntil` com o `fonte` da
main; ledger `CONFERE`. Disparo de prova (recibo #533, `db/disparo-prova-v17-ospc-oben-20261019.sql`, cliente
corta em 25s): completo limpo 01:37:48 (549 pedidos) e a passada **chegou a estado terminal às 01:39:36,
~220s após o disparo** — depois do ponto em que o `EarlyDrop` a matava. Primeira vez em 4 runs.

O terminal foi **abstenção**: `encerrados (520) passam da metade da varredura (549) — implausível`, registro
`invalidado` seq 149, nada publicado. A guarda de >50% fez o trabalho dela. Se o filtro só-encerrados
discrimina "encerrado" no sentido do R59 continua em aberto: com a abstenção, o registro não guarda os IDs, e
os controles do #3132 (positivo 12096301530/12098830141 dentro; negativo pedido aberto de out/2026 fora)
precisam do conjunto.

## v1.8 — conjunto da abstenção gravado e os 3 controles do #3132 (2026-10-19)

A v1.8 (#3167) grava, na abstenção, o conjunto observado em `sync_state.metadata.diagnostico` (só
diagnóstico; registro protegido e backtest intactos). Deploy `a299ed60b998` (9/9 sha256 contra `5a8a2910a`);
o sensor acusou `EDICAO_DETECTADA` pelos SINAIS do MCP (`commit_sha` `0a53b5ef`), mas medido contra o commit
deployado ele é um merge `lovable-sync-*` que muda só o `types.ts` (+1 linha regenerada), zero em
`supabase/` e fora da main — classe tolerada, nada a reverter. Sonda #541 → DEPLOY CONFIRMADO v1.8; ledger
`CONFERE`. Disparo #542: abstenção de novo (520/549), seq 151, `completa=true`, `truncado=false`.

| controle | resultado |
|---|---|
| positivo — 12096301530 e 12098830141 em `ids_observados` | ✅ os dois dentro |
| negativo — pedido aberto de out/2026 em `ids_fora_do_filtro` | ✅ 12197300494, 12197359383, 12199229751, 12199229888 (16/10, sem NF, previsão 27–29/10) estão no complemento; 12199229881 não foi visto pelo completo (fora dos dois) |
| tamanho — observados − alheios + fora = completo | ✅ 520 − 0 + 29 = 549 · **94,7%** do completo |

Perfil: os 29 de fora são TODOS pedidos de out/2026 com previsão 20–30/10 (18 sem NF, 11 com NF) — os em voo.
Os 13 pedidos de out/2026 observados têm NF. ⇒ o filtro só-encerrados separa "ciclo concluído" de "em voo",
não "encerrado manualmente sem NF". Com a guarda de metade, a passada absterá SEMPRE nesta carteira: ligar
`habilitado` sozinho é inerte. A decisão aberta é a SEMÂNTICA (o que o R59 quer tirar do caixa) e, com ela,
a guarda — não o interruptor.
