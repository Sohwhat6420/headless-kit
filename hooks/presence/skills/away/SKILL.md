---
name: away
description: Mark the user as away in every Claude Code session on this machine. Work carries on using best guesses, and each decision that was theirs is logged to the away backlog for /back to review.
argument-hint: "[optional last instructions]"
disable-model-invocation: true
---
The presence hook has normally flipped the switch already, because it reads this command as the user's prompt. Confirm it (this is safe to run twice):

```
node "${CLAUDE_SKILL_DIR}/../../presence.mjs" set away --said "/away $ARGUMENTS" --session "${CLAUDE_SESSION_ID}"
```

If that path does not exist, use the presence CLI path shown in this session's `[presence]` line.

Then, while the user is away:

1. **Their message comes first.** If the arguments ($ARGUMENTS) contain instructions or questions, carry them out or answer them before ending the turn. Never just echo them back.
2. **Keep working.** Where a decision is theirs, pick the most likely answer yourself and build on it. Do not stop to wait for them.
3. **Log every such decision** to the away backlog, so they can review it when they return:

   ```
   node "${CLAUDE_SKILL_DIR}/../../presence.mjs" ask --session "${CLAUDE_SESSION_ID}" \
     --question "<the question, answerable on its own>" \
     --context "<enough context to answer it cold>" \
     --assumed "<the answer you went with>" \
     --built "<what you built on it: files, commits>" \
     --reverse "<exactly how to undo it>"
   ```

   Other sessions add their own entries to the same backlog.
4. **Never act on a guess for anything that cannot be undone:** spending money, publishing, sending messages on the user's behalf, deleting their data, anything involving credentials. Log those with `--waiting` and leave them for the user.

End with the presence line and, at most, two lines answering anything they asked.
