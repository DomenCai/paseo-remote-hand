import type { PluginServerContext } from "@getpaseo/plugin/server";
import { access, brains, devices, direct, endpoint } from "./shared/settings.ts";
import { BrainService } from "./server/brain.ts";
import { createBrainAgentService } from "./server/brain/index.ts";
import { HandService } from "./server/hand.ts";
import { createLocalDaemon } from "./server/local-daemon.ts";
import { createHandProvider } from "./server/provider/index.ts";
import { Snapshots } from "./server/snapshots.ts";
import { pluginStateDir, resolvePaseoHome, StateStore } from "./server/state.ts";

export default function contribute(server: PluginServerContext) {
  const paseoHome = resolvePaseoHome();
  const state = new StateStore(pluginStateDir(paseoHome));
  const local = createLocalDaemon(paseoHome);
  const agents = createBrainAgentService({ paseoHome, cancelAgent: local.cancelAgent });
  const accessPolicy = {
    get providers() {
      const { providers } = state.current.access;
      // M1a 仅开放已接入的 Claude；空白名单允许当前支持的全部 provider。
      return !providers.length || providers.includes("claude") ? ["claude"] : [];
    },
  };
  const brain = new BrainService(state, Date.now, (deviceId, port) => {
    agents.attach({ deviceId, paseo: local.api, access: accessPolicy, port });
  });
  const hand = new HandService(state);
  const provider = createHandProvider({
    listBrains: () => hand.brains().map(({ brainId, name }) => ({ id: brainId, name, port: hand.port(brainId) })),
    subscribe: (listener) => hand.snapshots.subscribe(listener),
    readPolicy: async (brainId) => hand.readPolicy(brainId),
    authorizeProject: async (brainId, cwd) => hand.authorizeProject(brainId, cwd),
  });
  const unregisterHook = agents.registerHook(server);
  server.registerProvider(provider.registration);

  // 0.17.3 会缓存此前为空的模型目录。只在可见目录变化时刷新本机 provider。
  let visibleModels = "[]";
  let refresh = Promise.resolve();
  let stopping = false;
  const unsubscribeModels = hand.snapshots.subscribe(() => {
    const current = JSON.stringify(hand.brains().flatMap(({ name, models }) =>
      (models ?? []).map(({ id, label }) => [id, name, label])));
    if (current === visibleModels) return;
    visibleModels = current;
    refresh = refresh.then(async () => {
      if (stopping || visibleModels !== current) return;
      await (await local.api()).providers.refresh({ providers: ["remote-hand"] });
    }).catch(() => { if (!stopping) console.error("Could not refresh the Remote Hand provider catalog."); });
  });

  const directSnapshots = new Snapshots(() => state.current.direct);
  server.handle(direct.get, () => state.current.direct);
  server.handle(direct.watch, (_, context) => directSnapshots.watch(context));
  server.handle(direct.set, (input) => {
    if (JSON.stringify(input) === JSON.stringify(state.current.direct)) return null;
    state.update((current) => { current.direct = input; });
    brain.directSettingsChanged();
    hand.directSettingsChanged();
    directSnapshots.changed();
    return null;
  });

  server.handle(endpoint.get, () => brain.endpoint());
  server.handle(endpoint.watch, (_, context) => brain.endpointSnapshots.watch(context));
  server.handle(endpoint.setRelay, async ({ relay }) => { await brain.setRelay(relay); return null; });
  server.handle(devices.invite, ({ label }) => brain.invite(label));
  server.handle(devices.revoke, ({ deviceId }) => { brain.revoke(deviceId); return null; });
  server.handle(devices.watch, (_, context) => brain.snapshots.watch(context));
  server.handle(access.get, () => brain.access());
  server.handle(access.set, (input) => { brain.setAccess(input); return null; });

  server.handle(brains.preview, ({ pairingCode }) => hand.preview(pairingCode));
  server.handle(brains.add, ({ pairingCode, name, acknowledgedRiskCodes }) =>
    hand.add(pairingCode, name, acknowledgedRiskCodes));
  server.handle(brains.rename, ({ brainId, name }) => { hand.rename(brainId, name); return null; });
  server.handle(brains.remove, ({ brainId }) => hand.remove(brainId));
  server.handle(brains.setRelay, ({ brainId, relay }) => { hand.setRelay(brainId, relay); return null; });
  server.handle(brains.setPolicy, ({ brainId, policy }) => { hand.setPolicy(brainId, policy); return null; });
  server.handle(brains.revokeProject, ({ brainId, root }) => { hand.revokeProject(brainId, root); return null; });
  server.handle(brains.watch, (_, context) => hand.snapshots.watch(context));

  brain.start();
  hand.start();
  return async () => {
    stopping = true;
    unsubscribeModels();
    unregisterHook();
    await agents.close();
    await provider.dispose();
    hand.stop();
    brain.stop();
    await local.close();
  };
}
