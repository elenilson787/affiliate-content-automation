export type ShopeeCredentials = {
  appId: string;
  secret: string;
};

const SHOPEE_API_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const SHOPEE_SYSTEM_ERROR = 10000;
const MAX_SYSTEM_ERROR_RETRIES = 2;

type ShopeeGraphQLError = {
  message?: string;
  extensions?: {
    code?: number | string;
    message?: string;
  };
};

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function shopeeError(errors: ShopeeGraphQLError[] | undefined, status: number) {
  const first = errors?.[0];
  const code = Number(first?.extensions?.code);
  const detail = first?.extensions?.message || first?.message;
  const prefix = Number.isFinite(code) ? `SHOPEE_API_ERROR_${code}` : `SHOPEE_API_HTTP_${status}`;
  return new Error(`${prefix}: ${detail || "Falha desconhecida na API Shopee"}`);
}

function isRetryableSystemError(error: unknown) {
  return error instanceof Error && error.message.startsWith(`SHOPEE_API_ERROR_${SHOPEE_SYSTEM_ERROR}:`);
}

async function callShopeeApiOnce<T>(query: string, credentials: ShopeeCredentials): Promise<T> {
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

    const data = (await response.json()) as {
      data?: T;
      errors?: ShopeeGraphQLError[];
    };

    if (!response.ok || data.errors?.length || !data.data) {
      throw shopeeError(data.errors, response.status);
    }

    return data.data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("SHOPEE_API_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callShopeeApi<T>(query: string, credentials: ShopeeCredentials): Promise<T> {
  if (!credentials.appId || !credentials.secret) throw new Error("SHOPEE_API_NOT_CONFIGURED");

  for (let attempt = 0; attempt <= MAX_SYSTEM_ERROR_RETRIES; attempt += 1) {
    try {
      return await callShopeeApiOnce<T>(query, credentials);
    } catch (error) {
      if (!isRetryableSystemError(error) || attempt === MAX_SYSTEM_ERROR_RETRIES) throw error;
      await sleep(attempt === 0 ? 250 : 750);
    }
  }

  throw new Error("SHOPEE_API_RETRY_EXHAUSTED");
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
