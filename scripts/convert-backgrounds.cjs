const sharp = require('sharp');
const path = require('path');
const files = ['download-21','download-22','download-24','download-25','download-26','download-27','download-28'];
(async () => {
  for (const name of files) {
    const src = path.join(__dirname, '..', 'images', `${name}.jpg`);
    const out = path.join(__dirname, '..', 'images', `${name}.webp`);
    await sharp(src).resize({ width: 1920, withoutEnlargement: true }).webp({ quality: 72 }).toFile(out);
    console.log(name, 'done');
  }
})();
