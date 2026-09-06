import type { HtmlForm } from "./html.js";
import { extractForms, extractRedirectTarget } from "./html.js";

export type SlackSsoDocument = {
  boot: Record<string, unknown> | null;
  scriptSrcs: string[];
  inlineScripts: string[];
  form: HtmlForm | null;
  rehydrate: { args: string; signature: string } | null;
};

export type DecodedArgs = {
  encoding: string;
  value: unknown;
};

const BOOT_RE = /(?:var\s+boot_data|window\.boot_data|boot_data)\s*=\s*/;

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractBalancedObject(source: string, from: number): string | null {
  const start = source.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function parseBootData(html: string): Record<string, unknown> | null {
  const match = html.match(BOOT_RE);
  if (!match || match.index == null) return null;
  const json = extractBalancedObject(html, match.index + match[0].length);
  if (!json) return null;
  const parsed = tryJson(json);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

export function decodeRehydrateArgs(args: string): DecodedArgs {
  const trimmed = args.trim();
  const direct = tryJson(trimmed);
  if (direct !== undefined) return { encoding: "json", value: direct };

  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const text = Buffer.from(trimmed, encoding).toString("utf8");
      if (!text) continue;
      const parsed = tryJson(text);
      if (parsed !== undefined) return { encoding, value: parsed };
      if (text.startsWith("https://")) return { encoding: `${encoding}+url`, value: { url: text } };
    } catch {
      // not valid in this encoding
    }
  }

  return { encoding: "opaque", value: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type SlackCookieToSet = { name: string; value: string };

export function cookiesFromDecodedArgs(value: unknown): SlackCookieToSet[] {
  const found: SlackCookieToSet[] = [];
  const seen = new Set<string>();

  const add = (name: string, raw: unknown) => {
    const text = readString(raw);
    if (!text || seen.has(name)) return;
    if (name === "d" && !text.startsWith("xoxd-")) return;
    if ((name === "b" || name === "x" || name === "d-s") && text.length < 8) return;
    seen.add(name);
    found.push({ name, value: text });
  };

  const walk = (node: unknown, depth = 0): void => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;

    add("d", node.d ?? node.xoxd);
    add("d-s", node["d-s"] ?? node.d_s ?? node.ds);
    add("b", node.b);
    add("x", node.x ?? node.crumb);

    if (isRecord(node.cookies)) {
      for (const [name, cookieValue] of Object.entries(node.cookies)) add(name, cookieValue);
    }
    if (Array.isArray(node.cookies)) {
      for (const cookie of node.cookies) {
        if (!isRecord(cookie)) continue;
        const name = readString(cookie.name) ?? readString(cookie.key);
        const cookieValue = cookie.value ?? cookie.val;
        if (name) add(name, cookieValue);
      }
    }

    for (const nested of Object.values(node)) walk(nested, depth + 1);
  };

  walk(value);
  return found;
}

export function redirectFromDecodedArgs(value: unknown, baseUrl: string): string | null {
  const keys = ["url", "redir", "redirect", "redirect_url", "redirectUrl", "next", "location", "return_to"];
  const candidates: string[] = [];

  const walk = (node: unknown, depth = 0): void => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    for (const key of keys) {
      const text = readString(node[key]);
      if (text) candidates.push(text);
    }
    for (const nested of Object.values(node)) walk(nested, depth + 1);
  };

  walk(value);

  for (const raw of candidates) {
    try {
      const url = new URL(raw, baseUrl);
      if (url.protocol !== "https:") continue;
      if (!url.hostname.endsWith("slack.com")) continue;
      if (url.pathname.includes("/sso/rehydrate") && url.searchParams.has("nojsmode")) continue;
      return url.toString();
    } catch {
      // ignore
    }
  }
  return null;
}

export function parseSlackSsoDocument(html: string, baseUrl: string): SlackSsoDocument {
  const forms = extractForms(html, baseUrl);
  const rehydrateForm =
    forms.find((form) => form.fields.args && form.fields.signature && form.action.includes("/sso/rehydrate")) ??
    forms.find((form) => form.fields.args && form.fields.signature) ??
    null;

  const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) =>
    new URL(match[1]!, baseUrl).toString(),
  );
  const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => match[1] ?? "",
  );

  return {
    boot: parseBootData(html),
    scriptSrcs,
    inlineScripts,
    form: rehydrateForm ?? forms.find((form) => form.method === "post" && Object.keys(form.fields).length > 0) ?? null,
    rehydrate: rehydrateForm
      ? { args: rehydrateForm.fields.args ?? "", signature: rehydrateForm.fields.signature ?? "" }
      : null,
  };
}

export function describeSsoDocument(doc: SlackSsoDocument): string {
  const parts = [
    `scripts=${doc.scriptSrcs.length}`,
    `inline=${doc.inlineScripts.length}`,
    doc.boot ? "boot=1" : "boot=0",
    doc.rehydrate
      ? `rehydrate args=${doc.rehydrate.args.length} sig=${doc.rehydrate.signature.length}`
      : "rehydrate=0",
    doc.form ? `form=${new URL(doc.form.action).pathname}` : "form=0",
  ];
  return parts.join(" ");
}

export function ssoRedirectFromHtml(html: string, baseUrl: string): string | null {
  const fromJs = extractRedirectTarget(html, baseUrl);
  if (fromJs) return fromJs;
  const boot = parseBootData(html);
  if (!boot) return null;
  for (const key of ["redir", "redirect", "signin_url", "abs_root_url", "team_url"]) {
    const value = boot[key];
    if (typeof value === "string" && value.startsWith("https://") && value.includes("slack.com")) {
      return value;
    }
  }
  return null;
}
