'use strict';
/**
 * Vite plugin — the drop-in path for a React/Vue/Svelte project.
 *
 *   // vite.config.js
 *   const { visualEditor } = require('visual-dev-editor/vite')
 *   export default { plugins: [react(), visualEditor()] }
 *
 * Three jobs, all dev-only by construction (everything hangs off
 * configureServer / a serve-mode check, so a production build is untouched):
 *
 *   1. Stamp JSX with source locations, so the running DOM can name the exact
 *      source node behind each element.
 *   2. Mount the edit/undo/palette routes on Vite's own middleware stack.
 *   3. Inject the editor client into every served HTML page.
 */

const path = require('path');
const { createEditorMiddleware, INJECT } = require('./server.cjs');
const { stampSource } = require('./stamp.cjs');

function visualEditor(options = {}) {
  const include = options.include || /\.(jsx|tsx)$/;
  let root = options.root ? path.resolve(options.root) : process.cwd();
  let isServe = true;

  return {
    name: 'visual-dev-editor',
    // Must beat the React plugin: once JSX is compiled to createElement calls
    // there is nothing left to stamp.
    enforce: 'pre',

    configResolved(config) {
      if (config) {
        isServe = config.command === 'serve';
        if (!options.root && config.root) root = path.resolve(config.root);
      }
    },

    transform(code, id) {
      if (!isServe) return null;
      const clean = String(id).split('?')[0];
      if (!include.test(clean) || clean.includes('node_modules')) return null;
      const rel = path.relative(root, clean).split(path.sep).join('/');
      const out = stampSource(code, rel || path.basename(clean));
      return out === code ? null : { code: out, map: null };
    },

    configureServer(server) {
      const middleware = createEditorMiddleware({
        root: options.editRoot || root,
        targets: options.targets,
      });
      server.middlewares.use((req, res, next) => middleware(req, res, next));
    },

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!isServe) return html;
        if (html.includes('/__visual-editor/client.js')) return html;
        return html.replace('</body>', INJECT + '</body>');
      },
    },
  };
}

module.exports = { visualEditor };
module.exports.default = visualEditor;
