import { useRpc, useSubscription, useTranslation } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  DEFAULT_DIRECT,
  direct,
  DirectPeerSchema,
  DirectSettingsSchema,
  type DirectSettings,
} from "../shared/settings";
import { errorMessage, messages } from "./messages";
import { ActionButton, NoticeBox, type PluginLayout, type PluginTheme } from "./ui";

const EMPTY_INPUT = {};
const MAX_DIRECT_PEERS = 16;

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function DirectAccelerationSection({
  theme,
  layout,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const setDirect = useRpc(direct.set);

  const lastSyncedRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const [serverConfig, setServerConfig] = useState<DirectSettings | null>(null);
  const [enabledDraft, setEnabledDraft] = useState(DEFAULT_DIRECT.enabled);
  const [peersDraft, setPeersDraft] = useState<string[]>(DEFAULT_DIRECT.peers);
  const [dirty, setDirty] = useState(false);

  const [peerInput, setPeerInput] = useState("");
  const [peerError, setPeerError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setDirtyState = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  // 在同一次订阅回调中同步未编辑草稿，避免首帧闪烁，并保护正在编辑的状态与输入框。
  const onDirectEvent = useCallback((next: DirectSettings) => {
    setServerConfig(next);
    if (dirtyRef.current) return;
    const serialized = JSON.stringify(next);
    if (lastSyncedRef.current === serialized) return;
    lastSyncedRef.current = serialized;
    setEnabledDraft(next.enabled);
    setPeersDraft(next.peers);
    setSaveError(null);
  }, []);
  const directSub = useSubscription(direct.watch, EMPTY_INPUT, onDirectEvent);

  useEffect(() => {
    if (!serverConfig || dirty) return;
    const serialized = JSON.stringify(serverConfig);
    if (lastSyncedRef.current === serialized) return;
    lastSyncedRef.current = serialized;
    setEnabledDraft(serverConfig.enabled);
    setPeersDraft(serverConfig.peers);
    setSaveError(null);
  }, [dirty, serverConfig]);

  const updateDraftDirty = useCallback(
    (nextEnabled: boolean, nextPeers: readonly string[]) => {
      if (!serverConfig) {
        setDirtyState(true);
        return;
      }
      setDirtyState(
        nextEnabled !== serverConfig.enabled ||
          !sameStringArray(nextPeers, serverConfig.peers),
      );
    },
    [serverConfig, setDirtyState],
  );

  const handleAddPeer = useCallback(() => {
    const trimmed = peerInput.trim();
    if (!trimmed) return;

    const parsed = DirectPeerSchema.safeParse(trimmed);
    if (!parsed.success) {
      setPeerError(t("direct.peerInvalid"));
      return;
    }
    if (peersDraft.includes(parsed.data)) {
      setPeerError(t("direct.peerDuplicate"));
      return;
    }
    if (peersDraft.length >= MAX_DIRECT_PEERS) {
      setPeerError(t("direct.peersLimit", { max: MAX_DIRECT_PEERS }));
      return;
    }

    const nextPeers = [...peersDraft, parsed.data];
    setPeersDraft(nextPeers);
    setPeerInput("");
    setPeerError(null);
    setSaveError(null);
    updateDraftDirty(enabledDraft, nextPeers);
  }, [enabledDraft, peerInput, peersDraft, t, updateDraftDirty]);

  const handleRemovePeer = useCallback(
    (target: string) => {
      const nextPeers = peersDraft.filter((item) => item !== target);
      setPeersDraft(nextPeers);
      setPeerError(null);
      setSaveError(null);
      updateDraftDirty(enabledDraft, nextPeers);
    },
    [enabledDraft, peersDraft, updateDraftDirty],
  );

  const handleSave = useCallback(async () => {
    let nextPeers = peersDraft;
    const pendingInput = peerInput.trim();

    // 用户启用直连并在输入框中填了地址但未先点“添加”时，一并校验并纳入保存。
    if (enabledDraft && pendingInput) {
      const parsedPeer = DirectPeerSchema.safeParse(pendingInput);
      if (!parsedPeer.success) {
        setPeerError(t("direct.peerInvalid"));
        return;
      }
      if (!nextPeers.includes(parsedPeer.data)) {
        if (nextPeers.length >= MAX_DIRECT_PEERS) {
          setPeerError(t("direct.peersLimit", { max: MAX_DIRECT_PEERS }));
          return;
        }
        nextPeers = [...nextPeers, parsedPeer.data];
      }
    }

    const parsed = DirectSettingsSchema.safeParse({
      enabled: enabledDraft,
      peers: nextPeers,
    });
    if (!parsed.success) {
      setSaveError(t("direct.peerInvalid"));
      return;
    }

    setPeerError(null);
    setSaveError(null);
    setSaving(true);
    try {
      await setDirect(parsed.data);
      lastSyncedRef.current = JSON.stringify(parsed.data);
      setEnabledDraft(parsed.data.enabled);
      setPeersDraft(parsed.data.peers);
      if (enabledDraft && pendingInput) setPeerInput("");
      setDirtyState(false);
      toast.show(t("direct.saved"), { variant: "success" });
    } catch (err) {
      const msg = errorMessage(err);
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [enabledDraft, peerInput, peersDraft, setDirect, setDirtyState, t, toast]);

  const hasChanges = useMemo(() => {
    if (!serverConfig) return dirty;
    return (
      enabledDraft !== serverConfig.enabled ||
      !sameStringArray(peersDraft, serverConfig.peers)
    );
  }, [dirty, enabledDraft, peersDraft, serverConfig]);

  const noteItems = useMemo(
    () => [
      t("direct.noteFasterFallback"),
      t("direct.noteRendezvousOnly"),
      t("direct.noteEasyTierDownload"),
    ],
    [t],
  );

  const isLoadingInitial = !serverConfig && directSub.status === "connecting";
  const controlsDisabled = saving || !serverConfig;
  const atPeerLimit = peersDraft.length >= MAX_DIRECT_PEERS;

  return (
    <SettingsSection title={t("direct.sectionTitle")}>
      {directSub.status === "error" ? (
        <NoticeBox
          tone="danger"
          icon="AlertTriangle"
          items={[
            t("direct.watchError", {
              message: directSub.error.message,
            }),
          ]}
          theme={theme}
        />
      ) : null}

      {directSub.status === "closed" ? (
        <NoticeBox
          tone="warning"
          icon="Info"
          items={[t("direct.watchClosed")]}
          theme={theme}
        />
      ) : null}

      {isLoadingInitial ? (
        <SettingsCard>
          <SettingsRow label={t("direct.connecting")} />
        </SettingsCard>
      ) : serverConfig ? (
        <SettingsCard>
          <SettingsSwitch
            label={t("direct.enableLabel")}
            hint={t("direct.enableHint")}
            value={enabledDraft}
            disabled={controlsDisabled}
            onValueChange={(next) => {
              setEnabledDraft(next);
              setSaveError(null);
              updateDraftDirty(next, peersDraft);
            }}
          />

          <View
            style={[
              styles.peersBlock,
              {
                paddingVertical: layout.compact ? 12 : 14,
                paddingHorizontal: layout.compact ? 14 : 16,
              },
            ]}
          >
            <View style={styles.peersHeader}>
              <Text style={[styles.blockTitle, { color: theme.colors.foreground }]}>
                {t("direct.peersLabel")}
              </Text>
              <Text style={[styles.peersCount, { color: theme.colors.foregroundMuted }]}>
                {t("direct.peersCount", {
                  count: peersDraft.length,
                  max: MAX_DIRECT_PEERS,
                })}
              </Text>
            </View>

            <Text style={[styles.blockHint, { color: theme.colors.foregroundMuted }]}>
              {t("direct.peersHint", { max: MAX_DIRECT_PEERS })}
            </Text>

            {peersDraft.length === 0 ? (
              <Text
                style={[
                  styles.blockHint,
                  {
                    color: enabledDraft
                      ? theme.colors.statusWarning
                      : theme.colors.foregroundMuted,
                  },
                ]}
              >
                {enabledDraft ? t("direct.peersNeededHint") : t("direct.peersEmpty")}
              </Text>
            ) : (
              <View style={styles.peerList}>
                {peersDraft.map((peer) => (
                  <View
                    key={peer}
                    style={[
                      styles.peerRow,
                      {
                        backgroundColor: theme.colors.surface2,
                        borderColor: theme.colors.border,
                      },
                    ]}
                  >
                    <Text
                      selectable
                      numberOfLines={1}
                      style={[styles.peerAddress, { color: theme.colors.foreground }]}
                    >
                      {peer}
                    </Text>
                    <ActionButton
                      label={t("common.remove")}
                      theme={theme}
                      variant="outline"
                      compact
                      disabled={controlsDisabled}
                      onPress={() => handleRemovePeer(peer)}
                    />
                  </View>
                ))}
              </View>
            )}

            <View style={styles.addPeerRow}>
              <TextInput
                accessibilityLabel={t("direct.peerInputLabel")}
                placeholder={t("direct.peerPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                value={peerInput}
                onChangeText={(value) => {
                  setPeerInput(value);
                  if (peerError) setPeerError(null);
                }}
                onSubmitEditing={handleAddPeer}
                editable={!controlsDisabled && !atPeerLimit}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.peerInput,
                  {
                    color: theme.colors.foreground,
                    backgroundColor: theme.colors.surface2,
                    borderColor: peerError ? theme.colors.statusDanger : theme.colors.border,
                  },
                ]}
              />
              <ActionButton
                label={t("common.add")}
                icon="Plus"
                theme={theme}
                variant="outline"
                compact
                disabled={controlsDisabled || atPeerLimit || !peerInput.trim()}
                onPress={handleAddPeer}
              />
            </View>

            {peerError ? (
              <Text
                accessibilityRole="alert"
                style={[styles.errorText, { color: theme.colors.statusDanger }]}
              >
                {peerError}
              </Text>
            ) : null}
          </View>

          <SettingsAction
            label={t("direct.saveLabel")}
            error={saveError}
            actionLabel={saving ? t("common.saving") : t("common.save")}
            disabled={controlsDisabled || !hasChanges}
            onPress={() => void handleSave()}
          />
        </SettingsCard>
      ) : null}

      <NoticeBox tone="muted" icon="Info" items={noteItems} theme={theme} />
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  peersBlock: {
    gap: 10,
  },
  peersHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  blockTitle: {
    fontSize: 14,
    fontWeight: "500",
  },
  peersCount: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  blockHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  peerList: {
    gap: 8,
  },
  peerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderWidth: 1,
    borderRadius: 8,
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 6,
  },
  peerAddress: {
    flex: 1,
    fontSize: 13,
    fontFamily: "monospace",
  },
  addPeerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  peerInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
});
