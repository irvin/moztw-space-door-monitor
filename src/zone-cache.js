const PUBLIC_API_URL = "https://moztw.space/api";
const PURGE_TIMEOUT_MS = 5000;

/** 清除網站 zone 的公開 API 快取；與 ctx.cache.purge() 的 Workers Cache 分開。 */
export async function purgeZoneApiCache(env) {
  const zoneId = String(env.CLOUDFLARE_ZONE_ID || "").trim();
  const token = String(env.CLOUDFLARE_CACHE_PURGE_API_TOKEN || "").trim();
  if (!zoneId || !token) {
    throw new Error("未設定 CLOUDFLARE_ZONE_ID 或 CLOUDFLARE_CACHE_PURGE_API_TOKEN");
  }
  if (!/^[a-f0-9]{32}$/i.test(zoneId)) {
    throw new Error("CLOUDFLARE_ZONE_ID 格式無效");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PURGE_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ files: [PUBLIC_API_URL] }),
        signal: controller.signal,
      },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.success !== true) {
      const codes = Array.isArray(result?.errors)
        ? result.errors.map(error => error?.code).filter(Number.isInteger)
        : [];
      // 不記錄完整回應或請求標頭，避免憑證出現在日誌中。
      throw new Error(
        `Cloudflare zone purge 失敗（HTTP ${response.status}${codes.length ? `，代碼 ${codes.join(", ")}` : ""}）`,
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Cloudflare zone purge 逾時（5 秒）");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
