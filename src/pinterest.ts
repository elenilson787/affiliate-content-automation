import { SupabaseRest, eq } from "./db";
import { required, type Env } from "./env";

type JsonObject = Record<string, unknown>;

type PinterestConnectionRow = {
  id: string;
  enabled: boolean;
  account_id: string | null;
  username: string | null;
  access_token_ciphertext: string | null;
  refresh_token_ciphertext: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  scopes: string | null;
  default_board_id: string | null;
  created_at: string;
  updated_at: string;
};

type PinterestOauthStateRow = {
  state_hash: string;
  expires_at: string;
  used_at: string | null;
};

type PinterestTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  refresh_token_expires_at?: number;
  scope?: string;
};

type PinterestUser = {
  id?: string;
  username?: string;
  account_type?: string;
  profile_image?: string;
};

type PinterestBoard = {
  id: string;
  name: string;
  privacy?: string;
  description?: string;
};

type PinterestListResponse<T> = {
  items?: T[];
  bookmark?: string | null;
};

const CONNECTION_ID = "default";
const PINTEREST_SCOPES = ["boards:read", "pins:read", "pins:write", "user_accounts:read"];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function base64Encode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function tokenKey(env: Env) {
  const raw = base64Decode(required(env.PINTEREST_TOKEN_KEY, "PINTEREST_TOKEN_KEY"));
  if (raw.byteLength !== 32) throw new Error("PINTEREST_TOKEN_KEY deve ser uma chave base64 de 32 bytes.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSecret(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), new TextEncoder().encode(value)));
  return `${base64Encode(iv)}.${base64Encode(encrypted)}`;
}

async function decryptSecret(env: Env, value: string) {
  const [ivPart, cipherPart] = value.split(".");
  if (!ivPart || !cipherPart) throw new Error("PINTEREST_TOKEN_CIPHERTEXT_INVALID");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64Decode(ivPart) },
    await tokenKey(env),
    base64Decode(cipherPart),
  );
  return new TextDecoder().decode(decrypted);
}

async function sha256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function pinterestApiBase(env: Env) {
  return String(env.PINTEREST_ENVIRONMENT || "production").toLowerCase() === "sandbox"
    ? "https://api-sandbox.pinterest.com/v5"
    : "https://api.pinterest.com/v5";
}

export function pinterestAppConfigured(env: Env) {
  return Boolean(env.PINTEREST_APP_ID && env.PINTEREST_APP_SECRET && env.PINTEREST_REDIRECT_URI && env.PINTEREST_TOKEN_KEY);
}

async function pinterestRequest<T>(env: Env, token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${pinterestApiBase(env)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as (T & { message?: string; code?: number }) | null;
  if (!response.ok) throw new Error(`PINTEREST_API_ERROR: ${payload?.message || `HTTP ${response.status}`}`);
  return payload as T;
}

async function exchangeToken(env: Env, params: URLSearchParams) {
  const clientId = required(env.PINTEREST_APP_ID, "PINTEREST_APP_ID");
  const clientSecret = required(env.PINTEREST_APP_SECRET, "PINTEREST_APP_SECRET");
  const response = await fetch(`${pinterestApiBase(env)}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as (PinterestTokenResponse & { message?: string }) | null;
  if (!response.ok || !payload?.access_token) {
    throw new Error(`PINTEREST_OAUTH_ERROR: ${payload?.message || `HTTP ${response.status}`}`);
  }
  return payload;
}

async function loadConnection(db: SupabaseRest) {
  const rows = await db.select<PinterestConnectionRow>(
    "pinterest_connections",
    new URLSearchParams({ select: "*", id: eq(CONNECTION_ID), limit: "1" }),
  );
  return rows[0] || null;
}

function expiryIso(seconds?: number) {
  return Number.isFinite(Number(seconds))
    ? new Date(Date.now() + Math.max(0, Number(seconds)) * 1000).toISOString()
    : null;
}

async function persistTokens(env: Env, db: SupabaseRest, token: PinterestTokenResponse, profile: PinterestUser) {
  const existing = await loadConnection(db);
  const refreshCipher = token.refresh_token
    ? await encryptSecret(env, token.refresh_token)
    : existing?.refresh_token_ciphertext || null;
  const refreshExpiresAt = token.refresh_token_expires_at
    ? new Date(token.refresh_token_expires_at * 1000).toISOString()
    : expiryIso(token.refresh_token_expires_in) || existing?.refresh_token_expires_at || null;

  await db.insert<PinterestConnectionRow>("pinterest_connections", {
    id: CONNECTION_ID,
    enabled: true,
    account_id: profile.id || existing?.account_id || null,
    username: profile.username || existing?.username || null,
    access_token_ciphertext: await encryptSecret(env, token.access_token),
    refresh_token_ciphertext: refreshCipher,
    access_token_expires_at: expiryIso(token.expires_in),
    refresh_token_expires_at: refreshExpiresAt,
    scopes: token.scope || existing?.scopes || PINTEREST_SCOPES.join(" "),
    default_board_id: existing?.default_board_id || null,
    updated_at: new Date().toISOString(),
  }, "resolution=merge-duplicates,return=representation");
}

async function refreshAccessToken(env: Env, db: SupabaseRest, connection: PinterestConnectionRow) {
  if (!connection.refresh_token_ciphertext) throw new Error("PINTEREST_RECONNECT_REQUIRED");
  const refreshToken = await decryptSecret(env, connection.refresh_token_ciphertext);
  const token = await exchangeToken(env, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: PINTEREST_SCOPES.join(","),
  }));
  await persistTokens(env, db, token, { id: connection.account_id || undefined, username: connection.username || undefined });
  const updated = await loadConnection(db);
  if (!updated?.access_token_ciphertext) throw new Error("PINTEREST_TOKEN_REFRESH_FAILED");
  return { connection: updated, accessToken: await decryptSecret(env, updated.access_token_ciphertext) };
}

export async function getPinterestAccess(env: Env, db = new SupabaseRest(env)) {
  const connection = await loadConnection(db);
  if (!connection?.enabled || !connection.access_token_ciphertext) throw new Error("PINTEREST_NOT_CONNECTED");
  const expiresAt = connection.access_token_expires_at ? new Date(connection.access_token_expires_at).getTime() : 0;
  if (expiresAt && expiresAt <= Date.now() + 5 * 60_000) return refreshAccessToken(env, db, connection);
  return { connection, accessToken: await decryptSecret(env, connection.access_token_ciphertext) };
}

export async function listPinterestBoards(env: Env, db = new SupabaseRest(env)) {
  const { accessToken } = await getPinterestAccess(env, db);
  const response = await pinterestRequest<PinterestListResponse<PinterestBoard>>(env, accessToken, "/boards?page_size=100");
  return (response.items || []).map((board) => ({ id: String(board.id), name: board.name, privacy: board.privacy || null }));
}

export async function pinterestConnectionStatus(env: Env) {
  if (!pinterestAppConfigured(env)) {
    return { configured: false, connected: false, environment: env.PINTEREST_ENVIRONMENT || "production", boards: [] };
  }
  const db = new SupabaseRest(env);
  const connection = await loadConnection(db);
  if (!connection?.enabled) {
    return { configured: true, connected: false, environment: env.PINTEREST_ENVIRONMENT || "production", boards: [] };
  }
  try {
    const { connection: current, accessToken } = await getPinterestAccess(env, db);
    const [profile, boardResponse] = await Promise.all([
      pinterestRequest<PinterestUser>(env, accessToken, "/user_account"),
      pinterestRequest<PinterestListResponse<PinterestBoard>>(env, accessToken, "/boards?page_size=100"),
    ]);
    return {
      configured: true,
      connected: true,
      environment: env.PINTEREST_ENVIRONMENT || "production",
      account: { id: profile.id || current.account_id, username: profile.username || current.username },
      scopes: current.scopes,
      defaultBoardId: current.default_board_id,
      boards: (boardResponse.items || []).map((board) => ({ id: String(board.id), name: board.name, privacy: board.privacy || null })),
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      reconnectRequired: true,
      environment: env.PINTEREST_ENVIRONMENT || "production",
      message: error instanceof Error ? error.message : "Falha ao validar Pinterest",
      boards: [],
    };
  }
}

async function createAuthUrl(env: Env) {
  if (!pinterestAppConfigured(env)) throw new Error("Configure PINTEREST_APP_ID, PINTEREST_APP_SECRET, PINTEREST_REDIRECT_URI e PINTEREST_TOKEN_KEY.");
  const state = crypto.randomUUID();
  const db = new SupabaseRest(env);
  await db.insert("pinterest_oauth_states", {
    state_hash: await sha256(state),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    used_at: null,
  }, "return=minimal");
  const url = new URL("https://www.pinterest.com/oauth/");
  url.searchParams.set("client_id", required(env.PINTEREST_APP_ID, "PINTEREST_APP_ID"));
  url.searchParams.set("redirect_uri", required(env.PINTEREST_REDIRECT_URI, "PINTEREST_REDIRECT_URI"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PINTEREST_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function handlePinterestCallback(request: Request, env: Env) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const oauthError = url.searchParams.get("error") || url.searchParams.get("error_description");
    if (oauthError) throw new Error(oauthError);
    if (!code || !state) throw new Error("PINTEREST_CALLBACK_INVALID");

    const db = new SupabaseRest(env);
    const stateHash = await sha256(state);
    const states = await db.select<PinterestOauthStateRow>("pinterest_oauth_states", new URLSearchParams({
      select: "*",
      state_hash: eq(stateHash),
      used_at: "is.null",
      expires_at: `gt.${new Date().toISOString()}`,
      limit: "1",
    }));
    if (!states.length) throw new Error("PINTEREST_OAUTH_STATE_INVALID_OR_EXPIRED");
    await db.update("pinterest_oauth_states", new URLSearchParams({ state_hash: eq(stateHash) }), { used_at: new Date().toISOString() });

    const token = await exchangeToken(env, new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: required(env.PINTEREST_REDIRECT_URI, "PINTEREST_REDIRECT_URI"),
    }));
    const profile = await pinterestRequest<PinterestUser>(env, token.access_token, "/user_account");
    await persistTokens(env, db, token, profile);

    return html(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Pinterest conectado</title><body style="font-family:system-ui;background:#070b18;color:#eef3ff;display:grid;place-items:center;min-height:100vh"><div style="max-width:520px;padding:28px;border:1px solid #344a7c;border-radius:18px;background:#0a1429"><h2>✅ Pinterest conectado</h2><p>A conta <b>${String(profile.username || profile.id || "Pinterest")}</b> foi autorizada.</p><p>Você já pode fechar esta janela e atualizar a aba <b>Integrações</b>.</p><script>setTimeout(()=>{try{window.opener&&window.opener.postMessage({type:'pinterest-connected'},location.origin)}catch{}},300)</script></div></body></html>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida";
    return html(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Falha no Pinterest</title><body style="font-family:system-ui;background:#070b18;color:#eef3ff;display:grid;place-items:center;min-height:100vh"><div style="max-width:620px;padding:28px;border:1px solid #8c3454;border-radius:18px;background:#0a1429"><h2>❌ Não foi possível conectar o Pinterest</h2><p>${message.replace(/[<>&]/g, "")}</p></div></body></html>`, 400);
  }
}

export async function handlePinterestAdminApi(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = new SupabaseRest(env);

  if (request.method === "GET" && path === "/api/admin/pinterest/status") {
    return json(await pinterestConnectionStatus(env));
  }
  if (request.method === "POST" && path === "/api/admin/pinterest/auth-url") {
    return json({ ok: true, url: await createAuthUrl(env) });
  }
  if (request.method === "POST" && path === "/api/admin/pinterest/test") {
    const status = await pinterestConnectionStatus(env);
    return json({ ok: Boolean(status.connected), ...status }, status.connected ? 200 : 409);
  }
  if (request.method === "POST" && path === "/api/admin/pinterest/default-board") {
    const body = await request.json().catch(() => ({})) as JsonObject;
    const boardId = typeof body.boardId === "string" ? body.boardId.trim() : "";
    if (!/^\d+$/.test(boardId)) return json({ error: "BOARD_ID_INVALID" }, 400);
    const boards = await listPinterestBoards(env, db);
    if (!boards.some((board) => board.id === boardId)) return json({ error: "BOARD_NOT_AVAILABLE" }, 400);
    const updated = await db.update<PinterestConnectionRow>(
      "pinterest_connections",
      new URLSearchParams({ id: eq(CONNECTION_ID) }),
      { default_board_id: boardId, updated_at: new Date().toISOString() },
    );
    return json({ ok: true, defaultBoardId: updated[0]?.default_board_id || boardId });
  }
  if (request.method === "POST" && path === "/api/admin/pinterest/disconnect") {
    await db.update("pinterest_connections", new URLSearchParams({ id: eq(CONNECTION_ID) }), {
      enabled: false,
      access_token_ciphertext: null,
      refresh_token_ciphertext: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true });
  }

  return json({ error: "PINTEREST_ADMIN_ROUTE_NOT_FOUND" }, 404);
}
