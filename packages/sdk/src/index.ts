export type ShareVisibility = 'unlisted' | 'restricted' | 'public';
export type ShareFormat = 'html' | 'markdown' | 'json' | 'archive';

export interface ShareClientOptions {
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ShareAccess {
  capability?: string;
  agentLinkId?: string;
  agentSecret?: string;
  bearerToken?: string;
}

export interface ShareSummary {
  id: string;
  title: string;
  visibility: ShareVisibility;
  status: 'active' | 'revoked' | 'deleting' | 'deleted' | 'takedown';
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export class ShareClient {
  private readonly apiUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: ShareClientOptions = {}) {
    this.apiUrl = (options.apiUrl || 'https://api.neurcode.com').replace(/\/+$/, '');
    this.fetcher = options.fetch || globalThis.fetch;
    if (!this.fetcher) throw new Error('A Fetch API implementation is required.');
  }

  async fetch(
    shareId: string,
    format: ShareFormat,
    access: ShareAccess = {},
  ): Promise<Uint8Array> {
    if (!/^shr_[A-Za-z0-9_-]{20,26}$/.test(shareId)) throw new Error('Invalid Cut ID.');
    const suffix = format === 'html' ? '' : `/${format}`;
    const headers: Record<string, string> = {};
    if (access.bearerToken) headers.authorization = `Bearer ${access.bearerToken}`;
    if (access.capability) headers['x-share-capability'] = access.capability;
    if (access.agentLinkId) headers['x-share-agent-link'] = access.agentLinkId;
    if (access.agentSecret) headers['x-share-agent-secret'] = access.agentSecret;
    if (format !== 'html') headers['x-neurcode-share-consumer'] = 'agent';
    const response = await this.fetcher(
      `${this.apiUrl}/api/v1/shares/${encodeURIComponent(shareId)}${suffix}`,
      { headers },
    );
    if (!response.ok) {
      let message = `Cut request failed (${response.status}).`;
      try {
        const body = await response.json() as { message?: unknown };
        if (typeof body.message === 'string') message = body.message;
      } catch {}
      throw new Error(message);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async list(bearerToken: string, view: 'created' | 'received' = 'created'): Promise<ShareSummary[]> {
    const response = await this.fetcher(
      `${this.apiUrl}/api/v1/share/library?view=${view}`,
      { headers: { authorization: `Bearer ${bearerToken}` } },
    );
    if (!response.ok) throw new Error(`Cut library request failed (${response.status}).`);
    const body = await response.json() as { items?: ShareSummary[] };
    return Array.isArray(body.items) ? body.items : [];
  }
}
