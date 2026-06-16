import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
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
);
