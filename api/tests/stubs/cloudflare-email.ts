// Stand-in for the Workers-only "cloudflare:email" module (aliased in vitest.config.ts).
export class EmailMessage {
  constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
}
