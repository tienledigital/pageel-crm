/// <reference types="astro/client" />

type Runtime = import("@astrojs/cloudflare").Runtime<any>;

declare namespace App {
  interface Locals extends Runtime {
    user?: import("./lib/auth").SessionPayload;
    lang: 'vi' | 'en';
  }
}

declare module 'cloudflare:workers' {
  export const env: any;
}
