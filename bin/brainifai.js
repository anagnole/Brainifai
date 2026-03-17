#!/usr/bin/env node
process.env.LOG_LEVEL = 'silent';
await import('../dist/cli/index.js');
// Force clean exit before Kuzu native cleanup can segfault
process.exit(process.exitCode ?? 0);
