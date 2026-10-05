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
  que só o controle solto viu ⇒ `INDETERMINADA`.
- No julgamento: irmã **VIGENTE e ausente** ⇒ `ausentes` com a marca `irma` (procedência e último
  `CREATE`) ⇒ BLOQUEADA, com "APLIQUE essa migration" e a mesma ressalva de DML do corpo anterior (agora
  uma constante só); **APOSENTADA** ⇒ fora do conjunto, presente ou não, com o motivo no rodapé;
  **INDETERMINADA ou fora do mapa, e ausente** ⇒ INCERTA, dizendo que o "não sei" é do modelo do repo.
- Decisão de escopo, explícita: a aposentada **presente** também não conta. Mandar "APLIQUE" o `CREATE` de
  uma função que o repo removeu é ordem errada; a sobrevivente é achado do `deriva:corpo:prod`
  (RESSUSCITADA), não do gate de deploy. Censo: 0 casos hoje.

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
- **Ponta a ponta** (`scripts/pendencias-pacote.test.ts`): o reprodutor sai **3, sem colagem, nos dois
  transportes** (sonda local e `--dados-nuvem`), com pacotes idênticos; o controle (irmã aposentada por
  `DROP` posterior) sai 0 com a colagem.
- **Harness de mão** (`bun run falsificar:gate-corpo`): 14/14, com o controle verde antes das sabotagens e
  o par novo (VIGENTE ausente ⇒ BLOQUEADA; INDETERMINADA ⇒ INCERTA; APOSENTADA ⇒ LIBERADA).
- **Gates** (um job sob o `heavy`, exit de cada um capturado à parte): vitest de `scripts/` **79 arquivos, 3039/3039** · `typecheck` (app + scripts/db) 0 · `knip` 0 · eslint 0 · `lint:shell` 0 achados em 484 arquivos.
- ⟪mutcheck · PG17 do sensor⟫

## 2ª opinião (Codex)

⟪parecer cru + calibração⟫

## O que segue descoberto (declarado)

- `DROP` por DDL dinâmica (`EXECUTE format('DROP FUNCTION …')`) não tem alvo legível: a função segue
  VIGENTE no modelo e a ausência dela vira BLOQUEADA — o mesmo limite, e a mesma escolha, do sensor
  (`remocoesDe`). Nenhum caso no censo.
- O alvo (RPC da leva) ausente e APOSENTADO no repo continua BLOQUEADA com a ação de família: a edge chama
  uma função que o repo removeu, e isso não é pré-condição de banco, é a edge errada.
