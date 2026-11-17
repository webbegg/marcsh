---
name: brigadev-issue-creation
description: "Trigger: create issue, bug report, feature request. GitHub issues from evidence after a duplicate search."
---

## When to use

Creating, drafting, or triaging a GitHub issue.

## Rules

- Confirm the exact target repository (host and `owner/repo`) with the user before any remote call. A local checkout is not authorization to publish.
- Search for duplicates (open and closed) before drafting. Comment on a confirmed duplicate instead of creating a new issue.
- Use the repository's issue form or template when one exists; preserve its headings and required fields. Never invent answers or tick checkboxes the user has not affirmed.
- Before publishing, scan the exact body for private data: replace private project names, usernames, hostnames, home paths, credentials, and internal addresses with placeholders while keeping the reproduction intact.
- Show the final title, body, and labels to the user and publish only on explicit approval. Publish once; never retry an uncertain result blindly.
- After publishing, read the issue back and report its URL.

## Execution

```bash
REPO=<owner/repo>
gh issue list --repo "$REPO" --state all --search "<query>" --limit 50
ls .github/ISSUE_TEMPLATE 2>/dev/null
gh label list --repo "$REPO" --limit 100
```

1. Describe the report in one sentence and derive the search query.
2. Pick the matching form or template; fill it only from evidence (reproduction steps, observed output, versions).
3. Write the body to a temp file outside the repository (`mktemp`), then:

```bash
gh issue create --repo "$REPO" --title "<title>" --body-file "$BODY_FILE" --label "<label>"
gh issue view <N> --repo "$REPO" --json number,url,title
```

## Bug report body (no template)

```markdown
### What happened
### Expected
### Reproduction
1.
### Environment
### Evidence
```
