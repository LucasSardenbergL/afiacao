# Um retry recém-iniciado apagava o alerta do erro que ele ia consertar (2026-09-20)

**Em 3 linhas.** O `sync_reprocess_saude` subiu com `REVISÃO INDEPENDENTE PENDENTE` (cota do Codex
esgotada). A revisão retroativa veio dois dias depois e achou um furo real: o veredito lia a
**última linha**, qualquer que fosse, então um `running` de retry **liquidava** o `error` anterior —
o check dizia `ok` e o watchdog dismissava o alerta antes de o retry sequer completar. Reproduzido
por execução antes de consertar.

Antecessores: [sensor-do-reprocesso-catalogo-em-vez-de-janela.md](sensor-do-reprocesso-catalogo-em-vez-de-janela.md)
(o sensor) · [reprocess-oben-parado-seis-dias.md](reprocess-oben-parado-seis-dias.md) (o incidente).

## A sequência que produz o falso verde

| hora | linha gravada | o que o check via |
|---|---|---|
| 10h00 | `complete` | — |
| 12h00 | `error` | broken, alerta aberto ✅ |
| 12h29 | `running` (o retry começou) | última linha deixou de ser `error` |
| 12h30 | watchdog avalia | `running` é recente (< 2h, não-órfã); sucesso das 10h ainda cabe no SLA de 4h ⇒ **`ok`** |

E `ok` **explícito** é exatamente o que dispara a resolução automática no watchdog
(`UPDATE fin_alertas SET dismissed_at = now()`). O alerta do erro das 12h morria sozinho, e o
problema voltava a ser invisível — a mesma cegueira que o sensor existe para fechar, por outra porta.

Não é hipótese: o assert do cenário ficou **vermelho** contra o código em produção antes de
qualquer conserto. Parecer que se aceita no papel não é revisão; é opinião.

## O conserto: um INÍCIO não é um DESFECHO

O veredito passou a ler duas coisas separadas:

- **`u` — o último RESULTADO**: a última linha terminal (`status IS DISTINCT FROM 'running'`);
- **`r` — a última TENTATIVA em voo**: a última `running`, usada só no teste de órfã, e só quando
  é posterior ao último resultado.

Regra: **um início posterior não liquida um erro terminal; um sucesso posterior liquida** — porque
um sucesso vira o novo `u`, e um `running` não. O caso legítimo ("run em voo sobre sucesso fresco ⇒
`ok`") continua valendo, porque ali o último resultado é `complete`.

## O segundo achado veio da própria falsificação

Ao re-rodar as sabotagens, `orfa_nunca_dispara` ficou **verde** — o assert da órfã não tinha dente.
Motivo: o cenário transformava o único `complete` em `running`, então não sobrava sucesso nenhum e o
`broken` vinha da cláusula "nunca completou", não da órfã. **O assert passava pelo motivo errado**, e
por isso sabotar o limiar da órfã não o movia.

Corrigido com um cenário que isola o eixo: `complete` há 3h (dentro do SLA de 4h) + `running`
iniciada há 2h30. Só a cláusula da órfã pode dar `broken` ali.

É a lição do repo aplicada a si mesma: **um assert verde não prova que ele mede o que o nome diz** —
só a sabotagem daquele eixo prova. Quem falsifica um eixo por vez descobre qual assert é redundante
ou inalcançado; quem não falsifica carrega asserts decorativos sem saber.

## Dívida registrada (do mesmo parecer, não fechada aqui)

Quatro achados válidos que mudam o desenho mais fundo do que um PR de conserto comporta. Ficam
escritos para não virarem folclore:

- **Sucesso parcial renova o frescor** (P1). Um estágio que grava `complete` tendo processado só
  parte das entidades renova `ultimo_sucesso_em` e mantém o check verde indefinidamente. "O estágio
  andou" não prova que o **subconjunto problemático** andou. Fechar exige eixo de **cobertura**
  (obrigação × resultado), não mais um limiar de tempo.
- **`severity` fixa em `critical`** (P1). O contrato PERMITE variar (`critical|warning|info` entram
  no fingerprint, e a máquina de episódios tem via de escalada) — minha justificativa de que não
  podia estava errada. O dano é concreto: com um episódio de SKU reconhecido e aberto, **um
  incidente novo de pedidos pode ficar sem push**. Saída mínima: severity pelo maior impacto
  **entre as chaves problemáticas** (chaves saudáveis não emprestam criticidade). Mas `sku_status_omie`
  não vira `warning` automático — ele participa do bloqueio de compra de produto inativo, e só
  `false` explícito bloqueia: também tem consequência financeira.
- **Chave semanal nasce e some** (P2). A descoberta usa janela de 48h: uma chave semanal aparece,
  pode virar `unknown`, e some por ~5 dias — podendo se **auto-resolver sem ninguém decidir** sobre
  sua cobertura. Fechar exige fonte durável de obrigações esperadas, não uma janela maior.
- **Nenhum eixo de EFEITO** (P2). O check é cego a `complete` que não processou nada. E o remédio
  óbvio é uma armadilha: **`upserts_count > 0` não é prova de saúde** — zero pode ser reconciliação
  correta de dados já iguais, e positivo pode ser fração processada (os laços param no total de
  páginas declarado, que o Omie subestima). Sem denominador, zero significa "não sei". Pertence a um
  **source próprio**, com diagnóstico e reconhecimento independentes.

## Regras que este PR deixa

- **Sensor que lê "a última linha" confunde tentativa com desfecho.** Onde existir retry, separe o
  último RESULTADO da tentativa EM VOO: um início posterior nunca pode liquidar uma falha terminal.
- **Assert verde não prova que mede o que o nome diz.** Se sabotar o eixo e ele seguir verde, ele
  passa por outro motivo — conserte o CENÁRIO, não o limiar.
- **Revisão independente adiada é dívida, não formalidade.** Este furo estava no ar por 2 dias, num
  sensor que já tinha 27 asserts e 9 sabotagens verdes. A prova própria cobre o intervalo; não
  substitui o adversário.
