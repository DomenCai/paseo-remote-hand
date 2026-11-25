import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export type PluginTheme = PluginSurfaceProps["theme"];
export type PluginLayout = PluginSurfaceProps["layout"];
export type StatusTone = "success" | "warning" | "danger" | "muted";
export type ButtonVariant = "primary" | "outline" | "danger";

export function toneColor(theme: PluginTheme, tone: StatusTone): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "muted":
      return theme.colors.foregroundMuted;
  }
}

export function ActionButton({
  label,
  onPress,
  theme,
  variant = "outline",
  icon,
  disabled = false,
  compact = false,
  accessibilityLabel,
}: {
  label: string;
  onPress(): void;
  theme: PluginTheme;
  variant?: ButtonVariant;
  icon?: string;
  disabled?: boolean;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const colors = useMemo(() => {
    if (variant === "primary") {
      return {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
        textColor: theme.colors.accentForeground,
      };
    }
    if (variant === "danger") {
      return {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.statusDanger,
        textColor: theme.colors.statusDanger,
      };
    }
    return {
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      textColor: theme.colors.foreground,
    };
  }, [theme, variant]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact ? styles.buttonCompact : null,
        {
          backgroundColor: colors.backgroundColor,
          borderColor: colors.borderColor,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      {icon ? <Icon name={icon} size={14} color={colors.textColor} /> : null}
      <Text style={[styles.buttonText, { color: colors.textColor }]}>{label}</Text>
    </Pressable>
  );
}

export function StatusBadge({
  label,
  tone,
  theme,
}: {
  label: string;
  tone: StatusTone;
  theme: PluginTheme;
}) {
  const color = toneColor(theme, tone);
  return (
    <View style={styles.badge}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function TransportBadge({
  transport,
  label,
  theme,
}: {
  transport: "direct" | "relay";
  label: string;
  theme: PluginTheme;
}) {
  const isDirect = transport === "direct";
  return (
    <View
      style={[
        styles.transportBadge,
        {
          backgroundColor: isDirect ? theme.colors.accent : theme.colors.surface2,
          borderColor: isDirect ? theme.colors.accent : theme.colors.border,
        },
      ]}
    >
      {isDirect ? (
        <Icon name="Zap" size={11} color={theme.colors.accentForeground} />
      ) : null}
      <Text
        style={[
          styles.transportBadgeText,
          {
            color: isDirect ? theme.colors.accentForeground : theme.colors.foregroundMuted,
            fontWeight: isDirect ? "600" : "500",
          },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

export function DirectFallbackNotice({
  title,
  reason,
  expandLabel,
  collapseLabel,
  theme,
  compact = false,
}: {
  title: string;
  reason: string;
  expandLabel: string;
  collapseLabel: string;
  theme: PluginTheme;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View
      style={[
        compact ? styles.fallbackCompact : styles.fallbackBox,
        {
          backgroundColor: compact ? theme.colors.surface2 : theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View style={styles.fallbackHeader}>
        <View style={styles.fallbackTitleRow}>
          <Icon name="Info" size={14} color={theme.colors.foregroundMuted} />
          <Text
            style={[
              styles.fallbackTitle,
              { color: compact ? theme.colors.foregroundMuted : theme.colors.foreground },
            ]}
          >
            {title}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((current) => !current)}
          style={({ pressed }) => [styles.fallbackToggle, { opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.fallbackToggleText, { color: theme.colors.foregroundMuted }]}>
            {expanded ? collapseLabel : expandLabel}
          </Text>
          <Icon
            name={expanded ? "ChevronUp" : "ChevronDown"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
      </View>
      {expanded ? (
        <Text
          selectable
          style={[
            styles.fallbackReason,
            {
              color: theme.colors.foregroundMuted,
              backgroundColor: compact ? theme.colors.surface1 : theme.colors.surface2,
              borderColor: theme.colors.border,
            },
          ]}
        >
          {reason}
        </Text>
      ) : null}
    </View>
  );
}

export function NoticeBox({
  tone,
  icon,
  title,
  items,
  theme,
  children,
}: {
  tone: "warning" | "danger" | "muted";
  icon: string;
  title?: string;
  items?: readonly string[];
  theme: PluginTheme;
  children?: ReactNode;
}) {
  const accent = toneColor(theme, tone);
  const borderColor = tone === "muted" ? theme.colors.border : accent;
  return (
    <View
      style={[
        styles.noticeBox,
        {
          backgroundColor: theme.colors.surface1,
          borderColor,
        },
      ]}
    >
      {title ? (
        <View style={styles.noticeHeader}>
          <Icon name={icon} size={16} color={accent} />
          <Text style={[styles.noticeTitle, { color: accent }]}>{title}</Text>
        </View>
      ) : null}
      {items?.map((item, index) => (
        <View key={`${index}-${item}`} style={styles.noticeItem}>
          {!title ? <Icon name={icon} size={15} color={accent} /> : <Text style={{ color: accent }}>•</Text>}
          <Text style={[styles.noticeBody, { color: theme.colors.foreground }]}>{item}</Text>
        </View>
      ))}
      {children}
    </View>
  );
}

export function EmptyStateCard({
  icon,
  title,
  description,
  theme,
  layout,
  action,
}: {
  icon: string;
  title: string;
  description: string;
  theme: PluginTheme;
  layout: PluginLayout;
  action?: ReactNode;
}) {
  return (
    <View
      style={[
        styles.emptyCard,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          padding: layout.compact ? 20 : 28,
        },
      ]}
    >
      <View
        style={[
          styles.emptyIconWrap,
          { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border },
        ]}
      >
        <Icon name={icon} size={22} color={theme.colors.foregroundMuted} />
      </View>
      <Text style={[styles.emptyTitle, { color: theme.colors.foreground }]}>{title}</Text>
      <Text style={[styles.emptyDescription, { color: theme.colors.foregroundMuted }]}>
        {description}
      </Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  confirmVariant = "danger",
  icon = "AlertTriangle",
  busy = false,
  error,
  theme,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmVariant?: "danger" | "primary";
  icon?: string;
  busy?: boolean;
  error?: string | null;
  theme: PluginTheme;
  onConfirm(): void;
  onClose(): void;
}) {
  const iconColor =
    confirmVariant === "danger" ? theme.colors.statusDanger : theme.colors.statusWarning;
  return (
    <Modal
      title={title}
      icon={<Icon name={icon} size={18} color={iconColor} />}
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal.Content>
        <Text style={[styles.confirmBody, { color: theme.colors.foreground }]}>{body}</Text>
        {error ? (
          <Text accessibilityRole="alert" style={[styles.errorText, { color: theme.colors.statusDanger }]}>
            {error}
          </Text>
        ) : null}
        <View style={styles.modalActions}>
          <ActionButton
            label={cancelLabel}
            theme={theme}
            variant="outline"
            disabled={busy}
            onPress={onClose}
          />
          <ActionButton
            label={confirmLabel}
            theme={theme}
            variant={confirmVariant}
            disabled={busy}
            onPress={onConfirm}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  buttonCompact: {
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  buttonText: {
    fontSize: 13,
    fontWeight: "500",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 13,
    fontWeight: "500",
  },
  transportBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  transportBadgeText: {
    fontSize: 12,
    lineHeight: 16,
  },
  fallbackBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  fallbackCompact: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  fallbackHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  fallbackTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  fallbackTitle: {
    fontSize: 12,
    lineHeight: 17,
    flexShrink: 1,
  },
  fallbackToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 2,
  },
  fallbackToggleText: {
    fontSize: 12,
    fontWeight: "500",
  },
  fallbackReason: {
    fontSize: 12,
    lineHeight: 17,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  noticeBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 8,
  },
  noticeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  noticeTitle: {
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  noticeItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  noticeBody: {
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    gap: 10,
  },
  emptyIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyDescription: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    maxWidth: 440,
  },
  emptyAction: {
    marginTop: 6,
  },
  confirmBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
});
