import type { CameraRemoteSettings } from "@tiksee/core";

import { RemotePad } from "./remote-pad.js";
import { SelfieRemote } from "./selfie-remote.js";

/** Pad + selfie-stick setup: the body of the HUD popover and of the detached window. */
export function RemotePanel({ settings, onPatch }: { settings: CameraRemoteSettings; onPatch: (p: Partial<CameraRemoteSettings>) => void }) {
    return (
        <div className="flex flex-col gap-3">
            <RemotePad settings={settings} onPatch={onPatch} />
            <SelfieRemote selfie={settings.selfie} onChange={(selfie) => onPatch({ selfie })} />
        </div>
    );
}
