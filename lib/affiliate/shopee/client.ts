export type ShopeeCredentials = {
  appId: string;
  secret: string;
};

const SHOPEE_API_URL = "https://open-api.affiliate.shopee.com.br/graphql";

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function callShopeeApi<T>(query: string, credentials: ShopeeCredentials): Promise<T> {
  if (!credentials.appId || !credentials.secret) throw new Error("SHOPEE_API_NOT_CONFIGURED");

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({ query });
  const signature = await sha256(`${credentials.appId}${timestamp}${payload}${credentials.secret}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(SHOPEE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `SHA256 Credential=${credentials.appId},Timestamp=${timestamp},Signature=${signature}`,
      },
      body: payload,
      signal: controller.signal,
    });
    const data = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (!response.ok || data.errors?.length || !data.data) {
      throw new Error(data.errors?.[0]?.message || "SHOPEE_API_ERROR");
    }
    return data.data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("SHOPEE_API_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateShopeeAffiliateLink(
  originUrl: string,
  credentials: ShopeeCredentials,
  subIds: string[] = [],
) {
  const url = new URL(originUrl);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host === "shopee.com.br" || host.endsWith(".shopee.com.br") || host === "shope.ee")) {
    throw new Error("INVALID_SHOPEE_URL");
  }
  const safeSubIds = subIds.filter((value) => /^[a-zA-Z0-9]{1,50}$/.test(value)).slice(0, 5);
  const subIdInput = safeSubIds.length ? `, subIds: ${JSON.stringify(safeSubIds)}` : "";
  const query = `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(url.toString())}${subIdInput} }) { shortLink } }`;
  const result = await callShopeeApi<{ generateShortLink: { shortLink: string } }>(query, credentials);
  return result.generateShortLink.shortLink;
}
