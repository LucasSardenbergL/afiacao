# `url_changed` não prova login — e o alerta que existia era cego ao erro que aconteceu

**Incidente:** 2026-08-20, pedido 1939 (OBEN → Sayerlack). Três falhas (10:19, 10:45, 11:15 UTC),
~1h sem ninguém saber a causa. **Entrega:** este PR.

## O achado

A heurística de login era uma `Promise.race` de três sinais, e o mais rápido — *"a URL saiu de
`/login`"* — vencia sempre (poll imediato, sem esperar o DOM). Ele prova apenas que houve
**redirecionamento**, não que a **área logada** abriu. Quando o portal passou a exigir troca de
senha, o redirect foi para a tela de troca: `login_success via url_changed` foi gravado no trace,
o fluxo seguiu confiante e morreu 3s depois esperando o link do menu —
`Waiting failed: 3000ms exceeded`, `erroTipo: "EXCEPTION"`.

O alerta `fornecedor_alerta` "Senha do portal Sayerlack expirou" existia e estava **certo sobre a
causa** — mas era gateado por `erroTipo === "LOGIN_FAILED"`. A falha chegou como `EXCEPTION`,
por fora do `if`. **O aviso certo, atrás da condição errada, é o mesmo que aviso nenhum.**

## O que a evidência de prod mostrou além do relato

`pedidos_portal_tentativas` (psql-ro) tinha mais do que o trace do incidente:

| quando | url pós-login | status |
|---|---|---|
| 40+ logins, jul → 19/08 | `http://portal.sayerlack.com.br:9092/home` | `sucesso_portal` |
| 20/08 10:19 · 10:45 · 11:15 | `https://matriz.sayerlack.com.br/dts/` | falha, `EXCEPTION` |
| 20/08 11:32 | `http://portal.sayerlack.com.br:9092/login/401?message=` | `LOGIN_FAILED` |

Duas leituras que só o histórico entrega: (1) a URL de sucesso **sempre** foi `/home`, então
"não-`/home`" é discriminante medido, não palpite; (2) a 4ª tentativa voltou a bater na origem
configurada e deu **401** — o `SAYERLACK_PORTAL_URL` nunca mudou, quem redirecionou para outro
host foi o portal. A cronologia bate com uma senha trocada no portal entre 11:15 e 11:32, que
invalidou a do secret — e só aí, por acidente de tipo, o alerta disparou.

## A correção

Confirmação **positiva** de dashboard depois do `url_changed`, nas duas edges
(`enviar-pedido-portal-sayerlack` e `sayerlack-captura-precos`). A regra é um helper puro
(`sayerlack-pos-login.ts`, canônico em `src/lib/reposicao/` + espelho byte-idêntico em
`_shared/`, interpolado no Browserless via `${fn.toString()}`):

- `menuLinks > 0` → **dashboard**. Sinal positivo, vence tudo — um item "Alterar senha" no
  dropdown do usuário não pode ser lido como tela de troca de senha.
- texto/URL explícitos **ou** ≥2 campos de senha → **`PASSWORD_CHANGE_REQUIRED`**, erro
  pré-submit (não-retentável: retentar com a mesma senha repete a mesma tela — provado, 3×).
- nada disso → **`POS_LOGIN_NAO_DASHBOARD`**, retentável, relatando só o que foi **observado**
  (inclusive `origemDivergente`). Ausente ≠ senha expirada: o diagnóstico inventado é o que faz
  o founder trocar a senha à toa.

O alerta virou `decidirAlertaPortal(erroTipo, { esgotado, portalUrl })` — pura, testada — e o
insert virou sítio único que **captura `{ error }`**. Causa identificada alerta na hora; causa
desconhecida alerta ao **esgotar** (alertar a cada tentativa dessensibiliza o alerta).

**Não introduz falha nova:** a espera é pelo MESMO sinal que a navegação já exigia 3s adiante.
No caminho feliz resolve assim que o menu aparece. O que muda é o **nome** do que já falhava.

## O efeito colateral que valeu o PR: um fiscal cego por uma string

Ao adicionar um JSDoc `/** … */` no fim da edge, três gates textuais ficaram vermelhos acusando
"dívida quitada" — 10→1, 5→1, 3→1. Nenhuma dívida tinha sido quitada.

Os gates (`escrita-critica`, `erro-object-object`) removem comentários com
`.replace(/\/\*[\s\S]*?\*\//g, '')` antes de medir — regex, **sem entender strings**. E o header
HTTP das duas edges carrega:

```
'Accept': 'text/html,…,image/webp,*/*;q=0.8'
```

O `*/*` do mimetype coringa contém `/*`. Antes, nenhum `*/` vinha depois dela no arquivo, então
o regex não casava nada. **Meu JSDoc foi o par que faltava** — e o `semComentarios` passou a
apagar **1.730 linhas** da edge antes de o fiscal olhar.

Medido em seguida no repo inteiro: **4 arquivos** já viviam com região apagada, e o pior era a
edge irmã — `sayerlack-captura-precos`, **1.041 das 1.226 linhas invisíveis** desde sempre, por
um `} catch { /* … */ }` inline. Destravar aquele único comentário revelou **2 sítios reais** da
classe #1642 que nunca tinham sido medidos (quitados aqui com `mensagemDeErro`) e **1** que não
dá para quitar (vive dentro do template do Browserless, que não importa `_shared` — baselinado
com o motivo).

**A lição:** um gate textual que verde por **cegueira** é indistinguível de um que verde por
mérito — e o gate não tem como saber a diferença sozinho. O sentinela de denominador que esses
gates já têm ("o walker anda de verdade") mede *quantos arquivos* foram lidos, não *quanto de
cada arquivo* sobrou depois da limpeza. Guard novo em
`sayerlack-pos-login-edge-invariants.test.ts`: nas duas edges, `semBloco` tem de ter o mesmo
número de linhas do arquivo bruto.

⚠️ **Aberto (classe, não instância):** o `semComentarios` continua ingênuo para os outros ~3
arquivos e para qualquer arquivo futuro. O conserto real é um stripper que entenda string/regex,
e ele reclassifica dívida do repo inteiro — PR próprio, chip separado.

## O challenge do Codex derrubou meia correção — e a metade que sobrou era a errada

`/codex challenge` (gpt-5.6-sol, xhigh) confirmou que **não há caminho novo de duplicata** — a
proteção `efetivarAttempted` segura — e devolveu **seis furos**, cinco deles de coisas que eu
tinha declarado seguras:

**1. O gate media o efeito de uma interação que ainda não tinha acontecido.** Eu escrevi, no PR e
neste doc, que "a espera é pelo MESMO sinal que a navegação já exigia adiante". Era falso: a
navegação exigia aquele sinal **depois** de clicar em `.app-sidebar-minify-btn`, e o meu gate media
**antes**. Portal que abre com a sidebar minificada ⇒ dashboard legítimo classificado
`POS_LOGIN_NAO_DASHBOARD` ⇒ pedido bom travado. *"É o mesmo sinal" só vale se a ORDEM da interação
for a mesma.* A expansão passou para dentro do gate (expandir → esperar → classificar, uma etapa
só), o que de quebra eliminou o segundo par expandir+esperar que gastava o mesmo deadline global.

**2. A correção cobria a instância, não a classe.** Se a SPA trocar o DOM **depois** do gate, a
navegação morre como `EXCEPTION`, esgota — e `decidirAlertaPortal("EXCEPTION")` devolvia `null`.
**O silêncio original voltava por outra porta.** Agora, ao ESGOTAR, alerta **sempre**: o rótulo
escolhe o texto, nunca decide se o founder é avisado. Era exatamente esse acoplamento
(alerta ← rótulo do erro) que causou o incidente.

**3. Termo fraco travava pedido bom.** `"alterar senha"`, `"nova senha"` e `"primeiro acesso"`
bastavam sozinhos. Basta o portal renomear a classe `.menu-link` para o dashboard saudável virar
`menuLinks:0` + "Alterar senha" no dropdown ⇒ `PASSWORD_CHANGE_REQUIRED` ⇒ **não-retentável +
alerta urgente + senha trocada à toa**. Termos agora são **fortes** (afirmam expiração/obrigação —
valem sozinhos) ou **fracos** (nomeiam a ação — só com ≥1 campo de senha corroborando).

**4. O menu vencia cegamente.** Menu stale de SPA esconderia uma troca de senha real, e o pedido
morreria de novo como `EXCEPTION` anônima. Agora é **conflict-aware**: sinal forte vence o menu, e
`conflitoDeSinais` fica registrado na evidência.

**5. Minha própria mudança piorava o lote.** Antes, senha vencida gastava os 5 pedidos e todos
voltavam **retentáveis**. Marcar `PASSWORD_CHANGE_REQUIRED` como pré-submit tornaria os 5
**não-retentáveis** de uma vez — 5 pedidos travados e 5 alertas idênticos por uma causa só.
`ehFalhaSistemicaDoPortal` interrompe o lote no primeiro erro de credencial (`break`, não
`continue`: os restantes ficam pendentes e voltam sozinhos quando a senha for corrigida).

**6. `posLoginCheck` não chegava ao `evidence`.** O envelope só copia campos selecionados — sem
isso seria impossível **medir falso positivo da classificação depois do deploy**, que é a única
forma de saber se os termos estão calibrados.

**Onde divergi:** o Codex pediu para contar só `.menu-link` **visíveis** (`offsetParent`). Mantive
a contagem no DOM: a visibilidade depende de CSS de sidebar minificada e trocaria um falso negativo
conhecido por um desconhecido. O teste real de "menu utilizável" já existe adiante — é o
`a[href="/order-creation"]` visível. A contagem de campos de senha, essa sim, filtra visibilidade.

**Também aceito, sem correção nesta fatia:** `LOGIN_FAILED` afirmava "Senha expirou" no título
quando o mesmo sintoma cobre conta bloqueada, WAF e seletor quebrado. O título virou "Login do
portal Sayerlack falhou" e a mensagem pede para conferir antes de trocar a senha — o diagnóstico
categórico era preexistente e é a mesma classe do bug deste PR: **rótulo confiante sobre causa não
medida.**

## Provas

- 40 asserts da lógica pura + 19 asserts de forma nas duas edges.
- **20 falsificações, todas vermelhas.** Da 1ª rodada: menu deixa de valer · 1 campo de senha basta ·
  desconhecido vira senha-expirada · sem normalizar acento · alerta antes de esgotar · origem sempre
  igual · remover a confirmação de cada edge · voltar o `if (erroTipo === "LOGIN_FAILED")` · tirar o
  tipo do pré-submit · reintroduzir comentário de bloco · trocar a interpolação por cópia local.
  Da rodada pós-challenge: termo fraco vale sozinho · menu vence sinal forte · esgotamento cala tipo
  desconhecido · breaker cego a credencial · breaker interrompe por falha do pedido · expansão volta
  para depois do gate · `continue` no lugar de `break` · evidência não chega ao envelope.
- O guard de interpolabilidade pegou um bug meu **durante** a correção: uma crase dentro de um
  comentário do corpo da função — `fn.toString()` preserva comentários, e ela quebraria o template
  do Browserless em runtime, no portal, longe do CI. O `edges:typecheck` pegou a irmã dela dentro
  do template.
- Paridade byte-a-byte src ↔ `_shared` + guard de interpolabilidade (sem crase/`${` no corpo).
- Quatro gates de edge: `test:edges` (765) · `edges:typecheck` (0 crash) · `bun lint` ·
  `bun run test` (6.461) — todos exit 0.

## O que este PR NÃO resolve

Não detecta que **o portal mudou de endereço** — só relata `origemDivergente` como fato. Se a
migração para `matriz.sayerlack.com.br` for definitiva, o `SAYERLACK_PORTAL_URL` (e talvez os
seletores) precisam ser revistos: isso é decisão de produto com o fornecedor, não do automador.
