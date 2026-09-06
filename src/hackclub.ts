import { randomBytes } from "node:crypto";
import type { CliArgs } from "./args.js";
import { AUTH_ORIGIN, type HttpSession } from "./http.js";
import {
  extractCsrfToken,
  extractFlashError,
  pageLooksLikeCloudflare,
  pathOf,
} from "./html.js";
import { digitsOnly, prompt } from "./prompt.js";

function fingerprint(): string {
  return randomBytes(16).toString("hex");
}

function timezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function assertNotCloudflare(html: string): void {
  if (pageLooksLikeCloudflare(html)) {
    throw new Error("auth.hackclub.com returned a Cloudflare challenge; try again");
  }
}

async function loadLoginPage(session: HttpSession) {
  const page = await session.follow(await session.get(`${AUTH_ORIGIN}/login`));
  assertNotCloudflare(page.body);
  return page;
}

async function skipPasskey(session: HttpSession, pageUrl: string, html: string) {
  const csrf = extractCsrfToken(html);
  const skipUrl = pageUrl.replace(/\/webauthn\/?$/, "") + "/webauthn/skip";
  return session.follow(await session.post(skipUrl, { authenticity_token: csrf }, pageUrl), pageUrl);
}

export async function hackclubLogin(session: HttpSession, args: CliArgs): Promise<void> {
  const email = args.email!;
  let page = await loadLoginPage(session);
  const csrf = extractCsrfToken(page.body);

  process.stderr.write(`Signing in as ${email}…\n`);
  page = await session.follow(
    await session.post(
      `${AUTH_ORIGIN}/login`,
      {
        authenticity_token: csrf,
        email,
        fingerprint: fingerprint(),
        timezone: timezone(),
        commit: "Continue →",
      },
      page.url,
    ),
    page.url,
  );
  assertNotCloudflare(page.body);

  if (pathOf(page.url).startsWith("/signup")) {
    throw new Error(`no Hack Club Auth account exists for ${email}`);
  }

  if (pathOf(page.url).includes("/webauthn")) {
    process.stderr.write("Passkey is enabled; falling back to an email code…\n");
    page = await skipPasskey(session, page.url, page.body);
  }

  page = await completeFactors(session, page, args);

  if (pathOf(page.url) === "/" || pathOf(page.url) === "") {
    return;
  }

  throw new Error(`login did not finish (ended at ${page.url})`);
}

async function completeFactors(
  session: HttpSession,
  start: Awaited<ReturnType<HttpSession["get"]>>,
  args: CliArgs,
) {
  let page = start;

  for (let attempt = 0; attempt < 6; attempt++) {
    const path = pathOf(page.url);
    const flash = extractFlashError(page.body);
    if (flash) process.stderr.write(`${flash}\n`);

    if (path === "/" || path === "") return page;

    if (path.includes("/totp")) {
      const code = digitsOnly(args.totp ?? (await prompt("TOTP code: ")));
      const csrf = extractCsrfToken(page.body);
      page = await session.follow(
        await session.post(page.url, { authenticity_token: csrf, code, commit: "Verify →" }, page.url),
        page.url,
      );
      continue;
    }

    if (path.includes("/backup_code")) {
      const code = args.backupCode ?? (await prompt("Backup code: "));
      const csrf = extractCsrfToken(page.body);
      page = await session.follow(
        await session.post(page.url, { authenticity_token: csrf, code }, page.url),
        page.url,
      );
      continue;
    }

    if (path.includes("/webauthn")) {
      page = await skipPasskey(session, page.url, page.body);
      continue;
    }

    if (/^\/login\/[^/]+(\/verify)?$/.test(path)) {
      const code = digitsOnly(args.code ?? (await prompt("Email login code: ")));
      const csrf = extractCsrfToken(page.body);
      const attemptUrl = page.url.replace(/\/verify\/?$/, "");
      const verifyUrl = `${attemptUrl.replace(/\/$/, "")}/verify`;
      page = await session.follow(
        await session.post(
          verifyUrl,
          { authenticity_token: csrf, code, commit: "Verify →" },
          page.url,
        ),
        page.url,
      );
      continue;
    }

    throw new Error(`unexpected login page: ${page.url}`);
  }

  throw new Error("could not complete Hack Club Auth 2FA");
}
