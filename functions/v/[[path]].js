// functions/v/[[path]].js
// ★ catch-all route — /v/{id}.mp4 ရော /v/{id}/{filename} ရော နှစ်မျိုးလုံး ဖမ်းနိုင်
// direct link ကို KV မှာ ၅ မိနစ် cache လုပ်ထားသည်
// ★ browser မှာ play မဖြစ်ဘဲ ဖိုင်တန်းဒေါင်းအောင် attachment သုံးထားသည်
// ★ custom filename support (URL path ထဲကရော KV ကရော)

const CACHE_TTL = 300; // 5 မိနစ် (စက္ကန့်)

export async function onRequest(context) {
  const { request, params, env } = context;

  // GET / HEAD သာ ခွင့်ပြု
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ───────────────────────────────────────────────
  // ★ path ကို ပိုင်းခြား
  // params.path က array ဖြစ်နိုင် (catch-all) ဒါမှမဟုတ် string
  // ဖြစ်နိုင်တဲ့ပုံစံ:
  //   ["a9539b49.mp4"]              → /v/a9539b49.mp4
  //   ["a9539b49", "myvideo.mp4"]   → /v/a9539b49/myvideo.mp4
  let segments = params.path;
  if (typeof segments === "string") segments = [segments];
  if (!Array.isArray(segments) || segments.length === 0) {
    return new Response("Invalid path", { status: 400 });
  }

  // ★ ID = ပထမ segment (extension ဖယ်)
  let id = segments[0];
  if (id.includes(".")) id = id.substring(0, id.lastIndexOf("."));

  // ★ URL path ထဲက filename (ဒုတိယ segment ရှိရင် အဲ့ဒါ filename)
  let urlFilename = "";
  if (segments.length >= 2) {
    urlFilename = decodeURIComponent(segments[segments.length - 1]);
  }

  // MediaFire link ရှာ
  const mfUrl = await env.LINKS.get(id);
  if (!mfUrl) {
    return new Response("ID ရှာမတွေ့ပါ", { status: 404 });
  }

  // ★ user ပေးထားတဲ့ custom filename ရှာ (KV)
  const customName = await env.LINKS.get("name:" + id);

  // ★ cache အရင်စစ် — resolve လုပ်ထားတဲ့ direct link ရှိပြီးသားလား
  const cacheKey = "direct:" + id;
  let direct = await env.LINKS.get(cacheKey);

  if (!direct) {
    // cache မှာ မရှိ → MediaFire ကို အသစ်ပြန် resolve
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
  // ★ ဖိုင်နာမည် ဆုံးဖြတ်ခြင်း (priority order):
  //   1) URL path ထဲက filename (download manager က ဒါကို ယူတယ်)
  //   2) KV ထဲက custom name
  //   3) MediaFire URL ကနေ ထုတ်ယူ
  const filename =
    urlFilename || customName || extractFilename(mfUrl, direct);

  // Range request forward (seek/resume support)
  const fwdHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) fwdHeaders.set("Range", range);
  fwdHeaders.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  );

  let upstream = await fetch(direct, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });

  // ★ cache ထဲက link expire ဖြစ်နေရင် (403/410/404) → ပြန် resolve ပြီး ထပ်ကြိုး
  if (upstream.status === 403 || upstream.status === 410 || upstream.status === 404) {
    const fresh = await resolveMediafire(mfUrl);
    if (fresh) {
      direct = fresh;
      await env.LINKS.put(cacheKey, direct, { expirationTtl: CACHE_TTL });
      upstream = await fetch(direct, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: fwdHeaders,
        redirect: "follow",
      });
    }
  }

  const respHeaders = new Headers();
  for (const h of [
    "content-length", "content-range",
    "accept-ranges", "last-modified", "etag",
  ]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Accept-Ranges", "bytes");

  // ★★★ play မဖြစ်ဘဲ ဖိုင်တန်းဒေါင်းအောင် ★★★
  respHeaders.set("Content-Type", "application/octet-stream");
  respHeaders.set(
    "Content-Disposition",
    `attachment; filename="${sanitizeAscii(filename)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

// ───────────────────────────────────────────────
// filename ထဲက အန္တရာယ်ရှိနိုင်တဲ့ character (quote, newline) တွေ ဖယ်
function sanitizeAscii(name) {
  return name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_");
}

// ───────────────────────────────────────────────
// MediaFire URL သို့မဟုတ် direct URL ကနေ ဖိုင်နာမည် ဆွဲထုတ်
function extractFilename(mfUrl, directUrl) {
  // MediaFire URL ပုံစံ: .../file/xxxx/FILENAME.mp4/file
  try {
    const parts = new URL(mfUrl).pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[0] === "file") {
      const name = decodeURIComponent(parts[2]);
      if (name.includes(".")) return name;
    }
  } catch (_) {}

  // direct URL ရဲ့ နောက်ဆုံး segment ကနေ ကြိုးစား
  try {
    const dParts = new URL(directUrl).pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(dParts[dParts.length - 1] || "");
    if (last.includes(".")) return last;
  } catch (_) {}

  return "download.mp4";
}

// ───────────────────────────────────────────────
async function resolveMediafire(mfUrl) {
  const res = await fetch(mfUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();

  let link = null;

  let m = html.match(/id="downloadButton"[^>]*href="([^"]+)"/i);
  if (m && m[1]) link = m[1];

  if (!link) {
    m = html.match(/href="(https?:\/\/download[^"]+)"/i);
    if (m && m[1]) link = m[1];
  }

  if (!link) {
    m = html.match(/data-scrambled-url="([^"]+)"/i);
    if (m && m[1]) {
      try {
        const decoded = atob(m[1]);
        if (decoded.startsWith("http")) link = decoded;
      } catch (_) {}
    }
  }

  if (!link) {
    m = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
    if (m && m[1] && m[1].startsWith("http")) link = m[1];
  }

  // ★ HTML entity decode (&amp; → &)
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
