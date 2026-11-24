import {
  useSubscription,
  useTranslation,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { Icon, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { brains, type Brain } from "../shared/settings";
import { AddBrainModal } from "./add-brain-modal";
import { BrainDetailView, brainStatusTone } from "./brain-detail";
import {
  brainStatusKey,
  messages,
  osIconName,
  osLabelKey,
  policyShortKey,
} from "./messages";
import { ActionButton, EmptyStateCard, NoticeBox, StatusBadge } from "./ui";

const EMPTY_INPUT = {};

export function RemoteMachinesScreen({ theme, layout }: PluginSurfaceProps) {
  const { t } = useTranslation(messages);
  const [items, setItems] = useState<Brain[]>([]);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [selectedBrainId, setSelectedBrainId] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const onBrainsEvent = useCallback((next: Brain[]) => {
    setItems(next);
    setHasSnapshot(true);
  }, []);

  const subscription = useSubscription(brains.watch, EMPTY_INPUT, onBrainsEvent);

  const selectedBrain = selectedBrainId
    ? items.find((item) => item.brainId === selectedBrainId) ?? null
    : null;

  // 如果正在查看的机器已被移除，自动回到列表页。
  useEffect(() => {
    if (selectedBrainId && hasSnapshot && !selectedBrain) {
      setSelectedBrainId(null);
    }
  }, [hasSnapshot, selectedBrain, selectedBrainId]);

  if (selectedBrain) {
    return (
      <BrainDetailView
        brain={selectedBrain}
        theme={theme}
        onBack={() => setSelectedBrainId(null)}
      />
    );
  }

  return (
    <View style={styles.root}>
      <SettingsSection
        title={t("remoteMachines.sectionTitle")}
        trailing={
          <ActionButton
            label={t("remoteMachines.addButton")}
            icon="Plus"
            theme={theme}
            variant="primary"
            compact
            onPress={() => setAddModalOpen(true)}
          />
        }
      >
        {subscription.status === "error" ? (
          <NoticeBox
            tone="danger"
            icon="AlertTriangle"
            items={[
              t("remoteMachines.subscriptionError", {
                message: subscription.error.message,
              }),
            ]}
            theme={theme}
          />
        ) : null}

        {subscription.status === "closed" ? (
          <NoticeBox
            tone="warning"
            icon="Info"
            items={[t("remoteMachines.subscriptionClosed")]}
            theme={theme}
          />
        ) : null}

        {!hasSnapshot && subscription.status === "connecting" ? (
          <SettingsCard>
            <SettingsRow label={t("remoteMachines.subscriptionConnecting")} />
          </SettingsCard>
        ) : items.length === 0 ? (
          <EmptyStateCard
            icon="Server"
            title={t("remoteMachines.emptyTitle")}
            description={t("remoteMachines.emptyDescription")}
            theme={theme}
            layout={layout}
            action={
              <ActionButton
                label={t("remoteMachines.addButton")}
                icon="Plus"
                theme={theme}
                variant="primary"
                onPress={() => setAddModalOpen(true)}
              />
            }
          />
        ) : (
          <SettingsCard>
            {items.map((brain) => {
              const metaParts = [
                t(osLabelKey(brain.os)),
                brain.transport === "direct"
                  ? t("transport.direct")
                  : brain.transport === "relay"
                    ? t("transport.relay")
                    : null,
                t(policyShortKey(brain.policy)),
              ].filter((part): part is string => part !== null);

              return (
                <Pressable
                  key={brain.brainId}
                  accessibilityRole="button"
                  accessibilityLabel={brain.name}
                  onPress={() => setSelectedBrainId(brain.brainId)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      paddingVertical: layout.compact ? 12 : 14,
                      paddingHorizontal: layout.compact ? 14 : 16,
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <View style={styles.rowLeading}>
                    <Icon
                      name={osIconName(brain.os)}
                      size={18}
                      color={theme.colors.foregroundMuted}
                    />
                  </View>
                  <View style={styles.rowMain}>
                    <View style={styles.rowTop}>
                      <Text
                        numberOfLines={1}
                        style={[styles.rowTitle, { color: theme.colors.foreground }]}
                      >
                        {brain.name}
                      </Text>
                      <StatusBadge
                        label={t(brainStatusKey(brain.status))}
                        tone={brainStatusTone(brain.status)}
                        theme={theme}
                      />
                    </View>
                    <Text
                      numberOfLines={1}
                      style={[styles.rowMeta, { color: theme.colors.foregroundMuted }]}
                    >
                      {metaParts.join(" · ")}
                    </Text>
                    {brain.lastError ? (
                      <Text
                        numberOfLines={2}
                        style={[styles.rowError, { color: theme.colors.statusDanger }]}
                      >
                        {brain.lastError}
                      </Text>
                    ) : null}
                  </View>
                  <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
                </Pressable>
              );
            })}
          </SettingsCard>
        )}
      </SettingsSection>

      <AddBrainModal
        open={addModalOpen}
        theme={theme}
        onClose={() => setAddModalOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowLeading: {
    width: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "500",
    flexShrink: 1,
  },
  rowMeta: {
    fontSize: 13,
  },
  rowError: {
    fontSize: 12,
    lineHeight: 16,
  },
});
