import { auth, defineMcp } from "@lovable.dev/mcp-js";
import echoTool from "./tools/echo";
import searchCustomersTool from "./tools/search-customers";

// OAuth issuer MUST be the direct Supabase host (built from the project ref, not
// SUPABASE_URL, which on Lovable Cloud is the `.lovable.cloud` proxy). Vite inlines
// VITE_SUPABASE_PROJECT_ID as a literal at build time — keeps this entry import-safe
// (no runtime env read at module top level).
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "colacor-mcp",
  title: "Colacor",
  version: "0.1.0",
  instructions:
    "Colacor B2B operating system tools. Use `echo` to verify connectivity and `search_customers` to look up customer profiles by name, document, email or phone.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [echoTool, searchCustomersTool],
});
