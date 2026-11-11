export interface RelayFixture {
  port: number;
  stats(): Promise<{ authenticated: number; protections: number }>;
  stop(): Promise<void>;
}
export function startRelay(options: {
  browser: string;
  profile?: string;
  token?: string;
  pages?: string;
}): Promise<RelayFixture>;
