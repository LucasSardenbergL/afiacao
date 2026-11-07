# Radar, pacote H: o funil do lead empurrado (2026-11-07)

> Sessão `radar-h-painel` (worktree `determined-poincare-7948d9`). Migration `20261107230000_radar_funil_painel`
> (**manual**, SQL Editor), tela `/radar/funil` (**Publish**). Prova PG17: `db/test-radar-funil.sh` (`--falsificar`).

## Por que

O pacote D (#3678, #3700) passou a empurrar leads ao vendedor (e-mail semanal com 5 leads, card "Prospectar
hoje") e gravava os sensores (`radar_email_vendedor_envios`, `radar_lead_aberturas`,
`radar_prospectar_hoje_servido`, além do ledger `radar_eventos`). Nenhuma tela lia nada disso:
`radar_placar_uso()` nunca foi chamada pelo app, e saber se o "0 contato humano de vendedor em 60 dias" mudou
exigia psql. A fase seguinte do Radar exige sinal **com denominador** desta (`fase-sem-sinal.md`); este painel é
esse sinal.

## O que entrou

- **`/radar/funil`** (menu Vendas → "Funil do Radar", só master e gestor comercial; o servidor confere de novo com
  `private.pode_ver_carteira_completa`). Por vendedor e por semana (segunda a domingo, BRT): e-mails gerados →
  entregues (falhos, pendentes) → leads entregues → clicados → fichas entregues; card servido → clicado → ficha;
  contato humano (do qual em lead empurrado) → cliente novo no Omie (do qual de lead empurrado) e vínculos.
  Cada etapa mostra o denominador; taxa sem denominador é "—".
- **Ausente ≠ zero**: `radar_funil_sensores` registra quando cada sensor passou a existir. Semana antes disso sai
  `NULL` ("—"); semana coberta sai 0 quando nada aconteceu. Sensor sem data declarada conta do 1º registro.
- **Saúde dos sensores** no próprio painel: `ok | falhou | parcial | sem registro no período | nunca gravou`, com
  as falhas por motivo: e-mail `falha_notificacao`, pendente há mais de 2 h, `ignorado`; clique perdido (a ficha
  chegou sem o clique gravado); contato/cadastro sem evento no ledger (a reconciliação do fail-open dos
  triggers); e as falhas que só o CLIENTE vê, gravadas em `radar_sensor_falhas` (1 linha por sensor, motivo,
  usuário e dia, com contador).
- **Dois momentos da abertura**: o link do e-mail gravava a abertura antes de a ficha carregar, então o painel
  contaria clique sem ficha. Agora `RadarAbrirEmail` grava o clique, lê o lead (a mesma leitura da ficha) e só
  então grava `ficha_entregue_em` (`radar_registrar_ficha_entregue`). Lead não encontrado, erro de leitura ou
  demora acima de 8 s viram falha do sensor `ficha_email`, e o vendedor segue para a ficha do mesmo jeito.
- **Sensores que não perdem evento em silêncio** (`useRadarRegistroEmpurrado.ts`): toda escrita devolve
  `Promise<ResultadoSensor>` e nunca rejeita. Falha transitória (rede, banco 08/53/57) tem 3 tentativas
  (0,4 s e 1,2 s); a que sobra vai para `track('radar.sensor_falhou')`, `console.warn` e o ledger
  `radar_sensor_falhas`. Na lente "Ver como" nada é chamado (`motivo: 'lente'`).

## Contrato para a sessão F (`ProspectarHojeCard.tsx`)

- `registrarCardServido(n)` e `registrarAberturaEmpurrada({ origem: 'card', cnpj })` agora devolvem
  `Promise<ResultadoSensor>` (`{ ok: true, registrado } | { ok: false, motivo, transitorio }`). A chamada solta
  de hoje continua compilando e funcionando; a falha já é registrada dentro do hook.
- O card ainda **não** grava a ficha entregue: o sensor `ficha_card` aparece como "nunca gravou" e a coluna
  "Fichas (card)" fica "—". Para ligar, chame `registrarFichaEntregue({ origem: 'card', cnpj })` quando a ficha do
  lead tiver chegado (por exemplo, no `RadarClientes` quando o lead do deep link vier de um clique no card) e
  declare a instalação: `UPDATE public.radar_funil_sensores SET instalado_em = now() WHERE sensor = 'ficha_card'`
  depois do Publish.

## Camadas de deploy

| Camada | Quem | Estado |
|---|---|---|
| Migration `20261107230000` | founder (SQL Editor) | ⏳ |
| Publish do front (`/radar/funil`, `RadarAbrirEmail` com 2 momentos) | founder | ⏳ |
| Declarar `ficha_email` instalado (UPDATE de 1 linha, depois do Publish) | founder (SQL Editor) | ⏳ |

## 1ª leitura do painel em prod

(preenchida depois da aplicação)
