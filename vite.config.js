import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    // Wallet extensions commonly scope content-script injection to https:// pages only —
    // this gives the dev server a local self-signed cert so window.yours actually shows up.
    basicSsl(),
    // js-1sat-ord (and its deps) assume a Node runtime (Buffer, etc.) — polyfill those for the browser.
    nodePolyfills(),
  ],
  build: {
    rollupOptions: {
      input: 'mint.html',
    },
  },
});
