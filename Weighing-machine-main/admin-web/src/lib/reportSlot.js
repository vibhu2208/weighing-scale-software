/**
 * Report photo-cell geometry from the production slip template.
 * Source: admin-api/src/services/vehicleReportHtml.js
 *   .photo-cell { flex: 1; height: 120px; }
 *   .photo-cell img { width: 100%; height: 100%; object-fit: cover; }
 * Matching copy: backend/utils/reportPdfHtml.js
 * A4 8.27in at 96 CSS px, 12mm @page margin, 16px body padding and 24px
 * report padding leaves ~201px per cell in a 3-column row with 10px gaps.
 */
export const REPORT_PHOTO_SLOT = {
  width: 200,
  height: 120,
  objectFit: 'cover',
  columns: 3,
};

export function reportSlotCoverCrop(imageWidth, imageHeight, slot = REPORT_PHOTO_SLOT) {
  const width = Number(imageWidth);
  const height = Number(imageHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { axis: 'none', croppedFraction: 0, warning: false };
  }
  const imageAspect = width / height;
  const slotAspect = slot.width / slot.height;
  if (imageAspect > slotAspect) {
    const visible = slotAspect / imageAspect;
    const croppedFraction = Math.max(0, 1 - visible);
    return {
      axis: 'horizontal',
      croppedFraction,
      warning: croppedFraction > 0.08,
    };
  }
  const visible = imageAspect / slotAspect;
  const croppedFraction = Math.max(0, 1 - visible);
  return {
    axis: 'vertical',
    croppedFraction,
    warning: croppedFraction > 0.08,
  };
}
