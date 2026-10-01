/**
 * A picture shrunk to a small square data URL, which is what an assistant's
 * row stores: it is streamed to every browser, so it has to stay a few
 * kilobytes, whatever size the photo was.
 */
export async function shrinkAvatar(file: File, size = 160): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('That file is not an image the browser can read.'))
      element.src = url
    })
    // Cover the square: crop the longer side, centred.
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')!
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side,
      0, 0, size, size
    )
    const webp = canvas.toDataURL('image/webp', 0.85)
    // Safari before 16 answers PNG for a type it cannot encode.
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}
