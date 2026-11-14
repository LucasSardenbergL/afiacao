# Pin da minor do PG17 no `provas-sql` (2026-11-13)

**Incidente:** #3877. O PGDG subiu o `postgresql-17` de 17.11 para 17.12, e o CI não tinha pin. Um
deadlock 40P01 no PRE anti-deriva, que só a 17.12 expunha, deixou `provas-sql (10)` vermelho em
**todo PR com SQL** de 2026-11-12 17:33Z a 11-13 13:08Z (19,6 h; 7 PRs parados de 18 a 36 h). Depois
do conserto, os PRs presos ficaram mais ~9 h parados porque ninguém re-empurrou (regra nova em
`docs/agent/worktrees.md` §Conserto comum mergeado).

## Desenho

- **Fonte única:** `env:` do job `provas-sql` no `ci.yml`: `PG17_MINOR: '17.12'` e
  `PGVECTOR_VERSAO: '0.8.7'`. O bump é deliberado, por PR.
- **O pin é prefixo, não versão Debian completa.** `17.12` casa `17.12-1.pgdg24.04+1` e qualquer
  rebuild. Pin completo (`…pgdg24.04+1`) deixaria vermelho todo PR no dia em que o `ubuntu-latest`
  trocasse de codename: o mesmo modo de falha do incidente, só que por outro motivo. Custo aceito: um
  rebuild `+1`→`+2` muda o pacote sem PR. A minor e o ABI não mudam.
- **Resolução:** depois do `apt-get update` só do PGDG, `apt-cache madison` (consulta local) pega a
  versão mais nova com o prefixo para `postgresql-17`, `postgresql-client-17` e
  `postgresql-17-pgvector`, e o install vai com `pkg=versao`.
- **O medo antigo** (o comentário do step dizia "o PGDG remove pacotes antigos do índice, e o pin
  viraria vermelho por AMBIENTE") tem saída. Medido em 2026-11-13: o índice principal `noble-pgdg`
  guarda só 17.10/17.11/17.12. O `apt-archive.postgresql.org` (suite `noble-pgdg-archive`, assinada
  pela mesma chave ACCC4CF8, conferido no `InRelease`) guarda 17.6…17.11 e copia **toda** versão
  publicada, todo dia. Se o pin sair do principal, o step adiciona o archive, faz **um** update só
  dele (sob o `tentar`, `timeout 90`, `--error-on=any`) e resolve de novo. Se nem lá houver a versão,
  o step dá `::error::` e sai 1 (fail-closed).
- **`schedule` ignora o pin.** O cron diário da main instala a minor mais nova. Se ela quebrar
  alguma prova, a Issue `ci-main-red` abre com `- Evento: \`schedule\`` e um texto que aponta para
  cá. **Ela só fecha com outro `schedule` verde**: o run pós-merge (`workflow_dispatch`, com pin)
  verde não desmente a minor nova (achado do Codex, ver abaixo). Nenhum job ou sensor novo: é o cron
  e a Issue que já existiam.
- **Conferência positiva:** `initdb --version` tem de conter `(PostgreSQL) <minor> `. O espaço final
  impede `17.1` de casar `17.12`. Também `dpkg-query` do client e do pgvector contra o pin. O log
  ganha a linha `PG17_PIN_OK minor=… pgvector=…`.

## Provas

- `scripts/lab-retry-pgdg/lab.sh` (roda o texto REAL do step com dublês, zero rede) ganhou os
  cenários C11–C18: pin fora do índice principal → archive · pin inexistente → vermelho antes do
  install · `schedule` sem pin · pin vazio fora do schedule → vermelho · archive quebrado → exit do
  apt · initdb de outra minor · pin 17.1 × initdb 17.12 · pgvector fora do pin. Resultado: 59 ok.
- `falsifica.sh` ganhou S11–S16, uma camada do pin por vez. Total de 34 ok, com o controle verde
  na mesma invocação, em `C` e `pt_BR.UTF-8`. Os padrões S7–S9 foram ancorados no update do PGDG
  principal, porque o update do archive repete as mesmas opções e o padrão solto casaria 2x.

## 2ª opinião (Codex, `codex-async.sh`, 2026-11-13)

Acatado:
- **(d) BLOQUEIA:** o fecho da `ci-main-red` fechava a Issue do `schedule` no próximo run com pin
  verde. Corrigido como descrito acima.
- **(e) furo de máscara:** `{ apt-cache madison … || true; }` escondia a falha da ferramenta.
  Agora "versão ausente" (return 1 → archive) é separada de "madison falhou" (return 2 → reprova).
- Conferir também o pgvector e o client (C18), e o caso 17.1 × 17.12 (C17 e S15).

Não acatado, com motivo:
- **Corrida "resolve no principal e o pacote some antes do download":** a remoção do principal só
  acontece quando sai uma minor nova, uma vez por trimestre. Se a corrida acontecer, o install falha
  pelo caminho de sempre, que é fail-closed (vermelho com o exit do apt). Não abre verde falso.
- **Runner que já traga PG17 pulando a instalação:** hoje o runner não traz PG17. O comentário do
  step mede isso (mínimo de 10 s e `Setting up postgresql-17` em 205 execuções). Se passar a trazer,
  o caminho com pin reprova pela conferência positiva. Só o `schedule` testaria a versão da imagem
  em vez da mais nova.
- **Cache de `.deb` por versão:** o archive resolve o mesmo problema sem eviction e sem instalar
  arquivo local fora do apt.

## Evidência no runner

Run 43544443097 do PR #3892, `provas-sql (1)`, step `PostgreSQL 17 (PGDG)`, 2026-11-14T02:09Z. O
step levou ~13 s, igual à mediana de antes:

```
  pacotes: postgresql-17=17.12-1.pgdg24.04+1 postgresql-client-17=17.12-1.pgdg24.04+1 postgresql-17-pgvector=0.8.7-1.pgdg24.04+2
  initdb (PostgreSQL) 17.12 (Ubuntu 17.12-1.pgdg24.04+1)
  postgresql-client-17 17.12-1.pgdg24.04+1
  postgresql-17-pgvector 0.8.7-1.pgdg24.04+2
  PG17_PIN_OK minor=17.12 pgvector=0.8.7
```

O caminho do apt-archive não rodou: a 17.12 ainda está no índice principal. Ele só tem prova no lab
(C11/C15). O `schedule` sem pin só vai ter evidência no 1º cron depois do merge.

Lição do 1º run: o juiz `scripts/falsificar-exige-assert-gate.ts` guarda as **linhas literais** do
`falsifica.sh` como âncoras. Mudou a lista default de cenários do `roda_lab`, a âncora tem de mudar
junto, senão `testes (3)` reprova.
