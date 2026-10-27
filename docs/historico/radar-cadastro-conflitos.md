# Radar: conflito de cadastro Omie persistido no SERVIDOR (2026-10-27)

> Follow-up do **achado 3 do Codex** no PR #3293 ([radar-cadastro-omie-idempotente.md](radar-cadastro-omie-idempotente.md),
> seção Follow-ups). Migration `20261027160000_radar_cadastro_conflitos.sql` — a v1 (`20261021120500`, md5 `2b3dbe0d…`)
> NÃO é recriada.

## Problema

O lote "Cadastrar no Omie" vive no `localStorage` por usuário e cada aba regrava o lote INTEIRO a partir da sua cópia
em memória. A aba B grava um item como `divergente` (RD001/RD002/lookup divergente); a aba A, que carregou o lote
antes, regrava por cima e o aviso some. O vínculo autoritativo nunca foi sobrescrito, mas:

- o AVISO para um humano conferir o Omie se perdia (e "Esquecer lote" apagava a única evidência);
- pior (reproduzido pelo Codex executando as funções reais com duas cópias do lote): na aba A o item seguia `falha`,
  "Retomar" chamava `retentativa` SEM o código visto, relia o vínculo V e devolvia `{codigo: V, recuperado: true}` —
  **sucesso fabricado**, o mesmo D4 do #3293, sem nenhuma chamada ao Omie nem à RPC.

PROD (psql-ro, 2026-10-27 15:39 UTC): **0** vínculos, **0** linhas no ledger, tabela nova ausente — nada a migrar.

## Desenho (Codex `-r max`, veredito AJUSTAR, sem P0)

Proposta inicial (B): front registra o conflito numa RPC separada depois da recusa. O Codex trocou por **A enxuta + B**:

| Peça | O quê |
|---|---|
| `radar_cadastro_conflitos` | um registro ABERTO por `(cnpj, motivo, código recebido)` (índice único parcial); `ocorrencias` + **`versao`**; `codigo_vinculado`/`cnpj_do_codigo` lidos pelo SERVIDOR; resolver = marcar o PRÓPRIO registro (quem, quando, nota obrigatória); nada é apagado. RLS ligada, só policy SELECT (`private.cap_carteira_ler`), escrita direta revogada de todos. |
| `radar_registrar_cadastro_omie_v2` | ENVOLVE a v1 intacta: trava a linha da empresa **fora** do bloco de exceção (o rollback do bloco soltaria a trava tomada dentro dele), devolve `{ok:false, bloqueado:true}` se há conflito aberto (inclusive vínculo igual), chama a v1 e, em RD001/RD002, grava o conflito na MESMA transação e devolve `{ok:false, conflito}`. Retornar normalmente é o que mantém o INSERT. |
| `radar_estado_cadastro_omie` | vínculo + conflitos abertos lidos JUNTOS sob `FOR SHARE` — fecha a corrida "consultei conflitos → outra aba registrou → reli o vínculo". |
| `radar_registrar_conflito_cadastro` | divergência vista FORA da v2 (retomada K≠V, `OMIE_LOOKUP_DIVERGENTE` da edge, RD cru); o servidor re-confere o que sabe (RD003 se desmente), **sem exigir o ledger** (o ramo `codigoVisto` é justamente evidência sem confirmação). |
| `radar_resolver_conflito_cadastro` | "conferi no Omie": `UPDATE … WHERE versao = vista AND resolvido_em IS NULL`; 0 linhas → RD004. Corrida tem DOIS desfechos corretos: registrar vence (versão sobe, resolução velha falha) ou resolver vence (ocorrência seguinte abre OUTRO registro). |
| `_radar_cadastro_conflito_gravar` | escritor único das observações; INVOKER, sem EXECUTE para ninguém além do dono. |

Front (`src/lib/radar/cadastro-omie.ts` + `conflito-cadastro.ts`): em TODO caminho (lote, retomada, ficha, oferta) a lib
lê o estado conjunto ANTES de tudo — conflito aberto → `DivergenciaCadastro` com `bloqueio: true` (sem Omie, sem RPC,
**sem registrar de novo**); leitura que falha BLOQUEIA (nunca "zero conflitos"). Divergência observada é registrada; se
o registro falhar, o aviso fica local, marcado "não sincronizado". Toda resposta jsonb tem a forma conferida — desvio é
`RADAR_RESPOSTA_INDETERMINADA`, nunca "gravado".

Telas: diálogo do lote sobrepõe o servidor ao local (aberto vence até item local `ok`; resolvido = "conferido", não ok;
sem registro = "não sincronizado"; leitura falhou = mantém o local + aviso); "Esquecer lote" envia os não sincronizados
antes de apagar e SEGURA o lote se algum não subir (RD003 = desmentido, pode sair). Ficha: painel do conflito aberto com
"Conferi no Omie" (nota obrigatória, RD004 → "mudou, releia", desabilitado em "Ver como"). Página: indicador
**"N CNPJs com pendência Omie"** partindo dos conflitos (alcança já-cliente/descartado fora da fila; erro = indisponível,
nunca zero), com "Abrir ficha" que lê o lead inteiro.

**Limite aceito:** `lookup_divergente` só chega ao servidor pelo front (a edge não foi tocada — sessão irmã no lookup,
PR #3359); bundles velhos seguem na v1 (RD001/RD002 como erro, sem registro) até o Publish + adoção. Resolver não
corrige um vínculo errado — uma via de reparo auditada é follow-up.

## Prova

- `db/test-radar-cadastro-conflitos.sh` (núcleo do CI, **56 asserts**; verde em `LC_ALL=C` e `LC_ALL=pt_BR.UTF-8`;
  `--falsificar` **15/15** vermelhas com controle verde na mesma invocação): predecessoras reais até a v1 de PROD;
  PRE recusa a v1 sem RD001/RD002 sem deixar rastro; v2 em RD001/RD002 deixa o conflito legível de OUTRA sessão
  (resposta perdida); bloqueio sem ocorrência nova; RD003/RD004; nova observação após resolver = outro id; gate gestor
  nas 4 RPCs; RLS sob `SET ROLE authenticated`; INSERT direto e escritor interno negados (42501). **Duas sessões** com o
  bloqueio OBSERVADO em `pg_stat_activity`: v2×estado (B espera e já vê o conflito), v2×v2 (B sai bloqueado, 1
  ocorrência), registrar×registrar (1 registro, 2 ocorrências), resolver vence × registrar (outro id), registrar vence ×
  resolver (RD004, segue aberto), ROLLBACK de A (B não vê conflito), e a TRAVA da migration segurando as funções vivas
  (uma recriação concorrente ESPERA).
- **A trava fora do bloco é load-bearing:** a sabotagem `v2_sem_trava` fica vermelha no v2×v2 — sem ela o rollback do
  bloco de exceção solta a trava da v1 e B grava uma 2ª ocorrência (confirma o argumento do Codex).
- Lição de harness: o 1º `--falsificar` deu `tabela_insert_aberto` vermelho pelo motivo ERRADO (o INSERT forjado batia
  no índice único de um CNPJ com conflito aberto, não no privilégio). Trocado o CNPJ, vermelho pelo motivo certo
  (`GRAVOU/1`). Vermelho não basta — confira o PORQUÊ.
- Vitest: lib (bloqueio em 4 caminhos sem tocar Omie/RPC/registro, leitura que falha bloqueia, v2 `{ok:false}`/bloqueado,
  observação registrada, registro que falha = não sincronizado, lookup), parse estrito, sobreposição local×servidor,
  sincronização do "Esquecer", resolver com forma conferida, paginação sem recorte e o HOOK do lote (descarte com
  retomada de closure velha e 2º "Esquecer" concorrente). Falsificação do front **12/12** vermelhas com controle verde
  (77 testes), árvore restaurada.

## Revisão do código (Codex `-r max`, `ae2494daa..1ef44db2a`) — AJUSTA, os 8 corrigidos

- **P1 (reproduzido)** — "Esquecer lote" concorria com a retomada: enquanto o envio de A aguardava, "Retentar"
  processava B, cujo conflito local o `gravar(null)` do fim apagava. Correção: o descarte segura a MESMA trava por
  usuário do runner (`execucoesEmVoo`) do início ao fim + estado `descartando` que desabilita os botões. Prova no hook
  com um `retomar` capturado ANTES do descarte (a camada da trava; o `descartando` sozinho não pega closure velha).
- P2 — conflito gravado pela v2 na ficha não invalidava as queries (a lib LANÇA): `onError` invalida.
- P2 — resumo do lote contava "confirmado" um item `ok` com conflito aberto, e leitura falha voltava a dizer
  "(recuperado)": confirmados = ok SEM conflito aberto; sem leitura, "ok nesta aba (conflitos não conferidos)".
- P2 — teto de 1.000 linhas escondia conflito aberto: leitura pagina até a página curta e LANÇA acima de 20 páginas.
- P2 — resolver anunciava "conferido" com resposta indeterminada: `parsearResolucao` exige `{ok:true, versao}`.
- P2 — a TRAVA só lia `pg_proc`: agora faz o `ALTER … VOLATILE` sem efeito em cada função viva (inclusive a v1) e
  `LOCK TABLE` se a tabela existe — prova B10c + sabotagem `trava_sem_lock`.
- P2 — o classificador do harness ignorava `ok`: casa o discriminante (sabotagem `v2_sem_ok`, `RETURN r - 'ok'`).
- P2 — `LC_ALL` do chamador era sobrescrito por `C`: agora `LC_ALL_TESTE` > `LC_ALL` recebido > `C`.

## Coordenação multi-sessão

A sessão irmã do lookup estrito (#3362, edge v1.27) mergeou no meio desta entrega com um 4º motivo,
`lookup_ambiguo`, no mesmo `cadastro-omie.ts`. A migration (ainda não aplicada) passou a aceitá-lo no CHECK e no
escritor (relato da edge, como o `lookup_divergente`); o merge portou o `divergenciaDoLookup` dela para o
`falhaNoOmie` async, que registra o conflito — teste próprio.

## Deploy

| Camada | Estado | Quem |
|---|---|---|
| Migration `20261027160000` | ✅ aplicada 2026-10-27 ~16:50 UTC pelo envelope MCP (`query_database`) | esta sessão |
| Publish do Lovable (front) | ⏳ — o front novo chama a v2; só depois da migration (já aplicada) | **founder** (Publish) |
| Edge | nenhuma | — |

**Pré-voo PROD (psql-ro, colado ao apply, 16:49 UTC):** v1 = `2b3dbe0d…` com SECURITY DEFINER + `search_path=public` +
VOLATILE, tabela e as 5 funções ausentes, `private.cap_carteira_ler(uuid)` com EXECUTE para `authenticated`, fora da
janela 06:15–06:45 UTC. Conector confirmado no banco certo (mesmo md5 da v1, 573.021 empresas).

**Ensaio** (mesma SQL terminando em `RAISE 'ENSAIO_OK …'`): TRAVA, PRE, tabela, as 5 funções com os md5 do arquivo e
PÓS passaram; rollback conferido por psql-ro (tabela ausente, v2 ausente). Depois, o apply com `COMMIT`.

**Validação por fora** (psql-ro, outra conexão, depois do COMMIT): as 5 funções com md5 = arquivo, v1 intacta
`2b3dbe0d…`, escritor INVOKER sem EXECUTE para anon/PUBLIC/authenticated/service_role, as 4 RPCs DEFINER com EXECUTE só
`authenticated`/`service_role`; RLS ligada, 1 policy (SELECT, `authenticated`, `private.cap_carteira_ler`); ACL só
SELECT; índice parcial único válido com a definição exata; os 7 CHECKs e as 16 colunas como no arquivo; **0** linhas.

Bundle antigo + banco novo: o front velho segue na v1 (RD001/RD002 como erro, sem registro no servidor) até o Publish
+ adoção — o servidor não regride nada para ele.

## Follow-ups (fora deste PR)

- **Via de reparo auditada do vínculo** (Codex, desenho b): resolver o conflito só encerra o aviso; um vínculo V errado
  continua precisando de correção manual no banco.
- **`lookup_divergente`/`lookup_ambiguo` gravados pela própria edge** (service_role) em vez do front — hoje um bundle que
  perde a resposta da edge perde também o relato.
