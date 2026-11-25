import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import {
  Icon,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  useToast,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  brains,
  DEFAULT_RELAY,
  RelayAddressSchema,
  type Brain,
  type BrainPolicy,
  type BrainStatus,
} from "../shared/settings";
import {
  brainStatusKey,
  errorMessage,
  formatTimestamp,
  messages,
  osIconName,
  osLabelKey,
} from "./messages";
import {
  ActionButton,
  ConfirmModal,
  DirectFallbackNotice,
  NoticeBox,
  StatusBadge,
  TransportBadge,
  type PluginTheme,
  type StatusTone,
} from "./ui";

export function isDirectFallback(brain: Brain): boolean {
  return brain.status === "connected" && brain.transport === "relay" && Boolean(brain.lastError);
}

export function brainStatusTone(status: BrainStatus): StatusTone {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
    case "unverified":
      return "warning";
    case "revoked":
      return "danger";
    case "disconnected":
      return "muted";
  }
}

export function BrainDetailView({
  brain,
  theme,
  onBack,
}: {
  brain: Brain;
  theme: PluginTheme;
  onBack(): void;
}) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const renameBrain = useRpc(brains.rename);
  const removeBrain = useRpc(brains.remove);
  const setPolicy = useRpc(brains.setPolicy);
  const setRelay = useRpc(brains.setRelay);
  const revokeProject = useRpc(brains.revokeProject);

  const nameInputRef = useRef<SettingsInputHandle>(null);
  const lastSyncedNameRef = useRef(brain.name);
  const [nameDraft, setNameDraft] = useState(brain.name);
  const [nameDirty, setNameDirty] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const relayInputRef = useRef<SettingsInputHandle>(null);
  const lastSyncedRelayRef = useRef(brain.relay);
  const [relayDraft, setRelayDraft] = useState(brain.relay);
  const [relayDirty, setRelayDirty] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [savingRelay, setSavingRelay] = useState(false);

  const [savingPolicy, setSavingPolicy] = useState(false);
  const [confirmFullPolicy, setConfirmFullPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const [revokingRoots, setRevokingRoots] = useState<Record<string, boolean>>({});
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // 仅当服务端名称实际变化且用户未在编辑时同步，避免实时推送打断输入。
  useEffect(() => {
    if (nameDirty || lastSyncedNameRef.current === brain.name) return;
    lastSyncedNameRef.current = brain.name;
    setNameDraft(brain.name);
    nameInputRef.current?.replaceText(brain.name);
    setNameError(null);
  }, [brain.name, nameDirty]);

  // 仅当服务端 relay 实际变化且用户未在编辑时同步，避免实时状态推送打断输入。
  useEffect(() => {
    if (relayDirty || lastSyncedRelayRef.current === brain.relay) return;
    lastSyncedRelayRef.current = brain.relay;
    setRelayDraft(brain.relay);
    relayInputRef.current?.replaceText(brain.relay);
    setRelayError(null);
  }, [brain.relay, relayDirty]);

  const policyOptions = useMemo(
    () =>
      [
        { value: "restricted", label: t("policy.restricted") },
        { value: "full", label: t("policy.full") },
      ] as const,
    [t],
  );

  const handleRename = useCallback(async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNameError(t("remoteMachines.nameRequired"));
      return;
    }
    if (trimmed === brain.name) return;
    setNameError(null);
    setSavingName(true);
    try {
      await renameBrain({ brainId: brain.brainId, name: trimmed });
      lastSyncedNameRef.current = trimmed;
      setNameDraft(trimmed);
      nameInputRef.current?.replaceText(trimmed);
      setNameDirty(false);
      toast.show(t("remoteMachines.renameSuccess"), { variant: "success" });
    } catch (err) {
      const msg = errorMessage(err);
      setNameError(msg);
      toast.error(msg);
    } finally {
      setSavingName(false);
    }
  }, [brain.brainId, brain.name, nameDraft, renameBrain, t, toast]);

  const handleUpdateRelay = useCallback(async () => {
    const parsed = RelayAddressSchema.safeParse(relayDraft);
    if (!parsed.success) {
      setRelayError(t("remoteMachines.updateRelayInvalid"));
      return;
    }
    if (parsed.data === brain.relay) return;
    setRelayError(null);
    setSavingRelay(true);
    try {
      await setRelay({ brainId: brain.brainId, relay: parsed.data });
      lastSyncedRelayRef.current = parsed.data;
      setRelayDraft(parsed.data);
      relayInputRef.current?.replaceText(parsed.data);
      setRelayDirty(false);
      toast.show(t("remoteMachines.updateRelaySuccess"), { variant: "success" });
    } catch (err) {
      const msg = errorMessage(err);
      setRelayError(msg);
      toast.error(msg);
    } finally {
      setSavingRelay(false);
    }
  }, [brain.brainId, brain.relay, relayDraft, setRelay, t, toast]);

  const handleResetOfficialRelay = useCallback(() => {
    setRelayDraft(DEFAULT_RELAY);
    relayInputRef.current?.replaceText(DEFAULT_RELAY);
    setRelayDirty(DEFAULT_RELAY !== brain.relay);
    setRelayError(null);
  }, [brain.relay]);

  const applyPolicy = useCallback(
    async (nextPolicy: BrainPolicy) => {
      setPolicyError(null);
      setSavingPolicy(true);
      try {
        await setPolicy({ brainId: brain.brainId, policy: nextPolicy });
        toast.show(t("remoteMachines.policyUpdated"), { variant: "success" });
        setConfirmFullPolicy(false);
      } catch (err) {
        const msg = errorMessage(err);
        setPolicyError(msg);
        toast.error(msg);
      } finally {
        setSavingPolicy(false);
      }
    },
    [brain.brainId, setPolicy, t, toast],
  );

  const handlePolicyChange = useCallback(
    (nextPolicy: BrainPolicy) => {
      if (nextPolicy === brain.policy) return;
      if (nextPolicy === "full") {
        setPolicyError(null);
        setConfirmFullPolicy(true);
        return;
      }
      void applyPolicy(nextPolicy);
    },
    [applyPolicy, brain.policy],
  );

  const handleRevokeProject = useCallback(
    async (root: string) => {
      setRevokingRoots((current) => ({ ...current, [root]: true }));
      try {
        await revokeProject({ brainId: brain.brainId, root });
        toast.show(t("remoteMachines.projectRevoked"), { variant: "success" });
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setRevokingRoots((current) => {
          const next = { ...current };
          delete next[root];
          return next;
        });
      }
    },
    [brain.brainId, revokeProject, t, toast],
  );

  const handleConfirmRemove = useCallback(async () => {
    setRemoveError(null);
    setRemoving(true);
    try {
      const result = await removeBrain({ brainId: brain.brainId });
      toast.show(
        result.remoteRevoked
          ? t("remoteMachines.removeSuccess")
          : t("remoteMachines.removeSuccessLocalOnly"),
        { variant: result.remoteRevoked ? "success" : "warning" },
      );
      setConfirmRemove(false);
      onBack();
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  }, [brain.brainId, onBack, removeBrain, t, toast]);

  const directFallback = isDirectFallback(brain);
  const showRelayHint =
    (!directFallback && Boolean(brain.lastError)) || brain.status === "disconnected";
  const relayHasChanges = relayDraft.trim() !== brain.relay;

  const models = brain.models ?? [];

  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("remoteMachines.detailBack")}
        onPress={onBack}
        style={({ pressed }) => [styles.backButton, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Icon name="ChevronLeft" size={16} color={theme.colors.foregroundMuted} />
        <Text style={[styles.backText, { color: theme.colors.foregroundMuted }]}>
          {t("remoteMachines.detailBack")}
        </Text>
      </Pressable>

      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Icon name={osIconName(brain.os)} size={20} color={theme.colors.foreground} />
          <Text style={[styles.headerTitle, { color: theme.colors.foreground }]}>
            {brain.name}
          </Text>
        </View>
        <StatusBadge
          label={t(brainStatusKey(brain.status))}
          tone={brainStatusTone(brain.status)}
          theme={theme}
        />
      </View>

      {directFallback && brain.lastError ? (
        <DirectFallbackNotice
          title={t("remoteMachines.directFallbackTitle")}
          reason={brain.lastError}
          expandLabel={t("remoteMachines.directFallbackShowReason")}
          collapseLabel={t("remoteMachines.directFallbackHideReason")}
          theme={theme}
        />
      ) : null}

      {showRelayHint ? (
        <NoticeBox
          tone={brain.lastError ? "danger" : "warning"}
          icon="AlertTriangle"
          title={brain.lastError ? t("remoteMachines.lastErrorLabel") : t(brainStatusKey(brain.status))}
          items={
            brain.lastError
              ? [brain.lastError, t("remoteMachines.relayChangedHint")]
              : [t("remoteMachines.relayChangedHint")]
          }
          theme={theme}
        >
          <View style={styles.noticeActions}>
            <ActionButton
              label={t("remoteMachines.relayChangedFocusAction")}
              icon="Link2"
              theme={theme}
              variant="outline"
              compact
              onPress={() => relayInputRef.current?.focus()}
            />
          </View>
        </NoticeBox>
      ) : null}

      <SettingsSection title={t("remoteMachines.overviewSection")}>
        <SettingsCard>
          <SettingsRow label={t("remoteMachines.statusLabel")}>
            <StatusBadge
              label={t(brainStatusKey(brain.status))}
              tone={brainStatusTone(brain.status)}
              theme={theme}
            />
          </SettingsRow>
          <SettingsRow label={t("remoteMachines.osLabel")}>
            <Text style={[styles.valueText, { color: theme.colors.foreground }]}>
              {t(osLabelKey(brain.os))}
            </Text>
          </SettingsRow>
          <SettingsRow label={t("remoteMachines.transportLabel")}>
            {brain.transport ? (
              <TransportBadge
                transport={brain.transport}
                label={
                  brain.transport === "direct"
                    ? t("transport.direct")
                    : t("transport.relay")
                }
                theme={theme}
              />
            ) : (
              <Text style={[styles.valueText, { color: theme.colors.foregroundMuted }]}>—</Text>
            )}
          </SettingsRow>
          <SettingsInput
            ref={relayInputRef}
            label={t("remoteMachines.updateRelayLabel")}
            hint={t("remoteMachines.updateRelayHint")}
            initialValue={brain.relay}
            placeholder={t("remoteMachines.updateRelayPlaceholder")}
            error={relayError}
            disabled={savingRelay}
            onChangeText={(value) => {
              setRelayDraft(value);
              setRelayDirty(true);
              if (relayError) setRelayError(null);
            }}
          />
          <SettingsRow label={t("remoteMachines.updateRelayAction")}>
            <View style={styles.inlineActions}>
              {relayDraft.trim() !== DEFAULT_RELAY ? (
                <ActionButton
                  label={t("remoteMachines.useOfficialRelay")}
                  theme={theme}
                  variant="outline"
                  compact
                  disabled={savingRelay}
                  onPress={handleResetOfficialRelay}
                />
              ) : null}
              <ActionButton
                label={
                  savingRelay
                    ? t("remoteMachines.updateRelaySaving")
                    : t("remoteMachines.updateRelayAction")
                }
                theme={theme}
                variant="primary"
                compact
                disabled={savingRelay || !relayHasChanges}
                onPress={() => void handleUpdateRelay()}
              />
            </View>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("remoteMachines.identitySection")}>
        <SettingsCard>
          <SettingsInput
            ref={nameInputRef}
            label={t("remoteMachines.nameLabel")}
            initialValue={brain.name}
            placeholder={t("remoteMachines.namePlaceholder")}
            error={nameError}
            disabled={savingName}
            onChangeText={(value) => {
              setNameDraft(value);
              setNameDirty(true);
              if (nameError) setNameError(null);
            }}
          />
          <SettingsAction
            label={t("remoteMachines.renameAction")}
            actionLabel={savingName ? t("common.saving") : t("common.save")}
            disabled={savingName || !nameDraft.trim() || nameDraft.trim() === brain.name}
            onPress={() => void handleRename()}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("remoteMachines.permissionsSection")}>
        <SettingsCard>
          <SettingsSelect<BrainPolicy>
            label={t("remoteMachines.policyLabel")}
            hint={
              brain.policy === "full"
                ? t("remoteMachines.policyHintFull")
                : t("remoteMachines.policyHintRestricted")
            }
            error={confirmFullPolicy ? null : policyError}
            value={brain.policy}
            options={policyOptions}
            disabled={savingPolicy}
            onValueChange={handlePolicyChange}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("remoteMachines.projectsSection")}>
        <SettingsCard>
          {brain.projects.length === 0 ? (
            <SettingsRow label={t("remoteMachines.projectsEmpty")} />
          ) : (
            brain.projects.map((project) => (
              <SettingsAction
                key={project.root}
                label={project.root}
                hint={t("remoteMachines.projectGrantedAt", {
                  time: formatTimestamp(project.grantedAt, locale),
                })}
                actionLabel={t("common.revoke")}
                disabled={Boolean(revokingRoots[project.root])}
                onPress={() => void handleRevokeProject(project.root)}
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("remoteMachines.modelsSection")}>
        <SettingsCard>
          {models.length === 0 ? (
            <SettingsRow label={t("remoteMachines.modelsEmpty")} />
          ) : (
            models.map((model) => (
              <SettingsRow key={model.id} label={model.label} hint={model.id} />
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("remoteMachines.dangerSection")}>
        <SettingsCard>
          <SettingsAction
            label={t("remoteMachines.removeLabel")}
            hint={t("remoteMachines.removeHint")}
            actionLabel={t("remoteMachines.removeAction")}
            disabled={removing}
            onPress={() => {
              setRemoveError(null);
              setConfirmRemove(true);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <ConfirmModal
        open={confirmFullPolicy}
        title={t("remoteMachines.fullPolicyModalTitle")}
        body={t("remoteMachines.fullPolicyConfirmBody")}
        confirmLabel={t("remoteMachines.fullPolicyConfirmAction")}
        cancelLabel={t("common.cancel")}
        confirmVariant="danger"
        icon="ShieldAlert"
        busy={savingPolicy}
        error={policyError}
        theme={theme}
        onConfirm={() => void applyPolicy("full")}
        onClose={() => {
          setConfirmFullPolicy(false);
          setPolicyError(null);
        }}
      />

      <ConfirmModal
        open={confirmRemove}
        title={t("remoteMachines.removeModalTitle", { name: brain.name })}
        body={t("remoteMachines.removeConfirmBody", { name: brain.name })}
        confirmLabel={t("remoteMachines.removeAction")}
        cancelLabel={t("common.cancel")}
        confirmVariant="danger"
        icon="Trash2"
        busy={removing}
        error={removeError}
        theme={theme}
        onConfirm={() => void handleConfirmRemove()}
        onClose={() => {
          setConfirmRemove(false);
          setRemoveError(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 12,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    paddingVertical: 4,
  },
  backText: {
    fontSize: 13,
    fontWeight: "500",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 4,
  },
  headerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
    flexShrink: 1,
  },
  valueText: {
    fontSize: 14,
  },
  noticeActions: {
    flexDirection: "row",
    justifyContent: "flex-start",
    marginTop: 2,
  },
  inlineActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
});
