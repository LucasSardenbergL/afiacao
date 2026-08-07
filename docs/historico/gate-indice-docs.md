# Gate do índice de docs — a classe "doc invisível" e as duas versões do gate

Registro da linha de trabalho que fecha a classe **"o `.md` existe, o índice não o lista, e nada
quebra"**. Cinco PRs em pouco mais de duas semanas: #1658 e #1665 (reconciliações à mão), #1670 (o
gate), #1674 (a main vermelha que o gate pegou) e o endurecimento por 1ª coluna.

## O modo de falha

`docs/historico/` e `docs/runbooks/` mantêm o índice **à mão**, no `README.md`. Adicionar um doc sem
a linha correspondente é um bug **silencioso por construção**: o arquivo existe, o link não falta em
lugar nenhum, o CI fica verde — e o doc só é descoberto ausente quando alguém procura o que não
acha. O `tint-sync-corte-csv.md` viveu fora do índice **sem um único link no repo inteiro**: existia
e era inalcançável.

A frase "ao concluir uma entrega, registre aqui" já estava no README desde 2026-06-14. Ela não
segurou nada:

| # | quando | o que aconteceu |
|---|---|---|
| #1658 | 2026-08-02 | reconciliação à mão: **9 arquivos invisíveis**, metade do histórico recente |
| #1659 | horas depois | um PR de **feature**, que só por acaso escreveu um doc, reintroduziu a falha |
| #1665 | 4 dias depois | mais 2 arquivos |
| #1670 | 2026-08-06 | o gate estrutural (`scripts/docs-indice-gate-check.ts` + step `docs:indice`) |
| #1674 | mesmo dia | main **vermelha**: o #1212 entrou com um doc sem linha — o CI dele rodou sobre base anterior ao gate |

A meta-regra do catálogo de retrabalho, medida aqui em horas: **contramedida textual reincide, gate
estrutural para.**

## O falso-negativo da 1ª versão: "citado" ≠ "indexado"

O gate do #1670 extraía os links com `readme.matchAll(LINK_IRMAO)` sobre o **arquivo inteiro**. Isso
deixava passar exatamente a mentira que ele existe para pegar: um doc **apenas citado dentro do
resumo de outra entrada** contava como indexado, sem ter linha própria.

Não era hipótese — era o estado real do índice. `setup-agente.md` é citado no resumo de
`melhorias-code-2026-07.md`, então **apagar a linha própria dele mantinha o gate verde**:

```ts
const real = readFileSync('docs/historico/README.md', 'utf8');
const semLinha = real.split('\n').filter(l => !l.startsWith('| [setup-agente.md]')).join('\n');
new Set(Array.from(semLinha.matchAll(LINK_IRMAO), m => m[1])).has('setup-agente.md'); // true
```

A correção é ler a **1ª coluna da tabela**: é ela que distingue "tem linha própria" de "foi
mencionado por outro". Provado contra o README real, com controle: com a linha apagada o gate acusa
1 órfão; com o README intacto, 0 achados.

O que **não** podia se perder no caminho: a **âncora** (`](x.md#secao)`). Linkar a seção certa de um
doc longo é uso normal de markdown, e exigir link sem âncora criaria o falso-positivo mais provável
da regra — gate que grita errado treina a ignorar o vermelho.

## As cinco invariantes

O #1670 tinha duas; o endurecimento somou três. Todas as cinco olham só a 1ª coluna:

1. **ÓRFÃO** — o arquivo existe e não tem linha própria. Ser citado no resumo alheio não conta.
2. **LINK QUEBRADO** — o índice lista e o arquivo não existe (renomeação/remoção pela metade).
3. **DUPLICATA** — o mesmo doc em duas linhas. Duas worktrees que dão append do mesmo arquivo em
   posições diferentes **não conflitam no merge**: o git aceita as duas, e ninguém vê.
4. **TEXTO = DESTINO** — `[a.md](b.md)` é copiar-colar; quem clica esperando `a.md` cai em `b.md`.
   Vale **só na 1ª coluna**: citar `[faxina knip](faxina-knip-2026-07-07.md)` dentro de um resumo é
   prosa legítima, e é o que o índice real faz hoje.
5. **RESUMO REAL** — `| [x.md](x.md) | TODO |` satisfaz as quatro acima e não indexa nada. Piso de
   30 chars, folgado de propósito: a menor célula viva tem 44, então nenhuma entrada honesta esbarra
   nele. Um teste do repo real vigia essa folga — se a menor célula encostar no piso, o piso virou
   cobrança de estilo em vez de barreira à entrada-fantasma.

## Método: a falsificação é que fez o gate ficar correto

Cada invariante foi sabotado um a um, exigindo vermelho **só** no teste que o guarda. A sabotagem
que importa é a nº 1: trocar o invariante de órfão pela **busca solta** (`readme.includes('(' +
arquivo + ')')`, que é como se confere isso à mão). Na primeira tentativa da sessão anterior essa
sabotagem **passou verde** — a suíte não sabia distinguir "tem linha própria" de "foi citado", e foi
isso que revelou o teste ausente, não a leitura do código.

Dois cuidados que a mesma sessão pagou:

- **Sabotagem que não aplica é ausência de dado, não aprovação.** O harness confere que a âncora do
  `replace` casa exatamente 1× e falha alto se não casar. Sem isso, um `sed` que erra o alvo produz
  "suíte verde" e parece confirmação.
- **Commitar ANTES de sabotar.** `git checkout --` para restaurar a sabotagem apaga junto qualquer
  edição não-commitada.

## Escopo deliberado

O gate é de **precisão, não recall** (mesma doutrina do `edges:typecheck`): só olha diretório de
`docs/` que **tem `README.md`**, porque ter um README é a declaração de "aqui existe índice".
`docs/agent/` fica de fora de propósito — quem o indexa é a tabela do CLAUDE.md, que enumera
**domínios**, não arquivos: `review.md`, `threat-model-template.md` e `csv-governo-br.md` são
sub-documentos alcançáveis a um salto e seriam três falsos-positivos permanentes. Gate que nasce com
exceção é gate que treina a ignorar o vermelho.
