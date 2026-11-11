// Offline stand-in for the playwright package: no browser is started. It records the launch options so the tests
// can check that ig2md asks for headless, no channel and no persistent profile, and serves the embed fixture.
import { readFileSync, writeFileSync } from 'node:fs';

export const calls = [];
const html = readFileSync(new URL('../embed.html', import.meta.url), 'utf8');

export const chromium = {
  async launch(opts) {
    calls.push({ launch: opts });
    return {
      async newContext(copts) {
        calls.push({ newContext: copts });
        return {
          async newPage() {
            return {
              async goto(url) { calls.push({ goto: url }); return { status: () => Number(process.env.FAKE_PW_STATUS || 200) }; },
              async content() { return html; },
              async screenshot({ path }) { writeFileSync(path, 'fake-png'); },
            };
          },
        };
      },
      async close() { calls.push({ close: true }); },
    };
  },
  // Present so a test can prove ig2md never calls it.
  async launchPersistentContext() { calls.push({ persistent: true }); throw new Error('persistent profile requested'); },
};
export default { chromium };
