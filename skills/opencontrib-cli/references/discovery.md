# Discovery Commands

Commands for finding, scoring, and qualifying contribution opportunities.

## `scout <target>`

Discover high-value, unclaimed contribution opportunities for a repository or organization.

```bash
opencontrib scout facebook/react
opencontrib scout facebook/react --tech-stack typescript,react --limit 5
opencontrib scout bytedance --focus bugfix,testing --min-stars 100
opencontrib scout --help
```

| Flag | Type | Default | Description |
| ------ | ------ | --------- | ------------- |
| `<target>` | string | — | Repo full name (`owner/repo`) or org name |
| `--tech-stack` | list | `typescript,javascript` | Comma-separated developer tech stack |
| `--focus` | list | `bugfix,testing,docs` | Comma-separated focus areas |
| `--limit` | number | `5` | Max candidates to return |
| `--min-stars` | number | `50` (repo) / `100` (org) | Minimum repository stars |
| `--token` | string | `GITHUB_TOKEN` env | GitHub token |
| `--pretty` | flag | false | Pretty-print output |

**Output**: `{"status":"success","target":"...","foundCount":N,"opportunities":[...]}`

---

## `discovery rank`

Rank a single opportunity by multi-dimensional probability signals.

```bash
cat <<'JSON' | opencontrib discovery rank
{
  "issue": {
    "number": 42,
    "title": "Null pointer in parser module",
    "body": "...",
    "labels": ["bug", "parser"],
    "createdAt": "2026-01-15T00:00:00Z",
    "commentsCount": 3,
    "isOpen": true,
    "assigneesCount": 0
  },
  "repo": {
    "fullName": "facebook/react",
    "stars": 220000,
    "primaryLanguage": "TypeScript"
  },
  "developerProfile": {
    "techStack": ["typescript", "react"],
    "focusAreas": ["bugfix"]
  }
}
JSON
```

**Required fields**: `issue` (object with `number`, `title` at minimum).

---

## `discovery qualify`

Check author-first-right, anti-bandwagoning, and blocking labels for an issue.

```bash
cat <<'JSON' | opencontrib discovery qualify
{
  "issueNumber": 42,
  "issueTitle": "Fix NPE in parser",
  "issueBody": "...",
  "labels": ["bug"],
  "isOpen": true,
  "assignees": [],
  "createdAt": "2026-01-15T00:00:00Z",
  "comments": []
}
JSON
```

**Output**: `{"status":"qualified","qualification":{...}}` or `{"status":"disqualified",...}`

---

## `discovery feasibility`

Assess OS and toolchain execution feasibility for an issue.

```bash
opencontrib discovery feasibility \
  --title "Null pointer in parser module" \
  --body "..." \
  --labels bug,parser
```

**Output**: `{"status":"success","assessment":{"level":"fully_feasible",...},...}`

---

## `discovery context`

Assemble multi-dimensional context combining issue problem, repo skeleton, target test files, and reading order.

```bash
cat <<'JSON' | opencontrib discovery context
{
  "issue": {
    "number": 42,
    "title": "Fix NPE",
    "body": "...",
    "labels": ["bug"]
  },
  "repoDetails": {
    "owner": "facebook",
    "repo": "react",
    "defaultBranch": "main"
  },
  "repoTree": [
    {"path": "src/Parser.ts", "type": "blob"},
    {"path": "test/Parser.test.ts", "type": "blob"}
  ]
}
JSON
```

---

## `discovery manifests`

Diagnose repo manifest files (workflows, package.json, pyproject.toml, etc.) for ≤100-line PR improvements.

```bash
cat <<'JSON' | opencontrib discovery manifests
{
  "workflows": [
    {"path": ".github/workflows/ci.yml", "content": "uses: actions/checkout@v3"}
  ],
  "pyprojectContent": "# no ruff configured",
  "dependabotContent": ""
}
JSON
```

**Output**: `{"status":"success","suggestionsCount":N,"suggestions":[...]}`

---

## LLM Agent Tips

- `scout` is the only discovery command that requires a GitHub token. All others work offline with provided data.
- Feed `scout` results directly into `discovery qualify` or `discovery rank`:

```bash
# Rank opportunity signals:
opencontrib scout facebook/react --limit 3 | jq -r '.opportunities[0]' | \
  opencontrib discovery rank

# Assess environment feasibility:
opencontrib discovery feasibility \
  --title "Null pointer in parser module" \
  --body "Unhandled edge case on empty input" \
  --labels bug,parser
```

- `discovery rank` and `discovery qualify` expect JSON from `gh issue view` output — adapt fields accordingly.
