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
import { log, status } from "./ui.js";

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

function invalidCodeMessage(flash: string | null): string {
  if (flash && /invalid|incorrect|wrong|expired/i.test(flash)) return flash;
  if (flash) return flash;
  return "Invalid code, try again";
}

export async function hackclubLogin(session: HttpSession, args: CliArgs): Promise<void> {
  const email = args.email!;
  let page = await loadLoginPage(session);
  const csrf = extractCsrfToken(page.body);

  status(`Signing in as ${email}…`);
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

  let skippedPasskey = false;
  if (pathOf(page.url).includes("/webauthn")) {
    skippedPasskey = true;
    log("Passkey is configured on this account; switching to email login");
    status("Passkey is configured; switching to email login…");
    page = await skipPasskey(session, page.url, page.body);
  }

  page = await completeFactors(session, page, {
    email,
    backupCode: args.backupCode,
    skippedPasskey,
  });

  if (pathOf(page.url) === "/" || pathOf(page.url) === "") {
    status("Signed into Hack Club Auth");
    return;
  }

  throw new Error(`login did not finish (ended at ${page.url})`);
}

export async function hackclubLogout(session: HttpSession): Promise<void> {
  status("Signing out of Hack Club Auth…");
  const home = await session.follow(await session.get(`${AUTH_ORIGIN}/`));
  const csrf = extractCsrfToken(home.body);
  await session.follow(
    await session.post(
      `${AUTH_ORIGIN}/logout`,
      { authenticity_token: csrf, _method: "delete" },
      home.url,
    ),
    home.url,
  );
  log("Signed out of Hack Club Auth");
}

async function completeFactors(
  session: HttpSession,
  start: Awaited<ReturnType<HttpSession["get"]>>,
  ctx: { email: string; backupCode: string | null; skippedPasskey: boolean },
) {
  let page = start;
  let lastEmailFailed = false;
  let lastTotpFailed = false;

  for (let attempt = 0; attempt < 8; attempt++) {
    const path = pathOf(page.url);
    const flash = extractFlashError(page.body);
    if (flash) log(flash);

    if (path === "/" || path === "") return page;

    if (path.includes("/totp")) {
      status("Waiting for TOTP code");
      const code = digitsOnly(
        await prompt("TOTP code", {
          hint: "Enter the code from your authenticator app",
          error: flash || lastTotpFailed ? invalidCodeMessage(flash) : undefined,
        }),
      );
      const csrf = extractCsrfToken(page.body);
      status("Verifying TOTP…");
      page = await session.follow(
        await session.post(page.url, { authenticity_token: csrf, code, commit: "Verify →" }, page.url),
        page.url,
      );
      lastTotpFailed = true;
      continue;
    }

    if (path.includes("/backup_code")) {
      status("Waiting for backup code");
      const code =
        ctx.backupCode ??
        (await prompt("Backup code", {
          error: flash ? invalidCodeMessage(flash) : undefined,
        }));
      ctx.backupCode = null;
      const csrf = extractCsrfToken(page.body);
      status("Verifying backup code…");
      page = await session.follow(
        await session.post(page.url, { authenticity_token: csrf, code }, page.url),
        page.url,
      );
      continue;
    }

    if (path.includes("/webauthn")) {
      ctx.skippedPasskey = true;
      log("Passkey is configured on this account; switching to email login");
      status("Passkey is configured; switching to email login…");
      page = await skipPasskey(session, page.url, page.body);
      continue;
    }

    if (/^\/login\/[^/]+(\/verify)?$/.test(path)) {
      status("Waiting for email login code");
      const hints = [
        ctx.skippedPasskey
          ? "This account has a passkey configured; using email login instead."
          : null,
        `A login code was sent to ${ctx.email}.`,
      ].filter((line): line is string => Boolean(line));
      const code = digitsOnly(
        await prompt("Email login code", {
          hint: hints.join("\n"),
          error: flash || lastEmailFailed ? invalidCodeMessage(flash) : undefined,
        }),
      );
      const csrf = extractCsrfToken(page.body);
      const attemptUrl = page.url.replace(/\/verify\/?$/, "");
      const verifyUrl = `${attemptUrl.replace(/\/$/, "")}/verify`;
      status("Verifying email code…");
      page = await session.follow(
        await session.post(
          verifyUrl,
          { authenticity_token: csrf, code, commit: "Verify →" },
          page.url,
        ),
        page.url,
      );
      lastEmailFailed = true;
      continue;
    }

    throw new Error(`unexpected login page: ${page.url}`);
  }

  throw new Error("could not complete Hack Club Auth 2FA");
}
