// GitHub v2.6.4 发布附件。本地逐一下载并计算 ZIP 和所需成员的 SHA-256。
export const EASYTIER_VERSION = "2.6.4";
const github = "https://github.com/EasyTier/EasyTier/releases/download";

/**
 * 按顺序尝试的下载源；每个源提供 `<base>/v2.6.4/<官方 ZIP 文件名>`。
 * ZIP 和成员的摘要固定在下方，来源只影响速度，不影响信任。镜像追加在 GitHub 之后。
 */
export const easyTierSources: readonly string[] = [
  github,
  "https://dl.fullai.top/easytier",
];

function artifact(target: string, sha256: string, members: Record<string, string>) {
  const directory = `easytier-${target}`;
  const file = `${directory}-v${EASYTIER_VERSION}.zip`;
  return { file, officialUrl: `${github}/v${EASYTIER_VERSION}/${file}`, directory, sha256, members };
}

export const easyTierArtifacts = {
  "darwin-arm64": artifact("macos-aarch64", "4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b", {
    "easytier-core": "6478a522b8637e2bd2ad3adad66ed04a71b35f832bd9889bffaf1863262f6ddf",
  }),
  "darwin-x64": artifact("macos-x86_64", "89fc28a6e6995259d76ce3f11775220e8a21c760e94df91a6a9db30a69b6982e", {
    "easytier-core": "ddf95a012599e424a632105fc3dc87d15c0a2daaf30a20b71aa95c8f896f9a2f",
  }),
  "linux-x64": artifact("linux-x86_64", "61b659eaedba658fa66fe47d17e1426cdd77e5d02fa15fed447bb4357c09dfd6", {
    "easytier-core": "35b854e0c5853c02733870488c977200f6aa06d09c08d5dc7f9f9e150e7be8d5",
  }),
  "linux-arm64": artifact("linux-aarch64", "f533ec25a7ea714e09f645615012200278058525795cc3bb690ff011aec1a70f", {
    "easytier-core": "7bd504e87cad52edacb9ea84ece7397d0afb911101de623a3dfc4a4dbd9e6bb6",
  }),
  "win32-x64": artifact("windows-x86_64", "27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84", {
    "easytier-core.exe": "da7eb2d24b5416f3d3407636949e964a0750e3f9dc53a828cb6799a57ead445d",
    "Packet.dll": "c7c03a87eac7243ccbe331554624b18803010b740e311fc8cfddb573096eacac",
    "wintun.dll": "e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce",
  }),
};
