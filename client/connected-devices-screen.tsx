import {
  usePaseo,
  useRpc,
  useSubscription,
  useTranslation,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  TextInput,
  useToast,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  access,
  AccessSchema,
  DEFAULT_RELAY,
  devices,
  endpoint,
  RelayAddressSchema,
  type Device,
  type Endpoint,
} from "../shared/settings";
import { DirectAccelerationSection } from "./direct-acceleration-section";
import { InviteDeviceModal } from "./invite-device-modal";
import {
  endpointStatusKey,
  errorMessage,
  formatTimestamp,
  messages,
} from "./messages";
import {
  ActionButton,
  ConfirmModal,
  DirectFallbackNotice,
  EmptyStateCard,
  NoticeBox,
  StatusBadge,
  type StatusTone,
} from "./ui";

const EMPTY_INPUT = {};
const SELF_PROVIDER_ID = "remote-hand";

function endpointStatusTone(status: Endpoint["status"]): StatusTone {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
      return "warning";
    case "disconnected":
      return "muted";
  }
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

export function ConnectedDevicesScreen({ theme, layout, host }: PluginSurfaceProps) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const paseo = usePaseo();
  const queryClient = useQueryClient();

  const setRelay = useRpc(endpoint.setRelay);
  const revokeDevice = useRpc(devices.revoke);
  const getAccess = useRpc(access.get);
  const setAccess = useRpc(access.set);

  // 1. 本机端点状态与 relay 地址（通过 endpoint.watch 实时推送）
  const [endpointData, setEndpointData] = useState<Endpoint | null>(null);
  const onEndpointEvent = useCallback((next: Endpoint) => {
    setEndpointData(next);
  }, []);
  const endpointSub = useSubscription(endpoint.watch, EMPTY_INPUT, onEndpointEvent);

  const relayInputRef = useRef<SettingsInputHandle>(null);
  const lastSyncedRelayRef = useRef<string | null>(null);
  const [relayDraft, setRelayDraft] = useState<string>(DEFAULT_RELAY);
  const [relayDirty, setRelayDirty] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [savingRelay, setSavingRelay] = useState(false);
  const [switchedRelay, setSwitchedRelay] = useState<string | null>(null);

  const endpointRelay = endpointData?.relay ?? null;
  useEffect(() => {
    if (!endpointRelay || relayDirty || lastSyncedRelayRef.current === endpointRelay) return;
    lastSyncedRelayRef.current = endpointRelay;
    setRelayDraft(endpointRelay);
    relayInputRef.current?.replaceText(endpointRelay);
  }, [endpointRelay, relayDirty]);

  const handleSaveRelay = useCallback(async () => {
    const parsed = RelayAddressSchema.safeParse(relayDraft);
    if (!parsed.success) {
      setRelayError(t("connectedDevices.relayInvalid"));
      return;
    }
    setRelayError(null);
    setSavingRelay(true);
    try {
      await setRelay({ relay: parsed.data });
      lastSyncedRelayRef.current = parsed.data;
      setRelayDraft(parsed.data);
      relayInputRef.current?.replaceText(parsed.data);
      setRelayDirty(false);
      setSwitchedRelay(parsed.data);
      toast.show(t("connectedDevices.relaySaved"), { variant: "success" });
    } catch (err) {
      const msg = errorMessage(err);
      setRelayError(msg);
      toast.error(msg);
    } finally {
      setSavingRelay(false);
    }
  }, [relayDraft, setRelay, t, toast]);

  const handleResetOfficialRelay = useCallback(() => {
    setRelayDraft(DEFAULT_RELAY);
    relayInputRef.current?.replaceText(DEFAULT_RELAY);
    setRelayDirty(endpointRelay ? DEFAULT_RELAY !== endpointRelay : true);
    setRelayError(null);
  }, [endpointRelay]);

  const handleCopyText = useCallback(
    async (value: string | undefined) => {
      if (!value) return;
      try {
        await copyText(value);
        toast.show(t("common.copied"), { variant: "success" });
      } catch {
        toast.error(t("common.copyFailed"));
      }
    },
    [t, toast],
  );

  // 2. 已连接设备列表订阅与撤销
  const [deviceList, setDeviceList] = useState<Device[]>([]);
  const [hasDevicesSnapshot, setHasDevicesSnapshot] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Device | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const onDevicesEvent = useCallback((next: Device[]) => {
    setDeviceList(next);
    setHasDevicesSnapshot(true);
  }, []);

  const devicesSub = useSubscription(devices.watch, EMPTY_INPUT, onDevicesEvent);

  const handleConfirmRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    setRevokeError(null);
    setRevoking(true);
    try {
      await revokeDevice({ deviceId: revokeTarget.deviceId });
      toast.show(t("connectedDevices.revokeSuccess"), { variant: "success" });
      setRevokeTarget(null);
    } catch (err) {
      setRevokeError(errorMessage(err));
    } finally {
      setRevoking(false);
    }
  }, [revokeDevice, revokeTarget, t, toast]);

  // 3. 访问控制（允许的 provider + 每台设备的并发上限）
  const accessQueryKey = useMemo(() => ["remote-hand", host.id, "access"] as const, [host.id]);
  const accessQuery = useQuery({
    queryKey: accessQueryKey,
    queryFn: () => getAccess(EMPTY_INPUT),
  });

  const providersQuery = useQuery({
    queryKey: ["remote-hand", host.id, "available-providers"] as const,
    queryFn: () => paseo.providers.listAvailable(),
  });

  const maxConcurrentInputRef = useRef<SettingsInputHandle>(null);
  const [allowAllProviders, setAllowAllProviders] = useState(true);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [customProviderDraft, setCustomProviderDraft] = useState("");
  const [maxConcurrentDraft, setMaxConcurrentDraft] = useState("1");
  const [accessDirty, setAccessDirty] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [savingAccess, setSavingAccess] = useState(false);

  useEffect(() => {
    if (!accessQuery.data || accessDirty) return;
    setAllowAllProviders(accessQuery.data.providers.length === 0);
    setSelectedProviders(accessQuery.data.providers);
    const nextMax = String(accessQuery.data.maxConcurrentPerDevice);
    setMaxConcurrentDraft(nextMax);
    maxConcurrentInputRef.current?.replaceText(nextMax);
  }, [accessDirty, accessQuery.data]);

  const providerChoices = useMemo(() => {
    const discovered = (providersQuery.data?.providers ?? []).filter(
      (entry) => entry.provider !== SELF_PROVIDER_ID,
    );
    const seen = new Set<string>();
    const list: { id: string; available: boolean }[] = [];
    for (const entry of discovered) {
      if (seen.has(entry.provider)) continue;
      seen.add(entry.provider);
      list.push({ id: entry.provider, available: entry.available });
    }
    for (const savedId of selectedProviders) {
      if (seen.has(savedId)) continue;
      seen.add(savedId);
      list.push({ id: savedId, available: true });
    }
    return list;
  }, [providersQuery.data?.providers, selectedProviders]);

  const toggleProvider = useCallback((providerId: string) => {
    setAccessDirty(true);
    setAccessError(null);
    setSelectedProviders((current) =>
      current.includes(providerId)
        ? current.filter((item) => item !== providerId)
        : [...current, providerId],
    );
  }, []);

  const handleAddCustomProvider = useCallback(() => {
    const trimmed = customProviderDraft.trim();
    if (!trimmed) return;
    setAccessDirty(true);
    setAccessError(null);
    setAllowAllProviders(false);
    setSelectedProviders((current) => (current.includes(trimmed) ? current : [...current, trimmed]));
    setCustomProviderDraft("");
  }, [customProviderDraft]);

  const handleSaveAccess = useCallback(async () => {
    const providersToSave = allowAllProviders ? [] : selectedProviders;
    if (!allowAllProviders && providersToSave.length === 0) {
      setAccessError(t("connectedDevices.providersSelectionRequired"));
      return;
    }
    const trimmedMax = maxConcurrentDraft.trim();
    if (!/^[1-9]\d*$/.test(trimmedMax)) {
      setAccessError(t("connectedDevices.maxConcurrentInvalid"));
      return;
    }
    const parsed = AccessSchema.safeParse({
      providers: providersToSave,
      maxConcurrentPerDevice: Number(trimmedMax),
    });
    if (!parsed.success) {
      setAccessError(t("connectedDevices.maxConcurrentInvalid"));
      return;
    }

    setAccessError(null);
    setSavingAccess(true);
    try {
      await setAccess(parsed.data);
      setAccessDirty(false);
      toast.show(t("connectedDevices.accessSaved"), { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: accessQueryKey });
    } catch (err) {
      const msg = errorMessage(err);
      setAccessError(msg);
      toast.error(msg);
    } finally {
      setSavingAccess(false);
    }
  }, [
    accessQueryKey,
    allowAllProviders,
    maxConcurrentDraft,
    queryClient,
    selectedProviders,
    setAccess,
    t,
    toast,
  ]);

  const accessHasChanges = useMemo(() => {
    if (!accessQuery.data) return accessDirty;
    const targetProviders = allowAllProviders ? [] : selectedProviders;
    return (
      !sameStringSet(targetProviders, accessQuery.data.providers) ||
      maxConcurrentDraft.trim() !== String(accessQuery.data.maxConcurrentPerDevice)
    );
  }, [accessDirty, accessQuery.data, allowAllProviders, maxConcurrentDraft, selectedProviders]);

  const relayHasChanges = endpointRelay
    ? relayDraft.trim() !== endpointRelay
    : relayDirty;

  const riskMessages = useMemo(() => {
    const items = [
      t("connectedDevices.fixedRiskNativeTools"),
      t("connectedDevices.fixedRiskSharedSessions"),
    ];
    for (const risk of endpointData?.risks ?? []) {
      items.push(risk.message);
    }
    return items;
  }, [endpointData?.risks, t]);

  return (
    <View style={styles.root}>
      <SettingsSection title={t("connectedDevices.endpointSection")}>
        {endpointSub.status === "error" ? (
          <NoticeBox
            tone="danger"
            icon="AlertTriangle"
            items={[
              t("connectedDevices.endpointWatchError", {
                message: endpointSub.error.message,
              }),
            ]}
            theme={theme}
          />
        ) : null}

        {endpointSub.status === "closed" ? (
          <NoticeBox
            tone="warning"
            icon="Info"
            items={[t("connectedDevices.endpointWatchClosed")]}
            theme={theme}
          />
        ) : null}

        {endpointData?.lastError ? (
          endpointData.status === "connected" ? (
            <DirectFallbackNotice
              title={t("remoteMachines.directFallbackTitle")}
              reason={endpointData.lastError}
              expandLabel={t("remoteMachines.directFallbackShowReason")}
              collapseLabel={t("remoteMachines.directFallbackHideReason")}
              theme={theme}
            />
          ) : (
            <NoticeBox
              tone="danger"
              icon="AlertTriangle"
              title={t("connectedDevices.lastErrorLabel")}
              items={[endpointData.lastError]}
              theme={theme}
            />
          )
        ) : null}

        {switchedRelay ? (
          <NoticeBox
            tone="warning"
            icon="Info"
            title={t("connectedDevices.relaySwitchedTitle")}
            items={[t("connectedDevices.relaySwitchedNotice")]}
            theme={theme}
          >
            <View style={styles.switchedRelayRow}>
              <Text
                selectable
                style={[
                  styles.switchedRelayAddress,
                  {
                    color: theme.colors.foreground,
                    backgroundColor: theme.colors.surface2,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                {switchedRelay}
              </Text>
              <View style={styles.inlineActions}>
                <ActionButton
                  label={t("connectedDevices.copyNewRelay")}
                  icon="Copy"
                  theme={theme}
                  variant="outline"
                  compact
                  onPress={() => void handleCopyText(switchedRelay)}
                />
                <ActionButton
                  label={t("common.close")}
                  theme={theme}
                  variant="outline"
                  compact
                  onPress={() => setSwitchedRelay(null)}
                />
              </View>
            </View>
          </NoticeBox>
        ) : null}

        <SettingsCard>
          <SettingsRow label={t("connectedDevices.statusLabel")}>
            {!endpointData && endpointSub.status === "connecting" ? (
              <Text style={[styles.mutedText, { color: theme.colors.foregroundMuted }]}>
                {t("connectedDevices.endpointConnecting")}
              </Text>
            ) : endpointData ? (
              <StatusBadge
                label={t(endpointStatusKey(endpointData.status))}
                tone={endpointStatusTone(endpointData.status)}
                theme={theme}
              />
            ) : (
              <Text style={[styles.mutedText, { color: theme.colors.foregroundMuted }]}>—</Text>
            )}
          </SettingsRow>

          <SettingsInput
            ref={relayInputRef}
            label={t("connectedDevices.relayLabel")}
            hint={t("connectedDevices.relayHint", { defaultRelay: DEFAULT_RELAY })}
            initialValue={endpointRelay ?? DEFAULT_RELAY}
            placeholder={t("connectedDevices.relayPlaceholder")}
            error={relayError}
            disabled={savingRelay}
            onChangeText={(value) => {
              setRelayDraft(value);
              setRelayDirty(true);
              if (relayError) setRelayError(null);
            }}
          />

          <SettingsRow label={t("connectedDevices.saveRelay")}>
            <View style={styles.inlineActions}>
              {relayDraft.trim() !== DEFAULT_RELAY ? (
                <ActionButton
                  label={t("connectedDevices.useOfficialRelay")}
                  theme={theme}
                  variant="outline"
                  compact
                  disabled={savingRelay}
                  onPress={handleResetOfficialRelay}
                />
              ) : null}
              <ActionButton
                label={savingRelay ? t("common.saving") : t("common.save")}
                theme={theme}
                variant="primary"
                compact
                disabled={savingRelay || !relayHasChanges}
                onPress={() => void handleSaveRelay()}
              />
            </View>
          </SettingsRow>

          <SettingsRow label={t("connectedDevices.fingerprintLabel")}>
            <View style={styles.fingerprintRow}>
              <Text
                selectable
                numberOfLines={1}
                style={[styles.fingerprintText, { color: theme.colors.foregroundMuted }]}
              >
                {endpointData?.fingerprint ?? "—"}
              </Text>
              <ActionButton
                label={t("common.copy")}
                icon="Copy"
                theme={theme}
                variant="outline"
                compact
                disabled={!endpointData?.fingerprint}
                onPress={() => void handleCopyText(endpointData?.fingerprint)}
              />
            </View>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("connectedDevices.risksSection")}>
        <NoticeBox
          tone="warning"
          icon="ShieldAlert"
          items={riskMessages}
          theme={theme}
        />
      </SettingsSection>

      <SettingsSection
        title={t("connectedDevices.devicesSection")}
        trailing={
          <ActionButton
            label={t("connectedDevices.inviteButton")}
            icon="Plus"
            theme={theme}
            variant="primary"
            compact
            onPress={() => setInviteOpen(true)}
          />
        }
      >
        {devicesSub.status === "error" ? (
          <NoticeBox
            tone="danger"
            icon="AlertTriangle"
            items={[
              t("connectedDevices.devicesError", {
                message: devicesSub.error.message,
              }),
            ]}
            theme={theme}
          />
        ) : null}

        {devicesSub.status === "closed" ? (
          <NoticeBox
            tone="warning"
            icon="Info"
            items={[t("connectedDevices.devicesClosed")]}
            theme={theme}
          />
        ) : null}

        {!hasDevicesSnapshot && devicesSub.status === "connecting" ? (
          <SettingsCard>
            <SettingsRow label={t("connectedDevices.devicesConnecting")} />
          </SettingsCard>
        ) : deviceList.length === 0 ? (
          <EmptyStateCard
            icon="Laptop"
            title={t("connectedDevices.devicesEmptyTitle")}
            description={t("connectedDevices.devicesEmptyDescription")}
            theme={theme}
            layout={layout}
            action={
              <ActionButton
                label={t("connectedDevices.inviteButton")}
                icon="Plus"
                theme={theme}
                variant="primary"
                onPress={() => setInviteOpen(true)}
              />
            }
          />
        ) : (
          <SettingsCard>
            {deviceList.map((device) => (
              <View
                key={device.deviceId}
                style={[
                  styles.deviceRow,
                  {
                    paddingVertical: layout.compact ? 12 : 14,
                    paddingHorizontal: layout.compact ? 14 : 16,
                  },
                ]}
              >
                <View style={styles.deviceMain}>
                  <View style={styles.deviceTop}>
                    <Text
                      numberOfLines={1}
                      style={[styles.deviceName, { color: theme.colors.foreground }]}
                    >
                      {device.name}
                    </Text>
                    <StatusBadge
                      label={
                        device.online
                          ? t("connectedDevices.deviceOnline")
                          : t("connectedDevices.deviceOffline")
                      }
                      tone={device.online ? "success" : "muted"}
                      theme={theme}
                    />
                  </View>
                  <Text
                    numberOfLines={2}
                    style={[styles.deviceMeta, { color: theme.colors.foregroundMuted }]}
                  >
                    {t("connectedDevices.deviceLastSeen", {
                      time: formatTimestamp(device.lastSeenAt, locale),
                    })}
                    {" · "}
                    {t("connectedDevices.deviceSessions", { count: device.activeSessions })}
                  </Text>
                </View>
                <ActionButton
                  label={t("common.revoke")}
                  theme={theme}
                  variant="danger"
                  compact
                  onPress={() => {
                    setRevokeError(null);
                    setRevokeTarget(device);
                  }}
                />
              </View>
            ))}
          </SettingsCard>
        )}
      </SettingsSection>

      <SettingsSection title={t("connectedDevices.accessSection")}>
        {accessQuery.isError ? (
          <NoticeBox
            tone="danger"
            icon="AlertTriangle"
            items={[
              t("connectedDevices.accessLoadError", {
                message: errorMessage(accessQuery.error),
              }),
            ]}
            theme={theme}
          />
        ) : null}

        <SettingsCard>
          <SettingsSwitch
            label={t("connectedDevices.allowAllProvidersLabel")}
            hint={t("connectedDevices.allowAllProvidersHint")}
            value={allowAllProviders}
            disabled={savingAccess || accessQuery.isPending}
            onValueChange={(next) => {
              setAccessDirty(true);
              setAccessError(null);
              setAllowAllProviders(next);
            }}
          />

          {!allowAllProviders ? (
            <View
              style={[
                styles.providersBlock,
                {
                  paddingVertical: layout.compact ? 12 : 14,
                  paddingHorizontal: layout.compact ? 14 : 16,
                },
              ]}
            >
              <Text style={[styles.blockTitle, { color: theme.colors.foreground }]}>
                {t("connectedDevices.allowedProvidersLabel")}
              </Text>
              <Text style={[styles.blockHint, { color: theme.colors.foregroundMuted }]}>
                {t("connectedDevices.allowedProvidersHint")}
              </Text>

              {providerChoices.length === 0 ? (
                <Text style={[styles.blockHint, { color: theme.colors.foregroundMuted }]}>
                  {t("connectedDevices.discoveredProvidersEmpty")}
                </Text>
              ) : (
                <View style={styles.chipWrap}>
                  {providerChoices.map((choice) => {
                    const selected = selectedProviders.includes(choice.id);
                    return (
                      <Pressable
                        key={choice.id}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected, disabled: savingAccess }}
                        disabled={savingAccess}
                        onPress={() => toggleProvider(choice.id)}
                        style={[
                          styles.providerChip,
                          {
                            backgroundColor: selected
                              ? theme.colors.accent
                              : theme.colors.surface2,
                            borderColor: selected ? theme.colors.accent : theme.colors.border,
                          },
                        ]}
                      >
                        {selected ? (
                          <Icon name="Check" size={13} color={theme.colors.accentForeground} />
                        ) : null}
                        <Text
                          style={[
                            styles.providerChipText,
                            {
                              color: selected
                                ? theme.colors.accentForeground
                                : theme.colors.foreground,
                            },
                          ]}
                        >
                          {choice.available
                            ? choice.id
                            : `${choice.id} (${t("connectedDevices.providerUnavailable")})`}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              <View style={styles.customProviderRow}>
                <TextInput
                  accessibilityLabel={t("connectedDevices.customProviderLabel")}
                  placeholder={t("connectedDevices.customProviderPlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={customProviderDraft}
                  onChangeText={setCustomProviderDraft}
                  editable={!savingAccess}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.customProviderInput,
                    {
                      color: theme.colors.foreground,
                      backgroundColor: theme.colors.surface2,
                      borderColor: theme.colors.border,
                    },
                  ]}
                />
                <ActionButton
                  label={t("connectedDevices.customProviderAdd")}
                  theme={theme}
                  variant="outline"
                  compact
                  disabled={savingAccess || !customProviderDraft.trim()}
                  onPress={handleAddCustomProvider}
                />
              </View>
            </View>
          ) : null}

          <SettingsInput
            ref={maxConcurrentInputRef}
            label={t("connectedDevices.maxConcurrentLabel")}
            hint={t("connectedDevices.maxConcurrentHint")}
            initialValue={
              accessQuery.data ? String(accessQuery.data.maxConcurrentPerDevice) : maxConcurrentDraft
            }
            disabled={savingAccess || accessQuery.isPending}
            onChangeText={(value) => {
              setMaxConcurrentDraft(value);
              setAccessDirty(true);
              if (accessError) setAccessError(null);
            }}
          />

          <SettingsAction
            label={t("connectedDevices.saveAccess")}
            error={accessError}
            actionLabel={savingAccess ? t("common.saving") : t("common.save")}
            disabled={savingAccess || accessQuery.isPending || !accessHasChanges}
            onPress={() => void handleSaveAccess()}
          />
        </SettingsCard>
      </SettingsSection>

      <DirectAccelerationSection theme={theme} layout={layout} />

      <InviteDeviceModal
        open={inviteOpen}
        theme={theme}
        onClose={() => setInviteOpen(false)}
      />

      <ConfirmModal
        open={revokeTarget !== null}
        title={t("connectedDevices.revokeModalTitle", { name: revokeTarget?.name ?? "" })}
        body={t("connectedDevices.revokeConfirmBody", { name: revokeTarget?.name ?? "" })}
        confirmLabel={t("common.revoke")}
        cancelLabel={t("common.cancel")}
        confirmVariant="danger"
        icon="Trash2"
        busy={revoking}
        error={revokeError}
        theme={theme}
        onConfirm={() => void handleConfirmRevoke()}
        onClose={() => {
          setRevokeTarget(null);
          setRevokeError(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 4,
  },
  mutedText: {
    fontSize: 14,
  },
  inlineActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  switchedRelayRow: {
    gap: 8,
    marginTop: 2,
  },
  switchedRelayAddress: {
    fontSize: 13,
    fontFamily: "monospace",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  fingerprintRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    maxWidth: "100%",
  },
  fingerprintText: {
    fontSize: 12,
    fontFamily: "monospace",
    flexShrink: 1,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  deviceMain: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  deviceTop: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  deviceName: {
    fontSize: 15,
    fontWeight: "500",
    flexShrink: 1,
  },
  deviceMeta: {
    fontSize: 13,
    lineHeight: 18,
  },
  providersBlock: {
    gap: 10,
  },
  blockTitle: {
    fontSize: 14,
    fontWeight: "500",
  },
  blockHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  providerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  providerChipText: {
    fontSize: 13,
    fontWeight: "500",
  },
  customProviderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  customProviderInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
  },
});
