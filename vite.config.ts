import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

const isLovablePreview = process.env.LOVABLE_PREVIEW === "true";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
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
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
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
