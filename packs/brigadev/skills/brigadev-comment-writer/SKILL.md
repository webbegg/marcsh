---
name: brigadev-comment-writer
description: "Trigger: PR feedback, review comment, issue reply, team message. Short, warm, direct comments."
---

## When to use

Any comment another human will read: PR or issue comments, review feedback, maintainer replies, async team updates.

## Voice

| Rule | Requirement |
| --- | --- |
| Useful fast | Lead with the actionable point; do not recap the PR first. |
| Warm and direct | A thoughtful teammate, not a corporate bot. |
| Short | 1–3 short paragraphs or a tight bullet list. |
| Explain why | Give the technical reason when asking for a change. |
| No pile-ons | Comment on the highest-value issues, not every preference. |
| Target language | Write in the thread's language; the user's explicit request wins. Neutral, professional tone by default. |
| No em dashes | Use commas, periods, or parentheses. |

## Formula

```text
<direct observation or request>

<why it matters, only if needed>

<concrete next action>
```

## Examples

```markdown
Good approach overall. I'd move the validation into its own commit, since it is mixed with the UI wiring here.

That keeps the review focused and makes a rollback cleaner if the integration fails.
```

```markdown
Approved. Scope is clear and the change is well contained.
```

Show drafts to the user before posting. Posting is an outward-facing action and needs their approval.
