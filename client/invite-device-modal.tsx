import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { devices } from "../shared/settings";
import {
  errorMessage,
  formatRemainingDuration,
  formatTimestamp,
  messages,
} from "./messages";
import { ActionButton, NoticeBox, type PluginTheme } from "./ui";

interface InviteResult {
  pairingCode: string;
  expiresAt: string;
}

export function InviteDeviceModal({
  open,
  theme,
  onClose,
}: {
  open: boolean;
  theme: PluginTheme;
  onClose(): void;
}) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const inviteDevice = useRpc(devices.invite);

  const [label, setLabel] = useState("");
  const [result, setResult] = useState<InviteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 关闭后立即清空配对码，确保配对码只显示一次且不滞留状态。
  useEffect(() => {
    if (!open) {
      setLabel("");
      setResult(null);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  // 显示配对码期间每秒刷新剩余有效期。
  useEffect(() => {
    if (!open || !result) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, result]);

  const handleGenerate = useCallback(async () => {
    const trimmed = label.trim();
    setError(null);
    setBusy(true);
    try {
      const next = await inviteDevice(trimmed ? { label: trimmed } : {});
      setResult(next);
      setNowMs(Date.now());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [inviteDevice, label]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    try {
      await copyText(result.pairingCode);
      toast.show(t("common.copied"), { variant: "success" });
    } catch {
      toast.error(t("common.copyFailed"));
    }
  }, [result, t, toast]);

  const remaining = result ? formatRemainingDuration(result.expiresAt, nowMs) : null;

  return (
    <Modal
      title={t("invite.modalTitle")}
      icon={<Icon name="Link2" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal.Content>
        {result === null ? (
          <View style={styles.section}>
            <Text style={[styles.label, { color: theme.colors.foreground }]}>
              {t("invite.labelField")}
            </Text>
            <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
              {t("invite.labelHint")}
            </Text>
            <TextInput
              accessibilityLabel={t("invite.labelField")}
              placeholder={t("invite.labelPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              value={label}
              onChangeText={(value) => {
                setLabel(value);
                if (error) setError(null);
              }}
              editable={!busy}
              style={[
                styles.input,
                {
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface2,
                  borderColor: theme.colors.border,
                },
              ]}
            />
            {error ? (
              <Text
                accessibilityRole="alert"
                style={[styles.errorText, { color: theme.colors.statusDanger }]}
              >
                {error}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <ActionButton
                label={t("common.cancel")}
                theme={theme}
                variant="outline"
                disabled={busy}
                onPress={onClose}
              />
              <ActionButton
                label={busy ? t("invite.generatingAction") : t("invite.generateAction")}
                theme={theme}
                variant="primary"
                disabled={busy}
                onPress={() => void handleGenerate()}
              />
            </View>
          </View>
        ) : (
          <View style={styles.section}>
            <NoticeBox
              tone="warning"
              icon="ShieldAlert"
              items={[t("invite.secretWarning"), t("invite.onceNotice")]}
              theme={theme}
            />

            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: theme.colors.foreground }]}>
                {t("invite.codeLabel")}
              </Text>
              <View
                style={[
                  styles.codeBox,
                  {
                    backgroundColor: theme.colors.surface2,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                <Text selectable style={[styles.codeText, { color: theme.colors.foreground }]}>
                  {result.pairingCode}
                </Text>
              </View>
            </View>

            <View style={styles.expiryRow}>
              <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
                {t("invite.expiresAt", { time: formatTimestamp(result.expiresAt, locale) })}
              </Text>
              <Text
                style={[
                  styles.countdown,
                  {
                    color: remaining
                      ? theme.colors.statusWarning
                      : theme.colors.statusDanger,
                  },
                ]}
              >
                {remaining ? t("invite.expiresIn", { remaining }) : t("invite.expired")}
              </Text>
            </View>

            <View style={styles.actions}>
              <ActionButton
                label={t("invite.copyAction")}
                icon="Copy"
                theme={theme}
                variant="outline"
                onPress={() => void handleCopy()}
              />
              <ActionButton
                label={t("common.done")}
                theme={theme}
                variant="primary"
                onPress={onClose}
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
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  codeBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  codeText: {
    fontSize: 13,
    lineHeight: 20,
    fontFamily: "monospace",
  },
  expiryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  countdown: {
    fontSize: 13,
    fontWeight: "600",
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
