import type { ChatEvent, ConnectionStatus } from "@tiksee/core";

/** TikTok web session, harvested from the login window. */
export interface TikTokSession {
    sessionId: string;
    /** Data-centre hint TikTok requires alongside the session cookie. */
    ttTargetIdc: string;
}

export interface ChatSourceHandlers {
    onEvent: (event: ChatEvent) => void;
    onStatus: (status: Partial<ConnectionStatus> & { state: ConnectionStatus["state"] }) => void;
    /** Non-fatal driver error worth showing to the user (WS15-10). */
    onError?: (message: string) => void;
}

export interface ChatSourceStartOptions {
    streamId: string;
    username: string;
    session: TikTokSession | null;
    /** Poll until the creator goes live instead of failing immediately. */
    waitUntilLive: boolean;
}

/**
 * A pluggable live-chat ingestion driver.
 *
 * Two implementations exist:
 *  - `ConnectorSource`  — `tiktok-live-connector`, owns the webcast socket
 *    directly. Default; no browser required.
 *  - `SnifferSource`    — an embedded browser page whose WebSocket frames are
 *    intercepted. Fallback for when the signing provider is unavailable.
 *
 * Keeping this an interface is what makes the choice reversible: nothing
 * downstream of `onEvent` knows or cares which driver produced the event.
 */
export interface ChatSource {
    readonly name: "connector" | "sniffer";
    start(options: ChatSourceStartOptions, handlers: ChatSourceHandlers): Promise<void>;
    stop(): Promise<void>;
    readonly running: boolean;
}
