import type { CliArgs } from "./args.js";
import type { SlackCredentials } from "./extract.js";
import { hackclubLogin } from "./hackclub.js";
import { HttpSession } from "./http.js";
import { slackSso } from "./slack.js";

export async function loginAndExtract(args: CliArgs): Promise<SlackCredentials> {
  const session = new HttpSession(args.timeoutMs);
  await hackclubLogin(session, args);
  return slackSso(session);
}
