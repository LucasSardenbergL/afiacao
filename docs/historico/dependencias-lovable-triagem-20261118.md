# Triagem das dependências do painel Security do Lovable (2026-11-18)

O quadro "Project dependencies" do painel Security do Lovable mostrava 59 pacotes com 91 vulnerabilidades conhecidas. Nenhum lote do scanner havia olhado para ele. Na `main@60a85aff9`, o `bun audit` local lista **139 avisos** (3 critical, 53 high, 65 moderate e 18 low) em 42 pacotes. O painel conta outra coisa, provavelmente pacotes ou vulnerabilidades únicas. A pergunta que decide é **onde o pacote roda**, não a severidade do aviso.

## Onde cada coisa roda

| Superfície | Pacotes com aviso | Leitura |
|---|---|---|
| **Navegador** (bundle do app) | `react-router(-dom)` 6.30.4; `dompurify` 3.4.3, `fflate` 0.4.8 e `protobufjs` 7.5.8, os três puxados pelo `posthog-js` 1.373.4; `lodash` 4.17.21, puxado pelo `recharts`; `zod` 3.25 | Ver abaixo |
| **Edge `mcp`** (Deno, `npm:` próprio) | `@lovable.dev/mcp-js` → `@modelcontextprotocol/sdk` → `express`/`hono`/`proxy-addr` | O `package.json` não decide o que a edge carrega: ela importa `npm:@lovable.dev/mcp-js@0.20.0`. O app não usa o servidor HTTP do `express`/`hono`. Os critical de `proxy-addr` exigem `trust proxy` por sub-rede, que o handler do Supabase não usa. |
| **Build e testes** (nunca no ar) | `vite`, `esbuild`, `vitest`/`tinypool` (os 2 critical), `minimatch`, `brace-expansion`, `glob`, `postcss`, `@babel/*`, `workbox-build`→`lodash`, `js-yaml`, `smol-toml`, `ws` | Exige input hostil na máquina de quem builda. Não há caminho a partir do usuário. |

## O que era real e foi corrigido

Abrir o `react-router` levou a um **open redirect no app**. O `?returnTo=` da fila em `UnifiedOrder.tsx` tinha um guard caseiro (`startsWith('/') && !startsWith('//')`) que deixava passar `/\evil.example`. O navegador lê a contrabarra como barra, e o `pushState` recusa a outra origem. O react-router então cai em `window.location.assign`, e o "Voltar à fila" depois do pedido levava para fora do app. O login já tinha o guard certo (`caminhoInternoSeguro`, `src/lib/destino-pos-login.ts`, que recusa `\`). Agora a fila usa o mesmo guard.

O `react-router-dom` subiu de 6.30.4 para 6.30.6. Isso fecha o aviso da faixa 6.30.2–6.30.5. **O aviso da contrabarra (GHSA-wrjc-x8rr-h8h6) continua listado para toda a 6.x**: a correção da biblioteca só existe na 7.18. Por isso a defesa é o guard na fronteira. Fora do login e da fila, nenhum `navigate`/`<Link>` recebe destino vindo da URL. A busca foi `searchParams.get('next'|'returnTo'|'redirect'|…)` em `src/`.

O aviso de "constructor injection" do mesmo pacote é da hidratação SSR, e o app é SPA.

## O que fica sem ação agora, e por quê

- **`dompurify` (via `posthog-js`).** Todos os avisos exigem modo `IN_PLACE`, hook customizado ou `setConfig`. O app não importa o `dompurify`; quem o usa é o próprio PostHog, para HTML de survey que vem do projeto PostHog. Subir o `posthog-js` (1.373 para 1.450) traz `dompurify`, `fflate` e `protobufjs` novos, mas é um salto de 77 versões no SDK de analytics. Vale como PR próprio com o sensor de eventos conferido, não de carona aqui.
- **`zod` < 4.6.6.** O aviso é de memória com coleção gigante. O cliente só valida o que ele mesmo digita, e as edges importam `npm:zod` à parte. Migrar para a 4 é refactor de schemas, sem ganho de segurança mensurável.
- **`lodash` (via `recharts`).** O aviso é `_.template` com chaves de `imports` controladas pelo atacante e prototype pollution em `_.unset`/`_.omit`. O `recharts` não passa input de usuário a essas funções, e o app não importa `lodash`.
- **Build e testes.** Sem caminho do usuário. Atualizações de rotina, sem urgência.

## Seguimento: `posthog-js` 1.373.4 → 1.450.1 (mesmo dia)

Feito no PR seguinte. Fecha os avisos de `dompurify` e `protobufjs`; o `bun audit` cai de 139 para 121. Sobra o `fflate` 0.4.8, porque o `posthog-js` não exige a 0.4.9 e o `bun update` só a traria como dependência direta, na 0.8. O aviso é de `unzipSync`; o PostHog usa o `fflate` só para comprimir o que envia.

O CHANGELOG do intervalo (3.846 linhas, sem nenhuma seção de major) não quebra nenhuma opção que usamos. Do que passa a valer por padrão para quem não passa `defaults`:
- **`$device_model` em todo evento (1.394, #3986)**: desligado com `disableDeviceModel: true`. Nenhuma decisão usa o modelo do aparelho, e é mais um atributo que ajuda a identificar a pessoa.
- **Leitura dos cookies `_fbc`/`_fbp` da Meta (1.433, #4916)**: sem efeito, porque o app não tem Meta Pixel.
- **`reset()` limpa o consentimento persistido (#4314)**: o logout agora reaplica o opt-out em dev e em host local. Sem isso, o QA em `localhost` voltaria a mandar evento ao projeto de produção depois do logout.

Session replay, captura de exceções, heatmaps, console e rede: nada passa a ligar sozinho pelo SDK. O que o projeto liga pelo painel do PostHog, o changelog não cobre.

## Não clicar

Não use os botões de correção automática do painel ("Try to fix"/"Update"). Eles editam o `package.json`/`bun.lock` direto na `main`, sem CI. É a mesma classe do push do bot revertido no #3955.
