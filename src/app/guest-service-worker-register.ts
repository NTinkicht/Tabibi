// TAB-PWA-1 (#883): registration failures are reported, never swallowed. Only
// the error name is logged so no URL, token or payload can reach the console.
export type ServiceWorkerContainerLike = {
  register: (url: string, options: { scope: string }) => Promise<unknown>;
};

export async function registerGuestServiceWorker(
  container: ServiceWorkerContainerLike | undefined,
  warn: (message: string) => void = console.warn,
): Promise<boolean> {
  if (!container) return false;
  try {
    await container.register('/sw.js', { scope: '/' });
    return true;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    warn(`Guest service worker registration failed: ${name}`);
    return false;
  }
}
