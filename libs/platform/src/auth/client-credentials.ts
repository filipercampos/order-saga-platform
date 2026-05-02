/** Supplies bearer tokens for service-to-service calls. */
export interface TokenProvider {
  token(): Promise<string>;
  /** Drop the cached token (e.g. after a 401). */
  invalidate(): void;
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly value: string) {}
  token(): Promise<string> {
    return Promise.resolve(this.value);
  }
  invalidate(): void {}
}

export interface ClientCredentialsOptions {
  /** Cognito domain token endpoint: https://<domain>.auth.<region>.amazoncognito.com/oauth2/token */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  fetch?: typeof fetch;
  now?: () => number;
}

const REFRESH_MARGIN_MS = 60_000;

/**
 * OAuth2 client credentials grant (M2M) against the Cognito token endpoint. Tokens are
 * cached until shortly before expiry and concurrent callers share one in-flight request,
 * so a burst of messages does not become a burst of token requests (Cognito bills and
 * throttles them).
 */
export class ClientCredentialsTokenProvider implements TokenProvider {
  private cached: { value: string; expiresAt: number } | undefined;
  private inFlight: Promise<string> | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ClientCredentialsOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > this.now()) {
      return Promise.resolve(this.cached.value);
    }
    this.inFlight ??= this.fetchToken().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString(
      'base64',
    );
    const response = await this.fetchFn(this.options.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: this.options.scopes.join(' '),
      }).toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`token endpoint returned ${response.status}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.cached = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}
