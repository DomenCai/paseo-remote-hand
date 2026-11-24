import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ConnectedDevicesScreen } from "./client/connected-devices-screen";
import { messages } from "./client/messages";
import { RemoteMachinesScreen } from "./client/remote-machines-screen";

export default function contribute(client: PluginClientContext) {
  const removeRemoteMachines = client.addSettingsScreen({
    id: "remote-machines",
    title: messages.message("screens.remoteMachines"),
    icon: "Server",
    Component: RemoteMachinesScreen,
  });
  const removeConnectedDevices = client.addSettingsScreen({
    id: "connected-devices",
    title: messages.message("screens.connectedDevices"),
    icon: "Laptop",
    Component: ConnectedDevicesScreen,
  });

  return () => {
    removeRemoteMachines();
    removeConnectedDevices();
  };
}
