import { AUTH_ORIGIN, type HttpSession, type HttpResponse } from "./http.js";
import {
  extractAutoPostForm,
  extractCsrfToken,
  pageLooksLikeCloudflare,
} from "./html.js";
import {
  cookiesFromDecodedArgs,
  decodeRehydrateArgs,
  describeSsoDocument,
  parseSlackSsoDocument,
  redirectFromDecodedArgs,
  ssoRedirectFromHtml,
} from "./sso.js";
import {
  extractTokensFromText,
  mergeCredentials,
  type SlackCredentials,
} from "./extract.js";

const SLACK_AUTH_URLS = [
  "https://app.slack.com/auth?app=client",
  "https://app.slack.com/auth?app=client&return_to=%2Fclient%2FT0266FRGM",
  "https://app.slack.com/auth?app=client&return_to=%2Fclient%2FT0266FRGM&teams=&iframe=1",
  "https://hackclub.enterprise.slack.com/auth?app=client",
];

const COOKIE_URLS = [
  "https://app.slack.com/",
  "https://hackclub.enterprise.slack.com/",
  "https://slack.com/",
  "https://hackclub.slack.com/",
];

const WARMUP_URLS = [
  "https://slack.com/",
  "https://app.slack.com/",
  "https://hackclub.enterprise.slack.com/",
];

function assertNotCloudflare(html: string, where: string): void {
  if (pageLooksLikeCloudflare(html)) {
    throw new Error(`Cloudflare challenge while ${where}`);
  }
}

function isPermissionDenied(page: HttpResponse): boolean {
  return (
    page.status === 403 ||
    /Permission Denied\s*\|\s*Slack/i.test(page.body) ||
    /<title>Permission Denied/i.test(page.body)
  );
}

async function applyDecodedCookies(
  session: HttpSession,
  args: string,
  pageUrl: string,
): Promise<string | null> {
  const decoded = decodeRehydrateArgs(args);
  if (decoded.encoding !== "opaque") {
    process.stderr.write(`SSO args decoded as ${decoded.encoding}\n`);
    if (decoded.value && typeof decoded.value === "object") {
      const keys = Object.keys(decoded.value as object).slice(0, 12);
      if (keys.length) process.stderr.write(`SSO args keys: ${keys.join(",")}\n`);
    }
  }

  for (const cookie of cookiesFromDecodedArgs(decoded.value)) {
    process.stderr.write(`SSO JS set cookie ${cookie.name} (${cookie.value.length} chars)\n`);
    await session.setSlackCookie(cookie.name, cookie.value);
  }

  return redirectFromDecodedArgs(decoded.value, pageUrl);
}

async function withSlackCrumb(
  session: HttpSession,
  url: string,
  fields: Record<string, string>,
): Promise<Record<string, string>> {
  const crumb = (await session.cookieValue(url, "x")) ?? (await session.cookieValue("https://slack.com/", "x"));
  if (!crumb) return fields;
  if (fields.x || fields.crumb) return fields;
  return { ...fields, crumb, x: crumb };
}

async function rehydrateAsBrowser(
  session: HttpSession,
  page: HttpResponse,
): Promise<HttpResponse> {
  const doc = parseSlackSsoDocument(page.body, page.url);
  process.stderr.write(`Slack SSO JS: ${describeSsoDocument(doc)}\n`);

  let fromArgs: string | null = null;
  if (doc.rehydrate) {
    fromArgs = await applyDecodedCookies(session, doc.rehydrate.args, page.url);
    const xoxd = await session.cookieStartingWith("https://slack.com/", "d", "xoxd-");
    if (xoxd && fromArgs) {
      process.stderr.write(`SSO JS redirect from args → ${new URL(fromArgs).origin}${new URL(fromArgs).pathname}\n`);
      return session.follow(await session.get(fromArgs, page.url), page.url);
    }
  }

  const form = doc.form;
  if (form?.fields.args && form.fields.signature) {
    const fields = await withSlackCrumb(session, form.action, form.fields);
    let next = await session.follow(await session.post(form.action, fields, page.url), page.url);
    if (isPermissionDenied(next)) {
      process.stderr.write("Rehydrate form POST was denied; trying JSON POST like Slack's XHR path…\n");
      next = await session.follow(
        await session.postJson(
          form.action,
          { args: fields.args, signature: fields.signature, crumb: fields.crumb, x: fields.x },
          page.url,
        ),
        page.url,
      );
    }
    if (isPermissionDenied(next)) {
      const noJs = new URL(form.action);
      noJs.searchParams.set("nojsmode", "1");
      process.stderr.write("Rehydrate still denied; trying nojsmode GET…\n");
      next = await session.follow(await session.get(noJs.toString(), page.url), page.url);
    }
    return next;
  }

  const redirect = ssoRedirectFromHtml(page.body, page.url);
  if (redirect && redirect !== page.url) {
    return session.follow(await session.get(redirect, page.url), page.url);
  }

  return page;
}

async function followHtmlAndRedirects(
  session: HttpSession,
  start: HttpResponse,
  referer?: string,
): Promise<HttpResponse> {
  let page = await session.follow(start, referer);
  let rehydrated = false;
  for (let i = 0; i < 12; i++) {
    assertNotCloudflare(page.body, `following ${page.url}`);
    const form = extractAutoPostForm(page.body, page.url);
    const isSaml = Boolean(form?.fields.SAMLResponse || form?.fields.SAMLRequest);

    if (isSaml && form) {
      page = await session.follow(await session.post(form.action, form.fields, page.url), page.url);
      continue;
    }

    const before = page.url + page.status + page.body.length;
    if (!rehydrated) {
      const hadRehydrate = /name=["']args["']/i.test(page.body) && /\/sso\/rehydrate/i.test(page.body);
      page = await rehydrateAsBrowser(session, page);
      if (hadRehydrate) rehydrated = true;
    }
    const after = page.url + page.status + page.body.length;
    if (after !== before) continue;

    const redirect = ssoRedirectFromHtml(page.body, page.url);
    if (redirect && redirect !== page.url && !redirect.includes("nojsmode")) {
      page = await session.follow(await session.get(redirect, page.url), page.url);
      continue;
    }

    break;
  }
  return page;
}

async function findXoxd(session: HttpSession): Promise<string | null> {
  for (const url of COOKIE_URLS) {
    const value = await session.cookieStartingWith(url, "d", "xoxd-");
    if (value) return value;
    const raw = await session.cookieValue(url, "d");
    if (raw) return decodeURIComponent(raw);
  }
  return null;
}

export async function slackSso(session: HttpSession): Promise<SlackCredentials> {
  process.stderr.write("Launching Hack Club Slack via SAML…\n");
  for (const url of WARMUP_URLS) {
    await session.follow(await session.get(url));
  }

  const home = await session.follow(await session.get(`${AUTH_ORIGIN}/`));
  const csrf = extractCsrfToken(home.body);

  const posted = await session.post(
    `${AUTH_ORIGIN}/saml/idp_initiated/slack`,
    { authenticity_token: csrf },
    home.url,
  );

  const samlPage = await followHtmlAndRedirects(session, posted, home.url);

  let creds = mergeCredentials(extractTokensFromText(samlPage.body), {
    xoxd: await findXoxd(session),
  });

  for (const url of SLACK_AUTH_URLS) {
    const authPage = await session.follow(await session.get(url, samlPage.url));
    creds = mergeCredentials(creds, extractTokensFromText(authPage.body), {
      xoxd: await findXoxd(session),
    });
    if (creds.xoxc.length && creds.xoxd) break;
  }

  if (!creds.xoxd && !creds.xoxc.length) {
    throw new Error(
      `Slack SSO stopped at ${samlPage.url} without xoxc/xoxd. Hack Club enterprise Slack finishes login in /sso/rehydrate; the HTTP client could not complete that step.`,
    );
  }

  return creds;
}
