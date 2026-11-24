import type { PluginServerContext } from "@getpaseo/plugin/server";
import { access, brains, devices, endpoint } from "./shared/settings.ts";
import { BrainService } from "./server/brain.ts";
import { HandService } from "./server/hand.ts";
import { pluginStateDir, StateStore } from "./server/state.ts";

export default function contribute(server: PluginServerContext) {
  const state = new StateStore(pluginStateDir());
  const brain = new BrainService(state);
  const hand = new HandService(state);

  server.handle(endpoint.get, () => brain.endpoint());
  server.handle(endpoint.setRelay, ({ relay }) => { brain.setRelay(relay); return null; });
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
  server.handle(brains.setPolicy, ({ brainId, policy }) => { hand.setPolicy(brainId, policy); return null; });
  server.handle(brains.revokeProject, ({ brainId, root }) => { hand.revokeProject(brainId, root); return null; });
  server.handle(brains.watch, (_, context) => hand.snapshots.watch(context));

  brain.start();
  hand.start();
  return () => { hand.stop(); brain.stop(); };
}
