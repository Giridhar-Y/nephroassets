import { useEffect, useRef, useState } from "react";
import { fetchGoogleSsoConfig } from "../api/client.js";
import { useAuth } from "../lib/AuthContext.js";

// Google Identity Services' own type isn't worth pulling in a whole @types package for
// — this is the only file that touches it, and only these two calls are used.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (resp: { credential: string }) => void }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

// Loaded at most once per page load no matter how many times this component mounts.
let gsiScriptPromise: Promise<void> | null = null;
function loadGsiScript(): Promise<void> {
  if (!gsiScriptPromise) {
    gsiScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GSI_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Google Sign-In script."));
      document.head.appendChild(script);
    });
  }
  return gsiScriptPromise;
}

/** Renders nothing until the server confirms Google Sign-In is actually configured
 *  (GOOGLE_CLIENT_ID/GOOGLE_WORKSPACE_DOMAIN — see server/.env.example) — IT can turn
 *  this on later purely via server environment, no client build needed either way. */
export function GoogleSignInButton({ onError }: { onError: (message: string) => void }) {
  const { loginWithGoogle } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const [clientId, setClientId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGoogleSsoConfig()
      .then((config) => {
        if (!cancelled && config.enabled && config.clientId) setClientId(config.clientId);
      })
      .catch(() => {
        // Feature is optional — a failed config lookup just means no button, not a
        // broken login page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Runs only once `clientId` is set, which is also what gates the container div below
  // into existence — containerRef.current has to already be mounted for renderButton to
  // have somewhere to render into.
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    loadGsiScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (resp) => {
            const result = await loginWithGoogle(resp.credential);
            if (!result.ok) onError(result.error);
          }
        });
        window.google.accounts.id.renderButton(containerRef.current, { theme: "outline", size: "large", width: 300 });
      })
      .catch(() => onError("Couldn't load Google Sign-In. Please use your password instead."));
    return () => {
      cancelled = true;
    };
  }, [clientId, loginWithGoogle, onError]);

  if (!clientId) return null;

  return (
    <div className="mt-4 border-t border-gray-100 pt-4">
      <div ref={containerRef} className="flex justify-center" />
    </div>
  );
}
