// Nitro 3's Vite builder currently requires a JavaScript entry even for its
// static presets. Netlify never executes this module; the checked-in redirect
// map and the files in dist/ remain the production request path.
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
