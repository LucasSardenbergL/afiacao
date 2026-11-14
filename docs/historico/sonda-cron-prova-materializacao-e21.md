# Materialização da `sonda-cron-prova` por arquivo, conferência e 1 retry (E21, plano v9)

**Data:** 2026-11-11 · **Escopo:** só `scripts/sonda-cron-prova.ts` e o teste · sem deploy.

## Incidente

Run **43029163344**, tentativa 1, job `sonda-cron-prova` (`bun run sonda:cron-prova -- --gate`): `tar: Unexpected EOF in archive` ao materializar um closure da `fin-valor-cockpit`. O re-run do mesmo SHA (5b64a423) deu verde. Foi 1 vermelho falso em ~80 execuções, e o fail-fast cancelou junto as 16 partes de `provas-sql` e as 3 do mutcheck.

## O que mudou

O caminho antigo era `execFileSync('git', ['archive', …], { maxBuffer })`, depois `writeFileSync` e `tar -x`. Agora é `materializarClosure()`:

1. `git archive --format=tar -o <dir>/c.tar <sha> -- <caminhos>`: o git escreve o arquivo, e o tar não passa mais pelo buffer do processo pai.
2. `tar -x` com o exit conferido.
3. **Conferência:** cada blob de `git ls-tree -r -l <sha>` tem de existir no disco com o tamanho exato. Exit 0 do tar não prova o closure inteiro: um corte em fronteira de bloco extrai metade e sai 0.
4. Se qualquer etapa falha, uma 2ª tentativa num diretório **novo**. Cada falha sai no stderr com `sha · etapa (archive/extracao/conferencia) · tamanho · exit · stderr`. Se persistir, vira `Mecanica`, e o `main` sai com **exit 2**.

Não muda nenhum gate, veredito ou cache. O que se repete é só a cópia dos arquivos; ausência de materialização continua sendo mecânica, nunca "closure limpo".

## A causa continua NÃO provada

Pelo contrato do Node, a falha do processo lança exceção, mas o CI roda sob Bun 1.3.14. Diferença de runtime no buffer é hipótese, não causa. Se o EOF voltar, a linha `⚠ materialização … falhou (tentativa 1/2)` no log do job traz o dado que faltou desta vez (etapa, tamanho, stderr). Não generalizar 1 em 80 como taxa.

## Provas

- `scripts/sonda-cron-prova.test.ts`, bloco `materializarClosure`, num repo git temporário:
  - controle sem retry;
  - tar truncado em 700 B → `etapa=extracao` e acerto na 2ª, em diretório novo, com o 1º apagado;
  - arquivo ausente com tar exit 0 → `conferencia`;
  - arquivo cortado → `conferencia` pelo tamanho do blob;
  - falha persistente → `Mecanica` com as 2 tentativas.
- Falsificação com controle verde na mesma invocação: S1 sem conferência, S2 sem retry, S3 retry no mesmo diretório, S4 persistência sem throw e S5 exit do tar ignorado deram **5/5 vermelhos**.
- `bun run sonda:cron-prova -- --gate` local, com o caminho real: **exit 0**, 747 de 748 closures PASSA (1 NAO_COMPILA já dispensado, `omie-sync-nfes-recebidas@b880daeb1`) e **0** retries de materialização.
