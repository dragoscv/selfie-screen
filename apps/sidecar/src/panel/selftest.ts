/**
 * Panel hardware self-test.
 *
 * Run with `pnpm --filter @tiksee/sidecar panel:test`. Enumerates serial
 * ports, opens the first Turing panel, renders a frame of synthetic chat and
 * pushes it. Exists because the panel is the one subsystem that cannot be
 * proven by a unit test — it needs the physical device.
 */
import { nextEventId, type ChatEvent } from "@tiksee/core";

import { logger } from "../logger.js";
import { PanelRenderer } from "./render.js";
import { TuringPanel, findPanelPort, listPorts } from "./turing.js";

logger.setLevel("debug");
const log = logger.scoped("[selftest]");

function sample(): ChatEvent[] {
    const now = Date.now();
    const make = (
        kind: ChatEvent["kind"],
        nickname: string,
        text: string,
        offset: number,
    ): ChatEvent => ({
        id: nextEventId(now - offset),
        kind,
        user: { id: nickname, uniqueId: nickname.toLowerCase(), nickname },
        text,
        at: now - offset,
        streamId: "selftest",
    });

    return [
        make("join", "Mihai", "joined", 50_000),
        make("chat", "Ana", "salut! merge panoul? 👀", 40_000),
        make("gift", "Ionut", "sent Rose ×5 🎁", 30_000),
        make("follow", "Elena", "followed ✨", 20_000),
        make("chat", "Ana", "arata super bine pe ecranul mic", 10_000),
        make("share", "Radu", "shared the LIVE 📣", 4_000),
    ];
}

async function main(): Promise<void> {
    const ports = await listPorts();
    log.info("serial ports:");
    for (const port of ports) {
        log.info(
            `  ${port.path.padEnd(6)} vid=${port.vendorId ?? "----"} pid=${port.productId ?? "----"}` +
            ` ${port.isPanel ? "  <-- TURING PANEL" : ""}`,
        );
    }

    const path = process.argv[2] ?? (await findPanelPort());
    if (!path) {
        log.error("No Turing panel detected. Pass a port explicitly: panel:test COM6");
        process.exitCode = 1;
        return;
    }

    log.info(`opening ${path}`);
    const panel = new TuringPanel(path);
    await panel.open();

    const renderer = new PanelRenderer();
    const events = sample();

    // Two frames: the first is a full push, the second exercises the
    // dirty-region diff (only the newest row and the clock should move).
    const first = renderer.render({
        events,
        state: "live",
        collapseJoins: true,
        collapseLikes: true,
        mergeSameUser: true,
        showClock: true,
    });
    const bytes1 = await panel.display(first);
    log.info(`frame 1 pushed: ${bytes1} bytes (full repaint)`);

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const second = renderer.render({
        events: [
            ...events,
            {
                id: nextEventId(),
                kind: "chat",
                user: { id: "test", uniqueId: "tiksee", nickname: "TikSee" },
                text: "diff push works ✅",
                at: Date.now(),
                streamId: "selftest",
            },
        ],
        state: "live",
        collapseJoins: true,
        collapseLikes: true,
        mergeSameUser: true,
        showClock: true,
    });
    const bytes2 = await panel.display(second);
    log.info(`frame 2 pushed: ${bytes2} bytes (dirty-region diff)`);

    if (bytes2 >= bytes1 && bytes1 > 0) {
        log.warn("diff did not reduce the payload — check the row-compare logic");
    }

    log.info("leaving the frame on screen for 10s, then closing");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await panel.close();
    log.info("done");
}

main().catch((error: unknown) => {
    log.error("self-test failed", error);
    process.exitCode = 1;
});
