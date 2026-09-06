export function extractInputValue(html: string, name: string): string | null {
  const pattern = new RegExp(
    `<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']|<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`,
    "i",
  );
  const match = html.match(pattern);
  return match?.[1] ?? match?.[2] ?? null;
}

export function extractCsrfToken(html: string): string {
  const meta = html.match(
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i,
  );
  if (meta?.[1]) return meta[1];
  const fromInput = extractInputValue(html, "authenticity_token");
  if (fromInput) return fromInput;
  throw new Error("could not find CSRF token on the page");
}

export function extractFlashError(html: string): string | null {
  const match = html.match(/class="[^"]*flash[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/i);
  if (!match?.[1]) return null;
  return match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null;
}

export type HtmlForm = {
  action: string;
  method: "get" | "post";
  fields: Record<string, string>;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gi, "&");
}

function attr(attrs: string, name: string): string | undefined {
  const quoted = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  if (quoted) return decodeHtmlEntities(quoted[1]!);
  const unquoted = attrs.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"));
  return unquoted?.[1] ? decodeHtmlEntities(unquoted[1]) : undefined;
}

export function extractForms(html: string, baseUrl: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let formMatch: RegExpExecArray | null;
  while ((formMatch = formRe.exec(html))) {
    const attrs = formMatch[1] ?? "";
    const inner = formMatch[2] ?? "";
    const fields: Record<string, string> = {};
    const inputRe = /<input\b([^>]*)>/gi;
    let inputMatch: RegExpExecArray | null;
    while ((inputMatch = inputRe.exec(inner))) {
      const inputAttrs = inputMatch[1] ?? "";
      const name = attr(inputAttrs, "name");
      if (!name) continue;
      const type = attr(inputAttrs, "type")?.toLowerCase();
      if (type === "submit" || type === "button") continue;
      fields[name] = attr(inputAttrs, "value") ?? "";
    }
    const textareaRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
    let textareaMatch: RegExpExecArray | null;
    while ((textareaMatch = textareaRe.exec(inner))) {
      const name = attr(textareaMatch[1] ?? "", "name");
      if (!name) continue;
      fields[name] = decodeHtmlEntities(textareaMatch[2] ?? "");
    }
    forms.push({
      action: new URL(attr(attrs, "action") || baseUrl, baseUrl).toString(),
      method: attr(attrs, "method")?.toLowerCase() === "get" ? "get" : "post",
      fields,
    });
  }
  return forms;
}

export function extractAutoPostForm(html: string, baseUrl: string): HtmlForm | null {
  const forms = extractForms(html, baseUrl);
  return (
    forms.find((form) => "SAMLResponse" in form.fields || "SAMLRequest" in form.fields) ??
    forms.find((form) => Object.keys(form.fields).length > 0 && form.method === "post") ??
    null
  );
}

export function pageLooksLikeCloudflare(html: string): boolean {
  return /Just a moment|cf-browser-verification|Checking your browser before accessing|Enable JavaScript and cookies to continue/i.test(
    html,
  ) && !/authenticity_token/i.test(html);
}

export function extractTitle(html: string): string {
  return html.match(/<title>([^<]+)/i)?.[1]?.trim() ?? "";
}

function cleanRedirectRaw(raw: string): string {
  return raw
    .trim()
    .replace(/^\\+/, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\\\//g, "/");
}

export function extractRedirectTarget(html: string, baseUrl: string): string | null {
  const candidates: string[] = [];
  const patterns = [
    /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/gi,
    /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=\\?["']?([^"'>\s]+)/gi,
    /(?:window|document)\.location(?:\.href)?\s*=\s*["']([^"']+)["']/gi,
    /location\.replace\(["']([^"']+)["']\)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      const raw = cleanRedirectRaw(match[1] ?? "");
      if (!raw) continue;
      try {
        const url = new URL(raw, baseUrl);
        if (url.protocol !== "https:") continue;
        if (!url.hostname.endsWith("slack.com") && !url.hostname.endsWith("hackclub.com")) continue;
        if (url.hostname === "sso") continue;
        candidates.push(url.toString());
      } catch {
        // ignore malformed redirects
      }
    }
  }
  return (
    candidates.find((url) => url.includes("app.slack.com") && !url.includes("nojsmode")) ??
    candidates.find((url) => url.includes("app.slack.com")) ??
    candidates.find((url) => !url.includes("nojsmode")) ??
    candidates[0] ??
    null
  );
}

export function pathOf(url: string): string {
  return new URL(url).pathname;
}
