import { Button } from "@cap/ui-solid";
import {
	createEffect,
	createResource,
	createSignal,
	Show,
	Suspense,
} from "solid-js";
import { Input } from "~/routes/editor/ui";
import { defaultLocalGoogleDriveConfig, googleDriveConfigStore } from "~/store";
import {
	disconnectDirectGoogleDrive,
	fetchDirectGoogleDriveQuota,
	startDirectGoogleDriveAuth,
} from "~/utils/direct-google-drive";
import { commands } from "~/utils/tauri";
import { Section, SectionCard, SettingsPageContent } from "../Setting";
import { IntegrationConfigHeader } from "./config-header";

const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

const formatBytes = (value?: string | null) => {
	if (!value) return null;

	const bytes = Number(value);
	if (!Number.isFinite(bytes)) return null;
	if (bytes === 0) return "0 B";

	let size = bytes;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < byteUnits.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}

	const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
	return `${size.toFixed(decimals)} ${byteUnits[unitIndex]}`;
};

export default function GoogleDriveConfigPage() {
	const driveStoreQuery = googleDriveConfigStore.createQuery();
	const config = () => driveStoreQuery.data ?? defaultLocalGoogleDriveConfig;

	const [clientId, setClientId] = createSignal("");
	const [clientSecret, setClientSecret] = createSignal("");
	const [isAuthorizing, setIsAuthorizing] = createSignal(false);
	const [isTesting, setIsTesting] = createSignal(false);
	const [abortController, setAbortController] =
		createSignal<AbortController | null>(null);

	createEffect(() => {
		const current = config();
		if (current.clientId && !clientId()) {
			setClientId(current.clientId);
		}
		if (current.clientSecret && !clientSecret()) {
			setClientSecret(current.clientSecret);
		}
	});

	const isConnected = () => config().connected;
	const isActive = () => config().active;

	const [quota, { refetch: refetchQuota, loading: isQuotaLoading }] =
		createResource(
			() => isConnected(),
			async (connected) => {
				if (!connected) return null;
				return await fetchDirectGoogleDriveQuota();
			},
		);

	const quotaUsagePercent = () => {
		const q = quota();
		if (!q?.limit || !q.usage) return null;

		const limit = Number(q.limit);
		const usage = Number(q.usage);
		if (!Number.isFinite(limit) || !Number.isFinite(usage) || limit <= 0) {
			return null;
		}

		return Math.min(Math.max((usage / limit) * 100, 0), 100);
	};

	const quotaUsageLabel = () => {
		const q = quota();
		const usage = formatBytes(q?.usage);
		if (!q || !usage) return null;

		const limit = formatBytes(q.limit);
		return limit ? `${usage} of ${limit} used` : `${usage} used`;
	};

	const remainingBytes = () => {
		const q = quota();
		if (!q?.limit || !q.usage) return null;
		const rem = Number(q.limit) - Number(q.usage);
		return rem >= 0 ? formatBytes(String(rem)) : null;
	};

	const handleConnect = async () => {
		const id = clientId().trim();
		const secret = clientSecret().trim();

		if (!id || !secret) {
			await commands.globalMessageDialog(
				"Please enter both a Google Client ID and Client Secret.",
			);
			return;
		}

		const controller = new AbortController();
		setAbortController(controller);
		setIsAuthorizing(true);

		try {
			await startDirectGoogleDriveAuth(id, secret, controller.signal);
			await driveStoreQuery.refetch();
			await refetchQuota();
			await commands.globalMessageDialog(
				"Successfully connected to Google Drive directly!",
			);
		} catch (error: unknown) {
			if (!controller.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				await commands.globalMessageDialog(
					`Failed to connect to Google Drive: ${message}`,
				);
			}
		} finally {
			setIsAuthorizing(false);
			setAbortController(null);
		}
	};

	const handleCancelAuth = () => {
		abortController()?.abort();
		setIsAuthorizing(false);
		setAbortController(null);
	};

	const handleToggleActive = async () => {
		const nextActive = !isActive();
		await googleDriveConfigStore.set({ active: nextActive });
		await driveStoreQuery.refetch();
	};

	const handleTestConnection = async () => {
		setIsTesting(true);
		try {
			const res = await fetchDirectGoogleDriveQuota();
			if (res) {
				await commands.globalMessageDialog(
					res.email
						? `Direct Google Drive connection is working for ${res.email}`
						: "Direct Google Drive connection is working",
				);
				await refetchQuota();
			} else {
				await commands.globalMessageDialog(
					"Could not reach Google Drive. Please verify your internet connection or reconnect.",
				);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			await commands.globalMessageDialog(`Test failed: ${message}`);
		} finally {
			setIsTesting(false);
		}
	};

	const handleDisconnect = async () => {
		await disconnectDirectGoogleDrive();
		await driveStoreQuery.refetch();
		await commands.globalMessageDialog("Google Drive disconnected.");
	};

	const busy = () => isAuthorizing() || isTesting() || isQuotaLoading();

	return (
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<SettingsPageContent>
				<IntegrationConfigHeader title="Google Drive" />
				<Section
					title="Direct Google Drive"
					description="Connect your Google Drive directly to store exported recordings in a private 'Cap' folder in your Drive. Uploads go straight to Google Drive without passing through any Cap servers."
				>
					<SectionCard padded class="custom-scroll">
						<Suspense
							fallback={
								<div class="flex justify-center items-center py-10">
									<div class="animate-spin size-8 border-2 border-gray-12 border-t-transparent rounded-full" />
								</div>
							}
						>
							<div class="space-y-4 animate-in fade-in">
								<Show
									when={isConnected()}
									fallback={
										<div class="space-y-4">
											<div class="p-3.5 bg-gray-2 border border-gray-4 rounded-xl text-xs space-y-2 text-gray-11">
												<p class="font-medium text-gray-12">
													How to configure Google Drive directly:
												</p>
												<ol class="list-decimal list-inside space-y-1 pl-1">
													<li>
														Go to the{" "}
														<button
															type="button"
															class="text-blue-10 underline"
															onClick={() =>
																commands.openExternalLink(
																	"https://console.cloud.google.com/apis/credentials",
																)
															}
														>
															Google Cloud Console
														</button>
													</li>
													<li>
														Enable the "Google Drive API" for your project
													</li>
													<li>
														Configure OAuth consent screen (External, add scope:
														Drive File)
													</li>
													<li>
														Create OAuth Client ID &rarr; Application type:
														"Desktop app"
													</li>
													<li>Copy your Client ID and Client Secret below</li>
												</ol>
											</div>

											<div class="space-y-3">
												<div class="space-y-1.5">
													<label class="text-[13px] text-gray-12 font-medium">
														Client ID
													</label>
													<Input
														value={clientId()}
														onInput={(e) => setClientId(e.currentTarget.value)}
														placeholder="xxxx.apps.googleusercontent.com"
														disabled={busy()}
														autocapitalize="off"
														autocorrect="off"
														spellcheck={false}
													/>
												</div>

												<div class="space-y-1.5">
													<label class="text-[13px] text-gray-12 font-medium">
														Client Secret
													</label>
													<Input
														type="password"
														value={clientSecret()}
														onInput={(e) =>
															setClientSecret(e.currentTarget.value)
														}
														placeholder="GOCSPX-xxxx"
														disabled={busy()}
														autocapitalize="off"
														autocorrect="off"
														spellcheck={false}
													/>
												</div>
											</div>

											<div class="flex items-center gap-3 pt-2">
												<Show
													when={isAuthorizing()}
													fallback={
														<Button
															variant="primary"
															disabled={busy()}
															onClick={handleConnect}
														>
															Connect Google Drive
														</Button>
													}
												>
													<Button
														variant="destructive"
														onClick={handleCancelAuth}
													>
														Cancel Authorization
													</Button>
													<span class="text-xs text-gray-10 animate-pulse">
														Waiting for Google authorization in browser...
													</span>
												</Show>
											</div>
										</div>
									}
								>
									<div class="space-y-4">
										<div class="flex justify-between items-start gap-4">
											<div class="flex flex-col gap-0.5 min-w-0">
												<p class="text-[13px] text-gray-12 font-medium">
													{quota()?.email ?? config().email ?? "Google Drive"}
												</p>
												<p class="text-xs leading-snug text-gray-10">
													{isActive()
														? "Active for new uploads"
														: "Connected (Inactive)"}
												</p>
											</div>
											<Button
												variant="gray"
												disabled={busy()}
												onClick={() => refetchQuota()}
											>
												{isQuotaLoading() ? "Refreshing..." : "Refresh"}
											</Button>
										</div>

										<Show when={quota()}>
											<div class="pt-3 space-y-2 border-t border-gray-3">
												<div class="flex justify-between items-start gap-4">
													<div class="flex flex-col gap-0.5 min-w-0">
														<p class="text-[13px] text-gray-12">
															Storage Quota
														</p>
														<Show when={quotaUsageLabel()}>
															{(label) => (
																<p class="text-xs leading-snug text-gray-10">
																	{label()}
																</p>
															)}
														</Show>
													</div>
												</div>
												<Show when={quotaUsagePercent() !== null}>
													<div class="overflow-hidden h-1.5 rounded-full bg-gray-4">
														<div
															class="h-full rounded-full bg-blue-9"
															style={{
																width: `${quotaUsagePercent() ?? 0}%`,
															}}
														/>
													</div>
												</Show>
												<Show when={remainingBytes()}>
													{(rem) => (
														<div class="flex justify-between text-[12px] text-gray-10 pt-1">
															<span>Remaining space</span>
															<span class="text-gray-12">{rem()}</span>
														</div>
													)}
												</Show>
											</div>
										</Show>

										<div class="flex flex-wrap gap-2 pt-2">
											<Button
												variant={isActive() ? "gray" : "primary"}
												disabled={busy()}
												onClick={handleToggleActive}
											>
												{isActive()
													? "Deactivate Google Drive"
													: "Use Google Drive"}
											</Button>
											<Button
												variant="gray"
												disabled={busy()}
												onClick={handleTestConnection}
											>
												{isTesting() ? "Testing..." : "Test"}
											</Button>
											<Button
												variant="destructive"
												disabled={busy()}
												onClick={handleDisconnect}
											>
												Disconnect
											</Button>
										</div>
									</div>
								</Show>
							</div>
						</Suspense>
					</SectionCard>
				</Section>
			</SettingsPageContent>
		</div>
	);
}
