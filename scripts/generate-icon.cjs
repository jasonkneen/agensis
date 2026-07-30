// Rasterizes public/icon-512.svg into build/icon.png at 1024x1024 so
// electron-builder can derive every platform icon (.icns / .ico / png set)
// from a single source. Run automatically before `electron-builder` in CI
// and locally via `npm run electron:dist`.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repoRoot = path.join(__dirname, '..');
const svgPath = path.join(repoRoot, 'public', 'icon-512.svg');
const outDir = path.join(repoRoot, 'build');
const outPath = path.join(outDir, 'icon.png');

fs.mkdirSync(outDir, { recursive: true });

sharp(svgPath, { density: 512 })
  .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(outPath)
  .then(() => {
    console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
  })
  .catch((err) => {
    console.error('Failed to generate icon:', err);
    process.exit(1);
  });
