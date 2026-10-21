const IMAGE_FORMATS = {
  png: { fileName: "image.png", contentType: "image/png" },
  jpg: { fileName: "image.jpg", contentType: "image/jpeg" },
  gif: { fileName: "image.gif", contentType: "image/gif" },
  webp: { fileName: "image.webp", contentType: "image/webp" },
}

/** 每次发送独立持有临时素材，覆盖转换失败和被动转主动发送的整个生命周期。 */
export function createMaterialScope (data) {
  const images = new Map()
  return {
    async uploadImage (buffer, type) {
      const format = IMAGE_FORMATS[type]
      if (!format) throw new Error("Markdown 图片素材仅支持 PNG、JPEG、GIF 和 WebP")
      const service = (data.bot || Bot[data.self_id])?.sdk?.materialService
      if (!service) throw new Error("当前 QQBot SDK 不支持图片素材管理，请更新内置 SDK")

      const image = await service.uploadImage(buffer, format)
      // 即使后续响应校验或消息转换失败，也必须回收已经创建的素材。
      if (image?.image_id) images.set(image.image_id, service)
      if (!image?.image_id || !image.url?.startsWith("qqbot-media://"))
        throw new Error("图片素材上传响应缺少 image_id 或 qqbot-media:// 引用")
      return image
    },
    async cleanup () {
      for (const [imageId, service] of images) {
        try {
          await service.deleteImage(imageId)
        } catch (err) {
          Bot.makeLog("error", ["删除临时图片素材失败", imageId, err], data.self_id)
        }
      }
      images.clear()
    },
  }
}
