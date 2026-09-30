# Upgrade do gstack fora da sessão, sem furar o gate de supply chain (2026-09-29)

## O sintoma

Numa sessão sobre o cockpit (itens FCA.7090QT e WP01.3900QT, 2026-09-28), o preâmbulo do `/investigate`
achou `UPGRADE_AVAILABLE 1.91.2.0 1.91.6.0`. Com `auto_upgrade: true` no `~/.gstack/config.yaml`, o
próprio gstack mandou o modelo seguir o "Inline upgrade flow" (`git pull` + `./setup` em
`~/.claude/skills/gstack`) no meio da tarefa. A sessão gastou 4 chamadas nisso e terminou com
"a permissão foi negada, rode manualmente". Pergunta do founder: por que não faz sozinho?

## Diagnóstico (medido nas transcrições das duas sessões)

- **Quem negou:** o classificador do modo auto (`defaultMode: "auto"` no `~/.claude/settings.json`), com o
  motivo literal `[Code from External]`.
- **O que ele viu:** código baixado do GitHub e executado (`./setup`), que reescreve as skills e os hooks
  do `~/.claude/settings.json` global, por ordem vinda de **saída de ferramenta** (o preâmbulo), não do
  founder. Para o classificador isso não se distingue de uma injeção de prompt.
- **Contraprova:** em 2026-09-27 o upgrade 1.69 → 1.91.2 passou. O briefing do chip pedia
  `/gstack-upgrade` literalmente, e a sessão ainda escaneou o commit antes. Pedido do founder passa; a
  skill decidindo sozinha é barrada.
- **Logo:** o `auto_upgrade: true` é uma promessa que o gstack não cumpre no modo auto. Não é defeito do
  classificador, é ele funcionando. Toda sessão que usava uma skill do gstack depois de um release
  tentava, era barrada e gastava contexto nisso.

## O segundo achado: o plano "automático" furava uma decisão anterior

A primeira recomendação (e a primeira escolha do founder) foi um agendamento que aplicasse sozinho. Ao
abrir o `docs/agent/skills.md` para implementar, apareceu o conflito: o gstack está na lista das
**fixadas** ("nada aqui se atualiza sozinho; atualizar = decisão + gate"), e o gate de supply chain
exige, a cada atualização, o `skill-scanner` offline na versão instalada E na nova, a revisão só do
delta, e a leitura à mão de hooks e scripts. O critério que aprovou a 1.91.2 foi "nenhum achado novo em
código que dispara sozinho". Parei antes de escrever código e levei o conflito ao founder. O
`auto_upgrade: true` (ligado desde julho) já contradizia o gate desde 27/09, e ninguém o desligou.

**Lição:** antes de recomendar automação sobre um domínio que tem doc em `docs/agent/`, leia o doc. A
recomendação saiu do diagnóstico técnico (o classificador) e ignorou a política do domínio.

## Decisão (founder, 2026-09-29): prepara sozinho, aplica com uma frase

- O LaunchAgent `com.lucas.gstack-upgrade` (domingo 10h, o mesmo horário do `com.lucas.codex-modelo-update`)
  roda `~/.gstack/auto-upgrade/atualizar-gstack.sh`, cópia de `scripts/gstack-auto-upgrade.sh` instalada
  por `scripts/gstack-auto-upgrade-instalar.sh`. Ele busca a origin e, havendo versão nova, **não aplica**:
  extrai as duas árvores, roda o scanner offline nas duas, calcula o delta com o MESMO algoritmo da revisão
  de 27/09 (multiconjunto de severidade + regra + arquivo + trecho de 90 caracteres) e o diff do que
  dispara sozinho (setup, `bin/`, hooks, plugin, dependências). Tudo vai para `revisao.md`, com status PENDENTE.
- O `vigia-gstack.sh` mostra "gstack vX pronto" ao founder uma vez por dia; o modelo recebe sempre, calado,
  o como aplicar. O founder diz "aplica o upgrade do gstack", o modelo lê a revisão, dá o veredito do gate e
  roda `--aplicar <sha>`, que instala **exatamente o sha revisado**, nunca um tip mais novo que ninguém
  viu. Com o pedido do founder, o classificador libera.
- `update_check: false` e `auto_upgrade: false`: a sessão para de tentar, e o job vira o único escritor. O
  atualizador do próprio gstack (`bin/gstack-session-update`, que o `./setup --team` registraria como hook
  de SessionStart) também respeita o `auto_upgrade`.
- O lock é o MESMO do atualizador do gstack (`~/.gstack/.setup-lock`, pidfile + TTL), para nunca rodarem
  dois `./setup` juntos.

## Alternativas descartadas

- **Regra em `autoMode.allow`:** o upgrade continuaria no meio de sessões aleatórias (o setup recompila
  binários, num M2 8GB em swap), com várias sessões podendo disparar juntas, e a regra deixaria passar
  ordem vinda de saída de ferramenta. Além disso é config de segurança: é do founder, não do agente.
- **O hook `gstack-session-update` do próprio gstack:** roda no boot da sessão (justo a hora em que o
  founder trabalha), em background, sempre com exit 0 (sem evidência positiva), e aplica sem gate.
- **Aplicar tudo sozinho:** fura o gate; foi oferecida e não escolhida.
- **Aplicar sozinho quando o delta vier limpo:** fica para depois, com SINAL. Primeiro, medir quantas
  revisões semanais saem limpas (a regra "Fase N+1 exige SINAL da fase N" do CLAUDE.md).

## Defeitos que a construção pegou

- **`git checkout -- A B C` é tudo-ou-nada:** um pathspec sem match faz o git recusar o comando INTEIRO, e
  a sujeira de render do `SKILL.md` ficava (caso A12). O `/gstack-upgrade` original tem a mesma forma, e lá
  funciona porque os três padrões sempre casam. Agora é um checkout por padrão.
- **O scanner real dá o caminho relativo À SKILL, não ao repo** (medido no 2.1.0: `skill_path` absoluto no
  resultado, `file_path` relativo à skill). O stub dos testes usava caminho absoluto, então nada acusou: foi
  preciso rodar o scanner de verdade numa árvore com skill aninhada. Sem juntar `skill_path` + `file_path`, um
  `sub/bin/x` virava `bin/x` e contava como código da raiz que dispara sozinho (4 em vez de 2 no teste real).
  O stub agora imita o esquema real, com uma skill aninhada.
- **A falsificação pegou uma asserção sem dente:** a contagem de "dispara sozinho" contava CHAVES distintas;
  sob a sabotagem, os dois achados colapsavam na mesma chave e o número não mudava. A contagem agora soma
  os achados, e o arquivo aninhado do teste tem nome próprio (sabotagem F12).
- **O lock só era renovado ENTRE etapas** (achado no 1º preparo real, com a máquina em swap: o scan esperou
  ~20 min na fila do `heavy`). Com o TTL de 30 min, outro upgrade poderia tomar o lock de um dono VIVO, e o
  `heavy` desistiria da fila aos 30 min (revisão com GATE INCOMPLETO). Agora há um batimento de fundo a cada
  5 min, como no `bin/gstack-session-update`, com um trap que mata o próprio `sleep` (sem ele: 23 `sleep 300`
  órfãos por rodada da suíte), e a fila do `heavy` espera até 3 h no job. Entrou num PR de follow-up: o
  #2655 mergeou antes do push.
- **Revisão INCOMPLETA era reaproveitada** (também achado no 1º preparo real: o scan da versão nova estourou a
  fila do `heavy`, e a revisão saiu com GATE INCOMPLETO). O preparo reaproveitava a revisão quando o alvo não
  mudava, sem olhar se ela estava completa: nunca mais tentaria o scan. E nada impedia o `--aplicar`. Agora o
  status grava `gate=COMPLETO|INCOMPLETO` (ausente conta como incompleto), só a completa é reaproveitada, o
  `--aplicar` recusa a incompleta (o opt-in explícito é `GSTACK_AUTO_ACEITO_SEM_SCANNER=1`), e o vigia diz
  GATE INCOMPLETO em vez de "pronto". Sabotagens F13, F14 e S12.
- **`env -u X <função>`:** o `env` executa BINÁRIO, e a função `pesado` virava "No such file". Foi pego na
  revisão, antes do primeiro teste; o `env` agora vem DENTRO do `pesado`.

## Onde olhar

- `cat ~/.gstack/auto-upgrade/status` · `~/.gstack/auto-upgrade/log` · `~/.gstack/auto-upgrade/revisao.md`
- `launchctl print gui/$(id -u)/com.lucas.gstack-upgrade`
- Testes: `scripts/test-gstack-auto-upgrade.sh` (15 casos contra um "GitHub" local servido pela URL real via
  `insteadOf`, com ambiente zerado por `env -i`; 12 sabotagens) e `scripts/test-vigia-gstack.sh`
  (C7–C13; sabotagens S6–S11). Os dois estão no `test:hooks` e no `test:falsificacao`.
