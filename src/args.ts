export type CliArgs = {
  email: string | null;
  help: boolean;
  backupCode: string | null;
  timeoutMs: number;
};

export function printUsage(): void {
  console.log(`Usage: hc-slack-auth [email] [options]

Sign into auth.hackclub.com, complete 2FA, SSO into Hack Club Slack,
then copy or save xoxc/xoxd tokens.

This command is interactive and must be run in a terminal.

Arguments:
  email                 Hack Club Auth account email (prompted if omitted)

Options:
  --backup-code <code>  2FA backup code
  --timeout <seconds>   Request timeout (default: 90)
  -h, --help            Show this help

During login, press l to expand logs. After login: c copy, e save to env, q quit.
`);
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    email: null,
    help: false,
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
      case "--backup-code":
        args.backupCode = next();
        break;
      case "--timeout":
        args.timeoutMs = Number(next()) * 1000;
        if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
          throw new Error("--timeout must be a positive number of seconds");
        }
        break;
      case "--code":
      case "--totp":
      case "--json":
        throw new Error(`${arg} was removed; this command is interactive-only`);
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
