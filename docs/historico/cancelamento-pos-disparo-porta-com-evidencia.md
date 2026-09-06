# Recusar não é o mesmo que não ter porta — e um guard dentro da RPC não fecha a classe

> **A classe (2026-09-06):** quando uma defesa vive **dentro de uma RPC**, ela protege quem passa
> pela RPC. Toda outra via de escrita — PostgREST cru, SQL na mão no SQL Editor, uma RPC futura
> que reimplemente a operação — escapa. O que fecha a CLASSE é um **trigger**, porque ele mora na
> tabela e não na porta.
>
> E o corolário de produto, que é a metade que costuma ficar de fora: **uma recusa correta sem
> porta alternativa não elimina a operação, empurra ela para fora da fronteira.** O caso legítimo
> continua acontecendo — só que sem evidência, sem carimbo e sem trilha. Foi exatamente isso que
> as cinco linhas medidas em produção mostraram.

Artefatos: `supabase/migrations/20260906152235_cancelamento_pos_disparo_trigger_e_rpc.sql`,
`db/test-cancelamento-pos-disparo.sh` (78 asserts), `db/valida-cancelamento-pos-disparo.sql`.

## O achado: são CINCO linhas, e duas delas discriminam a via

O briefing partia de três linhas em `cancelado_humano` com `omie_pedido_compra_id` preenchido, e
registrava não ter conseguido determinar a via — a tentativa por `status_envio_portal` não separou
nada, porque `nao_aplicavel` é também o DEFAULT da coluna. Está certo **para aquelas três**.

Medindo o predicado completo (`status LIKE 'cancelad%' AND omie_pedido_compra_id IS NOT NULL`)
aparecem **cinco**:

| id | status | PO no Omie | cancelado_por | status_envio_portal |
|---|---|---|---|---|
| 33 | `cancelado_humano` | 12076996056 | reset-operacional | `nao_aplicavel` |
| 281 | `cancelado_humano` | 12098721294 | lucascoelhosardenberg@… | `nao_aplicavel` |
| 286 | `cancelado_humano` | 12098829067 | lucascoelhosardenberg@… | `nao_aplicavel` |
| **409** | **`cancelado`** | 12101983534 | reconciliacao_manual_po_excluido_omie | **`sucesso_portal`** |
| **1046** | **`cancelado`** | 12128060408 | reconciliacao_manual_po_excluido_omie | **`sucesso_portal`** |

As duas últimas **provam a via**, e por um teste que as três primeiras não permitiam:

1. estão no vocabulário legado `cancelado` — e `cancelar_pedido_sugerido` **só escreve**
   `cancelado_humano`, nunca `cancelado`;
2. preservam `status_envio_portal='sucesso_portal'` — e a RPC **sempre** sobrescreve para
   `nao_aplicavel` (a higiene do portal da `20260530210001`).

Nenhuma das duas passou pela RPC. O ponto de método: **um discriminador que empata no valor
DEFAULT não separa nada — mas o mesmo eixo separa muito bem quando o valor observado é um que o
default nunca produz.** A conclusão "não dá para saber a via" era verdadeira sobre a amostra
errada; ampliar o predicado antes de desistir custou uma query.

Consequência de desenho direta: o trigger tem de cobrir **os dois vocabulários**. Cobrir só
`cancelado_humano` deixaria de fora justamente as duas linhas cuja via está provada.

## `concluido_recebido` é inalcançável — medido, não deduzido

Zero linhas em produção, e o briefing pedia para confirmar antes de desenhar em cima. Confirmado
pelos dois lados: **nenhuma** função SQL escreve `SET status='concluido_recebido'` (as 5 que
mencionam a string só a comparam), e no repo as 4 ocorrências são leitura/tipo — a única fora de
teste é um `.in(...)` de filtro na `omie-sync-estoque`. Ele fica no predicado porque é barato e
porque o guard que este trigger generaliza já o lista; **nada aqui foi desenhado em cima dele**.

## Por que GUC, e não "coluna de intenção"

O trigger precisa de uma forma de a RPC passar sem abrir o portão para todo mundo. As duas
alternativas não empatam:

- **Coluna de intenção não fecha nada.** O mesmo `UPDATE` cru que carimba o status carimbaria a
  coluna na mesma instrução. A via não-autorizada continuaria passando e o trigger seria
  decorativo — que é precisamente o modo de falha que a fatia existe para evitar.
- **GUC de sessão fecha**, porque o PostgREST **não expõe `set_config` ao cliente**: ela vive em
  `pg_catalog`, e o cliente só alcança funções de `public`. Não há request que abra a porta sem
  passar pela RPC.

O GUC carrega **o id do pedido**, não um booleano: autorização para um pedido não vira autorização
para o próximo `UPDATE` da mesma transação (falsificado em **F3** — com portão booleano, a
autorização vaza).

E há uma **segunda camada**, que não é redundância: mesmo com a porta aberta, o trigger exige que
a linha resultante carregue motivo/evidência/autor/data. Isso barra uma RPC futura que abra o GUC e
esqueça o carimbo — que é literalmente como a "segunda via" do #2231 nasceu (alguém
**reimplementou** a operação em vez de chamar a fronteira). **F2** falsifica essa camada sozinha.

## O que foi medido ANTES, para não barrar transição legítima

Um trigger novo em tabela de money-path muda o comportamento de **toda** escrita, então:

- **13 funções** escrevem na tabela; só **duas** escrevem status cancelado, e **nenhuma** faz a
  transição proibida: `cancelar_pedido_sugerido` (denylist `NOT IN (disparado, concluido_recebido)`)
  e `remover_itens_pedido_sugerido` (allowlist `IN (pendente_aprovacao, bloqueado_guardrail)`).
- As **3 edges** que escrevem na tabela gravam `disparado`, `falha_envio`, `expirado_sem_aprovacao`
  e `status_envio_portal`. **Zero** escritas de `cancelad*` — a única ocorrência da string em
  `disparar-pedidos-aprovados` é `.is("cancelado_em", null)`, um filtro de leitura.
- Os outros dois triggers BEFORE não escrevem `NEW.status` (o `set_status_envio_portal_on_disparo`
  só o lê). O nome `trg_valida_…` o coloca por último na ordem alfabética, então ele avalia o
  `NEW.status` final — renomear para algo que ordene antes passaria a depender daquela medição.

O grupo **X** do harness transforma cada um desses achados em assert, inclusive **X8**: uma linha
já cancelada aceita `UPDATE` posterior — sem ele, a migration poderia ter congelado as cinco linhas
históricas e ninguém saberia até alguém tentar editar uma.

## As cinco linhas ficam como estão — decisão, não omissão

Carimbá-las retroativamente exigiria **decidir** que "protocolo 2097501", escrito em texto livre,
vale como evidência estruturada: transcrever prosa para um campo que passa a ter força de
invariante. Para a linha 33 ("reset operacional: backlog pré-fix do portal") seria fabricação pura
— não há cancelamento junto a fornecedor ali. O histórico continua legível em
`justificativa_cancelamento`, e a view `vw_cancelamento_pos_disparo_sem_evidencia` as expõe como o
conjunto **fechado** de exceções conhecidas: hoje devolve exatamente 5, e o trigger impede que uma
sexta entre. A view é, ao mesmo tempo, o inventário e o alarme se o guard for removido.

## A prova

`db/test-cancelamento-pos-disparo.sh` — PG17 descartável, **82 asserts, exit 0**, três execuções em
`pt_BR.UTF-8` e duas em `lc_messages=C` (o controle do eixo imprime `divisão por zero` num e
`division by zero` no outro, então os ambientes são de fato diferentes).

O centro é o grupo **R**, com barreira **observada** (`pg_blocking_pids`, nunca `sleep`), e ele
responde a pergunta que só a corrida responde: **o trigger vê o `OLD` re-avaliado?**

A `20260905224959` precisou pôr o predicado no `WHERE` para que o EvalPlanQual re-avaliasse a linha.
A via crua (`WHERE id = …`) **não tem esse WHERE** — ela grava mesmo assim. A aposta do desenho é
que o trigger BEFORE, disparando depois do lock, recebe em `OLD` a versão que o disparador acabou de
commitar. Isso é afirmação sobre o motor, então está medido:

- **R1 (baseline vermelho)** — sem o trigger, a via crua **vence** o disparo concorrente e deixa
  `PO-REAL-NO-OMIE` órfão sob `cancelado_humano`. Sem este vermelho, o verde de R2 poderia
  significar apenas que a corrida nunca aconteceu.
- **R2** — mesma corrida com o trigger: barrada, pedido segue `disparado`, PO sob status verdadeiro.
- **R3 (controle inócuo)** — um disparo concorrente em **outra** linha não barra esta via; sem ele,
  um trigger que recusasse sob qualquer concorrência passaria por fix.

Os demais grupos: **T** a via crua barrada nos dois vocabulários (o invariante da fatia) com
**T4** provando que o trigger não é um "nega tudo"; **P** a RPC com evidência corrige e deixa
trilha; **N** os negativos com SQLSTATE **e** sentinela do ramo; **A** o gate, com **A1d**
promovendo o mesmo uid a `employee` e exigindo que a chamada passe; **F** a falsificação camada a
camada; **V** a query de validação nos dois sentidos.

## Quatro coisas que a execução corrigiu

1. **`cut -d'|'` cortava dentro da mensagem de erro.** O helper devolve `SQLSTATE|SQLERRM`, então os
   campos do resultado da corrida saíam deslocados e três asserts mediam a coluna errada — inclusive
   um que "passava" comparando lixo com lixo. Separador virou `~~`.
2. **`mktemp /tmp/nome.XXXXXX.sql` cria o nome LITERAL no BSD/macOS** (os X só são substituídos no
   fim do template). O harness passava uma vez e morria na segunda com `File exists`. **Um teste que
   só passa uma vez não é regressão.** O harness de referência
   `db/test-cancelar-pedido-guard-atomico.sh` tem o mesmo padrão e o mesmo bug latente.
3. **A sonda de execução da postcondição dependia do `BEGIN/COMMIT` externo.** No ramo em que o
   trigger *não* barra, o `UPDATE` de sonda numa linha real de produção só seria desfeito pelo
   rollback do arquivo inteiro. Agora ela levanta um SQLSTATE próprio (`22023`) para forçar o
   rollback do **subtransaction** nos dois ramos: a sonda nunca deixa linha carimbada, nem se o
   bloco for colado fora da transação.

4. **A sonda tinha um ramo "PULEI o assert" num canal mudo.** Ela procurava uma linha real em
   `disparado`; não achando, emitia `RAISE NOTICE`. Mas **o SQL Editor do Lovable não exibe NOTICE**
   (regra que entrou na main no #2248 enquanto esta fatia estava em voo), então o Run sairia
   *Success* — indistinguível de "tudo provado" — com o eixo de execução **nunca exercitado**.
   Assert que não rodou não é assert que passou. O conserto não foi reportar melhor o pulo: foi
   **eliminá-lo**. A sonda agora **cria a própria linha** dentro do subtransaction que já era
   revertido nos dois ramos, então o eixo roda em qualquer banco — inclusive um vazio — e não
   deixa rastro (só a sequence de `id` avança, porque sequence não é transacional). **F8a-F8d**
   provam exatamente isso com a tabela truncada: verde com o trigger, **vermelho sem ele**, e
   `count(*)=0` depois de cada um.

## O que esta entrega NÃO fecha

1. **O efeito externo no Omie continua fora de alcance.** O trigger serializa o banco, não o ERP.
   O **cenário B** de [guard-fora-da-escrita-nao-e-guard.md](guard-fora-da-escrita-nao-e-guard.md)
   — a RPC cancela primeiro e o disparador, que já selecionou a linha, cria o PO e grava por cima —
   segue aberto, e o conserto é o claim atômico no disparador.
2. **`aprovar_pedido_sugerido` tem o mesmo TOCTOU** (registrado no #2231) e o trigger daqui **não**
   o cobre — `aprovado_aguardando_disparo` não é status cancelado, então a transição nem chega ao
   predicado. Está sendo fechado em paralelo no PR #2239 ("a 3ª via do mesmo TOCTOU"), que recria
   apenas `public.aprovar_pedido_sugerido`: **medido, sem colisão de objeto com esta migration** —
   o único encontro é textual, nos dois artefatos gerados por `bun run audit:migrations`.
3. **O front ainda não tem a tela da correção.** A RPC está de pé e `authenticated` a executa, mas
   nenhum componente a chama — hoje o caminho é o SQL Editor chamando a RPC (que é estritamente
   melhor que o `UPDATE` cru: exige evidência e deixa trilha). A tela é fatia própria.
4. **O banco garante que a evidência EXISTE e que alguém a assinou, não que ela é verdadeira.**
   Nenhum guard técnico verifica um protocolo de fornecedor. Isso é deliberado e está escrito no
   `COMMENT ON COLUMN`: o que a fronteira impõe é que ninguém cancele uma compra real sem se
   comprometer por escrito e com carimbo.
