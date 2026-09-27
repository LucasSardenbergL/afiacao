# Codex na sessão cloud — o "parou de funcionar" era troca de máquina (2026-09-27)

## Sintoma

"O Codex parou de funcionar." A sessão (claude.ai/code, ambiente `Default`) não conseguia rodar o ritual de 2ª opinião e oferecia saídas, entre elas "libere a rede e faça o login por código **uma vez**" (errada, ver abaixo).

## O que era (medido, não suposto)

**Não quebrou nada. As sessões mudaram de máquina.** Em 5 semanas de história da `main` (21/08→26/09), o 1º commit com trailer de sessão cloud é de **24/09**; antes, zero. O codex, o login dele (`~/.codex/auth.json`), o `psql-ro`, o heavy e o gstack moram no Mac. O container da nuvem nasce do zero a cada sessão, e o repo não tinha provisionamento de nuvem nenhum (0 referências a `CLAUDE_CODE_REMOTE`).

Havia três paredes independentes:

1. **Binário:** o container vinha sem `codex` e sem `~/.codex`.
2. **Rede:** o proxy do ambiente responde `CONNECT` com 403 para `api.openai.com`, `chatgpt.com` e `auth.openai.com` (`curl: (56) CONNECT tunnel failed, response 403`).
3. **Credencial:** o login do plano fica dentro do container e morre com ele. Por isso "login por código uma vez… daqui em diante" é falso: cada sessão nova pediria outro código.

O que **não** é parede, testado no próprio container:

- **npm:** alcança o registry (que fica fora do proxy; o GitHub Releases dá 403). Instalação em 7 s.
- **TLS:** o codex confia no TLS re-terminado pelo proxy (apontado para um host liberado, fechou o handshake e recebeu resposta HTTP).
- **Sandbox:** o sandbox Linux do codex funciona. Lê o repo e barra escrita com `Read-only file system`.
- **Wrapper:** o `codex-async.sh` roda em Linux (`pkill`, `mktemp`).

## A armadilha que isso destampou

Com binário e credencial presentes, mas o host negado, o codex **não falha**. Loga `HTTP CONNECT failed with status 403`, cai do WebSocket para HTTPS e fica em `Reconnecting... waiting for network` sem desistir (90 s até o `timeout` externo). No wrapper, o watchdog só o mata em 20 min, e o classificador lia isso como transitório (`Proxy connection failed` casa `connection`, e o kill dá rc≥124). Resultado: 3 tentativas, **~1 h em background por um erro de configuração** que nenhuma espera conserta.

## O conserto

`scripts/codex-async.sh`:

- **Instalação:** na nuvem (`CLAUDE_CODE_REMOTE=true`), codex ausente → `npm install -g @openai/codex`. O `flock` serializa consultas paralelas e o 2º RE-CONFERE antes de instalar; quem decide é o binário no PATH, não o exit do npm. Fora da nuvem nunca instala (no Mac o dono é o brew).
- **Pré-voo de rede:** só na nuvem, com host escolhido pelo modo de auth: chave → `api.openai.com`; `auth.json` → `chatgpt.com` + `auth.openai.com`. Bloqueia só com **prova positiva** (exit 56 do curl **e** a frase do 403 no CONNECT, na forma do curl 8.x e na do 7.x) → **exit 68** em menos de 1 s, sem gastar a chamada. Sonda inconclusiva segue e diz `REDE_NAO_MEDIDA`.
- **Classificação:** `CONNECT 403` no meio da consulta → 68 na 1ª tentativa, nunca transitório. Vem antes do ramo transitório e é lido **sem** o eco do prompt.
- **Exit 77 na nuvem:** diz que, por decisão, o Codex roda só no Mac, e manda reabrir a sessão como Local ou seguir pelo Caminho B.

Testes:

- **Suíte própria:** `scripts/test-codex-async-nuvem.sh` (~1 s; `--falsificar` com 9 sabotagens × 2 locales em ~10 s). Fica fora da suíte grande de propósito: lá cada sabotagem roda a suíte inteira (~17 s × 2), e o job `gates-e-falsificacao` já usava 16,5 dos 25 min do teto.
- **Validação real no container (sem stub):** instalação automática em 7 s → 77; pré-voo → 68 em menos de 1 s nos dois modos de auth; codex real travado → 68 após **1** tentativa, em 15 s.
- **Ponta a ponta numa sessão cloud NOVA** (criada pela sessão do conserto, no commit do PR): a instalação levou 8 s e parou em 77. A chave e a liberação de rede ainda não tinham chegado ao ambiente, e o teste mediu isso antes de gastar uma chamada.

**De brinde:** a `test-codex-async.sh` era **vermelha no container cloud por AMBIENTE**. O kernel dá mtime por tick (marca e rollout criados em sequência saíram com o mesmo mtime, até o ns) e o `find -newer` do sensor de fan-out é estrito, então o stub, rápido demais para ser realista, ficava invisível. O controle do filtro por cwd passava por cegueira pelo mesmo motivo. A correção é uma folga de 50 ms antes do rollout no stub.

## Decisões do founder (2026-09-27)

- **Final: o Codex roda só no Mac, na cota do plano.** As sessões só estavam na nuvem porque foram abertas como **Cloud** no app desktop (o registro da sessão do conserto diz origem `desktop_app`); o fluxo sempre foi local. Sessão que precisa do Codex, do `psql-ro`, do heavy ou do gstack abre como **Local**. Na nuvem o wrapper desiste em segundos (77 sem auth, 68 com a rede negada) e a sessão segue pelo Caminho B.
- **Por que não a chave de API, a 1ª decisão do mesmo dia:** ela é faturada na plataforma de API da OpenAI, por token, **à parte da assinatura**, e o plano não traz crédito de API. Consulta pela chave não come a cota do plano, mas também não é coberta por ela. Sem motivo para rodar na nuvem, é custo sem retorno.
- **Descartado desde o início:** copiar o `auth.json` do Mac como segredo. O refresh token rotaciona (o próprio binário tem `your refresh token was already used. Please log out and sign in again`), e Mac e nuvem se derrubariam. Login por código a cada sessão traria de volta o "founder como botão de retomar".

## Se um dia a nuvem precisar do Codex

O wrapper já está pronto: instala, sonda a rede e classifica. Falta só a credencial no ambiente, que só vale para sessão nova. Há dois caminhos, e **nenhum foi validado ponta a ponta**:

1. **API credential** (planos Pro e Max; no editor do ambiente, abaixo de Environment variables). A chave fica no ambiente, e o proxy da Anthropic a põe nas requisições para os hosts listados depois que elas saem da máquina: ela nunca entra na sessão, nas variáveis nem na transcrição. O host listado fica alcançável em qualquer nível de rede. Como o codex exige alguma chave local para arrancar, vai junto `CODEX_API_KEY=<placeholder>` nas variáveis. **Ponto em aberto:** a documentação não diz se o proxy sobrescreve o `Authorization` que o cliente já manda. Meça antes, com uma chamada sem cabeçalho e outra com cabeçalho falso para `https://api.openai.com/v1/models`: 200 na primeira prova a injeção, 200 na segunda prova a sobrescrita.
2. **Variável com a chave real** + Network access **Custom** com `api.openai.com` e "Also include default list of common package managers" marcado (sem isso as sessões perdem o npm). A chave fica legível para quem usa o ambiente.

Nos dois, a chave vem de um projeto OpenAI com teto de gasto, e as mensagens de cota (75) e de modelo (78) do wrapper ainda falam do login do plano (token, `codex logout`), não de billing de API. Ajuste antes de ligar.

## Lições

- **"Parou de funcionar" pode ser troca de máquina, não regressão.** Antes de depurar código, compare o AMBIENTE: onde roda, o que tem instalado, o que a rede deixa sair.
- **Rede negada não é falha transitória.** Cliente que "espera a rede voltar" transforma erro de configuração em hang. Sonde o túnel antes, com prova positiva, e classifique o 403 do proxy como configuração.
- **Stub rápido demais mede o relógio do kernel, não o código.** Com `find -newer`, dê ao fixture pelo menos 1 tick.
- **Antes de ligar credencial paga, pergunte de qual carteira sai.** "Chave de API" soa como a mesma conta da assinatura e não é. A pergunta certa veio do founder, depois do passo a passo pronto.
- **A troca de máquina passou despercebida porque ninguém a anuncia.** Na nuvem, o vigia do gstack fala só com o modelo (additionalContext), e o founder não vê que a sessão está fora do Mac.

## Mesma classe, fora deste conserto

`psql-ro`, heavy e gstack também não existem no container. Com a decisão de rodar local, isto deixa de ser pendência. Só volta a importar se a nuvem voltar a ser usada, e aí com uma ressalva ainda não medida: o proxy é HTTP e o `psql` não atravessa proxy HTTP.
