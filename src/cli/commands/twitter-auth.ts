import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

export function twitterAuthCommand(): Command {
  return new Command('twitter-auth')
    .description('Authenticate with Twitter/X and save cookies for ingestion')
    .option('--env-file <path>', 'Path to .env file', '.env')
    .action(async (opts) => {
      const { envFile } = opts as { envFile: string };
      const envPath = resolve(process.cwd(), envFile);

      // Dynamic import — playwright is an optional dependency
      let playwright: typeof import('playwright');
      try {
        playwright = await import('playwright');
      } catch {
        console.error('Playwright is required for twitter-auth. Install it with:');
        console.error('  npm install playwright');
        console.error('  npx playwright install chromium');
        process.exitCode = 1;
        return;
      }

      const { mkdtempSync, rmSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      // Use a persistent temp profile so Twitter remembers the browser
      // across auth attempts (reduces anti-bot friction)
      const profileDir = mkdtempSync(join(tmpdir(), 'brainifai-twitter-auth-'));

      console.log('Opening Twitter login page...');
      console.log('Please log in manually. The browser will close automatically after login.');
      console.log('(Timeout: 5 minutes)');
      console.log('');

      const context = await playwright.chromium.launchPersistentContext(profileDir, {
        headless: false,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
        ],
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      const page = context.pages()[0] ?? await context.newPage();

      try {
        await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });

        // Poll for auth_token cookie — indicates successful login
        const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
        const POLL_INTERVAL_MS = 1000;
        const start = Date.now();

        let authenticated = false;
        while (Date.now() - start < LOGIN_TIMEOUT_MS) {
          // Use setTimeout instead of page.waitForTimeout to avoid
          // crashing if the page/context closes during polling
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

          try {
            const cookies = await context.cookies('https://x.com');
            const hasAuth = cookies.some((c) => c.name === 'auth_token');
            const hasCt0 = cookies.some((c) => c.name === 'ct0');

            if (hasAuth && hasCt0) {
              authenticated = true;
              break;
            }
          } catch {
            // Context may have been closed by user — exit gracefully
            break;
          }
        }

        if (!authenticated) {
          console.error('Error: login timed out or browser was closed.');
          process.exitCode = 1;
          return;
        }

        // Extract all cookies from x.com
        const cookies = await context.cookies('https://x.com');

        // Format as cookie header string: "name1=value1; name2=value2"
        const cookieString = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');

        console.log(`Extracted ${cookies.length} cookies from x.com`);

        // Write TWITTER_COOKIES to .env file
        await upsertEnvVar(envPath, 'TWITTER_COOKIES', cookieString);

        console.log('');
        console.log(`TWITTER_COOKIES saved to ${envPath}`);
        console.log('You can now run Twitter ingestion.');
      } finally {
        try { await context.close(); } catch { /* already closed */ }
        try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
}

/**
 * Insert or replace an env var in a .env file.
 * Preserves all other variables and comments.
 */
async function upsertEnvVar(filePath: string, key: string, value: string): Promise<void> {
  let content = '';
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    // File doesn't exist yet — will be created
  }

  // Escape any single quotes in the value and wrap in single quotes
  // to handle special chars like semicolons
  const escapedValue = value.replace(/'/g, "'\\''");
  const newLine = `${key}='${escapedValue}'`;

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, newLine);
  } else {
    // Append with a newline separator
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
    content += newLine + '\n';
  }

  await writeFile(filePath, content, 'utf-8');
}
