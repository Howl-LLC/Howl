// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
const ALLOWED_REDIRECT_DOMAINS: ReadonlySet<string> = new Set([
  'checkout.stripe.com',
  'billing.stripe.com',
]);

export function isValidRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_REDIRECT_DOMAINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function isSafeOriginUrl(url: string, origin: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin;
  } catch {
    return false;
  }
}

const VALID_HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const VALID_CSS_FUNC = /^(rgb|rgba|hsl|hsla)\(\s*[\d.,\s%]+\)$/;
const VALID_CSS_VAR = /^var\(--[a-zA-Z0-9-]+\)$/;
const CSS_NAMED_COLORS: ReadonlySet<string> = new Set([
  'aliceblue','antiquewhite','aqua','aquamarine','azure','beige','bisque','black',
  'blanchedalmond','blue','blueviolet','brown','burlywood','cadetblue','chartreuse',
  'chocolate','coral','cornflowerblue','cornsilk','crimson','cyan','darkblue',
  'darkcyan','darkgoldenrod','darkgray','darkgreen','darkgrey','darkkhaki',
  'darkmagenta','darkolivegreen','darkorange','darkorchid','darkred','darksalmon',
  'darkseagreen','darkslateblue','darkslategray','darkslategrey','darkturquoise',
  'darkviolet','deeppink','deepskyblue','dimgray','dimgrey','dodgerblue','firebrick',
  'floralwhite','forestgreen','fuchsia','gainsboro','ghostwhite','gold','goldenrod',
  'gray','green','greenyellow','grey','honeydew','hotpink','indianred','indigo',
  'ivory','khaki','lavender','lavenderblush','lawngreen','lemonchiffon','lightblue',
  'lightcoral','lightcyan','lightgoldenrodyellow','lightgray','lightgreen','lightgrey',
  'lightpink','lightsalmon','lightseagreen','lightskyblue','lightslategray',
  'lightslategrey','lightsteelblue','lightyellow','lime','limegreen','linen','magenta',
  'maroon','mediumaquamarine','mediumblue','mediumorchid','mediumpurple',
  'mediumseagreen','mediumslateblue','mediumspringgreen','mediumturquoise',
  'mediumvioletred','midnightblue','mintcream','mistyrose','moccasin','navajowhite',
  'navy','oldlace','olive','olivedrab','orange','orangered','orchid','palegoldenrod',
  'palegreen','paleturquoise','palevioletred','papayawhip','peachpuff','peru','pink',
  'plum','powderblue','purple','rebeccapurple','red','rosybrown','royalblue',
  'saddlebrown','salmon','sandybrown','seagreen','seashell','sienna','silver',
  'skyblue','slateblue','slategray','slategrey','snow','springgreen','steelblue',
  'tan','teal','thistle','tomato','turquoise','violet','wheat','white','whitesmoke',
  'yellow','yellowgreen','transparent','currentcolor','inherit',
]);

export function isValidCssColor(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return (
    VALID_HEX_COLOR.test(trimmed) ||
    VALID_CSS_FUNC.test(trimmed) ||
    VALID_CSS_VAR.test(trimmed) ||
    CSS_NAMED_COLORS.has(trimmed.toLowerCase())
  );
}

/**
 * Append a hex-alpha suffix to a validated color.
 * Only works reliably with hex colors (#RGB or #RRGGBB).
 * For other color formats, falls back to `transparent`.
 */
export function colorWithAlpha(color: string | null | undefined, alphaHex: string): string {
  if (!color || !isValidCssColor(color)) return 'transparent';
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return `${trimmed}${alphaHex}`;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) return `${trimmed}${alphaHex}`;
  // Non-hex validated colors: use color-mix for proper alpha
  return `color-mix(in srgb, ${trimmed} ${Math.round(parseInt(alphaHex, 16) / 255 * 100)}%, transparent)`;
}

export function sanitizeCssUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    const escaped = trimmed.replace(/["\\()]/g, '');
    return `url("${escaped}")`;
  } catch {
    return undefined;
  }
}

const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function isValidYouTubeId(id: string | null): boolean {
  if (!id) return false;
  return YT_ID_RE.test(id);
}

export function sanitizeTitle(text: string): string {
  return text.replace(/[<>"'&]/g, '').slice(0, 100);
}
