// Cloudflare sets request.cf.regionCode to the ISO 3166-2 subdivision without the country ("13" = 東京都).
export function guessRegion(request: Request): { region_code: string | null } {
  const cf = (request as { cf?: { country?: string; regionCode?: string } }).cf;
  const code = cf?.country === 'JP' && /^\d{1,2}$/.test(cf.regionCode ?? '') ? `JP-${cf.regionCode!.padStart(2, '0')}` : null;
  const n = code ? Number(code.slice(3)) : 0;
  return { region_code: n >= 1 && n <= 47 ? code : null };
}
