import type { CliArgs } from "./args.js";
import { formatCredentials } from "./extract.js";
import { hackclubLogin } from "./hackclub.js";
import { HttpSession } from "./http.js";
import { slackSso } from "./slack.js";

export async function loginAndExtract(args: CliArgs): Promise<void> {
  const session = new HttpSession(args.timeoutMs);
  await hackclubLogin(session, args);
  const creds = await slackSso(session);
  console.log(formatCredentials(creds, args.json));
}
