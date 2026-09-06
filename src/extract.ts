export type SlackTeamToken = {
  teamId: string;
  token: string;
  url?: string;
  name?: string;
  userId?: string;
};

export type SlackCredentials = {
  xoxd: string | null;
  xoxc: string[];
  teams: SlackTeamToken[];
  enterpriseId: string | null;
};

const XOXC_RE = /xoxc-[A-Za-z0-9-]+/g;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectXoxc(value: unknown, found: Set<string>): void {
  if (typeof value === "string" && value.startsWith("xoxc-")) {
    found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectXoxc(item, found);
    return;
  }
  if (isObject(value)) {
    for (const nested of Object.values(value)) collectXoxc(nested, found);
  }
}

function teamFromEntry(teamId: string, team: JsonObject): SlackTeamToken | null {
  const token = readString(team.token);
  if (!token?.startsWith("xoxc-")) return null;
  return {
    teamId: readString(team.id) ?? teamId,
    token,
    url: readString(team.url),
    name: readString(team.name),
    userId: readString(team.user_id) ?? readString(team.userId),
  };
}

export function parseTeamConfig(parsed: unknown): {
  teams: SlackTeamToken[];
  xoxc: string[];
  enterpriseId: string | null;
} {
  const xoxc = new Set<string>();
  const teams: SlackTeamToken[] = [];
  let enterpriseId: string | null = null;

  collectXoxc(parsed, xoxc);

  if (isObject(parsed)) {
    enterpriseId =
      readString(parsed.enterprise_id) ??
      readString(parsed.enterpriseId) ??
      null;

    const maybeTeams = parsed.teams;
    if (isObject(maybeTeams)) {
      for (const [id, team] of Object.entries(maybeTeams)) {
        if (!isObject(team)) continue;
        const entry = teamFromEntry(id, team);
        if (entry) teams.push(entry);
        const enterprise =
          readString(team.enterprise_id) ?? readString(team.enterpriseId);
        if (enterprise) enterpriseId ??= enterprise;
        if (entry?.teamId.startsWith("E")) enterpriseId ??= entry.teamId;
      }
    }
  }

  if (teams.length === 0) {
    for (const token of xoxc) {
      teams.push({ teamId: "unknown", token });
    }
  }

  return { teams, xoxc: [...xoxc], enterpriseId };
}

export function parseLocalConfig(raw: string | null) {
  if (!raw) return { teams: [], xoxc: [] as string[], enterpriseId: null as string | null };
  try {
    return parseTeamConfig(JSON.parse(raw));
  } catch {
    return { teams: [], xoxc: [] as string[], enterpriseId: null as string | null };
  }
}

function extractBalancedObject(source: string, from: number): string | null {
  const start = source.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function parseIncomingConfig(html: string) {
  const markers = [
    "sessionStorage.incomingConfig = JSON.stringify(",
    "sessionStorage.incomingConfig=JSON.stringify(",
  ];
  for (const marker of markers) {
    const index = html.indexOf(marker);
    if (index < 0) continue;
    const json = extractBalancedObject(html, index + marker.length);
    if (!json) continue;
    try {
      return parseTeamConfig(JSON.parse(json));
    } catch {
      continue;
    }
  }
  return { teams: [], xoxc: [] as string[], enterpriseId: null as string | null };
}

export function extractTokensFromText(text: string) {
  const fromConfig = parseIncomingConfig(text);
  const xoxc = new Set(fromConfig.xoxc);
  for (const match of text.match(XOXC_RE) ?? []) xoxc.add(match);

  const apiToken = text.match(/"api_token"\s*:\s*"(xoxc-[^"]+)"/)?.[1];
  if (apiToken) xoxc.add(apiToken);

  const enterpriseFromUrl = text.match(/\/client\/(E[A-Z0-9]+)\b/)?.[1];
  const enterpriseFromJson = text.match(/"enterprise_id"\s*:\s*"(E[A-Z0-9]+)"/)?.[1];

  return {
    xoxc: [...xoxc],
    teams: fromConfig.teams.length
      ? fromConfig.teams
      : [...xoxc].map((token) => ({ teamId: "unknown", token })),
    enterpriseId: fromConfig.enterpriseId ?? enterpriseFromUrl ?? enterpriseFromJson ?? null,
  };
}

export function decodeSlackCookie(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(current)) break;
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

export function mergeCredentials(...parts: Array<Partial<SlackCredentials>>): SlackCredentials {
  const xoxc = new Set<string>();
  const teams: SlackTeamToken[] = [];
  let xoxd: string | null = null;
  let enterpriseId: string | null = null;

  for (const part of parts) {
    if (part.xoxd) xoxd = decodeSlackCookie(part.xoxd);
    if (part.enterpriseId) enterpriseId ??= part.enterpriseId;
    for (const token of part.xoxc ?? []) xoxc.add(token);
    for (const team of part.teams ?? []) {
      if (!teams.some((existing) => existing.token === team.token && existing.teamId === team.teamId)) {
        teams.push(team);
      }
    }
  }

  return { xoxd, xoxc: [...xoxc], teams, enterpriseId };
}

export function maskSecret(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 3)}…`;
  const head = value.startsWith("xox") ? value.slice(0, 5) : value.slice(0, 4);
  return `${head}…${value.slice(-4)}`;
}

export type IdentityInfo = {
  userIds: string[];
  enterpriseId: string | null;
};

export function identityInfo(creds: SlackCredentials): IdentityInfo {
  const userIds: string[] = [];
  for (const team of creds.teams) {
    if (team.userId && !userIds.includes(team.userId)) userIds.push(team.userId);
  }
  return { userIds, enterpriseId: creds.enterpriseId };
}

export type TokenCard = {
  id: string;
  kind: "xoxd" | "xoxc";
  role?: "enterprise" | "workspace";
  title: string;
  value: string;
  details: Array<{ label: string; value: string }>;
};

export function tokenCards(creds: SlackCredentials): TokenCard[] {
  const cards: TokenCard[] = [];
  if (creds.xoxd) {
    cards.push({
      id: "xoxd",
      kind: "xoxd",
      title: "xoxd",
      value: creds.xoxd,
      details: [],
    });
  }

  const named = creds.teams.filter((team) => team.teamId !== "unknown");
  const teams = named.length > 0 ? named : creds.teams;
  for (const team of teams) {
    const role =
      team.teamId.startsWith("E") || team.teamId === creds.enterpriseId ? "enterprise" : "workspace";
    const details: TokenCard["details"] = [];
    if (team.name) details.push({ label: "name", value: team.name });
    if (team.teamId && team.teamId !== "unknown") details.push({ label: "id", value: team.teamId });
    if (team.url) details.push({ label: "url", value: team.url });
    cards.push({
      id: `xoxc-${team.teamId}-${team.token.slice(-8)}`,
      kind: "xoxc",
      role,
      title: `xoxc · ${role}`,
      value: team.token,
      details,
    });
  }
  return cards;
}
