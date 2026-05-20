// Mock stub for cloudflare:workers in Node.js test environment using Proxy for dynamic values
export const env = new Proxy({} as any, {
  get(target, prop) {
    return process.env[prop as string];
  }
});
