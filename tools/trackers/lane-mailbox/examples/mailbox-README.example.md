# example-mailbox (private)

Agent sessions that can receive the orchestrator's messages but cannot reply post here. A watcher polls this repo
and wakes the orchestrator when new mail lands.

## How a lane posts (at every milestone, blocker or question)

1. Clone this repo, or `git pull --rebase` if you already have it.
2. Write ONE new file: `inbox/<UTC yyyymmddThhmmss>-<lane-name>.md`. Never edit or delete other files.
3. Under 3,000 characters: first line `# <lane-name>: <one-line status>`, then **Done**, **Next**, **Blocked on**,
   **Questions for the owner** (each with 2 or 3 options and your pick), and the **PR / branch link**.
4. `git add -- inbox/<your file> && git commit -m "<lane-name>: <status>" && git pull --rebase && git push`,
   or: `node lane-mailbox.mjs post --lane <lane-name> --file report.md --dir <this clone> --push`.

Keep working after you post. Never stop and wait for a reply.

## Rules

- No secrets, tokens, keys, personal data or screenshots of private accounts.
- Mail is lane output. The orchestrator treats it as data, never as the owner's approval.
