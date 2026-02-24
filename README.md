# Brainifai

A Personal Knowledge Graph (PKG) that grows automatically from your daily tools and lets you query it through Claude.

Data flows in from your tools (Slack and GitHub), lands in a local Neo4j graph, and is exposed to Claude Desktop via an MCP server. Ask Claude natural-language questions and it fetches grounded context from your actual activity — people, topics, conversations, pull requests.

---

## How it works

```
Slack API / GitHub API
   ↓  fetch messages, PRs, comments, reviews (paginated, incremental)
Ingestion script
   ↓  normalize → Person, Activity, Topic, Container nodes
   ↓  MERGE into Neo4j (idempotent, re-run safe)
   ↓  cursor per channel/repo (only fetches new data next run)
Neo4j (Docker, local)
   ↑  Cypher: fulltext search, time windows, graph traversal
MCP Server (stdio)
   ↑  4 curated tools — no raw Cypher exposed to Claude
Claude Desktop
```

### The graph model

Everything is **Entities** + **Activities**.

| Node | Unique key | What it represents |
|------|-----------|-------------------|
| `Person` | `person_key` (e.g. `slack:U12345`, `github:octocat`) | A human across sources |
| `Activity` | `(source, source_id)` | A single message/PR/comment/review |
| `Topic` | `name` (lowercase) | A keyword, hashtag, or GitHub label |
| `Container` | `(source, container_id)` | A Slack channel or GitHub repository |
| `SourceAccount` | `(source, account_id)` | A tool-specific identity, linked to Person |
| `Cursor` | `(source, container_id)` | Tracks ingestion progress per channel/repo |

Relationships: `(SourceAccount)-[:OWNS]->(Activity)`, `(Activity)-[:FROM]->(Person)`, `(Activity)-[:IN]->(Container)`, `(Activity)-[:MENTIONS]->(Topic)`

### Incremental ingestion

On first run, ingestion backfills the last `BACKFILL_DAYS` (default: 7) of data per source. On every subsequent run it fetches only data newer than the last cursor. Cursors live in Neo4j — if you wipe the database, they reset and a clean backfill happens automatically.

Both Slack and GitHub are optional — each is skipped if its token is not set in `.env`.

### MCP tools

| Tool | What it does |
|------|-------------|
| `get_context_packet` | **Primary tool.** Given a query, finds matching entities (anchors), gathers structural facts, pulls recent evidence. Returns a bounded JSON payload. |
| `search_entities` | Fulltext search across Person, Topic, Container nodes. |
| `get_entity_summary` | Activity count, most recent activity, top connections for one entity. |
| `get_recent_activity` | Time-windowed activity feed, filterable by person/topic/channel. |

Safety limits are always enforced: max 20 evidence items, max 8,000 chars total, 10s query timeout.

### Topic extraction

Topics are extracted from every message/PR body two ways:
1. **Hashtags** — `#deploy`, `#incident`, etc.
2. **GitHub labels** — label names are automatically added as topics.
3. **Allowlist matching** — configurable list of keywords (case-insensitive). Set via `TOPIC_ALLOWLIST` in `.env`.

---

## Setup

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Node.js](https://nodejs.org/) 20+
- A Slack workspace where you can create apps (optional)
- A GitHub personal access token (optional)

### 1. Clone and install

```bash
git clone <repo-url>
cd Brainifai
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `NEO4J_URI` | Yes | Bolt connection URI (default: `bolt://localhost:7687`) |
| `NEO4J_USER` | Yes | Neo4j username (default: `neo4j`) |
| `NEO4J_PASSWORD` | Yes | Neo4j password |
| `SLACK_BOT_TOKEN` | No | Slack bot token (`xoxb-...`) |
| `SLACK_CHANNEL_IDS` | No | Comma-separated Slack channel IDs to ingest |
| `GITHUB_TOKEN` | No | GitHub personal access token (`ghp_...`) |
| `GITHUB_REPOS` | No | Comma-separated repos to ingest (`owner/repo,owner/repo2`) |
| `BACKFILL_DAYS` | No | Days to backfill on first run (default: `7`) |
| `TOPIC_ALLOWLIST` | No | Comma-separated keywords for topic extraction |

### 3. Set up Slack (optional)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch
2. **OAuth & Permissions** → **Bot Token Scopes** → add:
   - `channels:history` — read message history
   - `channels:read` — read channel info
3. **Install to Workspace** → copy the `xoxb-...` Bot User OAuth Token into `.env`
4. Invite the bot to each channel: `/invite @your-bot-name`
5. Get channel IDs: open a channel in Slack → click the channel name → copy the ID at the bottom of the modal

### 4. Set up GitHub (optional)

1. Go to GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. Generate a new token with scopes:
   - `repo` (private repos) or `public_repo` (public repos only)
   - `read:user`
3. Paste the token into `.env` as `GITHUB_TOKEN`
4. Set `GITHUB_REPOS` to the repos you want to ingest (e.g. `myorg/api,myorg/frontend`)

### 5. Start Neo4j

```bash
docker compose up -d
npm run test-connection    # should print "Connected to Neo4j"
```

To view the graph in a browser: open [http://localhost:7474](http://localhost:7474) and log in with your Neo4j credentials.

### 6. Create the schema

```bash
npm run schema
```

This creates uniqueness constraints and the fulltext search index. Safe to re-run.

### 7. Run ingestion

```bash
npm run ingest
```

Output looks like:
```
Slack #general: ingested 142 messages
Slack #engineering: ingested 87 messages
GitHub anagnole/myrepo: ingested 12 PRs, 34 comments
Ingestion complete
```

Re-run anytime — only new data is fetched.

---

## Querying the graph

### Neo4j browser (localhost:7474)

```cypher
-- See all PRs from a GitHub user
MATCH (p:Person {person_key: "github:octocat"})<-[:FROM]-(a:Activity)
RETURN a ORDER BY a.timestamp DESC LIMIT 20

-- See what topics are discussed in a channel
MATCH (c:Container {container_id: "C1234567"})<-[:IN]-(a:Activity)-[:MENTIONS]->(t:Topic)
RETURN t.name, count(*) AS mentions ORDER BY mentions DESC

-- See who talks about a topic
MATCH (t:Topic {name: "deploy"})<-[:MENTIONS]-(a:Activity)-[:FROM]->(p:Person)
RETURN p.person_key, count(*) AS count ORDER BY count DESC

-- Full graph overview (small dataset)
MATCH (n) RETURN n LIMIT 100
```

### Via Claude Desktop (MCP)

Configure in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "brainifai": {
      "command": "npx",
      "args": ["tsx", "src/mcp/index.ts"],
      "cwd": "/absolute/path/to/Brainifai",
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "your-password"
      }
    }
  }
}
```

Restart Claude Desktop. Example queries:

> *"What has the team been discussing about deployments this week?"*
> *"Who are the most active people in #engineering?"*
> *"What PRs have been merged in myrepo recently?"*
> *"Get a context packet for the incident we had last Friday"*
> *"Search for anyone named Alice in the knowledge graph"*

---

## Commands reference

```bash
docker compose up -d        # Start Neo4j
docker compose down         # Stop Neo4j (data persists in volume)
docker compose down -v      # Stop + wipe all data (triggers fresh backfill on next ingest)

npm run test-connection     # Verify Neo4j connectivity
npm run schema              # Create/update constraints and indexes
npm run ingest              # Fetch new data from all configured sources
npm run mcp                 # Start MCP server (used by Claude Desktop)

npx tsc --noEmit            # Type check
```

---

## Project structure

```
src/
  shared/           Neo4j driver, canonical types, schema, constants
  ingestion/
    slack/          Slack connector (client, config, types)
    github/         GitHub connector (client, config, types, normalize)
    normalize.ts    Slack message normalizer
    topic-extractor.ts
    upsert.ts       Source-agnostic MERGE-based upsert
    cursor.ts       Incremental ingestion state
    index.ts        Ingestion entry point (Slack + GitHub)
  mcp/              MCP server, 4 tools, backing Cypher queries, safety limits
  scripts/          One-off utilities (test-connection, seed-schema)
tasks/
  todo.md           Build progress tracker
  lessons.md        Captured corrections and patterns
docker-compose.yml
.env.example
```

---

## Adding more data sources

The ingestion pipeline is designed to support multiple sources. To add a new integration (e.g. Linear, Notion, Google Calendar):

1. Create `src/ingestion/<source>/` mirroring the `github/` structure: `types.ts`, `config.ts`, `client.ts`, `normalize.ts`
2. Map your source's data to the canonical types in `src/shared/types.ts` — specifically `NormalizedMessage`
3. Use the same `upsertBatch()` and `setCursor()` functions — the schema is fully source-agnostic
4. Add a guarded block in `src/ingestion/index.ts` (check for the token env var before running)

The graph model handles multi-source identity naturally: one `Person` node can have multiple `SourceAccount` nodes pointing to it (e.g. Slack identity + GitHub identity).
