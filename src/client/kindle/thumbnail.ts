/** Fixed portrait canvas shared by KPW3/KO3. Fit without cropping, white letterbox, JPEG .85. */
export const THUMBNAIL_SIZE = { width: 330, height: 470 } as const;
export async function makeThumbnail(cover: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(cover)]));
  try {
    const canvas = document.createElement("canvas"); canvas.width = THUMBNAIL_SIZE.width; canvas.height = THUMBNAIL_SIZE.height;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("浏览器无法生成 Kindle 封面缩略图");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height), width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
    ctx.drawImage(bitmap, Math.floor((canvas.width - width) / 2), Math.floor((canvas.height - height) / 2), width, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Kindle 缩略图编码失败")), "image/jpeg", 0.85));
    return new Uint8Array(await blob.arrayBuffer());
  } finally { bitmap.close(); }
}
