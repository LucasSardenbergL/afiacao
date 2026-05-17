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
        // Function-form pra agrupar lazy pages por módulo + manter vendors split.
        // Antes: 119 chunks separados (1 por lazy page) → TTFB extra por navegação.
        // Agora: peers de um mesmo módulo no mesmo chunk (ex: 22 pages de Reposição = 1 chunk).
        // Vendors continuam separados (cacheable, raramente mudam).
        manualChunks(id) {
          // ─── Vendors ──────────────────────────────────────────────────
          if (id.includes('node_modules')) {
            if (/[\\/](react|react-dom|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
            if (id.includes('@tanstack/react-query')) return 'vendor-query';
            if (id.includes('@supabase/supabase-js')) return 'vendor-supabase';
            if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
            if (id.includes('framer-motion')) return 'vendor-motion';
            if (id.includes('@radix-ui/')) return 'vendor-ui';
            if (id.includes('lucide-react')) return 'vendor-icons';
            if (id.includes('date-fns')) return 'vendor-dates';
            return; // resto: deixar Rollup decidir
          }

          // ─── Feature chunks (agrupa lazy pages do mesmo módulo) ──────
          // ORDEM IMPORTA: AdminReposicao deve vir ANTES de Admin (catchall)
          if (id.includes('/src/pages/')) {
            if (id.includes('/AdminReposicao')) return 'feature-reposicao';
            if (id.includes('/Farmer')) return 'feature-farmer';
            if (id.includes('/Financeiro')) return 'feature-financeiro';
            if (id.includes('/Tint') || id.includes('/AdminTint')) return 'feature-tintometrico';
            if (id.includes('/Governance')) return 'feature-governance';
            if (id.includes('/Sales')) return 'feature-sales';
            if (id.includes('/Recebimento')) return 'feature-estoque';
            if (id.includes('/picking/')) return 'feature-estoque';
            // Docs internos: baixo uso, cabe num bundle único
            if (
              id.includes('/DesignSystem') ||
              id.includes('/DesignPreview') ||
              id.includes('/UXRules') ||
              id.includes('/TechnicalDocs') ||
              id.includes('/TintApiContract')
            ) return 'feature-docs';
            // Admin (catchall depois de AdminReposicao + AdminTint)
            if (id.includes('/Admin')) return 'feature-admin';
            // Restantes (~15 pages cliente: Orders, Tools, Profile, etc.) ficam
            // no chunk principal pra navegação inicial rápida do customer
          }
        },
      },
    },
  },
}));
