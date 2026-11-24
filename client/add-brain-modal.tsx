import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, Modal, SettingsCard, SettingsRow, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  brains,
  RISKS_NOT_ACKNOWLEDGED,
  type BrainPreview,
} from "../shared/settings";
import { errorMessage, messages, osLabelKey } from "./messages";
import { ActionButton, NoticeBox, type PluginTheme } from "./ui";

export function AddBrainModal({
  open,
  theme,
  onClose,
}: {
  open: boolean;
  theme: PluginTheme;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const previewBrain = useRpc(brains.preview);
  const addBrain = useRpc(brains.add);

  const [pairingCode, setPairingCode] = useState("");
  const [preview, setPreview] = useState<BrainPreview | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [checkedRisks, setCheckedRisks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"preview" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [risksUpdated, setRisksUpdated] = useState(false);

  // 关闭弹窗时立即清理配对码和中间状态，避免秘密滞留内存。
  useEffect(() => {
    if (!open) {
      setPairingCode("");
      setPreview(null);
      setDisplayName("");
      setCheckedRisks({});
      setBusy(null);
      setError(null);
      setRisksUpdated(false);
    }
  }, [open]);

  const handlePreview = useCallback(async () => {
    const trimmed = pairingCode.trim();
    if (!trimmed) {
      setError(t("addBrain.codeRequired"));
      return;
    }
    setError(null);
    setRisksUpdated(false);
    setBusy("preview");
    try {
      const result = await previewBrain({ pairingCode: trimmed });
      setPreview(result);
      setDisplayName(result.brainName);
      setCheckedRisks({});
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [pairingCode, previewBrain, t]);

  const toggleRisk = useCallback((code: string) => {
    setCheckedRisks((current) => ({ ...current, [code]: !current[code] }));
  }, []);

  const allRisksChecked =
    preview !== null && preview.risks.every((risk) => checkedRisks[risk.code] === true);

  const handleSubmit = useCallback(async () => {
    if (!preview) return;
    const trimmedCode = pairingCode.trim();
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setError(t("remoteMachines.nameRequired"));
      return;
    }
    if (!allRisksChecked) return;

    setError(null);
    setRisksUpdated(false);
    setBusy("add");
    try {
      await addBrain({
        pairingCode: trimmedCode,
        name: trimmedName,
        acknowledgedRiskCodes: preview.risks.map((risk) => risk.code),
      });
      toast.show(t("addBrain.addSuccess", { name: trimmedName }), { variant: "success" });
      onClose();
    } catch (err) {
      const msg = errorMessage(err);
      if (msg === RISKS_NOT_ACKNOWLEDGED || msg.includes("RISKS_NOT_ACKNOWLEDGED")) {
        // 风险列表在 preview 与 add 之间发生变化时，自动重新获取最新风险并要求逐条确认。
        try {
          const refreshed = await previewBrain({ pairingCode: trimmedCode });
          setPreview(refreshed);
          setCheckedRisks({});
          setRisksUpdated(true);
        } catch (previewErr) {
          setError(errorMessage(previewErr));
        }
      } else {
        setError(msg);
      }
    } finally {
      setBusy(null);
    }
  }, [preview, pairingCode, displayName, allRisksChecked, addBrain, previewBrain, toast, t, onClose]);

  const handleBackToCode = useCallback(() => {
    setPreview(null);
    setCheckedRisks({});
    setError(null);
    setRisksUpdated(false);
  }, []);

  return (
    <Modal
      title={t("addBrain.modalTitle")}
      icon={<Icon name="Server" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={(next) => {
        if (!next && busy === null) onClose();
      }}
    >
      <Modal.Content>
        {preview === null ? (
          <View style={styles.section}>
            <Text style={[styles.label, { color: theme.colors.foreground }]}>
              {t("addBrain.codeLabel")}
            </Text>
            <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
              {t("addBrain.codeHint")}
            </Text>
            <TextInput
              accessibilityLabel={t("addBrain.codeLabel")}
              placeholder={t("addBrain.codePlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              value={pairingCode}
              onChangeText={(value) => {
                setPairingCode(value);
                if (error) setError(null);
              }}
              editable={busy === null}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.codeInput,
                {
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                  borderColor: theme.colors.border,
                },
              ]}
            />
            {error ? (
              <Text accessibilityRole="alert" style={[styles.errorText, { color: theme.colors.statusDanger }]}>
                {error}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <ActionButton
                label={t("common.cancel")}
                theme={theme}
                variant="outline"
                disabled={busy !== null}
                onPress={onClose}
              />
              <ActionButton
                label={busy === "preview" ? t("addBrain.previewLoading") : t("common.next")}
                theme={theme}
                variant="primary"
                disabled={busy !== null || !pairingCode.trim()}
                onPress={() => void handlePreview()}
              />
            </View>
          </View>
        ) : (
          <View style={styles.section}>
            <View style={styles.previewHeader}>
              <Text style={[styles.sectionTitle, { color: theme.colors.foregroundMuted }]}>
                {t("addBrain.previewSection")}
              </Text>
              <ActionButton
                label={t("addBrain.changeCode")}
                theme={theme}
                variant="outline"
                compact
                disabled={busy !== null}
                onPress={handleBackToCode}
              />
            </View>

            <SettingsCard>
              <SettingsRow label={t("addBrain.machineName")}>
                <Text style={[styles.valueText, { color: theme.colors.foreground }]}>
                  {preview.brainName}
                </Text>
              </SettingsRow>
              <SettingsRow label={t("addBrain.system")}>
                <Text style={[styles.valueText, { color: theme.colors.foreground }]}>
                  {t(osLabelKey(preview.os))}
                </Text>
              </SettingsRow>
              <SettingsRow label={t("addBrain.relay")}>
                <Text style={[styles.valueText, { color: theme.colors.foreground }]}>
                  {preview.relay}
                </Text>
              </SettingsRow>
            </SettingsCard>

            {risksUpdated ? (
              <NoticeBox
                tone="warning"
                icon="AlertTriangle"
                items={[t("addBrain.risksUpdatedWarning")]}
                theme={theme}
              />
            ) : null}

            {preview.risks.length > 0 ? (
              <NoticeBox
                tone="warning"
                icon="ShieldAlert"
                title={t("addBrain.risksTitle")}
                theme={theme}
              >
                <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
                  {t("addBrain.risksHint")}
                </Text>
                <View style={styles.riskList}>
                  {preview.risks.map((risk) => {
                    const checked = checkedRisks[risk.code] === true;
                    return (
                      <Pressable
                        key={risk.code}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked, disabled: busy !== null }}
                        disabled={busy !== null}
                        onPress={() => toggleRisk(risk.code)}
                        style={[
                          styles.riskItem,
                          {
                            backgroundColor: theme.colors.surface2,
                            borderColor: checked ? theme.colors.accent : theme.colors.border,
                          },
                        ]}
                      >
                        <View
                          style={[
                            styles.checkbox,
                            {
                              borderColor: checked ? theme.colors.accent : theme.colors.border,
                              backgroundColor: checked ? theme.colors.accent : theme.colors.surface0,
                            },
                          ]}
                        >
                          {checked ? (
                            <Icon name="Check" size={12} color={theme.colors.accentForeground} />
                          ) : null}
                        </View>
                        <Text style={[styles.riskText, { color: theme.colors.foreground }]}>
                          {risk.message}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </NoticeBox>
            ) : null}

            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: theme.colors.foreground }]}>
                {t("addBrain.displayNameLabel")}
              </Text>
              <TextInput
                accessibilityLabel={t("addBrain.displayNameLabel")}
                placeholder={t("addBrain.displayNamePlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                value={displayName}
                onChangeText={(value) => {
                  setDisplayName(value);
                  if (error) setError(null);
                }}
                editable={busy === null}
                style={[
                  styles.nameInput,
                  {
                    color: theme.colors.foreground,
                    backgroundColor: theme.colors.surface2,
                    borderColor: theme.colors.border,
                  },
                ]}
              />
            </View>

            {error ? (
              <Text accessibilityRole="alert" style={[styles.errorText, { color: theme.colors.statusDanger }]}>
                {error}
              </Text>
            ) : null}

            <View style={styles.actions}>
              <ActionButton
                label={t("common.cancel")}
                theme={theme}
                variant="outline"
                disabled={busy !== null}
                onPress={onClose}
              />
              <ActionButton
                label={busy === "add" ? t("addBrain.submittingAction") : t("addBrain.submitAction")}
                theme={theme}
                variant="primary"
                disabled={busy !== null || !displayName.trim() || !allRisksChecked}
                onPress={() => void handleSubmit()}
              />
            </View>
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 14,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "500",
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
  },
  valueText: {
    fontSize: 14,
  },
  codeInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 88,
    fontSize: 13,
    textAlignVertical: "top",
  },
  nameInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  riskList: {
    gap: 8,
  },
  riskItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  riskText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
});
