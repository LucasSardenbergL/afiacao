# A irmã AUSENTE da migration liberava a colagem — a vigência no repo separa "não aplicada" de "aposentada"

> 2026-10-05. P1 **preexistente** que o Codex achou e executou na rodada 3 do #2757 (o re-teste por tokens
> do eixo 5), deixado de fora daquele PR por exigir modelar aposentadoria. Fechado aqui, só em scripts:
> nenhuma migration, nenhuma edge, nenhuma escrita em prod.

## O defeito

`julgarPrecondicao` (`scripts/lib/precondicao-banco.ts`) confere duas coisas diferentes para dois conjuntos:

- as RPCs da LEVA (`alvos`) têm a **existência** conferida — ausente ⇒ `ausentes` ⇒ BLOQUEADA;
- as IRMÃS da mesma migration (`alvosDeCorpo`, o conjunto acoplado do #2428) só tinham o **corpo** conferido.

Uma irmã medida como AUSENTE (`rpc|g|NAO|…`, `n|g|0`) caía no eixo de corpo sem corpo nenhum, saía
`INDECIDIVEL` ("prod não expôs corpo textual comparável") e ia para `naoConferidas` — que **não bloqueia**.

Reprodutor do Codex: a leva chama `f`, cujo corpo novo chama `g`; as duas nascem na mesma migration; prod
tem `f` e não tem `g` ⇒ `main` de `scripts/pendencias-pacote.ts` saía **0 com a colagem**. A edge ia ao ar e
`f` falhava em runtime (plpgsql é late-bound: nada falha no `CREATE`).

## Por que não era trocar "não conta" por "bloqueia"

Ausente também é a irmã que uma migration POSTERIOR **aposentou** (`DROP`, `SET SCHEMA`, `RENAME TO`), e
`historicoDeCorpos` (`corpo-esperado.ts`) só modela `CREATE` — nele, a aposentada e a não aplicada leem
igual. Quem modela aposentadoria é `modelarRepo` (`deriva-corpo.ts`: estado terminal por identidade,
`aposentadaPor`), e `precondicao-banco.ts` não pode importá-lo (o sensor importa o gate — seria ciclo).

**O censo de prod mostrou que o conserto ingênuo era um bloqueio falso REAL**, não hipotético: das 38 levas
com RPC literal, a única com irmã ausente (`tint-sync-agent`) tem as duas irmãs APOSENTADAS —
`estimar_impacto_exclusao_outlier` (`20260718093248_drop_…`) e `import_tint_formulas`
(`20260806223407_drop_…`). "Toda irmã ausente bloqueia" travaria essa leva sem razão.

## O conserto

- `CorposEsperados.vigencia` (obrigatório): `VigenciaNoRepo` por NOME — a granularidade da sonda, que mede
  `proname` —, montada por `vigenciaPorNome(modelarRepo(lidas))` em `pendencias-pacote.ts` (e no sensor).
- `vigenciaPorNome` é fail-closed: basta uma identidade viva para `VIGENTE`; assinatura ilegível (no
  `CREATE` ou no `DROP`) ⇒ `INDETERMINADA`; `CREATE` perdido pelo extrator derruba só a `APOSENTADA`; nome
  que só o controle solto viu ⇒ `INDETERMINADA`; nome que VOLTOU a `public` por `RENAME TO`/`SET SCHEMA
  public` depois de aposentado ⇒ `INDETERMINADA` (o modelo não reconstrói a identidade que entra).
- O modelo só aposenta o que **executa no apply** (`ddlQueExecuta`): DDL de topo e comando estático direto
  no corpo de `DO`. O texto de qualquer outro dollar-quote — literal de `SELECT`, argumento de `format()`,
  corpo de função que o extrator perdeu, dollar-quote aninhado no `DO` — não remove nada. E `"int4"` (tipo
  citado em minúsculas) é `integer`; `"char"` segue sendo o tipo interno, distinto de `char`.
- No julgamento: irmã **VIGENTE e ausente** ⇒ `ausentes` com a marca `irma` (procedência e último
  `CREATE`) ⇒ BLOQUEADA, com "APLIQUE essa migration" e a mesma ressalva de DML do corpo anterior (agora
  uma constante só); **APOSENTADA e ausente** ⇒ não conta, com o motivo no rodapé; **INDETERMINADA ou fora
  do mapa, e ausente** ⇒ INCERTA, dizendo que o "não sei" é do modelo do repo.
- **A vigência só decide sobre a AUSÊNCIA.** A irmã PRESENTE segue no eixo de corpo como sempre, aposentada
  ou não. A 1ª versão deste fix tirava a aposentada presente do eixo de corpo — e o Codex mostrou, executando,
  que a aposentadoria do modelo pode ser falsa: um bloqueio legítimo da main virava colagem. Com a vigência
  restrita à ausência (onde a main liberava sempre), o diff é **monotônico**: não libera nada que a main bloqueava.

## Evidência

- **Censo de prod** (`psql-ro -q -v ON_ERROR_STOP=1`, uma sonda para a união dos nomes de todas as levas,
  `origin/main@b88a4f851`, 760 migrations; canal íntegro: marcador de fim, dialeto, 494 funções em `public`,
  zero falha no canal de texto). 97 edges, **38 levas** com RPC literal, 102 nomes sondados. A saída CRUA
  da sonda foi salva e julgada duas vezes — o "antes" e o "depois" leem a MESMA medição:

  | | LIBERADA | BLOQUEADA | INCERTA |
  |---|---|---|---|
  | antes (main) | 36 | 0 | 2 (indireção, eixo 3) |
  | depois (este diff) | 36 | 0 | 2 |
  | controle: depois com `vigencia` VAZIA | 35 | 0 | 3 (`tint-sync-agent`) |

  **Nenhuma leva real muda de veredito.** A única com irmã ausente segue LIBERADA pelo motivo certo (o
  rodapé nomeia as duas como APOSENTADA, com a migration de cada `DROP`), e o controle prova que é a
  vigência que a segura — sem ela, a mesma leva cai em INCERTA. Irmã VIGENTE ausente: 0 em prod hoje; o
  caminho que BLOQUEIA está provado nos testes, não no banco.
- **TDD.** Linha de base 237/237 nos 3 arquivos, árvore limpa. RED com o fonte intocado: **258 testes, 18
  vermelhos — exatamente os novos**, cada um pelo motivo esperado (o reprodutor do Codex saindo LIBERADA e
  `exit 0` com colagem; a aposentada presente BLOQUEADA pelo eixo de corpo; `vigenciaPorNome is not a
  function`), e os 3 controles da lib verdes na mesma invocação. GREEN: **259/259** (os 258 + o teste que torna alcançável o guard "nome sem identidade modelada ⇒ INDETERMINADA").
  2ª rodada (os achados do Codex): RED sobre o commit da 1ª, fonte intocado — **270 testes, 10 vermelhos,
  exatamente os novos**, cada um pelo motivo esperado (texto em dollar-quote e ida e volta saindo APOSENTADA;
  `"int4"` não aposentando; a aposentada presente LIBERADA; os 2 de ponta a ponta saindo 0), com os 2 controles
  de aposentadoria legítima (DROP estático no `DO`, e a forma real da `fu7`) verdes. GREEN: **270/270**; vitest
  de `scripts/` 79 arquivos, **3050/3050**; typecheck, knip, eslint, `lint:shell` e o harness, todos 0.
- **Monotonicidade, por força bruta** (o gate da `origin/main` carregado ao lado do atual): 1.536 combinações de
  alvo × irmã (sem linha, ausente, em dia, anterior, deriva, sem corpo, overload, cosmética) × vigência ×
  histórico × indireção × canal × marcador. **0** casos em que a main bloqueava e o atual libera; **6** em que a
  main liberava e o atual bloqueia — todos com a irmã AUSENTE e vigência VIGENTE, INDETERMINADA ou fora do mapa.
- **Auto-desafio do modelo** (17 cantos: `DO LANGUAGE`, `UNDO`, `$` em identificador e em literal, barra no `E''`,
  `$1`, delimitador sem fecho, CRLF, tag unicode aninhada, ordem da volta no arquivo e entre arquivos, CREATE
  depois da volta, RENAME de outro schema): 16 certos de primeira; o 17º — `RENAME TO "G"`, citado com
  maiúscula, é OUTRO nome — marcava um retorno falso de `g` (INDETERMINADA, o lado seguro). Corrigido com teste e
  mutação próprios. Com ele: GREEN **271/271**; vitest de `scripts/` 79 arquivos, **3051/3051**; typecheck, knip,
  eslint, `docs:indice`/`links`/`citacoes` e o harness, todos 0 — e só então o commit.
- **O modelo não mudou no repo real**: `vigenciaPorNome` do commit anterior × do novo sobre as 760 migrations —
  327 nomes, 320 VIGENTE + 7 APOSENTADA nos dois, **0 diferenças**; aposentadas (identidade@migration),
  ilegíveis e perdidas idênticas. O endurecimento fecha os caminhos reproduzidos sem mexer no que prod tem hoje
  (nem no sensor `deriva:corpo:prod`, que usa o mesmo modelo). O censo sobre a mesma sonda repetiu 36 · 0 · 2.
- **Ponta a ponta** (`scripts/pendencias-pacote.test.ts`): o reprodutor sai **3, sem colagem, nos dois
  transportes** (sonda local e `--dados-nuvem`), com pacotes idênticos; o controle (irmã aposentada por
  `DROP` posterior) sai 0 com a colagem.
- **Harness de mão** (`bun run falsificar:gate-corpo`): 14/14, com o controle verde antes das sabotagens e
  o par novo (VIGENTE ausente ⇒ BLOQUEADA; INDETERMINADA ⇒ INCERTA; APOSENTADA ⇒ LIBERADA).
- **Gates da 1ª rodada** (um job sob o `heavy`, exit de cada um capturado à parte): vitest de `scripts/` **79 arquivos, 3039/3039** · `typecheck` (app + scripts/db) 0 · `knip` 0 · eslint 0 · `lint:shell` 0 achados em 484 arquivos.
- **mutcheck** (com a árvore commitada; `MUTCHECK_DIR` com os 9 contratos que o diff alcança): **60/60 mutações
  pegas**, 0 sobreviventes, 0 inválidas, controle+ em todos; os 3 novos — `precondicao-irma-vigencia` 9/9,
  `vigencia-por-nome` 15/15, `pendencias-pacote-vigencia` 1/1. Árvore limpa depois da sabotagem.
- **PG17 do sensor** (`db/test-audit-deriva-corpo-prod.sh`): **28 ok · 0 falhas** em `C` e em `pt_BR.UTF-8` — o
  mesmo total de antes; o sensor, que usa o mesmo modelo, não mudou de comportamento.

## 2ª opinião (Codex)

Adversarial no diff da 1ª versão (`gpt-6-astra` · `max` · 733 s · 195.270 tokens). **O que o Codex disse**
(cru, resumido): "seguraria o diff por dois P1"; nenhum P0. Reproduzidos com migrations e sondas sintéticas:

1. **P1 novo** — aposentadoria FALSA removia um bloqueio válido do eixo de corpo: `SELECT $nota$DROP FUNCTION
   public.g();$nota$;` (texto) aposentava `g`, e com `g` anterior em prod o veredito ia de BLOQUEADA para
   LIBERADA (`main` 0 com colagem). O mesmo com `DROP` no corpo de uma função que o extrator perde.
2. **P1 novo** — ida e volta por `RENAME` (ou `SET SCHEMA private` e de volta) deixava `g` aposentada para
   sempre: BLOQUEADA → LIBERADA.
3. **P2 novo** — `DROP FUNCTION public.g("int4")` não aposentava `g(p integer)`: bloqueio falso mandando recriar
   uma função legitimamente removida.
4. **P1 preexistente** — irmã sem corpo dollar-quoted (`RETURN 7`) não entra no conjunto acoplado: nem é sondada.
5. **P2 preexistente** — overload aposentado segue fornecendo o "último corpo" do nome ao histórico.

Sobre o desenho: concordou com a redução ao nome (para julgar AUSÊNCIA), com a ação apontar o último `CREATE`
vivo, com a vigência obrigatória e o nome fora do mapa ⇒ INCERTA; concordou com dispensar a aposentada presente
só "quando a aposentadoria estiver comprovada"; e mostrou que a política de DDL dinâmica não valia
universalmente (`EXECUTE format($sql$DROP …$sql$)` sob `IF FALSE` aposentava). Concedeu: o reprodutor original
bloqueia; ausência de linha `rpc` prevalece; irmã que é alvo não duplica; INCERTA não manda aplicar;
`origemDasIrmas` preserva `alvosDeCorpo` nos 326 nomes das 760 migrations.

**Minha calibração** (decisão minha, não do Codex): 1 e 2 aceitos — a regressão vinha de uma extensão MINHA
(dispensar a aposentada presente). Corrigi nas duas camadas: a vigência deixou de decidir sobre a irmã presente
(monotonicidade), e a causa no modelo foi fechada (só conta o que executa no apply; retorno por RENAME/SET SCHEMA
⇒ INDETERMINADA). 3 aceito (canonização do tipo citado). 4 e 5 ficam declarados abaixo — preexistentes, com a
exposição medida.

**Rodada de confirmação: NÃO rodou.** O `codex-async.sh` recusou no preflight sem gastar a chamada
(`SALDO_ALTO`: cota em 89% contra o teto de 85%; a janela de 7 dias reabre em 09/10 19:30). O delta seguiu pelo
Caminho B — a monotonicidade por força bruta e o auto-desafio acima, mais o mutcheck. **O delta da 2ª rodada
não teve revisão independente** — a auto-prova só cobre o intervalo, não a substitui.

**Decisões do founder (2026-10-05):** Caminho B aceito — o PR sai de DRAFT sem esperar a janela (`sem-codex:` no
corpo do #2800) — e a **revisão retroativa do Codex DISPENSADA**: não há rodada pendente para este delta, e o
prompt preparado no corpo do PR fica só como registro. Antes disso, o merge da `origin/main` trouxe o #2802 para o mesmo `deriva-corpo.ts`
(`modelarRepo` → `drenar(modelarRepoPassos(...))`, `yield` no fim de cada migration), e tudo rodou de novo sobre o
código mesclado: 271/271 nos três arquivos de teste, mutcheck 17/17 nos dois contratos do `deriva-corpo.ts`
(controle+), seco 58/58, harness falsificado e o carimbo `authz` regravado (o auditor `corpo` juntou os dois PRs).

## O que segue descoberto (declarado)

- **Irmã sem corpo dollar-quoted fora do conjunto acoplado** (achado 4): o conjunto sai do `historicoDeCorpos`,
  que só tem `CREATE` com corpo. Exposição medida: **1** identidade no repo inteiro
  (`omie_sync_identity_snapshot`, na `20260821192817`), que o sensor `deriva:corpo:prod` já cobre por existência.
- **Overload aposentado no histórico por nome** (achado 5): pode dar `CORPO_ANTERIOR` falso (bloqueio). 0 casos.
- `DROP` estático no corpo de `DO` conta mesmo sob um `IF` que nunca rode — o modelo não avalia condição de
  PL/pgSQL. A forma real do repo (`IF to_regprocedure(…) IS NOT NULL THEN … SET SCHEMA private`) é exatamente
  a que precisa contar.
- `DROP` por DDL dinâmica (`EXECUTE format('DROP FUNCTION …')`) não tem alvo legível: a função segue
  VIGENTE no modelo e a ausência dela vira BLOQUEADA — o mesmo limite, e a mesma escolha, do sensor
  (`remocoesDe`). Nenhum caso no censo.
- O alvo (RPC da leva) ausente e APOSENTADO no repo continua BLOQUEADA com a ação de família: a edge chama
  uma função que o repo removeu, e isso não é pré-condição de banco, é a edge errada.
