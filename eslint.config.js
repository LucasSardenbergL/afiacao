import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // worktrees git aninhados de outras sessões Claude (.claude/.claire são gitignored;
  // o CI nunca os vê). Sem isto, `eslint .` local recorre neles e reporta erros-fantasma
  // (no-explicit-any/prefer-const etc.) de código que não pertence a este checkout.
  // supabase/functions/mcp/** é o BUNDLE auto-gerado pelo @lovable.dev/mcp-js (banner "do not edit";
  // o Vite plugin regenera do fonte src/lib/mcp). O bundler emite `var` (no-var) e re-minifica a cada
  // build — lintar o artefato é ruído. A FONTE (src/lib/mcp/**) continua lintada normalmente.
  // `supabase/harness-sonda-rollback/sinteticos/**` são FIXTURES que imitam bundles históricos de
  // edge (com `as any` e afins, como o código de 2026-02 realmente era). Lintá-los mede a coisa
  // errada: o que importa neles é o COMPORTAMENTO que o runner executa, não o estilo.
  { ignores: ["dist", ".claude/**", ".claire/**", "supabase/functions/mcp/**", "supabase/harness-sonda-rollback/sinteticos/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Anti-injeção PostgREST (CLAUDE.md §9b): proíbe interpolar input direto
    // num .or() via template literal. Use os helpers de @/lib/postgrest
    // (ilikeOr/ilike/eqInt/eqText/orFilter), que sanitizam os metacaracteres.
    // Escopo: só o frontend (src/). Edge Functions (supabase/functions) rodam em
    // Deno, não importam o alias @/, e várias usam `and(...)` com datas
    // computadas (não-input) — fora do alcance deste helper.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='or'] > TemplateLiteral[expressions.length>0]",
          message:
            "Não interpole input em .or() do PostgREST com template literal — use os helpers de @/lib/postgrest (ilikeOr/ilike/eqInt/eqText/orFilter), que sanitizam. Ver CLAUDE.md §9b.",
        },
        {
          // PR0.0-bis: omie_payload/omie_response de sales_orders foram fechados à leitura de
          // `authenticated` (REVOKE SELECT column-level). Um `.select('*')` daria 42501 (o *
          // inteiro cai). Enumere as colunas não-sensíveis; leia o payload via a RPC staff
          // `staff_get_sales_order_payload`. Reintroduzir `.select('*')` reabriria a quebra.
          // ⚠️ Defense-in-depth: pega só o chain direto from('sales_orders').select('*') — não
          // aliases/casts/wrappers (achado Codex). A proteção REAL é o REVOKE (42501 em runtime);
          // esta regra só evita a reintrodução acidental no padrão comum.
          selector:
            "CallExpression[callee.property.name='select'][arguments.0.value='*'][callee.object.callee.property.name='from'][callee.object.arguments.0.value='sales_orders']",
          message:
            "sales_orders: NÃO use .select('*') — omie_payload/omie_response são fechados à leitura de `authenticated` (PR0.0-bis) e o * inteiro dá 42501. Enumere as colunas não-sensíveis; leia o payload via staff_get_sales_order_payload. Ver docs/agent/database.md.",
        },
      ],
    },
  },
  {
    // Lente "ver como pessoa" (CLAUDE.md §5): useDisplayAccess é hook de
    // exibição/navegação (retorna o userId do alvo quando na lente). Código de
    // escrita/serviço DEVE usar useAuth() — o client real, não o alvo da lente.
    // Proibir o import na camada de serviço evita que mutações acidentalmente
    // operem com o effectiveUserId do alvo em vez do master autenticado.
    files: ["src/services/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/hooks/useDisplayAccess",
              message:
                "useDisplayAccess é só para exibição/navegação. Camada de serviço/escrita usa useAuth() real.",
            },
          ],
        },
      ],
    },
  },
  {
    // bun congela o ambiente do processo FILHO na partida (docs/historico/bun-filho-sem-env-herda-a-partida.md).
    // Sob bun 1.3.14, `spawnSync`/`execSync`/`execFileSync` e `Bun.spawn`/`Bun.spawnSync` SEM `env`
    // explícito entregam ao filho o ambiente de quando o bun arrancou: a mutação de `process.env` feita
    // depois some em silêncio. No node — logo no vitest — as mesmas linhas funcionam, e o teste verde
    // não prova o script. A regra mira a MUTAÇÃO, não a chamada: é ela que alcança o filho até por
    // função importada (o `git()` de scripts/sonda-versao-bump-gate.ts serve outros 4 scripts), e as
    // chamadas sem `env` do repo só são inofensivas porque nada muta o ambiente antes delas.
    // Escopo: o que roda sob bun (`scripts/`, `db/`, TS e JS); `*.test.ts` roda no vitest (node) e
    // fica fora. Prova do gate: scripts/eslint-mutacao-env-bun.test.ts.
    files: ["scripts/**/*.{ts,js,mjs,cjs}", "db/**/*.{ts,js,mjs,cjs}"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          // process.env.X = … · process.env[X] = … · +=, ??=, ||= (todos são AssignmentExpression)
          "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.name=/^(process|Bun)$/][left.object.property.name='env']",
          // process.env = …
          "AssignmentExpression[left.type='MemberExpression'][left.object.name=/^(process|Bun)$/][left.property.name='env']",
          // delete process.env.X · delete process.env[X]
          "UnaryExpression[operator='delete'][argument.type='MemberExpression'][argument.object.type='MemberExpression'][argument.object.object.name=/^(process|Bun)$/][argument.object.property.name='env']",
          // Object.assign/defineProperty/defineProperties(process.env, …) · Reflect.set/deleteProperty/defineProperty(process.env, …)
          "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(Object|Reflect)$/][callee.property.name=/^(assign|defineProperty|defineProperties|set|deleteProperty)$/][arguments.0.type='MemberExpression'][arguments.0.object.name=/^(process|Bun)$/][arguments.0.property.name='env']",
        ].map((selector) => ({
          selector,
          message:
            "Mutar process.env em código que roda sob bun não chega ao processo filho: spawnSync/execSync/execFileSync e Bun.spawn/Bun.spawnSync SEM `env` entregam o ambiente da PARTIDA (no node/vitest funciona, então o teste verde não prova o script). Monte o ambiente e passe `env: { ...process.env, CHAVE: valor }` a cada filho; se a mutação é só in-process, desligue a linha com o motivo. Ver docs/historico/bun-filho-sem-env-herda-a-partida.md",
        })),
      ],
    },
  },
);
