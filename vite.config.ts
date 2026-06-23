import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
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

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  define: {
    // Substituído LITERALMENTE nos bytes do bundle → grepável na verificação de deploy.
    __COMMIT_SHA__: JSON.stringify(commitSha),
    // PROBE temporário — remover quando a env de SHA do Lovable for identificada.
    __BUILD_ENV_KEYS__: JSON.stringify(buildEnvKeys),
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
    mode === "development" && componentTagger(),
    mode === "production" && !isLovablePreview && VitePWA({
      registerType: "autoUpdate",
      injectRegister: "script-defer",
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
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Precache ENXUTO: o SW baixava TODOS os ~250 chunks (~6.2MB) na 1ª
        // instalação e revalidava a cada deploy — custo real no 4G da
        // vendedora. Ficam FORA do precache só chunks de telas INERENTEMENTE
        // online (IA/voz, mapa com tiles de rede, session replay, docs
        // internas de dev) — offline nelas não funcionaria de qualquer jeito.
        // Telas operacionais (picking/recebimento/pedido/Meu Dia/rota) e
        // todos os vendors continuam precacheados (offline-first, §6.1).
        // Quem sai do precache ganha cobertura PROGRESSIVA pelo runtime
        // caching de /assets/ (CacheFirst) abaixo: visitou 1× online, fica.
        globIgnores: [
          "**/FarmerCopilot-*.js", // ~465KB — copilot de voz (ElevenLabs), exige rede
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
        // Web Push da vendedora: handlers `push`/`notificationclick` vivem em
        // public/push-sw.js e são injetados no SW gerado (generateSW não aceita
        // handler custom inline; importScripts é o caminho oficial do Workbox).
        // ⚠️ Se EDITAR o push-sw.js, RENOMEIE pra push-sw-v2.js (+ aqui): o
        // importScripts passa pelo HTTP cache (updateViaCache default 'imports')
        // e um max-age na hospedagem serviria bytes velhos do handler.
        importScripts: ["push-sw.js"],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/~oauth/, /^\/__/],
        runtimeCaching: [
          // ─── Catálogo: cacheable longo (raramente muda) ─────────────
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/(tool_categories|default_prices|company_config|category_mappings)/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-catalog-cache",
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60, // 1 hour
              },
            },
          },
          // ─── Picking + recebimento (offline-first per CLAUDE.md §6.1) ─
          // Antes: rotas não cobertas → fetch direto sem fallback offline.
          // Agora: NetworkFirst com TTL curto. PWA tenta rede primeiro
          // (sempre fresco quando online); fallback pro cache quando offline.
          // Workbox NetworkFirst só cacheia GET — POSTs/PATCHes/DELETEs
          // sempre passam direto pra rede (semântica desejada).
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/(picking_tasks|picking_units|picking_lotes)/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-picking-cache",
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 5 * 60, // 5min — turno de picking renova rápido
              },
            },
          },
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/(nfe_recebimentos|nfe_recebimento_itens|cte_associados)/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-recebimento-cache",
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60, // 1min — conferência ativa
              },
            },
          },
          // ─── Pedidos: NetworkFirst com TTL muito curto ──────────────
          // Era NetworkOnly (sem fallback offline). NetworkFirst dá fallback
          // de leitura quando wifi cai durante navegação. TTL 30s garante
          // dados frescos quando online.
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/(orders|sales_orders|order_items|order_messages)/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-orders-cache",
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 30,
              },
            },
          },
          // ─── Profiles + user_tools: NetworkFirst (raramente mudam) ─
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/(profiles|user_tools)/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-profiles-cache",
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 5 * 60, // 5min
              },
            },
          },
          // ─── Tintométrico + Farmer (analíticos): NetworkFirst longo ─
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/(tint_|farmer_)/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-analytics-cache",
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 2 * 60, // 2min
              },
            },
          },
          // ─── Auth e realtime: SEMPRE network only ───────────────────
          // Sessões/tokens não podem cachear (segurança); realtime é
          // WebSocket que workbox não deve interceptar.
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/(auth|realtime)/i,
            handler: "NetworkOnly",
          },
          // ─── Chunks fora do precache: cache progressivo ─────────────
          // Assets do Vite têm hash no nome (immutable) → CacheFirst é
          // seguro por construção (conteúdo novo = URL nova). Cobre os
          // chunks dos globIgnores acima (e qualquer futuro): a 1ª visita
          // online grava no cache e a tela passa a abrir offline também.
          // same-origin only (o pattern casa pathname em same-origin).
          {
            urlPattern: /\/assets\/.*\.(?:js|css)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "app-assets-progressive",
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 dias
                purgeOnQuotaError: true,
              },
            },
          },
        ],
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
        // Só agrupa VENDORS (node_modules) em buckets cacheáveis. NÃO agrupar
        // páginas por feature: o agrupamento anterior (feature-admin/financeiro/...)
        // criava chunks com dependência circular (páginas se importam entre si),
        // e o Rollup avisava "Circular chunk: feature-admin -> feature-financeiro".
        // Em produção isso virava um TDZ em runtime ("Cannot access 'X' before
        // initialization") que crashava o boot ANTES do React montar → tela
        // travada. Deixar o Rollup auto-splitar as páginas (1 chunk por rota lazy)
        // é circular-safe e era o comportamento que funcionava.
        manualChunks(id) {
          if (id.includes('node_modules')) {
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
            if (id.includes('framer-motion')) return 'vendor-motion';
            if (id.includes('@radix-ui/')) return 'vendor-ui';
            if (id.includes('lucide-react')) return 'vendor-icons';
            if (id.includes('date-fns')) return 'vendor-dates';
            return; // resto: deixar Rollup decidir
          }
          // App code: sem agrupamento manual → Rollup decide (circular-safe).
        },
      },
    },
  },
}));
