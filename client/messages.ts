import { defineTranslations } from "@getpaseo/plugin/client";
import type { BrainOs, BrainPolicy, BrainStatus, Endpoint } from "../shared/settings";

export const messages = defineTranslations({
  resources: {
    en: {
      screens: {
        remoteMachines: "Remote machines",
        connectedDevices: "Connected devices",
      },
      common: {
        cancel: "Cancel",
        confirm: "Confirm",
        save: "Save",
        saving: "Saving…",
        saved: "Saved",
        close: "Close",
        done: "Done",
        back: "Back",
        copy: "Copy",
        copied: "Copied",
        copyFailed: "Could not copy. Select the text and copy it manually.",
        refresh: "Refresh",
        retry: "Retry",
        loading: "Loading…",
        remove: "Remove",
        revoke: "Revoke",
        add: "Add",
        next: "Continue",
        unknown: "Unknown",
        none: "None",
      },
      os: {
        darwin: "macOS",
        linux: "Linux",
        win32: "Windows",
        unknown: "Unknown OS",
      },
      brainStatus: {
        connected: "Connected",
        connecting: "Connecting",
        disconnected: "Disconnected",
        unverified: "Unverified",
        revoked: "Revoked",
      },
      endpointStatus: {
        connected: "Connected",
        connecting: "Connecting",
        disconnected: "Disconnected",
      },
      transport: {
        relay: "Relay",
        direct: "Direct",
      },
      policy: {
        restricted: "Restricted (default)",
        restrictedShort: "Restricted",
        full: "Full",
      },
      remoteMachines: {
        sectionTitle: "Remote machines",
        addButton: "Add machine",
        emptyTitle: "No remote machines yet",
        emptyDescription:
          "Use providers hosted on another machine directly from your local workspaces. Open \"Connected devices\" on the remote machine to generate a pairing code, then paste it here.",
        subscriptionConnecting: "Connecting to plugin service…",
        subscriptionError: "Unable to load remote machines: {{message}}",
        subscriptionClosed: "Connection to plugin service closed.",
        relayMeta: "Relay: {{relay}}",
        detailBack: "Remote machines",
        overviewSection: "Connection",
        statusLabel: "Status",
        osLabel: "System",
        transportLabel: "Transport",
        relayLabel: "Relay",
        lastErrorLabel: "Last error",
        directFallbackTitle: "Direct connection unavailable, using relay",
        directFallbackShowReason: "Show reason",
        directFallbackHideReason: "Hide reason",
        directRetryIn: "retrying in {{seconds}}s",
        directRetrying: "retrying…",
        directNoRetry: "won't retry until direct settings change",
        directRetryNow: "Retry now",
        updateRelayLabel: "Update relay address",
        updateRelayHint:
          "Keeps the existing pairing identity and reconnects through the new relay.",
        updateRelayPlaceholder: "host:port",
        updateRelayInvalid:
          "Enter a valid relay address in host:port format (use [IPv6]:port for IPv6).",
        updateRelayAction: "Update relay",
        updateRelaySaving: "Updating…",
        updateRelaySuccess: "Relay address updated. Reconnecting…",
        relayChangedHint:
          "If the remote machine switched relay addresses, paste the new address under \"Update relay address\" below—no need to pair again.",
        relayChangedFocusAction: "Update relay address",
        useOfficialRelay: "Use official relay",
        identitySection: "Display name",
        nameLabel: "Name",
        namePlaceholder: "e.g. Mac mini",
        nameRequired: "Enter a display name.",
        renameAction: "Save name",
        renameSuccess: "Display name updated",
        permissionsSection: "Permissions",
        policyLabel: "Permission level",
        policyHintRestricted:
          "File tools can only access authorized project directories. Running commands is disabled.",
        policyHintFull:
          "File tools and command execution are both enabled for this remote machine.",
        policyUpdated: "Permission level updated",
        fullPolicyModalTitle: "Switch to full permissions",
        fullPolicyConfirmBody:
          "Agents on this machine will be able to run arbitrary commands as your user.",
        fullPolicyConfirmAction: "Enable full permissions",
        projectsSection: "Authorized projects",
        projectsEmpty:
          "No authorized projects yet. Projects are added automatically the first time you use this machine in a workspace.",
        projectGrantedAt: "Authorized {{time}}",
        projectRevoked: "Project access revoked",
        modelsSection: "Available models",
        modelsEmpty: "No models reported yet.",
        dangerSection: "Remove machine",
        removeLabel: "Remove this remote machine",
        removeHint: "Removes the machine from this computer and revokes this device's access on it.",
        removeAction: "Remove",
        removeModalTitle: "Remove {{name}}",
        removeConfirmBody:
          "Remove \"{{name}}\"? This device's access on that machine will also be revoked.",
        removeSuccess: "Remote machine removed",
        removeSuccessLocalOnly:
          "Removed locally. The remote machine was unreachable; revoke this device there if needed.",
      },
      addBrain: {
        modalTitle: "Add remote machine",
        codeLabel: "Pairing code",
        codeHint:
          "Generate a one-time pairing code under \"Connected devices\" on the remote machine and paste it here.",
        codePlaceholder: "Paste pairing code",
        codeRequired: "Paste a pairing code to continue.",
        previewLoading: "Verifying pairing code…",
        previewSection: "Machine details",
        machineName: "Machine name",
        system: "System",
        relay: "Relay",
        changeCode: "Change code",
        risksTitle: "Confirm risks before continuing",
        risksHint: "Review and check every item below to enable adding this machine.",
        risksUpdatedWarning:
          "The remote machine's risk notices changed. Review and confirm every item below, then try again.",
        displayNameLabel: "Display name",
        displayNamePlaceholder: "Name shown in model picker",
        submitAction: "Add remote machine",
        submittingAction: "Adding…",
        addSuccess: "Added {{name}}",
      },
      connectedDevices: {
        endpointSection: "Local endpoint",
        statusLabel: "Status",
        fingerprintLabel: "Fingerprint",
        lastErrorLabel: "Last error",
        relayLabel: "Relay address",
        relayHint:
          "Default is the official relay ({{defaultRelay}}). Online devices follow automatically; offline devices can update the address on their \"Remote machines\" page.",
        relayPlaceholder: "host:port",
        relayInvalid:
          "Enter a valid relay address in host:port format (use [IPv6]:port for IPv6).",
        useOfficialRelay: "Use official relay",
        saveRelay: "Save relay",
        relaySaved: "Relay switch started",
        relaySwitchedTitle: "Relay address updated",
        relaySwitchedNotice:
          "Online devices will follow automatically. Offline devices need to update the address on their \"Remote machines\" page.",
        copyNewRelay: "Copy new address",
        endpointConnecting: "Connecting to plugin service…",
        endpointWatchError: "Unable to watch local endpoint: {{message}}",
        endpointWatchClosed: "Endpoint status stream closed.",
        risksSection: "Security & visibility notices",
        fixedRiskNativeTools:
          "Remote agents' native tools can access files belonging to this local user account.",
        fixedRiskSharedSessions:
          "When multiple people share this machine, everyone's sessions are visible to each other in local Paseo.",
        devicesSection: "Paired devices",
        inviteButton: "Invite device",
        devicesEmptyTitle: "No connected devices yet",
        devicesEmptyDescription:
          "Generate a one-time pairing code to let another computer use this machine's providers.",
        devicesConnecting: "Connecting to plugin service…",
        devicesError: "Unable to load devices: {{message}}",
        devicesClosed: "Connection to plugin service closed.",
        deviceOnline: "Online",
        deviceOffline: "Offline",
        deviceLastSeen: "Last seen {{time}}",
        deviceSessions_one: "{{count}} running session",
        deviceSessions_other: "{{count}} running sessions",
        revokeModalTitle: "Revoke {{name}}",
        revokeConfirmBody:
          "Revoke \"{{name}}\"? Active connections will close immediately and in-flight requests will be cancelled.",
        revokeSuccess: "Device revoked",
        accessSection: "Access control",
        accessLoadError: "Unable to load access control: {{message}}",
        allowAllProvidersLabel: "Allow all providers",
        allowAllProvidersHint:
          "Paired devices can use every provider available on this machine.",
        allowedProvidersLabel: "Allowed providers",
        allowedProvidersHint:
          "Select which providers paired devices may use. Leave \"Allow all providers\" enabled to permit all.",
        discoveredProvidersEmpty: "No providers discovered automatically. Add a provider ID below.",
        providerUnavailable: "Unavailable",
        customProviderLabel: "Add provider ID",
        customProviderPlaceholder: "e.g. claude or claude-sub",
        customProviderAdd: "Add",
        providersSelectionRequired:
          "Select at least one provider, or turn on \"Allow all providers\".",
        allowDeviceModesLabel: "Let devices choose permission modes",
        allowDeviceModesHint:
          "Off: paired devices always use this machine's default mode for each provider. On: they can pick any mode the provider offers, including full access. Agents also keep this machine's own tools.",
        maxConcurrentLabel: "Max running sessions per device",
        maxConcurrentHint: "Sessions starting or working on a turn count toward the limit. Idle sessions do not.",
        maxConcurrentInvalid: "Enter a positive whole number (at least 1).",
        saveAccess: "Save access control",
        accessSaved: "Access control updated",
      },
      invite: {
        modalTitle: "Invite device",
        labelField: "Device label (optional)",
        labelHint: "Optional label to help you recognize this device later.",
        labelPlaceholder: "e.g. Work laptop",
        generateAction: "Generate pairing code",
        generatingAction: "Generating…",
        secretWarning: "This pairing code is a secret. Share it only through a private channel.",
        onceNotice: "Shown only once. It will not be shown again after you close this dialog.",
        codeLabel: "One-time pairing code",
        copyAction: "Copy pairing code",
        expiresAt: "Expires at {{time}}",
        expiresIn: "Expires in {{remaining}}",
        expired: "Expired",
      },
      direct: {
        sectionTitle: "Direct acceleration (experimental)",
        connecting: "Loading direct acceleration settings…",
        watchError: "Unable to watch direct acceleration settings: {{message}}",
        watchClosed: "Direct acceleration settings stream closed.",
        enableLabel: "Enable direct acceleration",
        enableHint:
          "Machine-wide setting shared by remote machines and connected devices. Direct connections are attempted only when both sides enable it and configure rendezvous peers.",
        peersLabel: "Rendezvous peers",
        peersCount: "{{count}} / {{max}}",
        peersHint: "Enter tcp://host:port or udp://host:port addresses (up to {{max}}).",
        peersEmpty: "No rendezvous peers configured.",
        peersNeededHint:
          "Enabled without rendezvous peers. Add at least one peer and save before direct connections will be attempted.",
        peerInputLabel: "Add rendezvous peer",
        peerPlaceholder: "tcp://host:port or udp://host:port",
        peerInvalid:
          "Enter a valid address in tcp://host:port or udp://host:port format (use [IPv6]:port for IPv6).",
        peerDuplicate: "This rendezvous peer is already in the list.",
        peersLimit: "You can configure at most {{max}} rendezvous peers.",
        saveLabel: "Save direct acceleration settings",
        saved: "Direct acceleration settings saved",
        noteFasterFallback:
          "Direct connections are faster when established; if unavailable, traffic automatically stays on relay without interrupting use.",
        noteRendezvousOnly:
          "Rendezvous peers only help both sides establish a connection and do not forward application traffic.",
        noteEasyTierDownload:
          "Enabling for the first time downloads a verified EasyTier component (LGPL-3.0).",
        easyTierLabel: "EasyTier component",
        easyTierWatchError: "Unable to watch the EasyTier component: {{message}}",
        easyTierMissing: "Not installed",
        easyTierMissingHint: "Downloaded automatically when a direct connection is negotiated.",
        easyTierDownloading: "Downloading",
        easyTierProgress: "{{received}} / {{total}} MB ({{percent}}%)",
        easyTierProgressUnknown: "{{received}} MB",
        easyTierReady: "Ready",
        easyTierFailed: "Failed",
        easyTierImportHint:
          "If the download fails or is slow, get {{file}} from the official link below (or copy the same file from another machine) and paste its full path here. Any copy is installed only if its SHA-256 matches the pinned value.",
        easyTierOfficialLink: "Official download: {{file}}",
        easyTierPathLabel: "EasyTier ZIP path",
        easyTierPathPlaceholder: "~/Downloads/{{file}}",
        easyTierImport: "Import",
        easyTierImporting: "Importing…",
        easyTierImported: "EasyTier component imported",
      },
    },
    "zh-CN": {
      screens: {
        remoteMachines: "远端机器",
        connectedDevices: "已连接设备",
      },
      common: {
        cancel: "取消",
        confirm: "确认",
        save: "保存",
        saving: "保存中…",
        saved: "已保存",
        close: "关闭",
        done: "完成",
        back: "返回",
        copy: "复制",
        copied: "已复制",
        copyFailed: "无法自动复制，请选中文本后手动复制。",
        refresh: "刷新",
        retry: "重试",
        loading: "加载中…",
        remove: "移除",
        revoke: "撤销",
        add: "添加",
        next: "下一步",
        unknown: "未知",
        none: "无",
      },
      os: {
        darwin: "macOS",
        linux: "Linux",
        win32: "Windows",
        unknown: "未知系统",
      },
      brainStatus: {
        connected: "已连接",
        connecting: "连接中",
        disconnected: "断开",
        unverified: "未确认",
        revoked: "已撤销",
      },
      endpointStatus: {
        connected: "已连接",
        connecting: "连接中",
        disconnected: "已断开",
      },
      transport: {
        relay: "relay",
        direct: "直连",
      },
      policy: {
        restricted: "受限（默认）",
        restrictedShort: "受限",
        full: "完全",
      },
      remoteMachines: {
        sectionTitle: "远端机器",
        addButton: "添加远端机器",
        emptyTitle: "尚未添加远端机器",
        emptyDescription:
          "在本机工作区里直接使用另一台机器上的 provider。请在远端机器的“已连接设备”里生成配对码，然后粘贴到这里。",
        subscriptionConnecting: "正在连接插件服务…",
        subscriptionError: "无法加载远端机器：{{message}}",
        subscriptionClosed: "与插件服务的连接已关闭。",
        relayMeta: "中继：{{relay}}",
        detailBack: "远端机器",
        overviewSection: "连接状态",
        statusLabel: "状态",
        osLabel: "系统",
        transportLabel: "传输方式",
        relayLabel: "中继地址",
        lastErrorLabel: "最近错误",
        directFallbackTitle: "直连未建立，正在使用 relay",
        directFallbackShowReason: "查看原因",
        directFallbackHideReason: "收起原因",
        directRetryIn: "{{seconds}} 秒后重试",
        directRetrying: "正在重试…",
        directNoRetry: "修改直连设置前不会自动重试",
        directRetryNow: "立即重试",
        updateRelayLabel: "更新 relay 地址",
        updateRelayHint: "保留原有配对身份，仅替换 relay 地址并重新连接。",
        updateRelayPlaceholder: "host:port",
        updateRelayInvalid: "请输入有效的 host:port 格式地址（IPv6 请使用 [IPv6]:port）。",
        updateRelayAction: "更新地址",
        updateRelaySaving: "更新中…",
        updateRelaySuccess: "已更新 relay 地址，正在重连…",
        relayChangedHint:
          "如果远端机器更换了 relay 地址，请在下方“更新 relay 地址”中粘贴新地址，无需重新配对。",
        relayChangedFocusAction: "去更新 relay 地址",
        useOfficialRelay: "恢复官方地址",
        identitySection: "显示名称",
        nameLabel: "名称",
        namePlaceholder: "例如：Mac mini",
        nameRequired: "请输入显示名称。",
        renameAction: "保存名称",
        renameSuccess: "已更新显示名称",
        permissionsSection: "权限设置",
        policyLabel: "权限档",
        policyHintRestricted: "文件工具仅能访问已授权的项目目录，已禁用命令执行。",
        policyHintFull: "已启用文件工具和命令执行。",
        policyUpdated: "已更新权限档",
        fullPolicyModalTitle: "切换到“完全”权限",
        fullPolicyConfirmBody: "这台机器上的 agent 将能以你的用户身份运行任意命令",
        fullPolicyConfirmAction: "确认切换",
        projectsSection: "已授权项目",
        projectsEmpty: "暂无已授权项目。在某个工作区首次使用这台机器时会自动加入。",
        projectGrantedAt: "授权于 {{time}}",
        projectRevoked: "已撤销项目授权",
        modelsSection: "可用模型",
        modelsEmpty: "暂未上报可用模型。",
        dangerSection: "移除机器",
        removeLabel: "移除这台远端机器",
        removeHint: "从本机移除该机器，并同时撤销本机在对方上的设备访问权限。",
        removeAction: "移除",
        removeModalTitle: "移除 {{name}}",
        removeConfirmBody: "确定要移除“{{name}}”吗？本机在该机器上的设备权限也会一并撤销。",
        removeSuccess: "已移除远端机器",
        removeSuccessLocalOnly: "已从本机移除；远端当前不可达，如需立即吊销请到对方“已连接设备”里撤销。",
      },
      addBrain: {
        modalTitle: "添加远端机器",
        codeLabel: "配对码",
        codeHint: "在远端机器的“已连接设备”中生成一次性配对码，粘贴到下方。",
        codePlaceholder: "粘贴配对码",
        codeRequired: "请先粘贴配对码。",
        previewLoading: "正在核对配对码…",
        previewSection: "远端机器信息",
        machineName: "机器名称",
        system: "系统",
        relay: "中继地址",
        changeCode: "更换配对码",
        risksTitle: "请逐条确认以下风险后再继续",
        risksHint: "需要勾选全部风险项后才能添加这台机器。",
        risksUpdatedWarning: "远端机器的风险说明已更新，请重新核对并勾选全部风险项后再提交。",
        displayNameLabel: "显示名称",
        displayNamePlaceholder: "在模型列表中显示的名称",
        submitAction: "添加远端机器",
        submittingAction: "正在添加…",
        addSuccess: "已添加 {{name}}",
      },
      connectedDevices: {
        endpointSection: "本机端点",
        statusLabel: "端点状态",
        fingerprintLabel: "指纹",
        lastErrorLabel: "最近错误",
        relayLabel: "Relay 地址",
        relayHint:
          "默认使用官方地址（{{defaultRelay}}）。切换后在线设备会自动跟随，离线设备可在“远端机器”页更新地址。",
        relayPlaceholder: "host:port",
        relayInvalid: "请输入有效的 host:port 格式地址（IPv6 请使用 [IPv6]:port）。",
        useOfficialRelay: "恢复官方地址",
        saveRelay: "保存地址",
        relaySaved: "已开始切换 Relay 地址",
        relaySwitchedTitle: "Relay 地址已切换",
        relaySwitchedNotice: "在线设备会自动跟随；离线设备需要在它们的“远端机器”页更新地址。",
        copyNewRelay: "复制新地址",
        endpointConnecting: "正在连接插件服务…",
        endpointWatchError: "无法监听本机端点状态：{{message}}",
        endpointWatchClosed: "端点状态订阅已关闭。",
        risksSection: "风险说明",
        fixedRiskNativeTools: "远端 agent 的原生工具可以访问本机这个用户的文件。",
        fixedRiskSharedSessions: "多人共用时，各人的会话在本机 Paseo 里彼此可见。",
        devicesSection: "已连接设备",
        inviteButton: "邀请设备",
        devicesEmptyTitle: "暂无已连接设备",
        devicesEmptyDescription: "生成一次性配对码，让另一台电脑使用本机配置的 provider。",
        devicesConnecting: "正在连接插件服务…",
        devicesError: "无法加载设备列表：{{message}}",
        devicesClosed: "与插件服务的连接已关闭。",
        deviceOnline: "在线",
        deviceOffline: "离线",
        deviceLastSeen: "最近连接：{{time}}",
        deviceSessions_other: "{{count}} 个运行中会话",
        revokeModalTitle: "撤销 {{name}}",
        revokeConfirmBody: "确定要撤销“{{name}}”吗？其活动连接会立即断开，进行中的请求将被取消。",
        revokeSuccess: "已撤销设备",
        accessSection: "访问控制",
        accessLoadError: "无法读取访问控制配置：{{message}}",
        allowAllProvidersLabel: "允许全部 provider",
        allowAllProvidersHint: "已连接设备可以使用本机上所有可用的 provider。",
        allowedProvidersLabel: "允许的 provider",
        allowedProvidersHint: "选择开放给已连接设备的 provider；如需全部开放，请开启“允许全部 provider”。",
        discoveredProvidersEmpty: "未自动发现本地 provider，可在下方手动添加 ID。",
        providerUnavailable: "不可用",
        customProviderLabel: "添加 provider ID",
        customProviderPlaceholder: "例如：claude 或 claude-sub",
        customProviderAdd: "添加",
        providersSelectionRequired: "请至少选择一个 provider，或开启“允许全部 provider”。",
        allowDeviceModesLabel: "允许设备选择权限模式",
        allowDeviceModesHint:
          "关闭时，已连接设备只能使用本机为各 provider 设置的默认模式；开启后可选 provider 提供的任意模式，包括完全访问。agent 也能使用本机自带的工具。",
        maxConcurrentLabel: "每台设备同时运行的会话上限",
        maxConcurrentHint: "正在启动或执行任务的会话计入上限，空闲会话不计入。",
        maxConcurrentInvalid: "请输入大于等于 1 的整数。",
        saveAccess: "保存访问控制",
        accessSaved: "已保存访问控制",
      },
      invite: {
        modalTitle: "邀请设备",
        labelField: "设备备注（可选）",
        labelHint: "便于后续识别这台设备，可留空。",
        labelPlaceholder: "例如：工作电脑",
        generateAction: "生成配对码",
        generatingAction: "正在生成…",
        secretWarning: "配对码是秘密，只通过私密渠道发送。",
        onceNotice: "配对码仅显示一次，关闭后将不再显示。",
        codeLabel: "一次性配对码",
        copyAction: "复制配对码",
        expiresAt: "到期时间：{{time}}",
        expiresIn: "剩余 {{remaining}}",
        expired: "已过期",
      },
      direct: {
        sectionTitle: "直连加速（实验性）",
        connecting: "正在加载直连加速配置…",
        watchError: "无法监听直连加速配置：{{message}}",
        watchClosed: "直连加速配置订阅已关闭。",
        enableLabel: "启用直连加速",
        enableHint:
          "本机全局配置，作为远端机器和已连接设备时共用。只有两端都启用并各自配置会合节点，才会尝试直连。",
        peersLabel: "会合节点",
        peersCount: "{{count}} / {{max}}",
        peersHint: "填写 tcp://host:port 或 udp://host:port 格式地址，最多 {{max}} 个。",
        peersEmpty: "尚未配置会合节点。",
        peersNeededHint:
          "已开启开关但尚未配置会合节点；请至少添加一个会合节点并保存，才会尝试直连。",
        peerInputLabel: "添加会合节点",
        peerPlaceholder: "tcp://host:port 或 udp://host:port",
        peerInvalid:
          "地址格式无效，请输入 tcp://host:port 或 udp://host:port（IPv6 请使用 [IPv6]:port）。",
        peerDuplicate: "该会合节点已在列表中。",
        peersLimit: "最多只能配置 {{max}} 个会合节点。",
        saveLabel: "保存直连加速配置",
        saved: "已保存直连加速配置",
        noteFasterFallback:
          "直连在打通时更快；打不通时自动使用 relay，不影响使用。",
        noteRendezvousOnly:
          "会合节点只帮两端建立连接，不转发业务数据。",
        noteEasyTierDownload:
          "首次启用时会下载一个经过校验的 EasyTier 组件（LGPL-3.0）。",
        easyTierLabel: "EasyTier 组件",
        easyTierWatchError: "无法监听 EasyTier 组件状态：{{message}}",
        easyTierMissing: "未安装",
        easyTierMissingHint: "协商直连时自动下载。",
        easyTierDownloading: "下载中",
        easyTierProgress: "{{received}} / {{total}} MB（{{percent}}%）",
        easyTierProgressUnknown: "{{received}} MB",
        easyTierReady: "已就绪",
        easyTierFailed: "失败",
        easyTierImportHint:
          "下载失败或太慢时，可从下方官方链接下载 {{file}}（或从其他机器拷贝同一文件），再把它在本机的完整路径粘贴到这里。无论来源，只有 SHA-256 与插件固定值一致才会安装。",
        easyTierOfficialLink: "官方下载：{{file}}",
        easyTierPathLabel: "EasyTier ZIP 路径",
        easyTierPathPlaceholder: "~/Downloads/{{file}}",
        easyTierImport: "导入",
        easyTierImporting: "导入中…",
        easyTierImported: "已导入 EasyTier 组件",
      },
    },
  },
});

export function osLabelKey(os: BrainOs): `os.${BrainOs}` {
  return `os.${os}`;
}

export function osIconName(os: BrainOs): string {
  switch (os) {
    case "darwin":
      return "Laptop";
    case "linux":
      return "Server";
    case "win32":
      return "Monitor";
    default:
      return "Cpu";
  }
}

export function brainStatusKey(status: BrainStatus): `brainStatus.${BrainStatus}` {
  return `brainStatus.${status}`;
}

export function endpointStatusKey(
  status: Endpoint["status"],
): `endpointStatus.${Endpoint["status"]}` {
  return `endpointStatus.${status}`;
}

export function policyShortKey(policy: BrainPolicy): "policy.restrictedShort" | "policy.full" {
  return policy === "full" ? "policy.full" : "policy.restrictedShort";
}

export function formatTimestamp(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function formatRemainingDuration(expiresAtIso: string, nowMs: number): string | null {
  const targetMs = Date.parse(expiresAtIso);
  if (Number.isNaN(targetMs)) return null;
  const remainingSec = Math.floor((targetMs - nowMs) / 1000);
  if (remainingSec <= 0) return null;
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
