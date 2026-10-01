# A prova do sync-reprocess, no núcleo, verde e um compute atrás

**2026-09-30.** A pendência que o diário das provas tint registrou como achado lateral
([provas-tint-apodrecidas.md](provas-tint-apodrecidas.md)): `db/test-data-health-sync-reprocess.sh`
— no núcleo do CI, eixo sensores — aplicava a cadeia FIXA `0918 → 0920a → 0920b` sobre
`db/stubs-data-health-trio.sql` e parava. Em 2026-09-22 a `20260922225500` (portal humano: severidade
dinâmica) recriou o `_data_health_compute`, e a prova seguiu verde oito dias medindo o anterior. É a
classe "o HARNESS mente" ([money-path.md](../agent/money-path.md)) — VERSÃO COBERTA ≠ VERSÃO
ENTREGUE —, desta vez DENTRO do núcleo, no mesmo dia em que as 3 irmãs foram revividas sobre a cadeia
viva ([provas-data-health-revividas.md](provas-data-health-revividas.md)).

## Medido, não presumido

`md5(pg_get_functiondef())` — prod via `psql-ro` × o banco do harness (stubs + o ACL de prod):

| função | prod | harness, cadeia até a 0920b (antes) | harness, cadeia viva (agora) |
|---|---|---|---|
| `_data_health_compute` | `4cc51b39…` | `f0eecc34…` ❌ | `4cc51b39…` ✅ |
| `data_health_watchdog` | `9f4cf19b…` | `9f4cf19b…` | `9f4cf19b…` |
| `fin_sync_heartbeat` | `2de28cfc…` | `2de28cfc…` | `2de28cfc…` |

A 0922 muda UMA linha — a severidade do `reposicao_portal_humano`, conferido por diff do corpo
0920b × 0922 —, fora de tudo o que a prova assevera. Por isso nada ficou vermelho. E o próprio código
declarava a premissa que apodreceu: o `sabotar()` extraía o compute "da migration do conserto (a
última a recriá-lo, que é o que vale em prod)" — a 0920b, verdade só até 22/09. O ACL do compute em
prod (mesma leitura): `anon`/`authenticated`/`PUBLIC` sem EXECUTE, `service_role` com, SECURITY DEFINER.

## O que mudou

- **Cadeia dinâmica, não "+ a 0922".** Acrescentar a 0922 à lista consertaria hoje e apodreceria na
  próxima reescrita — o trio é reescrito quase toda semana. A prova usa a seleção de
  [`db/lib/data-health-vivo.sh`](../../db/lib/data-health-vivo.sh) (`dhv_cadeia`: toda migration
  ≥ `20260918200000` que redefine função guardada, em ordem de versão), sobre os STUBS — não sobre o
  snapshot, como as irmãs.
- **Estreitada às 3 funções que a prova executa**, e com o `DHV_INICIO` fixado na própria prova. A
  `DHV_GUARDADAS` da lib inclui o `_data_health_episodio` (aqui, o espião do A28) e os 2 helpers de
  lista (stubs): com a lista inteira, uma redefinição futura deles atropelaria o stub — o sintoma que
  matou as provas tint. E o início é desta prova (a 0918 é a base de watchdog e heartbeat sobre os
  stubs), não do snapshot das irmãs. O setup ainda confere que a cadeia não tocou nenhuma função que a
  prova STUBA — senão o A27/A28 cairia com o diagnóstico errado ("não roteou").
- **Sabotagem no corpo VIVO** (`dhv_sabotar`, sobre o `pg_get_functiondef`), e não no texto do
  arquivo da 0920b. Com a 0922 na cadeia, a sabotagem antiga recriaria a 0920b + a troca: duas
  mudanças por rodada, com a 0922 revertida em silêncio.
- **O dente da cadeia passa pelo SETUP.** As sabotagens `migracao_nova_*` montam um 2º banco (`pre`)
  do jeito normal, tiram dele o corpo vivo, escrevem a PRÓXIMA reescrita (`29991231235959`) num
  espelho de `supabase/migrations` — e a rodada monta o banco pela MESMA chamada de sempre, lendo esse
  diretório. Se o compute instalado não for a reescrita (md5), a rodada sai 9 e o juiz conta FALHA.
  Duas: `migracao_nova_retry_liquida_erro:A15` (o furo E.1 chegando pela próxima reescrita) e
  `migracao_nova_drop_create:A32`.
- **A32 — o ACL no FIM da cadeia.** O setup reproduz o ACL de prod antes da cadeia, mas só a
  postcondição da 0918 o confere. Uma reescrita por `DROP`+`CREATE` (a armadilha do CLAUDE.md) o
  reseta — EXECUTE de volta a PUBLIC numa função SECURITY DEFINER — sem mudar uma letra do md5:
  **md5 igual não é função igual**. Medido: com essa reescrita, a suíte sem o A32 ficava 31/0.
- **O relógio controlado deriva o `search_path`** do que a cadeia deixou, em vez dos literais
  `public, pg_catalog, pg_temp` / `public, pg_temp`: a próxima reescrita que mudasse o `search_path`
  faria o desligamento acusar "relógio não desligado" sem defeito nenhum.
- `db/nucleo-ci.txt`: `31  falsificar=13` → `32  falsificar=15`. O teste do gate
  `falsificar-exige-assert` congelava `entradas: 13` → 15. A versão coberta fica legível no log do CI
  (`compute exercitado: md5 …`).

## Falsificação — medida

| onde | modo normal | `--falsificar` |
|---|---|---|
| M2 local | `PASS=32  FAIL=0`, compute `4cc51b39…` | `SABOTAGENS: 15 vermelhas / 0 falhas` |

**Contrafactual do incidente** (cópias no scratchpad, nada no repo):

| cenário | modo normal | rodada `migracao_nova_*` |
|---|---|---|
| setup re-fixado na lista até a 0920b | VERDE, `PASS=32`, compute `f0eecc…` (o incidente) | `exit 9`, 0 linhas ATIVA, "o SETUP não a aplicou" → FALHA |
| setup ignorando o diretório da cadeia | — | `exit 9`, idem → FALHA |

O modo normal sozinho não vê o incidente, por construção; o `--falsificar` que o CI roda, agora sim.
Antes da revisão, a mesma cópia re-fixada passava `14 vermelhas / 0 falhas`.

## Revisão independente (Caminho B)

O Codex não foi consultado: o `scripts/codex-async.sh` barrou pelo sensor de cota (86% > teto de 85%;
a janela reabre em 03/10 19:11) sem gastar a chamada. No lugar, revisão adversarial por subagente
só-leitura, com o roteiro do Codex e experimentos no scratchpad. Dez achados:

| # | achado | destino |
|---|---|---|
| 1 | a `migracao_nova` trazia a própria cadeia (`dhv_migracao_nova`): setup re-fixado passava 14/0 | **consertado** — a reescrita passa pelo setup |
| 2 | nenhum assert de ACL no fim da cadeia; `DROP`+`CREATE` abria o compute a anon e passava 31/0 | **consertado** — A32 + `migracao_nova_drop_create` |
| 3 | `search_path` literal no relógio: vermelho-falso com diagnóstico errado | **consertado** |
| 4 | comentários falsos (`get_data_health` "stub"; "reprova no CREATE" vale só para o sql; "a suíte ficaria verde") | **consertados**, inclusive o do `dhv_migracao_nova` na lib |
| 5–6, 8 | limites da seleção textual, da ordem de versão e das contagens congeladas | **declarados** abaixo |
| 7 | `DHV_INICIO` acoplado ao snapshot das irmãs | **consertado** — fixado na prova |
| 9 | reaplicar a cadeia é idempotente só por sorte do histórico | **deixou de existir** — a cadeia é aplicada uma vez |
| 10 | o diário fora do commit | **consertado** |

Não substitui o Codex; cobre o intervalo. Revisão retroativa quando a cota voltar, se o founder quiser.

## O que NÃO prova (limites declarados)

- **A seleção é TEXTUAL** (o limite da lib): escapam `EXECUTE replace(pg_get_functiondef(...))`, o
  nome entre aspas (`"public"."_data_health_compute"()`) e a quebra de linha depois de `FUNCTION`; e
  uma migration que só CITE o `CREATE` num comentário é selecionada. Nenhuma das ~40 migrations do
  trio tem essas formas (medido na revisão).
- **"A versão de prod" é a do repo, em ordem de versão.** Merge não é apply (o founder aplica à mão),
  e um PR com timestamp antigo mergeado depois de outro inverte quem vence. O md5 no log existe para
  essa conferência — não é comparado com nada no CI, que não lê prod. Medido no mesmo dia: depois do
  merge do #2698, a prova passou a exercitar `e81de322…` (com a `20261001011500`), e prod seguia em
  `4cc51b39…` até o apply — a prova cobre a versão ENTREGUE, que é a que o apply vai pôr no ar.
- **A4 e A26 são contagens congeladas.** Com a cadeia viva, a próxima fonte nova as derruba no PR
  que a acrescenta (ou no que mergear por segundo); um commit direto do bot do Lovable na main não
  passa por CI de PR. Materializou no MESMO dia: o #2698 (`20261001011500`,
  `vendas_empurradas_sem_gemeo`) entrou na cadeia, e o A4 foi de 30 a 31 e o A26 de 22 a 23 —
  atualizados aqui. A mesma migration derrubou a âncora do `fora_do_v_sources`, que era o FIM do
  array (`'sync_reprocess_saude'];`): virou só o nome entre aspas, que não depende da posição.
- **A30/A31 são textuais** (o `LIKE` casa até comentário), e o A31 — a perna do heartbeat — não tem
  sabotagem própria; já era assim antes desta entrega.

## Lições

**"A última migration que recria X é a que vale em prod" é um RETRATO** — verdadeiro até a próxima
migration. Escrito como lista fixa ou como comentário numa prova, ele apodrece VERDE: a reescrita
seguinte não toca nada que a prova assevera, e nada acusa. A pergunta "qual é a última?" só se
responde certo A CADA EXECUÇÃO — por seleção, não por nome. E a sabotagem herda o mesmo retrato:
recriar a função a partir de um arquivo mede a versão do arquivo, não a instalada.

**O dente de "segue a cadeia" tem de passar pela MESMA chamada do setup.** Uma sabotagem que traz a
própria cadeia prova a seleção, não que o setup a use — e o setup re-fixado à mão é exatamente o
incidente. Quem pôs a reescrita nova no diretório que o setup lê foi o que transformou "o comentário
avisa" em "o `--falsificar` do CI reprova".

**md5 igual não é função igual.** `pg_get_functiondef` não carrega o ACL: a reescrita por
`DROP`+`CREATE` abre uma função SECURITY DEFINER a anon com o md5 intacto. Quem confere "a versão
coberta é a entregue" pelo md5 tem de conferir o ACL à parte.
