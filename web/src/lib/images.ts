export interface PreparedPhoto {
  full: Blob;
  thumb: Blob;
  /** Object URL of the thumbnail; revoke it when the photo is no longer shown. */
  previewUrl: string;
}

const FULL_SIZE = 1600;
const THUMB_SIZE = 400;

function scaledCanvas(source: CanvasImageSource, width: number, height: number, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't process photos.");
  context.imageSmoothingQuality = "high";
  // Transparent PNGs would otherwise turn black as JPEGs.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("That photo couldn't be processed."))),
      "image/jpeg",
      quality,
    ),
  );
}

/**
 * Shrinks a photo on the phone before upload. Re-encoding through a canvas also drops all metadata,
 * including GPS location, so the server never receives it.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`"${file.name}" couldn't be read. Try a JPEG or PNG photo.`);
  }
  try {
    const fullCanvas = scaledCanvas(bitmap, bitmap.width, bitmap.height, FULL_SIZE);
    const thumbCanvas = scaledCanvas(fullCanvas, fullCanvas.width, fullCanvas.height, THUMB_SIZE);
    const [full, thumb] = await Promise.all([toJpeg(fullCanvas, 0.82), toJpeg(thumbCanvas, 0.78)]);
    return { full, thumb, previewUrl: URL.createObjectURL(thumb) };
  } finally {
    bitmap.close();
  }
}
