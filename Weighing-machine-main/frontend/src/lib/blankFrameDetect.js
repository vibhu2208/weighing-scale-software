/**
 * Client-side blank/grey frame check using a downscaled canvas sample.
 * @param {HTMLImageElement} img
 * @returns {boolean}
 */
export function isBlankPreviewImage(img) {
  if (!img?.naturalWidth || !img?.naturalHeight) return true;

  const width = 72;
  const height = 40;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;

  try {
    ctx.drawImage(img, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    let sum = 0;
    let sumSq = 0;
    const count = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
    }

    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);

    // Solid grey/black/white camera placeholders have very low variance.
    if (variance < 120) return true;
    if (variance < 280 && mean >= 35 && mean <= 220) return true;
    return false;
  } catch {
    return false;
  }
}
