// An example notify command for presence.mjs. Configure it as:
//   "notify": { "command": ["node", "/absolute/path/to/notify-example.mjs"], "on": ["away", "present", "waiting"] }
// presence.mjs appends the event (away | present | waiting) to argv and sets PRESENCE_EVENT and PRESENCE_TEXT.
// Replace the body with a call to your own notifier (a desktop toast, a self-hosted push service, a chat webhook).
// This one only records the call: to the file named by NOTIFY_LOG if set, otherwise to stderr.
import fs from 'node:fs';

const line = JSON.stringify({ argv: process.argv.slice(2), event: process.env.PRESENCE_EVENT, text: process.env.PRESENCE_TEXT }) + '\n';
if (process.env.NOTIFY_LOG) fs.appendFileSync(process.env.NOTIFY_LOG, line);
else process.stderr.write(line);
