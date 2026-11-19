/** Formats the vision backends accept. Identify bytes instead of trusting a clipboard MIME label. */
export function imageMimeType(bytes: Uint8Array): string | undefined {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (starts(255, 216, 255)) return "image/jpeg";
  if (starts(71, 73, 70, 56) && [55, 57].includes(bytes[4]) && bytes[5] === 97) return "image/gif";
  if (starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
}

export const isImageFileName = (name: string): boolean => /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i.test(name);
