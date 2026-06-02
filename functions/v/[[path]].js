// functions/v/[[path]].js
// ★ catch-all route — /v/{id}.mp4 ရော /v/{id}/{filename} ရော ဖမ်းနိုင်
// MediaFire → direct link resolve လုပ်ပြီး proxy ပြန်ထုတ်
//
// ★ SPEED FIX:
//   1) MediaFire JSON API (get_info.php) သုံး → HTML page မဆွဲတော့ → အရမ်းမြန်
//   2) API fail မှသာ HTML fallback
//   3) cache TTL ကို 300s → 1800s (30min) တိုး → resolve ကြိမ်နှုန်းလျှော့
//   4) ?dl=1 → download, default → play (stream)

const CACHE_TTL = 1800; // 30 မိနစ် (စက္ကန့်)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) " +
  "Gecko/20100101 Firefox/131.0";

export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ───────────────────────────────────────────────
  let segments = params.path;
  if (typeof segments === "string") segments = [segments];
  if (!Array.isArray(segments) || segments.length === 0) {
    return new Response("Invalid path", { status: 400 });
  }

  let id = segments[0];
  if (id.includes(".")) id = id.substring(0, id.lastIndexOf("."));

  let urlFilename = "";
  if (segments.length >= 2) {
    urlFilename = decodeURIComponent(segments[segments.length - 1]);
  }

  const mfUrl = await env.LINKS.get(id);
  if (!mfUrl) {
    return new Response("ID ရှာမတွေ့ပါ", { status: 404 });
  }

  const customName = await env.LINKS.get("name:" + id);

  const reqUrl = new URL(request.url);
  const forceDownload = reqUrl.searchParams.get("dl") === "1";

  // ───────────────────────────────────────────────
  // ★ direct link resolve (cache အရင်)
  const cacheKey = "direct:" + id;
  let direct = await env.LINKS.get(cacheKey);

  if (!direct) {
    try {
      direct = await resolveMediafire(mfUrl);
    } catch (e) {
      return new Response("Resolve error: " + e.message, { status: 502 });
    }
    if (!direct) {
      return new Response("Direct link ရှာမတွေ့ပါ", { status: 502 });
    }
    await env.LINKS.put(cacheKey, direct, { expirationTtl: CACHE_TTL });
  }

  // ───────────────────────────────────────────────
  const filename =
    urlFilename || customName || extractFilename(mfUrl, direct);

  // ───────────────────────────────────────────────
  // ★ upstream fetch (HEAD → bytes=0-0 GET, size စစ်နိုင်အောင်)
  let upstream = await fetchUpstream(direct, request);

  // ★ link expire → ပြန် resolve
  if (
    upstream.status === 403 ||
    upstream.status === 410 ||
    upstream.status === 404
  ) {
    const fresh = await resolveMediafire(mfUrl);
    if (fresh) {
      direct = fresh;
      await env.LINKS.put(cacheKey, direct, { expirationTtl: CACHE_TTL });
      upstream = await fetchUpstream(direct, request);
    }
  }

  // ───────────────────────────────────────────────
  // ★ response headers
  const respHeaders = new Headers();

  const upLen = upstream.headers.get("content-length");
  const upRange = upstream.headers.get("content-range");

  for (const h of ["content-range", "last-modified", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  // ★ Content-Length မှန်အောင် (download manager size စစ်)
  let totalSize = null;
  if (upRange) {
    const m = upRange.match(/\/(\d+)\s*$/);
    if (m) totalSize = m[1];
  }

  const reqHasRange = !!request.headers.get("Range");

  if (request.method === "HEAD") {
    if (totalSize) {
      respHeaders.set("Content-Length", totalSize);
      respHeaders.delete("content-range");
    } else if (upLen) {
      respHeaders.set("Content-Length", upLen);
    }
  } else {
    if (reqHasRange) {
      if (upLen) respHeaders.set("Content-Length", upLen);
    } else {
      if (totalSize) respHeaders.set("Content-Length", totalSize);
      else if (upLen) respHeaders.set("Content-Length", upLen);
    }
  }

  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Accept-Ranges", "bytes");

  let respStatus = upstream.status;
  if (request.method === "HEAD") {
    respStatus = upstream.status === 206 ? 200 : upstream.status;
  }

  if (forceDownload) {
    respHeaders.set("Content-Type", "application/octet-stream");
    respHeaders.set(
      "Content-Disposition",
      `attachment; filename="${sanitizeAscii(filename)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  } else {
    const upstreamType = upstream.headers.get("content-type");
    respHeaders.set(
      "Content-Type",
      upstreamType && upstreamType.startsWith("video/")
        ? upstreamType
        : "video/mp4"
    );
    respHeaders.set(
      "Content-Disposition",
      `inline; filename="${sanitizeAscii(filename)}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  }

  const body = request.method === "HEAD" ? null : upstream.body;

  return new Response(body, {
    status: respStatus,
    headers: respHeaders,
  });
}

// ───────────────────────────────────────────────
// ★ upstream fetch helper (HEAD → bytes=0-0, GET → Range forward)
async function fetchUpstream(direct, request) {
  const fwdHeaders = new Headers();
  fwdHeaders.set("User-Agent", UA);

  if (request.method === "HEAD") {
    fwdHeaders.set("Range", "bytes=0-0");
    return fetch(direct, {
      method: "GET",
      headers: fwdHeaders,
      redirect: "follow",
    });
  }

  const range = request.headers.get("Range");
  if (range) fwdHeaders.set("Range", range);

  return fetch(direct, {
    method: "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });
}

// ───────────────────────────────────────────────
function sanitizeAscii(name) {
  return name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_");
}

// ───────────────────────────────────────────────
function extractFilename(mfUrl, directUrl) {
  // MediaFire URL ပုံစံ: .../file/xxxx/FILENAME.mp4/file
  try {
    const parts = new URL(mfUrl).pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[0] === "file") {
      const name = decodeURIComponent(parts[2]);
      if (name.includes(".")) return name;
    }
  } catch (_) {}

  try {
    const dParts = new URL(directUrl).pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(dParts[dParts.length - 1] || "");
    if (last.includes(".")) return last;
  } catch (_) {}

  return "download.mp4";
}

// ───────────────────────────────────────────────
// ★ MediaFire → direct link resolve
//   ★ SPEED: API အရင်ကြိုး (မြန်)၊ မရမှ HTML fallback
async function resolveMediafire(mfUrl) {
  // ★ file key ထုတ် — /file/{KEY}/... သို့ /file_premium/{KEY}/...
  const keyMatch = mfUrl.match(
    /mediafire\.com\/(?:file|file_premium)\/([a-zA-Z0-9]+)/i
  );

  // ───── METHOD 1: JSON API (အမြန်ဆုံး) ─────
  if (keyMatch && keyMatch[1]) {
    const key = keyMatch[1];
    try {
      const apiUrl =
        `https://www.mediafire.com/api/file/get_info.php` +
        `?quick_key=${key}&response_format=json`;
      const apiRes = await fetch(apiUrl, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const link =
          data?.response?.file_info?.links?.normal_download;
        if (link) {
          // ★ normal_download က တခါတရံ HTML page ဖြစ်တတ် → resolve ထပ်လုပ်
          const resolved = await followToDirect(link);
          if (resolved) return resolved;
        }
      }
    } catch (_) {
      // API fail → HTML fallback ဆက်
    }
  }

  // ───── METHOD 2: HTML page parse (fallback) ─────
  return await resolveFromHtml(mfUrl);
}

// ───────────────────────────────────────────────
// ★ link ကို follow လုပ် — တကယ့် direct file link (download.mediafire.com) ရအောင်
async function followToDirect(link) {
  // download host ဆိုရင် တန်းသုံး
  if (/download[^.]*\.mediafire\.com/i.test(link)) {
    return link;
  }

  // မဟုတ်ရင် ဖွင့်ကြည့် — HTML လား direct လား
  try {
    const res = await fetch(link, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
    });

    // ★ redirect ပြီး download host ရောက်သွားရင်
    if (/download[^.]*\.mediafire\.com/i.test(res.url)) {
      return res.url;
    }

    const ct = res.headers.get("content-type") || "";
    // ★ HTML မဟုတ်ရင် (video/octet-stream) → ဒီ link ကိုယ်တိုင် direct
    if (!ct.includes("text/html")) {
      return res.url || link;
    }

    // ★ HTML ဆိုရင် scrambled-url ထဲက ဆွဲ
    const html = await res.text();
    const fromHtml = parseHtmlForLink(html);
    if (fromHtml) return fromHtml;

    return res.url || link;
  } catch (_) {
    return link; // fail ရင် ရှိတဲ့ link ပြန်
  }
}

// ───────────────────────────────────────────────
// ★ HTML page ကနေ direct link parse
async function resolveFromHtml(mfUrl) {
  const res = await fetch(mfUrl, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  const html = await res.text();
  return parseHtmlForLink(html);
}

// ───────────────────────────────────────────────
// ★ HTML string ထဲက download link ဆွဲထုတ်
function parseHtmlForLink(html) {
  let link = null;

  // ★ scrambled-url (base64) — အဓိက method
  let m = html.match(/data-scrambled-url="([^"]+)"/i);
  if (m && m[1]) {
    try {
      const decoded = atob(m[1]);
      if (decoded.startsWith("http")) link = decoded;
    } catch (_) {}
  }

  // ★ downloadButton href
  if (!link) {
    m = html.match(/id="downloadButton"[^>]*href="([^"]+)"/i);
    if (m && m[1] && m[1].startsWith("http")) link = m[1];
  }

  // ★ download host href
  if (!link) {
    m = html.match(/href="(https?:\/\/download[^"]+)"/i);
    if (m && m[1]) link = m[1];
  }

  // ★ JS redirect
  if (!link) {
    m = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
    if (m && m[1] && m[1].startsWith("http")) link = m[1];
  }

  if (link) link = decodeHtmlEntities(link);
  return link;
}

// ───────────────────────────────────────────────
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/");
}
