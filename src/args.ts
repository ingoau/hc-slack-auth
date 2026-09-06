export type CliArgs = {
  email: string | null;
  help: boolean;
  json: boolean;
  code: string | null;
  totp: string | null;
  backupCode: string | null;
  timeoutMs: number;
};

export function printUsage(): void {
  console.log(`Usage: hc-slack-auth <email> [options]

Sign into auth.hackclub.com, complete email/TOTP/passkey/backup 2FA,
SSO into Hack Club Slack, then print xoxc and xoxd tokens.

Arguments:
  email                 Hack Club Auth account email

Options:
  --code <code>         Email login code (skips the prompt)
  --totp <code>         Authenticator TOTP code
  --backup-code <code>  2FA backup code
  --json                Print tokens as JSON
  --timeout <seconds>   Request timeout (default: 90)
  -h, --help            Show this help

In a TTY, progress uses a compact spinner. Press ctrl+e to expand logs.
If .env or .env.* files are present, you can append SLACK_XOXD, SLACK_TEAM_XOXC,
and SLACK_ENTERPRISE_XOXC without overwriting existing values.
`);
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    email: null,
    help: false,
    json: false,
    code: null,
    totp: null,
    backupCode: null,
    timeoutMs: 90_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`missing value for ${arg}`);
      }
      return value;
    };

    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--code":
        args.code = next();
        break;
      case "--totp":
        args.totp = next();
        break;
      case "--backup-code":
        args.backupCode = next();
        break;
      case "--timeout":
        args.timeoutMs = Number(next()) * 1000;
        if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
          throw new Error("--timeout must be a positive number of seconds");
        }
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`unknown option: ${arg}`);
        }
        if (args.email) {
          throw new Error("only one email is allowed");
        }
        args.email = arg;
    }
  }

  return args;
}
