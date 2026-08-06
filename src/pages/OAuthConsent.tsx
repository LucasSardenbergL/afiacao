// Consent page for OAuth 2.1 authorization requests from MCP clients (Claude,
// ChatGPT, etc.). Supabase redirects the user here with ?authorization_id=...
// after they hit /oauth/authorize on the direct supabase.co host.
//
// This file is a REQUIRED part of the MCP app-server setup — see
// docs/agent/app-mcp-server-authoring guidance. Do NOT navigate to `/` on the
// unauthenticated path: preserve the full consent URL through `/auth?next=`
// so the connector round-trip completes.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Loader2 } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Button } from '@/components/ui/button';

// Wrapper tipado local pro namespace `supabase.auth.oauth` (ainda em beta no
// SDK — o tipo pode não existir; runtime existe). Sem `any` global.
interface OAuthAuthorizationClient { name?: string; client_uri?: string; logo_uri?: string }
interface OAuthAuthorizationDetails { client?: OAuthAuthorizationClient; redirect_url?: string; redirect_to?: string; scope?: string[] }
interface OAuthAuthorizationResult { redirect_url?: string; redirect_to?: string }
interface SupabaseAuthOAuthApi {
  getAuthorizationDetails(id: string): Promise<{ data: OAuthAuthorizationDetails | null; error: { message: string } | null }>;
  approveAuthorization(id: string): Promise<{ data: OAuthAuthorizationResult | null; error: { message: string } | null }>;
  denyAuthorization(id: string): Promise<{ data: OAuthAuthorizationResult | null; error: { message: string } | null }>;
}
function oauthApi(): SupabaseAuthOAuthApi {
  return (supabase.auth as unknown as { oauth: SupabaseAuthOAuthApi }).oauth;
}

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const authorizationId = params.get('authorization_id') ?? '';
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!authorizationId) return setError('Missing authorization_id');
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        // Preserva a URL de consent COMPLETA — sem isto o connector volta pra `/`.
        const next = window.location.pathname + window.location.search;
        window.location.href = '/auth?next=' + encodeURIComponent(next);
        return;
      }
      const { data, error } = await oauthApi().getAuthorizationDetails(authorizationId);
      if (!active) return;
      if (error) return setError(error.message);
      const immediate = data?.redirect_url ?? data?.redirect_to;
      if (immediate && !data?.client) { window.location.href = immediate; return; }
      setDetails(data);
    })();
    return () => { active = false; };
  }, [authorizationId]);

  async function decide(approve: boolean) {
    setBusy(true);
    const { data, error } = approve
      ? await oauthApi().approveAuthorization(authorizationId)
      : await oauthApi().denyAuthorization(authorizationId);
    if (error) { setBusy(false); return setError(error.message); }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) { setBusy(false); return setError('No redirect returned by the authorization server.'); }
    window.location.href = target;
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-semibold">Não foi possível carregar esta autorização</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </main>
    );
  }

  if (!details) {
    return (
      <main className="min-h-screen bg-background px-4 pt-16">
        <div className="max-w-lg mx-auto">
          <PageSkeleton variant="auto" />
        </div>
      </main>
    );
  }

  const clientName = details.client?.name ?? 'este aplicativo';

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl p-6 space-y-4 shadow-strong">
        <h1 className="text-xl font-semibold">Conectar {clientName} à sua conta</h1>
        <p className="text-sm text-muted-foreground">
          {clientName} poderá usar as ferramentas do Colacor em seu nome. Você pode
          revogar o acesso a qualquer momento.
        </p>
        {details.client?.client_uri && (
          <p className="text-xs text-muted-foreground break-all">{details.client.client_uri}</p>
        )}
        <div className="flex gap-2 pt-2">
          <Button variant="outline" className="flex-1" disabled={busy} onClick={() => decide(false)}>
            Negar
          </Button>
          <Button className="flex-1" disabled={busy} onClick={() => decide(true)}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Aprovar'}
          </Button>
        </div>
      </div>
    </main>
  );
}
