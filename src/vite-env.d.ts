/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the Colyseus multiplayer server (e.g. ws://localhost:2567). */
  readonly VITE_MULTIPLAYER_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.glb?url" {
  const src: string;
  export default src;
}
