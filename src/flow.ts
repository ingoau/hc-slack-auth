import type { CliArgs } from "./args.js";
import { formatCredentials, type SlackCredentials } from "./extract.js";
import { hackclubLogin } from "./hackclub.js";
import { HttpSession } from "./http.js";
import { slackSso } from "./slack.js";

export async function loginAndExtract(args: CliArgs): Promise<SlackCredentials> {
  const session = new HttpSession(args.timeoutMs);
  await hackclubLogin(session, args);
  return slackSso(session);
}

export function printCredentials(creds: SlackCredentials, asJson: boolean): void {
  console.log(formatCredentials(creds, asJson));
}
