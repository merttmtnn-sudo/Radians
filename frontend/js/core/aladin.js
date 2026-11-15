// Aladin Lite (CDS, Strasbourg; GPL-3.0), loaded once for the whole site: the Map and the "wider
// sky" view of the Blink viewer share it. One CDN can be down or blocked, so a second one stands
// behind it, and every try has a time limit; the caller shows a message with a retry if both fail.
const VERSION = '3.6.5';
export const ALADIN_SOURCES = [
  `https://cdn.jsdelivr.net/npm/aladin-lite@${VERSION}/dist/aladin.js`,
  `https://unpkg.com/aladin-lite@${VERSION}/dist/aladin.js`,
];

// Options every view of the site wants: Aladin's own usage ping and its default survey both go to
// CDS servers, which some networks block (it then throws in the console and shows nothing useful).
export const QUIET = { log: false };

let loading = null;

/** window.A, ready to use. Rejects when no source answers; calling again tries again. */
export function loadAladin(timeoutMs = 9000) {
  if (window.A) return Promise.resolve(window.A);
  if (!loading) {
    loading = (async () => {
      let last = new Error('Aladin Lite could not be loaded');
      for (const url of ALADIN_SOURCES) {
        try {
          const mod = await Promise.race([
            import(url),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs)),
          ]);
          await mod.default.init;
          window.A = mod.default;
          return window.A;
        } catch (e) { last = e; }
      }
      throw last;
    })();
    loading.catch(() => { loading = null; });        // a later call may find the network back
  }
  return loading;
}
