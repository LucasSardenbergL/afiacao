# Aposentar uma migration regressiva: a captura é sobre ORDEM, não sobre conteúdo

> **A classe (2026-08-30):** quando o audit acusa deriva entre o corpo vivo e o repo, o reflexo é
> "capturar o corpo vivo numa migration nova". Em `aplicar_promocoes_no_ciclo` a captura era a
> decisão certa **pelo motivo errado**: o repo **já continha** o corpo certo (md5 do corpo sem
> comentários idêntico ao da migration das 18h). Não havia conteúdo a capturar. O que havia era uma
> migration POSTERIOR e regressiva sendo a **última palavra** do repo — e é a *ordem*, não o
> conteúdo, que a captura conserta.
>
> A regra: **antes de escrever a captura, meça se o repo já tem o corpo.** Se tem, a captura não é
> um resgate de conteúdo, é um desempate de precedência — e isso muda o que ela precisa provar.

Continuação de [deriva-de-corpo-prod-a-frente-do-repo.md](deriva-de-corpo-prod-a-frente-do-repo.md),
pendência 2. Entrega: `supabase/migrations/20260830214547_reposicao_aplicar_promocoes_captura_corpo_vivo.sql`
+ `db/test-captura-corpo-vivo-aplicar-promocoes.sh`.

## O que foi medido (prod, 2026-08-30, via `psql-ro`)

| Afirmação da triagem | Veredito da re-medição |
| --- | --- |
| prod perdeu o hardening se a 20h for aplicada | **confirmado** — `ajustado_humano` e `promocao_campanha` têm 2 ocorrências no vivo e **0** na das 20h |
| o vivo evoluiu além das 18h | **falso** — `md5` do corpo sem comentários bate exatamente (`f3587d9f…`); as 9 diferenças são rabo de comentário truncado |
| o `::bigint` arrisca erro ou match errado | **não reproduz** — 0/2448 `sku_codigo_omie` não-castáveis, 0 com zero à esquerda, len máx 11. O custo presente é outro: `::bigint` sobre a coluna inutiliza `idx_pedido_compra_item_sku` (btree em coluna `text`) |
| o `ceil` ausente é o defeito que sobrou | **redundante** — ambos os `ceil(` estão no ramo `forward_buying`, que tem **0 linhas em prod desde sempre**; e os dois insumos de `qtde_com_desconto` já são inteiros (ver abaixo) |

**Por que o `ceil` não tem caso.** `qtde_com_desconto = GREATEST(qtde_base, volume_minimo)`, e mais nada.
`volume_minimo`: 151 itens de promoção, **150 NULL** e o único preenchido vale 0 — nunca fracionário.
`qtde_base` é a sugestão do motor, que **parou de gerar fração em junho** (abr 20 · mai 53 · jun 12 ·
**jul 0 · ago 0**, de 617 itens no bimestre), corrigida na camada certa pelas migrations
`reposicao_qtde_inteira*`. Acrescentar `ceil` no ramo de promoção seria remendo redundante na camada
errada — e num ramo que já **infla** quantidade, arredondar pra cima só aumenta gasto. Ressalva viva:
`volume_minimo` é `numeric`, então campanha futura *poderia* declarar mínimo fracionário; o guard
certo aí é um CHECK na coluna, não um arredondamento escondido no money-path.

## O que a captura precisa provar (e que uma captura "normal" não precisa)

Como o apply é NO-OP de efeito, o teste não pode ser "o comportamento mudou". O que se prova é
**precedência + não-regressão**, e isso exige um guard de **dois eixos** — um só não fecha:

- **Só md5** não serve: o corpo hardened tem **dois** md5 legítimos, que diferem só em comentário —
  o vivo de prod (`b48783…`, rabo truncado pelo apply do Lovable) e o que a migration das 18h
  instala (`c0ac59…`, comentários completos, que é o que um replay do repo produz). Gatear por um só
  torna a migration inaplicável fora da prod daquele dia — **defeito que só apareceu ao montar o
  PG17**, não na leitura.
- **Só semântica** (procurar `ajustado_humano` etc.) não serve: aceitaria qualquer variante hardened
  desconhecida e sobrescreveria trabalho alheio em silêncio.

⇒ Guard = marcadores presentes **E** md5 na allowlist dos dois conhecidos-bons; md5 fora da lista
**com** marcadores presentes aborta pedindo re-medição, em vez de decidir sozinho. Fail-closed nos dois.

## Duas armadilhas que custaram tempo aqui

- ⚠️ **`btrim(x)` de UM argumento remove só ESPAÇO — não remove `\n`.** O normalizador da Seção 3 do
  audit é `md5(regexp_replace(btrim(prosrc), '\s+', ' ', 'g'))`, e `prosrc` **começa** com a quebra de
  linha que segue `AS $function$`. O `btrim` deixa esse `\n`, o `regexp_replace` o vira **espaço
  inicial** — então reproduzir o md5 fora do banco exige incluir a quebra de linha inicial. Sem isso
  o md5 dá diferente e parece deriva onde não há. (Controle: `btrim(E'\n x \n')` devolve o texto
  ainda com os `\n`.)
- ⚠️ **Capturar o corpo vivo significa capturar os comentários TRUNCADOS.** A ferramenta de apply
  descarta o rabo dos comentários (`-- [H7] guard NaN/∞/zero (promoção)` → `-- [H7]`). Escrever a
  migration com os comentários completos deixaria o md5 repo×prod divergente para sempre — ou seja,
  a captura *criaria* a deriva que veio consertar. O arquivo fica feio de propósito; os comentários
  completos vivem na 20260606180000.

## O teste (`db/test-captura-corpo-vivo-aplicar-promocoes.sh`, PG17, 12 asserts)

Verde real com a migration real; a falsificação tem dente e tem **controle**:

- **C2c/C2d/C2e** — a função pós-captura executa (plpgsql é late-bound: só o EXECUTE prova) e produz
  efeito **idêntico** ao da 18h por item. O C2e é o **controle anti-vacuidade**: exige que o item
  *não*-ajustado TENHA recebido a promoção. Ele pegou um bug real do seed (`status='rascunho'` em vez
  de `'pendente_aprovacao'`), sob o qual C2c comparava dois no-ops e C2d passava por vacuidade.
- **C4/C5/C6** — os três caminhos de aborto do guard: função ausente, corpo regressivo da 20h vivo,
  variante hardened desconhecida.
- **C7 + C7b** — o bloco de verificação roda **isolado** contra o corpo regressivo e tem de REPROVAR;
  o C7b exige que o mesmo bloco APROVE o corpo certo, senão "reprova sempre" passaria por teste.

## Estado da 20260606200000

**APOSENTADA — não aplicar.** O arquivo é imutável (hook `migration-immutability-guard.sh`, e a pasta
é fonte de DR), então ela continua no repo; o que muda é que a **última** migration a definir a função
passa a ser a captura, e o guard desta aborta se alguém tiver colado a das 20h antes. O harness dela,
`db/test-promo-forward-buying-min.sh`, não é referenciado por nada e não roda no CI — não havia (nem
há) teste verde defendendo o corpo regressivo.

> **REVISÃO INDEPENDENTE PENDENTE** — o ritual `/codex` falhou por cota (`COTA_ESGOTADA`, plano
> declarado `prolite`). Seguido o Caminho B do `money-path.md`: PG17 falsificável + re-medição própria
> das quatro afirmações da triagem, três das quais foram corrigidas acima. Rodar o Codex retroativo
> quando a cota voltar.
