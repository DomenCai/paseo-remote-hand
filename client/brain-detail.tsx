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
import { brains, type Brain, type BrainPolicy, type BrainStatus } from "../shared/settings";
import {
  brainStatusKey,
  errorMessage,
  formatTimestamp,
  messages,
  osIconName,
  osLabelKey,
} from "./messages";
import {
  ConfirmModal,
  NoticeBox,
  StatusBadge,
  type PluginTheme,
  type StatusTone,
} from "./ui";

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
  const revokeProject = useRpc(brains.revokeProject);

  const nameInputRef = useRef<SettingsInputHandle>(null);
  const [nameDraft, setNameDraft] = useState(brain.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const [savingPolicy, setSavingPolicy] = useState(false);
  const [confirmFullPolicy, setConfirmFullPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const [revokingRoots, setRevokingRoots] = useState<Record<string, boolean>>({});
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // 服务端推送名称变化时同步输入框内容。
  useEffect(() => {
    setNameDraft(brain.name);
    nameInputRef.current?.replaceText(brain.name);
    setNameError(null);
  }, [brain.brainId, brain.name]);

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
      toast.show(t("remoteMachines.renameSuccess"), { variant: "success" });
    } catch (err) {
      const msg = errorMessage(err);
      setNameError(msg);
      toast.error(msg);
    } finally {
      setSavingName(false);
    }
  }, [brain.brainId, brain.name, nameDraft, renameBrain, t, toast]);

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
      await removeBrain({ brainId: brain.brainId });
      toast.show(t("remoteMachines.removeSuccess"), { variant: "success" });
      setConfirmRemove(false);
      onBack();
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  }, [brain.brainId, onBack, removeBrain, t, toast]);

  const transportText =
    brain.transport === "direct"
      ? t("transport.direct")
      : brain.transport === "relay"
        ? t("transport.relay")
        : "—";

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

      {brain.lastError ? (
        <NoticeBox
          tone="danger"
          icon="AlertTriangle"
          title={t("remoteMachines.lastErrorLabel")}
          items={[brain.lastError]}
          theme={theme}
        />
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
            <Text style={[styles.valueText, { color: theme.colors.foreground }]}>
              {transportText}
            </Text>
          </SettingsRow>
          <SettingsRow label={t("remoteMachines.relayLabel")}>
            <Text selectable style={[styles.valueText, { color: theme.colors.foreground }]}>
              {brain.relay}
            </Text>
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
});
