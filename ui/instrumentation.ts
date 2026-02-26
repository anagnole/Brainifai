export async function register() {
  // Only initialise in the Node.js runtime (not Edge), and only once
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/scheduler')
    startScheduler()
  }
}
