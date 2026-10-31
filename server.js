"use strict"

const fs = require("fs")
const http = require("http")
const path = require("path")

let sharp
try {
  sharp = require("sharp")
} catch {
  console.warn("[CDN] 'sharp' not loaded, resizing disabled.")
}

let S3rver
try {
  S3rver = require("s3rver")
} catch {
  console.warn("[CDN] 's3rver' not loaded, local S3 API disabled.")
}

try {
  process.loadEnvFile(path.join(__dirname, ".env"))
} catch (error) {
  // .env isteğe bağlı
}

const ROOT = path.resolve(process.env.CDN_DIR || path.join(__dirname, "files"))
const RESIZED_ROOT = path.resolve(
  process.env.CDN_RESIZED_DIR || path.join(__dirname, "resized")
)
const CDN_PORT = Number(process.env.CDN_PORT || 9080)
const CDN_HOST = process.env.CDN_HOST || "0.0.0.0"
const S3_PORT = Number(process.env.S3_PORT || 9002)
const S3_HOST = process.env.S3_HOST || "127.0.0.1"
const S3_BUCKET = process.env.S3_BUCKET || "medusa-media"

if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true })
if (!fs.existsSync(RESIZED_ROOT)) fs.mkdirSync(RESIZED_ROOT, { recursive: true })

// ----------------------------------------------------
// 1. Yerel S3 API Sunucusu (Port 9002)
// ----------------------------------------------------
if (S3rver) {
  function startS3(retries = 10) {
    const s3Instance = new S3rver({
      port: S3_PORT,
      address: S3_HOST,
      directory: ROOT,
      silent: false,
      configureBuckets: [{ name: S3_BUCKET }],
    })

    s3Instance.run((err, { address, port } = {}) => {
      if (err) {
        if ((err.code === "EADDRINUSE" || String(err).includes("EADDRINUSE")) && retries > 0) {
          console.warn(`[S3 Server] Port ${S3_PORT} busy, retrying in 1s... (${retries} left)`)
          setTimeout(() => startS3(retries - 1), 1000)
          return
        }
        console.error("[S3 Server] Start error:", err.message)
        return
      }
      console.log(`[S3 Server] Local S3 API listening at http://${address}:${port} (Bucket: "${S3_BUCKET}")`)
    })
  }

  startS3()
}

// ----------------------------------------------------
// 2. Akıllı CDN Proxy & Image Resizer (Port 9080)
// ----------------------------------------------------
const MAX_DIMENSION = 4096
const RESIZABLE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
])
const VALID_FITS = new Set(["cover", "contain", "fill", "inside", "outside"])
const VALID_FORMATS = new Set(["avif", "gif", "jpeg", "jpg", "png", "webp"])

const TYPES = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

const SECURITY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
}

const inFlightResizes = new Map()

function send(res, status, headers = {}, body = "") {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  res.end(body)
}

function resolvePhysicalFile(key) {
  // 1. Doğrudan dosya (file-local modu): ROOT/filename
  const p1 = path.join(ROOT, key)
  if (fs.existsSync(p1) && fs.statSync(p1).isFile()) return p1

  // 2. S3 bucket dizini (s3rver nesnesi): ROOT/bucket/filename._S3rver_object
  const p2 = path.join(ROOT, S3_BUCKET, `${key}._S3rver_object`)
  if (fs.existsSync(p2) && fs.statSync(p2).isFile()) return p2

  // 3. S3 bucket dizini doğrudan dosya: ROOT/bucket/filename
  const p3 = path.join(ROOT, S3_BUCKET, key)
  if (fs.existsSync(p3) && fs.statSync(p3).isFile()) return p3

  return null
}

function parsePositiveInt(raw, min, max) {
  if (raw === null || raw === undefined || raw === "") return null
  if (!/^\d+$/.test(String(raw).trim())) return NaN
  const num = Number(raw)
  if (!Number.isInteger(num) || num < min || num > max) return NaN
  return num
}

function parseResizeOptions(searchParams, ext) {
  if (!sharp || !RESIZABLE_EXTENSIONS.has(ext)) {
    return { options: null, error: null }
  }

  const rawWidth = searchParams.get("w") ?? searchParams.get("width")
  const rawHeight = searchParams.get("h") ?? searchParams.get("height")
  const rawQuality = searchParams.get("q") ?? searchParams.get("quality")
  const rawFit = searchParams.get("fit")
  const rawFormat = searchParams.get("fm") ?? searchParams.get("format")

  const hasAnyParam =
    rawWidth !== null ||
    rawHeight !== null ||
    rawQuality !== null ||
    rawFit !== null ||
    rawFormat !== null

  if (!hasAnyParam) return { options: null, error: null }

  const width = parsePositiveInt(rawWidth, 1, MAX_DIMENSION)
  const height = parsePositiveInt(rawHeight, 1, MAX_DIMENSION)
  const quality = parsePositiveInt(rawQuality, 1, 100)

  if (Number.isNaN(width) || Number.isNaN(height) || Number.isNaN(quality)) {
    return { options: null, error: "Geçersiz boyut veya kalite parametresi" }
  }

  let fit = null
  if (rawFit !== null) {
    const normalizedFit = String(rawFit).trim().toLowerCase()
    if (!VALID_FITS.has(normalizedFit)) {
      return { options: null, error: "Geçersiz fit parametresi" }
    }
    fit = normalizedFit
  }

  let format = null
  if (rawFormat !== null) {
    let normalizedFormat = String(rawFormat).trim().toLowerCase()
    if (normalizedFormat === "jpg") normalizedFormat = "jpeg"
    if (!VALID_FORMATS.has(normalizedFormat)) {
      return { options: null, error: "Geçersiz format" }
    }
    format = normalizedFormat
  }

  if (width === null && height === null && format === null && quality === null) {
    return { options: null, error: null }
  }

  return {
    options: {
      width,
      height,
      quality: quality ?? 80,
      fit: fit ?? "cover",
      format,
    },
    error: null,
  }
}

async function resizeImage(sourcePath, targetPath, options, sourceExt) {
  const targetDir = path.dirname(targetPath)
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  let pipeline = sharp(sourcePath, { animated: false })
  const resizeConfig = {}
  if (options.width) resizeConfig.width = options.width
  if (options.height) resizeConfig.height = options.height
  if (options.fit) resizeConfig.fit = options.fit

  if (Object.keys(resizeConfig).length > 0) {
    pipeline = pipeline.resize(resizeConfig)
  }

  const outFormat = options.format || (sourceExt === ".jpg" ? "jpeg" : sourceExt.replace(".", ""))
  if (outFormat === "webp") {
    pipeline = pipeline.webp({ quality: options.quality })
  } else if (outFormat === "jpeg") {
    pipeline = pipeline.jpeg({ quality: options.quality, progressive: true })
  } else if (outFormat === "png") {
    pipeline = pipeline.png({ quality: options.quality })
  } else if (outFormat === "avif") {
    pipeline = pipeline.avif({ quality: options.quality })
  }

  await pipeline.toFile(targetPath)
}

const cdnServer = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204)

  if (req.url === "/health") {
    return send(res, 200, { "Content-Type": "text/plain" }, "OK")
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { Allow: "GET, HEAD, OPTIONS" }, "Method Not Allowed")
  }

  let parsedUrl
  try {
    parsedUrl = new URL(req.url, "http://localhost")
  } catch {
    return send(res, 400, { "Content-Type": "text/plain" }, "Bad URL")
  }

  let pathname = decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, "")
  if (pathname.includes("\0") || pathname.includes("..")) {
    return send(res, 400, { "Content-Type": "text/plain" }, "Bad Request")
  }

  // S3 bucket prefix'i varsa temizle (örn: /medusa-media/file.png -> file.png)
  if (pathname.startsWith(`${S3_BUCKET}/`)) {
    pathname = pathname.substring(S3_BUCKET.length + 1)
  }

  const physicalPath = resolvePhysicalFile(pathname)
  if (!physicalPath) {
    return send(res, 404, { "Content-Type": "text/plain" }, "Not Found")
  }

  const ext = path.extname(pathname).toLowerCase()
  const { options, error } = parseResizeOptions(parsedUrl.searchParams, ext)
  if (error) {
    return send(res, 400, { "Content-Type": "text/plain" }, error)
  }

  let finalPath = physicalPath
  let finalExt = ext

  if (options) {
    const formatSuffix = options.format ? `.${options.format}` : ext
    const baseName = path.basename(pathname, ext)
    const cacheKey = `${baseName}_w${options.width || 0}_h${options.height || 0}_q${options.quality}_${options.fit}${formatSuffix}`
    finalPath = path.join(RESIZED_ROOT, cacheKey)
    finalExt = formatSuffix

    if (!fs.existsSync(finalPath)) {
      try {
        let resizePromise = inFlightResizes.get(finalPath)
        if (!resizePromise) {
          resizePromise = resizeImage(physicalPath, finalPath, options, ext)
          inFlightResizes.set(finalPath, resizePromise)
        }
        await resizePromise
      } catch (err) {
        console.error("[CDN] Resize error:", err.message)
        finalPath = physicalPath
        finalExt = ext
      } finally {
        inFlightResizes.delete(finalPath)
      }
    }
  }

  try {
    const stat = fs.statSync(finalPath)
    const mime = TYPES[finalExt] || "application/octet-stream"
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`

    if (req.headers["if-none-match"] === etag) {
      return send(res, 304, { ETag: etag })
    }

    const headers = {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
    }

    if (req.method === "HEAD") {
      res.writeHead(200, { ...SECURITY_HEADERS, ...headers })
      return res.end()
    }

    res.writeHead(200, { ...SECURITY_HEADERS, ...headers })
    fs.createReadStream(finalPath).pipe(res)
  } catch (err) {
    console.error("[CDN] Stream error:", err.message)
    send(res, 500, { "Content-Type": "text/plain" }, "Internal Server Error")
  }
})

let cdnRetries = 10
cdnServer.on("error", (err) => {
  if (err.code === "EADDRINUSE" && cdnRetries > 0) {
    cdnRetries--
    console.warn(`[CDN] Port ${CDN_PORT} busy, retrying in 1s... (${cdnRetries} left)`)
    setTimeout(() => {
      cdnServer.close()
      cdnServer.listen(CDN_PORT, CDN_HOST)
    }, 1000)
  } else {
    console.error("[CDN] Server error:", err)
  }
})

cdnServer.listen(CDN_PORT, CDN_HOST, () => {
  console.log(`[CDN] Smart S3 & Image CDN listening at http://${CDN_HOST === "0.0.0.0" ? "localhost" : CDN_HOST}:${CDN_PORT}`)
})
