import { Cookie, CookieJar } from "tough-cookie";
import { request as undiciRequest } from "undici";
import { log } from "./ui.js";

export const AUTH_ORIGIN = "https://auth.hackclub.com";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CHROME_HINTS: Record<string, string> = {
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Upgrade-Insecure-Requests": "1",
};

export type HttpResponse = {
  url: string;
  status: number;
  headers: Headers;
  body: string;
};

function joinUrl(from: string, location: string): string {
  return new URL(location, from).toString();
}

function headerList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function fetchSite(referer: string | undefined, url: string): string {
  if (!referer) return "none";
  try {
    const from = new URL(referer);
    const to = new URL(url);
    if (from.origin === to.origin) return "same-origin";
    const slack = (host: string) => host === "slack.com" || host.endsWith(".slack.com");
    if (slack(from.hostname) && slack(to.hostname)) return "same-site";
    return "cross-site";
  } catch {
    return "none";
  }
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const canonical = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === canonical) delete headers[key];
  }
  headers[canonical] = value;
}

function normalizeSetCookie(header: string): string {
  return header.replace(/;\s*Partitioned(?:=[^;]*)?/gi, "");
}

export class HttpSession {
  readonly jar = new CookieJar(undefined, { looseMode: true });

  constructor(private readonly timeoutMs: number) {}

  async ingestCookies(url: string, setCookies: string[]): Promise<string[]> {
    const stored: string[] = [];
    for (const raw of setCookies) {
      const header = normalizeSetCookie(raw);
      const name = header.split("=")[0]?.trim() ?? "?";
      try {
        const parsed = Cookie.parse(header, { loose: true });
        if (parsed) {
          await this.jar.setCookie(parsed, url, { ignoreError: true });
          stored.push(name);
          continue;
        }
      } catch {
        // fall through to a host-only cookie
      }
      const match = header.match(/^([^=;\s]+)=([^;]*)/);
      if (!match) continue;
      try {
        const fallback = new Cookie({
          key: match[1]!,
          value: match[2] ?? "",
          path: "/",
          secure: true,
        });
        await this.jar.setCookie(fallback, url, { ignoreError: true });
        stored.push(name);
      } catch {
        // Slack sometimes sets cookies we still cannot store.
      }
    }
    return stored;
  }

  async setSlackCookie(name: string, value: string): Promise<void> {
    for (const url of [
      "https://slack.com/",
      "https://app.slack.com/",
      "https://hackclub.enterprise.slack.com/",
    ]) {
      const cookie = new Cookie({
        key: name,
        value,
        domain: "slack.com",
        path: "/",
        secure: true,
        hostOnly: false,
      });
      await this.jar.setCookie(cookie, url, { ignoreError: true });
    }
  }

  async cookieNames(url: string): Promise<string[]> {
    const cookies = await this.jar.getCookies(url);
    return cookies.map((cookie) => cookie.key);
  }

  async request(
    url: string,
    init: RequestInit & { body?: string | URLSearchParams; referer?: string } = {},
  ): Promise<HttpResponse> {
    const cookie = await this.jar.getCookieString(url);
    const headers: Record<string, string> = {};
    setHeader(headers, "User-Agent", USER_AGENT);
    setHeader(headers, "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
    setHeader(headers, "Accept-Language", "en-US,en;q=0.9");
    for (const [name, value] of Object.entries(CHROME_HINTS)) setHeader(headers, name, value);
    setHeader(headers, "Sec-Fetch-Dest", "document");
    setHeader(headers, "Sec-Fetch-Mode", "navigate");
    setHeader(headers, "Sec-Fetch-Site", fetchSite(init.referer, url));
    new Headers(init.headers).forEach((value, key) => {
      if (key.toLowerCase() === "referer") return;
      setHeader(headers, key, value);
    });
    if (init.referer) {
      setHeader(headers, "Referer", init.referer);
      setHeader(headers, "Sec-Fetch-Site", fetchSite(init.referer, url));
    }
    if (cookie) setHeader(headers, "Cookie", cookie);

    let body: string | undefined;
    if (init.body instanceof URLSearchParams) {
      body = init.body.toString();
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        setHeader(headers, "Content-Type", "application/x-www-form-urlencoded");
      }
    } else if (typeof init.body === "string") {
      body = init.body;
    }

    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST") setHeader(headers, "Sec-Fetch-User", "?1");

    const { statusCode, headers: rawHeaders, body: rawBody } = await undiciRequest(url, {
      method,
      headers,
      body,
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });

    const stored = await this.ingestCookies(url, headerList(rawHeaders["set-cookie"]));
    const parsed = new URL(url);
    log(`${method} ${parsed.host}${parsed.pathname} → ${statusCode}`);
    if (stored.length) {
      log(`cookies ${parsed.host}: ${stored.join(",")}`);
    }

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (value == null || key === "set-cookie") continue;
      for (const item of headerList(value)) responseHeaders.append(key, item);
    }

    return {
      url,
      status: statusCode,
      headers: responseHeaders,
      body: await rawBody.text(),
    };
  }

  async get(url: string, referer?: string): Promise<HttpResponse> {
    return this.request(url, { method: "GET", referer });
  }

  async post(
    url: string,
    fields: Record<string, string>,
    referer?: string,
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = {};
    if (referer) headers.Origin = new URL(referer).origin;
    return this.request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(fields),
      referer,
    });
  }

  async postJson(url: string, payload: unknown, referer?: string): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/html;q=0.9,*/*;q=0.8",
      "Content-Type": "application/json",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
    };
    if (referer) headers.Origin = new URL(referer).origin;
    return this.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      referer,
    });
  }

  async follow(response: HttpResponse, referer?: string): Promise<HttpResponse> {
    let current = response;
    for (let i = 0; i < 20; i++) {
      if (![301, 302, 303, 307, 308].includes(current.status)) {
        return current;
      }
      const location = current.headers.get("location");
      if (!location) return current;
      const nextUrl = joinUrl(current.url, location);
      const preserveMethod = current.status === 307 || current.status === 308;
      current = preserveMethod
        ? await this.request(nextUrl, {
            method: "POST",
            referer: referer ?? current.url,
          })
        : await this.get(nextUrl, referer ?? current.url);
    }
    throw new Error("too many redirects");
  }

  async cookieValue(url: string, name: string): Promise<string | null> {
    const cookies = await this.jar.getCookies(url);
    return cookies.find((cookie) => cookie.key === name)?.value ?? null;
  }

  async cookieStartingWith(url: string, name: string, prefix: string): Promise<string | null> {
    const cookies = await this.jar.getCookies(url);
    return (
      cookies.find((cookie) => cookie.key === name && cookie.value.startsWith(prefix))?.value ??
      null
    );
  }
}
