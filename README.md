Disclaimer: this codebase (and part of this readme) is entirely AI generated, use at your own risk

# hc-slack-auth

A simple CLI to generate Slack tokens from your Hack Club account. Useful for grabbing creds for a selfbot.

It signs into [Hack Club Auth](https://auth.hackclub.com), completes 2FA in the terminal, SSO's into Hack Club Slack, then displays the `xoxc` / `xoxd` tokens.

```bash
git clone https://github.com/ingoau/hc-slack-auth.git
cd hc-slack-auth
npm install
npm start
```

During login, `l` expands logs. After login you get a token page:


| key                 | what it does                         |
| ------------------- | ------------------------------------ |
| `j` / `k` or arrows | move                                 |
| `c`                 | copy selected (tokens, user, or org) |
| `C`                 | copy all tokens as env lines         |
| `e`                 | save selected token to an env file   |
| `E`                 | save all tokens                      |
| `v`                 | show / hide values                   |
| `q`                 | quit                                 |


`e` / `E` look for `.env` / `.env.*` in the current directory (skipping example/sample/template files). If none exist, it offers to create `.env`. Same values are left alone; a different value asks **Replace `SLACK_XOXD` in `.env`?** with a diff (default: skip).

Writes:

```
SLACK_XOXD=…
SLACK_TEAM_XOXC=…          # T… workspace
SLACK_ENTERPRISE_XOXC=…    # E… org
```

These are your Slack session cookies - Treat them like a password.

Then it signs out of Hack Club Auth so leftover HCA sessions don't pile up.