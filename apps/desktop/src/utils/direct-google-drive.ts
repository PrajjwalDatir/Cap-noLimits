import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as shell from "@tauri-apps/plugin-shell";
import callbackTemplate from "~/components/callback.template";
import {
	defaultLocalGoogleDriveConfig,
	googleDriveConfigStore,
	type LocalGoogleDriveConfig,
} from "~/store";

const DRIVE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";

export async function startDirectGoogleDriveAuth(
	clientId: string,
	clientSecret: string,
	signal: AbortSignal,
): Promise<LocalGoogleDriveConfig> {
	await invoke("plugin:oauth|stop").catch(() => {});

	const port: string = await invoke("plugin:oauth|start", {
		config: {
			response: callbackTemplate,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store, no-cache, must-revalidate",
				Pragma: "no-cache",
			},
			cleanup: true,
		},
	});

	const redirectUri = `http://127.0.0.1:${port}`;
	const authUrl = new URL(DRIVE_AUTH_URL);
	authUrl.searchParams.set("client_id", clientId);
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set(
		"scope",
		"https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
	);
	authUrl.searchParams.set("access_type", "offline");
	authUrl.searchParams.set("prompt", "consent");

	let settled = false;
	let stopListening: (() => void) | undefined;
	let resolvePromise: (code: string | null) => void = () => {};

	const authCodePromise = new Promise<string | null>((resolve) => {
		resolvePromise = resolve;
	});

	const settle = (value: string | null) => {
		if (settled) return;
		settled = true;
		resolvePromise(value);
	};

	stopListening = await listen("oauth://url", (data: { payload: string }) => {
		try {
			const parsed = new URL(data.payload);
			const code = parsed.searchParams.get("code");
			if (code) {
				settle(code);
			}
		} catch {}
	});

	const cleanup = async () => {
		stopListening?.();
		stopListening = undefined;
		await invoke("plugin:oauth|stop").catch(() => {});
	};

	signal.addEventListener(
		"abort",
		() => {
			settle(null);
			void cleanup();
		},
		{ once: true },
	);

	await shell.open(authUrl.toString());

	const code = await authCodePromise;
	await cleanup();

	if (!code) {
		throw new Error("Authorization was cancelled or failed");
	}

	const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}),
	});

	if (!tokenResponse.ok) {
		const errorText = await tokenResponse.text();
		throw new Error(`Google token exchange failed: ${errorText}`);
	}

	const tokenData: {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	} = await tokenResponse.json();

	let email: string | null = null;
	try {
		const userinfoResponse = await fetch(GOOGLE_USERINFO_URL, {
			headers: { Authorization: `Bearer ${tokenData.access_token}` },
		});
		if (userinfoResponse.ok) {
			const userinfo = await userinfoResponse.json();
			email = userinfo.email ?? null;
		}
	} catch {}

	let folderId: string | null = null;
	try {
		folderId = await ensureCapFolder(tokenData.access_token);
	} catch (err) {
		console.warn("Failed to ensure Cap folder in Google Drive:", err);
	}

	const nextConfig: LocalGoogleDriveConfig = {
		clientId,
		clientSecret,
		refreshToken: tokenData.refresh_token ?? null,
		accessToken: tokenData.access_token,
		expiresAt: Date.now() + tokenData.expires_in * 1000,
		email,
		folderId,
		connected: true,
		active: true,
	};

	await googleDriveConfigStore.set(nextConfig);
	return nextConfig;
}

export async function getValidDirectDriveAccessToken(): Promise<string | null> {
	const config = await googleDriveConfigStore.get();
	if (!config?.connected || !config.clientId || !config.refreshToken) {
		return null;
	}

	if (
		config.accessToken &&
		config.expiresAt &&
		config.expiresAt > Date.now() + 60000
	) {
		return config.accessToken;
	}

	const refreshResponse = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			refresh_token: config.refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!refreshResponse.ok) {
		return null;
	}

	const data: { access_token: string; expires_in: number } =
		await refreshResponse.json();

	await googleDriveConfigStore.set({
		accessToken: data.access_token,
		expiresAt: Date.now() + data.expires_in * 1000,
	});

	return data.access_token;
}

export async function ensureCapFolder(accessToken: string): Promise<string> {
	const query = encodeURIComponent(
		"name='Cap' and mimeType='application/vnd.google-apps.folder' and trashed=false",
	);
	const searchResponse = await fetch(
		`${GOOGLE_DRIVE_API}/files?q=${query}&fields=files(id,name)`,
		{
			headers: { Authorization: `Bearer ${accessToken}` },
		},
	);

	if (searchResponse.ok) {
		const result: { files?: Array<{ id: string; name: string }> } =
			await searchResponse.json();
		if (result.files && result.files.length > 0) {
			return result.files[0].id;
		}
	}

	const createResponse = await fetch(`${GOOGLE_DRIVE_API}/files`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			name: "Cap",
			mimeType: "application/vnd.google-apps.folder",
		}),
	});

	if (!createResponse.ok) {
		throw new Error("Failed to create 'Cap' folder in Google Drive");
	}

	const created: { id: string } = await createResponse.json();
	return created.id;
}

export async function fetchDirectGoogleDriveQuota(): Promise<{
	limit: string | null;
	usage: string | null;
	email: string | null;
} | null> {
	const accessToken = await getValidDirectDriveAccessToken();
	if (!accessToken) return null;

	const response = await fetch(
		`${GOOGLE_DRIVE_API}/about?fields=user,storageQuota`,
		{
			headers: { Authorization: `Bearer ${accessToken}` },
		},
	);

	if (!response.ok) return null;

	const data: {
		user?: { emailAddress?: string; displayName?: string };
		storageQuota?: { limit?: string; usage?: string };
	} = await response.json();

	return {
		limit: data.storageQuota?.limit ?? null,
		usage: data.storageQuota?.usage ?? null,
		email: data.user?.emailAddress ?? null,
	};
}

export async function disconnectDirectGoogleDrive(): Promise<void> {
	await googleDriveConfigStore.set(defaultLocalGoogleDriveConfig);
}
