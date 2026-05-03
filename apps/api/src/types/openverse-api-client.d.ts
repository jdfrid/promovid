declare module "@openverse/api-client" {
  export interface OpenverseAudioDetail {
    title: string | null;
    url: string | null;
    creator: string | null;
    license: string;
    license_url: string | null;
    provider: string | null;
    source: string | null;
    filesize: string | null;
    filetype: string | null;
    mature: boolean;
    duration: number | null;
    foreign_landing_url: string | null;
  }

  export interface OpenverseClientOptions {
    baseUrl?: string;
    credentials?: {
      clientId: string;
      clientSecret: string;
    };
  }

  export function OpenverseClient(options?: OpenverseClientOptions): (
    endpoint: "GET v1/audio/",
    request: {
      params: Record<string, unknown>;
    }
  ) => Promise<{
    body: {
      results: OpenverseAudioDetail[];
    };
    meta: {
      status: number;
    };
  }>;
}
