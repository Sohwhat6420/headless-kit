---
name: back
description: Mark the user as back in every Claude Code session on this machine, then walk through the away backlog with them, reversing anything they answer differently.
disable-model-invocation: true
---
Typing /back has normally flipped the switch already, because the presence hook reads this command as the user's prompt. Confirm it (safe to run twice):

```
node "${CLAUDE_SKILL_DIR}/../../presence.mjs" set present --said "/back $ARGUMENTS" --session "${CLAUDE_SESSION_ID}"
```

If that path does not exist, use the presence CLI path shown in this session's `[presence]` line.

Then review the backlog with the user:

1. List what is waiting: `node "${CLAUDE_SKILL_DIR}/../../presence.mjs" backlog`. It prints one JSON object whose `items` hold every `waiting` entry first, then every `open` one, oldest first.
2. Ask the user about each entry in chat, `waiting` entries first. In Claude Code use AskUserQuestion, at most four questions per call, and keep going until every entry has been asked.
   - Give each question its context in one or two lines, and say: "I went ahead with X (built: ...); answering differently means I reverse it."
   - Offer the answer you assumed as the first option, marked "(already built)".
   - A `waiting` entry was not acted on: say so, and ask for the go-ahead or the answer.
3. For each answer:
   - It matches the assumption: `node "${CLAUDE_SKILL_DIR}/../../presence.mjs" resolve <id> --as confirmed`.
   - It differs: undo what was built using the entry's `reverse` steps (or pass them to the session that built it), build the user's version, then `resolve <id> --as reversed --answer "<their answer>"`, and tell them in one line what was undone.
   - A `waiting` entry they answer: act on it, then `resolve <id> --as answered --answer "<their answer>"`.
4. Reply with the presence line and a short tally: confirmed, reversed, answered, still waiting.
