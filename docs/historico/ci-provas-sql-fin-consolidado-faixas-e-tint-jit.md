# Provas SQL: a `fin-consolidado-ic --falsificar` em 2 faixas, e o JIT que pesava na `tint-corante-giro` (2026-11-11)

Continuação de `ci-provas-sql-radar-privacidade-faixas.md`. Depois do #3857, a pior parte do `provas-sql`
(16 partes × 3 workers, run 43112361077) era de **388 s**, puxada pela `test-tint-corante-giro` NORMAL
(236 s, numa prova `falsificar=fora-do-ci`). A segunda pior era de 347 s, puxada pela
`test-fin-consolidado-ic --falsificar` (286 s, 70 sabotagens).

## tint-corante-giro: era o JIT, não o volume

- **O que é caro.** Medi cada statement com `\timing` dentro dos cenários. O template (snapshot vivo +
  migrations) leva ~9 s, e cada clone `FILE_COPY` de 0,1 a 3 s. O custo está em `tint_corante_giro_em`:
  **2 a 11 s por chamada**, sobre dados mínimos. A prova faz 33 chamadas, em 16 cenários.
- **Por que é tão mais caro no CI** (236 s contra ~100 s no Mac): o PG17 do PGDG no runner vem com JIT
  ligado, e o do Homebrew não tem (`pg_jit_available()` = f). O plano da função tem CTEs e o P90 por janela
  deslizante (subconsulta correlacionada sobre o `diario` materializado), com custo estimado acima do
  `jit_above_cost`, então o LLVM compilava o plano a cada chamada. É o mesmo caso da `db/test-radar-funil.sh`
  (133 s no CI contra 4 s local).
- **A correção:** `-c jit=off` no `pg_ctl` da prova, que é o espelho da prod (`SHOW jit` = off, psql-ro
  2026-11-11). Não muda o resultado de nenhuma consulta, só o tempo, e não mexe em assert nem em sabotagem.
- **Descartado:** cachear a chamada por cenário. Pouparia ~9 das 33 chamadas, mas vários cenários escrevem
  entre uma leitura e outra (G4, G9, G10, G11, G13), e o G8 troca o `TIME ZONE` da sessão entre as chamadas.
  Isso mexeria no mecanismo do assert, para pouco ganho.
- **Visto e NÃO tratado:** o P90 é O(dias²) por WP (para cada dia, uma subconsulta soma a janela sobre o
  `diario` inteiro). A prova já usa 14 WPs × 180 dias, e a função leva ~2 s por chamada no Mac sem JIT. A
  latência na prod NÃO foi medida (o gate de staff barra o `claude_ro`).
  Se a tela do giro ficar lenta, o caminho é uma soma por janela (`sum() OVER (… RANGE …)`), numa migration
  com prova própria. Não é coisa de CI.

## fin-consolidado-ic: só volume, partida em 2

- **Procurei medição sem teto** (`statement_timeout`, `\timing`, EXPLAIN ANALYZE, `generate_series` grande):
  não há. O modo normal leva 14 s no Mac carregado (102 asserts), e a falsificação são 71 invocações
  disso. ~286 s no CI ≈ 71 × ~4 s, uniforme.
- **O que mudou:** o idioma da radar, sem diferença de contrato. `NUCLEO_FAIXA=i/k` roda o controle verde e
  a fatia canônica i de k, e emite `FAIXA: i/k sabotagens a-b de T`. T é contado por `wc -w`. O `LOGDIR` e o
  `WORK` são `mktemp` por invocação, e a porta é do slot do worker, então as 2 faixas juntas não disputam log
  nem porta. Manifesto: `faixas=2` (1–35 e 36–70).

## Medido

- **Local:** runner com o manifesto das 2 provas (`NUCLEO_WORKERS=3`): `SQL_PROOF_OK provas=2/2
  falsificacoes=2/2`, exit 0, com as faixas 1–35 (202 s) e 36–70 (194 s). `db/falsifica-nucleo-ci.sh` deu
  exit 0 e `FALSIFICACAO: OK=115 XX=0` tanto em C quanto em pt_BR.
- **CI, 1º run do PR (43145558990), step Núcleo:** `tint-corante-giro` normal **236 → 104 s**, o JIT
  confirmado. As faixas da `fin-consolidado-ic` levaram **164 e 155 s** (antes, uma unidade de 286). Mas a
  pior parte foi **399 s** (parte 13), porque a partição mudou e outra prova normal passou a puxar: a
  `tint-fase5-watchdog` (**240 s** no CI contra 34 s no Mac sem JIT, a mesma assinatura). Ela ganhou `jit=off`
  no mesmo PR. A `rls-has-role-initplan-classe` (289 s no CI, 186 s local) é volume, não JIT, e ficou de fora.
- **A classe:** prova que roda o PG17 do PGDG sem `jit=off` paga a compilação LLVM em todo plano caro, e o
  Mac não tem JIT para mostrar isso. As que já espelham a prod: `radar-funil`, `radar-funil-agenda`,
  `radar-medicao` e, agora, `tint-corante-giro` e `tint-fase5-watchdog`. Ligar `jit=off` no `pg-harness`
  para todas seria fechar a classe, e fica para outra entrega, medida.

- **CI, 2º run do PR (43147391328), com a watchdog já em `jit=off`:** a pior parte caiu de **388 para 323 s**
  (−65 s). Por unidade: `tint-fase5-watchdog` **240 → 15 s**, `tint-corante-giro` 83 s, `fin-consolidado-ic`
  com faixas de 114 e 107 s, e `radar-privacidade-j` com faixas de 93 e 102 s.
- **O novo piso:** a parte 2 (323 s) é puxada pela `hoje-sp-views-defaults --falsificar`, com **303 s**, na faixa
  SERIAL. É a frente das esperas K1/K2 em paralelo, que o `/codex` já recomendou. A próxima da fila é a
  `sayerlack-cancelado-com-compra-viva --falsificar`, com 256 s.
