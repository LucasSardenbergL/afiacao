# A senha do bootstrap: quem segurava era um agente atento, agora é uma máquina (2026-09-09)

**Entrega:** `db/claude-rw-bootstrap.sql` carrega o placeholder `TROQUE_ESTA_SENHA`. O founder o
troca pela senha real para colar no SQL Editor do Lovable, e tem de restaurá-lo depois. Em
2026-09-07/08 ([db-aplicar-colagem-manual-vira-comando.md](db-aplicar-colagem-manual-vira-comando.md))
a senha real ficou na árvore de trabalho **duas vezes**. Nenhuma foi commitada — o que impediu foi
um agente conferir na hora, e o único freio que restou foi uma frase naquele doc. Agora são duas
máquinas: `bun run gate:senha-bootstrap` (passo do CI) e um `pre-commit` que roda o mesmo script
com `--staged` (`bun run hooks:instalar`).

## As lições

### 1. Detectar ≠ impedir — e o CI só sabe detectar

O gate de CI reprova o PR, mas **quando ele fala, o commit já está no remoto e a senha com ele**. A
única resposta correta ali é ROTACIONAR, e a mensagem do gate diz isso em vez de mandar "corrigir".
Quem *impede* é o hook local. Chamar o gate de CI de "proteção da senha" seria a versão desta
classe do `ausente ≠ zero`: confundir o sensor com o freio.

As duas camadas cobrem buracos diferentes de propósito, e nenhuma cobre a outra:

| | pre-commit (`--staged`) | CI (`gate:senha-bootstrap`) |
|---|---|---|
| impede a senha de existir no remoto | **sim** | não — só detecta |
| vale em todas as ~30 worktrees | **sim** (compartilham `.git/hooks`) | sim |
| vale em outra máquina / outro clone | não (precisa instalar lá) | **sim** |
| vale sob `git commit --no-verify` | não | **sim** |
| vale no commit que o sync do Lovable cria | não (nasce fora da máquina) | **sim** |

### 2. Um hook basta para ~30 worktrees — medido, não suposto

`core.hooksPath` aponta, no escopo `local` do repo principal **e** no `config.worktree` de cada
worktree, para o mesmo `<repo>/.git/hooks`. Instalar um arquivo lá vale para todas as worktrees
existentes e para as futuras. O instalador resolve o destino por `git rev-parse --git-path hooks`
(que honra `core.hooksPath`) em vez de ler o config na mão — ler na mão erraria justamente em
worktree. O que é instalado é um **shim**; a lógica fica versionada em `scripts/`, então melhorar o
gate melhora o hook instalado sem reinstalar nada.

### 3. O gate de segredo não pode imprimir o segredo — e isso se resolve na FORMA da regex

Um gate que ecoa a linha ofensora "para ajudar" publica a senha no log do CI, que persiste. Aqui
isso não depende da disciplina de quem edita o script: as duas regexes casam apenas a palavra-chave
e a aspa de abertura (`PASSWORD '`), então `grep -o` é **incapaz** de emitir o conteúdo do literal.
A saída é sempre `arquivo` + número de linha. A suíte sabota com uma senha falsa marcada e exige
duas coisas ao mesmo tempo: vermelho **e** a string ausente da saída — vermelho sozinho passaria
com um gate que vaza.

### 4. Sem stripper de comentário, porque o critério certo não precisa dele

O risco não é a palavra "password" — é um **literal**. Medido contra o repo inteiro em 2026-09-09:
`PASSWORD` seguido de literal aparece **uma vez**, e é a canônica; os comentários que citam
`encrypted_password` de passagem não casam, porque não abrem literal. Isso dispensa a limpeza de
comentário que o CLAUDE.md proíbe fazer com regex local (ela erra dos dois lados). Se um dia um
comentário escrever `PASSWORD 'x'` literalmente, o gate reprova — ali o "falso positivo" é
verdadeiro, porque senha comentada vaza igual.

A keyword é casada por classe explícita (`[Pp][Aa]…`) e **não** por `grep -i`: SQL é
case-insensitive na keyword, mas o placeholder é um literal exato — com `-i` global,
`troque_esta_senha` minúsculo passaria por canônico e o gate perderia o dente. O caso S6 da
falsificação existe só para isso, e roda nos dois locales.

### 5. A falsificação achou um defeito no cenário MAIS provável, e o rc não denunciava

A primeira versão cobrava a âncora (`o arquivo tem a forma canônica?`) **antes** de varrer os
literais. Trocar o placeholder pela senha faz a âncora sumir junto — então o caso real, o único que
já aconteceu duas vezes, era acusado como `BOOTSTRAP-SEM-ANCORA`: "âncora ausente", quando a coisa
a dizer era *há uma senha neste diff, rotacione*. **O rc era 1 nos dois casos**; só o marcador
distinguia. É o argumento de sempre contra asserção frouxa — "saiu diferente de zero" teria
aprovado o diagnóstico errado. Fix: a varredura vem primeiro; a âncora só é cobrada quando não há
achado, e passa a servir ao que ela realmente protege — a evasão por `format(%L)`, que faz a
cobertura sumir sem deixar literal (caso S10).

### 6. Duas expectativas do teste estavam erradas, e o gate estava certo

`password 'troque_esta_senha'` e `PASSWORD 'COLOQUE_AQUI'` disparam `BOOTSTRAP-SENHA-LITERAL`, não
`SEM-ANCORA` — os dois *são* literais não-canônicos, e esse é o diagnóstico mais informativo. A
correção foi na expectativa. Vale registrar porque a tentação oposta — mexer no alvo até casar o
teste — é como um gate perde o dente sem ninguém notar.

### 7. O gate novo teve de pagar o pedágio — e a medição devolveu um resultado incômodo

O CI reprovou o PR com `GATE_NOVO_SEM_EXCLUSIVIDADE`: o gate `exclusividade` cobra de todo gate
novo a prova de que ele pega algo que nenhum outro pega ("um gate custa segundos em todo PR, para
sempre; a prova é o preço"). O defeito escrito para pagar é o **real** — a senha no lugar do
placeholder — e o resultado medido foi:

```
VERMELHOS: gate:senha-bootstrap, test:hooks     (23 verdes; poda em 2, 3 desconhecidos)
[redund] gate:senha-bootstrap  exclusivos 0/9
```

**Dois gates pegam, e o segundo é a própria suíte deste gate** — `test:hooks` roda
`test-gate-senha-bootstrap.sh`, cujo caso N3 executa o gate contra o repo de verdade. A
exclusividade zero é artefato de o teste ser bom, não sinal de gate inútil. Daria para "ganhar"
exclusividade apagando o N3; seria piorar a suíte para melhorar a métrica, exatamente o oposto do
que a métrica existe para provocar. Ficou medido e declarado (`EXCLUSIVIDADE_ZERO` é **RELATA**, não
reprova). O que o passo dedicado acrescenta sobre o `test:hooks` é o sinal **nomeado** e a mensagem
certa (*rotacione*) em 4s, em vez de enterrada em 100s de suíte — e é o mesmo script que serve ao
pre-commit, que é a camada que de fato impede.

Dois atalhos que destravariam na hora e foram recusados, ambos por fabricarem veredito:
`--ignorar-baseline` registraria o `exclusividade` como tendo pego o defeito, quando o vermelho dele
era sobre o *ato de medir*; e a **lista de dispensados** é para gates pré-existentes de quando a
matriz nasceu — um gate novo se auto-dispensando da regra que existe para gates novos é o pecado que
o próprio `matriz.def` narra. A saída correta foi medir com os 28 gates, excluindo só o
`exclusividade`, que demonstravelmente não lê `.sql`.

## O que continua sem freio de máquina

`git commit --no-verify` pula o hook (é desenho do git; o caso N13 da suíte **afirma** isso em vez
de supor), e o pre-commit precisa ser instalado uma vez por clone. Um `pre-push` fecharia o
primeiro buraco pela metade e foi deixado de fora por simplicidade: o CI já é o backstop que não
se pula.

## O que foi avaliado e recusado: tirar a senha do arquivo

Tentador, e não cabe **agora**:

- **`\prompt` do psql** não existe no SQL Editor do Lovable (é feature do cliente psql).
- **Gerar a senha dentro do SQL** (`EXECUTE format('CREATE ROLE … PASSWORD %L', gen_random_bytes…)`)
  e devolvê-la num `SELECT` final tiraria a senha do disco por completo — mas depende de
  comportamento **não medido** do SQL Editor (notices visíveis, temp table sobrevivendo ao pooler)
  e mexe no caminho de DR do banco de produção, que hoje funciona e roda uma vez só.
- **`set_config` no topo do arquivo**, movendo o ponto de edição para a primeira linha, tem o mesmo
  problema: assume sessão única entre statements.

O que foi feito no lugar é procedimental e de custo zero: o cabeçalho do arquivo agora manda trocar
o placeholder **dentro do editor, depois de colar** — o arquivo em disco nunca vê a senha. O gate é
o que torna isso verificável em vez de combinado.
