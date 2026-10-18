import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "node:fs";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
import { entryPrimeiro } from "./src/sw/releases";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/supabase/vite";
import { execSync } from "node:child_process";

const isLovablePreview = process.env.LOVABLE_PREVIEW === "true";

// Carimbo de commit no bundle (lido pela verificação de deploy / cron de smoke E2E).
// Confirmado em 2026-06-19: o build do Lovable NÃO tem `.git` (git rev-parse → "dev").
// Por isso varremos env de SHA de várias PLATAFORMAS (uma pode ser a do Lovable); só
// aceitamos valor que PARECE um SHA. Sem nenhuma → git local → "dev". Nunca quebra.
function resolveCommitSha(): string {
  const candidates = [
    "VITE_COMMIT_SHA", "COMMIT_SHA", "GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA",
    "CF_PAGES_COMMIT_SHA", "COMMIT_REF", "CACHED_COMMIT_REF", "RENDER_GIT_COMMIT",
    "RAILWAY_GIT_COMMIT_SHA", "SOURCE_VERSION", "LOVABLE_COMMIT_SHA",
    "LOVABLE_GIT_SHA", "LOVABLE_GIT_COMMIT", "LOVABLE_BUILD_SHA",
  ];
  for (const k of candidates) {
    const v = (process.env[k] || "").trim();
    if (/^[0-9a-f]{7,40}$/i.test(v)) return v.slice(0, 8);
  }
  try {
    return execSync("git rev-parse --short=8 HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
}

// PROBE (temporário, removível): quais CHAVES de env de build existem que possam conter
// o commit. Só NOMES (nunca valores), filtrado pra fora de segredos. No 1º Publish revela
// o nome real da env do Lovable se nenhum candidato acima pegou (→ adicioná-lo à lista).
function buildEnvProbe(): string {
  return Object.keys(process.env)
    .filter((k) => /(^|_)(GIT|SHA|COMMIT|REF|REV|BRANCH|DEPLOY|VERCEL|LOVABLE|CF|PAGES|RENDER|RAILWAY|SOURCE|BUILD|CI|HEAD)(_|$)/i.test(k))
    .filter((k) => !/(SECRET|KEY|TOKEN|PASSWORD|PRIVATE|AUTH|CREDENTIAL)/i.test(k))
    .sort()
    .join(",");
}
const commitSha = resolveCommitSha();
const buildEnvKeys = buildEnvProbe();

// Carimbo ORDENÁVEL do build (ISO-8601 UTC, instante em que o Vite rodou). Existe para o
// "build mínimo" (src/lib/pwa-build-minimo.ts): o `build_id` (hash do entry) identifica o
// build mas não diz se é ANTERIOR a outro, e o builder do Lovable não tem SHA de commit.
// Não substitui o `build_id` — ele segue sendo o eixo de adoção.
//
// ⚠️ Vai como <meta> no index.html, NÃO como `define` em JS: um `define` que muda a cada
// build troca o hash de todo chunk que o lê, e se ele morasse em código compartilhado
// refaria a cascata de hash do precache que o #3114 cortou (cada Publish = ~4 MB no
// celular). O index.html já muda em todo build (aponta pro entry), então o carimbo sai
// de graça. E fica no MESMO documento que o `build_id` é lido (src/lib/build-id.ts): o SW
// velho serve o index.html PRECACHEADO, com o carimbo velho — que é a leitura certa.
const buildEm = new Date().toISOString();
function carimboDeBuild(): Plugin {
  return {
    name: "carimbo-de-build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { name: "app-build-em", content: buildEm }, injectTo: "head" },
    ],
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  define: {
    // Substituído LITERALMENTE nos bytes do bundle → grepável na verificação de deploy.
    __COMMIT_SHA__: JSON.stringify(commitSha),
    // PROBE temporário — remover quando a env de SHA do Lovable for identificada.
    __BUILD_ENV_KEYS__: JSON.stringify(buildEnvKeys),
    // Casa EXATAMENTE a condição de inclusão do VitePWA abaixo. main.tsx só
    // registra o SW (via @/lib/pwa-update) quando true — em dev e no preview
    // Lovable não há /sw.js; sendo constante de build, o DCE remove o bloco.
    __PWA_ENABLED__: JSON.stringify(mode === "production" && !isLovablePreview),
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    carimboDeBuild(),
    mcpPlugin(),
    mode === "development" && componentTagger(),
    mode === "production" && !isLovablePreview && VitePWA({
      // Recarregar a PÁGINA continua sendo decisão do operador (toast "Atualizar",
      // ou o momento seguro de src/lib/pwa-atualizacao.ts): um reload no meio do
      // turno mata o estado local do formulário (a fila offline sobrevive no
      // localStorage, o lote meio-digitado não). O que mudou em 2026-10-18 é que o
      // SW em si assume sem espera — sem recarregar nada (src/sw/sw.ts).
      // `registerType` é ignorado com injectManifest; fica 'prompt' por clareza.
      registerType: "prompt",
      // false: registramos o SW nós mesmos (src/lib/pwa-update.ts, API nativa).
      injectRegister: false,
      includeAssets: ["favicon.ico", "robots.txt"],
      manifest: {
        name: "Colacor",
        short_name: "Colacor",
        description: "Sistema operacional B2B do grupo Colacor",
        theme_color: "#1a1a2e",
        background_color: "#1a1a2e",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      // SW PRÓPRIO (src/sw/sw.ts), não mais o gerado pelo Workbox — 2026-10-18.
      // O gerado acoplava "SW novo utilizável" a "baixou o precache INTEIRO no
      // install" + clique: o iPhone do founder ficou 9+ dias preso num build cujo
      // código não alcançávamos. O SW ponte instala sem baixar nada, assume na
      // hora (sem recarregar a página aberta) e prepara o build novo em segundo
      // plano; o modelo e as invariantes estão em src/sw/releases.ts e
      // docs/agent/deploy.md §"Atualização do PWA". `filename: sw.ts` → publicado
      // como /sw.js, o MESMO URL do SW antigo (é o que faz o cliente velho achá-lo).
      strategies: "injectManifest",
      srcDir: "src/sw",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Precache ENXUTO: ficam FORA só chunks de telas INERENTEMENTE online
        // (IA/voz, mapa com tiles, session replay, docs de dev). Telas
        // operacionais (picking/recebimento/pedido/Meu Dia/rota) e todos os
        // vendors entram — offline-first (§6.1). Os de fora ganham cobertura
        // progressiva pelo cache de runtime de /assets/ no SW.
        globIgnores: [
          "**/FarmerCopilot-*.js", // copilot de voz, exige rede (o SDK pesado saiu daqui → vendor-elevenlabs)
          "**/vendor-elevenlabs-*.js", // ~465KB — SDK de voz; só o copilot usa, lazy no iniciar sessão
          "**/vendor-tesseract-*.js", // OCR core (LoteScannerOCR, lazy no 1º scan); wasm/traineddata já vêm da rede
          "**/AdminRoutePlanner-*.js", // ~188KB — Leaflet; tiles do mapa exigem rede
          "**/AdminRoutePlanner-*.css", // CSS do Leaflet (único ignorado com CSS próprio)
          "**/vendor-posthog-*.js", // ~186KB — posthog-js core (analytics; lazy via analytics.ts)
          "**/TechnicalDocs-*.js", // ~74KB — documentação interna de dev
          "**/DesignSystem-*.js", // docs internas de design
          "**/DesignPreview-*.js",
          // ⚠️ Case EXATO do chunk (UXRules.tsx): glob é case-insensitive no
          // macOS (nocase default do darwin) mas case-SENSITIVE no Linux do
          // builder de produção — grafia errada = ignore morto só em prod.
          "**/UXRules-*.js",
        ],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
        // O entry REAL (o do index.html) vira a 1ª entrada: é o build_id da release
        // no SW (há vários index-*.js no bundle). Entry ausente = build FALHA.
        manifestTransforms: [
          (entradas) => ({
            manifest: entryPrimeiro(entradas, fs.readFileSync(path.resolve(__dirname, "dist/index.html"), "utf8")),
            warnings: [],
          }),
        ],
        // iife: o SW é registrado como script CLÁSSICO (importScripts do
        // push-sw.js funciona; registro ES-module não existe no iOS < 16.4).
        rollupFormat: "iife",
      },
      devOptions: {
        enabled: false,
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Agrupa VENDORS (node_modules) em buckets cacheáveis + o grafo estático
        // do entry em app-core (abaixo). NÃO agrupar páginas por feature: o agrupamento anterior (feature-admin/financeiro/...)
        // criava chunks com dependência circular (páginas se importam entre si),
        // e o Rollup avisava "Circular chunk: feature-admin -> feature-financeiro".
        // Em produção isso virava um TDZ em runtime ("Cannot access 'X' before
        // initialization") que crashava o boot ANTES do React montar → tela
        // travada. Deixar o Rollup auto-splitar as páginas (1 chunk por rota lazy)
        // é circular-safe e era o comportamento que funcionava.
        manualChunks(id, { getModuleInfo }) {
          // ENTRY FINO (app-core). O entry (index-*.js) carrega o `__vite__mapDeps`
          // com o nome de TODOS os chunks lazy (as rotas do App.tsx): o hash dele
          // muda em todo Publish que mexe no app. Antes, o código compartilhado
          // que o entry importava estaticamente (supabase client, contexts, ui/*,
          // preload helper do Vite...) morava DENTRO dele, então ~266 chunks lazy
          // faziam `import ... from "./index-<hash>.js"`. Como o hash do Rollup é
          // transitivo (o nome do import faz parte do conteúdo), o hash de todos
          // trocava junto: 267/326 entradas do precache = 4,0 de 6,0 MB por
          // Publish (medido 2026-10-16), mesmo editando uma tela só.
          // Agora vai pra app-core só o que é estático a partir do entry E é
          // usado por algum chunk lazy. O que só o shell usa (AppShell,
          // CommandPalette, GuardModuloCongelado → lib/modulos/manifesto.ts, que
          // quase todo PR edita) fica no entry, que muda de qualquer jeito.
          // Mandar o shell pro app-core voltaria a cascatear a cada PR.
          // Acíclico por construção: o que um módulo de app-core importa é também
          // estático a partir do entry E alcançável por um lazy → app-core ou
          // vendor. Nada em app-core importa o entry nem um chunk lazy.
          // Só código do APP (src/) + o preload helper do Vite (todo chunk com
          // import() dinâmico o importa). Helpers virtuais do Rollup (\0commonjs*)
          // e node_modules sem bucket ficam com o Rollup, que os absorve no 1º
          // chunk manual que depende deles; mandá-los pra app-core criava
          // "Circular chunk: vendor-react -> app-core -> vendor-react".
          if (id.includes('node_modules')) {
            return vendorChunk(id);
          }
          if (id.includes('vite/preload-helper')) return 'app-core';
          if (id.startsWith(SRC_DIR) && !id.endsWith('.css')) {
            return chunkCompartilhado(getModuleInfo).get(id);
          }
          // App code: sem agrupamento manual → Rollup decide (circular-safe).
        },
      },
    },
  },
}));

const SRC_DIR = path.resolve(__dirname, "src") + path.sep;

// A partir de quantos chunks lazy (alvos de import() dinâmico) um módulo
// compartilhado vai pro app-core em vez de um chunk do seu grupo. Abaixo
// disso a edição custa no máximo ~LAZY_MIN_APP_CORE telas; acima, separar
// não compensa (quase toda tela muda junto de qualquer jeito).
const LAZY_MIN_APP_CORE = 20;

// Chunk de cada módulo COMPARTILHADO do app: alcançável por import ESTÁTICO a
// partir do entry (src/main.tsx), menos main.tsx e App.tsx (o App tem os lazy()
// das rotas e portanto o mapDeps), E usado por algum chunk lazy. O que só o
// shell usa fica de fora (fica no entry, que muda em todo Publish).
// Alcance = conjunto de alvos de import() dinâmico que chegam ao módulo por
// import estático.
//  - alcance >= LAZY_MIN_APP_CORE (supabase client, AuthContext, ui/*,
//    postgrest) → app-core.
//  - abaixo disso, um chunk por ASSINATURA de alcance: módulos usados pelas
//    MESMAS telas cascateiam pras mesmas telas, então dividir chunk não custa
//    nada. Editar useTarefas troca só as ~6 telas que o usam. Dentro do
//    app-core trocava o hash dele e de todos os ~263 importadores; eram assim
//    6 dos 9 commits residuais medidos em 2026-10-17.
// Sem ciclo entre chunks, por construção: se X importa Y, todo lazy que alcança
// X alcança Y (alcance(Y) ⊇ alcance(X)). Um ciclo exigiria alcances iguais,
// e alcances iguais caem no mesmo chunk. O app-core nunca importa um grupo.
// Calculado uma vez por build: o manualChunks roda com o grafo já completo.
type ModuleInfoMinima = { importedIds: readonly string[]; dynamicallyImportedIds: readonly string[] };
type GetModuleInfo = (id: string) => ModuleInfoMinima | null;
const chunkCompartilhadoCache = new WeakMap<GetModuleInfo, Map<string, string>>();
function chunkCompartilhado(getModuleInfo: GetModuleInfo): Map<string, string> {
  const emCache = chunkCompartilhadoCache.get(getModuleInfo);
  if (emCache) return emCache;
  const fecho = (raizes: Iterable<string>, comDinamicos: boolean) => {
    const seen = new Set<string>();
    const pilha = [...raizes];
    while (pilha.length) {
      const id = pilha.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const info = getModuleInfo(id);
      for (const dep of info?.importedIds ?? []) pilha.push(dep);
      if (comDinamicos) for (const dep of info?.dynamicallyImportedIds ?? []) pilha.push(dep);
    }
    return seen;
  };
  const entryId = path.resolve(__dirname, "src/main.tsx");
  const estaticoDoEntry = fecho([entryId], false);
  estaticoDoEntry.delete(entryId);
  estaticoDoEntry.delete(path.resolve(__dirname, "src/App.tsx"));
  const alvosDinamicos = new Set<string>();
  for (const id of fecho([entryId], true)) {
    for (const dep of getModuleInfo(id)?.dynamicallyImportedIds ?? []) alvosDinamicos.add(dep);
  }
  const alcance = new Map<string, string[]>();
  for (const alvo of [...alvosDinamicos].sort()) {
    for (const id of fecho([alvo], false)) {
      if (id.startsWith(SRC_DIR) && estaticoDoEntry.has(id)) alcance.set(id, [...(alcance.get(id) ?? []), alvo]);
    }
  }
  const grupos = new Map<string, string[]>();
  const resultado = new Map<string, string>();
  for (const [id, alvos] of alcance) {
    if (alvos.length >= LAZY_MIN_APP_CORE) {
      resultado.set(id, "app-core");
      continue;
    }
    const assinatura = alvos.join("\n");
    grupos.set(assinatura, [...(grupos.get(assinatura) ?? []), id]);
  }
  // Nome legível e determinístico: o 1º módulo (em ordem) do grupo.
  for (const membros of grupos.values()) {
    const primeiro = path.relative(SRC_DIR, [...membros].sort()[0]);
    const nome = "app-" + primeiro.replace(/\.[^.]+$/, "").replace(/[\\/]/g, "-");
    for (const id of membros) resultado.set(id, nome);
  }
  chunkCompartilhadoCache.set(getModuleInfo, resultado);
  return resultado;
}

// Buckets de VENDOR (node_modules) cacheáveis. undefined = Rollup decide.
function vendorChunk(id: string): string | undefined {
  // Utilitários de classe usados pelo cn() do shell. SEM esta regra o
  // Rollup alocava o clsx DENTRO do vendor-charts (recharts depende
  // dele) e o entry passava a importar recharts+d3 inteiros (~114KB
  // gzip) só pra obter o clsx — medido no build de 2026-06-09.
  if (/node_modules[\\/](clsx|tailwind-merge|class-variance-authority)[\\/]/.test(id)) return 'vendor-utils';
  // Ancorado em node_modules: a regex antiga sem âncora casava
  // QUALQUER segmento "react" no caminho — capturava @elevenlabs/react
  // (SDK de voz, ~100KB gzip, usado só pelo FarmerCopilot lazy) pra
  // dentro do vendor-react. react-router core + @remix-run/router
  // entram explícitos (a família toda num chunk coeso e estável).
  if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@remix-run)[\\/]/.test(id)) return 'vendor-react';
  if (id.includes('@tanstack/react-query')) return 'vendor-query';
  if (id.includes('@supabase/supabase-js')) return 'vendor-supabase';
  if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
  // Nome explícito: sem isto o chunk do posthog-js (dynamic import
  // em analytics.ts) nasce como "module-<hash>.js" (basename do
  // entry ESM do pacote) — nome genérico que o globIgnores do
  // precache não consegue mirar com segurança.
  if (id.includes('posthog-js')) return 'vendor-posthog';
  // Mesmo racional do vendor-posthog: SDKs pesados atrás de dynamic
  // import (voz ElevenLabs no MotorVozScribe; OCR no LoteScannerOCR) —
  // nome explícito pro globIgnores do precache conseguir mirá-los.
  if (/node_modules[\\/]@elevenlabs[\\/]/.test(id)) return 'vendor-elevenlabs';
  if (/node_modules[\\/]tesseract\.js[\\/]/.test(id)) return 'vendor-tesseract';
  if (id.includes('framer-motion')) return 'vendor-motion';
  if (id.includes('@radix-ui/')) return 'vendor-ui';
  // next-themes: o ThemeProvider é do shell (fica no entry), mas telas lazy
  // usam useTheme. Sem bucket, o Rollup o deixava DENTRO do entry e a tela
  // importava ./index-<hash>.js (cascata, ver app-core). Só depende de react.
  if (/node_modules[\\/]next-themes[\\/]/.test(id)) return 'vendor-ui';
  if (id.includes('lucide-react')) return 'vendor-icons';
  if (id.includes('date-fns')) return 'vendor-dates';
  return; // resto: deixar Rollup decidir
}
